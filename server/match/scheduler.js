// server/match/scheduler.js — injectable time source + timers for the match engine.
//
// The match never touches setTimeout/Date.now directly: it asks a scheduler. Two implementations:
//
//   RealScheduler({ now })        production: wall-clock timers (unref'd so a stray timer never keeps the process
//                                 alive). `now` defaults to Date.now (the lobby passes its injectable clock).
//   VirtualScheduler({ start, instantCombat })
//                                 tests / tools: a priority queue of callbacks on a virtual clock. Nothing runs until
//                                 the owner advances time (advance / runNext / runUntil / runAll). With
//                                 `instantCombat: true` (default) the match steps battles to completion synchronously
//                                 inside one callback instead of pacing them at 2× real time, so an entire match runs
//                                 in milliseconds of wall time.
//
// Common interface: now(), setTimeout(fn, ms) → handle, clearTimeout(handle), setInterval(fn, ms) → handle,
// clearInterval(handle), dispose(). Flags: `virtual` (bool), `instant` (bool: battles run synchronously).
// Callbacks are expected to guard themselves; the schedulers still catch and report (onError) so one faulty
// callback never breaks the queue.
//
// RealScheduler additionally carries the main-thread turn budget (SP_TURN_BUDGET_MS, default 50; 0 = off):
// libuv drains every timer due at the same moment inside one timers turn — each slice is bounded
// (botSliceMs / headlessSliceMs / the 20 ms battle tick) but the turn is not, so its length is the sum of
// the batch (the 2026-11-07 production stack samples: every ≥150 ms pause entered through
// processTimers → listOnTimeout → RealScheduler._wrap). The gate lives in _wrap: once a turn has
// dispatched SP_TURN_BUDGET_MS worth of callback time, further due callbacks are re-queued with
// setTimeout(1) through the same wrapper (same accounting); a setImmediate (the check phase — it runs
// between two timer drains) resets the accumulator, so deferred work always gets the next turn. A
// callback that already started is never preempted. 0 keeps the pre-change wrapper verbatim: no clock
// reads, no extra handles, nothing on the hot path. Deferred work respects clearTimeout/clearInterval/
// dispose (a cancelled or disposed timer's deferred continuation never runs).

import { performance } from 'node:perf_hooks';

const MAX_DELAY = 2 ** 31 - 1;
const clampDelay = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_DELAY, n);
};

// —— turn budget（SP_TURN_BUDGET_MS，默认 50；0 = 关）——
// 累计器是模块级的：一个 timers turn 会排空所有对局（每个对局有自己的 RealScheduler 实例）的定时器，
// 预算必须对它们共享同一份。

const TURN_BUDGET_DEFAULT = 50;

const parseTurnBudget = (raw) => {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n) || n < 0) return TURN_BUDGET_DEFAULT;
  return n;
};

let TURN_BUDGET_MS = parseTurnBudget(process.env.SP_TURN_BUDGET_MS);
let turnSpentMs = 0; // 当前 turn 已派发的回调时长（ms）
let turnResetPending = false; // 已有一个 setImmediate 在排队清零——同一轮多次超支不再叠加定时器

const resetTurnSpent = () => {
  turnSpentMs = 0;
  turnResetPending = false;
};

const armTurnReset = () => {
  if (turnResetPending) return;
  turnResetPending = true;
  setImmediate(resetTurnSpent);
};

/** 测试钩子：SP_TURN_BUDGET_MS 在 import 时读一次，测试用它改运行中的值并清掉上一轮的残账。 */
export function _setTurnBudgetForTests(ms) {
  TURN_BUDGET_MS = parseTurnBudget(ms == null ? undefined : String(ms));
  turnSpentMs = 0;
  turnResetPending = false;
}

export class RealScheduler {
  /** @param {{ now?: () => number, onError?: (e: unknown) => void }} [opts] */
  constructor({ now = Date.now, onError = null } = {}) {
    this.virtual = false;
    this.instant = false;
    this._now = typeof now === 'function' ? now : Date.now;
    this._onError = onError;
    /** @type {Set<any>} */
    this._timeouts = new Set();
    /** @type {Set<any>} */
    this._intervals = new Set();
    /** 已顺延的 timeout（原 handle → 顺延句柄）：clearTimeout(原 handle) 要能取消顺延中的工作。
     *  惰性创建——关闸（预算 0）时一个 Map 也不分配。 */
    this._deferred = null;
    this.disposed = false;
  }

