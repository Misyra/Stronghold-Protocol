// server/http/config.js — where the server's settings come from. startServer() options win over the environment:
//
//   * PORT (default 3000), HOST (default '::', one dual-stack socket for IPv6 and IPv4);
//   * TRUST_PROXY ('auto' default: honour CF-Connecting-IP / X-Real-IP / X-Forwarded-For only from loopback/private
//     peers such as a local cloudflared; '1' always; '0' never) → net.js trustProxy;
//   * DEBUG → the console logger's debug level;
//   * the served directories (public/, data/, shared/, the content packs packs/ and the plugins plugins/ of this
//     repository unless the options name others), and which startServer() options are handed on to net.js Network
//     and lobby.js Lobby.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOM_LIMIT_OPTIONS } from '../roomConfig.js';
import { PORTAL_ROOM_MODES } from './portalRoom.js';

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** startServer() options handed on to net.js Network / lobby.js Lobby (an absent one keeps that module's default). */
const NET_OPTION_KEYS = ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
  'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy'];
const LOBBY_OPTION_KEYS = ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs'];

/**
 * Bind address used when neither the `host` option nor `HOST` says otherwise: one dual-stack socket, so the server
 * answers IPv6 and IPv4 alike without a second listener (Node keeps `ipv6Only` off for `::`).
 * `HOST=0.0.0.0` still means IPv4 only, `HOST=127.0.0.1` still means loopback only (a reverse proxy in front).
 */
export const DEFAULT_BIND_HOST = '::';

// The probe writes public notice content here; the game never writes this directory.
export const DEFAULT_AGENT_ANNOUNCEMENT_FILE = process.platform === 'win32'
  ? path.join(ROOT, '.state', 'announcement.json') : '/var/lib/stronghold-announcement/announcement.json';

/**
 * 站点 ID（§47.3）。统一的 `SP_SITE_ID` 是唯一的站点身份：公告（panel 源）与房间分享都从它取站点，
 * 用两个不同的 ID 意味着「公告写到 A 站、房间登记到 B 站」，而两边都不会报错 —— 只会安静地各干各的。
 * 所以旧的 `SP_PORTAL_SITE_ID` 只当兼容别名，**同时出现且不同就拒绝启动**。
 * 显式的 startServer() 选项优先（它就是程序配置），这里不跟它对账。
 * @param {{ siteId?: string, announcementSiteId?: string, portalSiteId?: string }} opts
 * @param {Record<string, string | undefined>} env
 */
export function siteIdFrom(opts = {}, env = process.env) {
  const explicit = opts.siteId ?? opts.announcementSiteId ?? opts.portalSiteId;
  if (explicit != null && explicit !== '') {
    if (!/^[a-z0-9-]{1,40}$/.test(explicit)) throw new RangeError('SP_SITE_ID must be 1..40 characters of [a-z0-9-]');
    return explicit;
  }
  const primary = env.SP_SITE_ID, alias = env.SP_PORTAL_SITE_ID;
  if (primary && alias && primary !== alias)
    throw new RangeError('SP_SITE_ID and SP_PORTAL_SITE_ID are both set and differ: the announcement and the room share must use one site id');
  const value = primary || alias;
  if (value == null || value === '') return null;
  if (!/^[a-z0-9-]{1,40}$/.test(value)) throw new RangeError('SP_SITE_ID must be 1..40 characters of [a-z0-9-]');
  return value;
}

/**
 * The default source is the managed probe file. Explicit feed URLs remain compatible.
 * @param {{ announcementSource?: string, announcementFile?: string, announcementAgentFile?: string, announcementPollMs?: number,
 * announcementSiteId?: string, announcementPortalUrl?: string, announcementUrl?: string }} opts
 * @param {Record<string, string | undefined>} env
 */
