// poc/botplan/collect.mjs — PoC 采集器：驱动真实 Match（真 Battle、生产 rehearsal=3）跑多回合，
// 通过 bot.js planLayoutSteps 的临时探针（__spPlanCapture / _poc(out)，采集后即还原，不进提交）
// 抓下每一次布防规划调用的完整输入快照 + 真实结果 + 真实 rng 末态 + 主线程耗时，存 specimens.json
// 供 bench.mjs 做「主线程 vs 池」对比。不接生产路径；跑完即弃。
//
// 快照只存 worker 侧无法从数据子集重建的东西：模型（routes/index/ground/airflow/lead）、部署图、
// 每子的 rangeGrid 覆盖（rec = {b: chessId} 或 {b, g}）、补位 body 记录、召唤约束、
// advisor plan placements、params（holdTiles 摊平）、occupied、rngBots 状态、wave/boss 键位材料。
//
// 用法：node poc/botplan/collect.mjs [--out poc/botplan/specimens.json] [--quick]
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMatch } from '../../test/match/harness.js';
import { fieldModel, rangeRec } from '../../server/match/bot.js';
import { advisorPlan } from '../../server/match/aiPlan.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = opt('out', path.join(here, 'specimens.json'));
const QUICK = args.includes('--quick');
const TINY = args.includes('--tiny');

// coop4 三难度 ×3 seed（生产主形态，4 bot 同波）、AI 托管 solo（1 bot 席）、
// coop4 ABYSS 高 LP 到 R13+boss（重晚波）。8/16 席同波的波次形态压力由 bench 合成
// （把同回合的多局席位段拼成一波——席位相互独立、rng 链按席位切分；coop 房容量上限放不下 8 席）。
const configs = [];
if (TINY) {
  configs.push({ difficulty: 'NORMAL', seed: 11, humans: 0, bots: 4, rounds: 3 });
} else {
for (const difficulty of ['NORMAL', 'HARD', 'ABYSS']) {
  for (const seed of QUICK ? [11] : [11, 12, 13]) configs.push({ difficulty, seed, humans: 0, bots: 4, rounds: 8 });
}
for (const difficulty of ['HARD', 'ABYSS']) {
  for (const seed of QUICK ? [11] : [11, 12]) configs.push({ difficulty, seed, humans: 1, bots: 0, rounds: 8, hosted: true });
}
configs.push({ difficulty: 'ABYSS', seed: 11, humans: 0, bots: 4, rounds: 99, lp: 99, late: true });
}

const specimens = [];
let seq = 0;
let current = null;

/** 一次 planLayoutSteps 调用的完整快照（在生成体首句、任何 rng 抽取之前同步完成）。 */
globalThis.__spPlanCapture = (m, ps, pieces, params, opts) => {
  const t0 = performance.now();
  const pgd = ps.gd || m.gd;
  const waveFlag = !!m.wave;
  let boss = null;
  if (!waveFlag && typeof m.bossGroupOf === 'function') {
    const g = m.bossGroupOf(ps);
    boss = g && g.wave ? { tid: g.wave.templateId, side: g.side } : null;
  }
  const bodyUsed = !!(params.body > 0 && boss);
  // fieldModel 幂等预热（真生成体随后同样调用，缓存命中），序列化所用的那份
  const modelRaw = fieldModel(m, ps, bodyUsed);
  const model = {
    routes: modelRaw.routes.map((rt) => ({ ...rt })),
    index: [...modelRaw.index].map(([k, arr]) => [k, arr.map((e) => [e[0], e[1]])]),
    ground: [...modelRaw.ground].map(([k, v]) => [k, { flow: v.flow, prog: v.prog }]),
    airflow: [...modelRaw.airflow].map(([k, v]) => [k, { dir: v.dir, bb: v.bb }]),
    armor: modelRaw.armor.map((a) => ({ ...a })),
    flyTotal: modelRaw.flyTotal,
    lead: modelRaw.lead ? { tiles: [...modelRaw.lead.tiles], strike: modelRaw.lead.strike ? [...modelRaw.lead.strike] : null } : null,
  };
  // 每子解析：默认 recOf（与 planLayoutSteps 一致）+ placeClass 的补位 body + 召唤约束
  const bodies = new Map(); // chessId → 补位 body 记录（fieldRecord 输出；与基础记录同则 null），worker 侧复建 placeClass
  const piecesOut = pieces.map((p) => {
    let within, without;
    if (p.kind === 'token') {
      if (typeof ps.summonRange === 'function') { const w = ps.summonRange(p); within = w ? [...w] : null; }
      if (typeof ps.summonExcluded === 'function') { const w = ps.summonExcluded(p); without = w ? [...w] : null; }
      return { uid: p.uid, id: p.id, kind: p.kind, rec: { t: p.id }, within, without };
    }
    const base = pgd.chess(p.id);
    const rec = rangeRec(ps, base);
    const recRef = rec === base ? { b: p.id } : { b: p.id, g: rec.rangeGrid };
    if (!bodies.has(p.id)) {
      let body = base;
      if (typeof ps.fieldRecord === 'function') { try { body = ps.fieldRecord(base) || base; } catch { body = base; } }
      bodies.set(p.id, body === base ? null : { b: body.chessId ?? p.id, rec: body });
    }
    return { uid: p.uid, id: p.id, kind: p.kind, rec: recRef, within, without };
  });
  const plan = advisorPlan(m, ps);
  const task = {
    seq: seq++,
    round: m.round, stageId: m.stageId,
    waveFlag, waveTid: m.wave ? m.wave.templateId : undefined,
    bossTid: boss ? boss.tid : undefined, bossSide: boss ? boss.side : undefined,
    bodyUsed,
    key: modelRaw.key,
    model,
    map: [...ps.deployMap()],
    pieces: piecesOut,
    bodies: [...bodies],
    occupied: opts.occupied ? [...opts.occupied] : [],
    params: { ...params, holdTiles: params.holdTiles instanceof Set ? [...params.holdTiles] : undefined },
    placements: plan?.placements ?? [],
    rngState: m.rngBots.state(),
    seat: ps.playerId,
  };
  return (realOut) => {
    task.ms = performance.now() - t0;
    task.real = serializePlan(realOut);
    task.rngEnd = m.rngBots.state();
    task.cfg = current;
    specimens.push(task);
  };
};

