// SPDX-License-Identifier: GPL-3.0-or-later
// deploy/monitoring/collector/index.mjs — polls ONE fixed game-server /healthz?traffic=1 and serves its
// figures as Prometheus text on GET /metrics (metrics.mjs). 移植自 Stardust fork
// deploy/stardust/monitoring/collector/index.mjs(其改编自 xinhai-ai/Stronghold-Protocol
// deploy/monitoring/exporter/index.mjs,GPL-3.0-or-later)。
//
//   * the target comes only from MONITOR_HEALTHZ_URL: no ?target= or other request parameter can change it (no SSRF);
//     http(s) only, no credentials or fragment in the URL, path /healthz;
//   * each poll: AbortSignal timeout (headers and body), redirects refused, HTTP 200 or 503 with application/json only,
//     body capped at 2 MiB, shape checked; a poll never overlaps the previous one;
//   * nothing from the response, the URL or the client is logged; failures are counted by a fixed reason only;
//   * listens on 127.0.0.1:9108 by default (host networking on the edge; never published).
// No npm dependencies: Node 24 built-ins only.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { renderMetrics } from './metrics.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;

/** A failed poll, by one of metrics.mjs FAILURE_REASONS. */
export class PollError extends Error {
  constructor(reason) { super(`healthz poll failed: ${reason}`); this.reason = reason; }
}

/** The fixed target: an absolute http(s) URL of /healthz without credentials or fragment. */
export function validateHealthzUrl(text) {
  let url;
  try { url = new URL(String(text ?? '')); } catch { throw new Error('MONITOR_HEALTHZ_URL is not a URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || !url.pathname.endsWith('/healthz')) {
    throw new Error('MONITOR_HEALTHZ_URL must be an http(s) URL of /healthz without credentials or fragment');
  }
  return url.href;
}

/** The collector settings from the environment (index.mjs is the container's command). */
export function parseConfig(env = process.env) {
  const url = validateHealthzUrl(env.MONITOR_HEALTHZ_URL);
  const intervalMs = Number(env.MONITOR_INTERVAL_MS ?? 10_000);
  const timeoutMs = Number(env.MONITOR_TIMEOUT_MS ?? 5_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300_000
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs >= intervalMs) {
    throw new Error('invalid MONITOR_INTERVAL_MS / MONITOR_TIMEOUT_MS (timeout must be shorter than the interval)');
  }
  const listen = String(env.MONITOR_LISTEN ?? '127.0.0.1:9108');
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(listen);
  if (!match || Number(match[2]) > 65535) throw new Error('MONITOR_LISTEN must be ADDRESS:PORT');
  return { url, intervalMs, timeoutMs, host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) };
}

/** Is this the JSON of server/http/routes.js healthReport (not an error page, a proxy page or another service)? */
export function looksLikeHealthz(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) && typeof data.ok === 'boolean'
    && typeof data.app === 'string' && Number.isFinite(data.uptimeSec) && Number.isFinite(data.version)
    && Number.isFinite(data.sockets);
}

/**
 * One poll of the fixed URL.
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, fetchFn?: typeof fetch }} [opts]
 */
export async function fetchHealthz(url, { timeoutMs = 5000, maxBytes = MAX_BYTES, fetchFn = fetch } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchFn(url, { signal, redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } });
  } catch (e) {
    if (signal.aborted) throw new PollError('timeout');
    throw new PollError(/redirect/i.test(String(e?.cause?.message ?? e?.message)) ? 'redirect' : 'network');
  }
  const discard = () => response.body?.cancel().catch(() => {});
  if (response.status >= 300 && response.status < 400) { discard(); throw new PollError('redirect'); }
  // 503 is the same report with ok: false (routes.js); anything else is not a health report
  if (response.status !== 200 && response.status !== 503) { discard(); throw new PollError('status'); }
  if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) { discard(); throw new PollError('content_type'); }
  if (Number(response.headers.get('content-length')) > maxBytes) { discard(); throw new PollError('too_large'); }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength;
      if (total > maxBytes) { discard(); throw new PollError('too_large'); }
      chunks.push(Buffer.from(chunk));
    }
  } catch (e) {
    if (e instanceof PollError) throw e;
    throw new PollError(signal.aborted ? 'timeout' : 'network');
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { throw new PollError('invalid'); }
  if (!looksLikeHealthz(data)) throw new PollError('invalid');
  return data;
}

/**
 * The poller: `poll()` runs at most one request at a time (a call while one runs returns that one); `metrics()` renders
 * the last outcome (a failed poll drops the game figures at once).
 * @param {{ url: string, intervalMs?: number, timeoutMs?: number, maxBytes?: number, fetchFn?: typeof fetch,
 *           now?: () => number, clock?: () => number }} opts
 */
export function createCollector({ url, intervalMs = 10_000, timeoutMs = 5_000, maxBytes = MAX_BYTES, fetchFn = fetch,
  now = Date.now, clock = () => performance.now() }) {
  url = validateHealthzUrl(url);
  const state = { up: false, data: null, lastSuccessAt: null, durationSeconds: null, polls: 0, failures: {} };
  let pending = null;
  let timer = null;
  let stopped = false;

  function poll() {
    if (pending) return pending; // the server is slow: no pile-up
    const start = clock();
    pending = (async () => {
      try {
        const data = await fetchHealthz(url, { timeoutMs, maxBytes, fetchFn });
        Object.assign(state, { up: true, data, lastSuccessAt: now() });
      } catch (e) {
        const reason = e instanceof PollError ? e.reason : 'network';
        Object.assign(state, { up: false, data: null });
        state.failures[reason] = (state.failures[reason] || 0) + 1;
      } finally {
        state.polls++;
        state.durationSeconds = Math.max(0, (clock() - start) / 1000);
      }
    })().finally(() => { pending = null; });
    return pending;
  }

  return {
    state, poll,
    /** The exposition text now (a success older than 3 intervals + the timeout counts as down). */
    metrics: () => renderMetrics(state, now(), { staleAfterMs: intervalMs * 3 + timeoutMs }),
    start() {
      if (timer || stopped) return;
      timer = setInterval(poll, intervalMs);
      poll();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      await pending;
    },
  };
}

/**
 * GET / HEAD /metrics (and /healthz for a liveness probe) on `host:port`; any query string is ignored.
 * @param {{ metrics: () => string }} collector
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<import('node:http').Server>}
 */
export async function startServer(collector, { host = '127.0.0.1', port = 9108 } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const path = (req.url || '/').split('?')[0];
    let body, type;
    if (path === '/metrics') { body = collector.metrics(); type = 'text/plain; version=0.0.4; charset=utf-8'; }
    else if (path === '/healthz') { body = '{"ok":true}\n'; type = 'application/json'; }
    else { res.writeHead(404); res.end(); return; }
    const bytes = Buffer.from(body);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 50;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let config;
  try { config = parseConfig(); } catch (e) {
    console.error(`[collector] ${e.message}`); // names the variable, never echoes its value
    process.exit(1);
  }
  const collector = createCollector(config);
  let server;
  try { server = await startServer(collector, config); } catch {
    console.error('[collector] cannot listen on MONITOR_LISTEN');
    process.exit(1);
  }
  collector.start();
  console.log(`[collector] polling every ${config.intervalMs / 1000} s; serving /metrics on ${config.host}:${config.port}`);
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
    collector.stop().then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
