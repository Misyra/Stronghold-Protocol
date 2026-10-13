// server/net.js — WebSocket session layer (DESIGN §1, §8).
//
// Responsibilities:
//   * Session objects (playerId, secret reconnect token, name, bound socket, connection state) and the
//     SessionRegistry that resolves reconnect tokens and expires sessions after the reconnect window (10 min; the
//     lobby may extend it per session via `session.resumeWindowMs` — a solo run: 24 h, see server/lobby.js).
//   * Per-connection pipeline: token-bucket rate limit (40 msg/s) → JSON decode → schema validation
//     (shared/protocol.js) → `hello`/`ping` handling → dispatch to the lobby handler → `ok`/`error`
//     reply echoing the request id (`rid`). Intents whose answer is a large state resend (`g.watch` →
//     m.field) also draw from a second, much smaller bucket (2/s, burst 6), so one socket cannot turn
//     40 tiny requests per second into hundreds of KB/s of downstream traffic.
//   * Client address per connection (`clientAddress`): the socket peer, or — when the peer is a local
//     reverse proxy (loopback / private address, e.g. `cloudflared tunnel --url http://localhost:3000`) —
//     the address it forwards (CF-Connecting-IP, X-Real-IP, rightmost X-Forwarded-For). Its `key` (IPv4
//     address or IPv6 /64) is what per-network limits count against: concurrent sockets here
//     (`maxConnectionsPerAddr`, checked at upgrade time through `admission`), rooms and running matches
//     in server/lobby.js. Local / LAN peers without a forwarding header (dev machine, tests, LAN party)
//     have no key and are never limited per address.
//   * Heartbeat (ws ping/pong every `heartbeatMs`, dead sockets terminated), hello timeout.
//   * Send helpers that never throw, with a backpressure guard: non-critical `b.snap` frames are skipped
//     above 1 MiB queued; congested sockets pause gameplay writes and merge eligible pending states.
//     Reliable barriers retain FIFO order, with byte/frame limits triggering reconnect and full resync.
//
// Close codes used by the server (clients should NOT auto-reconnect on 4001):
//   4001 session replaced (the same token connected from another socket/tab)
//   4002 hello timeout
//   1008 abusive flooding (rate-limit drops > abuseDropsPerSec)
//   1001 server shutdown
//
// The handler object (implemented by server/lobby.js) receives:
//   onHello(session, { resumed, repeat })  after `welcome` was sent
//   welcomeInfo() → object (optional)      extra fields of every `welcome` (never one of its own keys): the lobby's
//                                          `diyKitted` (0.2.0 自选编队 — which operators a DIY slot may field)
//   onMessage(session, msg) → { ok: true } | { error: ERR code, detail?: string } | undefined
//   routeGame(session, msg) → same (optional): client-side combat reports `b.progress` / `b.result` (DESIGN §14) go
//                                          straight to the running match through it; without it they reach onMessage
//   onDisconnect(session)                  the session's socket closed (session kept for the reconnect window)
//   onExpire(session)                      the session was purged (disconnected longer than the window)

import { STRIP_RE, LONE_SURROGATE_RE } from './moderation/characters.js';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { NetDiagnostics, socketDiagnostics } from './netDiagnostics.js';
import { OutboundQueue } from './outboundQueue.js';
import { ENCODED, STATE_COALESCE } from './wireHints.js';
import { ForeignSessions, foreignSessionKey } from './foreignSessions.js';
export { ENCODED, STATE_COALESCE } from './wireHints.js';
import { isIP } from 'node:net';
import { C2S, validateC2S } from '../shared/protocol.js';
import { hasSensitiveNickname } from './moderation/nickname.js';
import { chatRetentionUntil, CHAT_MUTE_MAX_MS, CHAT_WINDOW_MS } from './moderation/chatState.js';
import { negotiateStateDelta, prepareStateFrame, reserveStateFrame, resetStateDelta } from './stateTransport.js';
import { ERR, ERR_TEXT, NAME_MAX_LEN, PROTOCOL_VERSION } from '../shared/constants.js';

/** Tunables (all overridable through the Network / SessionRegistry constructors). */
const PUMP_VISITS = 128;
const PUMP_MS = 2;

export const NET_DEFAULTS = Object.freeze({
  ratePerSec: 40,               // token bucket refill rate
  rateBurst: 40,                // token bucket capacity
  abuseDropsPerSec: 400,        // rate-limited messages within one second before the socket is closed (1008)
  heartbeatMs: 30_000,          // ping interval; a socket that missed one full interval is terminated
  helloTimeoutMs: 30_000,       // sockets that never say hello are closed (4002)
  reconnectWindowMs: 10 * 60_000, // disconnected sessions stay resumable this long
  snapDropBytes: 1 << 20,       // skip b.snap while bufferedAmount exceeds this
  hardBufferBytes: 16 << 20,    // terminate a socket whose send queue exceeds this
  maxQueuedFrames: 1024,       // also bound tiny reliable frames while a peer cannot drain
  backpressurePollMs: 25,      // blocked peers do not spin the setImmediate send pump
  maxConnections: 2000,         // concurrent sockets (enforced by index.js at upgrade time)
  maxConnectionsPerAddr: 64,    // concurrent sockets per client network key (0 = unlimited); see clientAddress
  maxSessions: 20_000,          // registry cap; oldest idle sessions are evicted first
  heavyPerSec: 2,               // refill of the bucket for resend-heavy intents (HEAVY_TYPES)
  heavyBurst: 6,
  trustProxy: 'auto',           // forwarding headers: 'auto' = from loopback/private peers only, true = always, false = never
});

/**
 * Intents that also draw from the per-connection heavy bucket: g.watch (its reply is a large state resend, m.field),
 * room.loadout (a ≤ 160-entry map and ≤ 256 operator settings validated against the game data; the client debounces its
 * edits), room.ownership
 * (a ≤ 160-id list, the same way), room.diy (≤ 8 自选 picks checked against the data, the same way) and room.spectate
 * (taking a spectator seat in a running match resends its state like a watcher's g.watch — server/lobby.js spectate)
 * and matchmaking.join (this fork's alliance queue). state.resync requests a full recovery through the same limits.
 */
export const HEAVY_TYPES = new Set(['g.watch', 'room.loadout', 'room.ownership', 'room.diy', 'matchmaking.join', 'room.matchmaking', 'room.spectate', 'state.resync']);

/** Close codes (see header). */
export const CLOSE = Object.freeze({ REPLACED: 4001, HELLO_TIMEOUT: 4002, POLICY: 1008, SHUTDOWN: 1001 });