  now() {
    try { return Number(this._now()) || Date.now(); } catch { return Date.now(); }
  }

  _wrap(fn) {
    if (!TURN_BUDGET_MS) {
      // 关闸（SP_TURN_BUDGET_MS=0）：与改动前逐字节等价的直通路径——没有时钟读数、没有额外句柄。
      return () => {
        try { fn(); } catch (e) { if (this._onError) this._onError(e); else console.error('[scheduler] callback threw', e); }
      };
    }
    const wrapped = (h, interval) => {
      if (turnSpentMs >= TURN_BUDGET_MS) { this._defer(wrapped, h, interval); return; }
      const t0 = performance.now();
      try { fn(); } catch (e) { if (this._onError) this._onError(e); else console.error('[scheduler] callback threw', e); }
      turnSpentMs += performance.now() - t0;
      if (turnSpentMs >= TURN_BUDGET_MS) armTurnReset();
    };
    return wrapped;
  }

  /**
   * 预算耗尽后把一个到期回调顺延到下一个 turn：setTimeout(1)，仍走同一包装（wrapped）重新计量，
   * 预算仍耗尽就再次顺延。顺延句柄登记在 _timeouts 里（dispose 一并清掉）；timeout 顺延另记在
   * _deferred（原 handle → 顺延句柄），clearTimeout(原 handle) 仍能取消顺延中的工作；interval 顺延
   * 在执行前复查 _intervals——clearInterval 之后必然为假，顺延中的工作不执行。
   */
  _defer(wrapped, h, interval) {
    if (this.disposed) return;
    const dh = setTimeout(() => {
      this._timeouts.delete(dh);
      if (interval) {
        if (!this._intervals.has(h)) return; // 已 clearInterval：顺延中的工作不执行
      } else if (h !== undefined) {
        if (this._deferred?.get(h) !== dh) return; // 已 clearTimeout：顺延中的工作不执行
        this._deferred.delete(h);
      }
      if (this.disposed) return;
      wrapped(h, interval);
    }, 1);
    dh.unref?.();
    this._timeouts.add(dh);
    if (!interval && h !== undefined) (this._deferred ??= new Map()).set(h, dh);
  }

  setTimeout(fn, ms) {
    if (this.disposed || typeof fn !== 'function') return null;
    const run = this._wrap(fn);
    if (!TURN_BUDGET_MS) {
      const h = setTimeout(() => { this._timeouts.delete(h); run(); }, clampDelay(ms));
      h.unref?.();
      this._timeouts.add(h);
      return h;
    }
    // 开闸时把原 handle 传进包装：顺延句柄要能被 clearTimeout(原 handle) 取消（关闸包装忽略入参）。
    const h = setTimeout(() => { this._timeouts.delete(h); run(h); }, clampDelay(ms));
    h.unref?.();
    this._timeouts.add(h);
    return h;
  }

  clearTimeout(h) {
    if (!h) return;
    const dh = this._deferred?.get(h);
    if (dh !== undefined) {
      this._deferred.delete(h);
      this._timeouts.delete(dh);
      clearTimeout(dh);
    }
    clearTimeout(h);
    this._timeouts.delete(h);
  }

  setInterval(fn, ms) {
    if (this.disposed || typeof fn !== 'function') return null;
    if (!TURN_BUDGET_MS) {
      const h = setInterval(this._wrap(fn), Math.max(1, clampDelay(ms)));
      h.unref?.();
      this._intervals.add(h);
      return h;
    }
    const run = this._wrap(fn);
    const h = setInterval(() => { run(h, true); }, Math.max(1, clampDelay(ms)));
    h.unref?.();
    this._intervals.add(h);
    return h;
  }

  clearInterval(h) {
    if (!h) return;
    clearInterval(h);
    this._intervals.delete(h);
  }

  dispose() {
    this.disposed = true;
    for (const h of this._timeouts) clearTimeout(h);
    for (const h of this._intervals) clearInterval(h);
    this._timeouts.clear();
    this._intervals.clear();
    if (this._deferred) {
      for (const dh of this._deferred.values()) clearTimeout(dh);
      this._deferred.clear();
    }
  }
}

