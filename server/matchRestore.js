// Bringing persisted rooms and a running match back to life. Lifted out of Lobby so the upstream class
// keeps four one-line seams — a call, a seat map and an adopt — instead of the restore logic woven
// through startMatch (FORK_MAINTENANCE.md: 共用文件只修改本分支的接入点).
//
// Adapted from xinhai-ai/Stronghold-Protocol (20524bb), GPL-3.0-or-later.
//
// Every entry takes the Lobby as its first argument. It deliberately does NOT import lobby.js — indeed
// `Room` is passed in, because lobby.js imports this module back and a cycle would be the only one in
// server/. `OK` / `fail` mirror Lobby's local helpers so the result shapes stay identical.

import { ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN } from '../shared/constants.js';
import { N_ } from '../shared/i18n.js';
import { botCountry } from './botPopulation.js';
import { restoreMatch as applyMatchCheckpoint } from './match/snapshot.js';
import { createRngFromState } from './sim/rng.js';

const OK = Object.freeze({ ok: true });
/** Mirrors Lobby's local `fail` (server/lobby.js): a result object, never a throw. */
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });

/**
 * The seats a match is built from: the checkpoint's players when restoring, the room's own seats
 * otherwise. Both shapes are the header's `unitInfo` input, so they must stay field-for-field equal.
 * @param {object} room
 * @param {object | null} checkpoint
 * @returns {object[]}
 */
export function seatEntries(room, checkpoint) {
  if (checkpoint) {
    return checkpoint.players.map((p) => ({
      seat: p.seat, playerId: p.playerId, name: p.name, isBot: !!p.isBot, connected: false,
      loadout: p.isBot ? null : (p.loadout || null),
      ops: p.isBot ? null : (p.ops || null),
      notOwned: p.isBot ? null : (p.notOwned || null),
      diy: p.isBot ? null : (p.diy || null),
      // 干员皮肤 (custom_docs/SKINS.md): the seat's choice rides into the Match, where PlayerState publishes it to teammates
      skins: p.isBot ? null : (p.skins || null),
    }));
  }
  return room.seats.filter(Boolean).map((s) => ({
    seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
    // DESIGN §16: the human's checked operator loadout (bots fight with the defaults)
    loadout: s.isBot ? null : s.loadout || null,
    ops: s.isBot ? null : s.ops || null,
    // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
    notOwned: s.isBot ? null : s.notOwned || null,
    // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
    diy: s.isBot ? null : s.diy || null,
    // 干员皮肤 (custom_docs/SKINS.md): the seat's choice rides into the Match, where PlayerState publishes it to teammates
    skins: s.isBot ? null : s.skins || null,
  }));
}

/**
 * Rebuild the lobby's rooms from a persisted document.
 * @param {object} lobby the Lobby (state owner; never mutated beyond its own methods)
 * @param {object[]} docs
 * @param {{ Room: new (code: string, mode: string, difficulty: string, now: number) => object, now?: number }} options
 *   `Room` is injected: this module must not import lobby.js (see the header).
 * @returns {{ rooms: number, seats: number, droppedSeats: number }}
 */
