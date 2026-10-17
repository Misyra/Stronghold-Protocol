// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * /studio and /studio/… → the plugin studio (server/studio/index.js: for this machine and the local network only — any
//     other client gets the 404 page; its API also takes POST / PUT / DELETE), when the server has one;
//   * POST /api/nickname/validate → server-only nickname preflight, bounded and rate-limited;
//   * other routes reject methods but GET / HEAD with 405;
//   * GET /healthz → the PUBLIC status (protocol `version`, release `app`, uptime, the served `build`, the asset
//     identity fields, sockets/sessions/rooms/matches/humans/bots/spectators and this fork's public counters
//     roomProtection/botPopulation/foreignSessions), HTTP no-store with a one-second internal snapshot. This fork's
//     process diagnostics are NOT part of it — they describe this host, not the players, and live on /metrics below.
//     `content.vanilla`, `content.sets` and, when there are some, `content.plugins` (the unofficial plugin count the
//     title screen reads before any hello, DESIGN 32) ride along with the upstream 0.3.0 content block;
//     `?build=1` answers the release tag alone; `?traffic=1` adds the traffic counters (traffic.js: bytes by category
//     since the start, WebSocket wire and payload bytes) for a loopback or private-network client only — the
//     maintainer's decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or
//     proxy on this machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the
//     WebSocket limits);
//   * GET /metrics → the one endpoint carrying those diagnostics: workers, memory, static cache, socket buffers,
//     outbound wire counters, state-delta and persistence accounting, chat log, rehearsal pressure and the
//     per-instance process windows, plus bounded WebSocket latency diagnostics. Always collected fresh, and NOT
//     public: only a loopback or private-network client gets it — every other caller falls through to the static
//     files and sees the same 404 as an unknown path, so the route does not even advertise itself. The host's monitor
//     reads it over 127.0.0.1 (sp-portal collector.mjs; MON_METRICS_URL, default derived as
//     http://127.0.0.1:<game port>/metrics);
//   * GET /api/ping → a tiny public latency probe ({ ok: true }, no session, CORS `*`);
//   * GET /api/rooms/<code>/status → the room's read-only public projection (server/roomStatus.js), rate-limited per
//     network; private enumeration and room controls live on the separate loopback listener (server/roomAdmin.js);
//   * GET /api/announcement → the hot-loaded maintenance notice, the server time and the announcement revision
//     this process actually observed (announcement.js `delivery()`; the Agent reports it to the central, no write API);
//   * GET /api/portal-room (feature probe) / POST /api/portal-room (submit this room) / GET /api/portal-room/status
//     (the result of that submission) → the opt-in room share (http/portalRoom.js). The mode (off / legacy-http /
//     agent), the destination and the credentials all come from the startup configuration, never from the request;
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

// Health snapshot reuse adapted from xinhai 23d0a929; retain this fork's detailed fields.
import { validateNickname } from './nickname.js';
import { createPublicApiLimiter, isPublicApiPath, publicApiCountryStatus } from './publicApiLimit.js';
import { createIpBanStore } from './ipBans.js';
import { markHttpRejection } from './rejection.js';
import { createPortalRoomHandler, PORTAL_ROOM_STATUS_PATH } from './portalRoom.js';
import { performance } from 'node:perf_hooks';
import { PROTOCOL_VERSION, APP_VERSION, ROOM_CODE_LEN, ERR, ERR_TEXT } from '../../shared/constants.js';
import { CODE_ALPHABET } from '../lobby.js';
import { clientAddress, isLocalIp, wireStatsSnapshot } from '../net.js';
import { stateDeltaStats } from '../stateTransport.js';
import { setSecurityHeaders, sendError, sendJson, sendJsonBody, splitUrl } from './common.js';

const MAX_URL_LENGTH = 4096;

/** `{ plugins: n }` when the server has n > 0 unofficial plugins (the lobby's visual sets count them), else nothing. */
function pluginCount(lobby) {
  let n;
  try { n = Number(lobby?.plugins?.unofficial?.()) || 0; } catch { n = 0; }
  return n > 0 ? { plugins: n } : {};
}

