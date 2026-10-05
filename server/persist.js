// Adapted from xinhai-ai/Stronghold-Protocol (20524bb), GPL-3.0-or-later.
// server/persist.js — server state/checkpoints, backed by server/stateFile.js (docs/PERSISTENCE.md).
//
// WHAT SURVIVES A RESTART
//   * Sessions — playerId, secret token, nickname, operator loadout, the room they are in and their reconnect window.
//     A client that reconnects with its token after a restart is the same player, with the same seat.
//   * Rooms — code, mode, difficulty, host, seats (humans + AI), who is ready, the room's match counter.
//   * Running matches — via server/match/snapshot.js: the *last checkpoint*, which is only taken in the phases whose
//     state is fully serializable (INFO_CHECK / BAND_DRAFT / SP_DRAFT / ROUND_START / PREP). A match interrupted during
//     a battle therefore resumes at the start of the round it was in: same round, operators, items, economy, LP and
//     pool, with the round's battle fought again. A match that never reached a checkpoint (it started during the last
//     seconds before the crash) comes back as an empty room.
//
// WHAT DOES NOT
//   * The sockets themselves (every client reconnects and is rebound by its token — that is the point).
//   * A solo pause (g.pause) and the exact remaining clock of a battle: on restore the phase clock restarts from the
//     remaining time the checkpoint recorded, with at least 20 s of prep (snapshot.MIN_RECOVER_PREP_SEC).
//   * A session whose reconnect window elapsed while the server was down (10 min for a co-op room, 24 h for a solo run:
//     lobby.soloReconnectWindowMs). Its room is dropped too when nobody is left in it; a running match whose human seat
//     lost its session is not resumed — the room goes back to the lobby with the players that did survive.
//
// The document is one JSON object, refreshed every saveMs (default 10 s), at important transitions, and on shutdown.
// Reconnect expiry includes downtime. Incompatible document/checkpoint schemas are refused before any state write.

import { snapshotMatch, canSnapshot, SNAPSHOT_VERSION } from './match/snapshot.js';

/** Document layout version (bumped when the shape below changes). */
export const PERSIST_VERSION = 1;
/** Default interval between state writes (ms). */
export const SAVE_MS = 10_000;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------------

/**
 * One session as persisted. `disconnectedAt` is the moment its socket dropped; a session that was connected when the
 * document was written gets the write time (the crash is what cut it off — see the header).
 * @param {import('./net.js').Session} s
 * @param {number} now
 */
export function sessionDoc(s, now) {
  return {
    playerId: s.playerId,
    token: s.token,
    name: s.name,
    roomCode: s.roomCode || null,
    loadout: s.loadout || null,
    notice: s.notice || null,
    pendingResult: s.pendingResult || null,
    resumeWindowMs: typeof s.resumeWindowMs === 'number' && s.resumeWindowMs > 0 ? s.resumeWindowMs : null,
    connected: !!s.connected,
    disconnectedAt: s.connected || s.disconnectedAt == null ? now : s.disconnectedAt,
  };
}

/** One seat of a room. */
function seatDoc(seat) {
  return {
    seat: seat.seat, playerId: seat.playerId, name: seat.name, isBot: !!seat.isBot,
    ready: !!seat.ready, left: !!seat.left, connected: !!seat.connected && !seat.left,
    loadout: seat.loadout || null,
  };
}

/** One room (the match checkpoint is added by the Persister). */
export function roomDoc(room) {
  return {
    code: room.code,
    mode: room.mode,
    difficulty: room.difficulty,
    hostId: room.hostId || null,
    ownerKey: room.ownerKey || null,
    matchKey: room.matchKey || null,
    matchCount: room.matchCount | 0,
    seats: room.seats.filter(Boolean).map(seatDoc),
    spectators: room.spectators.map((s) => ({ playerId: s.playerId, name: s.name })),
    lastSummary: room.lastSummary || null,
    replay: room.replay ? { publicFrame: room.replay.publicFrame, frames: [...room.replay.frames], pending: [...room.replay.pending] } : null,
  };
}