const WS_OPEN = 1;
const MAX_RID = 2 ** 31;
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// Session & registry
// ---------------------------------------------------------------------------------------------------

/** One logical player identity; survives socket reconnects for the reconnect window. */
export class Session {
  /**
   * @param {{ playerId: string, token: string, name: string, now?: number }} init
   */
  constructor({ playerId, token, name, now = Date.now() }) {
    /** @type {string} public id, shared with other players */
    this.playerId = playerId;
    /** @type {string} secret 128-bit hex reconnect token (only ever sent to its owner) */
    this.token = token;
    /** @type {string} sanitized nickname */
    this.name = name;
    /** @type {import('ws').WebSocket | null} currently bound socket */
    this.ws = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {number | null} local first-welcome stamp of the attached client (optional, not authentication) */
    this.claimAt = null;
    /** @type {number} ms epoch of the last inbound frame / pong */
    this.lastSeen = now;
    /** @type {number | null} ms epoch when the socket was lost (null while connected) */
    this.disconnectedAt = now;
    /** @type {string | null} room code — owned and maintained by server/lobby.js */
    this.roomCode = null;
    /** @type {string | null} pending `room.closed` reason to deliver on the next resume (lobby-owned) */
    this.notice = null;
    /** @type {string[] | null} encoded frames (final m.public + m.result) to deliver on the next resume (lobby-owned) */
    this.pendingResult = null;
    /** @type {number} ms epoch of the last full match resync (lobby-owned; throttles repeated hellos) */
    this.resyncAt = -Infinity;
    /** @type {Record<string, { skill: number, module: string|null }> | null} checked operator loadout (lobby-owned, DESIGN §16) */
    this.loadout = null;
    /** @type {Readonly<Record<string, { potential: number, cultivate: number }>> | null} checked per-operator 潜能 / 练度 (lobby-owned, 0.2.2; room.loadout `ops`) */
    this.ops = null;
    /** @type {readonly string[] | null} checked not-owned chess ids (干员持有, lobby-owned, 0.2.0 补位) */
    this.notOwned = null;
    /** @type {Readonly<Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>> | null} checked 自选 picks (lobby-owned, 0.2.0 自选编队) */
    this.diy = null;
    /** @type {string} client address of the latest connection (logging) */
    this.addr = '?';
    /** @type {string | null} per-network limit key of the latest connection (null = not limited), see clientAddress */
    this.limitKey = null;
    /** Private stable quota key, never sent to clients; unlike addr it survives state restoration. */
    this.foreignSessionKey = null;
    /**
     * @type {number | null} lobby-owned extension of the reconnect window for this session (ms; null = the registry's
     * window). A solo run keeps its session resumable for the official `singleReconnectTime` (24 h) — see lobby.js.
     */
    this.resumeWindowMs = null;
    this.chatLastHitAt = 0;
    this.chatStrikes = 0;
    this.chatMutedUntil = 0;
    this.chatLastSentAt = -Infinity;
  }
}

/** Random 128-bit hex token. */
export const newToken = () => randomBytes(16).toString('hex');

/** Registry of sessions by playerId and by token; purges sessions disconnected longer than the window. */
export class SessionRegistry {
  /**
   * @param {{ reconnectWindowMs?: number, maxSessions?: number, now?: () => number }} [opts]
   */
  constructor({ reconnectWindowMs = NET_DEFAULTS.reconnectWindowMs, maxSessions = NET_DEFAULTS.maxSessions, now = Date.now } = {}) {
    this.reconnectWindowMs = reconnectWindowMs;
    this.maxSessions = maxSessions;
    this.now = now;
    /** @type {Map<string, Session>} */ this.byPlayerId = new Map();
    /** @type {Map<string, Session>} */ this.byTokenMap = new Map();
  }

  get size() { return this.byPlayerId.size; }

  /**
   * Create a new session with a fresh playerId and token. Evicts the oldest idle (disconnected, roomless)
   * session when the registry is full. Returns null when full of active sessions.
   * @param {string} name
   * @returns {Session | null}
   */
  create(name) {
    if (this.byPlayerId.size >= this.maxSessions && !this.evictOne()) return null;
    let playerId;
    do playerId = 'p_' + randomBytes(5).toString('hex'); while (this.byPlayerId.has(playerId));
    let token;
    do token = newToken(); while (this.byTokenMap.has(token));
    const s = new Session({ playerId, token, name, now: this.now() });
    this.byPlayerId.set(playerId, s);
    this.byTokenMap.set(token, s);
    return s;
  }

  /** @param {unknown} token @returns {Session | null} a live (non-expired) session for this token */
  byToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const s = this.byTokenMap.get(token);
    if (!s) return null;
    if (this.isExpired(s, this.now())) return null;
    return s;
  }

  /** @param {string} playerId @returns {Session | null} */
  byId(playerId) { return this.byPlayerId.get(playerId) || null; }

