// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST '::' dual-stack, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger, the official versions
//                      this server offers (SP_VERSIONS / SP_VERSION_DEFAULT / SP_MAX_VERSION_HOSTS — versions.js below)
//   versions.js        the official versions (DESIGN §35.23, M1): each enabled one's cs, data, manifest
//                      (/cs/<cs16>/index.json) and data directory (/data/versions/<slug>/); their matches run in match
//                      hosts of their own (match/host/, kind 'version') — the pool exists when another version is
//                      enabled (the default: all four) and forks a process on the first match of one, never at boot;
//                      none when only 第二期下半 is enabled
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB,
//                      permessage-deflate from 1 KB; refused at upgrade with 404 / 429 per network / 503)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser stand-in,
//                      the language packs (/packs/index.json, /packs/<id>/<file>), the plugin catalogue
//                      (/plugins/index.json — the registry is plugins/registry.js), the vanilla content set's manifest
//                      (/cs/<cs16>/index.json — plugins/identity.js: the content hash `cs`, DESIGN §32), the visual sets
//                      of cosmetic plugins (/vs/<vs16>/…, plugins/visualSet.js) and their files (/p/<id>/<hash8>/…),
//                      the content sets of gameplay plugins (/cs/<cs16>/…, plugins/contentSets.js — DESIGN §32.6; the
//                      server owner's plugins/config.json: plugins/policy.js; a room's plugins: plugins/roomSets.js; its
//                      match then runs in that set's worker: match/host/)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, brotli / gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/assetIndex.js the content hashes of public/assets and public/fonts (built in the background, cached in
//                      .cache/asset-hashes.json by path + size + mtime; Spine models share one hash)
//   http/assetViews.js the served /data/assets.json, /data/local-assets.json and /data/local-fx.json: every art URL with
//                      its hash segment (/assets/~<hash>/…, immutable when the hash matches); the files stay unchanged
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400, the access gate (http/gate.js — /entry, the
//                      login endpoints and the cookie; SP_GATE_PASSWORD), the plugin studio (/studio/, studio/index.js —
//                      this machine and the local network only), 405, GET /healthz → JSON status, else static
//   http/traffic.js    the traffic counters: bytes sent per category (assets / audio / code / data) and on the
//                      WebSocket, since the start (GET /healthz?traffic=1)
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       a pending update package first (update.js: old files deleted, the install verified against
//                      MANIFEST.json), banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT /
//                      SIGTERM
//
// Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
// (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import path from 'node:path';
import { loadDataAsync, preloadData, simWorkerData } from './data.js';
import { getBotStrategy, getBotStrategySeats } from './match/botStrategies.js';
import { noteLlmIgnored, releaseIgnoresExternalAi, validateExternalConfig } from './match/llmGate.js';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy, parseAssetCdn, assetIndexOptionsFrom, versionsFrom, parseRoomCode, announcementOptionsFrom } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { siteCsp } from './http/csp.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPluginRegistry } from './plugins/registry.js';
import { computeVanillaContentAsync } from './plugins/identity.js';
import { createVisualSets } from './plugins/visualSet.js';
import { createContentSets } from './plugins/contentSets.js';
import { createPluginPolicy } from './plugins/policy.js';
import { createRoomSets } from './plugins/roomSets.js';
import { warmupScriptProbes } from './plugins/scriptPreflight.js';
import { createMatchHosts } from './match/host/index.js';
import { createVersionSets, preloadVersionFiles } from './versions.js';
import { versionById } from '../shared/versions.js';
import { t } from '../shared/i18n.js';
import { createTrustedRuntime } from './plugins/trustedRuntime.js';
import { trustedHostAllowed } from './plugins/trusted.js';
import { createStudio } from './studio/index.js';
import { MIME, COMPRESSIBLE, acceptsGzip, pickEncoding, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { gateFrom } from './http/gate.js';
import { ChatLog } from './chatLog.js';
import { chatEnabled } from './moderation/chat.js';
import { initializeModeration } from './moderation/nickname.js';
import { Persister, restoreServerForBoot } from './persist.js';
import { FileStateStore } from './stateFile.js';
import { createRedisStore } from './redisState.js';
import { createValkeyStore, resolvePersistBackend } from './valkeyState.js';
import { within } from './pathSafety.js';
import { createAnnouncementReader, createAnnouncementSignal } from './announcement.js';
import { createTrafficCounter } from './http/traffic.js';
import { createAssetIndex } from './http/assetIndex.js';
import { createManifestViews } from './http/assetViews.js';
// eslint-disable-next-line no-unused-vars -- assetIndex/assetViews 保留在盘上(工具与回滚用),但不再在启动时构建:
// 用户分支的预载/CDN 缓存体系(/_v/ 发布层 + 每文件指纹 + 分包)取代了内容哈希索引的职责。
import { assetCdnSettings, resolveAssetsCdnVersion } from '../shared/assetCdn.js';
import { DEFAULT_RESOURCE_PACK_ROUTES, parseResourcePackRoutes } from '../shared/resourcePackRoutes.js';
import { readAssetsCdnVersionFile, readAssetsManifestFile } from './assetVersion.js';
import { answerClientError } from './http/common.js';
import { createEventLoopMonitor } from './health/eventLoop.js';
import { createHealthMetrics } from './healthMetrics.js';
import { createRoomWorkerPool } from './workers/roomPool.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, pickEncoding, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
};

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, pluginsDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   versionVoteMs?: number, versionRetryMs?: number, afkRemoveRounds?: number,
 *   roomCode?: string | null,
 *   stateFile?: string | null, store?: object | null, resume?: boolean, saveMs?: number,
 *   assetIndex?: boolean | { cacheFile?: string | null, delayMs?: number }, studio?: boolean,
 *   matchHost?: object, versions?: { enabled?: 'all' | string[], default?: string, maxHosts?: number },
 *   gatePassword?: string | null, gateSecret?: string | null, gateTtlDays?: number, gateLocal?: boolean,
 *   gate?: false,
 *   healthMetricsFactory?: typeof import('./healthMetrics.js').createHealthMetrics, phaseMetrics?: object,
 * }} [opts]
 *   gatePassword / gateSecret / gateTtlDays / gateLocal: the access gate (http/gate.js; SP_GATE_PASSWORD … — a
 *   password enables it, loopback and the private network skip it unless gateLocal is false); gate: false disables it
 *   even when the environment names one (tests);
 *   assetIndex: the content-hash index (default on; false or SP_ASSET_INDEX=0: off — config.js assetIndexOptionsFrom);
 *   studio: the plugin studio at /studio/ (default on for this machine and the local network — SP_STUDIO=local|off;
 *   false: none);
 *   matchHost: options of the match hosts (server/match/host/index.js — watchdogMs, matchOptions …; tests) — the
 *   version hosts' too; versions: the official versions this server offers (http/config.js versionsFrom; DESIGN §35.23);
 *   versionVoteMs / versionRetryMs: the version vote's answer window and the guard after a declined or expired vote (tests;
 *   server/lobby.js header "Official versions")
 *   roomCode: a fixed alliance key for every new room (--room-code; four letters or digits — config.js parseRoomCode);
 *   healthMetricsFactory: an injected sampler (tests); phaseMetrics: a phase recorder (server/phaseMetrics.js) whose
 *   window the 10 s sample rotates into `performance.phases` (loopback /healthz only)
 *   stateFile: the persistence path (a directory → the sharded layout, a .json path → the single file, 'off' → memory
 *   only — persist, 移植自用户分支); store: an explicit state store (tests; null = memory only, takes precedence over
 *   stateFile and SP_REDIS_URL); resume: false skips the startup restore (tests); saveMs: the save cadence;
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPluginRegistry>,
 *                     content: import('./plugins/identity.js').VanillaContent, visual: ReturnType<typeof createVisualSets>,
 *                     contents: ReturnType<typeof createContentSets>, hosts: ReturnType<typeof createMatchHosts>,
 *                     versions: ReturnType<typeof createVersionSets>, versionHosts: ReturnType<typeof createMatchHosts> | null,
 *                     traffic: ReturnType<typeof createTrafficCounter>, assetIndex: ReturnType<typeof createAssetIndex> | null,
 *                     views: ReturnType<typeof createManifestViews> | null, studio: ReturnType<typeof createStudio> | null,
 *                     healthMetrics: ReturnType<typeof createHealthMetrics> | null,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  // A release ignores external-AI settings (one log line) and keeps the built-in bot (§35.66).
  // An unknown strategy id still fails here, before data is loaded or the port is opened.
  const log = opts.log || makeLogger(!!opts.quiet);
  if (releaseIgnoresExternalAi()) noteLlmIgnored(log);
  try {
    const strategy = getBotStrategy(process.env.SP_BOT_STRATEGY);
    if (strategy.id === 'external') validateExternalConfig();
  } catch (cause) {
    throw new Error(`Invalid SP_BOT_STRATEGY: ${cause.message}. Unset SP_BOT_STRATEGY to use the original bot (legacy).`, { cause });
  }
  try {
    const seats = getBotStrategySeats(process.env.SP_BOT_STRATEGY_SEATS);
    if (Object.values(seats).some((s) => s.id === 'external')) validateExternalConfig();
  } catch (cause) {
    throw new Error(`Invalid SP_BOT_STRATEGY_SEATS: ${cause.message}. Unset SP_BOT_STRATEGY_SEATS to use SP_BOT_STRATEGY for every seat.`, { cause });
  }
  const { port, host } = listenAddress(opts);
  const { publicDir, dataDir, sharedDir, packsDir, pluginsDir } = serveDirs(opts);
  const simDir = path.join(ROOT, 'server', 'sim');

  // 局内聊天 (合并自用户分支): SP_CHAT_ENABLED (server/moderation/chat.js chatEnabled, 默认关); 开着时先初始化
  // 敏感词引擎——缺密钥/词表在启动期就拒绝(never silently off), 而不是第一条聊天消息才炸。审计日志按天落
  // .state/chat-logs/(SP_CHAT_LOG_DIR), 压缩与保留窗 SP_CHAT_LOG_COMPRESS_AFTER_DAYS / SP_CHAT_LOG_RETENTION_DAYS。
  // 构造在一切监听/线程之前: 目录布局非法(SP_CHAT_LOG_DIR 落在被服务的目录里)这里就抛, 没有任何资源要回收。
  const chatEnabledOpt = opts.chatEnabled ?? chatEnabled();
  if (chatEnabledOpt) initializeModeration();
  const chatLog = new ChatLog({ dir: opts.chatLogDir ?? process.env.SP_CHAT_LOG_DIR,
    compressAfterDays: opts.chatLogCompressAfterDays ?? process.env.SP_CHAT_LOG_COMPRESS_AFTER_DAYS,
    retentionDays: opts.chatLogRetentionDays ?? process.env.SP_CHAT_LOG_RETENTION_DAYS,
    publicDirs: [publicDir, dataDir, sharedDir, packsDir], log });

  // The three boot loads over independent trees start together (server/data.js, server/plugins/identity.js,
  // server/versions.js): the data tables, the sim/shared content bytes and the versions' files are read
  // concurrently instead of one after another, and the plugin scan below runs while those reads are in flight.
  // Every consumer waits in the old order, so the results — values, log lines, per-file warnings — are the ones
  // the sequential boot produced (none of the three throws at the read level; failures are warned per file).
  const versionCfg = versionsFrom(opts, log);
  /** data/*.json bytes, read once and shared by the data load and the content hash */
  const reads = new Map();
  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const dataReady = opts.dataDir ? loadDataAsync(dataDir, { log, reads }) : preloadData({ dir: dataDir, log, reads });
  // the vanilla content hash `cs` (DESIGN §32): the bytes of the served sim, shared code and game data, read once now —
  // like the data the matches use and the build tag below
  const contentReady = computeVanillaContentAsync({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log, reads });
  const versionBytesReady = preloadVersionFiles({ enabled: versionCfg.enabled, dataDir });
  // language packs and plugins (docs/PACKS.md, docs/PLUGINS.md): scanned now — the start log names them — and again
  // whenever their folders change
  const scriptMode = process.env.SP_PLUGIN_SCRIPTS;
  const packs = createPluginRegistry({ publicDir, dataDir, packsDir, pluginsDir }, { log, scriptHost:host, scriptMode });
  packs.refresh(true);
  // The script probes warm in the background (server/plugins/scriptPreflight.js warmupScriptProbes): the first room
  // that builds a set with a script plugin then finds the report cached instead of paying the probe child on the
  // message path. Never awaited — boot does not wait for a child — and every failure is caught inside. Re-warmed once
  // the script host is bound (a trust-gated script plugin only loads then) and after every rescan (an install, a
  // changed folder): the per-key cache and the in-flight dedup make a repeat free.
  warmupScriptProbes(packs, log);
  packs.onScan(() => warmupScriptProbes(packs, log));
  const data = await dataReady;
  const content = await contentReady;
  log.info(`[content] vanilla ${content.cs.slice(0, 16)} (${Object.keys(content.simFiles).length} code files, ${Object.keys(content.data).length} data files)`);
  // the content hashes of the art (built in the background once listening) and the manifests served with them —
  // 不再构建(用户分支的预载/CDN 缓存体系取代了它,见上方的 import 说明): assetIndex 与 views 保持 null,
  // /healthz 的 assetHashes 报告 null,清单由静态层按 CDN/发布语义改写后原样送出。
  const assetIndex = null;
  const views = null;
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
  // the official versions (DESIGN §35.23, M1): which ones (the option, else SP_VERSIONS …), their content, and — only
  // when one beyond 第二期下半 is enabled — the match hosts their rooms play in (counted apart from the plugin hosts)
  const versions = createVersionSets({ enabled: versionCfg.enabled, defaultId: versionCfg.default, dataDir, vanilla: content, defaultData: data, log, reads: await versionBytesReady });
  // (the test options of matchHost apply to both pools, but never the version pool's kind or its own SP_MAX_VERSION_HOSTS)
  const versionHosts = versions.nonDefault.length
    ? createMatchHosts({ contents: versions, log, options: { transport, ...(opts.matchHost || {}), kind: 'version', maxWorkers: Math.max(1, versionCfg.maxHosts) } })
    : null;
  log.info(`[versions] enabled: ${versions.ids.map((id) => `${id} (${t(/** @type {any} */ (versionById(id)).label)}${id === versions.defaultId ? ', default' : ''})`).join(', ')}`);
  // The pool clones a subset into every thread (server/data.js simWorkerData): the sim's data only, not the art
  // manifests / emotes / tuning the worker tasks never read. Version rooms and plugin rooms never submit here
  // (match/rehearsal.js poolRehearsal), so the default pack is always what a worker sees.
  const simPool = createRoomWorkerPool({ data: simWorkerData(data) });
  log.info(simPool
    ? `[workers] simulation pool: ${simPool.stats().size} thread(s) (SP_WORKERS; 0 disables it)`
    : '[workers] simulation pool: off (SP_WORKERS=0)');
  const { registry, lobby, network } = createSessionStack({ ...opts, chatEnabled: chatEnabledOpt }, { data, log, content, plugins: roomSets, hosts, versions, versionHosts, simPool, chatLog });

  // 持久化 (server/persist.js + server/stateFile.js, 移植自用户分支): 会话/房间/运行中对局的检查点落盘, 重启恢复。
  // SP_STATE_FILE(目录 → 分片布局, .json 路径 → 单文件, 'off' → 纯内存, 默认 .state/server-<PORT>); 配了
  // SP_REDIS_URL / REDIS_URL 则改用 Redis 多键后端(server/redisState.js)且不再写文件; 配了 SP_VALKEY_URL 则改用
  // Valkey 后端(server/valkeyState.js, 零依赖 RESP 客户端, 合并自 Stardust fork)。启动读失败先不写
  // (Persister.deferLoad), 每轮写之前重读, 绝不覆盖没读回来的存档。
  const stateFileRaw = opts.stateFile !== undefined ? opts.stateFile : process.env.SP_STATE_FILE;
  const stateFile = typeof stateFileRaw === 'string' && stateFileRaw.trim() === ''
    ? (() => { log.warn('[persist] SP_STATE_FILE 为空，改用默认路径 .state/server-<PORT>；要内存运行请显式写 off'); return path.join(ROOT, '.state', `server-${process.env.PORT || 3000}`); })()
    : (typeof stateFileRaw === 'string' ? stateFileRaw.trim() : stateFileRaw);
  if (stateFile && stateFile !== 'off') {
    const absoluteState = path.resolve(stateFile);
    for (const root of [publicDir, dataDir, sharedDir]) {
      if (within(root, absoluteState)) throw new Error('SP_STATE_FILE 不能位于公开静态目录，建议使用 .state/ 或私有数据目录');
    }
  }
  // 可选存储后端（server/valkeyState.js）：SP_PERSIST_BACKEND=valkey|redis|file 显式指定；缺省自动——
  // SP_VALKEY_URL → Valkey（零依赖 RESP 客户端），SP_REDIS_URL / REDIS_URL → Redis，都没配 → 文件（默认，行为不变）。
  // 可选后端连不上就退回内存运行，不自动回退文件（同一份状态悄悄写两处比停下来更糟）。
  const backendEnv = opts.env ?? process.env;
  const backend = opts.store === undefined ? resolvePersistBackend(backendEnv) : null;
  const valkeyStore = backend === 'valkey' ? createValkeyStore({ env: backendEnv, log }) : null;
  const redisStore = opts.store === undefined && backend === 'redis' ? createRedisStore({ env: backendEnv, log }) : null;
  const store = opts.store !== undefined ? opts.store : valkeyStore ?? redisStore ?? (stateFile && stateFile !== 'off'
    ? new FileStateStore({ file: stateFile, log }) : null);
  if (backend === 'valkey' && !valkeyStore) log.warn('[persist] SP_PERSIST_BACKEND=valkey 但 SP_VALKEY_URL 未配置，退回文件后端');
  if (valkeyStore) log.info(`[persist] Valkey 存储 ${valkeyStore.label}（键 ${valkeyStore.prefix}index / runtime / cp:<房间码>）`);
  else if (redisStore) log.info(`[persist] Redis 存储 ${redisStore.label}（键 ${redisStore.prefix}index / runtime / cp:<房间码>）`);
  else if (store) log.info(`[persist] 状态文件 ${store.label}`);
  const persister = store ? new Persister({ store, registry, lobby, log, saveMs: opts.saveMs ?? process.env.SP_STATE_SAVE_MS }) : null;
  if (store && opts.resume !== false) {
    try {
      const doc = await store.load();
      // 启动读失败（存储没起来 / 内容不是状态文档）：先别写，否则会把没读回来的那份覆盖掉。
      if (!doc && ['unavailable', 'invalid'].includes(store.loadState)) {
        persister.deferLoad();
        log.warn(`[persist] 存档未能读取（${store.loadState}）：在读到之前不会写回，避免覆盖`);
      }
      if (doc) {
        const stats = await restoreServerForBoot({ doc, registry, lobby, log });
        if (!stats.ok) throw new Error(`状态格式不兼容 (${stats.reason})，已保留状态文件，请恢复备份或显式选择新的 SP_STATE_FILE`);
        log.info(`[persist] restored ${stats.sessions} sessions, ${stats.rooms} rooms, ${stats.matches} matches`);
      }
    } catch (err) {
      await persister?.dispose().catch(() => {});
      try { await store.close(); } catch { /* the boot already failed */ }
      throw err;
    }
  }
  // 运维公告（server/announcement.js，合并自用户分支; 单源）: 一份热加载的排程文件（http/config.js
  // announcementOptionsFrom，默认 config/announcements.json）。读函数同时服务 GET /api/announcement
  // 与 pong 里的 revision 提示（net.js）。
  const announcementOptions = announcementOptionsFrom(opts);
  const readAnnouncement = createAnnouncementReader({ ...announcementOptions, log });
  network.announcementRevision = createAnnouncementSignal(readAnnouncement);
  log.info(`[announcement] ${announcementOptions.source} ${announcementOptions.filePath ?? '(none)'}`);
  // Main-thread event-loop delay sampling (server/health/eventLoop.js): opt-in with SP_LOOP_SAMPLE=1, no worker pool involved, and a
  // LOCAL log line per window (`[loop] p50=… p95=… p99=… max=… cpu=… mem=… rooms=… humans=… phase=…`) — deliberately not
  // part of /healthz. This is what tells an operator whether a stall is the rehearsal / battle slice or something else.
  const eventLoop = createEventLoopMonitor({
    log,
    windowMs: opts.loopSample?.windowMs,
    counts: () => {
      const s = lobby.stats();
      const phases = new Set();
      let rehearsals = 0;
      for (const room of lobby.rooms.values()) {
        if (room.match?.phase) phases.add(room.match.phase);
        rehearsals += room.match?._rehearsalTasks?.size || 0;
      }
      return { rooms: s.rooms, matches: s.matches, humans: s.humans, spectators: s.spectators,
        phase: [...phases].sort().join('+') || 'idle', rehearsals,
        // the hall's delegated-rehearsal counters (lobby.rehearsalStats): the [loop] line's `rehe=d/a/t pool=p/a/f`
        rehearsal: lobby.rehearsalStats?.() || null };
    },
  });
  // 资源 CDN 与分包预载（移植自用户分支，xinhai 系 static.js 的配套接线）：
  // SP_ASSETS_CDN 未配置时全部为空值，static.js 按原站同源模式工作。
  // The per-file art manifest (`.assets-manifest.json`, generated on the publishing machine by
  // tools/r2-sync.mjs or from local art by tools/build-assets-manifest.mjs; not in Git)
  // supersedes the release-tag lookup: with it, art URLs carry a per-file `?v=` query and no version is
  // needed. Without it the legacy chain applies — the repo's `.assets-cdn-version` (travels with
  // `git pull`), then the CDN's own `/_v/latest` publication — and a CDN without either simply stays
  // unversioned.
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
  const resourcePackRoutes = parseResourcePackRoutes(opts.resourcePackRoutes ?? process.env.SP_RESOURCE_PACK_ROUTES ?? DEFAULT_RESOURCE_PACK_ROUTES);
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, simDir, packsDir, pluginsDir, packs, content, log, visual, contents, versions,
    cdnBase: parseAssetCdn(cdn.base || cdnBase), dataCdnBase: parseAssetCdn(opts.dataCdn ?? process.env.SP_DATA_CDN),
    resourcePackRoutes,
    assetsManifest });
  // the plugin studio (DESIGN §32.9): its page and API for this machine and the local network; it watches plugins/ only
  // once it is used (hot reload), and rooms whose host is the author or alone follow a plugin's changes by themselves
  const studio = opts.studio === false ? null : createStudio({ publicDir, pluginsDir, dataDir, registry: packs, lobby, sessions: registry, log, fetch: opts.fetch });
  const trustedRuntime = await createTrustedRuntime({registry:packs,log});
  lobby.trustedRuntime = trustedRuntime;
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag(ROOT, { servedVersionDirs: versions.servedDirs() });

  const traffic = createTrafficCounter();
  // 门禁 (server/http/gate.js, 2026-11-03): one shared password in front of every remote client — HTTP pages, data,
  // assets and the /ws upgrade alike; loopback and the private network skip it unless SP_GATE_LOCAL=0. Off when no
  // password is configured (`gate: false` disables even an environment one).
  const gate = opts.gate === false ? null : gateFrom(opts, process.env, log);
  // 只读性能采样器 (server/healthMetrics.js, 移植自 Stardust fork): 主线程 CPU/ELU/内存/事件循环延迟的 10 s 缓存,
  // 只随 ?traffic=1 进 /healthz 的 `performance` 块 (routes.js 的回环/私网门控);不与 Worker/对局进程通信。
  let healthMetrics = null;
  const server = http.createServer(createRequestHandler({ serveStatic, csp: process.env.SP_CSP === 'off' ? null : siteCsp(publicDir, serveStatic.transformPage, cdn.base, resourcePackRoutes), health: { startedAt, network, registry, lobby, content, traffic, assetIndex, views, trusted:trustedRuntime?.health, versions, versionHosts, serveStatic, chatLog, persister, store, getHealthMetrics: () => healthMetrics }, log, trustProxy: network.opts.trustProxy, studio, trustedRuntime, gate,
    readAnnouncement, announcementSource: announcementOptions.source }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, traffic, gate, trustProxy: network.opts.trustProxy });

  // The address actually bound. The default may fall back to IPv4; the returned host and url follow that.
  let boundHost;
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
    // Check the kernel's address too: aliases/DNS and bind fallback cannot weaken the owner gate.
    const actual = server.address();
    const scriptHost = actual && typeof actual === 'object' ? actual.address : '';
    packs.setScriptHost(scriptHost);
    warmupScriptProbes(packs, log); // a script plugin the bind just admitted (trust gate): probed off the message path now
    const testGate = lobby.setTestHost(scriptHost);
    if (testGate.warn) log.warn(`[test-mode] ${testGate.warn}`);
    else if (testGate.enabled) log.info('[test-mode] test rooms enabled');
    if (!trustedHostAllowed(scriptHost, scriptMode)) {
      lobby.trustedRuntime = null;
      await trustedRuntime?.close();
    }
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    try { healthMetrics?.dispose(); } catch { /* diagnostic only */ }
    hosts.close();
    versionHosts?.close();
    assetIndex?.close();
    studio?.close();
    packs.close();
    eventLoop?.close();
    await simPool?.close();
    await trustedRuntime?.close();
    await persister?.dispose().catch(() => {});
    try { await store?.close(); } catch { /* the boot already failed */ }
    try { await chatLog.close(); } catch { /* the boot already failed */ }
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));
  assetIndex?.start();
  chatLog.start();
  // the save loop starts with the listener: its first round then holds the real, bound server
  persister?.start();
  // started only once the server is listening: the first window then reports real counts, not a half-built hall
  eventLoop?.start();
  // the performance sampler starts with the listener for the same reason (healthMetrics.js); a broken start never
  // keeps the server from serving (the sampler degrades to `unavailable`)
  try {
    healthMetrics = (opts.healthMetricsFactory ?? createHealthMetrics)(opts.phaseMetrics ? { log, phases: opts.phaseMetrics } : { log });
    healthMetrics.start();
  } catch (e) {
    try { healthMetrics?.dispose(); } catch { /* diagnostic only */ }
    healthMetrics = null;
    try { log.warn?.(`[health] performance metrics unavailable: ${e.message}`); } catch { /* diagnostic only */ }
  }

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${displayHost(boundHost)}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { healthMetrics?.dispose(); } catch (e) {
        try { log.warn?.('[health] performance disposal failed', e); } catch { /* diagnostic only */ }
      }
      // the final state document is written BEFORE the lobby disposes its rooms (移植自用户分支的关停次序):
      // a drain that fails on the way out is logged, and the shutdown still reaches the persister
      if (persister) {
        let saved = false;
        try { saved = await persister.shutdown('shutdown'); }
        catch (e) { log.error('[shutdown] persistence', e); }
        if (!saved) log.error('[persist] final state was NOT saved; check the state directory permissions and disk space');
      }
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      try { hosts.close(); } catch (e) { log.error('[shutdown] match hosts', e); }
      try { versionHosts?.close(); } catch (e) { log.error('[shutdown] version hosts', e); }
      // after the lobby: every room is gone, so no rehearsal can still be waiting on a thread
      try { await simPool?.close(); } catch (e) { log.error('[shutdown] simulation pool', e); }
      eventLoop?.close();
      network.close();
      assetIndex?.close();
      studio?.close();
      packs.close();
      await trustedRuntime?.close();
      try { await chatLog.close(); } catch (e) { log.error('[shutdown] chat log', e); }
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
      try { await store?.close(); } catch (e) { log.error('[shutdown] state store', e); }
    })();
    return closing;
  }

  return { port: actualPort, host: boundHost, url, server, wss, lobby, network, registry, packs, content, visual, contents, hosts, versions, versionHosts, traffic, assetIndex, views, studio, gate, eventLoop, simPool, chatLog, store, persister, healthMetrics, close };
}

