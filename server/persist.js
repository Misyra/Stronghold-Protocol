// Adapted from xinhai-ai/Stronghold-Protocol (20524bb), GPL-3.0-or-later.
// server/persist.js — server state/checkpoints; storage backends live in server/stateFile.js (custom_docs/operations/PERSISTENCE.md).
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
// room (rewritten: never) from a changed one. Directory stores refresh only a small runtime file for clocks and the
// server heartbeat; their sessions/rooms index changes only with metadata. The store decides the on-disk layout
// (server/stateFile.js). A Worker failure degrades to a synchronous encode — persistence never dies with the Worker.
//
// Reconnect expiry includes downtime. Incompatible document/checkpoint schemas are refused before any state write.

import { splitClocks, mergeClocks } from './stateClocks.js';
import { captureMatch, canSnapshot, encodeMatchCapture, matchClocks, persistVersion, SNAPSHOT_VERSION, snapshotMatch } from './match/snapshot.js';
import { PersistenceWorker } from './workers/persistenceClient.js';
import { N_ } from '../shared/i18n.js';
import { chatRetentionUntil } from './moderation/chatState.js';
import { performance } from 'node:perf_hooks';
import { botCountry } from './botPopulation.js';
import { foreignSessionKey } from './foreignSessions.js';

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
 * document was written has no disconnect time; recovery uses the last durable heartbeat (see the header).
 * @param {import('./net.js').Session} s
 * @param {number} now
 */
export function sessionDoc(s, now) {
  return {
    playerId: s.playerId,
    token: s.token,
    name: s.name,
    roomCode: s.roomCode || null,
    ...(foreignSessionKey(s.foreignSessionKey) ? { foreignSessionKey: s.foreignSessionKey } : {}),
    loadout: s.loadout || null,
    ops: s.ops || null,
    notOwned: s.notOwned || null,
    diy: s.diy || null,
    notice: s.notice || null,
    pendingResult: s.pendingResult || null,
    chatStrikes: Number.isInteger(s.chatStrikes) && s.chatStrikes > 0 ? s.chatStrikes : 0,
    chatLastHitAt: Number.isFinite(s.chatLastHitAt) && s.chatLastHitAt > 0 ? s.chatLastHitAt : 0,
    chatMutedUntil: s.chatMutedUntil,
    resumeWindowMs: typeof s.resumeWindowMs === 'number' && s.resumeWindowMs > 0 ? s.resumeWindowMs : null,
    connected: !!s.connected,
    // A connected session has no disconnect time — writing `now` here would dirty every online session on every
    // save. restoreServer bounds a crash cut-off with doc.savedAt, which is the same stamp the old write produced.
    disconnectedAt: s.connected ? null : s.disconnectedAt == null ? now : s.disconnectedAt,
  };
}

/** One seat of a room. */
function seatDoc(seat) {
  return {
    seat: seat.seat, playerId: seat.playerId, name: seat.name, isBot: !!seat.isBot,
    ready: !!seat.ready, left: !!seat.left, connected: !!seat.connected && !seat.left,
    ...(seat.isBot && botCountry(seat.botCountry) ? { botCountry: seat.botCountry } : {}),
    loadout: seat.loadout || null,
    ops: seat.ops || null,
    notOwned: seat.notOwned || null,
    diy: seat.diy || null,
  };
}

const replayFrames = new WeakMap();
function replayFrameList(frames) {
  let cached = replayFrames.get(frames);
  if (!cached || cached.size !== frames.size) {
    cached = { size: frames.size, value: [...frames] };
    replayFrames.set(frames, cached);
  }
  return cached.value;
}

