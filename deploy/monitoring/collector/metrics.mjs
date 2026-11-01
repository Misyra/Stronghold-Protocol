// SPDX-License-Identifier: GPL-3.0-or-later
// deploy/monitoring/collector/metrics.mjs — the game server's GET /healthz?traffic=1 JSON
// (server/http/routes.js healthReport) as Prometheus text. Adapted from the Stardust fork
// deploy/stardust/monitoring/collector/metrics.mjs (GPL-3.0-or-later): this server has no /metrics, so the field
// table follows B 的 healthReport and the modules it reads instead.
//
// Rules:
//   * one fixed table: every exported name, type, help text and finite label set is below; nothing from the JSON
//     becomes a metric or label name, and the only label values copied from it are `app` / `build` (sp_info), after an
//     allowlist check;
//   * a missing, null or non-finite field is absent, never 0; a counter must also be >= 0;
//   * counters are the since-start counts of the process (persist, traffic) and end in `_total`; a server restart
//     resets them, which rate() handles;
//   * `performance.*` is the cached 10 s window of server/healthMetrics.js (移植自 Stardust fork): gauges, in
//     seconds / bytes / ratios; it is only answered to a loopback / private-network client (?traffic=1);
//     `performance.phases` (per-phase timings) is not exported;
//   * a failed or stale poll presents only the collector's own series (sp_up 0): no game value outlives its poll.
//
// fork 集群专用的字段在本仓的 healthz 里没有limits / reconnect(hello) / net.backpressure / stateDelta /
// persistence(协调器存档) / online / queued,故 fork 表里的对应指标(sp_hello_total、sp_limit、sp_state_*、
// sp_store_*、sp_online、sp_queued …)不再导出;本仓自己的持久化面是 healthz 的 `persist` 块(server/persist.js)。

const G = 'gauge';
const C = 'counter';

/** [name, type, help, JSON path, scale] — one unlabelled sample each. */
const SCALARS = [
  ['sp_uptime_seconds', G, 'Seconds since the server process started.', 'uptimeSec'],
  ['sp_protocol_version', G, 'WebSocket protocol version the server speaks.', 'version'],
  ['sp_sockets', G, 'Open WebSocket connections on the server.', 'sockets'],
  ['sp_sessions', G, 'Sessions held, including disconnected ones inside their reconnect window.', 'sessions'],
  ['sp_rooms', G, 'Rooms open now.', 'rooms'],
  ['sp_matches', G, 'Rooms with a running match.', 'matches'],
  ['sp_humans', G, 'Human seats in rooms (players who have not left), connected or not.', 'humans'],
  ['sp_bots', G, 'AI seats in rooms.', 'bots'],
  ['sp_spectators', G, 'Spectators in rooms.', 'spectators'],
  ['sp_content_sets', G, 'Content sets with gameplay plugins that rooms hold now.', 'content.sets'],
  ['sp_content_plugins', G, 'Unofficial plugins the server has (absent when none).', 'content.plugins'],
  ['sp_performance_window_seconds', G, 'Length of the cached performance window.', 'performance.windowMs', 1e-3],
  ['sp_performance_sampled_timestamp_seconds', G, 'Unix time the cached performance window ended.', 'performance.sampledAt', 1e-3],
  ['sp_event_loop_utilization', G, 'Main-thread event-loop utilization over the last window (0..1).',
    'performance.mainThread.eventLoopUtilization'],
  ['sp_heap_used_bytes', G, 'Main-thread V8 heap used.', 'performance.mainThread.memory.heapUsedBytes'],
  ['sp_heap_total_bytes', G, 'Main-thread V8 heap reserved.', 'performance.mainThread.memory.heapTotalBytes'],
  ['sp_external_memory_bytes', G, 'Main-thread memory held outside the V8 heap.', 'performance.mainThread.memory.externalBytes'],
  ['sp_array_buffers_bytes', G, 'Main-thread ArrayBuffer memory.', 'performance.mainThread.memory.arrayBuffersBytes'],
  ['sp_process_cpu_ratio', G, 'Server process CPU over the last window (1 = one full core; may exceed 1).',
    'performance.process.cpu.percent', 1e-2],
  ['sp_process_resident_memory_bytes', G, 'Server process resident memory (RSS).', 'performance.process.rssBytes'],
  ['sp_persist_writes_total', C, 'State documents written to the store (server/persist.js).', 'persist.writes'],
  ['sp_persist_skipped_total', C, 'Save rounds skipped (nothing changed).', 'persist.skipped'],
  ['sp_persist_failures_total', C, 'Failed state writes — growing means saving is broken.', 'persist.failures'],
  ['sp_persist_checkpoints', G, 'Match checkpoints held now.', 'persist.checkpoints'],
  ['sp_persist_checkpoint_encodes_total', C, 'Checkpoint encodes shipped to the encoder.', 'persist.checkpointsEncoded'],
  ['sp_persist_checkpoint_skips_total', C, 'Checkpoint captures skipped (no safe point).', 'persist.checkpointsSkipped'],
  ['sp_persist_version_checks_total', C, 'Checkpoint version proofs verified.', 'persist.versionChecks'],
  ['sp_persist_version_holes_total', C, 'Checkpoint version holes found (SP_PERSIST_VERIFY).', 'persist.versionHoles'],
  ['sp_persist_deferred_skips_total', C, 'Save rounds skipped while the startup state has not been read back.', 'persist.deferredSkips'],
  ['sp_persist_last_save_seconds', G, 'Duration of the last completed state write.', 'persist.lastSaveMs', 1e-3],
  ['sp_ws_connections_total', C, 'WebSocket connections opened (traffic counter).', 'traffic.ws.connections'],
  ['sp_ws_open', G, 'WebSocket connections open now (traffic counter).', 'traffic.ws.open'],
];

