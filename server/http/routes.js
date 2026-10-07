// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached; this fork adds worker/memory/static-cache/socket-buffer/wire/persist diagnostics;
//   * GET /api/ping → a tiny public latency probe ({ ok: true }, no session, CORS `*`);
//   * GET /api/rooms/<code>/status → the room's read-only public projection (server/roomStatus.js), rate-limited per
//     network and never a room listing; no other /api/rooms route exists;
//   * GET /api/announcement → the hot-loaded maintenance notice and the server time (no write API);
//   * everything else → the static files (static.js).
// A route that throws is logged and answers 500.

import { PROTOCOL_VERSION, APP_VERSION, ROOM_CODE_LEN } from '../../shared/constants.js';
import { CODE_ALPHABET } from '../lobby.js';
import { wireStatsSnapshot } from '../net.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body.
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, workerPool: object | null, persister: object | null, store: object | null,
 *           serveStatic: object, cdn: { base: string, version: string }, assetsManifest: object | null }} health
 */
export function healthReport({ startedAt, network, registry, lobby, workerPool = null, persister = null, store = null, serveStatic = null, cdn = null, assetsManifest = null }) {
  return {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: serveStatic ? serveStatic.version : null,
    ...(serveStatic ? { artVersion: serveStatic.artVersion, staticCache: serveStatic.cacheStats() } : {}),
    assetsCdn: cdn?.base || null,
    assetsCdnVersion: cdn?.version || null,
    assetsManifest: assetsManifest?.tag || null,
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
    workers: workerPool?.stats() || null,
    // rss is process-wide (all Workers); other memory counters describe this main thread, in bytes.
    memory: process.memoryUsage(),
    socketBuffers: network.bufferedBytes?.() || null,
    // outbound frames since process start, per socket send (`byType` only knows the frame's type; poll twice
    // for rates — which types dominate the broadcast/serialization cost)
    wire: wireStatsSnapshot(),
    persist: persister ? { enabled: true, backend: store?.kind || 'custom', mode: store?.mode || null, writes: persister.writes,
      failures: persister.failures, checkpoints: persister.matchDocs.size,
      workerMemory: persister.encoder?.memory || null } : null,
  };
}

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object,
 *           allowStatus?: (req: import('node:http').IncomingMessage) => boolean,
 *           readAnnouncement?: () => Promise<object | null> }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, allowStatus = null, readAnnouncement = null }) {
  const statusPath = new RegExp(`^/api/rooms/([${CODE_ALPHABET}]{${ROOM_CODE_LEN}})/status$`, 'i');
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, healthReport(health));
      return;
    }
    // Public latency probe, deliberately tiny and session-free. No credentials or room information.
    if (parts.rawPath === '/api/ping') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
      sendJson(req, res, 200, { ok: true });
      return;
    }
    // No collection route: even malformed /api/rooms requests consume the lookup budget.
    if (parts.rawPath === '/api/rooms' || parts.rawPath.startsWith('/api/rooms/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      if (allowStatus && !allowStatus(req)) {
        res.setHeader('Retry-After', '1');
        sendJson(req, res, 429, { error: 'RATE_LIMITED' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const code = statusPath.exec(parts.rawPath)?.[1];
      const status = code ? health.lobby.getRoomStatus(code) : null;
      sendJson(req, res, status ? 200 : 404, status || { error: 'ROOM_NOT_FOUND' });
      return;
    }
    if (parts.rawPath === '/api/announcement' && readAnnouncement) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      sendJson(req, res, 200, { announcement: await readAnnouncement(), serverTime: Date.now() });
      return;
    }
    if (req.method === 'OPTIONS' && /^\/(?:assets|fonts|media)\/|^\/_v\/[a-f0-9]{16}\/(?:assets|fonts|media)\//.test(parts.rawPath)) {
      await serveStatic(req, res, parts.rawPath, parts.query);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
