import { TokenBucket } from './net.js';
import { ROOM_PROTECTION_DEFAULTS as defaults } from './roomConfig.js';

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
    this.counts = { createAllowed: 0, createDenied: 0, startAllowed: 0, startDenied: 0, botDenied: 0 };
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
  /** Count every refusal; sample logs per network/action so one sender cannot hide another. */
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
