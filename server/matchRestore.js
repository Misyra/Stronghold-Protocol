// Bringing persisted rooms and a running match back to life (移植自用户分支). Lifted out of Lobby so the class
// keeps four one-line seams — a call, a seat map and an adopt — instead of the restore logic woven
// through startMatch.
//
// Adapted from xinhai-ai/Stronghold-Protocol (20524bb), GPL-3.0-or-later.
//
// Every entry takes the Lobby as its first argument. It deliberately does NOT import lobby.js — indeed
// `Room` is passed in, because lobby.js imports this module back and a cycle would be the only one in
// server/. `OK` / `fail` mirror Lobby's local helpers so the result shapes stay identical.

import { randomUUID } from 'node:crypto';
import { ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN } from '../shared/constants.js';
import { N_ } from '../shared/i18n.js';
import { DEFAULT_VERSION } from '../shared/versions.js';
import { restoreMatch as applyMatchCheckpoint } from './match/snapshot.js';
import { createRngFromState } from './sim/rng.js';

const OK = Object.freeze({ ok: true });
/** Mirrors Lobby's local `fail` (server/lobby.js): a result object, never a throw. */
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });

/**
 * The content a restored room plays (roomDoc.content). The resolved set is rebuilt through Lobby.resolveContent with
 * the persisted plugin ids and settings — the same seam setPlugins uses — so a plugin set that changed on disk is
 * re-applied rather than frozen, and the room holds its set again (Lobby.holdContent, counted against maxSets).
 *
 * A set that can no longer be made (a plugin uninstalled, refused by the server policy, or a modded room whose plugin
 * list is gone) refuses the room: silently restoring it as the original game would let an unofficial room into the
 * official matchmaking queue. Old documents carry no content: the room gets its version's base content, which is the
 * best the document can say.
 * @param {object} lobby @param {object} room @param {object} d the persisted room
 * @returns {object | null | undefined} the content, null for a lobby with no content identity, undefined = refuse
 */
function restoredContent(lobby, room, d) {
  const doc = d.content;
  if (!doc || typeof doc !== 'object' || typeof doc.cs !== 'string' || !doc.cs) {
    const base = lobby.baseContent(room.version);
    if (room.version !== DEFAULT_VERSION && !base) {
      lobby.log.warn?.(`[lobby] ${room.code}: the content of ${room.version} is no longer available — the room is not restored`);
      return undefined;
    }
    return base || null;
  }
  const plugins = Array.isArray(doc.plugins) ? doc.plugins : [];
  const ids = [...new Set(plugins.filter((p) => p && typeof p.id === 'string' && p.id && !p.auto).map((p) => p.id))];
  const settings = {};
  for (const p of plugins) if (p && typeof p.id === 'string' && p.settings && typeof p.settings === 'object') settings[p.id] = p.settings;
  const r = lobby.resolveContent(room, ids, settings, room.version, null);
  if ('error' in r || !r.content) {
    lobby.log.warn?.(`[lobby] ${room.code}: the room's content ${String(doc.cs).slice(0, 8)} is no longer available (${'error' in r ? r.error : 'none'}) — the room is not restored`);
    return undefined;
  }
  // A room that was modded must stay modded: an empty plugin list resolving to the version base is exactly the silent
  // degradation this restore path exists to prevent.
  if (doc.vanilla === false && r.content.vanilla !== false) {
    lobby.log.warn?.(`[lobby] ${room.code}: the room's content set ${String(doc.cs).slice(0, 8)} is gone — the room is not restored`);
    return undefined;
  }
  // the mode the room picked survives while the set still provides it (Lobby.setPlugins / setMode)
  const content = doc.modeId && r.content.modes?.some((m) => m && m.id === doc.modeId)
    ? Object.freeze({ ...r.content, modeId: doc.modeId })
    : r.content;
  lobby.holdContent(content);
  return content;
}


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
      // 干员皮肤 (docs/SKINS.md): the seat's choice rides into the Match, where PlayerState publishes it to teammates
      skins: p.isBot ? null : (p.skins || null),
      // room.setBotBand: the AI seat's designated strategy, restored with its checkpoint
      ...(p.isBot && p.band ? { band: p.band } : {}),
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
    // 干员皮肤 (docs/SKINS.md): the seat's choice rides into the Match, where PlayerState publishes it to teammates
    skins: s.isBot ? null : s.skins || null,
    // room.setBotBand (移植自用户分支): the AI seat's designated strategy (absent when it picks by itself)
    ...(s.isBot && s.band ? { band: s.band } : {}),
  }));
}

