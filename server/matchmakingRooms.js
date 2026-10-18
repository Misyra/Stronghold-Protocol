// The room side of matchmaking: what the Lobby does when the queue (server/matchmaking.js) hands it a
// group, and what a host's opt-in / cancel do to their own room. Lifted out of Lobby so the upstream
// class keeps four one-line seams instead of a hundred-line insertion (FORK_MAINTENANCE.md).
//
// Every entry takes the Lobby as its first argument and reaches the rest through it. It deliberately
// does NOT import lobby.js — lobby.js imports this module back, and a cycle would be the only one in
// server/. `fail` mirrors Lobby's local helper so the result shapes stay identical.

import { ERR, MAX_SEATS, MAX_SPECTATORS } from '../shared/constants.js';
import { sendSession } from './net.js';

/** Mirrors Lobby's local `fail` (server/lobby.js): a result object, never a throw. */
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });

/** Allocate a fresh private co-op room and start it with exactly four opted-in humans. */
export function allocateMatchmakingGroup(lobby, group, difficulty) {
  if (group.length !== MAX_SEATS || group.some((s) => !s.connected)) return fail(ERR.NOT_READY);
  // Every participant's network budget applies, including when that player is not the generated room's host.
  const keys = new Set(group.map((s) => s.limitKey).filter(Boolean));
  if (lobby.opts.maxMatchesPerAddr > 0) for (const key of keys) {
    if (lobby.countRooms((r) => !!r.match && (r.matchKey === key || r.activeHumans().some((seat) => lobby.registry.byId(seat.playerId)?.limitKey === key))) >= lobby.opts.maxMatchesPerAddr) return fail(ERR.RATE);
  }
  if (group.some((s) => lobby.roomOf(s))) return mergePartyMatchmaking(lobby, group, difficulty);
  const created = lobby.create(group[0], { mode: 'coop', difficulty });
  if (!created.ok) return created;
  const room = lobby.roomOf(group[0]);
  try {
    for (const s of group.slice(1)) {
      const joined = lobby.join(s, { code: room.code });
      if (!joined.ok) { lobby.disposeRoom(room, 'matchmaking_failed'); return joined; }
    }
    for (const seat of room.seats) if (seat) seat.ready = true;
    const started = lobby.start(group[0]);
    if (!started.ok) lobby.disposeRoom(room, 'matchmaking_failed');
    return started;
  } catch (error) {
    lobby.disposeRoom(room, 'matchmaking_failed'); lobby.log.error('[matchmaking] allocation failed', error);
    return fail(ERR.INTERNAL);
  }
}

/** The host opts the whole ready alliance into four-human matchmaking. */
export function queuePartyMatchmaking(lobby, session) {
  const room = lobby.roomOf(session);
  if (!room) return fail(ERR.NOT_IN_ROOM);
  if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
  if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
  if (room.match) return fail(ERR.ROOM_STARTED);
  if (room.consoleEnabled) return fail(ERR.MATCHING, 'console and matchmaking are mutually exclusive');
  if (room.mode !== 'coop' || room.seats.some((s) => s?.isBot) || room.freeSeat() < 0) return fail(ERR.BAD_MSG);
  if (room.activeHumans().some((s) => !s.connected || (s.playerId !== room.hostId && !s.ready))) return fail(ERR.NOT_READY);
  return lobby.matchmaking.joinParty(room);
}

export function cancelPartyMatchmaking(lobby, session) {
  const room = lobby.roomOf(session);
  if (room?.match) return fail(ERR.ROOM_STARTED);
  if (room) {
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
  }
  return lobby.matchmaking.cancel(session);
}

/** Keep the oldest alliance's code and host; merge whole parties, restoring them if start fails. */
export function mergePartyMatchmaking(lobby, group, difficulty) {
  const origins = group.map((s) => lobby.roomOf(s));
  const parties = [...new Set(origins.filter(Boolean))];
  if (parties.some((r) => r.match || r.disposed || r.mode !== 'coop' || r.difficulty !== difficulty ||
    r.seats.some((s) => s?.isBot) || r.activeHumans().some((s) => !group.some((p) => p.playerId === s.playerId)))) return fail(ERR.NOT_READY);
  const room = parties[0];
  const spectators = parties.flatMap((r) => r.spectators);
  if (spectators.length > MAX_SPECTATORS) return fail(ERR.ROOM_FULL);
  const previous = { seats: room.seats, spectators: room.spectators, matchCount: room.matchCount, replay: room.replay };
  room.seats = room.seats.map((s) => s ? { ...s, ready: true } : null);
  room.spectators = spectators;
  for (const s of group) {
    if (!room.seatOf(s.playerId)) {
      const seat = room.freeSeat();
      room.seats[seat] = { ...lobby.humanSeat(seat, s), ready: true };
    }
    s.roomCode = room.code;
  }
  for (const s of spectators) {
    const session = lobby.registry.byId(s.playerId);
    if (session) session.roomCode = room.code;
  }
  let result;
  try { result = lobby.start(lobby.registry.byId(room.hostId)); } catch { result = fail(ERR.INTERNAL); }
  if (result.ok) {
    for (let i = 0; i < group.length; i++) if (origins[i] !== room) {
      if (origins[i]) lobby.audit('room.left', group[i], origins[i], { reason: 'merged' });
      lobby.audit('room.joined', group[i], room, { reason: 'merged', sourceRoomCode: origins[i]?.code || null });
    }
    for (const source of parties.slice(1)) lobby.disposeRoom(source, 'merged');
  } else {
    Object.assign(room, previous);
    for (let i = 0; i < group.length; i++) {
      group[i].roomCode = origins[i]?.code || null;
      if (!origins[i]) sendSession(group[i], { t: 'room.closed', reason: 'matchmaking_failed' });
    }
    for (const source of parties) {
      for (const s of source.spectators) {
        const session = lobby.registry.byId(s.playerId);
        if (session) session.roomCode = source.code;
      }
      lobby.broadcastState(source);
    }
  }
  return result;
}