/** The content sets with gameplay plugins rooms hold now (DESIGN §32.6; 0 without any). */
function contentSets(lobby) {
  try { return Number(lobby?.plugins?.contentInUse?.()) || 0; } catch { return 0; }
}

/**
 * The public GET /healthz body: protocol and asset identity plus the counters a player, the middle station or a
 * third-party site may see. Deliberately free of process diagnostics — healthReport below adds those, and only
 * /metrics (loopback/private-network) ever serves them.
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, serveStatic?: object, cdn?: { base: string, version: string },
 *           assetsManifest?: object | null, content?: { cs: string } | null }} health
 *   content: the server content the report carries (server/plugins/identity.js), or none
 */
export function publicHealthReport({ startedAt, network, registry, lobby, serveStatic = null, cdn = null, assetsManifest = null, content = null }) {
  return {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the release the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: serveStatic ? serveStatic.version : null,
    ...(serveStatic ? { runtimeVersion: serveStatic.runtimeVersion, artVersion: serveStatic.artVersion } : {}),
    assetsCdn: cdn?.base || null,
    assetsCdnVersion: cdn?.version || null,
    assetsManifest: assetsManifest?.tag || null,
    // what its rooms play (DESIGN §32): the vanilla content hash, and how many content sets with gameplay plugins rooms
    // hold now (P1c, §32.6 — a room's cosmetic plugins leave its cs the vanilla one, §32.3); how many unofficial plugins
    // it has, when it has some (a page's title screen says so; P1a)
    ...(content ? { content: { vanilla: content.cs, sets: contentSets(lobby), ...pluginCount(lobby) } } : {}),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
    // The fork own limits (server/roomProtection.js, server/botPopulation.js). A handler built without them (a test
    // fixture, a tool) reports null instead of failing the whole public body with a 500.
    roomProtection: lobby.roomActions?.stats() || null,
    botPopulation: lobby.botPopulation?.stats() || null,
    foreignSessions: network.foreignSessions?.stats() || null,
  };
}

/**
 * The GET /metrics body: the public snapshot plus every process diagnostic this fork adds. Served to a loopback
 * or private-network client only (`withTraffic`: plus the traffic counters, the loopback-only `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, workerPool: object | null, persister: object | null, store: object | null,
 *           serveStatic: object, cdn: { base: string, version: string }, assetsManifest: object | null, content?: { cs: string } | null, trusted?: object | null,
 *           traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           chatLog?: import('../chatLog.js').ChatLog }} health
 * @param {boolean} [withTraffic] plus the traffic counters (the loopback/private-network-only `?traffic=1`)
 */
export function healthReport({ startedAt, network, registry, lobby, content = null, trusted = null, workerPool = null, persister = null, store = null, serveStatic = null, cdn = null, assetsManifest = null, traffic = null, chatLog = null }, withTraffic = false) {
  const report = {
    ...publicHealthReport({ startedAt, network, registry, lobby, serveStatic, cdn, assetsManifest, content }),
    ...(serveStatic ? { staticCache: serveStatic.cacheStats() } : {}),
    rehearsalPressure: network.diagnostics?.rehearsalPressure?.stats() || null,
    workers: workerPool?.stats() || null,
    // rss is process-wide (all Workers); other memory counters describe this main thread, in bytes.
    memory: process.memoryUsage(),
    socketBuffers: network.bufferedBytes?.() || null,
    processDiagnostics: network.diagnostics?.intervals?.snapshot() || null,
    chatLog: chatLog?.stats() || null,
    // outbound frames since process start, per socket send (`byType` only knows the frame's type; poll twice
    // for rates — which types dominate the broadcast/serialization cost)
    wire: wireStatsSnapshot(),
    // state-delta accounting (server/stateTransport.js): how many state frames were sent whole / as a patch, how often
    // a baseline had to be parsed, and (with SP_STATE_DELTA_VERIFY=1) how many replayed deltas disagreed with the
    // state they describe. Poll twice for rates — this is the sampling hook for the state-sync chain.
    stateDelta: { ...stateDeltaStats },
    persist: persister ? { enabled: true, backend: store?.kind || 'custom', mode: store?.mode || null, writes: persister.writes,
      failures: persister.failures, checkpoints: persister.matchDocs.size,
      lastSaveMs: persister.lastSaveMs ?? null,
      // checkpoint encode bookkeeping (snapshot.js persistVersion): encodes committed, checkpoints skipped because the
      // match did not change, verification comparisons, and versions that missed a change (must stay 0).
      checkpointsEncoded: persister.versionStats?.encodes ?? null,
      checkpointsSkipped: persister.versionStats?.skipped ?? null,
      versionChecks: persister.versionStats?.verified ?? null,
      versionHoles: persister.versionStats?.holes ?? null,
      workerMemory: persister.encoder?.memory || null } : null,
  };
  // The traffic counters are the host's own figures (upstream 0.2.6): the caller gates them on isLocalIp, and they
  // never come from the one-second snapshot createHealthBody caches.
  if (trusted && Object.keys(trusted).length) report.plugins = trusted;
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  return report;
}