export function announcementOptionsFrom(opts = {}, env = process.env) {
  const explicitUrl = opts.announcementUrl || env.SP_ANNOUNCEMENT_URL;
  const source = opts.announcementSource ?? env.SP_ANNOUNCEMENT_SOURCE ?? (explicitUrl ? 'panel' : 'agent');
  if (!['agent', 'panel', 'file'].includes(source)) throw new RangeError('SP_ANNOUNCEMENT_SOURCE must be agent, panel or file');
  const filePath = path.resolve(ROOT, source === 'agent'
    ? opts.announcementAgentFile ?? env.SP_ANNOUNCEMENT_AGENT_FILE ?? DEFAULT_AGENT_ANNOUNCEMENT_FILE
    : opts.announcementFile ?? env.SP_ANNOUNCEMENT_FILE ?? 'announcement.json');
  const pollMs = opts.announcementPollMs ?? Number(env.SP_ANNOUNCEMENT_POLL_MS || 10000);
  if (!Number.isFinite(pollMs)) throw new RangeError('invalid SP_ANNOUNCEMENT_POLL_MS');
  if (source !== 'panel') return { filePath, pollMs, announcementUrl: null, source: { mode: source, siteId: null } };
  let url;
  if (explicitUrl) url = new URL(explicitUrl);
  else {
    const siteId = siteIdFrom(opts, env);
    if (!siteId) throw new RangeError('panel source requires a valid SP_SITE_ID or SP_ANNOUNCEMENT_URL');
    const portal = opts.announcementPortalUrl ?? env.SP_PORTAL_URL;
    if (!portal) throw new RangeError('panel source requires SP_PORTAL_URL or SP_ANNOUNCEMENT_URL');
    url = new URL('/api/announce/v1/' + siteId, portal);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new RangeError('announcement URL must be HTTP(S) without credentials or a fragment');
  }
  return { filePath, pollMs, announcementUrl: url.href,
    source: { mode: 'panel', siteId: /^\/api\/announce\/v1\/([a-z0-9-]{1,40})$/.exec(url.pathname)?.[1] ?? null } };
}

/**
 * Where to listen: the `port` / `host` options, else PORT / HOST, else port 3000 on DEFAULT_BIND_HOST.
 * An empty host is treated as unset.
 * @param {{ port?: number, host?: string }} opts
 * @returns {{ port: number, host: string }}
 * @throws {RangeError} when the port is not an integer in 0…65535
 */
export function listenAddress(opts) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = (opts.host || process.env.HOST) || DEFAULT_BIND_HOST;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  return { port, host };
}

/**
 * The hosts to try, in order, for a bind. Only the default is retried: a host with IPv6 switched off refuses `::`
 * with EAFNOSUPPORT / EADDRNOTAVAIL / EINVAL, and falling back to IPv4 beats not booting. An explicit HOST is literal.
 * @param {string} host a host out of listenAddress()
 * @returns {string[]}
 */
export function bindCandidates(host) {
  return host === DEFAULT_BIND_HOST ? [DEFAULT_BIND_HOST, '0.0.0.0'] : [host];
}

/**
 * The directories the static server reads (packsDir: the pack folders, pluginsDir: the plugin folders —
 * server/plugins/registry.js; default: the plugins/ folder beside packsDir, so a server given its own packs folder —
 * a test — never reads this checkout's plugins).
 * @param {{ publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, pluginsDir?: string }} opts
 */
export function serveDirs(opts) {
  const packsDir = opts.packsDir || path.join(ROOT, 'packs');
  return {
    publicDir: opts.publicDir || path.join(ROOT, 'public'),
    dataDir: opts.dataDir || path.join(ROOT, 'data'),
    sharedDir: opts.sharedDir || path.join(ROOT, 'shared'),
    packsDir,
    pluginsDir: opts.pluginsDir || path.join(path.dirname(path.resolve(packsDir)), 'plugins'),
  };
}

/** net.js Network options out of the startServer() options; `trustProxy` falls back to TRUST_PROXY. */
export function netOptionsFrom(opts) {
  const netOptions = {};
  for (const k of NET_OPTION_KEYS) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  return netOptions;
}

