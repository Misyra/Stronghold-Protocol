// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB, permessage-deflate only when SP_WS_COMPRESSION=on (WS_DEFLATE, the
//     preset of server/wsCompression.js; per-type allowlist in net.js) → Network.handleConnection. Refused at
//     the upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { resolveWsCompression } from '../wsCompression.js';
import { Lobby } from '../lobby.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/**
 * permessage-deflate (RFC 7692) for the JSON text frames, the preset SP_WS_COMPRESSION=on runs (DESIGN §37.138, the
 * server/wsCompression.js port of the Stardust fork). The window is KEPT from one message to the next (context
 * takeover, the ws default: the extension's `server_no_context_takeover` is not negotiated) at the full 32 KiB — the
 * state frames and the battle stream repeat most of their keys and values (bonds, players, shop), so a frame costs a
 * fraction of its standalone deflate; with the shared context even the small battle frames shrink several-fold for
 * little CPU, which per-message deflate could not. WHICH frames enter that context is not a byte-length threshold but
 * the per-type allowlist of server/wsCompression.js, applied at the send paths (net.js sendRaw / send): welcome
 * (credentials), error/ok/pong and every unknown type go out plain — they never touch the shared context.
 */
export const WS_DEFLATE = resolveWsCompression('on');

/**
 * The reference server window of narrowDeflateOffer, in bits: the zlib default a browser client gets (browsers offer
 * no `server_max_window_bits`, so the shared context runs at the full 15-bit / 32 KiB window).
 */
export const WS_DEFLATE_SERVER_WINDOW_BITS = 15;

/**
 * Does every permessage-deflate offer of this `Sec-WebSocket-Extensions` header cap the server window below
 * WS_DEFLATE_SERVER_WINDOW_BITS? With the preset unpinned, ws itself would accept such an offer as asked — but a
 * server window that small defeats the shared-context design (each frame then compresses against a 0.5–8 KiB history
 * for nearly full CPU), so the upgrade drops the header instead and the connection goes uncompressed. No browser
 * sends `server_max_window_bits`.
 * @param {string | string[] | undefined} header
 */
export function narrowDeflateOffer(header) {
  if (typeof header !== 'string') return false;
  const offers = header.split(',').map((s) => s.trim()).filter((s) => /^permessage-deflate\b/i.test(s));
  if (!offers.length) return false;
  return offers.every((offer) => {
    const m = /(?:^|;)\s*server_max_window_bits\s*=\s*"?(\d+)"?/i.exec(offer);
    return !!m && Number(m[1]) < WS_DEFLATE_SERVER_WINDOW_BITS;
  });
}

/** A per-network cap, as printed on boot ('unlimited' for 0). */
function perNetwork(n) { return n > 0 ? n : 'unlimited'; }

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object, content?: { cs: string } | null,
 *   plugins?: ReturnType<typeof import('../plugins/roomSets.js').createRoomSets> | null,
 *   hosts?: ReturnType<typeof import('../match/host/index.js').createMatchHosts> | null,
 *   simPool?: ReturnType<typeof import('../workers/roomPool.js').createRoomWorkerPool> | null,
 *   versions?: ReturnType<typeof import('../versions.js').createVersionSets> | null,
 *   versionHosts?: ReturnType<typeof import('../match/host/index.js').createMatchHosts> | null }} deps the game data the lobby's
 *   matches use, the logger, the vanilla content (server/plugins/identity.js: welcome / room.state content, BattleSpec
 *   cs), the room sets a room's host chooses from (room.setPlugins: visual and content sets), the match hosts a room with
 *   gameplay plugins plays in (DESIGN §32.6), the official versions and their match hosts (DESIGN §35.23)
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log, content = null, plugins = null, hosts = null, versions = null, versionHosts = null, simPool = null, chatLog = null }) {
  const netOptions = netOptionsFrom(opts, log);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts, log);
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, content, plugins, hosts, versions, versionHosts, simPool, chatLog, options: lobbyOptions });
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  // The caps in effect, printed once when the stack is built, so the deploy log states the configuration the server is
  // actually running with. A global cap of 0 is printed as 0 (it rejects every room / socket); a per-network 0 is
  // printed as "unlimited". `log` is the quiet-aware logger, so a test server stays silent.
  log.info(`[http] limits: rooms ${lobby.opts.maxRooms} (${perNetwork(lobby.opts.maxRoomsPerAddr)}/network), `
    + `matches ${perNetwork(lobby.opts.maxMatchesPerAddr)}/network, `
    + `sockets ${network.opts.maxConnections} (${perNetwork(network.opts.maxConnectionsPerAddr)}/network)`);

  lobby.network = network;
  return { registry, lobby, network };
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
 * @param {{ network: Network, log: object, traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *   wsCompression?: false | object }} deps `wsCompression`: the resolved permessage-deflate options
 *   (wsCompression.js resolveWsCompression), false: none; default the on-preset (startServer resolves SP_WS_COMPRESSION)
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, traffic = null, gate = null, wsCompression = WS_DEFLATE }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: wsCompression === false ? false : { ...wsCompression }, clientTracking: false });
  wss.on('connection', (ws, req) => {
    if (traffic) meterSocket(ws, req, traffic);
    network.handleConnection(ws, req);
  });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      // The client may never read our answer: end the handshake, then drop the TCP connection if it still lingers.
      const timer = setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } }, 1000);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    // 门禁 (server/http/gate.js): the upgrade carries the page's cookie; without it a script could join a gated server
    // through /ws alone. Local / private-network clients pass without one (gate.bypass) — and, as in gate.js, that is
    // decided by the real socket peer only: a forwarded address never grants the bypass.
    if (gate && !gate.check(req)) { reject(401, 'Unauthorized'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    if (narrowDeflateOffer(req.headers['sec-websocket-extensions'])) delete req.headers['sec-websocket-extensions'];
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