// Adapted from xinhai-ai/Stronghold-Protocol (20524bb), GPL-3.0-or-later.
  adopt(doc) {
    if (!doc || typeof doc.playerId !== 'string' || typeof doc.token !== 'string') return null;
    if (!doc.playerId || !doc.token) return null;
    if (this.byPlayerId.has(doc.playerId) || this.byTokenMap.has(doc.token)) return null;
    if (this.byPlayerId.size >= this.maxSessions) return null;
    const now = this.now();
    const s = new Session({ playerId: doc.playerId, token: doc.token, name: doc.name, now });
    s.connected = false;
    s.ws = null;
    const since = Number(doc.disconnectedAt);
    s.disconnectedAt = Number.isFinite(since) ? since : now;
    s.resumeWindowMs = Number.isFinite(doc.resumeWindowMs) && doc.resumeWindowMs > 0 ? Number(doc.resumeWindowMs) : null;
    s.roomCode = typeof doc.roomCode === 'string' && doc.roomCode ? doc.roomCode : null;
    s.loadout = doc.loadout && typeof doc.loadout === 'object' ? doc.loadout : null;
    s.ops = doc.ops && typeof doc.ops === 'object' ? doc.ops : null;
    s.notOwned = Array.isArray(doc.notOwned) ? doc.notOwned : null;
    s.diy = doc.diy && typeof doc.diy === 'object' ? doc.diy : null;
    // Documents from the ban-window policy tracked hit timestamps; the newest one and their count carry
    // over (each was one violation) and expire by the same rule going forward.
    const legacy = Array.isArray(doc.chatHitTimes)
      ? doc.chatHitTimes.filter((at) => Number.isFinite(at) && at >= 0 && at > now - CHAT_WINDOW_MS && at <= now) : [];
    s.chatLastHitAt = Number.isFinite(doc.chatLastHitAt) && doc.chatLastHitAt > 0 ? doc.chatLastHitAt
      : legacy.length ? legacy[legacy.length - 1] : 0;
    s.chatStrikes = Number.isInteger(doc.chatStrikes) && doc.chatStrikes > 0 ? doc.chatStrikes : legacy.length;
    s.chatMutedUntil = Number.isFinite(doc.chatMutedUntil) ? Math.max(0, Math.min(doc.chatMutedUntil, now + CHAT_MUTE_MAX_MS)) : 0;
    s.addr = typeof doc.addr === 'string' ? doc.addr : '?';
    s.foreignSessionKey = foreignSessionKey(doc.foreignSessionKey);
    s.notice = typeof doc.notice === 'string' ? doc.notice : null;
    s.pendingResult = Array.isArray(doc.pendingResult) ? doc.pendingResult.filter((f) => typeof f === 'string') : null;
    this.byPlayerId.set(s.playerId, s);
    this.byTokenMap.set(s.token, s);
    return s;
  }

  /** @param {Session} s */
  remove(s) {
    if (this.byPlayerId.get(s.playerId) === s) this.byPlayerId.delete(s.playerId);
    if (this.byTokenMap.get(s.token) === s) this.byTokenMap.delete(s.token);
  }

  /**
   * The reconnect window of one session: the registry's, or the session's own `resumeWindowMs` when that is longer
   * (the lobby may only extend it, never shorten it).
   * @param {Session} s @returns {number} ms
   */
  windowOf(s) {
    const own = s.resumeWindowMs;
    return typeof own === 'number' && own > this.reconnectWindowMs ? own : this.reconnectWindowMs;
  }

  /** @param {Session} s @param {number} now */
  roomExpired(s, now) {
    return !s.connected && s.disconnectedAt != null && now - s.disconnectedAt > this.windowOf(s);
  }

  /** @param {Session} s @param {number} now */
  isExpired(s, now) {
    return !s.connected && s.disconnectedAt != null && now >= chatRetentionUntil(s, now) && now - s.disconnectedAt > this.windowOf(s);
  }

  /**
   * Remove and return every session whose reconnect window has elapsed.
   * @param {number} [now]
   * @returns {Session[]}
   */
  sweep(now = this.now()) {
    const out = [];
    for (const s of this.byPlayerId.values()) if (this.isExpired(s, now)) out.push(s);
    for (const s of out) this.remove(s);
    return out;
  }

  /** Evict the oldest disconnected session that is not in a room. @returns {boolean} */
  evictOne() {
    for (const s of this.byPlayerId.values()) {
      if (!s.connected && !s.roomCode && chatRetentionUntil(s, this.now()) <= this.now()) { this.remove(s); return true; }
    }
    return false;
  }

  /** @returns {IterableIterator<Session>} */
  all() { return this.byPlayerId.values(); }
}

// ---------------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------------

