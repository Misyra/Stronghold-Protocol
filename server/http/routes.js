// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * /studio and /studio/… → the plugin studio (server/studio/index.js: for this machine and the local network only — any
//     other client gets the 404 page; its API also takes POST / PUT / DELETE), when the server has one;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, the vanilla content
//     hash `content.vanilla`, the modded content sets in use `content.sets` and — only when there are some — how many
//     unofficial plugins the server has, `content.plugins` (the title screen's count before any hello) — DESIGN §32 —,
//     sockets, sessions,
//     rooms, matches, and the negotiated state-delta counters `stateDelta` (frames, full/delta split, parsed
//     baselines, and the SP_STATE_DELTA_VERIFY replay checks); `versions: { enabled, default, hosts }` only when the server enables another official version than
//     第二期下半 — DESIGN §35.23), never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) and the cached `performance` sample (healthMetrics.js: the main thread's
//     event-loop delay / ELU / memory / CPU over its 10 s window, `performance.phases` when a phase recorder is wired)
//     for a loopback or private-network client only — the maintainer's
//     decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or proxy on this
//     machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits);
//     the performance sample follows the same gate (移植自 Stardust fork 的 healthMetrics,进程诊断细节不进公网 /healthz);
//   * GET /api/online → `{ online: N }`, the title screen's 当前在线人数 (sessions bound to a socket, ~10 s cached);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { PERFORMANCE_UNAVAILABLE } from '../healthMetrics.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { clientAddress, isLocalIp } from '../net.js';
import { stateDeltaStats } from '../stateTransport.js';

const MAX_URL_LENGTH = 4096;

// GET /api/online (the title screen's 当前在线人数, 合并自用户分支): the sessions currently bound to a socket.
// Cached for 10 s per server instance — the value changes on hello / disconnect only, and the page polls it every 10 s,
// so a per-request walk of the session registry would be wasted work. The cache hangs off the registry (a WeakMap
// keyed by it, with the network/health object as fallback), never a module variable: two servers in one process must
// not answer each other's count.
const ONLINE_TTL_MS = 10_000;
const onlineCaches = new WeakMap();

/** @param {{ registry?: any, network?: any }} health */
function onlineCacheOf(health) {
  const scope = health.registry || health.network || health;
  let cache = onlineCaches.get(scope);
  if (!cache) { cache = { at: -Infinity, value: 0 }; onlineCaches.set(scope, cache); }
  return cache;
}

/**
 * The cached online count for /api/online.
 * @param {{ registry?: import('../net.js').SessionRegistry | null, network?: { connectionCount: number } | null }} health
 * @returns {number}
 */
// [ASSUMED] 在线人数 = 当前连接中的会话数（不含断线后重连窗口内保留的会话）；没有专门的快速匹配/在线统计协议，这是最简单的口径
function onlineCount(health) {
  const cache = onlineCacheOf(health);
  const now = Date.now();
  if (now - cache.at >= ONLINE_TTL_MS) {
    cache.at = now;
    const { registry, network } = health;
    cache.value = registry
      ? registry.connectedSize
      : (network ? network.connectionCount : 0);
  }
  return cache.value;
}

/** `{ plugins: n }` when the server has n > 0 unofficial plugins (the lobby's visual sets count them), else nothing. */
function pluginCount(lobby) {
  let n;
  try { n = Number(lobby?.plugins?.unofficial?.()) || 0; } catch { n = 0; }
  let notices = false;
  try { notices = lobby?.plugins?.hasNotices?.() === true; } catch { /* optional catalogue hint */ }
  return { ...(n > 0 ? { plugins: n } : {}), ...(notices ? { notices: true } : {}) };
}

/** The content sets with gameplay plugins rooms hold now (DESIGN §32.6; 0 without any). */
function contentSets(lobby) {
  try { return Number(lobby?.plugins?.contentInUse?.()) || 0; } catch { return 0; }
}

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, content?: { cs: string } | null,
 *           traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null, trusted?: any,
 *           versions?: ReturnType<typeof import('../versions.js').createVersionSets> | null,
 *           versionHosts?: { stats: () => object } | null,
 *           getHealthMetrics?: () => ReturnType<typeof import('../healthMetrics.js').createHealthMetrics> | null }} health
 *   content: the server's vanilla content (server/plugins/identity.js); versions / versionHosts: the official versions
 *   and their match hosts (DESIGN §35.23)
 * @param {boolean} [withTraffic]
 */
