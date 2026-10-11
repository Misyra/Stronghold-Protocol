// Adapted from xinhai-ai/Stronghold-Protocol commit 23d0a929 (GPL-3.0-or-later).
import { monitorEventLoopDelay, performance, PerformanceObserver, constants } from 'node:perf_hooks';
import { C2S } from '../shared/protocol.js';

// Bounded histograms: no per-player data, frame contents, or growing sample arrays.
const BOUNDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024,
  2048, 4096, 8192, 16384, 32768, 65536, Infinity];
export class TimingHistogram {
  constructor() { this.count = 0; this.totalMs = 0; this.maxMs = 0; this.buckets = new Float64Array(BOUNDS.length); }
  record(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.count++;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
    this.buckets[BOUNDS.findIndex((bound) => ms <= bound)]++;
  }
  stats() {
    const percentile = (p) => {
      if (!this.count) return 0;
      let n = 0;
      for (let i = 0; i < BOUNDS.length; i++) {
        n += this.buckets[i];
        if (n >= Math.ceil(this.count * p)) return Math.min(BOUNDS[i], this.maxMs);
      }
      return this.maxMs;
    };
    return { count: this.count, avgMs: this.count ? this.totalMs / this.count : 0,
      maxMs: this.maxMs, p95UpperMs: percentile(0.95), p99UpperMs: percentile(0.99) };
  }
}

export class NetDiagnostics {
  constructor({ windowMs = 15000 } = {}) {
    this.startedAt = performance.now();
    this.eluStart = performance.eventLoopUtilization();
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.intervals = new ProcessIntervals({ windowMs });
    this.receivedFrames = 0;
    this.receivedBytes = 0;
    this.handlers = new Map();
    this.sendCompletion = new TimingHistogram();
    this.sentFrames = 0;
    this.sentBytes = 0;
    this.droppedSnapshots = 0;
    this.slowDisconnects = 0;
  }
  received(type, bytes, elapsedMs) {
    // Arbitrary incoming type strings cannot grow the histogram map.
    if (!Object.hasOwn(C2S, type)) type = 'invalid';
    this.receivedFrames++;
    this.receivedBytes += bytes;
    if (!this.handlers.has(type)) this.handlers.set(type, new TimingHistogram());
    this.handlers.get(type).record(elapsedMs);
  }
  sent(data) {
    this.sentFrames++;
    this.sentBytes += Buffer.byteLength(data);
  }
  sendCallback() {
    // Sample callbacks to keep the hot send path cheap. This is local completion,
    // including compression/TCP queuing, not delivery or client RTT.
    if ((this.sentFrames + 1) % 64) return null;
    const start = performance.now();
    return (err) => { if (!err) this.sendCompletion.record(performance.now() - start); };
  }
  stats() {
    const ms = (value) => Number.isFinite(value) ? value / 1e6 : 0;
    return { period: 'sinceStart', elapsedSec: (performance.now() - this.startedAt) / 1000,
      eventLoop: { resolutionMs: 20, utilization: performance.eventLoopUtilization(this.eluStart).utilization,
        meanMs: this.loop.count ? ms(this.loop.mean) : 0, maxMs: this.loop.count ? ms(this.loop.max) : 0,
        p95Ms: this.loop.count ? ms(this.loop.percentile(95)) : 0, p99Ms: this.loop.count ? ms(this.loop.percentile(99)) : 0 },
      receivedFrames: this.receivedFrames, receivedBytes: this.receivedBytes,
      sentFrames: this.sentFrames, sentBytes: this.sentBytes,
      droppedSnapshots: this.droppedSnapshots, slowDisconnects: this.slowDisconnects,
      handlerMs: Object.fromEntries([...this.handlers].map(([type, timing]) => [type, timing.stats()])),
      sendCompletionMs: { sampleEvery: 64, ...this.sendCompletion.stats() } };
  }
  close() { this.loop.disable(); this.intervals.close(); }
}

// Completed windows are independent of readers. Keep two minutes of bounded
// history so polling on either side of a boundary need not lose a short freeze.
export class ProcessIntervals {
  constructor({ windowMs = 15000 } = {}) {
    if (!Number.isFinite(windowMs) || windowMs < 50) throw new RangeError('Invalid diagnostics window');
    this.windowMs = windowMs;
    this.startedAt = Date.now();
    this.monoStart = performance.now();
    this.sequence = 0;
    this.history = [];
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.gc = this.emptyGc();
    this.observer = new PerformanceObserver((list) => this.recordGc(list.getEntries()));
    this.observer.observe({ entryTypes: ['gc'] });
    this.timer = setInterval(() => this.settle(), windowMs);
    this.timer.unref();
  }
  emptyGc() {
    return { count: 0, totalMs: 0, maxMs: 0, over20: 0, over50: 0,
      byKind: { minor: 0, major: 0, incremental: 0, weakcb: 0, unknown: 0 } };
  }
  recordGc(entries) {
    const kinds = { [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
      [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
      [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
      [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb' };
    for (const entry of entries) {
      if (!Number.isFinite(entry.duration) || entry.duration < 0) continue;
      this.gc.count++; this.gc.totalMs += entry.duration;
      this.gc.maxMs = Math.max(this.gc.maxMs, entry.duration);
      if (entry.duration > 20) this.gc.over20++;
      if (entry.duration > 50) this.gc.over50++;
      this.gc.byKind[kinds[entry.detail?.kind] || 'unknown']++;
    }
  }
  settle() {
    this.recordGc(this.observer.takeRecords());
    const endedAt = Date.now(), monoEnd = performance.now();
    const ms = (n) => this.loop.count && Number.isFinite(n) ? n / 1e6 : null;
    const window = { sequence: ++this.sequence, startedAt: this.startedAt, endedAt,
      windowMs: monoEnd - this.monoStart,
      eventLoop: { resolutionMs: 20, count: this.loop.count,
        p50Ms: ms(this.loop.percentile(50)), p90Ms: ms(this.loop.percentile(90)),
        p99Ms: ms(this.loop.percentile(99)), maxMs: ms(this.loop.max) },
      gc: this.gc };
    this.history.push(window);
    if (this.history.length > 8) this.history.shift();
    this.loop.reset(); this.gc = this.emptyGc();
    this.startedAt = endedAt; this.monoStart = monoEnd;
  }
  snapshot() {
    // Defensive copies prevent API callers from altering later observations.
    return structuredClone({ period: 'completedWindows', windowTargetMs: this.windowMs,
      latest: this.history.at(-1) || null, windows: this.history });
  }
  close() { clearInterval(this.timer); this.observer.disconnect(); this.loop.disable(); }
}

export const socketDiagnostics = new WeakMap();
