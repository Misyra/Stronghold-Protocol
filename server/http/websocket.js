// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB, permessage-deflate (WS_DEFLATE / perMessageDeflateFor)
//     → Network.handleConnection. Refused at
//     the upgrade: any other path 404; disabled overseas access 403 with a JSON message;
//     per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.
//     SP_WS_COMPRESSION ('on' default; 'off' disables): small frames bypass zlib, dictionaries reset between
//     messages and each connection's deflate window is capped (this fork's bounded permessage-deflate).

import { chatEnabled } from '../moderation/chat.js';
import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS, clientAddress } from '../net.js';
import { ERR, ERR_TEXT } from '../../shared/constants.js';
import { NetDiagnostics } from '../netDiagnostics.js';
import { Lobby } from '../lobby.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';
import { parseIpSessionScope } from '../foreignSessions.js';
import { createWsUpgradeLimiter } from './wsUpgradeLimit.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/** SP_WS_ORIGINS: extra `host[:port]` values a browser may open the socket from (comma separated). */
export function parseWsOrigins(value) {
  return String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Browser origin gate for /ws (the address limits cannot see this: a foreign page spends its *visitor's* address).
 * A request without an Origin header is not a browser (a game client, a probe, a test) and is left to the limits
 * below. A browser must name this very host, or one SP_WS_ORIGINS allowlists; 'Origin: null' is refused.
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} extra allowlisted `host[:port]` values
 * @returns {boolean}
 */
export function wsOriginAllowed(req, extra = []) {
  const origin = req.headers.origin;
  if (origin == null || origin === '') return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  if (!host) return false;
  // The upgrade is forwarded with `Host $host`, which drops the port the browser typed (`wss://host:16657` →
  // `host: "host"`), so compare host names: another port on this very host is the same site, another name is not.
  const target = String(req.headers.host || '').toLowerCase();
  const bare = (h) => h.replace(/:\d+$/, '');
  if (host === target || bare(host) === bare(target)) return true;
  return extra.includes(host) || extra.includes(bare(host));
}

/** SP_WS_COMPRESSION env (or a boolean option) → enabled; reject typos before starting timers. */
export function parseWsCompression(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['', '1', 'true', 'on'].includes(s)) return true;
  if (['0', 'false', 'off'].includes(s)) return false;
  throw new RangeError(`invalid SP_WS_COMPRESSION ${v}; use on or off`);
}

/**
 * The bounded permessage-deflate config (see the header), or false when disabled.
 *
 * `WS_DEFLATE` holds the values shared with upstream 0.2.6 (threshold, no server context takeover, a 2 KB server
 * window, memLevel 7); this fork adds the level (1 instead of zlib's default 6 — measurably cheaper on a host whose
 * point is idleness), `clientNoContextTakeover` and a cap on concurrent zlib operations. The window is a small part
 * of what a connection costs: memLevel and the concurrency cap are the bulk of it, so 12 → 11 (matching upstream)
 * is a marginal saving, not a halving.
 * @param {boolean|string|undefined} option the SP_WS_COMPRESSION value
 */
export function perMessageDeflateFor(option) {
  const enabled = parseWsCompression(option);
  if (!enabled) return false;
  return {
    ...WS_DEFLATE,
    zlibDeflateOptions: { level: 1, memLevel: 7 },
    clientNoContextTakeover: true,
    concurrencyLimit: 4,
  };
}

/**
 * permessage-deflate (RFC 7692) for the JSON text frames. A message from 1 KB up (m.public, m.private, b.start, welcome
 * …) is compressed on its own — no context is kept from one message to the next (`serverNoContextTakeover`) — with a
 * 2 KB window (11 bits) and zlib memLevel 7; smaller frames (pong, ok) go out as they are. Measured upstream on a solo
 * session (rounds 3–5, the server's own counters, traffic.js): 173 KB of payload → 60 KB on the wire; replaying a
 * session's frames with larger windows gained nothing on these messages. Browsers negotiate it by themselves; a client
 * that offers none gets plain frames. The inflated size of a client frame still counts against WS_MAX_PAYLOAD.
 */
export const WS_DEFLATE = Object.freeze({
  threshold: 1024,
  serverNoContextTakeover: true,
  serverMaxWindowBits: 11,
  zlibDeflateOptions: Object.freeze({ memLevel: 7 }),
});

/**
 * Does every permessage-deflate offer of this `Sec-WebSocket-Extensions` header cap the server window below
 * `serverMaxWindowBits`? ws cannot accept such an offer and refuses the whole handshake (400), so the upgrade drops
 * the header instead and the connection goes uncompressed. No browser sends `server_max_window_bits`.
 * @param {string | string[] | undefined} header
 * @param {number} [serverMaxWindowBits] the window the server would negotiate (the effective config, not a constant)
 */
