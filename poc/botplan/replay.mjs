// poc/botplan/replay.mjs — PoC 复建层（bench 主线程与 planWorker 共用）：
// 从 specimens.json 的任务快照复建「假 m / 假 ps」，跑真的 planLayoutSteps（bot.js 原函数）。
// 快照不完整（漏读、键不合、rng 链断）一律响亮失败——这正是本 PoC 要证明的事。
import { createRngFromState } from '../../server/sim/rng.js';
import { planLayoutSteps, runSteps } from '../../server/match/bot.js';

/** 同步跑完一次规划调用，返回 { plan, rngState, ms }。 */
export function runTask(gd, c) {
  const t0 = performance.now();
  const m = reconstruct(gd, c);
  const out = runSteps(m.gen);
  const plan = serializePlan(out);
  return { plan, rngState: m.m.rngBots.state(), ms: performance.now() - t0 };
}

/** 只复建不驱动：返回 { m, gen }（bench 的切片驱动逐片 next() 用）。 */
export function startTaskGen(gd, c) {
  return reconstruct(gd, c);
}

function serializePlan(out) {
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([uid, k]) => [uid, k, out.dirs.get(uid) ?? 'RIGHT']);
}

/** 一批任务（同席位、rng 链断点切分后的段）顺序执行，段内断链响亮失败。 */
export function runSegment(gd, tasks) {
  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const c = tasks[i];
    if (i > 0 && c.rngState !== results[i - 1].rngState) {
      throw new Error(`rng chain broken before task ${c.seq}: entry ${c.rngState} != prev end ${results[i - 1].rngState}`);
    }
    const r = runTask(gd, c);
    results.push({ seq: c.seq, plan: r.plan, rngState: r.rngState, ms: r.ms });
  }
  return results;
}

function reconstruct(gd, c) {
  const bossHere = !c.waveFlag && c.bossTid !== undefined;
  // 与 fieldModel 相同的缓存键公式（wave = m.wave || boss && boss.wave）；与采集端的 key 不一致＝快照不完整，响亮失败
  const waveTidEff = c.waveFlag ? c.waveTid : (bossHere ? c.bossTid : 'boss');
  const key = `${c.round}|${c.stageId}|${waveTidEff}|${bossHere ? c.bossSide : ''}`;
  if (key !== c.key) throw new Error(`model key mismatch: replay ${key} != captured ${c.key}`);
  const model = { key, ...rebuildModel(c.model) };
  const m = {
    round: c.round, stageId: c.stageId,
    wave: c.waveFlag ? { templateId: c.waveTid } : null,
    bossGroupOf: bossHere ? () => ({ wave: { templateId: c.bossTid }, side: c.bossSide }) : null,
    gd,
    rngBots: createRngFromState(c.rngState),
  };
  if (c.bodyUsed) m._botPathBody = model; // body 模型走 fieldModel 的 body 槽
  else m._botPath = model;
  const withinByUid = new Map(), withoutByUid = new Map();
  const pieces = c.pieces.map((p) => {
    if (p.within) withinByUid.set(p.uid, new Set(p.within));
    if (p.without) withoutByUid.set(p.uid, new Set(p.without));
    return { uid: p.uid, id: p.id, kind: p.kind };
  });
  const recByUid = new Map(c.pieces.map((p) => [p.uid, recFor(gd, p.rec)]));
  const bodyByChessId = new Map((c.bodies || []).map(([id, b]) => [id, b ? recFor(gd, b.rec) : null]));
  const ps = {
    gd,
    deployMap: () => new Map(c.map),
    fieldRecord: (r) => (r && bodyByChessId.has(r.chessId) ? (bodyByChessId.get(r.chessId) || r) : r),
    summonRange: (p) => withinByUid.get(p.uid) || null,
    summonExcluded: (p) => withoutByUid.get(p.uid) || null,
    _botSelf: { round: c.round, plan: { placements: c.placements } },
  };
  const params = { ...c.params };
  if (params.holdTiles) params.holdTiles = new Set(params.holdTiles);
  return { m, gen: planLayoutSteps(m, ps, pieces, params, {
    occupied: new Set(c.occupied),
    recOf: (p) => recByUid.get(p.uid),
  }) };
}

function recFor(gd, ref) {
  if (!ref) return null;
  if (ref.t !== undefined) return gd.token(ref.t);
  const base = gd.chess(ref.b);
  if (!base) throw new Error(`replay: unknown chess ${ref.b}`);
  return ref.g ? Object.freeze({ ...base, rangeGrid: ref.g }) : base;
}

function rebuildModel(mo) {
  return {
    routes: mo.routes.map((rt) => ({ ...rt })),
    index: new Map(mo.index.map(([k, arr]) => [k, arr.map((e) => [e[0], e[1]])])),
    ground: new Map(mo.ground.map(([k, v]) => [k, { flow: v.flow, prog: v.prog }])),
    airflow: new Map(mo.airflow.map(([k, v]) => [k, { dir: v.dir, bb: v.bb }])),
    armor: mo.armor.map((a) => ({ ...a })),
    flyTotal: mo.flyTotal,
    dps: new Map(), // 纯缓存：effDps 值只依赖 (rec, armor)，冷缓存重算值相同
    lead: mo.lead ? { tiles: new Set(mo.lead.tiles), strike: mo.lead.strike ? new Set(mo.lead.strike) : null } : null,
  };
}
