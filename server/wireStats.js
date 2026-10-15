// Outbound wire counters. A self-contained metrics module with no imports, read by /healthz (`wire`)
// and by the latency benchmarks. It lives outside server/net.js so the fork's monitoring surface is a
// file of its own rather than twenty lines wedged into the upstream wire layer (FORK_MAINTENANCE.md).

/** Monotonic outbound frame counters since process start (per-socket sends; /healthz `wire`). */
export const wireStats = { frames: 0, bytes: 0, byType: new Map() };

/**
 * @param {string | null} kind frame type (null = unknown, counted in the totals only)
 * @param {number} len data.length (UTF-16 units ≈ wire bytes for the ASCII-heavy frames here)
 */
export function noteWireFrame(kind, len) {
  wireStats.frames++;
  wireStats.bytes += len;
  if (kind == null) return;
  let e = wireStats.byType.get(kind);
  if (!e) { e = { frames: 0, bytes: 0 }; wireStats.byType.set(kind, e); }
  e.frames++;
  e.bytes += len;
}

/** Plain-object snapshot of wireStats for /healthz (diff two polls for rates). */
export function wireStatsSnapshot() {
  const byType = {};
  for (const [k, v] of wireStats.byType) byType[k] = { frames: v.frames, bytes: v.bytes };
  return { frames: wireStats.frames, bytes: wireStats.bytes, byType };
}