function serializePlan(out) {
  if (!out) return null;
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([uid, k]) => [uid, k, out.dirs.get(uid) ?? 'RIGHT']);
}

for (const c of configs) {
  const h = makeMatch({ mode: 'coop', difficulty: c.difficulty, humans: c.humans, bots: c.bots, seed: c.seed, fake: false, botRehearsal: 3 });
  const m = h.m;
  if (c.hosted) h.autoHumans();
  current = { difficulty: c.difficulty, seed: c.seed, bots: c.bots, hosted: !!c.hosted, stress: !!c.stress, late: !!c.late };
  const before = specimens.length;
  m.start();
  if (c.lp) { // 高 LP 形态：start() 之后第一段 PREP 前抬 LP（matchrun --lp 同款做法），冲 R10+ 与 boss 波
    for (const ps of m.players.values()) ps.lp = c.lp;
  }
  const t0 = performance.now();
  h.run(() => h.ended != null || m.round > c.rounds, { maxSteps: 5e6 });
  const wall = performance.now() - t0;
  const planMs = specimens.slice(before).reduce((s, t) => s + (t.ms || 0), 0);
  const errors = m.errorCount;
  const rounds = m.round;
  m.dispose();
  current = null;
  console.log(`[collect] ${c.difficulty} seed=${c.seed} bots=${c.bots}${c.hosted ? ' HOSTED' : ''}${c.stress ? ' STRESS' : ''}${c.late ? ' LP99' : ''}: rounds=${rounds} errors=${errors} calls=${specimens.length - before} planMs=${planMs.toFixed(0)} matchWall=${wall.toFixed(0)}ms share=${wall > 0 ? ((planMs / wall) * 100).toFixed(1) : '?'}%`);
}

writeFileSync(out, JSON.stringify(specimens));
const totalMs = specimens.reduce((s, t) => s + (t.ms || 0), 0);
console.log(`[collect] wrote ${specimens.length} specimens -> ${out} (${(JSON.stringify(specimens).length / 1048576).toFixed(1)} MB)`);
console.log(`[collect] planLayout main-thread total: ${totalMs.toFixed(0)} ms over ${specimens.length} calls (mean ${(totalMs / Math.max(1, specimens.length)).toFixed(2)} ms)`);
// rng 链完整性：同席位相邻调用 entry == prev end（规划段是否 rng 连续，决定池化任务的切分边界）
let chainOk = 0, chainBreak = 0;
const lastEnd = new Map();
for (const t of specimens) {
  const k = `${t.cfg.seed}|${t.cfg.bots}|${t.seat}`;
  if (lastEnd.has(k)) { if (lastEnd.get(k) === t.rngState) chainOk++; else chainBreak++; }
  lastEnd.set(k, t.rngEnd);
}
console.log(`[collect] per-seat consecutive-call rng chain: ${chainOk} chained, ${chainBreak} broken (断点=池化任务切分处)`);