/** Cache expensive collection and encoded JSON for at most one second per server.
 * Cheap connection/session/uptime fields stay current. Topology changes invalidate immediately.
 * Refresh errors propagate; HTTP remains no-store. The cached body is publicHealthReport — the process
 * diagnostics /metrics serves are never cached there, and /metrics always collects fresh.
 */
export function createHealthBody(health, { now = () => performance.now(), maxAgeMs = 1000 } = {}) {
  let snapshot = null, body = null, expiresAt = -Infinity;
  let rooms = -1, queued = -1, sockets = -1, sessions = -1, uptimeSec = -1;
  return () => {
    // A handler built without the lobby topology (a test fixture, a tool) has nothing to invalidate on: the room
    // and queue counts stay 0 and only the one-second maxAge applies.
    const at = now(), currentRooms = health.lobby.rooms?.size ?? 0;
    const currentQueued = health.lobby.matchmaking?.entries.size ?? 0;
    const refresh = !snapshot || at >= expiresAt || currentRooms !== rooms || currentQueued !== queued;
    const currentSockets = health.network.connectionCount, currentSessions = health.registry.size;
    const currentUptime = Math.round((Date.now() - health.startedAt) / 1000);
    if (!body || refresh || currentSockets !== sockets || currentSessions !== sessions || currentUptime !== uptimeSec) {
      // The cached body is the PUBLIC report: the diagnostics /metrics serves are always collected fresh.
      const next = refresh ? publicHealthReport(health) : snapshot;
      const encoded = Buffer.from(JSON.stringify({ ...next, sockets: currentSockets, sessions: currentSessions, uptimeSec: currentUptime }));
      // Commit only after collection and encoding both succeed: failed refreshes must retry.
      if (refresh) {
        snapshot = next; expiresAt = at + maxAgeMs;
        rooms = currentRooms; queued = currentQueued;
      }
      body = encoded; sockets = currentSockets; sessions = currentSessions; uptimeSec = currentUptime;
    }
    return body;
  };
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object,
 *           allowNickname?: (req: import('node:http').IncomingMessage) => boolean,
 *           allowStatus?: (req: import('node:http').IncomingMessage) => boolean,
 *           readAnnouncement?: () => Promise<object | null>, announcementSource?: { mode: string, siteId: string | null },
 *           portalRoom?: object, trustProxy?: 'auto' | boolean,
 *           publicApiLimits?: object, ipBans?: ReturnType<typeof createIpBanStore>, apiMainlandOnly?: boolean,
 *           apiCountryLookup?: ((ip: string) => string | null) | null, csp?: string | null,
 *           studio?: { handles: (rawPath: string) => boolean, handle: (req: any, res: any, rawPath: string, query: string) => Promise<void> } | null }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY) — the gate
 *   on the `?traffic=1` figures
 *   portalRoom: the share mode and its local credentials (http/config.js portalRoomOptionsFrom); absent → off
 *   csp: the Content-Security-Policy header every response gets (http/config.js), or none; studio: the plugin studio
 *   (server/studio/index.js), or none
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, allowNickname = null, allowStatus = null, readAnnouncement = null, announcementSource = null, portalRoom = null, trustProxy = 'auto', studio = null, csp = null, trustedRuntime = null, publicApiLimits = {}, ipBans = createIpBanStore({ log }), apiMainlandOnly = false, apiCountryLookup = null }) {
  const healthBody = createHealthBody(health);
  const allowPublicApi = createPublicApiLimiter({ ...publicApiLimits, trustProxy, banStore: ipBans });
  const portalRoomHandler = createPortalRoomHandler({ ...(portalRoom ?? {}),
    registry: health.registry, lobby: health.lobby, log,
    trustProxy: health.network?.opts?.trustProxy ?? 'auto' });
  const methodAllowed = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    res.setHeader('Allow', 'GET, HEAD');
    sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
    return false;
  };
  const serveHealth = (req, res) => {
    if (!methodAllowed(req, res)) return;
    const query = splitUrl(req.url)?.query;
    // The host's own bandwidth figures: a loopback/private client only (net.js clientAddress, honouring TRUST_PROXY
    // like the WebSocket limits), straight from the counters — never from the one-second snapshot below.
    if (wantsTraffic(query) && isLocalIp(clientAddress(req, trustProxy).ip)) {
      sendJson(req, res, 200, healthReport(health, true));
      return;
    }
    // Players only need the release tag; the process diagnostics live on /metrics, for this host alone.
    if (new URLSearchParams(query).get('build') === '1') {
      sendJson(req, res, 200, { build: health.serveStatic ? health.serveStatic.version : null });
    } else sendJsonBody(req, res, 200, healthBody());
  };
  // Whose client address the diagnostics may be served to: this host and the private networks it sits in, or an
  // in-process caller with no socket at all ('?', net.js clientAddress). Everything else is the public internet.
  const hostCaller = (req) => { const { ip } = clientAddress(req, trustProxy); return ip === '?' || isLocalIp(ip); };
  const failed = (req, res, e) => {
    log.error('[http] request failed', e);
    sendError(req, res, 500, '服务器内部错误 · Internal error');
  };
  const statusPath = new RegExp(`^/api/rooms/([${CODE_ALPHABET}]{${ROOM_CODE_LEN}})/status$`, 'i');
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    // nginx auth_request: a ban-only check, so subrequests never consume API request counts.
    // nginx exposes this location as internal; direct internet callers get the normal 404.
    if (parts.rawPath === '/_sp/ip-check' && isLocalIp(clientAddress(req, false).ip)) {
      res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (parts.rawPath === '/api/portal-room' || parts.rawPath === PORTAL_ROOM_STATUS_PATH) { await portalRoomHandler(req, res); return; }
    if (parts.rawPath === '/api/nickname/validate') {
      await validateNickname(req, res, allowNickname);
      return;
    }
    if (parts.rawPath === '/healthz') {
      serveHealth(req, res);
      return;
    }
    // The process diagnostics: this host's own numbers, so a loopback or private-network client only. Everyone
    // else falls through to the static handler and gets the same 404 an unknown path gets — the route never
    // confirms it exists (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits, so a tunnel or
    // proxy on this machine still counts as the remote client it forwards).
    if (parts.rawPath === '/metrics' && hostCaller(req)) {
      if (methodAllowed(req, res)) sendJson(req, res, 200, { ...healthReport(health),
        websocket: { diagnostics: health.network.diagnostics.stats() } });
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
    // Even malformed public /api/rooms requests consume the lookup budget.
    if (parts.rawPath === '/api/rooms' || parts.rawPath.startsWith('/api/rooms/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      if (allowStatus && !allowStatus(req)) {
        markHttpRejection(req, res, 'RATE_LIMITED');
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
      // 公告的三层状态里，「游戏读到了哪一版」只有这里能回答（§46.3）：Agent 把它随 sync.report 报给中央，
      // 中央据此区分「文件写好了但游戏还没读到」与「根本没写进去」。它只是版本号与时间，玩家看到的公告
      // 内容与展示策略（announcement.id）一个字都没变。顺序重要：先真的读一次，再取「读到的是哪一版」。
      const announcement = await readAnnouncement();
      const delivery = readAnnouncement.delivery?.() ?? { revision: null, observedAt: null };
      sendJson(req, res, 200, { announcement, serverTime: Date.now(), source: announcementSource,
        observedRevision: delivery.revision, observedAt: delivery.observedAt });
      return;
    }
    if (req.method === 'OPTIONS' && /^\/(?:assets|fonts|media)\/|^\/_v\/[a-f0-9]{16}\/(?:assets|fonts|media)\//.test(parts.rawPath)) {
      await serveStatic(req, res, parts.rawPath, parts.query);
      return;
    }
    if (trustedRuntime && parts.rawPath.startsWith('/x/') && await trustedRuntime.route(req,res,parts.rawPath)) return;
    if (studio && studio.handles(parts.rawPath)) { await studio.handle(req, res, parts.rawPath, parts.query); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    // Refuse the game document itself: overseas visitors see only the message, not the game UI.
    let entryPath = parts.rawPath;
    try { entryPath = decodeURIComponent(entryPath); } catch { /* static handler validates malformed paths */ }
    if (entryPath.endsWith('/') || /\.html$/i.test(entryPath)) {
      const address = clientAddress(req, trustProxy);
      // 明确名单先于国家门禁：名单命中时不去查库，也不因 SP_ALLOW_FOREIGN_CONNECTIONS=on 而放行。
      const netBlocked = health.network?.networkBlocked?.(address);
      if (netBlocked?.blocked) {
        // 响应体与既有的海外门禁完全一致（客户端不需要认识第四种拒绝）；原因只进审计日志。
        sendJson(req, res, 403, { code: ERR.FOREIGN_CONNECTIONS_DISABLED, msg: ERR_TEXT.FOREIGN_CONNECTIONS_DISABLED });
        return;
      }
      if (health.network?.foreignConnectionDenied?.(address)) {
        sendJson(req, res, 403, { code: ERR.FOREIGN_CONNECTIONS_DISABLED, msg: ERR_TEXT.FOREIGN_CONNECTIONS_DISABLED });
        return;
      }
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    // Every response's body bytes count in the traffic counters, the synchronous /healthz fast path included.
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    const url = req.url || '/';
    const rawPath = splitUrl(url)?.rawPath;
    let apiPath = rawPath;
    try { apiPath = decodeURIComponent(apiPath).replace(/\/{2,}/g, '/'); } catch { /* routing rejects malformed URLs */ }
    // Before both the synchronous health fast path and async dispatch: no query/method bypass,
    // no status collection, announcement read, request-body parsing or portal I/O after rejection.
    try {
      const api = apiPath && isPublicApiPath(apiPath);
      const alreadyBanned = ipBans.isBanned(req, trustProxy);
      const countryStatus = api && !alreadyBanned ? publicApiCountryStatus(req, {
        enabled: apiMainlandOnly, countryLookup: apiCountryLookup, trustProxy,
      }) : 0;
      if (alreadyBanned || (api && !allowPublicApi(req, apiPath, !countryStatus))) {
        const banned = ipBans.isBanned(req, trustProxy);
        const status = banned ? 403 : countryStatus || 429;
        if (status !== 403) res.setHeader('Retry-After', '1');
        res.setHeader('Connection', 'close');
        if (rawPath === '/api/ping') res.setHeader('Access-Control-Allow-Origin', '*');
        if (banned || countryStatus !== 503) markHttpRejection(req, res,
          banned ? 'IP_BANNED' : countryStatus === 403 ? 'FOREIGN_IP_BLOCKED' : 'RATE_LIMITED');
        sendJson(req, res, status, { error: banned ? 'IP_BANNED' : countryStatus === 403 ? 'FOREIGN_IP_BLOCKED' :
          countryStatus === 503 ? 'GEOIP_UNAVAILABLE' : 'RATE_LIMITED' });
        return;
      }
    } catch (error) { failed(req, res, error); return; }
    // Rejections are tiny JSON, not documents: do not amplify them with the full page CSP.
    if (csp) res.setHeader('Content-Security-Policy', csp);
    if (url.length <= MAX_URL_LENGTH && (url === '/healthz' || url.startsWith('/healthz?') || url.startsWith('/healthz#'))) {
      try { serveHealth(req, res); } catch (e) { failed(req, res, e); }
      return;
    }
    handleRequest(req, res).catch((e) => failed(req, res, e));
  };
}
