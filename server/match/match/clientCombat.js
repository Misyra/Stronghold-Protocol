// server/match/match/clientCombat.js — Match methods: client-side combat bookkeeping (DESIGN §14) — field records (the
// JSON BattleSpec + the authority / result state), spec battles on the server, the field clock, the authority (the
// lowest connected seat), b.start per recipient, result deadlines and releases, server runs (headless slices, the
// simulation pool under SP_BATTLE_POOL, takeovers), field completion → the phase end, and the timers of it all.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { requiresTraitLayerAuthority } from '../operatorTraits.js';
import { PHASE } from '../../../shared/constants.js';
import { DeadBattle, syntheticResult, RESULT_GRACE_MS, HARD_CAP_SECONDS, HeadlessJob } from '../fields.js';
import { buildBattleSpec, createBattleFromSpec } from '../../sim/spec.js';
import { testSlice } from '../testTrace.js';
import { morphBattleOpt } from '../../../shared/plugins/rules.js';

// —— SP_BATTLE_POOL：server-run normal / 联防场把 headless 步进交给模拟线程池（SP_WORKERS 池的 'battle' 任务，
// server/workers/simulation.js）。开关关闭（默认）或池缺席时逐字节现状（本地 8ms 切片路径，_runHeadlessLocal）；
// 池拒绝（POOL_FULL）或任务失败同样回退本地。boss 场（sharedBoss CreditPool 与房池实时联动）与 SP_COMBAT=server
// 的 FieldRunner 流式不池化，留在主线程。
const POOL_ENV_ON = ['1', 'true', 'on', 'yes'];
let BATTLE_POOL_DEFAULT = POOL_ENV_ON.includes(String(process.env.SP_BATTLE_POOL ?? '').trim().toLowerCase());
// 分批让出（SP_BATTLE_POOL_YIELD，默认开）：同窗齐落的多场池结果逐场完整应用、每场之后让出；'0' 退回回调内
// 同步应用（A/B 对照与独立回滚面）。只在池化落地路径被读到，关闭的池路径一次都不会碰它。
let BATTLE_POOL_YIELD = !['0', 'false', 'off', 'no'].includes(String(process.env.SP_BATTLE_POOL_YIELD ?? '').trim().toLowerCase());

/** 测试钩子：SP_BATTLE_POOL 在 import 时读一次，测试用它改运行中的默认值。 */
export function _setBattlePoolForTests(on) { BATTLE_POOL_DEFAULT = on === true; }

/** 测试钩子：SP_BATTLE_POOL_YIELD 在 import 时读一次，测试用它改运行中的默认值。 */
export function _setBattlePoolYieldForTests(on) { BATTLE_POOL_YIELD = on === true; }

/** SP_BATTLE_POOL 的当前默认值（Match 构造在 opts.battlePool 未显式给出时用它；clientCombat.js 是唯一消费方）。 */
export function battlePoolDefault() { return BATTLE_POOL_DEFAULT; }

export class MatchClientCombat {
  /** Stop every client-combat timer and the headless pacer (phase end, finish, dispose). */
  _stopClientCombat() {
    if (this._progressTimer) { this.cancel(this._progressTimer); this._progressTimer = null; }
    if (this._bossClock) { this.cancel(this._bossClock); this._bossClock = null; }
    this._bossClockOn = false;
    // a pending throttled boss refresh: the merged team LP is written back now (m.result / settlement read it)
    if (this._bossPubTimer) { this.cancel(this._bossPubTimer); this._bossPubTimer = null; this._syncTeamLp(); this.markPublic(); }
    this._clearPause();
    if (this._poolTimer) { this.cancel(this._poolTimer); this._poolTimer = null; }
    if (this.pacer) { try { this.pacer.stop(); } catch { /* ignore */ } this.pacer = null; }
    for (const f of this.fields) this._clearFieldTimers(f);
  }

  _clearFieldTimers(f) {
    if (!f || !f.cc) return;
    for (const k of ['deadlineTimer', 'doneTimer', 'waitTimer', 'sliceTimer', 'verifyTimer']) if (f[k]) { this.cancel(f[k]); f[k] = null; }
    f.job = null;
    f.verifyJob = null;
    f.poolLanding = null;
    // SP_BATTLE_POOL：在飞任务取消（dispose / phase end / 场已另判）。队列中即弃，运行中到下个 4ms 分片边界停；
    // 池自己的契约收摊那个线程槽（与 rehearsal 取消同款）。回执处理按 _poolTask 已清空判陈旧，不再落任何结果。
    if (f.poolTask) { const task = f.poolTask; f.poolTask = null; try { task.cancel(); } catch { /* the pool settles the promise; the awaiter ignores it */ } }
  }

