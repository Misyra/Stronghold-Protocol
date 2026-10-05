// Adapted from xinhai-ai/Stronghold-Protocol (20524bb), GPL-3.0-or-later.
// server/persist.js — server state/checkpoints; storage backends live in server/stateFile.js (docs/PERSISTENCE.md).
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
// HOW IT IS WRITTEN. The main thread only *captures* a match (field selection, by reference — snapshot.captureMatch);
// a dedicated persistence Worker (server/workers/persistence.js) encodes and JSON-validates it off the game loop. Each
// checkpoint is stored as a clock-free body string plus a fresh clock envelope, so the store can tell an unchanged
// room (rewritten: never) from a changed one, and an idle room costs one index entry per tick instead of a full
// state rewrite. The store decides the on-disk layout: one JSON file, or a directory of per-room shards
// (server/stateFile.js). A Worker failure degrades to a synchronous encode — persistence never dies with the Worker.
//
// Reconnect expiry includes downtime. Incompatible document/checkpoint schemas are refused before any state write.

import { captureMatch, canSnapshot, SNAPSHOT_VERSION, snapshotMatch } from './match/snapshot.js';
import { PersistenceWorker } from './workers/persistenceClient.js';

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
 * The meta part of the document (sessions, rooms, version stamps). The matches and their clock envelopes are added by
 * the Persister, which owns the encoded checkpoints.
 * @param {{ registry: import('./net.js').SessionRegistry, lobby: import('./lobby.js').Lobby, now?: number }} args
 */
export function snapshotServer({ registry, lobby, now = Date.now() }) {
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
    clocks: {},
    matches: {},
  };
}

// ---------------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------------

/**
 * Re-create the sessions of a document (expired ones are dropped), then the rooms, then the running matches.
 * Never throws: an unusable document is refused with a log line. Both checkpoint layouts are accepted — clocks in a
 * `clocks` envelope (what the Persister writes) or inline in the checkpoint (older documents).
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
      name: typeof s.name === 'string' && s.name ? s.name : '博士',
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
  const clocks = doc.clocks && typeof doc.clocks === 'object' ? doc.clocks : {};
  for (const room of lobby.rooms.values()) {
    const checkpoint = matches[room.code];
    if (!checkpoint) continue;
    // the envelope carries the freshest clocks (the index is written after the shards); inline values are the fallback
    const c = clocks[room.code];
    const restored = c && typeof c === 'object' ? { ...checkpoint } : checkpoint;
    if (restored !== checkpoint) {
      if (Number.isFinite(c.deadlineRemainingMs)) restored.deadlineRemainingMs = c.deadlineRemainingMs;
      if (Number.isFinite(c.startedAtAgoMs)) restored.startedAtAgoMs = c.startedAtAgoMs;
    }
    if (lobby.restoreMatch(room, restored)) stats.matches++;
    else log.warn?.(`[persist] ${room.code}: the running match could not be resumed — room kept in the lobby`);
  }
  stats.ok = true;
  return stats;
}

// ---------------------------------------------------------------------------------------------------
// periodic writer
// ---------------------------------------------------------------------------------------------------

/**
 * Keeps the state document up to date: every tick it refreshes the checkpoint of each running match that is in a
 * checkpointable phase. The main thread only captures; the persistence Worker encodes. An encode may outlive its
 * match, so a checkpoint is committed only while it still belongs to the room's *current* match. A graceful shutdown
 * waits for an in-flight write and saves a fresh final document before the lobby is disposed.
 */