/** One room (the match checkpoint is added by the Persister). */
export function roomDoc(room) {
  return {
    code: room.code,
    // Room instance id travels with the room: a restored room keeps the id the browser and the 联机站 already know it
    // by, so a restart does not read as "this code now points at a different room" (that would drop its registration).
    // Documents written before this field existed carry none — the reader mints one and the next save writes it.
    roomId: room.roomId,
    createdAt: room.createdAt,
    mode: room.mode,
    difficulty: room.difficulty,
    aiPicksLast: room.aiPicksLast === true,
    hostId: room.hostId || null,
    ownerKey: room.ownerKey || null,
    matchKey: room.matchKey || null,
    matchCount: room.matchCount | 0,
    seats: room.seats.filter(Boolean).map(seatDoc),
    spectators: room.spectators.map((s) => ({ playerId: s.playerId, name: s.name })),
    lastSummary: room.lastSummary || null,
    replay: room.replay ? { publicFrame: room.replay.publicFrame, frames: replayFrameList(room.replay.frames), pending: [...room.replay.pending] } : null,
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
export function restoreServer(args) {
  return restoreServerCore(args, false).stats;
}

/**
 * The boot path (server/index.js): the same restore, but a room whose match plays in a lane Worker
 * (server/workers/matchPool.js) is awaited — that thread builds and applies the checkpoint before the server listens.
 * The synchronous restoreServer stays for every caller that owns no Worker (tests, a stub lobby).
 * @param {Parameters<typeof restoreServer>[0]} args
 * @returns {Promise<ReturnType<typeof restoreServer>>}
 */
export async function restoreServerForBoot(args) {
  const { stats, pending } = restoreServerCore(args, true);
  await Promise.all(pending);
  return stats;
}

/**
 * @param {{ doc: object, registry: import('./net.js').SessionRegistry, lobby: import('./lobby.js').Lobby,
 *   now?: number, log?: object }} args
 * @param {boolean} lanes true: a Promise from lobby.restoreMatch (a lane Worker) is collected instead of dropped
 */
function restoreServerCore({ doc, registry, lobby, now = Date.now(), log = noopLog }, lanes) {
  /** @type {Promise<void>[]} restores a lane Worker still owes this restore */
  const pending = [];
  const stats = { ok: false, sessions: 0, expired: 0, rooms: 0, matches: 0, droppedSeats: 0 };
  if (!doc || typeof doc !== 'object') return { stats: { ...stats, reason: 'empty' }, pending };
  if (doc.v !== PERSIST_VERSION) return { stats: { ...stats, reason: `version ${doc.v}` }, pending };
  if (doc.snapshot != null && doc.snapshot !== SNAPSHOT_VERSION) return { stats: { ...stats, reason: `snapshot ${doc.snapshot}` }, pending };

  for (const s of Array.isArray(doc.sessions) ? doc.sessions : []) {
    if (!s || typeof s.playerId !== 'string' || typeof s.token !== 'string' || !s.token) continue;
    // The last durable timestamp bounds when a crash disconnected a previously connected session.
    const since = s.connected === false && Number.isFinite(s.disconnectedAt) ? Number(s.disconnectedAt)
      : Number.isFinite(doc.savedAt) ? doc.savedAt : now;
    const windowMs = Number.isFinite(s.resumeWindowMs) && s.resumeWindowMs > 0 ? Number(s.resumeWindowMs) : null;
    const window = windowMs != null && windowMs > registry.reconnectWindowMs ? windowMs : registry.reconnectWindowMs;
    if (now - since > window && chatRetentionUntil(s, now) <= now) { stats.expired++; continue; }
    const session = registry.adopt({
      playerId: s.playerId,
      token: s.token,
      name: typeof s.name === 'string' && s.name ? s.name : N_('博士'),
      disconnectedAt: since,
      resumeWindowMs: windowMs,
      roomCode: s.roomCode,
      loadout: s.loadout,
      ops: s.ops,
      notOwned: s.notOwned,
      diy: s.diy,
      addr: s.addr,
      foreignSessionKey: s.foreignSessionKey,
      notice: s.notice,
      pendingResult: s.pendingResult,
      chatStrikes: s.chatStrikes,
      chatLastHitAt: s.chatLastHitAt,
      chatMutedUntil: s.chatMutedUntil,
    });
    if (session) {
      if (registry.roomExpired(session, now)) { session.roomCode = null; session.notice = 'timeout'; session.pendingResult = null; }
      stats.sessions++;
    }
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
      Object.assign(restored, mergeClocks(restored, c));
    }
    const resumed = lobby.restoreMatch(room, restored);
    if (resumed && typeof resumed.then === 'function') {
      // a lane Worker's match (server/workers/matchPool.js): it is restored in that thread; the caller awaits it
      if (!lanes) { stats.matches++; continue; }   // a synchronous caller cannot wait: the lane applies it anyway
      pending.push(resumed.then((ok) => {
        if (ok) stats.matches++;
        else log.warn?.(`[persist] ${room.code}: the running match could not be resumed — room kept in the lobby`);
      }, () => log.warn?.(`[persist] ${room.code}: the running match could not be resumed — room kept in the lobby`)));
    } else if (resumed === true) stats.matches++;
    else log.warn?.(`[persist] ${room.code}: the running match could not be resumed — room kept in the lobby`);
  }
  stats.ok = true;
  return { stats, pending };
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
   *   log?: object, now?: () => number, saveMs?: number, minFlushMs?: number, verifyVersion?: boolean,
   * }} opts
   */
  constructor({ store, registry, lobby, log = noopLog, now = Date.now, saveMs = SAVE_MS, minFlushMs, verifyVersion }) {
    this.store = store;
    this.registry = registry;
    this.lobby = lobby;
    this.log = log;
    this.now = now;
    this.saveMs = Math.max(1000, Number(saveMs) || SAVE_MS);
    /** Minimum gap between two write rounds: checkpoint events coalesce into the next slot instead of a hot loop. */
    this.minFlushMs = minFlushMs == null ? this.saveMs : Math.max(0, Number(minFlushMs) || 0);
    /** Encoded clock-free checkpoint bodies per room code (JSON text; written to a shard verbatim). */
    this.matchDocs = new Map();
    this.metadataTokens = new WeakMap();
    this.metadataTokenSeq = 0;
    this.metadataVersion = 0;
    this.metadataSignature = null;
    /** Fresh phase clocks per room code (deadlineRemainingMs / startedAtAgoMs; written into the document envelope). */
    this.matchClocks = new Map();
    /**
     * The persistence version each stored checkpoint body was encoded at, per room code, together with the match it
     * belongs to (snapshot.js persistVersion). An unchanged version means capture, cross-thread clone and codec are
     * all skipped and only the clock envelope is refreshed.
     */
    this.matchVersions = new Map();
    /**
     * True (or SP_PERSIST_VERIFY=1) to prove the version on live traffic: a room whose version says "unchanged" is
     * encoded anyway and the body compared with the stored one. A difference is counted in `versionHoles` and logged,
     * and the fresh body is committed, so verification never persists a stale checkpoint.
     */
    this.verifyVersion = verifyVersion ?? process.env.SP_PERSIST_VERIFY === '1';
    /** Checkpoint bookkeeping: encodes, skips (nothing changed), verified comparisons, and version misses. */
    this.versionStats = { encodes: 0, skipped: 0, verified: 0, holes: 0 };
    this.encoder = new PersistenceWorker();
    this.checkpointPending = new Set();
    /**
     * True while the startup read has not succeeded (Redis down, or the document is not a state document): no write may
     * run, or it would replace a state document that was never recovered. deferLoad / retryLoad, as in xinhai.
     */
    this.pendingLoad = false;
    /** Save rounds refused while pendingLoad held (diagnostics). */
    this.deferredSkips = 0;
    /** @type {Promise<boolean> | null} one recovery attempt at a time */
    this._loadRetry = null;
    /** False while the Worker is failing and checkpoints encode inline (warned once per streak). */
    this._workerHealthy = true;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.writes = 0;
    this.skipped = 0;
    this.failures = 0;
    this.lastSaveMs = null;
    this.running = false;
    this._busy = false;
    this._pending = null;
    this._again = false;
    /** @type {NodeJS.Timeout | null} the deferred flush slot (see flush) */
    this._cooldownTimer = null;
    this._lastFlushAt = -Infinity;
    const onCheckpoint = (code, match) => {
      if (!match) {
        this.matchDocs.delete(code);
        this.matchClocks.delete(code);
        this.matchVersions.delete(code);
        if (this.running) this.scheduleFlush('checkpoint');
        return;
      }
      const pending = this.encodeRoom(code, match);
      this.checkpointPending.add(pending);
      void pending.then((encoded) => {
        if (encoded && this.running) this.scheduleFlush('checkpoint');
      }).catch(() => {}).finally(() => this.checkpointPending.delete(pending));
    };
    // Test doubles may expose only the legacy hook.
    if (this.lobby.subscribeCheckpoint) this.unsubscribeCheckpoint = this.lobby.subscribeCheckpoint(onCheckpoint);
    else {
      const previous = this.lobby.onCheckpoint;
      const handler = (code, match) => { previous?.(code, match); onCheckpoint(code, match); };
      this.lobby.onCheckpoint = handler;
      this.unsubscribeCheckpoint = () => { if (this.lobby.onCheckpoint === handler) this.lobby.onCheckpoint = previous; };
    }
  }

  /** Heavy terminal records are replaced, never edited during live operation. Compare their identity once. */
  versionMetadata(meta) {
    const token = (value) => {
      if (!value || typeof value !== 'object') return value;
      if (!this.metadataTokens.has(value)) this.metadataTokens.set(value, ++this.metadataTokenSeq);
      return this.metadataTokens.get(value);
    };
    const signature = JSON.stringify({ sessions: meta.sessions, rooms: meta.rooms.map((room) => ({
      ...room, lastSummary: token(room.lastSummary),
      replay: room.replay ? { frames: token(room.replay.frames), pending: room.replay.pending } : null,
    })) });
    if (signature !== this.metadataSignature) { this.metadataSignature = signature; this.metadataVersion++; }
    return this.metadataVersion;
  }

  /** Refresh every checkpointable match (Worker-encoded, one room at a time); drop checkpoints of gone rooms. */
  async checkpointMatches() {
    for (const code of [...this.matchDocs.keys()]) {
      if (!this.lobby.rooms.has(code)) {
        this.matchDocs.delete(code);
        this.matchClocks.delete(code);
        this.matchVersions.delete(code);
      }
    }
    for (const [code, room] of this.lobby.rooms) {
      if (room.disposed || !room.match) continue;
      await this.encodeRoom(code, room.match);
    }
  }

  /**
   * The startup read failed (Redis unreachable, or the document is not a state document): refuse to write until it can
   * be read. Same contract as xinhai-ai/Stronghold-Protocol's Persister.deferLoad — a save here would overwrite a state
   * document this process never saw.
   */
  deferLoad() {
    this.pendingLoad = true;
  }

  /**
   * Re-read the document the startup read missed: when it arrives, restore it (matches included — including one in a
   * lane Worker, server/index.js boot path) and keep its checkpoints, so the first save of this run cannot drop them.
   * @returns {Promise<boolean>} true when writes may proceed
   */
  retryLoad() {
    if (!this.pendingLoad) return Promise.resolve(true);
    if (this._loadRetry) return this._loadRetry;
    this._loadRetry = (async () => {
      let doc = null;
      try { doc = await this.store.load({ attempts: 1 }); }
      catch (e) { this.log.warn?.('[persist] the deferred state read failed again', e); }
      // Still unreadable (or still not a document): keep refusing. An empty store is a fresh start.
      if (!doc && ['unavailable', 'invalid'].includes(this.store.loadState)) return false;
      if (doc) {
        const stats = await restoreServerForBoot({ doc, registry: this.registry, lobby: this.lobby, now: this.now(), log: this.log });
        if (!stats.ok) return false;
        this.seedMatches(doc);
        this.log.info?.(
          '[persist] deferred state recovered (' + stats.sessions + ' sessions, ' + stats.rooms + ' rooms, '
          + stats.matches + ' matches)');
      }
      this.pendingLoad = false;
      return true;
    })().finally(() => { this._loadRetry = null; });
    return this._loadRetry;
  }

  /**
   * Keep a recovered document's checkpoints: they are already the clock-free bodies the shards hold (commit / flush),
   * and their clocks live in the document envelope.
   * @param {object} doc a state document (snapshotServer shape)
   */
  seedMatches(doc) {
    const matches = doc?.matches && typeof doc.matches === 'object' ? doc.matches : {};
    const clocks = doc?.clocks && typeof doc.clocks === 'object' ? doc.clocks : {};
    for (const [code, checkpoint] of Object.entries(matches)) {
      if (!checkpoint || typeof checkpoint !== 'object') continue;
      const { deadlineRemainingMs, startedAtAgoMs, ...body } = checkpoint;
      try { this.matchDocs.set(code, JSON.stringify(body)); }
      catch { continue; }                      // an unusable checkpoint is dropped, never saved as text
      const c = clocks[code];
      const remaining = c && typeof c === 'object' ? c.deadlineRemainingMs : deadlineRemainingMs;
      const started = c && typeof c === 'object' ? c.startedAtAgoMs : startedAtAgoMs;
      if (Number.isFinite(remaining) || Number.isFinite(started)) {
        this.matchClocks.set(code, { deadlineRemainingMs: Number(remaining) || 0, startedAtAgoMs: Number(started) || 0 });
      }
    }
  }

  /**
   * Capture one room's match and encode it — Worker first, a fresh synchronous capture as the fallback. Never throws.
   *
   * A room whose persistence version (snapshot.js persistVersion) is unchanged since its stored body was written
   * skips all of it: no capture, no structured clone across the Worker boundary, no codec, no JSON round trip — the
   * clock envelope is refreshed and the body on disk stays byte-identical. With `verifyVersion` the encode still runs
   * and the body is compared instead of trusted (see the constructor).
   * @returns {Promise<boolean>} true when a checkpoint of the room's current match was committed
   */
  async encodeRoom(code, match) {
    // A match in a lane Worker (server/workers/matchPool.js) keeps its state in that thread: its phase is known from the
    // pool's metadata and a capture is one round trip away. The version skip therefore does not apply to it — every save
    // round asks for a capture, which stalls neither the game loop here nor the match loop there.
    const remote = match?.remote === true;
    if (remote ? match.snapshotable === false : !canSnapshot(match)) return false; // unsafe phase: keep the last checkpoint
    const version = remote ? match.persistVersion ?? '' : persistVersion(match);
    const stored = this.matchVersions.get(code);
    const unchanged = !remote && !!(stored && stored.match === match && stored.version === version);
    if (unchanged && !this.verifyVersion) {
      this.matchClocks.set(code, matchClocks(match));
      this.versionStats.skipped++;
      return false;
    }
    const capture = remote ? await match.captureSnapshot() : captureMatch(match);
    if (!capture) return false;
    let clocks, body;
    try {
      ({ clocks, body } = await this.encoder.request('encode', { capture }));
      this._workerHealthy = true;
    } catch (err) {
      // Re-capture synchronously: the posted capture held references that may have moved on while the Worker died.
      // A lane Worker's match cannot be recaptured here (its state is not on this thread): its own capture is already
      // a consistent, thread-crossed snapshot, so it is encoded inline instead.
      const doc = remote ? encodeMatchCapture(capture) : snapshotMatch(match);
      if (!doc) return false;
      const split = splitClocks(doc);
      clocks = split.clocks;
      body = JSON.stringify(split.body);
      if (this._workerHealthy !== false) {
        this._workerHealthy = false;
        this.log.warn?.(`[persist] persistence worker unavailable, encoding inline (${err?.message}); will retry the Worker every save`);
      }
    }
    if (unchanged) {
      // Verification round: the body must be the one already stored, or the version missed a change.
      this.versionStats.verified++;
      if (this.matchDocs.get(code) === body) {
        this.matchClocks.set(code, clocks);
        this.versionStats.skipped++;
        return false;
      }
      this.versionStats.holes++;
      this.log.warn?.(`[persist] ${code}: the persistence version missed a change — the checkpoint was re-encoded (report this with the match phase and round)`);
    }
    this.versionStats.encodes++;
    return this.commit(code, match, clocks, body, version);
  }

  /** A room's encode may outlive its match: only a checkpoint of the room's *current* match is committed. */
  commit(code, match, clocks, body, version) {
    const room = this.lobby.rooms.get(code);
    if (!room || room.disposed || room.match !== match) return false;
    this.matchDocs.set(code, body);
    this.matchClocks.set(code, clocks);
    this.matchVersions.set(code, { match, version });
    return true;
  }

  /** Assemble the document in the classic layout (clocks merged back into each checkpoint) for object-based stores. */
  legacyDocument(meta) {
    const clocks = Object.fromEntries(this.matchClocks);
    const doc = { ...meta, clocks, matches: {} };
    for (const [code, body] of this.matchDocs) {
      const parsed = JSON.parse(body);
      const c = clocks[code];
      doc.matches[code] = mergeClocks(parsed, c);
    }
    return doc;
  }

  /** Diagnostic API: the whole document in the classic layout, after refreshing the checkpoints. */
  async document() {
    await this.checkpointMatches();
    return this.legacyDocument(snapshotServer({ registry: this.registry, lobby: this.lobby, now: this.now() }));
  }

  /** One save round (never throws). Rounds run at most once per minFlushMs; shutdown/test bypass the gap. */
  flush(reason = 'tick') {
    if (!this.store) return Promise.resolve(false);
    // A save may not run while the startup read is outstanding: recover first, then save with fresh metadata (the
    // restore adds sessions and rooms, so a document captured before it would be missing them).
    if (this.pendingLoad) return this._flushAfterLoad(reason);
    if (this._busy) return this._pending || Promise.resolve(false);
    // Checkpoint events arrive far faster than saves are useful; an immediate re-run here (queueMicrotask) kept the
    // loop hot forever under load. Defer into the next free slot instead — the saveMs contract bounds everything.
    // Only the live loop defers: shutdown() has stopped the persister, and tests drive explicit rounds.
    if (this.running && reason !== 'test') {
      const since = this.now() - this._lastFlushAt;
      if (since < this.minFlushMs) {
        this._again = true;
        this._armCooldown(this.minFlushMs - since);
        return Promise.resolve(false);
      }
    }
    if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null; }
    this._again = false;                             // this round consumes the outstanding request
    // Capture the meta synchronously, at flush() call time: a shutdown's final write must hold the state as of the
    // moment it was asked for, not whatever the lobby looks like by the time the Worker answers.
    const meta = snapshotServer({ registry: this.registry, lobby: this.lobby, now: this.now() });
    this._busy = true;
    const saveStarted = performance.now();
    this._lastFlushAt = this.now();
    this._pending = (async () => { try {
      await this.checkpointMatches();
      const ok = typeof this.store.saveSharded === 'function'
        ? await this.store.saveSharded({ index: { ...meta, clocks: Object.fromEntries(this.matchClocks) }, shards: this.matchDocs, metadataVersion: this.versionMetadata(meta) })
        : await this.store.save(this.legacyDocument(meta));
      if (ok) this.writes++;
      else { this.failures++; this.skipped++; this.log.debug?.(`[persist] write skipped (${reason})`); }
      return ok;
    } catch (e) {
      this.failures++;
      this.log.warn?.('[persist] save failed', e);
      return false;
    } finally {
      this.lastSaveMs = performance.now() - saveStarted;
      this._busy = false;
      this._pending = null;
      if (this._again && this.running) this._armCooldown(Math.max(0, this.minFlushMs - (this.now() - this._lastFlushAt)));
    } })();
    return this._pending;
  }

  /** flush() while the startup read is outstanding: retry it, then save normally — or refuse this round. */
  async _flushAfterLoad(reason) {
    // A shutdown does not wait out a slow read: the store is unreachable, and the document on its side is untouched.
    if (reason !== 'shutdown' && await this.retryLoad()) return this.flush(reason);
    this.deferredSkips++;
    this.log.warn?.(`[persist] 启动时的存档还没读到（${this.store.loadState || 'unknown'}），本轮不写，以免覆盖它`);
    return false;
  }
  /** Schedule the deferred flush slot (coalesced; a flush that starts first clears it). */
  _armCooldown(delayMs) {
    if (this._cooldownTimer || !this.running) return;
    this._cooldownTimer = setTimeout(() => {
      this._cooldownTimer = null;
      if (this._again && this.running) { this._again = false; void this.flush('checkpoint'); }
    }, delayMs);
    this._cooldownTimer.unref?.();
  }

  /** Ask for a flush: coalesced into the next write slot — at most one round per minFlushMs (shutdown bypasses). */
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
    if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null; }
  }

  /** Release the encoder without saving, including after a failed startup. */
  async dispose() {
    this.stop();
    this._again = false;
    this.unsubscribeCheckpoint();
    await this._pending;
    await Promise.allSettled([...this.checkpointPending]);
    await this.encoder.close();
  }

  /** Stop and write the final document. */
  async shutdown(reason = 'shutdown') {
    this.stop();
    this._again = false;
    this.unsubscribeCheckpoint();
    await this._pending;
    await Promise.allSettled([...this.checkpointPending]);
    try { return await this.flush(reason); }
    finally { this.unsubscribeCheckpoint(); await this.encoder.close(); }
  }
}