/**
 * The `--room-code ABCD` / `--room-code=ABCD` argument of this process entry, or null when it is absent. The value is
 * read once at startup and lives only in this server instance: there is no environment variable and nothing is
 * persisted, so stopping the server and starting it again without the argument is random again. A missing or invalid
 * value throws (the boot helper reports it and exits) instead of silently starting random.
 * @param {string[]} [argv]
 * @returns {string | null}
 */
export function roomCodeFromArgv(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room-code') {
      const v = argv[i + 1];
      if (v == null || v.startsWith('-') || !v.trim()) throw new RangeError('--room-code needs 4 letters or digits');
      return parseRoomCode(v);
    }
    if (a.startsWith('--room-code=')) {
      const v = a.slice('--room-code='.length);
      if (!v.trim()) throw new RangeError('--room-code needs 4 letters or digits');
      return parseRoomCode(v);
    }
  }
  return null;
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
// The state file defaults to .state/server-<PORT> (persist, 移植自用户分支); SP_STATE_FILE / SP_REDIS_URL override.
if (isProcessEntry(import.meta.url)) runMain(() => startServer({ roomCode: roomCodeFromArgv(), stateFile: process.env.SP_STATE_FILE ?? path.join(ROOT, '.state', `server-${process.env.PORT || 3000}`) }));