export class VirtualScheduler {
  /**
   * @param {{ start?: number, instantCombat?: boolean, onError?: (e: unknown) => void }} [opts]
   */
  constructor({ start = 1_700_000_000_000, instantCombat = true, onError = null } = {}) {
    this.virtual = true;
    this.instant = instantCombat !== false;
    this.t = Number(start) || 0;
    this._seq = 0;
    /** @type {Array<{ id: number, at: number, seq: number, fn: Function, every: number, cancelled: boolean }>} */
    this._q = [];
    this._onError = onError;
    this.disposed = false;
    /** callbacks executed so far (diagnostics) */
    this.executed = 0;
    /** errors thrown by callbacks (tests assert this stays empty) */
    this.errors = [];
  }

  now() { return this.t; }

  _push(fn, ms, every) {
    if (this.disposed || typeof fn !== 'function') return null;
    const e = { id: ++this._seq, at: this.t + clampDelay(ms), seq: this._seq, fn, every, cancelled: false };
    // binary insertion keeps the queue sorted by (at, seq)
    let lo = 0;
    let hi = this._q.length;
    while (lo < hi) { // loop-cap: binary search
      const mid = (lo + hi) >> 1;
      const o = this._q[mid];
      if (o.at < e.at || (o.at === e.at && o.seq < e.seq)) lo = mid + 1; else hi = mid;
    }
    this._q.splice(lo, 0, e);
    return e;
  }

  setTimeout(fn, ms) { return this._push(fn, ms, 0); }
  clearTimeout(h) { if (h && typeof h === 'object') h.cancelled = true; }
  setInterval(fn, ms) { return this._push(fn, Math.max(1, clampDelay(ms)), Math.max(1, clampDelay(ms))); }
  clearInterval(h) { if (h && typeof h === 'object') h.cancelled = true; }

  /** Number of live (not cancelled) queued callbacks. */
  pending() {
    let n = 0;
    for (const e of this._q) if (!e.cancelled) n++;
    return n;
  }

  /** Time of the next live callback, or null. */
  nextAt() {
    while (this._q.length && this._q[0].cancelled) this._q.shift(); // loop-cap: queue of timers
    return this._q.length ? this._q[0].at : null;
  }

  /** Run the earliest callback (advancing the clock to it). Returns false when the queue is empty. */
  runNext() {
    while (this._q.length && this._q[0].cancelled) this._q.shift(); // loop-cap: queue of timers
    const e = this._q.shift();
    if (!e) return false;
    if (e.at > this.t) this.t = e.at;
    if (e.every > 0) {
      // re-arm before running so the callback may clear itself
      e.at = this.t + e.every;
      e.seq = ++this._seq;
      this._reinsert(e);
    }
    this.executed++;
    try { e.fn(); } catch (err) {
      this.errors.push(err);
      if (this._onError) this._onError(err); else console.error('[virtual scheduler] callback threw', err);
    }
    return true;
  }

  _reinsert(e) {
    let lo = 0;
    let hi = this._q.length;
    while (lo < hi) { // loop-cap: binary search
      const mid = (lo + hi) >> 1;
      const o = this._q[mid];
      if (o.at < e.at || (o.at === e.at && o.seq < e.seq)) lo = mid + 1; else hi = mid;
    }
    this._q.splice(lo, 0, e);
  }

  /** Advance the clock by `ms`, running every callback that falls due (in order). */
  advance(ms) {
    const target = this.t + Math.max(0, Number(ms) || 0);
    for (;;) {
      const at = this.nextAt();
      if (at == null || at > target) break;
      this.runNext();
    }
    if (target > this.t) this.t = target;
  }

  /**
   * Run callbacks until `pred()` is true (checked before each callback), the queue is empty, or a limit is hit.
   * Returns true when the predicate held.
   */
  runUntil(pred, { maxSteps = 1e7, maxTime = Infinity } = {}) {
    const limitT = this.t + maxTime;
    for (let i = 0; i < maxSteps; i++) {
      if (pred()) return true;
      const at = this.nextAt();
      if (at == null || at > limitT) return !!pred();
      this.runNext();
    }
    return !!pred();
  }

  /** Run until the queue is empty (or maxSteps). Returns the number of callbacks run. */
  runAll({ maxSteps = 1e7 } = {}) {
    let n = 0;
    while (n < maxSteps && this.runNext()) n++; // loop-cap: maxSteps
    return n;
  }

  dispose() {
    this.disposed = true;
    for (const e of this._q) e.cancelled = true;
    this._q = [];
  }
}