export function narrowDeflateOffer(header, serverMaxWindowBits = WS_DEFLATE.serverMaxWindowBits) {
  if (typeof header !== 'string') return false;
  const offers = header.split(',').map((s) => s.trim()).filter((s) => /^permessage-deflate\b/i.test(s));
  if (!offers.length) return false;
  return offers.every((offer) => {
    const m = /(?:^|;)\s*server_max_window_bits\s*=\s*"?(\d+)"?/i.exec(offer);
    return !!m && Number(m[1]) < serverMaxWindowBits;
  });
}

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object, chatLog?: import('../chatLog.js').ChatLog, content?: { cs: string } | null,
 *   plugins?: ReturnType<typeof import('../plugins/roomSets.js').createRoomSets> | null,
 *   hosts?: ReturnType<typeof import('../match/host/index.js').createMatchHosts> | null }} deps the game data the
 *   lobby's matches use, the logger, the private chat log, the vanilla content (server/plugins/identity.js: welcome /
 *   room.state content, BattleSpec cs), the room sets a room's host chooses from (room.setPlugins: visual and content
 *   sets), the match hosts a room with gameplay plugins plays in (DESIGN §32.6)
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log, chatLog, content = null, plugins = null, hosts = null }) {
  const enabled = chatEnabled(opts.chatEnabled ?? process.env.SP_CHAT_ENABLED);
  const netOptions = netOptionsFrom(opts);
  const ipSessionScope = parseIpSessionScope(opts.ipSessionScope ?? process.env.SP_IP_SESSION_SCOPE);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = { ...lobbyOptionsFrom(opts), chatEnabled: enabled };
  const diagnostics = new NetDiagnostics();
  try {
    const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, content, plugins, hosts, options: lobbyOptions, workerPool: opts.workerPool ?? null, chatLog, countryLookup: opts.countryLookup, rehearsalPressure: diagnostics.rehearsalPressure });
    const network = new Network({ registry, handler: lobby, log, options: netOptions, diagnostics, countryLookup: opts.countryLookup,
      ipSessionScope,
      foreignSessionsEnabled: () => lobby.opts.limitForeignSessions,
      foreignSessionsMaxPerIp: () => lobby.opts.maxForeignSessionsPerIp,
      allowForeignConnections: () => lobby.opts.allowForeignConnections });
    return { registry, lobby, network };
  } catch (error) {
    diagnostics.close();
    throw error;
  }
}

/**
 * Count a socket in the traffic counters (traffic.js): its wire bytes from now until it closes, the payload of every
 * message it sends (ws.send wrapped) and receives.
 * @param {import('ws').WebSocket} ws
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<typeof import('./traffic.js').createTrafficCounter>} traffic
 */
function meterSocket(ws, req, traffic) {
  const socket = req.socket;
  traffic.wsOpen(socket);
  const send = ws.send;
  ws.send = function meteredSend(data, ...rest) {
    traffic.wsSent(data);
    return send.call(this, data, ...rest);
  };
  ws.on('message', (data) => traffic.wsReceived(data));
  ws.once('close', () => traffic.wsClose(socket));
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, wsCompression?: boolean | string, wsOrigins?: string[], isIpBanned?: (req: import('node:http').IncomingMessage) => boolean, ipBans?: ReturnType<typeof import('./ipBans.js').createIpBanStore>, wsUpgradeLimits?: object, traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter> }} deps
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, wsCompression, wsOrigins = [], traffic = null, isIpBanned = () => false, ipBans, wsUpgradeLimits = {} }) {
  const allowUpgrade = createWsUpgradeLimiter({ ...wsUpgradeLimits, trustProxy: network.opts.trustProxy,
    ...(ipBans ? { banStore: ipBans } : {}) });
  // Small frames bypass zlib; reset dictionaries between messages and cap each connection's deflate window.
  const deflate = perMessageDeflateFor(wsCompression);
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: deflate, clientTracking: false });
  wss.on('connection', (ws, req) => {
    if (traffic) meterSocket(ws, req, traffic);
    network.handleConnection(ws, req);
  });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (isIpBanned(req)) { reject(403, 'Forbidden'); return; }
    if (!allowUpgrade(req)) { reject(403, 'Forbidden'); return; }
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    if (network.foreignConnectionDenied(clientAddress(req, network.opts.trustProxy))) {
      const body = JSON.stringify({ code: ERR.FOREIGN_CONNECTIONS_DISABLED, msg: ERR_TEXT.FOREIGN_CONNECTIONS_DISABLED });
      socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    if (!wsOriginAllowed(req, wsOrigins)) { reject(403, 'Forbidden'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    if (deflate && narrowDeflateOffer(req.headers['sec-websocket-extensions'], deflate.serverMaxWindowBits)) delete req.headers['sec-websocket-extensions'];
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