export class Persister {
  /**
   * @param {{
   *   store: { save?: (doc: object) => Promise<boolean>, saveSharded?: (payload: object) => Promise<boolean>, log?: object },
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
    /** Encoded clock-free checkpoint bodies per room code (JSON text; written to a shard verbatim). */
    this.matchDocs = new Map();
    /** Fresh phase clocks per room code (deadlineRemainingMs / startedAtAgoMs; written into the document envelope). */
    this.matchClocks = new Map();
    this.encoder = new PersistenceWorker();
    /** False while the Worker is failing and checkpoints encode inline (warned once per streak). */
    this._workerHealthy = true;
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
      if (!match) {
        this.matchDocs.delete(code);
        this.matchClocks.delete(code);
        if (this.running) this.scheduleFlush('checkpoint');
        return;
      }
      this.encodeRoom(code, match).then((encoded) => {
        if (encoded && this.running) this.scheduleFlush('checkpoint');
      }, () => {});
    };
  }

  /** Refresh every checkpointable match (Worker-encoded, one room at a time); drop checkpoints of gone rooms. */
  async checkpointMatches() {
    for (const code of [...this.matchDocs.keys()]) {
      if (!this.lobby.rooms.has(code)) { this.matchDocs.delete(code); this.matchClocks.delete(code); }
    }
    for (const [code, room] of this.lobby.rooms) {
      if (room.disposed || !room.match) continue;
      await this.encodeRoom(code, room.match);
    }
  }

  /**
   * Capture one room's match and encode it — Worker first, a fresh synchronous capture as the fallback. Never throws.
   * @returns {Promise<boolean>} true when a checkpoint of the room's current match was committed
   */
  async encodeRoom(code, match) {
    if (!canSnapshot(match)) return false;           // unsafe phase: keep the last checkpoint
    const capture = captureMatch(match);
    if (!capture) return false;
    let clocks = null;
    let body = null;
    try {
      ({ clocks, body } = await this.encoder.request('encode', { capture }));
      this._workerHealthy = true;
    } catch (err) {
      // Re-capture synchronously: the posted capture held references that may have moved on while the Worker died.
      const doc = snapshotMatch(match);
      if (!doc) return false;
      const { deadlineRemainingMs, startedAtAgoMs, ...rest } = doc;
      clocks = { deadlineRemainingMs, startedAtAgoMs };
      body = JSON.stringify(rest);
      if (this._workerHealthy !== false) {
        this._workerHealthy = false;
        this.log.warn?.(`[persist] persistence worker unavailable, encoding inline (${err?.message}); will retry the Worker every save`);
      }
    }
    return this.commit(code, match, clocks, body);
  }

  /** A room's encode may outlive its match: only a checkpoint of the room's *current* match is committed. */
  commit(code, match, clocks, body) {
    const room = this.lobby.rooms.get(code);
    if (!room || room.disposed || room.match !== match) return false;
    this.matchDocs.set(code, body);
    this.matchClocks.set(code, clocks);
    return true;
  }

  /** Assemble the document in the classic layout (clocks merged back into each checkpoint) for object-based stores. */
  legacyDocument(meta) {
    const clocks = Object.fromEntries(this.matchClocks);
    const doc = { ...meta, clocks, matches: {} };
    for (const [code, body] of this.matchDocs) {
      const parsed = JSON.parse(body);
      const c = clocks[code];
      doc.matches[code] = c ? { ...parsed, deadlineRemainingMs: c.deadlineRemainingMs, startedAtAgoMs: c.startedAtAgoMs } : parsed;
    }
    return doc;
  }

  /** Diagnostic API: the whole document in the classic layout, after refreshing the checkpoints. */
  async document() {
    await this.checkpointMatches();
    return this.legacyDocument(snapshotServer({ registry: this.registry, lobby: this.lobby, now: this.now() }));
  }

  /** One save round (never throws). */
  flush(reason = 'tick') {
    if (!this.store) return Promise.resolve(false);
    if (this._busy) return this._pending || Promise.resolve(false);
    // Capture the meta synchronously, at flush() call time: a shutdown's final write must hold the state as of the
    // moment it was asked for, not whatever the lobby looks like by the time the Worker answers.
    const meta = snapshotServer({ registry: this.registry, lobby: this.lobby, now: this.now() });
    this._busy = true;
    this._pending = (async () => { try {
      await this.checkpointMatches();
      const ok = typeof this.store.saveSharded === 'function'
        ? await this.store.saveSharded({ index: { ...meta, clocks: Object.fromEntries(this.matchClocks) }, shards: this.matchDocs })
        : await this.store.save(this.legacyDocument(meta));
      if (ok) this.writes++;
      else { this.failures++; this.skipped++; this.log.debug?.(`[persist] write skipped (${reason})`); }
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

  /** Ask for a flush: coalesced while one is already running (it re-runs once when the write settles). */
  scheduleFlush(reason) {
    if (this._busy) { this._again = true; return; }
    void this.flush(reason);
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
    try { return await this.flush(reason); }
    finally { await this.encoder.close(); }
  }
}