/**
 * The whole document.
 * @param {{ registry: import('./net.js').SessionRegistry, lobby: import('./lobby.js').Lobby, matchDocs?: Map<string, object>, now: number }} args
 */
export function snapshotServer({ registry, lobby, matchDocs = null, now = Date.now() }) {
  const matches = {};
  if (matchDocs) {
    for (const [code, doc] of matchDocs) if (doc) matches[code] = doc;
  }
  return {
    v: PERSIST_VERSION,
    snapshot: SNAPSHOT_VERSION,
    savedAt: now,
    sessions: [...registry.all()].map((s) => {
      const doc = sessionDoc(s, now);
      const room = lobby.rooms.get(s.roomCode);
      if (room?.mode === 'solo' && room.match) doc.resumeWindowMs = Math.max(doc.resumeWindowMs || 0, lobby.soloResumeWindowMs());
      return doc;
    }),
    rooms: [...lobby.rooms.values()].map((room) => ({ ...roomDoc(room), hasMatch: !!room.match })),
    matches,
  };
}

// ---------------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------------

/**
 * Re-create the sessions of a document (expired ones are dropped), then the rooms, then the running matches.
 * Never throws: an unusable document is refused with a log line.
 * @param {{
 *   doc: object, registry: import('./net.js').SessionRegistry, lobby: import('./lobby.js').Lobby,
 *   now?: number, log?: object,
 * }} args
 * @returns {{ ok: boolean, reason?: string, sessions: number, expired: number, rooms: number, matches: number, droppedSeats: number }}
 */
export function restoreServer({ doc, registry, lobby, now = Date.now(), log = noopLog }) {
  const stats = { ok: false, sessions: 0, expired: 0, rooms: 0, matches: 0, droppedSeats: 0 };
  if (!doc || typeof doc !== 'object') return { ...stats, reason: 'empty' };
  if (doc.v !== PERSIST_VERSION) return { ...stats, reason: `version ${doc.v}` };
  if (doc.snapshot != null && doc.snapshot !== SNAPSHOT_VERSION) return { ...stats, reason: `snapshot ${doc.snapshot}` };

  for (const s of Array.isArray(doc.sessions) ? doc.sessions : []) {
    if (!s || typeof s.playerId !== 'string' || typeof s.token !== 'string' || !s.token) continue;
    // The last durable timestamp bounds when a crash disconnected a previously connected session.
    const since = s.connected === false && Number.isFinite(s.disconnectedAt) ? Number(s.disconnectedAt)
      : Number.isFinite(doc.savedAt) ? doc.savedAt : now;
    const windowMs = Number.isFinite(s.resumeWindowMs) && s.resumeWindowMs > 0 ? Number(s.resumeWindowMs) : null;
    const window = windowMs != null && windowMs > registry.reconnectWindowMs ? windowMs : registry.reconnectWindowMs;
    if (now - since > window) { stats.expired++; continue; }
    const session = registry.adopt({
      playerId: s.playerId,
      token: s.token,
      name: typeof s.name === 'string' ? s.name : '博士',
      disconnectedAt: since,
      resumeWindowMs: windowMs,
      roomCode: s.roomCode,
      loadout: s.loadout,
      addr: s.addr,
      notice: s.notice,
      pendingResult: s.pendingResult,
    });
    if (session) stats.sessions++;
  }

  const result = lobby.restoreRooms(Array.isArray(doc.rooms) ? doc.rooms : [], { now });
  stats.rooms = result.rooms;
  stats.droppedSeats = result.droppedSeats;

  const matches = doc.matches && typeof doc.matches === 'object' ? doc.matches : {};
  for (const room of lobby.rooms.values()) {
    const checkpoint = matches[room.code];
    if (!checkpoint) continue;
    if (lobby.restoreMatch(room, checkpoint)) stats.matches++;
    else log.warn?.(`[persist] ${room.code}: the running match could not be resumed — room kept in the lobby`);
  }
  stats.ok = true;
  return stats;
}