  /**
   * A client-combat field record: the JSON BattleSpec of its Battle options plus the authority / result state. The spec
   * names the room's content set (`cs`, opts.cs — DESIGN §32) when the match was given one.
   */
  _ccField({ fieldId, kind, players, opts, boss = null }) {
    const seq = `${this.battlePrefix}.${this.round}.${++this._battleSeq}`;
    // protocol ids are ≤ 64 chars (shared/protocol.js isId): the field id is informational, the sequence is unique
    const battleId = seq.length + 1 + String(fieldId).length <= 64 ? `${seq}.${fieldId}` : seq;
    const spec = buildBattleSpec({ ...opts, ...morphBattleOpt(this.rules), battleId, fieldId, kind, content: this.battleContent, boss, cs: this.cs, vs: this.vs, version: this.data.config?.version?.id });
    let total = 0;
    for (const x of spec.spawns) if (x && x.tag !== 'boss' && x.tag !== 'part' && x.countInTotal !== false) total += Math.max(1, Math.floor(Number(x.count) || 1));
    return {
      cc: true, fieldId, kind, players: players.slice(), battleId, spec, battle: null, live: true, done: false,
      mode: null, authority: null, startAt: this.sched.now(), result: null, resultSource: null, timeline: null, endGt: null,
      // progress: the field's own numbers as far as they are known before its first b.progress / result (`total` = the
      // spec's scheduled enemies — the capsule's denominator). `resolved` starts at **null**: it is only adopted from a
      // real report, so `resolved ?? killed` fallbacks (an unreported field, a synthetic result) keep working — a 0 here
      // would read as "nothing resolved yet" and could never be told apart from a reported 0.
      progress: { gt: 0, killed: 0, total, leaks: 0, resolved: null, done: false }, lastProgressAt: this.sched.now(),
      bossAcked: 0, bossBy: {}, lpAcked: 0, lpCum: 0, deadlineTimer: null, doneTimer: null, waitTimer: null,
      // boss fields: the latest client reports (re-credited as the plausibility budget grows), the server run's
      // CreditPool, humans demoted for an implausible result (never the authority of this field again), a 'cleared'
      // b.result waiting for the budget to credit the pool it emptied (`heldResult`, _onResult); `leaksBy`: the authority's
      // per-player split of the LP its enemy leaks cost (b.progress, the highest value seen; null until one carried it),
      // which a result must not contradict before a perfect-payout bounty pays (_bossLeaksAgree)
      bossReported: null, lpReported: 0, credit: null, demoted: new Set(), heldResult: null, leaksBy: null,
      // SP_BATTLE_POOL: the simulation pool task in flight ({ promise, cancel, attempt }), null otherwise
      poolTask: null,
      // 分批让出：本场的落地令牌（_poolLand / _poolLandApply 的陈旧性复查），null 之外只在结果与下一个
      // 事件循环轮次之间短暂持有
      poolLanding: null,
    };
  }

  /** A battle built from a spec on the server (headless / takeover / verification); never throws. */
  _specBattle(spec, { sharedBoss = null } = {}) {
    try {
      return createBattleFromSpec(spec, this.ds, { BattleClass: this.BattleClass, sharedBoss, logger: this.log, recordEvents: false });
    } catch (e) {
      this.reportError(`battle ${spec && spec.fieldId} construct`, e);
      return new DeadBattle({ fieldId: spec && spec.fieldId, kind: spec && spec.kind, players: (spec && spec.players) || [], rect: spec && spec.rect, stageId: spec && spec.stageId }, 'forced');
    }
  }

  /** Game seconds a field has run (its clock; a finished field: its final time). */
  _fieldElapsed(f) {
    if (f.done && f.result && Number.isFinite(f.result.time)) return f.result.time;
    const gt = Math.max(0, ((this._clockNow() - f.startAt) / 1000) * this.gameSpeed);
    if (f.endGt != null) return Math.min(gt, f.endGt);
    const lim = f.spec && f.spec.timeLimit > 0 ? f.spec.timeLimit : HARD_CAP_SECONDS;
    return Math.min(gt, lim);
  }

  /** The connected human who simulates a field: lowest seat among its players (normal: the owner). */
  _authorityFor(f, exclude = null) {
    // [ASSUMED] Layer traits require an authoritative run, even with SP_VERIFY=off.
    // Use the existing sliced server path (also for shared boss pools) before assigning any client.
    if (requiresTraitLayerAuthority(f.spec, this.gd)) return null;
    let best = null;
    for (const pid of f.players) {
      if (pid === exclude || (f.demoted && f.demoted.has(pid))) continue;
      const ps = this.players.get(pid);
      if (!ps || ps.isBot || ps.left || !ps.connected) continue;
      if (!best || ps.seat < best.seat) best = ps;
    }
    return best ? best.playerId : null;
  }