/** [name, type, help, label, { label value: JSON path }, scale] — fixed label values only. */
const FAMILIES = [
  ['sp_event_loop_delay_seconds', G, 'Main-thread event-loop delay over the last window (20 ms timer resolution).', 'stat', {
    p50: 'performance.mainThread.eventLoopDelayMs.p50', p95: 'performance.mainThread.eventLoopDelayMs.p95',
    p99: 'performance.mainThread.eventLoopDelayMs.p99', max: 'performance.mainThread.eventLoopDelayMs.max' }, 1e-3],
  ['sp_http_responses_total', C, 'HTTP responses the server sent, by traffic class.', 'class', trafficPaths('requests')],
  ['sp_http_response_bytes_total', C, 'HTTP body bytes the server sent (after compression), by traffic class.', 'class',
    trafficPaths('bytes')],
  ['sp_http_not_modified_total', C, 'HTTP 304 responses the server sent, by traffic class.', 'class', trafficPaths('notModified')],
  ['sp_ws_wire_bytes_total', C, 'WebSocket bytes on the wire (after permessage-deflate).', 'direction', {
    out: 'traffic.ws.wireOut', in: 'traffic.ws.wireIn' }],
  ['sp_ws_payload_bytes_total', C, 'WebSocket message payload bytes (before compression).', 'direction', {
    out: 'traffic.ws.payloadOut', in: 'traffic.ws.payloadIn' }],
  ['sp_ws_messages_total', C, 'WebSocket messages.', 'direction', { out: 'traffic.ws.messagesOut', in: 'traffic.ws.messagesIn' }],
];

/** [name, help, JSON path, expected type, value meaning 1] — 1 / 0 when the field has the expected type, absent otherwise. */
const FLAGS = [
  ['sp_ok', 'The server reports itself healthy (/healthz ok).', 'ok', 'boolean', true],
  ['sp_performance_ready', 'The performance window is a measurement (status ready).', 'performance.status', 'string', 'ready'],
  ['sp_persist_enabled', 'Server persistence (checkpoints) is on (SP_STATE_FILE / SP_REDIS_URL).', 'persist.enabled', 'boolean', true],
];

/** The HTTP traffic classes of shared/assetPaths.js TRAFFIC_CATEGORIES (`total` is derivable and left out). */
function trafficPaths(field) {
  return Object.fromEntries(['assets', 'audio', 'code', 'data', 'other'].map((c) => [c, `traffic.http.${c}.${field}`]));
}