export function restoreLobbyRooms(lobby, docs, { Room, now = lobby.now() } = {}) {
  const stats = { rooms: 0, seats: 0, droppedSeats: 0 };
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || typeof d.code !== 'string' || d.code.length !== ROOM_CODE_LEN || lobby.rooms.has(d.code)) { stats.droppedSeats++; continue; }
    const mode = d.mode === 'solo' ? 'solo' : 'coop';
    const difficulty = typeof d.difficulty === 'string' && d.difficulty ? d.difficulty : 'NORMAL';
    const room = new Room(d.code, mode, difficulty, now, typeof d.roomId === 'string' ? d.roomId : null);
    if (Number.isSafeInteger(d.createdAt) && d.createdAt >= 0 && d.createdAt <= now) room.createdAt = d.createdAt;
    room.aiPicksLast = mode !== 'solo' && d.aiPicksLast === true;
    room.ownerKey = typeof d.ownerKey === 'string' ? d.ownerKey : null;
    room.matchKey = typeof d.matchKey === 'string' ? d.matchKey : null;
    room.matchCount = Number.isInteger(d.matchCount) && d.matchCount >= 0 ? d.matchCount : 0;
    for (const s of Array.isArray(d.seats) ? d.seats : []) {
      if (!s || typeof s.playerId !== 'string' || !Number.isInteger(s.seat) || s.seat < 0 || s.seat >= MAX_SEATS || room.seats[s.seat]) continue;
      const isBot = !!s.isBot;
      const left = !!s.left;
      const session = isBot ? null : lobby.registry.byId(s.playerId);
      if (!isBot && !left && (!session || lobby.registry.roomExpired(session, now))) { stats.droppedSeats++; continue; }
      room.seats[s.seat] = {
        seat: s.seat,
        playerId: s.playerId,
        name: session?.name || (typeof s.name === 'string' && s.name ? s.name : N_('博士')),
        isBot,
        ready: !!s.ready,
        connected: false,
        left,
        loadout: isBot ? null : (session?.loadout || (s.loadout && typeof s.loadout === 'object' ? s.loadout : null)),
        ops: isBot ? null : (session?.ops || s.ops || null),
        notOwned: isBot ? null : (session?.notOwned || s.notOwned || null),
        diy: isBot ? null : (session?.diy || s.diy || null),
        ...(isBot ? { botCountry: botCountry(s.botCountry) } : {}),
      };
      stats.seats++;
    }
    if (room.activeHumans().length === 0) { stats.droppedSeats += room.seats.filter(Boolean).length; continue; }
    for (const s of Array.isArray(d.spectators) ? d.spectators.slice(0, MAX_SPECTATORS) : []) {
      const session = lobby.registry.byId(s?.playerId);
      if (session && !lobby.registry.roomExpired(session, now) && !room.seatOf(session.playerId) && !room.spectatorOf(session.playerId)) {
        room.spectators.push({ playerId: session.playerId, name: session.name, connected: false });
      }
    }
    room.lastSummary = d.lastSummary || null;
    if (d.replay && Array.isArray(d.replay.frames) && Array.isArray(d.replay.pending)) {
      room.replay = { publicFrame: d.replay.publicFrame || null, frames: new Map(d.replay.frames), pending: new Set(d.replay.pending) };
    }
    room.hostId = room.seatOf(d.hostId) ? d.hostId : null;
    if (!room.hostId) lobby.migrateHost(room);
    lobby.rooms.set(room.code, room);
    for (const seat of room.seats) lobby.botPopulation.track(seat);
    stats.rooms++;
    for (const s of room.seats) if (s && !s.isBot && !s.left && !s.connected) lobby.startGrace(room, s);
    for (const s of room.spectators) lobby.startGrace(room, s);
  }
  if (stats.rooms) lobby.log.info(`[lobby] restored ${stats.rooms} room(s), ${stats.seats} seat(s)${stats.droppedSeats ? `, ${stats.droppedSeats} seat(s) dropped` : ''}`);
  return stats;
}

/**
 * Rebuild a running match from a checkpoint (server/match/snapshot.js). Every seat of the checkpoint must still be in
 * the room; otherwise nothing is restored and the room stays in the lobby (the players simply start a new match).
 * A room whose matches play in a lane Worker (server/workers/matchPool.js) answers with a Promise here: its match is
 * constructed and restored in that thread before it is ready.
 * @param {object} lobby @param {object} room @param {object} checkpoint
 * @returns {boolean | Promise<boolean>} true when the match runs again
 */
export function restoreLobbyMatch(lobby, room, checkpoint) {
  if (!room || room.disposed || room.match || !checkpoint || typeof checkpoint !== 'object') return false;
  const players = Array.isArray(checkpoint.players) ? checkpoint.players : [];
  if (players.length === 0) return false;
  for (const p of players) {
    if (!p || typeof p.playerId !== 'string' || !Number.isInteger(p.seat)) return false;
    if (!room.seatOf(p.playerId)) return false;
  }
  const res = lobby.startMatchWith(room, room.matchKey, checkpoint);
  // a lane answers later (startRemoteMatch); the local path stays synchronous, as every caller up to now expects
  if (res && typeof res.then === 'function') return res.then((r) => !(r && r.error), () => false);
  return !(res && res.error);
}

/**
 * The restore half of startMatch: apply a checkpoint to a freshly built match and adopt it, or refuse and
 * leave the room in the lobby. Called from Lobby.startMatchWith's single `if (checkpoint)` seam.
 * @param {object} lobby @param {object} room
 * @param {{ match: object, ctx: object, key: string | null, starter: object | null, checkpoint: object }} parts
 */
export function adoptRestoredMatch(lobby, room, { match, ctx, key, starter, checkpoint }) {
  if (!applyMatchCheckpoint(match, checkpoint, { createRngFromState, log: lobby.log })) {
    lobby.log.warn(`[lobby] ${room.code} match checkpoint refused — the room stays in the lobby`);
    lobby.disposeMatchCtx(ctx);
    lobby.broadcastState(room);
    return fail(ERR.INTERNAL, 'match checkpoint refused');
  }
  room.match = match;
  room.matchCtx = ctx;
  room.matchKey = key;
  room.replay = null;
  match.syncOfflinePause?.();
  lobby.audit('match.restored', starter, room, { round: match.round, phase: match.phase });
  lobby.log.info(`[lobby] ${room.code} match #${room.matchCount} restored (${room.mode}/${room.difficulty}, round ${match.round}, ${match.phase})`);
  lobby.broadcastState(room);
  lobby.checkpoint(room.code, match);
  return OK;
}