// ---------------------------------------------------------------------------------------------------
// periodic writer
// ---------------------------------------------------------------------------------------------------

/**
 * Refreshes safe checkpoints and writes the state document. Shutdown waits for an in-flight write and saves a
 * fresh final document before the lobby is disposed.
 */
export class Persister {
  /**
   * @param {{
   *   store: { save: (doc: object) => Promise<boolean>, log?: object },
   *   registry: import('./net.js').SessionRegistry,
   *   lobby: import('./lobby.js').Lobby,
   *   log?: object, now?: () => number, saveMs?: number,
   * }} opts
   */
  constructor({ store, registry, lobby, log = noopLog, now = Date.now, saveMs = SAVE_MS }) {
    this.store = store;
    this.registry = registry;
    this.lobby = lobby;
    this.log = log;
    this.now = now;
    this.saveMs = Math.max(1000, Number(saveMs) || SAVE_MS);
    /** @type {Map<string, object>} room code → last safe match checkpoint */
    this.matchDocs = new Map();
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.writes = 0;
    this.skipped = 0;
    this.failures = 0;
    this.running = false;
    this._busy = false;
    this._pending = null;
    this._again = false;
    this.lobby.onCheckpoint = (code, match) => {
      const doc = snapshotMatch(match);
      if (doc) this.matchDocs.set(code, doc);
      else if (!match) this.matchDocs.delete(code);
      else return;
      if (this.running) {
        if (this._busy) this._again = true;
        else void this.flush('checkpoint');
      }
    };
  }

  /** Refresh the checkpoint of every running match (a placeholder document while none is safe yet is *not* written). */
  checkpointMatches() {
    for (const [code, room] of this.lobby.rooms) {
      if (room.disposed || !room.match) { this.matchDocs.delete(code); continue; }
      if (!canSnapshot(room.match)) continue;                     // keep the last safe checkpoint
      const doc = snapshotMatch(room.match);
      if (doc) this.matchDocs.set(code, doc);
    }
    for (const code of [...this.matchDocs.keys()]) if (!this.lobby.rooms.has(code)) this.matchDocs.delete(code);
  }

  /** Build the document without writing it (tests / diagnostics). */
  document() {
    this.checkpointMatches();
    return snapshotServer({ registry: this.registry, lobby: this.lobby, matchDocs: this.matchDocs, now: this.now() });
  }

  /** One save round (never throws). */
  flush(reason = 'tick') {
    if (!this.store) return Promise.resolve(false);
    if (this._busy) return this._pending || Promise.resolve(false);
    this._busy = true;
    this._pending = (async () => { try {
      const doc = this.document();
      const ok = await this.store.save(doc);
      if (ok) this.writes++;
      else { this.failures++; this.log.debug?.(`[persist] write skipped (${reason})`); }
      return ok;
    } catch (e) {
      this.failures++;
      this.log.warn?.('[persist] save failed', e);
      return false;
    } finally {
      this._busy = false;
      this._pending = null;
      if (this._again && this.running) { this._again = false; queueMicrotask(() => { void this.flush('checkpoint'); }); }
    } })();
    return this._pending;
  }

  start() {
    if (this.running || !this.store) return this;
    this.running = true;
    this.timer = setInterval(() => { this.flush('interval').catch(() => {}); }, this.saveMs);
    this.timer.unref?.();
    return this;
  }

  /** Stop the interval. Does not flush (call flush() first when the process is shutting down). */
  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Stop and write the final document. */
  async shutdown(reason = 'shutdown') {
    this.stop();
    this._again = false;
    await this._pending;
    return this.flush(reason);
  }
}
