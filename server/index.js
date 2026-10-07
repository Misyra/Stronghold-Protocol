// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST 0.0.0.0, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB;
//                      refused at upgrade with 404 / 429 per network / 503; SP_WS_COMPRESSION, this fork's bounded
//                      permessage-deflate, 'on' default)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser
//                      stand-in, the content packs (/packs/index.json, /packs/<id>/<file> — the registry is packs.js);
//                      this fork's release/CDN asset layer (/_v/<tag>/ URLs, the per-file art manifest of
//                      tools/r2-sync.mjs, /data/resource-manifest.json for the offline preload, URL rewriting + CORS)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400 / 405, GET /healthz → JSON status (this fork:
//                      worker / memory / static-cache / socket-buffer / wire / persist diagnostics),
//                      GET /api/ping, GET /api/rooms/<code>/status (rate-limited, roomStatus.js), GET /api/announcement,
//                      else static
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       a pending update package first (update.js: old files deleted, the install verified against
//                      MANIFEST.json), banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT /
//                      SIGTERM
//
// This fork's extra wiring in startServer():
//   * SimulationPool (server/workers/pool.js): bot rehearsal, normal / 联防 headless runs and SP_VERIFY=all
//     verifications run in worker threads (SP_WORKERS etc.; 0 disables). The pool is created here and closed on close().
//   * Persister / FileStateStore (server/persist.js, server/stateFile.js): SP_STATE_FILE (default .state/server-<PORT>:
//     `.state/server-<PORT>/` sharded directory layout, `off` disables) keeps sessions, rooms and running matches across
//     restarts; restored before listening, final write on graceful shutdown. It must not sit in a public directory.
//   * Announcement reader (server/announcement.js): SP_ANNOUNCEMENT_FILE (default ROOT/announcement.json) or the
//     central source SP_ANNOUNCEMENT_URL (SP_ANNOUNCEMENT_POLL_MS) → GET /api/announcement.
//   * Assets CDN (SP_ASSETS_CDN + .assets-manifest.json / .assets-cdn-version / CDN /_v/latest): static.js rewrites
//     art URLs to the CDN; /healthz reports the resolved release.
//   * Lobby: 同盟匹配 (matchmaking.js), the room status projection (roomStatus.js) and the persistence checkpoints
//     (lobby.onCheckpoint) live in server/lobby.js.
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import path from 'node:path';
import { getData, loadData } from './data.js';
import { ROOT, listenAddress, serveDirs, makeLogger, parseTrustProxy } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { answerClientError } from './http/common.js';
import { lanUrls, isProcessEntry, runMain } from './http/boot.js';
import { Persister, restoreServer } from './persist.js';
import { FileStateStore } from './stateFile.js';
import { createStatusLimiter } from './roomStatus.js';
import { createAnnouncementReader } from './announcement.js';
import { readAssetsCdnVersionFile, readAssetsManifestFile, VERSION_PREFIX } from './assetVersion.js';
import { SimulationPool, workerSettings } from './workers/pool.js';
import { assetCdnSettings, resolveAssetsCdnVersion } from '../shared/assetCdn.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy, VERSION_PREFIX,
};

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object, wsCompression?: boolean | string,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string,
 *   announcementFile?: string, announcementUrl?: string, announcementPollMs?: number,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   workers?: number, workerQueue?: number, workerTimeoutMs?: number, workerPool?: SimulationPool | null,
 *   assetsCdn?: string, assetsCdnVersion?: string, assetsVersionFile?: string, assetsManifestFile?: string,
 *   stateFile?: string | null, store?: object | null, resume?: boolean, saveMs?: number,
 * }} [opts]
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPackRegistry>,
 *                     workerPool: SimulationPool | null, store: object | null, persister: Persister | null,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const { publicDir, dataDir, sharedDir, packsDir } = serveDirs(opts);

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  // The shared CPU pool is owned by startServer (opts.workerPool injects one, tests share it); 0 threads disable it.
  const workerConfig = workerSettings();
  for (const [option, key] of [['workers', 'size'], ['workerQueue', 'maxQueue'], ['workerTimeoutMs', 'timeoutMs']]) {
    if (opts[option] != null) workerConfig[key] = opts[option];
  }
  const ownsWorkerPool = opts.workerPool === undefined;
  if (!Number.isInteger(workerConfig.size) || workerConfig.size < 0 || workerConfig.size > 32) {
    throw new RangeError('workers must be 0..32');
  }
  const workerPool = ownsWorkerPool ? (workerConfig.size > 0 ? new SimulationPool({ data, ...workerConfig }) : null) : opts.workerPool;
  const { registry, lobby, network } = createSessionStack({ ...opts, workerPool }, { data, log });
  // content packs (docs/guides/PACKS.md): scanned now — the start log names them — and again whenever their folders change
  const packs = createPackRegistry({ publicDir, dataDir, packsDir }, { log });
  packs.refresh(true);

  // The per-file art manifest (`.assets-manifest.json`, shipped by tools/r2-sync.mjs and committed
  // with the release) supersedes the release-tag lookup: with it, art URLs carry a per-file `?v=`
  // query and no version is needed. Without it the legacy chain applies — the repo's
  // `.assets-cdn-version` (travels with `git pull`), then the CDN's own `/_v/latest` publication —
  // and a CDN without either simply stays unversioned.
  const cdnBase = opts.assetsCdn ?? process.env.SP_ASSETS_CDN;
  const assetsManifest = cdnBase ? readAssetsManifestFile(opts.assetsManifestFile) : null;
  let cdnVersion = '';
  if (cdnBase && !assetsManifest) {
    cdnVersion = opts.assetsCdnVersion ?? process.env.SP_ASSETS_CDN_VERSION;
    if (!cdnVersion) {
      cdnVersion = readAssetsCdnVersionFile(opts.assetsVersionFile);
      if (cdnVersion) log.info(`assets CDN ${cdnBase} release ${cdnVersion} (from the version file)`);
      else {
        cdnVersion = await resolveAssetsCdnVersion(cdnBase);
        log.info(cdnVersion ? `assets CDN ${cdnBase} release ${cdnVersion} (from /_v/latest)` : `assets CDN ${cdnBase} publishes no release tag, serving unversioned URLs`);
      }
    }
  }
  const cdn = assetCdnSettings(cdnBase, cdnVersion);
  if (assetsManifest) log.info(`assets CDN ${cdnBase} manifest ${assetsManifest.tag} (${Object.keys(assetsManifest.hashes).length} files, per-file ?v= busting)`);

  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log,
    assetsCdn: cdn.base, assetsCdnVersion: cdn.version, assetsManifest });

  // Persistence: SP_STATE_FILE (a directory → the sharded layout, a .json path → the single file, 'off' → memory only).
  const stateFile = opts.stateFile !== undefined ? opts.stateFile : process.env.SP_STATE_FILE;
  if (stateFile && stateFile !== 'off') {
    const absoluteState = path.resolve(stateFile);
    for (const root of [publicDir, dataDir, sharedDir]) {
      const relative = path.relative(path.resolve(root), absoluteState);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        if (ownsWorkerPool) await workerPool?.close();
        throw new Error('SP_STATE_FILE 不能位于公开静态目录，建议使用 .state/ 或私有数据目录');
      }
    }
  }
  const store = opts.store !== undefined ? opts.store : stateFile && stateFile !== 'off'
    ? new FileStateStore({ file: stateFile, log }) : null;
  const persister = store ? new Persister({ store, registry, lobby, log, saveMs: opts.saveMs ?? process.env.SP_STATE_SAVE_MS }) : null;
  try {
    if (store) {
      const doc = await store.load();
      if (doc && opts.resume !== false) {
        const stats = restoreServer({ doc, registry, lobby, log });
        if (!stats.ok) throw new Error(`状态格式不兼容 (${stats.reason})，已保留状态文件，请恢复备份或显式选择新的 SP_STATE_FILE`);
        log.info(`[persist] restored ${stats.sessions} sessions, ${stats.rooms} rooms, ${stats.matches} matches`);
      }
    }
  } catch (err) {
    persister?.stop();
    lobby.shutdown('shutdown');
    await store?.close();
    if (ownsWorkerPool) await workerPool?.close();
    throw err;
  }

  const allowStatus = createStatusLimiter({ trustProxy: parseTrustProxy(opts.trustProxy ?? process.env.TRUST_PROXY) });
  const readAnnouncement = createAnnouncementReader({
    filePath: path.resolve(ROOT, opts.announcementFile ?? process.env.SP_ANNOUNCEMENT_FILE ?? 'announcement.json'), log,
    announcementUrl: opts.announcementUrl ?? process.env.SP_ANNOUNCEMENT_URL,
    pollMs: Number(process.env.SP_ANNOUNCEMENT_POLL_MS) || undefined,
  });
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag();

  const server = http.createServer(createRequestHandler({
    serveStatic,
    health: { startedAt, network, registry, lobby, workerPool, persister, store, serveStatic, cdn, assetsManifest },
    log, allowStatus, readAnnouncement,
  }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, wsCompression: opts.wsCompression ?? process.env.SP_WS_COMPRESSION });

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
    persister?.stop();
    lobby.shutdown('shutdown');
    await store?.close();
    if (ownsWorkerPool) await workerPool?.close();
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));
  persister?.start();
  if (workerPool) log.info(`[workers] ${workerPool.size} threads, queue ${workerPool.maxQueue}, timeout ${workerPool.timeoutMs} ms (lazy start)`);

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      if (persister) {
        const saved = await persister.shutdown('shutdown');
        if (!saved) log.error('[persist] final state was NOT saved; check the state directory permissions and disk space');
      }
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      if (ownsWorkerPool) await workerPool?.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
      await store?.close();
    })();
    return closing;
  }

  return { port: actualPort, host, url, server, wss, lobby, network, registry, packs, workerPool, store, persister, close };
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) {
  runMain(() => startServer({ stateFile: process.env.SP_STATE_FILE ?? path.join(ROOT, '.state', `server-${process.env.PORT || 3000}`) }));
}