  /** b.start of a field for one recipient (`watch`: not a player of the field); the spec hides every other player's funds. */
  _startMsg(f, pid, { watch = false } = {}) {
    return {
      t: 'b.start', battleId: f.battleId, fieldId: f.fieldId, kind: f.kind,
      spec: this._viewSpec(f, pid),
      authoritative: !!(!f.done && !f.verifyJob && f.mode === 'client' && f.authority === pid && !watch),
      startAt: f.startAt, serverNow: this.sched.now(), elapsed: Math.round(this._fieldElapsed(f) * 1000) / 1000,
      speed: this.gameSpeed, watch: !!watch, done: !!f.done,
    };
  }

  _sendStart(pid, f, opts = {}) {
    const ps = this.players.get(pid) || this.spectators.get(pid);
    if (!ps || ps.isBot || ps.left || !ps.connected) return false;
    return this.sendTo(pid, this._startMsg(f, pid, opts));
  }

  /** Give every field its authority (a connected human) or run it on the server. */
  _launch(fields) {
    const now = this.sched.now();
    this.fields = fields;
    for (const f of fields) { f.startAt = now; f.lastProgressAt = now; }
    for (const f of fields) {
      const auth = this._authorityFor(f);
      if (auth) this._assignClient(f, auth);
      else this._runOnServer(f, 'no-human');
    }
  }

  _assignClient(f, pid) {
    f.mode = 'client';
    f.authority = pid;
    f.lastProgressAt = this.sched.now();
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    if (f.kind === 'boss' || f.kind === 'hidden') return; // the pool / team LP / silence watchdog end those
    if (this.paused) { f.rearmDeadline = true; return; }
    this._armDeadline(f);
  }

  /** A client field's result deadline: its time limit on the field clock + RESULT_GRACE_MS (then the server takes over). */
  _armDeadline(f) {
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    if (f.verifyJob) return;
    const lim = f.spec.timeLimit > 0 ? f.spec.timeLimit : 60;
    const at = f.startAt + Math.round((lim / this.gameSpeed) * 1000) + RESULT_GRACE_MS;
    f.deadlineTimer = this.later(Math.max(0, at - this.sched.now()), () => {
      f.deadlineTimer = null;
      if (f.done || f.mode !== 'client') return;
      this._runOnServer(f, 'timeout');
    });
  }

  /** A server-run normal / 联防 field's result is released at the battle's natural end on the field clock. */
  _armRelease(f) {
    if (f.doneTimer) { this.cancel(f.doneTimer); f.doneTimer = null; }
    if (f.done || f.result == null) return;
    if (this.paused) { f.rearmRelease = true; return; }
    const doneAt = f.startAt + Math.round(((f.endGt || 0) / this.gameSpeed) * 1000);
    const wait = this.sched.instant ? 0 : Math.max(0, doneAt - this.sched.now());
    f.doneTimer = this.later(wait, () => { f.doneTimer = null; this._fieldDone(f); });
  }

  /**
   * The server simulates a field: normal / 联防 headlessly at once (the result is released at the battle's natural end
   * on the field's clock, so the teammates' progress UI and the round pacing stay as if it ran live); boss fields in
   * real time on the pacer (they share the pool), fast-forwarded to the field's clock on a takeover. Under
   * SP_BATTLE_POOL a normal / 联防 field's battle runs in a simulation-pool worker instead (its result is released the
   * same way); a missing or refusing pool falls back to the local sliced path — the pre-change behaviour, byte for
   * byte.
   */
  _runOnServer(f, reason) {
    const prev = f.mode === 'client' ? f.authority : null;
    if (prev) {
      this.verifyStats.takeovers++;
      this.log.info?.(`[match ${this.roomCode}] ${f.fieldId} R${this.round}: server takeover from ${prev} (${reason})`);
    }
    f.mode = 'server';
    f.authority = null;
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    // the former authority (still online after a timeout / an invalid result) stops reporting and keeps its view
    if (prev) this.sendTo(prev, { t: 'b.end', battleId: f.battleId, fieldId: f.fieldId, reason: 'takeover' });
    if (f.kind === 'boss' || f.kind === 'hidden') { this._bossServerRun(f); return; }
    if (this.battlePool && this.simPool && this.test !== true && this._runHeadlessOnPool(f)) {
      this._armProgressTicker();
      return;
    }
    this._runHeadlessLocal(f);
    this._armProgressTicker();
  }

