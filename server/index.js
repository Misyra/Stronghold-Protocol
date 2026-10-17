// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST '::' dual-stack, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB;
//                      refused at upgrade with 404 / 429 per network / 503; SP_WS_COMPRESSION, this fork's bounded
//                      permessage-deflate, 'on' default)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser
//                      the content packs (/packs/index.json, /packs/<id>/<file> — the registry is plugins/registry.js), the plugin catalogue
//                      (/plugins/index.json — the registry is plugins/registry.js), the vanilla content set's manifest
//                      (/cs/<cs16>/index.json — plugins/identity.js: the content hash `cs`, DESIGN §32), the visual sets
//                      of cosmetic plugins (/vs/<vs16>/…, plugins/visualSet.js) and their files (/p/<id>/<hash8>/…),
//                      the content sets of gameplay plugins (/cs/<cs16>/…, plugins/contentSets.js — DESIGN §32.6; the
//                      server owner's plugins/config.json: plugins/policy.js; a room's plugins: plugins/roomSets.js; its
//                      match then runs in that set's worker: match/host/)
//                      this fork's release/CDN asset layer (/_v/<tag>/ URLs, the per-file art manifest of
//                      tools/r2-sync.mjs, /data/resource-manifest.json for the offline preload, URL rewriting + CORS)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   assetVersion.js    the served release tag (/healthz `build`, public/js/ui/buildGuard.js)
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400 / 405, GET /healthz → JSON status (this fork:
//                      worker / memory / static-cache / socket-buffer / wire / persist diagnostics),
//                      the plugin studio (/studio/, studio/index.js —
//                      this machine and the local network only),
//                      GET /api/ping, GET /api/rooms/<code>/status (rate-limited, roomStatus.js), GET /api/announcement,
//                      else static
//   http/traffic.js    the traffic counters: bytes sent per category (assets / audio / code / data) and on the
//                      WebSocket, since the start (GET /healthz?traffic=1)
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       a pending update package first (update.js: old files deleted, the install verified against
//                      MANIFEST.json), banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT /
//                      SIGTERM
//
// This fork's extra wiring in startServer():
//   * SimulationPool (server/workers/pool.js): bot rehearsal, normal / 联防 headless runs and SP_VERIFY=all
//     verifications run in worker threads (SP_WORKERS etc.; 0 disables). The pool is created here and closed on close().
//   * RoomWorkerPool (server/workers/roomPool.js): opt-in room lanes (SP_ROOM_WORKERS 1..N, default 0; must not exceed
//     SP_WORKERS) — each room's simulation tasks are pinned to one lane's own queue instead of the shared one.
//   * Persister / FileStateStore (server/persist.js, server/stateFile.js): SP_STATE_FILE (default .state/server-<PORT>:
//     `.state/server-<PORT>/` sharded directory layout, `off` disables) keeps sessions, rooms and running matches across
//     restarts; restored before listening, final write on graceful shutdown. It must not sit in a public directory.
//   * Announcement reader (server/announcement.js): probe-managed announcement file by default (http/config.js);
//     SP_ANNOUNCEMENT_SOURCE=file explicitly selects SP_ANNOUNCEMENT_FILE → GET /api/announcement.
//   * Assets CDN (SP_ASSETS_CDN + .assets-manifest.json / .assets-cdn-version / CDN /_v/latest): static.js rewrites
//     art URLs to the CDN; /healthz reports the resolved release.
//   * Lobby: 同盟匹配 (matchmaking.js), the room status projection (roomStatus.js) and the persistence checkpoints
//     (lobby.onCheckpoint) live in server/lobby.js.
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import { within } from './pathSafety.js';
import { initializeModeration } from './moderation/nickname.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getData, loadData } from './data.js';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy, announcementOptionsFrom, roomAdminTokenFrom, lobbyOptionsFrom, portalRoomOptionsFrom, siteIdFrom } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket, parseWsOrigins } from './http/websocket.js';
import { siteCsp } from './http/csp.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPluginRegistry } from './plugins/registry.js';
import { computeVanillaContent } from './plugins/identity.js';
import { createVisualSets } from './plugins/visualSet.js';
import { createContentSets } from './plugins/contentSets.js';
import { createPluginPolicy } from './plugins/policy.js';
import { createRoomSets } from './plugins/roomSets.js';
import { createMatchHosts } from './match/host/index.js';
import { createTrustedRuntime } from './plugins/trustedRuntime.js';
import { trustedHostAllowed } from './plugins/trusted.js';
import { createStudio } from './studio/index.js';
import { MIME, COMPRESSIBLE, acceptsGzip, pickEncoding, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { publicApiLimitsFrom, apiMainlandOnlyFrom } from './http/publicApiLimit.js';
import { createIpBanStore } from './http/ipBans.js';
import { wsUpgradeLimitsFrom } from './http/wsUpgradeLimit.js';
import { createTrafficCounter } from './http/traffic.js';
import { answerClientError } from './http/common.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';
import { Persister, restoreServer } from './persist.js';
import { FileStateStore } from './stateFile.js';
import { createStatusLimiter } from './roomStatus.js';
import { createAnnouncementReader } from './announcement.js';
import { ChatLog } from './chatLog.js';
import { readAssetsCdnVersionFile, readAssetsManifestFile, VERSION_PREFIX } from './assetVersion.js';
import { SimulationPool, workerSettings } from './workers/pool.js';
import { RoomWorkerPool } from './workers/roomPool.js';
import { assetCdnSettings, resolveAssetsCdnVersion } from '../shared/assetCdn.js';
import { listenRoomAdmin, loadRoomConfigDocument } from './roomAdmin.js';
import { saveRoomConfigDocument } from './roomConfig.js';
import { openCountryLookup, parseGeoipMode } from './geoip.js';
import { parseIpSessionScope } from './foreignSessions.js';
import { cleanupRuntime } from './runtimeCleanup.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, pickEncoding, parseRange, createStaticHandler, createTrafficCounter, lanUrls, parseTrustProxy, VERSION_PREFIX,
};

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object, wsCompression?: boolean | string,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, pluginsDir?: string,
 *   announcementSource?: 'agent' | 'panel' | 'file', announcementAgentFile?: string, announcementFile?: string, announcementUrl?: string, announcementPollMs?: number,
 *   announcementSiteId?: string, announcementPortalUrl?: string,
 *   chatEnabled?: boolean, chatLogDir?: string, chatLogCompressAfterDays?: number, chatLogRetentionDays?: number,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   workers?: number, roomWorkers?: number, workerQueue?: number, workerTimeoutMs?: number,
 *   workerPool?: SimulationPool | import('./workers/roomPool.js').RoomWorkerPool | null,
 *   roomAdminToken?: string, roomAdminPort?: number, roomAdminStateFile?: string, allowBots?: boolean, roomCreateBurst?: number, roomCreateRefillMs?: number,
 *   matchStartBurst?: number, matchStartRefillMs?: number,
 *   geoLiteCountryFile?: string, geoipMode?: 'country' | 'cn-only', countryLookup?: (ip: string) => string | null, maxBots?: number, maxForeignBots?: number, limitForeignSessions?: boolean, allowForeignConnections?: boolean, maxForeignSessionsPerIp?: number, ipSessionScope?: 'all' | 'foreign',
 *   assetsCdn?: string, assetsCdnVersion?: string, assetsVersionFile?: string, assetsManifestFile?: string,
 *   stateFile?: string | null, store?: object | null, resume?: boolean, saveMs?: number,
 *   studio?: boolean,
 * }} [opts]
 *   studio: the plugin studio at /studio/ (default on for this machine and the local network — SP_STUDIO=local|off;
 *   false: none);
 *   matchHost: options of the match hosts (server/match/host/index.js — watchdogMs, matchOptions …; tests)
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPluginRegistry>,
 *                     workerPool: SimulationPool | import('./workers/roomPool.js').RoomWorkerPool | null, store: object | null, persister: Persister | null, chatLog: ChatLog,
 *                     content: import('./plugins/identity.js').VanillaContent, visual: ReturnType<typeof createVisualSets>,
 *                     contents: ReturnType<typeof createContentSets>, hosts: ReturnType<typeof createMatchHosts>,
 *                     traffic: ReturnType<typeof createTrafficCounter>,
 *                     studio: ReturnType<typeof createStudio> | null,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const publicApiLimits = publicApiLimitsFrom(opts.publicApiLimits);
  const wsUpgradeLimits = wsUpgradeLimitsFrom(opts.wsUpgradeLimits);
  const apiMainlandOnly = apiMainlandOnlyFrom(opts.httpApiMainlandOnly ?? process.env.SP_HTTP_API_CN_ONLY);
  initializeModeration();
  const { port, host } = listenAddress(opts);
  const ipSessionScope = parseIpSessionScope(opts.ipSessionScope ?? process.env.SP_IP_SESSION_SCOPE);
  const log = opts.log || makeLogger(!!opts.quiet);
  const announcementOptions = announcementOptionsFrom(opts);
  const roomAdminToken = roomAdminTokenFrom(opts);
  // 分享模式与它的本机凭据（§47.3）。放在启动时校验：填错一个字节不该等到某个玩家点分享才暴露。
  const portalRoom = portalRoomOptionsFrom(opts);
  const siteId = siteIdFrom(opts);
  const { publicDir, dataDir, sharedDir, packsDir, pluginsDir } = serveDirs(opts);
  const ipBanFile = path.resolve(opts.ipBanFile ?? process.env.SP_HTTP_BAN_FILE ?? path.join(ROOT, '.state', 'http-ip-bans.jsonl'));
  for (const root of [publicDir, dataDir, sharedDir, packsDir]) {
    if (within(root, ipBanFile)) throw new Error('SP_HTTP_BAN_FILE cannot be in a public static directory');
  }
  const ipBans = createIpBanStore({ file: ipBanFile, log });
  const simDir = path.join(ROOT, 'server', 'sim');
  const lobbyOptions = lobbyOptionsFrom(opts);
  const geoLiteFile = opts.geoLiteCountryFile ?? process.env.SP_GEOLITE_COUNTRY_DB;
  const geoipMode = parseGeoipMode(opts.geoipMode ?? process.env.SP_GEOIP_MODE);
  let countryLookup = opts.countryLookup ?? null;
  if (countryLookup !== null && typeof countryLookup !== 'function') throw new TypeError('countryLookup must be a function');
  if (!countryLookup && geoLiteFile) {
    const file = path.resolve(geoLiteFile);
    for (const root of [publicDir, dataDir, sharedDir, packsDir]) {
      if (within(root, file))
        throw new Error('SP_GEOLITE_COUNTRY_DB cannot be in a public static directory');
    }
    countryLookup = await openCountryLookup(file, { mode: geoipMode });
    log.info(`[geoip] country database loaded in ${geoipMode} mode`);
    if (geoipMode === 'cn-only') log.warn('[geoip] mainland-only IPv4 mode: unmatched IPv6 addresses remain unknown and are not restricted as foreign');
  }
  // API-only default: use the bundled global database without enabling/changing gameplay GeoIP gates.
  let apiCountryLookup = countryLookup;
  if (apiMainlandOnly && !apiCountryLookup) {
    try { apiCountryLookup = await openCountryLookup(path.join(ROOT, 'geoip', 'GeoLite2-Country.mmdb')); }
    catch (error) { log.error('[http] API mainland-only database unavailable; public API requests will return 503', error); }
  }
  log.info(`[http] API mainland-only: ${apiMainlandOnly ? (apiCountryLookup ? 'on' : 'database unavailable') : 'off'}; permanent ban after ${publicApiLimits.banThreshold} requests/${publicApiLimits.banWindowMs}ms`);
  log.info(`[ws] upgrade ban: after ${wsUpgradeLimits.threshold} attempts/${wsUpgradeLimits.windowMs}ms, ban for ${wsUpgradeLimits.banMs}ms`);
  log.info(`[bots] total AI population limit: ${lobbyOptions.maxBots}`);
  if (countryLookup) log.info(`[geoip] foreign AI population limit enabled: ${lobbyOptions.maxForeignBots}`);
  else log.warn('[geoip] no country database configured; foreign AI limit is disabled, total AI limit remains active');
  const roomAdminStateFile = path.resolve(opts.roomAdminStateFile ?? process.env.SP_ROOM_ADMIN_STATE_FILE ?? path.join(ROOT, '.state', 'room-admin.json'));
  for (const root of [publicDir, dataDir, sharedDir, packsDir]) {
    if (within(root, roomAdminStateFile))
      throw new Error('SP_ROOM_ADMIN_STATE_FILE 不能位于公开静态目录');
  }
  let roomConfig = null;
  if (roomAdminToken) {
    try { roomConfig = await loadRoomConfigDocument(roomAdminStateFile); }
    catch (error) { log.error('[room-admin] saved room limit unavailable; using startup configuration', error); }
    // v1 → v2 迁移（§43.2）：读出来就按第 1 版落成 v2。不这么做的话，旧文件会一直停在「被兼容读取」的
    // 状态 —— 每次启动都读一遍旧格式，而第一次改动才写新格式，中间任何一个只读的排查都得自己换算。
    if (roomConfig?.migrated) {
      try { await saveRoomConfigDocument(roomAdminStateFile, roomConfig); }
      catch (error) { log.error('[room-admin] room config migration to v2 failed; the old file stays readable', error); }
    }
  }
  const savedRoomConfig = roomConfig?.values ?? null;
  lobbyOptions.maxRooms = opts.maxRooms ?? savedRoomConfig?.maxRooms ?? lobbyOptions.maxRooms ?? 1000;
  if (opts.allowBots == null && typeof savedRoomConfig?.allowBots === 'boolean') lobbyOptions.allowBots = savedRoomConfig.allowBots;
  if (opts.limitForeignSessions == null && typeof savedRoomConfig?.limitForeignSessions === 'boolean')
    lobbyOptions.limitForeignSessions = savedRoomConfig.limitForeignSessions;
  if (opts.allowForeignConnections == null && typeof savedRoomConfig?.allowForeignConnections === 'boolean')
    lobbyOptions.allowForeignConnections = savedRoomConfig.allowForeignConnections;
  if (opts.maxForeignSessionsPerIp == null && Number.isSafeInteger(savedRoomConfig?.maxForeignSessionsPerIp))
    lobbyOptions.maxForeignSessionsPerIp = savedRoomConfig.maxForeignSessionsPerIp;
  log.info(`[sessions] ${ipSessionScope} IP limit: ${lobbyOptions.limitForeignSessions ? lobbyOptions.maxForeignSessionsPerIp : 'off'}, GeoIP ${countryLookup ? 'ready' : 'unavailable'}`);
  if (lobbyOptions.limitForeignSessions && ipSessionScope === 'foreign' && !countryLookup)
    log.warn('[sessions] foreign scope needs a GeoIP country database; session quota is inactive until configured');
  log.info(`[connections] foreign access: ${lobbyOptions.allowForeignConnections ? 'allowed' : 'blocked when GeoIP identifies a foreign source'}`);
  // 分享模式的启动自述：排障的第一件事就是「这个站点是哪种模式、往哪里发」，而这两件事都只来自启动配置。
  log.info(`[portal] site ${siteId ?? 'unset'} · room share ${portalRoom.mode}` +
    (portalRoom.mode === 'agent' ? ` via ${portalRoom.agentUrl}` : portalRoom.mode === 'legacy-http' ? ` to ${new URL('/api/rooms/from-game', portalRoom.url).origin}` : ''));
  const chatLog = new ChatLog({ dir: opts.chatLogDir ?? process.env.SP_CHAT_LOG_DIR,
    compressAfterDays: opts.chatLogCompressAfterDays ?? process.env.SP_CHAT_LOG_COMPRESS_AFTER_DAYS,
    retentionDays: opts.chatLogRetentionDays ?? process.env.SP_CHAT_LOG_RETENTION_DAYS,
    publicDirs: [publicDir, dataDir, sharedDir, packsDir], log });

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
  // Opt-in room lanes (server/workers/roomPool.js): SP_ROOM_WORKERS / opts.roomWorkers, 0 keeps the plain shared pool.
  const rawRoomWorkers = opts.roomWorkers ?? process.env.SP_ROOM_WORKERS;
  const roomWorkers = rawRoomWorkers == null || String(rawRoomWorkers).trim() === '' ? 0 : Number(rawRoomWorkers);
  if (!Number.isInteger(roomWorkers) || roomWorkers < 0 || roomWorkers > 32) throw new RangeError('roomWorkers must be 0..32');
  if (roomWorkers > workerConfig.size) throw new RangeError('roomWorkers cannot exceed workers');
  const workerPool = ownsWorkerPool ? (workerConfig.size > 0
    ? (roomWorkers > 0
      ? new RoomWorkerPool({ data, lanes: roomWorkers, totalWorkers: workerConfig.size,
        maxQueue: workerConfig.maxQueue, timeoutMs: workerConfig.timeoutMs })
      : new SimulationPool({ data, ...workerConfig }))
    : null) : opts.workerPool;
  // the vanilla content hash `cs` (DESIGN §32): the bytes of the served sim, shared code and game data, read once now —
  // like the data the matches use and the build tag below
  const content = computeVanillaContent({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log });
  log.info(`[content] vanilla ${content.cs.slice(0, 16)} (${Object.keys(content.simFiles).length} code files, ${Object.keys(content.data).length} data files)`);
  // language packs and plugins (docs/PACKS.md, docs/PLUGINS.md): scanned now — the start log names them — and again
  // whenever their folders change
  const scriptMode = process.env.SP_PLUGIN_SCRIPTS;
  const packs = createPluginRegistry({ publicDir, dataDir, packsDir, pluginsDir }, { log, scriptHost:host, scriptMode });
  packs.refresh(true);
  // the visual sets of the cosmetic plugins (DESIGN §32 P1a): what a room's host switches on, served at /vs/ and /p/
  const visual = createVisualSets({ registry: packs, log });
  // the server owner's policy (plugins/config.json), the content sets of the gameplay plugins (served at /cs/<cs16>/…),
  // what a room's plugins make of both, and the match hosts a room with gameplay plugins plays in (DESIGN §32.6)
  const policy = createPluginPolicy({ pluginsDir, log });
  const contents = createContentSets({ registry: packs, vanillaData: data, log, maxSets: () => policy.get().maxSets });
  const roomSets = createRoomSets({ registry: packs, visual, contents, policy });
  // a child process per content set; SP_MATCH_HOST=worker asks for a worker thread instead (match/host/index.js header:
  // an out-of-memory abort in a worker thread ends the whole server)
  const transport = String(process.env.SP_MATCH_HOST || '').trim().toLowerCase() === 'worker' ? 'worker' : 'process';
  const hosts = createMatchHosts({ contents, log, options: { transport, maxWorkers: Math.max(1, policy.get().maxSets), ...(opts.matchHost || {}) } });
  const { registry, lobby, network } = createSessionStack({ ...opts, ...lobbyOptions, ipSessionScope, countryLookup, workerPool }, { data, log, chatLog, content, plugins: roomSets, hosts });
  // the plugin studio (DESIGN §32.9): its page and API for this machine and the local network; it watches plugins/ only
  // once it is used (hot reload), and rooms whose host is the author or alone follow a plugin's changes by themselves
  const studio = opts.studio === false ? null : createStudio({ publicDir, pluginsDir, dataDir, registry: packs, lobby, sessions: registry, log, fetch: opts.fetch });
  const trustedRuntime = await createTrustedRuntime({registry:packs,log});
  lobby.trustedRuntime = trustedRuntime;
  const release = (extra = {}) => cleanupRuntime({ lobby, network, chatLog, workerPool, ownsWorkerPool, log, ...extra });

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

  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, simDir, packsDir, pluginsDir, packs, content, visual, contents, log,
    assetsCdn: cdn.base, assetsCdnVersion: cdn.version, assetsManifest,
    clientBuild: opts.clientBuild ?? !process.argv.includes('--source-client') });

  // Persistence: SP_STATE_FILE (a directory → the sharded layout, a .json path → the single file, 'off' → memory only).
  const stateFile = opts.stateFile !== undefined ? opts.stateFile : process.env.SP_STATE_FILE;
  if (stateFile && stateFile !== 'off') {
    const absoluteState = path.resolve(stateFile);
    for (const root of [publicDir, dataDir, sharedDir]) {
      if (within(root, absoluteState)) {
        await release();
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
    await release({ persister, store });
    throw err;
  }

  const allowNickname = createStatusLimiter({ trustProxy: parseTrustProxy(opts.trustProxy ?? process.env.TRUST_PROXY) });
  const allowStatus = createStatusLimiter({ trustProxy: parseTrustProxy(opts.trustProxy ?? process.env.TRUST_PROXY) });
  const readAnnouncement = createAnnouncementReader({ ...announcementOptions, log });
  log.info(`[announcement] ${announcementOptions.source.mode} ${announcementOptions.announcementUrl || announcementOptions.filePath}`);
  const startedAt = Date.now();
  // Game boot id (lobby share / 联机站, docs/design/portal-agent-wss.md §46.3): a fresh value on every process start.
  // The room instance id survives a restart, so "the same roomId" alone cannot tell a probe whether an observation it
  // still holds predates the restart — this can, and the Agent reports it with every room observation.
  const gameBootId = randomUUID();
  // createStaticHandler already computes the authoritative 16-character release
  // tag. The legacy buildTag exports remain compatibility helpers only.

  // Every response's body bytes and every WebSocket's wire/payload bytes count here (upstream 0.2.6); the snapshot is
  // reachable through GET /healthz?traffic=1 for a loopback or private-network client only (http/routes.js).
  const traffic = createTrafficCounter();
  const server = http.createServer(createRequestHandler({
    serveStatic, csp: process.env.SP_CSP === 'off' ? null : siteCsp(publicDir, serveStatic.transformPage, cdn.base),
    health: { startedAt, gameBootId, network, registry, lobby, workerPool, persister, store, serveStatic, cdn, assetsManifest, chatLog, traffic, content, trusted: trustedRuntime?.health },
    log, allowStatus, allowNickname, publicApiLimits, ipBans, apiMainlandOnly, apiCountryLookup,
    readAnnouncement, announcementSource: announcementOptions.source,
    portalRoom, studio, trustedRuntime, trustProxy: network.opts.trustProxy,
  }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, traffic, ipBans, wsUpgradeLimits,
    isIpBanned: (req) => ipBans.isBanned(req, network.opts.trustProxy),
    wsCompression: opts.wsCompression ?? process.env.SP_WS_COMPRESSION,
    wsOrigins: parseWsOrigins(opts.wsOrigins ?? process.env.SP_WS_ORIGINS) });

  // The address actually bound. The default may fall back to IPv4; the returned host and url follow that.
  let boundHost, roomAdmin = null;
  try {
    // A host with IPv6 switched off refuses '::'. Fall back to IPv4 rather than not booting. Only the default is
    // retried: an explicit HOST is literal (server/http/config.js bindCandidates).
    let bound = null;
    let lastError = null;
    const candidates = bindCandidates(host);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { server.off('listening', onListening); reject(e); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, candidate);
        });
        bound = candidate;
        break;
      } catch (e) {
        lastError = e;
        const retry = ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code) && i < candidates.length - 1;
        if (!retry) break;
        log.warn(`[boot] cannot bind ${candidate} (${e.code}) — falling back to IPv4 only`);
      }
    }
    if (bound === null) throw lastError;
    boundHost = bound;
    try {
      roomAdmin = await listenRoomAdmin({ lobby, registry, token: roomAdminToken, gameBootId, roomConfig,
        port: opts.roomAdminPort ?? (process.env.SP_ROOM_ADMIN_PORT ? Number(process.env.SP_ROOM_ADMIN_PORT) : 3001),
        stateFile: roomAdminStateFile, log });
    } catch (error) { log.error('[room-admin] loopback API unavailable; game service remains online', error); }
    // Check the kernel's address too: aliases/DNS and bind fallback cannot weaken the owner gate.
    const actual = server.address();
    const scriptHost = actual && typeof actual === 'object' ? actual.address : '';
    packs.setScriptHost(scriptHost);
    if (!trustedHostAllowed(scriptHost, scriptMode)) {
      lobby.trustedRuntime = null;
      await trustedRuntime?.close();
    }
  } catch (e) {
    studio?.close();
    await trustedRuntime?.close();
    await release({ persister, store, server, wss, roomAdmin });
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));
  persister?.start();
  chatLog.start();
  if (Array.isArray(workerPool?.lanes)) {
    const threads = workerPool.lanes.reduce((n, lane) => n + lane.pool.size, 0);
    log.info(`[workers] ${workerPool.lanes.length} room lanes over ${threads} threads, queue ${workerPool.lanes[0].pool.maxQueue}, timeout ${workerPool.lanes[0].pool.timeoutMs} ms (lazy start; /healthz workers.kind room-lanes)`);
  } else if (workerPool) {
    log.info(`[workers] ${workerPool.size} threads, queue ${workerPool.maxQueue}, timeout ${workerPool.timeoutMs} ms (lazy start)`);
  }

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${displayHost(boundHost)}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try {
        network.beginDrain();
        lobby.beginDrain();
        await roomAdmin?.drain();
      try { hosts.close(); } catch (e) { log.error('[shutdown] match hosts', e); }
      studio?.close();
      await trustedRuntime?.close();
        if (persister) {
          const saved = await persister.shutdown('shutdown');
          if (!saved) log.error('[persist] final state was NOT saved; check the state directory permissions and disk space');
        }
      } finally { await release({ persister, store, server, wss, roomAdmin }); }
    })();
    return closing;
  }

  return { port: actualPort, host: boundHost, url, roomAdminUrl: roomAdmin?.url || null, server, wss, lobby, network, registry, packs, content, visual, contents, hosts, studio, workerPool, store, persister, chatLog, traffic, close };
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) {
  runMain(() => startServer({ stateFile: process.env.SP_STATE_FILE ?? path.join(ROOT, '.state', `server-${process.env.PORT || 3000}`) }));
}