export function healthReport({ startedAt, network, registry, lobby, content = null, traffic, assetIndex, views, trusted, versions = null, versionHosts = null, serveStatic = null, persister = null, store = null, getHealthMetrics = null }, withTraffic = false) {
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the release the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload. 移植自用户分支: the
    // static layer's release tag is the authority — its /_v/<tag>/ namespace validates against exactly this.
    build: (serveStatic && serveStatic.version) || buildTag(),
    // what its rooms play (DESIGN §32): the vanilla content hash, and how many content sets with gameplay plugins rooms
    // hold now (P1c, §32.6 — a room's cosmetic plugins leave its cs the vanilla one, §32.3); how many unofficial plugins
    // it has, when it has some (a page's title screen says so; P1a)
    ...(content ? { content: { vanilla: content.cs, sets: contentSets(lobby), ...pluginCount(lobby) } } : {}),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
    // the per-network action budgets (server/roomProtection.js, 合并自用户分支): allowed / denied counts per action
    roomProtection: lobby.roomActions?.stats() || null,
    // state-delta accounting (server/stateTransport.js): how many state frames were sent whole / as a patch, how often
    // a baseline had to be parsed, and (with SP_STATE_DELTA_VERIFY=1) how many replayed deltas disagreed with the
    // state they describe. Poll twice for rates — this is the sampling hook for the state-sync chain.
    stateDelta: { ...stateDeltaStats },
    // 持久化 (server/persist.js, 移植自用户分支): write rounds / failures / held checkpoints and the checkpoint
    // encode bookkeeping — `failures` growing means saving is broken (本仓无独立 /metrics 面, 计数进 /healthz)
    persist: persister ? {
      enabled: true, backend: store?.kind || 'custom', mode: store?.mode || null,
      writes: persister.writes, skipped: persister.skipped, failures: persister.failures,
      checkpoints: persister.matchDocs.size, lastSaveMs: persister.lastSaveMs ?? null,
      checkpointsEncoded: persister.versionStats?.encodes ?? null,
      checkpointsSkipped: persister.versionStats?.skipped ?? null,
      versionChecks: persister.versionStats?.verified ?? null,
      versionHoles: persister.versionStats?.holes ?? null,
      deferredSkips: persister.deferredSkips ?? 0,
      pendingLoad: persister.pendingLoad === true,
      workerMemory: persister.encoder?.memory || null,
    } : null,
  };
  if (trusted && Object.keys(trusted).length) report.plugins = trusted;
  // the official versions (DESIGN §35.23): only when another one than 第二期下半 is enabled
  if (versions && versions.nonDefault.length) {
    report.versions = { enabled: [...versions.ids], default: versions.defaultId,
      hosts: versionHosts ? versionHosts.stats() : { workers: 0, matches: 0, transport: 'process' } };
  }
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // the bot rehearsal counters over the live matches (DESIGN §14, lobby.rehearsalStats): how the delegated rehearsals
  // ended (delegated/answered/takeovers) and how their simulation-pool hand-offs did (pooled/accepted/fallbacks) —
  // the tuning pair for the host answer window. Same loopback / private gate as the traffic family: read-only
  // aggregates, but they stay out of the public /healthz a tunnel probe sees.
  if (withTraffic && lobby?.rehearsalStats) report.rehearsal = lobby.rehearsalStats();
  // the static layer's response caches (files.js CompressCache / TransformCache): bytes held, entries, budget —
  // an operator sees what a hot page load keeps in memory and when a budget starts churning (entries evicted)
  if (withTraffic && serveStatic?.cacheStats) report.staticCache = serveStatic.cacheStats();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  // the cached performance summary (healthMetrics.js, 移植自 Stardust fork): same loopback / private gate as the
  // traffic counters — process diagnostics do not go to the public /healthz
  if (withTraffic) report.performance = getHealthMetrics?.()?.snapshot() ?? PERFORMANCE_UNAVAILABLE;
  return report;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object, trustProxy?: 'auto' | boolean,
 *           csp?: string | null,
 *           studio?: { handles: (rawPath: string) => boolean, handle: (req: any, res: any, rawPath: string, query: string) => Promise<void> } | null }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY); studio: the
 *   plugin studio (server/studio/index.js), or none
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, trustProxy = 'auto', studio = null, csp = null, trustedRuntime = null, readAnnouncement = null, announcementSource = null, gate = null }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    // 门禁 (server/http/gate.js): /entry and the login endpoints first, then the cookie for everything but /healthz.
    // A remote client's HTML navigation is redirected to /entry; its assets, data and the WebSocket upgrade (websocket.js)
    // are refused. Loopback / private-network clients skip the gate (gate.bypass).
    if (gate) {
      const { ip, key } = clientAddress(req, trustProxy);
      if (await gate.handle(req, res, { method: req.method, rawPath: parts.rawPath, query: parts.query, ip, key })) return;
      if (!gate.isPublic(parts.rawPath) && !gate.check(req)) { gate.deny(req, res, { ...parts, method: req.method }); return; }
    }
    if (trustedRuntime && parts.rawPath.startsWith('/x/') && await trustedRuntime.route(req,res,parts.rawPath)) return;
    if (studio && studio.handles(parts.rawPath)) { await studio.handle(req, res, parts.rawPath, parts.query); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    // The title screen's 当前在线人数 (public/js/screens/title.js): { online: N }, never cached by the browser.
    if (parts.rawPath === '/api/online') {
      sendJson(req, res, 200, { online: onlineCount(health) });
      return;
    }
    // The hot-loaded maintenance notice (server/announcement.js, 合并自用户分支): every open page polls this, so
    // the body is the public projection only. A schedule document may also carry a popup
    // (shared/announcements.js): the same read serves both, so the two never disagree about which notices are live.
    if (parts.rawPath === '/api/announcement' && readAnnouncement) {
      const announcement = await readAnnouncement();
      const popupAnnouncement = readAnnouncement.popup?.() ?? null;
      sendJson(req, res, 200, { announcement, popupAnnouncement, serverTime: Date.now(), source: announcementSource });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    if (csp) res.setHeader('Content-Security-Policy', csp);
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
