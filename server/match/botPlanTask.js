// server/match/botPlanTask.js — bot 布防规划的池化任务载荷（SP_BOT_PLAN_POOL，默认关）。
//
// planLayoutSteps（bot.js）的输入全部可快照：每回合缓存的 fieldModel（routes/index/ground/airflow/lead）、
// 部署图、每子的记录（数据子集里的基础记录 + rangeGrid 覆盖）、补位 body、召唤约束、advisor placements、
// params、occupied 和 rngBots 的 uint32 状态。capturePlanTask 在主线程只做这些廉价读取（不推进 rng、
// 不跑 exposure 模型），worker 侧 applyPlanTask 用「假 m / 假 ps + 真 planLayoutSteps」复现同一次规划——
// plan 与 rng 末态与主线程逐字节一致（poc/botplan 台架：2715/2715 调用、383/383 段全同）。
//
// 契约（server/workers/simulation.js 的 'botplan' 任务）：
//   payload: { tasks: [capturePlanTask 的输出...] } —— 同一席位一段 rng 链上的相邻调用，顺序执行；
//            任务 i 的 rngState 必须等于任务 i-1 worker 侧算出的末态（链断即错，响亮失败）。
//   value:   { results: [{ seq, plan, rngState }...], rngState } —— plan = [[uid, key, dir]...]（uid 升序），
//            rngState = 该任务结束后 mulberry32 的状态；顶层 rngState = 最后一个任务的末态。
// 消费方（match/match/botplan.js）按这个形状取值；POOL_FULL / 失败 / 状态核验不过一律回退主线程内联路径。

import { createRngFromState } from '../sim/rng.js';
import { planLayoutSteps, runSteps, fieldModel, rangeRec } from './bot.js';
import { advisorPlan } from './aiPlan.js';

/**
 * Snapshot one planLayoutSteps call (cheap reads only: no rng draw, no exposure model, no mutation).
 * The caller captures a whole rng-chained batch before submitting it; between capture and the worker's run
 * nothing else may draw `m.rngBots` for this seat (the consumer verifies the stream state on resolve).
 * @param {import('./Match.js').Match} m
 * @param {import('./PlayerState.js').PlayerState} ps
 * @param {any[]} pieces
 * @param {object} params
 * @param {{ occupied?: Set<string>, recOf?: Function }} [opts]
 */
export function capturePlanTask(m, ps, pieces, params, opts = {}) {
  const pgd = ps.gd || m.gd;
  const waveFlag = !!m.wave;
  let boss = null;
  if (!waveFlag && typeof m.bossGroupOf === 'function') {
    const g = m.bossGroupOf(ps);
    boss = g && g.wave ? { tid: g.wave.templateId, side: g.side } : null;
  }
  const bodyUsed = !!(params.body > 0 && boss);
  // fieldModel 幂等预热：真生成体随后同样调用（缓存命中），这里序列化的是同一份
  const modelRaw = fieldModel(m, ps, bodyUsed);
  const bodies = new Map(); // chessId → 补位 body（fieldRecord 输出；与基础记录同则 null）
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
  return {
    seq: 0, // 消费方按批内序号补
    round: m.round, stageId: m.stageId,
    waveFlag, waveTid: m.wave ? m.wave.templateId : undefined,
    bossTid: boss ? boss.tid : undefined, bossSide: boss ? boss.side : undefined,
    bodyUsed,
    key: modelRaw.key,
    model: serializeModel(modelRaw),
    map: [...ps.deployMap()],
    pieces: piecesOut,
    bodies: [...bodies],
    occupied: opts.occupied ? [...opts.occupied] : [],
    params: { ...params, holdTiles: params.holdTiles instanceof Set ? [...params.holdTiles] : undefined },
    placements: plan?.placements ?? [],
    rngState: m.rngBots.state(),
  };
}

/**
 * The worker side: rebuild the fake m / ps over the pool's game data and run the real planLayoutSteps.
 * `rng` (the batch form): the shared mulberry32 stream threaded through the batch's consecutive calls — the
 * batch was captured atomically, so every task carries the same entry state and each call continues where the
 * previous one stopped (the inline path draws them back to back). Without `rng` the task starts from its own
 * captured state (the PoC's per-call replay form).
 */
export function applyPlanTask(gd, c, rng = null) {
  const bossHere = !c.waveFlag && c.bossTid !== undefined;
  // 与 fieldModel 相同的缓存键公式（wave = m.wave || boss && boss.wave）；不一致＝载荷不完整，响亮失败
  const waveTidEff = c.waveFlag ? c.waveTid : (bossHere ? c.bossTid : 'boss');
  const key = `${c.round}|${c.stageId}|${waveTidEff}|${bossHere ? c.bossSide : ''}`;
  if (key !== c.key) throw new Error(`botplan: model key mismatch (worker ${key} != captured ${c.key})`);
  const model = { key, ...rebuildModel(c.model) };
  const m = {
    round: c.round, stageId: c.stageId,
    wave: c.waveFlag ? { templateId: c.waveTid } : null,
    bossGroupOf: bossHere ? () => ({ wave: { templateId: c.bossTid }, side: c.bossSide }) : null,
    gd,
    rngBots: rng || createRngFromState(c.rngState),
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
  const out = runSteps(planLayoutSteps(m, ps, pieces, params, {
    occupied: new Set(c.occupied),
    recOf: (p) => recByUid.get(p.uid),
  }));
  return { plan: serializePlan(out), rngState: m.rngBots.state() };
}

/** The consumer side: rebuild a LayoutPlan (bot.js, Map uid → key + .dirs) from a worker result row set. */
export function planFromResult(LayoutPlan, planRows) {
  const out = new LayoutPlan(planRows.map(([uid, key]) => [uid, key]));
  for (const [uid, , dir] of planRows) out.dirs.set(uid, dir);
  return out;
}

export function serializePlan(out) {
  if (!out) return null;
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([uid, k]) => [uid, k, out.dirs.get(uid) ?? 'RIGHT']);
}

function serializeModel(mo) {
  return {
    routes: mo.routes.map((rt) => ({ ...rt })),
    index: [...mo.index].map(([k, arr]) => [k, arr.map((e) => [e[0], e[1]])]),
    ground: [...mo.ground].map(([k, v]) => [k, { flow: v.flow, prog: v.prog }]),
    airflow: [...mo.airflow].map(([k, v]) => [k, { dir: v.dir, bb: v.bb }]),
    armor: mo.armor.map((a) => ({ ...a })),
    flyTotal: mo.flyTotal,
    lead: mo.lead ? { tiles: [...mo.lead.tiles], strike: mo.lead.strike ? [...mo.lead.strike] : null } : null,
  };
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

function recFor(gd, ref) {
  if (!ref) return null;
  if (ref.t !== undefined) return gd.token(ref.t);
  const base = gd.chess(ref.b);
  if (!base) throw new Error(`botplan: unknown chess ${ref.b}`);
  return ref.g ? Object.freeze({ ...base, rangeGrid: ref.g }) : base;
}