  /**
   * The pre-pool path: the battle steps on this thread in wall-clock slices (also the pool's fallback, and the
   * virtual-time / test-match path).
   */
  _runHeadlessLocal(f) {
    const job = new HeadlessJob(this._specBattle(f.spec), { onError: (e) => this.reportError(`field ${f.fieldId} step`, e), players: f.players });
    f.job = job;
    f.battle = job.battle;
    f.timeline = job.timeline; // grows while the job runs (the teammates' progress UI reads it on the field clock)
    if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; }
    const complete = () => {
      if (f.job !== job || f.done) return;
      f.job = null;
      const run = job.output();
      f.battle = run.battle;
      f.result = run.result;
      f.resultSource = 'server';
      f.timeline = run.timeline;
      f.endGt = Number(run.battle.time) || 0;
      this._armRelease(f);
    };
    const sliceCtl = testSlice(this);
    if (!Number.isFinite(this.headlessSliceMs)) {
      job.run(Infinity, undefined, sliceCtl);
      complete();
    } else {
      // a real host: wall-clock-bounded slices in callbacks of their own (3 bot fields at combat start would otherwise
      // block the event loop for ~0.2–0.5 s here, seconds on a low-power mini PC)
      const slice = () => {
        f.sliceTimer = null;
        if (f.job !== job || f.done) return;
        if (job.run(this.headlessSliceMs, undefined, sliceCtl)) complete();
        else f.sliceTimer = this.later(0, slice);
      };
      f.sliceTimer = this.later(0, slice);
    }
  }

  /**
   * SP_BATTLE_POOL: submit the field's spec to the simulation pool's 'battle' task (server/workers/simulation.js) and
   * mirror its real return shape `{ result, timeline, time, errors, crashed }`: the result/timeline/endGt land on the
   * field exactly as the local run's, the release stays at the battle's natural end on the field clock (_armRelease),
   * and the timeline grows from the worker's progress messages (reset opens it, the samples append). The pool's
   * refusal (POOL_FULL / closed) arrives as a rejection, not a throw — the rejection handler falls back to the local
   * path; so does a value that is not the worker's documented shape (the d3fffd27 lesson: never guess). Returns false
   * only when the submit itself threw (the caller falls through to the local path at once). `_poolTask` holds the
   * attempt token: a stale answer (cleared, force-done, superseded by the fallback) applies nothing. Cancel
   * (dispose / phase end / the field judged otherwise): `_clearFieldTimers` calls handle.cancel() — a queued task is
   * dropped, a running one stops at its next 4 ms slice boundary (the pool's own contract retires that worker slot).
   * @returns {boolean} true when the task is in flight
   */
  _runHeadlessOnPool(f) {
    const attempt = {};
    let handle;
    try {
      handle = this.simPool.submit('battle', { spec: f.spec, players: f.players, progress: true }, {
        onProgress: (p) => this._poolTimeline(f, attempt, p),
      });
    } catch (e) {
      this.reportError(`field ${f.fieldId} pool submit`, e);
      return false;
    }
    f.poolTask = { promise: handle.promise, cancel: handle.cancel, attempt };
    f.battle = null; // a pool-run field holds no battle object; its errors travel on f.errors (see _collectSimErrors)
    f.job = null;
    f.timeline = null; // opens with the worker's first progress message; until then the views read f.progress
    f.endGt = null;
    const stale = () => !f.poolTask || f.poolTask.attempt !== attempt || f.done || this.disposed || this.ended;
    handle.promise.then((value) => {
      if (stale()) return;
      f.poolTask = null;
      if (!value || typeof value !== 'object' || !value.result || typeof value.result !== 'object' || !value.result.perPlayer) {
        this.reportError(`field ${f.fieldId} pool result`, new Error('unexpected battle task payload'));
        this._runHeadlessLocal(f);
        return;
      }
      this._poolLand(f, attempt, value);
    }, (err) => {
      if (stale()) return;
      f.poolTask = null;
      this.reportError(`field ${f.fieldId} pool`, err);
      this._runHeadlessLocal(f); // POOL_FULL / worker failure / timeout: the pre-change path
    });
    return true;
  }

  /**
   * SP_BATTLE_POOL 分批让出：同窗齐落的多场池结果逐场完整应用，每场之后让出一个事件循环轮次——promise 回调、
   * result 克隆、_armRelease 与 m.public 扇出不再全部挤同一个事件循环块（风暴窗）。窗口按完成序（FIFO）落；
   * 每个窗口的头场仍在回调当拍应用——单场落地与关闭让出时逐字节同时序，让出只改变多场之间的落地交错，
   * 单场内部不变。门在一个队列已空的轮次关上；同一拍微任务里背靠背排进来的后续结果因此也逐场让出。
   * SP_BATTLE_POOL_YIELD=0 退回回调内同步应用。虚拟调度器（测试 / 工具）的步进同时挂一个调度器 timer，
   * 同步的 h.run 循环泵得到它——生产行为只有 setImmediate 一条路。
   */
  _poolLand(f, attempt, value) {
    f.poolLanding = attempt;
    if (!BATTLE_POOL_YIELD) { this._poolLandApply(f, attempt, value); return; }
    const q = (this._poolLandQueue ??= []);
    q.push({ f, attempt, value });
    if (this._poolLanding || q.length > 1) return; // 窗口已开：排在本场之后，由在飞的步进逐场取用
    this._poolLanding = true;
    this._poolLandStep();
  }

  _poolLandStep() {
    const q = this._poolLandQueue;
    const item = q && q.shift();
    if (!item) { this._poolLanding = false; this._poolLandQueue = null; return; }
    this._poolLandApply(item.f, item.attempt, item.value);
    if (this.sched.virtual) this.later(0, () => this._poolLandStep());
    else setImmediate(() => this._poolLandStep()); // check 阶段：越过送来 worker 消息的 poll 批次再落下一场
  }

  /**
   * One landed pool result, applied whole (the pre-yield promise-callback body): the field's result / timeline /
   * endGt / errors and the natural-end release timer. The landing token re-checks staleness at apply time — a queued
   * item may wait a few event-loop turns while the field is cancelled (`_clearFieldTimers` nulls the token), re-run
   * (a newer attempt owns the token; an in-flight newer task fails the `_poolTask` guard) or judged done.
   */
  _poolLandApply(f, attempt, value) {
    if (f.poolLanding !== attempt || f.poolTask) return;
    f.poolLanding = null;
    if (f.done || this.disposed || this.ended) return;
    f.result = value.result;
    f.resultSource = 'server';
    f.timeline = Array.isArray(value.timeline) ? value.timeline : f.timeline;
    f.endGt = Number(value.time) || 0;
    if (Array.isArray(value.errors) && value.errors.length) f.errors = value.errors;
    this._armRelease(f);
  }

  /**
   * The pool worker's progress message: `{ reset, samples }` — timeline samples ([[gt, killed, total, resolved(,
   * left)], …]) of the running battle. `reset` opens a fresh timeline (the first message); the samples append in
   * order. A stale attempt (task cancelled, field re-run) applies nothing.
   */
  _poolTimeline(f, attempt, p) {
    if (!p || !Array.isArray(p.samples) || !f || !f.poolTask || f.poolTask.attempt !== attempt) return;
    if (p.reset || !Array.isArray(f.timeline)) f.timeline = p.samples.slice();
    else f.timeline.push(...p.samples);
  }

  /** m.public ~1 Hz while server-run fields progress along their timelines. */
  _armProgressTicker() {
    if (this._progressTimer || this.sched.instant) return;
    const tick = () => {
      this._progressTimer = null;
      if (!this.fields.some((f) => f.cc && f.mode === 'server' && !f.done && f.timeline)) return;
      this.markPublic();
      this._progressTimer = this.later(1000, tick);
    };
    this._progressTimer = this.later(1000, tick);
  }

  /** A field has its final result. */
  _fieldDone(f) {
    if (!f || f.done) return;
    f.done = true;
    f.live = false;
    this._clearFieldTimers(f);
    if (!f.result) f.result = syntheticResult(f.players, { bossBy: f.bossBy });
    f.progress.done = true;
    this.markPublic();
    this._maybeFieldsDone();
  }

  _maybeFieldsDone() {
    if (!this.fields.length || this.fields.some((f) => f.cc && !f.done)) return;
    if (!this.fields.every((f) => f.cc)) return;
    if (this.phase === PHASE.COMBAT) this._finishCombat((f) => f.result);
    else if (this.phase === PHASE.UNITE) this._finishUniteClient();
    else if (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) this._finishFinal(this.phase === PHASE.HIDDEN_CORE, (f) => f.result);
  }

  /** An authoritative human disconnected / left: normal & 联防 fields → server takeover; boss → the partner or the server. */
  _authorityLost(ps, why) {
    for (const f of this.fields) {
      if (!f.cc || f.done || f.verifyJob || f.mode !== 'client' || f.authority !== ps.playerId) continue;
      if (f.kind === 'boss' || f.kind === 'hidden') this._bossHandover(f, why);
      else this._runOnServer(f, why);
    }
  }
}
