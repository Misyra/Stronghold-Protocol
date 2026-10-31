// Opt-in per-phase main-thread timings for the coordinator's /healthz `performance.phases` block.
// A phase is one synchronous chunk of work (one presence slice, one receipt commit, one message handler …)
// measured with performance.now(); `static.*` and `receipt.worker` are wall times that include awaited I/O.
// Fixed buckets, no sampling timer of its own: createHealthMetrics rotates the window with its 10 s sample.
// GC pauses come from a perf_hooks 'gc' observer. Nothing here logs, allocates per event beyond the first
// sight of a phase name, or changes what any client receives.
import { performance, PerformanceObserver, constants } from 'node:perf_hooks';

/** Upper bucket bounds (ms); the last one is open. p50/p99 report the bound of the quantile's bucket (capped by max). */
export const PHASE_BUCKETS_MS = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, Infinity]);
/** Distinct phase names kept; later names fold into 'other' (names are code constants or validated message types). */
export const MAX_PHASES = 256;

/** The disabled recorder every instrumented module defaults to: one call, no clock read, no allocation. */
export const NO_PHASES = Object.freeze({ enabled: false, start: () => 0, end() {}, add() {} });

const GC_KINDS = new Map([
  [constants.NODE_PERFORMANCE_GC_MINOR, 'gc.minor'], [constants.NODE_PERFORMANCE_GC_MAJOR, 'gc.major'],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'gc.incremental'], [constants.NODE_PERFORMANCE_GC_WEAKCB, 'gc.weakcb'],
]);
const round = (ms) => Math.round(ms * 1000) / 1000;

function bucketOf(ms) {
  let i = 0;
  while (ms > PHASE_BUCKETS_MS[i]) i++;
  return i;
}

function quantile(entry, q) {
  const target = Math.max(1, Math.ceil(entry.count * q));
  let seen = 0;
  for (let i = 0; i < entry.buckets.length; i++) {
    seen += entry.buckets[i];
    if (seen >= target) return round(Math.min(PHASE_BUCKETS_MS[i], entry.maxMs));
  }
  return round(entry.maxMs);
}

/**
 * @param {{ now?: () => number, gc?: boolean, Observer?: typeof PerformanceObserver }} [opts]
 * @returns {{ enabled: true, start: () => number, end: (name: string, t0: number, items?: number) => void,
 *   add: (name: string, ms: number, items?: number) => void, rotate: () => Record<string, object>, dispose: () => void }}
 */
export function createPhaseMetrics({ now = () => performance.now(), gc = true, Observer = PerformanceObserver } = {}) {
  let window = new Map();
  const peaks = new Map();
  let observer = null, disposed = false;

  function add(name, ms, items = 0) {
    if (disposed || !(ms >= 0)) return;
    let entry = window.get(name);
    if (!entry) {
      if (!peaks.has(name) && peaks.size >= MAX_PHASES && name !== 'other') { add('other', ms, items); return; }
      entry = { count: 0, totalMs: 0, maxMs: 0, items: 0, buckets: new Uint32Array(PHASE_BUCKETS_MS.length) };
      window.set(name, entry);
    }
    entry.count++;
    entry.totalMs += ms;
    if (ms > entry.maxMs) entry.maxMs = ms;
    if (Number.isFinite(items) && items > 0) entry.items += items;
    entry.buckets[bucketOf(ms)]++;
    let peak = peaks.get(name);
    if (!peak) { peak = { maxMs: 0, count: 0 }; peaks.set(name, peak); }
    peak.count++;
    if (ms > peak.maxMs) peak.maxMs = ms;
  }

  if (gc) {
    try {
      observer = new Observer((list) => {
        for (const entry of list.getEntries()) add(GC_KINDS.get(entry.detail?.kind ?? entry.kind) ?? 'gc.other', entry.duration);
      });
      observer.observe({ entryTypes: ['gc'] });
    } catch { observer = null; } // diagnostics only
  }

  return {
    enabled: true,
    start: now,
    end(name, t0, items = 0) { add(name, now() - t0, items); },
    add,
    /** Close the current window: its per-phase figures, plus the peak and count since start. Sorted by name. */
    rotate() {
      const out = {};
      for (const name of [...window.keys()].sort()) {
        const e = window.get(name), peak = peaks.get(name);
        out[name] = { count: e.count, totalMs: round(e.totalMs), maxMs: round(e.maxMs), p50Ms: quantile(e, 0.5),
          p99Ms: quantile(e, 0.99), items: e.items, peakMs: round(peak.maxMs), totalCount: peak.count };
      }
      window = new Map();
      return out;
    },
    dispose() {
      disposed = true;
      try { observer?.disconnect(); } catch { /* diagnostics only */ }
      observer = null;
      window = new Map();
    },
  };
}
