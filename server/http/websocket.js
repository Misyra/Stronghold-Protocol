// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB → Network.handleConnection. Refused at the
//     upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.
//     SP_WS_COMPRESSION ('on' default; 'off' disables): small frames bypass zlib, dictionaries reset between
//     messages and each connection's deflate window is capped (this fork's bounded permessage-deflate).

import { chatEnabled } from '../moderation/chat.js';
import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/** SP_WS_COMPRESSION env (or a boolean option) → enabled; reject typos before starting timers. */
export function parseWsCompression(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['', '1', 'true', 'on'].includes(s)) return true;
  if (['0', 'false', 'off'].includes(s)) return false;
  throw new RangeError(`invalid SP_WS_COMPRESSION ${v}; use on or off`);
}

/**
 * The bounded permessage-deflate config (see the header), or false when disabled.
 * @param {boolean|string|undefined} option the SP_WS_COMPRESSION value
 */
export function perMessageDeflateFor(option) {
  const enabled = parseWsCompression(option);
  if (!enabled) return false;
  return {
    zlibDeflateOptions: { level: 1, memLevel: 7 },
    serverMaxWindowBits: 12,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    threshold: 1024,
    concurrencyLimit: 4,
  };
}

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object, chatLog?: import('../chatLog.js').ChatLog }} deps the game data, logger and private chat log
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log, chatLog }) {
  const enabled = chatEnabled(opts.chatEnabled ?? process.env.SP_CHAT_ENABLED);
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = { ...lobbyOptionsFrom(opts), chatEnabled: enabled };
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions, workerPool: opts.workerPool ?? null, chatLog });
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  return { registry, lobby, network };
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, wsCompression?: boolean | string }} deps
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, wsCompression }) {
  // Small frames bypass zlib; reset dictionaries between messages and cap each connection's deflate window.
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: perMessageDeflateFor(wsCompression), clientTracking: false });
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
  return wss;
}
