// server/index.js — process entry & boot (DESIGN §1, §2).
//
//   * node:http static server:  /        → public/      (index.html for directories)
//                                /data/   → data/        (generated game data)
//                                /shared/ → shared/      (ESM shared with the browser)
//                                /sim/    → server/sim/  (the battle simulation, read-only, `.js` only — client-side
//                                                         combat, DESIGN §14; the Node-only loader nodeData.js is not served)
//                                /data.js → a generated browser stand-in of server/data.js (the sim's content modules
//                                           import `../../../data.js`; in the browser it serves the data injected with
//                                           /sim/simdata.js setSimData). No other server file is ever served.
//                                /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 — the same audio files, addressed
//                                           **without** an extension so download managers (IDM / 迅雷 …) stop popping a
//                                           "下载文件信息" dialog for every BGM track (shared/media.js, public/js/media.js)
//     MIME types incl. .mjs/.js text/javascript, .skel application/octet-stream, .atlas text/plain;
//     gzip for text-like types, .skel and uncompressed fonts when the client accepts it (small files are
//     compressed once and cached in memory); strong ETag + Last-Modified with 304s; Cache-Control
//     (html & code/data: no-cache + revalidate; public/assets|fonts|vendor: 1 day; any `?v=` URL: immutable);
//     single byte-range requests (206/416, used by <audio>); traversal & dotfile protection; 404 page.
//   * GET /healthz → JSON status (protocol `version`, release `app`, rooms, matches, sessions, sockets).
//   * WebSocket (ws) at /ws, maxPayload 64 KB → server/net.js Network → server/lobby.js Lobby.
//   * Env: PORT (default 3000), HOST (default 0.0.0.0), TRUST_PROXY ('auto' default: honour CF-Connecting-IP /
//     X-Real-IP / X-Forwarded-For only from loopback/private peers such as a local cloudflared; '1' always; '0' never).
//     Prints LAN URLs on boot.
//   * Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
//     (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//   * Graceful shutdown on SIGINT/SIGTERM (rooms get room.closed{reason:'shutdown'}, sockets close 1001).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from './net.js';
import { Lobby } from './lobby.js';
import { getData, loadData } from './data.js';
import { PROTOCOL_VERSION, APP_VERSION } from '../shared/constants.js';
import { ROOT, parseTrustProxy, makeLogger } from './http/config.js';
import { sendError, sendJson, splitUrl } from './http/common.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { WS_MAX_PAYLOAD } from './http/websocket.js';
import { lanUrls } from './http/boot.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
};

const MAX_URL_LENGTH = 4096;

// ---------------------------------------------------------------------------------------------------
// Server assembly
// ---------------------------------------------------------------------------------------------------

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 * }} [opts]
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: WebSocketServer,
 *                     lobby: Lobby, network: Network, registry: SessionRegistry, close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  const log = opts.log || makeLogger(!!opts.quiet);
  const publicDir = opts.publicDir || path.join(ROOT, 'public');
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const sharedDir = opts.sharedDir || path.join(ROOT, 'shared');

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const netOptions = {};
  for (const k of ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
    'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy']) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = {};
  for (const k of ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs']) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions });
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, log });
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag();

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  });

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, {
        ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
        // older than this reloads itself, so a deploy reaches clients that never reload
        build: buildTag(),
        sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
      });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  server.on('clientError', (err, socket) => {
    if (err && err.code === 'ECONNRESET') { socket.destroy(); return; }
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    } catch { /* ignore */ }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  return { port: actualPort, host, url, server, wss, lobby, network, registry, close };
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[process] uncaught exception', e));
  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`端口已被占用 / port in use: ${e.port ?? process.env.PORT ?? 3000}. Try PORT=3001 npm start`);
    else console.error('[boot] failed to start', e);
    process.exit(1);
  }
  console.log(`\n  卫戍协议：盟约 · Stronghold Protocol: Alliance v${APP_VERSION}`);
  console.log(`  Local:   ${srv.url}`);
  if (srv.host === '0.0.0.0' || srv.host === '::') {
    for (const u of lanUrls(srv.port)) console.log(`  LAN:     ${u}`);
  }
  console.log('  Internet: cloudflared tunnel --url ' + `http://localhost:${srv.port}` + '\n');

  let stopping = false;
  const stop = (signal) => {
    if (stopping) { console.log('forced exit'); process.exit(1); }
    stopping = true;
    console.log(`\n[${signal}] shutting down…`);
    setTimeout(() => process.exit(0), 5000).unref();
    srv.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (isMain()) main();