const META = {
  sp_up: [G, 'The last poll of the server /healthz succeeded and is recent (1) or not (0).'],
  sp_scrape_duration_seconds: [G, 'Duration of the last /healthz poll.'],
  sp_last_success_timestamp_seconds: [G, 'Unix time of the last successful /healthz poll.'],
  sp_polls_total: [C, 'Polls of the server /healthz.'],
  sp_poll_failures_total: [C, 'Failed polls of the server /healthz, by reason.'],
  sp_info: [G, 'Release (app) and served client build of the server.'],
};
/** Fixed poll failure reasons (index.mjs PollError). */
export const FAILURE_REASONS = Object.freeze(['timeout', 'network', 'redirect', 'status', 'content_type', 'too_large', 'invalid']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const pathValue = (obj, path) => path.split('.').reduce((v, key) => (v && typeof v === 'object' ? v[key] : undefined), obj);

/** Label value escaping of the text exposition format. */
export function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
const escapeHelp = (text) => String(text).replaceAll('\\', '\\\\').replaceAll('\n', '\\n');

/** `app` / `build` label values: short version or hash strings only, else "unknown" (no free text becomes a label). */
export function safeLabelValue(value, pattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/) {
  return typeof value === 'string' && pattern.test(value) ? value : 'unknown';
}

/** Every metric name the collector can export (for the dashboard / rules checks). */
export function exportedMetricNames() {
  return [...Object.keys(META), ...SCALARS.map((s) => s[0]), ...FAMILIES.map((f) => f[0]), ...FLAGS.map((f) => f[0])];
}

/**
 * Render the exposition text.
 * @param {{ up: boolean, data?: any, lastSuccessAt?: number | null, durationSeconds?: number | null,
 *           polls?: number, failures?: Record<string, number> }} state  the collector's last poll (index.mjs)
 * @param {number} nowMs
 * @param {{ staleAfterMs?: number }} [opts]  a success older than this no longer counts (no stale game values)
 */
export function renderMetrics(state, nowMs = Date.now(), { staleAfterMs = 35_000 } = {}) {
  /** @type {Map<string, { type: string, help: string, samples: string[] }>} */
  const families = new Map();
  const emit = (name, type, help, value, labels = {}) => {
    if (!finite(value) || (type === C && value < 0)) return;
    let family = families.get(name);
    if (!family) families.set(name, family = { type, help, samples: [] });
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
    family.samples.push(`${name}${pairs ? `{${pairs}}` : ''} ${value}`);
  };
  const meta = (name, value, labels) => emit(name, META[name][0], META[name][1], value, labels);

  const fresh = !!state?.up && !!state.data && finite(state.lastSuccessAt) && nowMs - state.lastSuccessAt <= staleAfterMs;
  meta('sp_up', fresh ? 1 : 0);
  meta('sp_scrape_duration_seconds', state?.durationSeconds);
  meta('sp_last_success_timestamp_seconds', finite(state?.lastSuccessAt) ? state.lastSuccessAt / 1000 : undefined);
  meta('sp_polls_total', state?.polls ?? 0);
  for (const reason of FAILURE_REASONS) meta('sp_poll_failures_total', state?.failures?.[reason] ?? 0, { reason });

  if (fresh) {
    const m = state.data;
    meta('sp_info', 1, { app: safeLabelValue(m.app), build: safeLabelValue(m.build) });
    for (const [name, help, path, type, one] of FLAGS) {
      const v = pathValue(m, path);
      if (typeof v === type) emit(name, G, help, v === one ? 1 : 0);
    }
    for (const [name, type, help, path, scale = 1] of SCALARS) {
      const v = pathValue(m, path);
      if (finite(v)) emit(name, type, help, v * scale);
    }
    for (const [name, type, help, label, paths, scale = 1] of FAMILIES) {
      for (const [value, path] of Object.entries(paths)) {
        const v = pathValue(m, path);
        if (finite(v)) emit(name, type, help, v * scale, { [label]: value });
      }
    }
  }

  const lines = [];
  for (const [name, { type, help, samples }] of families) lines.push(`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`, ...samples);
  return lines.join('\n') + '\n';
}