/** Classic token bucket: `burst` capacity, refilled continuously at `ratePerSec`. */
export class TokenBucket {
  /** @param {number} ratePerSec @param {number} burst @param {number} now ms */
  constructor(ratePerSec, burst, now) {
    this.rate = ratePerSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  /** Consume one token. @param {number} now ms @returns {boolean} false when rate-limited */
  take(now) {
    const dt = Math.max(0, now - this.at);
    this.at = now;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Send helpers (never throw)
// ---------------------------------------------------------------------------------------------------

/** Monotonic outbound frame counters since process start (per-socket sends; /healthz `wire`). */
export const wireStats = { frames: 0, bytes: 0, byType: new Map() };

/**
 * @param {string | null} kind frame type (null = unknown, counted in the totals only)
 * @param {number} len data.length (UTF-16 units ≈ wire bytes for the ASCII-heavy frames here)
 */
function noteWireFrame(kind, len) {
  wireStats.frames++;
  wireStats.bytes += len;
  if (kind == null) return;
  let e = wireStats.byType.get(kind);
  if (!e) { e = { frames: 0, bytes: 0 }; wireStats.byType.set(kind, e); }
  e.frames++;
  e.bytes += len;
}

/** Plain-object snapshot of wireStats for /healthz (diff two polls for rates). */
export function wireStatsSnapshot() {
  const byType = {};
  for (const [k, v] of wireStats.byType) byType[k] = { frames: v.frames, bytes: v.bytes };
  return { frames: wireStats.frames, bytes: wireStats.bytes, byType };
}

/**
 * JSON-encode a message; returns null (and never throws) on unserializable input. A message
 * carrying a string under `ENCODED` encodes to that string (see the symbol).
 * @param {object} msg
 * @returns {string | null}
 */
export function encode(msg) {
  try {
    if (msg && typeof msg === 'object' && typeof msg[ENCODED] === 'string') return msg[ENCODED];
    const s = JSON.stringify(msg);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

const onSendDone = (err) => { void err; }; // errors surface through the socket's 'error'/'close' events

// Managed sockets share a server-wide send budget, including Lobby's room broadcasts and unicasts.
// Unmanaged sockets (tools/tests) retain the immediate send helpers.
const socketNetworks = new WeakMap();
const capturedMessages = new WeakMap();

// A mutable source object can be reused before every recipient's slice executes. Give each encoding
// a stable identity so stateTransport's shared snapshot cache never oscillates between old/new views.
function captureFrame(msg, data, kind) {
  if (!msg || typeof msg !== 'object') return { data, bytes: Buffer.byteLength(data), kind, msg: null, droppable: false, scope: null };
  let captured = capturedMessages.get(msg);
  const scope = (kind === 'm.public' || kind === 'm.private') ? msg[STATE_COALESCE] || null : null;
  if (!captured || captured.data !== data || captured.kind !== kind || captured.scope !== scope) {
    captured = { data, bytes: Buffer.byteLength(data), kind, msg: { t: kind }, droppable: isDroppable(msg), scope,
      owner: kind === 'm.private' ? msg.playerId : null };
    reserveStateFrame(captured.msg, data);
    capturedMessages.set(msg, captured);
  }
  return captured;
}

/**
 * Send an already-encoded frame. Skips when the socket is not OPEN, when `droppable` and the socket is
 * congested (> 1 MB queued), and terminates sockets whose queue exceeds 16 MB.
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {string} data
 * @param {{ droppable?: boolean, kind?: string | null }} [opts] kind labels the frame in wireStats
 * @returns {boolean} true when the frame was queued
 */
export function sendRaw(ws, data, { droppable = false, kind = null } = {}) {
  if (!ws || ws.readyState !== WS_OPEN || typeof data !== 'string') return false;
  const network = socketNetworks.get(ws);
  if (network) return network.queueFrame(ws, { data, bytes: Buffer.byteLength(data), droppable, kind, msg: null, scope: null });
  return writeRaw(ws, data, { droppable, kind });
}

/** Actually write a frame; the send pump must not re-enqueue its own writes. */
function writeRaw(ws, data, { droppable = false, kind = null, bytes } = {}) {
  try {
    const queued = ws.bufferedAmount;
    const diagnostics = socketDiagnostics.get(ws);
    if (queued > NET_DEFAULTS.hardBufferBytes) { if (diagnostics) diagnostics.slowDisconnects++; ws.terminate(); return false; }
    if (droppable && queued > NET_DEFAULTS.snapDropBytes) { if (diagnostics) diagnostics.droppedSnapshots++; return false; }
    ws.send(data, diagnostics?.sendCallback() || onSendDone);
    diagnostics?.sent(data, bytes);
    noteWireFrame(kind, data.length);
    return true;
  } catch {
    return false;
  }
}

/** True for frames that may be skipped under backpressure (only battle snapshots). */
export const isDroppable = (msg) => !!msg && msg.t === 'b.snap';

/**
 * Encode and send one message to a socket. Never throws.
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {object} msg
 * @param {string | null} [encoded] trusted encoding of this exact message
 * @returns {boolean}
 */
export function send(ws, msg, encoded = null) {
  const data = encoded ?? encode(msg);
  if (data == null || !ws || ws.readyState !== WS_OPEN) return false;
  const kind = msg && typeof msg === 'object' && typeof msg.t === 'string' ? msg.t : null;
  const network = socketNetworks.get(ws);
  if (network) return network.queueFrame(ws, captureFrame(msg, data, kind));
  return writeMessage(ws, { data, droppable: isDroppable(msg), kind, msg });
}

/** Prepare deltas only when writing, after every earlier frame on this socket. */
function writeMessage(ws, { msg, data, droppable, kind, bytes }) {
  try {
    const frame = prepareStateFrame(ws, msg, data, bytes);
    // Preserve logical message types in wireStats; count the actual full/delta frame length.
    const queued = writeRaw(ws, frame.data, { droppable, kind, bytes: frame.bytes });
    if (queued) {
      frame.commit();
      if (kind === 'm.result' || kind === 'room.closed') resetStateDelta(ws);
    }
    return queued;
  } catch { return false; }
}

/** Baseline resets must follow already queued states, so a recovery still starts with a full frame. */
export function resetSocketState(ws) {
  const network = socketNetworks.get(ws);
  if (network) return network.queueFrame(ws, { data: '', bytes: 0, droppable: false, kind: null, msg: null, scope: null, reset: true });
  resetStateDelta(ws);
  return true;
}

function writeFrame(ws, frame) {
  if (frame.reset) { resetStateDelta(ws); return true; }
  return frame.msg ? writeMessage(ws, frame) : writeRaw(ws, frame.data, frame);
}

/**
 * Send to a session's current socket (no-op while disconnected). Never throws.
 * @param {Session | null | undefined} session
 * @param {object} msg
 * @returns {boolean}
 */
export function sendSession(session, msg, encoded = null) {
  if (!session || !session.connected) return false;
  return send(session.ws, msg, encoded);
}

/** @param {unknown} rid */
const validRid = (rid) => Number.isInteger(rid) && rid >= 0 && rid <= MAX_RID;

/**
 * True for a real ERR code (own property; rejects inherited names like "constructor").
 * @param {unknown} code
 * @returns {boolean}
 */
export const isErrCode = (code) => typeof code === 'string' && Object.hasOwn(ERR, code);

/**
 * Build an `error` frame.
 * @param {string} code ERR code
 * @param {unknown} [rid]
 * @param {string} [detail] developer-facing reason
 */
export function errorMsg(code, rid, detail) {
  const known = isErrCode(code);
  const m = { t: 'error', code: known ? code : ERR.INTERNAL, msg: known ? ERR_TEXT[code] || ERR_TEXT.INTERNAL : ERR_TEXT.INTERNAL };
  if (validRid(rid)) m.rid = rid;
  if (detail) m.detail = String(detail).slice(0, 120);
  return m;
}

// ---------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------

/**
 * Normalize a nickname: strip control/invisible characters and lone surrogates, collapse whitespace,
 * trim, cap at NAME_MAX_LEN code points. Returns null when nothing printable remains.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').replace(LONE_SURROGATE_RE, '').replace(/\s+/g, ' ').replace(STRIP_RE, '').replace(/ {2,}/g, ' ').trim();
  s = [...s].slice(0, NAME_MAX_LEN).join('').trim();
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------------------------------
// Client addresses (per-network limits)
// ---------------------------------------------------------------------------------------------------

/**
 * Canonical textual IP: lowercase, zone id stripped, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → IPv4.
 * @param {unknown} raw
 * @returns {string} '' when not an IP address
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  const withPort = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s); // [v6]:port, v4:port
  if (withPort) s = withPort[1];
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (isIP(s) === 6) {
    const g = ipv6Groups(s);
    if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) s = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return isIP(s) ? s : '';
}

/** Expand an IPv6 address into 8 numeric groups (null when malformed). @param {string} ip */
function ipv6Groups(ip) {
  let s = ip;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Loopback or private-network address (RFC 1918, link-local, CGNAT/Tailscale, IPv6 ULA / link-local).
 * @param {string} ip normalized
 */
export function isLocalIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.every((x, i) => (i < 7 ? x === 0 : x <= 1))) return true; // ::1 and ::
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * The key per-network limits count against: the IPv4 address, or the /64 prefix of an IPv6 address
 * (one subscriber typically owns a whole /64).
 * @param {string} ip normalized
 */
export function limitKeyOf(ip) {
  if (isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : ip;
}

/** The client address a trusted local proxy forwards (null when it sent none). */
function forwardedAddress(headers) {
  if (!headers) return null;
  const one = (h) => (Array.isArray(h) ? h[h.length - 1] : h);
  for (const name of ['cf-connecting-ip', 'x-real-ip']) {
    const ip = normalizeIp(one(headers[name]));
    if (ip) return ip;
  }
  const xff = one(headers['x-forwarded-for']);
  if (typeof xff === 'string') {
    // The rightmost entry was appended by the proxy nearest to us; earlier ones are client-controlled.
    const parts = xff.split(',');
    const ip = normalizeIp(parts[parts.length - 1]);
    if (ip) return ip;
  }
  return null;
}

/**
 * Resolve an upgrade request's client address and its per-network limit key.
 * Forwarding headers are honoured from loopback/private peers ('auto'), always (true) or never (false).
 * Local/private peers without a forwarded address get `key: null` (never limited per network).
 * @param {import('node:http').IncomingMessage | undefined} req
 * @param {'auto' | boolean} [trustProxy]
 * @returns {{ ip: string, key: string | null }}
 */
export function clientAddress(req, trustProxy = NET_DEFAULTS.trustProxy) {
  const peer = normalizeIp(req?.socket?.remoteAddress);
  const local = !peer || isLocalIp(peer);
  if (trustProxy === true || (trustProxy !== false && local)) {
    const fwd = forwardedAddress(req?.headers);
    if (fwd) return { ip: fwd, key: isLocalIp(fwd) ? null : limitKeyOf(fwd) };
  }
  if (local) return { ip: peer || '?', key: null };
  return { ip: peer, key: limitKeyOf(peer) };
}

// ---------------------------------------------------------------------------------------------------
// Network: per-socket pipeline
// ---------------------------------------------------------------------------------------------------

/** Per-socket state. */
class Connection {
  /** @param {import('ws').WebSocket} ws @param {{ ip: string, key: string | null }} addr @param {number} now @param {typeof NET_DEFAULTS} opts */
  constructor(ws, addr, now, opts) {
    this.ws = ws;
    this.ip = addr.ip;
    /** @type {string | null} per-network limit key (see clientAddress) */
    this.key = addr.key;
    this.openedAt = now;
    this.alive = true;
    /** @type {Session | null} */
    this.session = null;
    this.bucket = new TokenBucket(opts.ratePerSec, opts.rateBurst, now);
    this.heavy = new TokenBucket(opts.heavyPerSec, opts.heavyBurst, now);
    this.dropWindowAt = now;
    this.drops = 0;
    /** true once the server initiated the close; frames still in flight are ignored */
    this.closing = false;
  }

  /** Server-initiated close (never throws). Later frames from this socket are ignored. */
  close(code, reason) {
    this.closing = true;
    try { this.ws.close(code, reason); } catch { /* ignore */ }
  }
}

/** Frames larger than this are not parsed just to echo a rid on a RATE error (CPU guard). */
const PEEK_RID_MAX_BYTES = 2048;

/** Owns every live socket; turns frames into validated messages for the handler. */
export class Network {
  /**
   * @param {{
   *   registry: SessionRegistry,
   *   handler: { onHello?: Function, onMessage: Function, onDisconnect?: Function, onExpire?: Function, welcomeInfo?: Function },
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   now?: () => number,
   *   options?: Partial<typeof NET_DEFAULTS>,
   *   countryLookup?: ((ip: string) => string | null) | null,
   * }} opts
   */
  constructor({ registry, handler, log = noopLog, now = Date.now, options = {}, diagnostics = new NetDiagnostics(), countryLookup = null }) {
    this.registry = registry;
    this.handler = handler;
    this.log = log;
    this.now = now;
    this.opts = { ...NET_DEFAULTS, ...options };
    /** @type {Map<import('ws').WebSocket, Connection>} */
    this.conns = new Map();
    /** @type {Map<string, number>} open sockets per client network key */
    this.connsPerKey = new Map();
    this.closed = false;
    this.diagnostics = diagnostics;
    this.draining = false;
    this.foreignSessions = new ForeignSessions({ registry, countryLookup, now });
    /** Fanout queue (see _eachConnection): FIFO jobs of per-connection callbacks, pumped in small slices. */
    this._fanout = [];
    this._fanoutImmediate = null;
    this._fanoutRunning = false;
    this._heartbeatPending = false;
    /** Per-socket FIFO frames; Map insertion order rotates recipients fairly between slices. */
    this._outbound = new Map();
    this._blockedOutbound = new Map();
    this._backpressureTimer = null;
    this._outboundImmediate = null;
    this._sendVisits = 0;
    this._sendDeadline = 0;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
    this.heartbeatTimer.unref?.();
    const sweepMs = Math.max(20, Math.min(15_000, Math.floor(this.opts.reconnectWindowMs / 4)));
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  /** Number of open sockets. */
  get connectionCount() { return this.conns.size; }

  /** Bytes queued unsent across all open sockets ({ total, max }) — health diagnostics for a backed-up peer. */
  bufferedBytes() {
    let total = 0, max = 0;
    for (const conn of this.conns.values()) {
      const n = (conn.ws?.bufferedAmount || 0) + (this._outbound.get(conn.ws)?.bytes || this._blockedOutbound.get(conn.ws)?.bytes || 0);
      total += n;
      if (n > max) max = n;
    }
    return { total, max };
  }

  /**
   * Accept one immutable encoding, preserving FIFO across broadcasts, raw room states and unicasts.
   * The first 128 writes / 2 ms are immediate; the budget is shared across all rooms until setImmediate.
   * Deferred bytes count toward the existing snapshot-drop and disconnect limits.
   * @param {import('ws').WebSocket} ws
   * @param {{ data: string, bytes: number, droppable: boolean, kind: string | null, msg: object | null, scope?: object | null, reset?: boolean }} frame
   */
  queueFrame(ws, frame) {
    const conn = this.conns.get(ws);
    if (this.closed || !conn || conn.closing || ws.readyState !== WS_OPEN) return false;
    const pending = this._outbound.get(ws) || this._blockedOutbound.get(ws);
    const buffered = (ws.bufferedAmount || 0) + (pending?.bytes || 0);
    if (buffered > NET_DEFAULTS.hardBufferBytes) {
      this.diagnostics.slowDisconnects++;
      try { ws.terminate(); } catch { /* socket already closing */ }
      return false;
    }
    if (frame.droppable && buffered > NET_DEFAULTS.snapDropBytes) {
      this.diagnostics.droppedSnapshots++;
      return false;
    }
    // Transport probes carry no game state and may bypass queued gameplay frames.
    if (frame.kind === 'pong') return writeMessage(ws, frame);
    const blocked = (ws.bufferedAmount || 0) > NET_DEFAULTS.snapDropBytes;
    if (!this._sendVisits) this._sendDeadline = performance.now() + PUMP_MS;
    if (!blocked && !pending && this._sendVisits < PUMP_VISITS && performance.now() < this._sendDeadline) {
      this._sendVisits++;
      this._scheduleOutbound();
      return writeFrame(ws, frame);
    }
    const queue = pending || new OutboundQueue();
    if (queue.push(frame, buffered > NET_DEFAULTS.snapDropBytes)) this.diagnostics.coalescedStates++;
    if (queue.size > this.opts.maxQueuedFrames || (ws.bufferedAmount || 0) + queue.bytes > NET_DEFAULTS.hardBufferBytes) {
      this.diagnostics.slowDisconnects++;
      this._outbound.delete(ws);
      this._blockedOutbound.delete(ws);
      try { ws.terminate(); } catch { /* socket already closing */ }
      return false;
    }
    if (blocked) {
      this._outbound.delete(ws);
      this._blockedOutbound.set(ws, queue);
      this._scheduleBackpressure();
    } else {
      this._blockedOutbound.delete(ws);
      this._outbound.set(ws, queue);
      this._scheduleOutbound();
    }
    return true;
  }

  _scheduleBackpressure() {
    if (this._backpressureTimer !== null || this.closed || !this._blockedOutbound.size) return;
    this._backpressureTimer = setTimeout(() => {
      this._backpressureTimer = null;
      for (const [ws, queue] of this._blockedOutbound) {
        const conn = this.conns.get(ws);
        if (!conn || conn.closing || ws.readyState !== WS_OPEN) this._blockedOutbound.delete(ws);
        else if ((ws.bufferedAmount || 0) + queue.bytes > NET_DEFAULTS.hardBufferBytes) {
          this.diagnostics.slowDisconnects++;
          this._blockedOutbound.delete(ws);
          try { ws.terminate(); } catch { /* socket already closing */ }
        } else if ((ws.bufferedAmount || 0) <= NET_DEFAULTS.snapDropBytes) {
          this._blockedOutbound.delete(ws);
          this._outbound.set(ws, queue);
        }
      }
      if (this._outbound.size) this._scheduleOutbound();
      this._scheduleBackpressure();
    }, this.opts.backpressurePollMs);
    this._backpressureTimer.unref?.();
  }

  _scheduleOutbound() {
    if (this._outboundImmediate !== null || this.closed) return;
    this._outboundImmediate = setImmediate(() => {
      this._outboundImmediate = null;
      this._sendVisits = 0;
      this._sendDeadline = 0;
      this._pumpOutbound();
    });
    this._outboundImmediate.unref?.();
  }

  /** Drain fairly across sockets; each socket's broadcast / private / result order stays intact. */
  _pumpOutbound() {
    this._sendDeadline = performance.now() + PUMP_MS;
    while (!this.closed && this._outbound.size && this._sendVisits < PUMP_VISITS && performance.now() < this._sendDeadline) {
      const [ws, queue] = this._outbound.entries().next().value;
      this._outbound.delete(ws);
      this._sendVisits++;
      const conn = this.conns.get(ws);
      if (conn && !conn.closing && ws.readyState === WS_OPEN) {
        if ((ws.bufferedAmount || 0) > NET_DEFAULTS.snapDropBytes) {
          this._blockedOutbound.set(ws, queue);
          this._scheduleBackpressure();
          continue;
        }
        const frame = queue.shift();
        if (queue.size) this._outbound.set(ws, queue);
        writeFrame(ws, frame);
      } else this._outbound.delete(ws);
    }
    // A final empty turn resets the shared budget even when small-room broadcasts drained synchronously.
    if (this._sendVisits || this._outbound.size) this._scheduleOutbound();
  }

  /**
   * Queue a per-connection callback over a snapshot of the current sockets and pump it in small slices
   * (at most 128 visits or 2 ms per turn, then `setImmediate`) so one huge fanout cannot stall the event
   * loop or starve fresh I/O: work that arrives between slices (new frames, replies) runs first. `fn` must
   * not throw — callbacks are invoked from setImmediate, an exception would surface as uncaughtException.
   * @param {(conn: Connection) => void} fn
   * @param {'broadcast' | 'heartbeat'} [kind]
   */
  _eachConnection(fn, kind) {
    if (this.closed) return;
    this._fanout.push({ connections: [...this.conns.values()], index: 0, fn, kind });
    if (!this._fanoutRunning && this._fanoutImmediate === null) this._pumpFanout();
  }

  /** Drain the fanout FIFO one slice; a connection is visited only while still live (this.conns owns it). */
  _pumpFanout() {
    this._fanoutImmediate = null;
    this._fanoutRunning = true;
    const deadline = performance.now() + PUMP_MS;
    let visited = 0;
    try {
      while (!this.closed && this._fanout.length && visited < PUMP_VISITS) {
        const job = this._fanout[0];
        if (job.index === job.connections.length) {
          this._fanout.shift();
          if (job.kind === 'heartbeat') this._heartbeatPending = false; // the next heartbeat() may queue a new round
          continue;
        }
        const conn = job.connections[job.index++];
        if (this.conns.get(conn.ws) === conn) job.fn(conn);
        visited++;
        if (performance.now() >= deadline) break;
      }
    } finally {
      this._fanoutRunning = false;
      if (!this.closed && this._fanout.length) {
        this._fanoutImmediate = setImmediate(() => this._pumpFanout());
        this._fanoutImmediate.unref?.();
      }
    }
  }

  /**
   * Global broadcast: the same send budget also serves Lobby.broadcastRoom / broadcastState / unicasts.
   * Capture recipients now, encode once, and defer expensive writes / state deltas through queueFrame.
   * @param {object} msg
   */
  broadcastAll(msg) {
    if (this.closed) return;
    const data = encode(msg);
    if (data == null) return;
    for (const conn of this.conns.values()) if (!conn.closing) send(conn.ws, msg, data);
  }

  /**
   * Upgrade-time admission check (server/http/websocket.js): null to accept, otherwise the reason to refuse.
   * @param {import('node:http').IncomingMessage} req
   * @returns {null | 'shutdown' | 'full' | 'per-address'}
   */
  admission(req) {
    if (this.closed || this.draining) return 'shutdown';
    if (this.conns.size >= this.opts.maxConnections) return 'full';
    const { key } = clientAddress(req, this.opts.trustProxy);
    const cap = this.opts.maxConnectionsPerAddr;
    if (key && cap > 0 && (this.connsPerKey.get(key) || 0) >= cap) return 'per-address';
    return null;
  }

  /**
   * Adopt a freshly upgraded socket.
   * @param {import('ws').WebSocket} ws
   * @param {import('node:http').IncomingMessage} [req]
   */
  handleConnection(ws, req) {
    if (this.closed || this.draining) { try { ws.close(CLOSE.SHUTDOWN, 'server shutdown'); } catch { /* ignore */ } return; }
    const conn = new Connection(ws, clientAddress(req, this.opts.trustProxy), this.now(), this.opts);
    this.conns.set(ws, conn);
    socketNetworks.set(ws, this);
    socketDiagnostics.set(ws, this.diagnostics);
    if (conn.key) this.connsPerKey.set(conn.key, (this.connsPerKey.get(conn.key) || 0) + 1);
    ws.on('message', (data, isBinary) => {
      const start = performance.now();
      conn.frameType = 'invalid';
      try { this.onFrame(conn, data, isBinary); } catch (e) { this.log.error('[net] frame handler crashed', e); }
      finally { this.diagnostics.received(conn.frameType, data.length || 0, performance.now() - start); }
    });
    ws.on('pong', () => { conn.alive = true; if (conn.session && conn.session.ws === ws) conn.session.lastSeen = this.now(); });
    ws.on('error', (e) => { this.log.debug?.('[net] socket error', e?.code || e?.message); });
    ws.on('close', () => { try { this.onClose(conn); } catch (e) { this.log.error('[net] close handler crashed', e); } });
  }

  /** @param {Connection} conn @param {object} msg */
  reply(conn, msg) { return send(conn.ws, msg); }

  /** @param {Connection} conn */
  onFrame(conn, data, isBinary) {
    // A socket we are closing (replaced by another tab, hello timeout, flooding, shutdown) may still have
    // frames in flight; acting on them could e.g. mint an orphan session from a late `hello`.
    if (conn.closing || this.closed) return;
    if (this.draining) { this.reply(conn, errorMsg(ERR.INTERNAL, peekRid(data, isBinary), 'server shutting down')); return; }
    const now = this.now();
    conn.alive = true;
    if (conn.session && conn.session.ws === conn.ws) conn.session.lastSeen = now;

    if (!conn.bucket.take(now)) {
      if (now - conn.dropWindowAt >= 1000) { conn.dropWindowAt = now; conn.drops = 0; }
      if (++conn.drops > this.opts.abuseDropsPerSec) {
        this.log.warn(`[net] closing flooding socket ${conn.ip}`);
        conn.close(CLOSE.POLICY, 'rate limit');
        return;
      }
      this.reply(conn, errorMsg(ERR.RATE, peekRid(data, isBinary)));
      return;
    }

    if (isBinary) { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'binary frame')); return; }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'invalid json')); return; }
    const rid = msg && typeof msg === 'object' ? msg.rid : undefined;
    // Own-property check first: validateC2S alone would accept inherited keys like "constructor".
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || !Object.hasOwn(C2S, msg.t)) {
      const t = msg && typeof msg === 'object' ? String(msg.t).slice(0, 32) : typeof msg;
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `unknown type ${t}`));
      return;
    }
    const reason = validateC2S(msg);
    if (reason) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, reason)); return; }
    conn.frameType = msg.t;

    if (msg.t === 'ping') {
      const pong = { t: 'pong', c: msg.c, s: now };
      if (validRid(rid)) pong.rid = rid;
      this.reply(conn, pong);
      return;
    }
    if (msg.t === 'hello') { this.onHelloMsg(conn, msg, now); return; }
    if (!conn.session) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'hello required')); return; }
    if (HEAVY_TYPES.has(msg.t) && !conn.heavy.take(now)) { this.reply(conn, errorMsg(ERR.RATE, rid, `${msg.t} too often`)); return; }

    let res;
    try {
      // client-side combat reports (b.progress / b.result, DESIGN §14) belong to the running match like 'g.*' intents:
      // handed to the lobby's match router when the handler has one (server/lobby.js routeGame)
      if (msg.t.startsWith('b.') && typeof this.handler.routeGame === 'function') res = this.handler.routeGame(conn.session, msg);
      else res = this.handler.onMessage(conn.session, msg);
    } catch (e) {
      this.log.error(`[net] handler crashed on ${msg.t}`, e);
      res = { error: ERR.INTERNAL };
    }
    if (res && res.error) {
      // fire-and-forget battle progress (no rid) that reached no running match — the match just ended, the room went
      // back to the lobby — is stale, not a client mistake: never answered (DESIGN §14; a rid-less error frame would
      // surface as an error toast in the browser)
      if (msg.t === 'b.progress' && !validRid(rid)) return;
      this.reply(conn, errorMsg(isErrCode(res.error) ? res.error : ERR.INTERNAL, rid, res.detail));
    } else if (validRid(rid)) this.reply(conn, { t: 'ok', rid });
  }

  /** @param {Connection} conn @param {any} msg @param {number} now */
  onHelloMsg(conn, msg, now) {
    const rid = msg.rid;
    if (msg.version != null && msg.version !== PROTOCOL_VERSION) {
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `version mismatch: server ${PROTOCOL_VERSION}`));
      return;
    }
    const name = sanitizeName(msg.name);
    if (!name) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'bad field name')); return; }
    // Check before creating, renaming or taking over a session, including token-based reconnects.
    if (hasSensitiveNickname(name)) { this.reply(conn, errorMsg(ERR.NICKNAME_SENSITIVE, rid)); return; }

    let session = conn.session;
    let resumed = false;
    const repeat = !!session;
    if (!session) {
      session = msg.token ? this.registry.byToken(msg.token) : null;
      if (session) {
        if (session.connected && session.ws && session.ws !== conn.ws
          && (msg.noReplace || (Number.isFinite(msg.claimAt) && session.claimAt != null && msg.claimAt > session.claimAt))) {
          this.reply(conn, errorMsg(ERR.SESSION_IN_USE, rid));
          return;
        }
        resumed = true;
      }
      const ip = normalizeIp(conn.ip);
      const admission = this.foreignSessions.prepare(ip && !isLocalIp(ip) ? ip : '', session);
      if (!admission.ok) {
        if (admission.suppressed !== null) this.log.info('[audit] ' + JSON.stringify({ at: new Date(now).toISOString(),
          action: 'session.foreignLimit.denied', ip: conn.ip, network: conn.key, country: admission.country,
          name, suppressed: admission.suppressed }));
        this.reply(conn, errorMsg(ERR.FOREIGN_SESSION_LIMIT, rid));
        return;
      }
      try {
        this.foreignSessions.reclaim(admission, (old) => {
          this.log.info('[audit] ' + JSON.stringify({ at: new Date(now).toISOString(), action: 'session.foreignLimit.reclaimed',
            ip: conn.ip, network: conn.key, country: admission.country, playerId: old.playerId, name: old.name, roomCode: old.roomCode }));
          this.handler.onExpire?.(old);
          if (old.ws) this.detachReplaced(old.ws);
          old.ws = null;
        });
      } catch (error) {
        this.log.error('[net] foreign session cleanup failed', error);
        this.reply(conn, errorMsg(ERR.INTERNAL, rid));
        return;
      }
      if (!session) {
        session = this.registry.create(name);
        if (!session) { this.reply(conn, errorMsg(ERR.INTERNAL, rid, 'server full')); return; }
      }
      this.foreignSessions.bind(session, admission);
      if (session.ws && session.ws !== conn.ws) this.detachReplaced(session.ws);
      conn.session = session;
      session.ws = conn.ws;
      session.connected = true;
      session.claimAt = Number.isFinite(msg.claimAt) ? msg.claimAt : null;
      session.disconnectedAt = null;
    }
    session.name = name;
    session.lastSeen = now;
    session.addr = conn.ip;
    session.limitKey = conn.key;
    if (!repeat) this.log.info('[audit] ' + JSON.stringify({ at: new Date(now).toISOString(),
      action: resumed ? 'session.resumed' : 'session.connected', ip: conn.ip,
      network: conn.key, playerId: session.playerId, name: session.name, roomCode: session.roomCode || null }));
    negotiateStateDelta(conn.ws, msg.stateDelta);

    let extra = null;
    try { extra = this.handler.welcomeInfo?.() ?? null; } catch (e) { this.log.error('[net] welcomeInfo crashed', e); }
    const welcome = { ...(extra && typeof extra === 'object' ? extra : null), t: 'welcome', playerId: session.playerId, token: session.token, name: session.name, serverNow: now, version: PROTOCOL_VERSION, resumed };
    if (validRid(rid)) welcome.rid = rid;
    this.reply(conn, welcome);
    try {
      this.handler.onHello?.(session, { resumed, repeat });
    } catch (e) {
      this.log.error('[net] onHello crashed', e);
    }
  }

  /** The session moved to a new socket: unbind and close the old one without firing a disconnect. */
  detachReplaced(oldWs) {
    const old = this.conns.get(oldWs);
    if (old) {
      old.session = null;
      old.close(CLOSE.REPLACED, 'session replaced');
    } else {
      try { oldWs.close(CLOSE.REPLACED, 'session replaced'); } catch { /* ignore */ }
    }
  }

  /** @param {Connection} conn */
  onClose(conn) {
    socketNetworks.delete(conn.ws);
    this._outbound.delete(conn.ws);
    this._blockedOutbound.delete(conn.ws);
    if (!this._blockedOutbound.size && this._backpressureTimer !== null) {
      clearTimeout(this._backpressureTimer);
      this._backpressureTimer = null;
    }
    socketDiagnostics.delete(conn.ws);
    if (this.conns.delete(conn.ws) && conn.key) {
      const n = (this.connsPerKey.get(conn.key) || 1) - 1;
      if (n > 0) this.connsPerKey.set(conn.key, n);
      else this.connsPerKey.delete(conn.key);
    }
    const s = conn.session;
    conn.session = null;
    if (!s || s.ws !== conn.ws) return;
    s.ws = null;
    s.connected = false;
    s.disconnectedAt = this.now();
    if (this.closed || this.draining) return;
    try { this.handler.onDisconnect?.(s); } catch (e) { this.log.error('[net] onDisconnect crashed', e); }
  }

  /** Ping every socket; terminate the ones that did not answer since the previous heartbeat. */
  heartbeat() {
    if (this.closed || this._heartbeatPending) return;
    this._heartbeatPending = true;
    // One `now` per connection, not one per round: the pumped fanout slices across event-loop turns,
    // a timestamp taken at enqueue time would go stale for later slices (hello timeout would misfire).
    this._eachConnection((conn) => {
      const now = this.now();
      try {
        if (conn.closing) {
          // Closing handshake never completed within a heartbeat interval → drop the TCP connection.
          if (!conn.alive) conn.ws.terminate();
          conn.alive = false;
          return;
        }
        if (!conn.session && now - conn.openedAt > this.opts.helloTimeoutMs) {
          conn.close(CLOSE.HELLO_TIMEOUT, 'hello timeout');
          return;
        }
        if (!conn.alive) { conn.ws.terminate(); return; }
        conn.alive = false;
        conn.ws.ping();
      } catch (e) {
        this.log.debug?.('[net] heartbeat error', e?.message);
      }
    }, 'heartbeat');
  }

  /** Purge expired sessions and tell the handler. */
  sweep() {
    // Moderation may retain an identity, but it must not extend that identity's room lease.
    for (const session of this.registry.all()) if (session.roomCode && this.registry.roomExpired(session, this.now())) {
      try { this.handler.onRoomExpire?.(session); } catch (error) { this.log.error('[net] onRoomExpire crashed', error); }
    }
    let expired;
    try { expired = this.registry.sweep(this.now()); } catch (e) { this.log.error('[net] sweep crashed', e); return; }
    for (const s of expired) {
      try { this.handler.onExpire?.(s); } catch (e) { this.log.error('[net] onExpire crashed', e); }
    }
    this.foreignSessions.prune();
  }

  /** Stop input and expiry before the final snapshot; outbound shutdown notices still work. */
  beginDrain() {
    this.draining = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.sweepTimer);
  }

  /**
   * Stop timers and close every socket (graceful: close frame, then terminate after 1 s).
   * @param {number} [code] @param {string} [reason]
   */
  close(code = CLOSE.SHUTDOWN, reason = 'server shutdown') {
    if (this.closed) return;
    for (const [ws, queue] of [...this._outbound, ...this._blockedOutbound]) {
      const conn = this.conns.get(ws);
      if (!conn || conn.closing || ws.readyState !== WS_OPEN) continue;
      while (queue.size) writeFrame(ws, queue.shift());
    }
    this.closed = true;
    if (this._fanoutImmediate !== null) clearImmediate(this._fanoutImmediate);
    this._fanoutImmediate = null;
    this._fanout.length = 0;
    if (this._outboundImmediate !== null) clearImmediate(this._outboundImmediate);
    this._outboundImmediate = null;
    this._outbound.clear();
    if (this._backpressureTimer !== null) clearTimeout(this._backpressureTimer);
    this._backpressureTimer = null;
    this._blockedOutbound.clear();
    this.diagnostics.close();
    clearInterval(this.heartbeatTimer);
    clearInterval(this.sweepTimer);
    for (const conn of this.conns.values()) {
      conn.close(code, reason);
      const t = setTimeout(() => { try { conn.ws.terminate(); } catch { /* ignore */ } }, 1000);
      t.unref?.();
    }
  }
}

/** Best-effort rid extraction for rate-limited frames (so the client's pending request resolves). */
function peekRid(data, isBinary) {
  if (isBinary || !data || data.length > PEEK_RID_MAX_BYTES) return undefined;
  try {
    const m = JSON.parse(data.toString('utf8'));
    return m && typeof m === 'object' ? m.rid : undefined;
  } catch {
    return undefined;
  }
}