/** lobby.js Lobby options out of the startServer() options. */
export function lobbyOptionsFrom(opts, env = process.env) {
  const lobbyOptions = {};
  for (const k of LOBBY_OPTION_KEYS) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  for (const [key, [name, fallback, min, max]] of Object.entries(ROOM_LIMIT_OPTIONS)) {
    const primary = key === 'maxForeignSessionsPerIp' ? 'SP_IP_MAX_SESSIONS_PER_IP' : name;
    const value = Number(opts[key] ?? env[primary] ?? env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${primary} must be ${min}..${max}`);
    lobbyOptions[key] = value;
  }
  for (const [key, name] of [['allowBots', 'SP_ALLOW_BOTS'], ['limitForeignSessions', 'SP_FOREIGN_SESSION_LIMIT'],
    ['allowForeignConnections', 'SP_ALLOW_FOREIGN_CONNECTIONS']]) {
    const primary = key === 'limitForeignSessions' ? 'SP_IP_SESSION_LIMIT' : name;
    const value = String(opts[key] ?? env[primary] ?? env[name] ?? 'on').trim().toLowerCase();
    if (!['1', 'true', 'on', '0', 'false', 'off'].includes(value)) throw new RangeError(`${primary} must be on or off`);
    lobbyOptions[key] = ['1', 'true', 'on'].includes(value);
  }
  return lobbyOptions;
}

/** An absent secret disables private enumeration; reject weak/malformed configuration before startup. */
export function roomAdminTokenFrom(opts = {}, env = process.env) {
  const token = opts.roomAdminToken ?? env.SP_ROOM_ADMIN_TOKEN;
  if (token == null || token === '') return null;
  if (typeof token !== 'string' || !/^[!-~]{32,256}$/.test(token)) {
    throw new RangeError('SP_ROOM_ADMIN_TOKEN must contain 32..256 non-space ASCII characters');
  }
  return token;
}

/** 本机 Agent 地址允许的主机名。Docker 里分开部署时 127.0.0.1 并不互通（§47.3），首版只支持同宿主机回环。 */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * 游戏 → Agent 的本机地址（§47.3）。只允许回环上的 HTTP 根路径，且不得带用户名/密码/query/hash：
 * 这个地址是**启动配置**，浏览器永远不能指定它（§45.1），所以配置错了必须在启动时就说出来，而不是等到
 * 某个玩家点分享时才发现「原来填的是另一个站的域名」。
 * @param {string} value
 */
export function localAgentUrlFrom(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new RangeError('SP_PORTAL_AGENT_URL must be an absolute URL'); }
  if (url.protocol !== 'http:') throw new RangeError('SP_PORTAL_AGENT_URL must use http on loopback: the Agent is a local process');
  if (!LOOPBACK_HOSTS.includes(url.hostname))
    throw new RangeError('SP_PORTAL_AGENT_URL must point at a loopback address; game and Agent share the host (see §47.3 for containers)');
  if (url.username || url.password || url.search || url.hash)
    throw new RangeError('SP_PORTAL_AGENT_URL must not carry credentials, a query or a fragment');
  if (url.pathname !== '/') throw new RangeError('SP_PORTAL_AGENT_URL must be the root path: the bridge path is fixed');
  return url.href;
}

/**
 * 房间分享的三种模式（§45.1 / §46.3 / §47.3），解析成 createPortalRoomHandler 的那组选项。
 *
 *   off          —— 显式关掉。**不看**其它变量：一个曾经配好的站点把模式改成 off 之后，不该因为它还留着
 *                   旧的密钥而报「配置无效」。
 *   legacy-http  —— 游戏自己带 HMAC 签名直连中央的老路。不写模式时按「HMAC 三项齐不齐」判定，于是旧部署
 *                   升级这个版本以后行为完全不变。
 *   agent        —— 走本机 Agent 的桥接口。这种模式**不需要**中央 URL，也不需要旧 HMAC key：游戏不再
 *                   持有任何能代表本站改写公告/配置/关房的东西（§38.2 凭据分离）。
 *
 * @param {{ portalRoomMode?: string, portalUrl?: string, portalSiteId?: string, portalRoomKey?: string,
 *   portalAgentUrl?: string, portalBridgeToken?: string, siteId?: string, announcementSiteId?: string,
 *   roomAdminToken?: string }} opts
 * @param {Record<string, string | undefined>} env
 */
export function portalRoomOptionsFrom(opts = {}, env = process.env) {
  const siteId = siteIdFrom(opts, env);
  const url = opts.portalUrl ?? env.SP_PORTAL_URL ?? null;
  const key = opts.portalRoomKey ?? env.SP_PORTAL_ROOM_KEY ?? null;
  const agentUrl = opts.portalAgentUrl ?? env.SP_PORTAL_AGENT_URL ?? null;
  const bridgeToken = opts.portalBridgeToken ?? env.SP_PORTAL_BRIDGE_TOKEN ?? null;
  const raw = opts.portalRoomMode ?? env.SP_PORTAL_ROOM_MODE;
  const text = raw == null ? '' : String(raw).trim().toLowerCase();
  if (text && !PORTAL_ROOM_MODES.includes(text))
    throw new RangeError('SP_PORTAL_ROOM_MODE must be off, legacy-http or agent');
  // 「不写模式」时按**分享专用**的那几个变量判定：分享密钥，或者那个只为分享存在的旧站点别名。
  // `SP_PORTAL_URL` 不算信号 —— 它同时是公告 panel 源的基址，把它当信号会让一个只发送公告的站点直接启动
  // 失败（或者更糟：以为自己在分享，其实缺密钥）。
  const legacySignal = key || opts.portalSiteId || env.SP_PORTAL_SITE_ID;
  const mode = text || (legacySignal ? 'legacy-http' : 'off');
  if (mode === 'off') return { mode, url: null, siteId: null, key: null, agentUrl: null, bridgeToken: null };
  if (mode === 'legacy-http') {
    if (!url || !siteId || !key || !/^[a-f0-9]{64}$/.test(key))
      throw new RangeError('legacy-http share mode requires SP_PORTAL_URL, SP_SITE_ID and a 64-hex SP_PORTAL_ROOM_KEY');
    let base;
    try { base = new URL(url); } catch { throw new RangeError('SP_PORTAL_URL must be an absolute URL'); }
    if (base.username || base.password || base.search || base.hash)
      throw new RangeError('SP_PORTAL_URL must not carry credentials, a query or a fragment');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK_HOSTS.includes(base.hostname)))
      throw new RangeError('SP_PORTAL_URL must use HTTPS (HTTP allowed on loopback only)');
    return { mode, url, siteId, key, agentUrl: null, bridgeToken: null };
  }
  if (!agentUrl || !bridgeToken)
    throw new RangeError('agent share mode requires SP_PORTAL_AGENT_URL and SP_PORTAL_BRIDGE_TOKEN');
  // 桥接凭据是一把独立凭据（§38.2）：它只能读写在 Agent 手里的分享入口。与游戏自己的管理令牌相同意味着
  // 「拿到分享凭据就等于拿到关房/改配置的资格」，而那正是 agent 模式要避免的事。
  if (!/^[!-~]{32,256}$/.test(bridgeToken))
    throw new RangeError('SP_PORTAL_BRIDGE_TOKEN must be 32..256 non-space ASCII characters');
  const adminToken = opts.roomAdminToken ?? env.SP_ROOM_ADMIN_TOKEN;
  if (adminToken && adminToken === bridgeToken)
    throw new RangeError('SP_PORTAL_BRIDGE_TOKEN must differ from SP_ROOM_ADMIN_TOKEN: separate credentials (see §38.2)');
  return { mode, url: null, siteId, key: null, agentUrl: localAgentUrlFrom(agentUrl), bridgeToken };
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

/** The console logger (`quiet` → silent; debug lines only with DEBUG set). */
export function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}