/**
 * Rebuild the lobby's rooms from a persisted document.
 * @param {object} lobby the Lobby (state owner; never mutated beyond its own methods)
 * @param {object[]} docs
 * @param {{ Room: new (code: string, mode: string, difficulty: string, now: number, version?: string) => object, now?: number }} options
 *   `Room` is injected: this module must not import lobby.js (see the header).
 * @returns {{ rooms: number, seats: number, droppedSeats: number }}
 */
export function restoreLobbyRooms(lobby, docs, { Room, now = lobby.now() } = {}) {
  const stats = { rooms: 0, seats: 0, droppedSeats: 0 };
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || typeof d.code !== 'string' || d.code.length !== ROOM_CODE_LEN || lobby.rooms.has(d.code)) { stats.droppedSeats++; continue; }
    const mode = d.mode === 'solo' ? 'solo' : 'coop';
    const difficulty = typeof d.difficulty === 'string' && d.difficulty ? d.difficulty : 'NORMAL';
    const room = new Room(d.code, mode, difficulty, now, typeof d.version === 'string' && d.version ? d.version : undefined);
    // the room instance id (roomDoc): mint one when the document predates the field
    room.roomId = typeof d.roomId === 'string' && d.roomId ? d.roomId : randomUUID();
    if (Number.isSafeInteger(d.createdAt) && d.createdAt >= 0 && d.createdAt <= now) room.createdAt = d.createdAt;
    room.aiPicksLast = mode !== 'solo' && d.aiPicksLast === true;
    room.bandDupes = mode !== 'solo' && d.bandDupes === true;
    // Developer console authorization survives a restart with the room (a running match keeps its own copy).
    room.consoleEnabled = d.consoleEnabled === true;
    // 「不限时」 (header): the room's own flag, restored with it
    room.soloUnlimited = mode === 'solo' && d.soloUnlimited === true;
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
        skins: isBot ? null : (session?.skins || s.skins || null),
        // 名片干员 (room.card): the seat-card operator rides back with the seat (re-checked against the room's
        // operators on the next humanSeat / version switch, like the session's own copy)
        card: isBot ? null : (session?.card || (s.card && typeof s.card === 'object' && !Array.isArray(s.card) ? s.card : null)),
        // room.setBotBand (移植自用户分支): the designated strategy rides back onto the AI seat
        ...(isBot ? { band: typeof s.band === 'string' && s.band ? s.band : null } : {}),
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
    // The room's content set (roomDoc.content): rebuilt and held again, or the room is refused — a plugin room must
    // never come back as the original game (header "Gameplay plugins"; P1c). Resolved only once the room is otherwise
    // accepted, so a refused room never leaves a held set behind. undefined = the set is gone.
    const content = restoredContent(lobby, room, d);
    if (content === undefined) { stats.droppedSeats += room.seats.filter(Boolean).length; continue; }
    room.content = content;
    lobby.rooms.set(room.code, room);
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
 * @param {object} lobby @param {object} room @param {object} checkpoint
 * @returns {boolean} true when the match runs again
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
  lobby.audit('match.restored', starter, room, { round: match.round, phase: match.phase });
  lobby.log.info(`[lobby] ${room.code} match #${room.matchCount} restored (${room.mode}/${room.difficulty}, round ${match.round}, ${match.phase})`);
  lobby.broadcastState(room);
  lobby.checkpoint(room.code, match);
  return OK;
}
