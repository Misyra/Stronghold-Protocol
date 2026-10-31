// server/roomProtection.js — per-network room-action budgets (合并自用户分支).
//
// The lobby's *concurrency* caps (maxRoomsPerAddr / maxMatchesPerAddr, lobby.js) bound how much one network can hold
// at once; this limiter additionally bounds how *fast* it may act, so a churn loop (create → leave → create …) cannot
// run ahead of its refill. Budgets are shared by all sessions of one network (the net.js `limitKey`: IPv4 address or
// IPv6 /64) and live in bounded memory (idle keys are pruned).
//
// 默认值内联自用户分支 server/roomConfig.js 的 ROOM_PROTECTION_DEFAULTS（那一半属于房间运行配置 v2 / 房间管理通道，
// 不在本次移植范围；同名常量以这里的为准）。

import { TokenBucket } from './net.js';

/** Default budgets: 4 room creations per 15 s and 4 match starts per 30 s per network. */
export const ROOM_PROTECTION_DEFAULTS = Object.freeze({
  roomCreateBurst: 4,
  roomCreateRefillMs: 15_000,
  matchStartBurst: 4,
  matchStartRefillMs: 30_000,
});
const defaults = ROOM_PROTECTION_DEFAULTS;

/** Bounded budgets shared by sessions on the same IPv4 / IPv6 /64. */
export class RoomActionLimiter {
  constructor({ now = Date.now, maxKeys = 4096, createBurst = defaults.roomCreateBurst, startBurst = defaults.matchStartBurst,
    createRefillMs = defaults.roomCreateRefillMs, startRefillMs = defaults.matchStartRefillMs } = {}) {
    for (const value of [maxKeys, createBurst, startBurst, createRefillMs, startRefillMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('room action limits must be positive integers');
    }
    this.now = now;
    this.maxKeys = maxKeys;
    this.createBurst = createBurst;
    this.startBurst = startBurst;
    this.createRefillMs = createRefillMs;
    this.startRefillMs = startRefillMs;
    this.idleMs = Math.max(300000, createBurst * createRefillMs, startBurst * startRefillMs);
    this.buckets = new Map();
    this.nextPruneAt = -Infinity;
    this.counts = { createAllowed: 0, createDenied: 0, startAllowed: 0, startDenied: 0 };
    this.overflowLog = { at: -Infinity, suppressed: 0 };
  }
  take(key, action) {
    if (!key) { this.counts[action + 'Allowed']++; return true; }
    const now = this.now();
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys && now >= this.nextPruneAt) {
      this.nextPruneAt = now + 10000;
      for (const [k, v] of this.buckets) if (now - v.last >= this.idleMs) this.buckets.delete(k);
    }
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size >= this.maxKeys) return false;
      entry = { create: new TokenBucket(1000 / this.createRefillMs, this.createBurst, now),
        start: new TokenBucket(1000 / this.startRefillMs, this.startBurst, now), last: now, logs: {} };
      this.buckets.set(key, entry);
    }
    entry.last = now;
    const allowed = entry[action].take(now);
    if (allowed) this.counts[action + 'Allowed']++;
    return allowed;
  }
  /** Count every refusal; sample logs (overflow entries share one global sampler — bounded memory) so one sender
   *  cannot flood the log: within 10 s of a sampled refusal further ones only bump `suppressed`. */
  denied(key, action) {
    this.counts[action + 'Denied']++;
    const entry = this.buckets.get(key);
    const sample = entry ? (entry.logs[action] ||= { at: -Infinity, suppressed: 0 }) : this.overflowLog;
    const now = this.now();
    if (now - sample.at < 10000) { sample.suppressed++; return null; }
    const suppressed = sample.suppressed;
    sample.at = now;
    sample.suppressed = 0;
    return suppressed;
  }
  stats() {
    return { ...this.counts, trackedNetworks: this.buckets.size, maxNetworks: this.maxKeys };
  }
}
