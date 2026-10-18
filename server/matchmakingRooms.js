// The room side of matchmaking: what the Lobby does when the queue (server/matchmaking.js) needs a view of a
// session, when its host opts a whole alliance in, and how the queue's allocation becomes a started room. Lifted
// out of Lobby so the upstream class keeps a handful of one-line seams (FORK_MAINTENANCE.md).
//
// Every entry takes the Lobby as its first argument and reaches the rest through it. It deliberately does
// NOT import lobby.js — lobby.js imports this module back, and a cycle would be the only one in
// server/. `fail` mirrors Lobby's local helper so the result shapes stay identical.

import { ERR, MAX_SEATS, MAX_SPECTATORS } from '../shared/constants.js';
import { EXPERIMENTAL_DEFAULTS } from '../shared/experimental.js';
import { sendSession } from './net.js';

/** Mirrors Lobby's local `fail` (server/lobby.js): a result object, never a throw. */
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });

/** The queue's outbound channel: a complete queue.state snapshot, never a delta. */
export const matchmakingSend = (session, msg) => sendSession(session, msg);

/**
 * Whether a session can still be part of a match right now (server/matchmaking.js `available`). A solo ticket needs
 * no room; a party ticket needs its room intact, nobody seated elsewhere, and every seated human present — a party is
 * indivisible, so one absence withdraws all of it.
 */
export function matchmakingAvailable(lobby, session, entry) {
  if (!session || !session.connected) return false;
  const room = lobby.roomOf(session);
  if (room?.spectatorOf(session.playerId)) return false;
  const partyCode = entry?.party?.roomCode || null;
  if (!partyCode) return !room || !room.match;
  if (!room || room.disposed || room.match || room.code !== partyCode) return false;
  if (room.spectatorOf(session.playerId)) return false;
  return room.activeHumans().every((seat) => {
    const member = lobby.registry.byId(seat.playerId);
    return !!member && member.connected && lobby.roomOf(member) === room;
  });
}

/**
 * The sessions one ticket covers (server/matchmaking.js `members`): the solo player, or every seated human of the
 * host's alliance. A party joins as one indivisible unit and its room keeps `matchmaking` set while it waits.
 */
export function matchmakingMembers(lobby, session, difficulty, party) {
  if (!party) return { sessions: [session], roomCode: null, leaderId: session.playerId };
  const room = lobby.roomOf(session);
  if (!room) return fail(ERR.NOT_IN_ROOM);
  if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
  if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
  if (room.match) return fail(ERR.ROOM_STARTED);
  if (room.consoleEnabled) return fail(ERR.MATCHING, 'console and matchmaking are mutually exclusive');
  if (room.mode !== 'coop' || room.seats.some((s) => s?.isBot) || room.freeSeat() < 0) return fail(ERR.BAD_MSG);
  if (room.activeHumans().some((s) => !s.connected || (s.playerId !== room.hostId && !s.ready))) return fail(ERR.NOT_READY);
  const sessions = room.activeHumans().map((seat) => lobby.registry.byId(seat.playerId));
  if (sessions.some((s) => !s) || sessions.length > MAX_SEATS) return fail(ERR.NOT_READY);
  return { sessions, roomCode: room.code, leaderId: room.hostId, experimental: EXPERIMENTAL_DEFAULTS };
}

/**
 * Allocate a fresh private co-op room and start it with exactly four opted-in humans. The cohort's tickets stay
 * the queue's own while this runs: lobby.leaveQueue skips them, so a failed start keeps accepted tickets for a
 * retry instead of dissolving the pool with a misleading `cancelled`.
 */
export function allocateMatchmakingGroup(lobby, group, difficulty) {
  for (const s of group) s.mmCohort = true;
  try { return allocateCohort(lobby, group, difficulty); }
  finally { for (const s of group) delete s.mmCohort; }
}

function allocateCohort(lobby, group, difficulty) {
  if (group.length !== MAX_SEATS || group.some((s) => !s.connected)) return fail(ERR.NOT_READY);
  // Every participant's network budget applies, including when that player is not the generated room's host.
  const keys = new Set(group.map((s) => s.limitKey).filter(Boolean));
  if (lobby.opts.maxMatchesPerAddr > 0) for (const key of keys) {
    if (lobby.countRooms((r) => !!r.match && (r.matchKey === key || r.activeHumans().some((seat) => lobby.registry.byId(seat.playerId)?.limitKey === key))) >= lobby.opts.maxMatchesPerAddr) return fail(ERR.RATE);
  }
  if (group.some((s) => lobby.roomOf(s))) {
    const own = lobby.roomOf(group[0]);
    if (own) own.queueCohort = true;
    return mergePartyMatchmaking(lobby, group, difficulty);
  }
  const created = lobby.create(group[0], { mode: 'coop', difficulty });
  if (!created.ok) return created;
  const room = lobby.roomOf(group[0]);
  room.queueCohort = true;
  // 野排: any seated human may propose the setup reroll vote (server/lobby.js rerollSetup)
  room.fromMatchmaking = true;
  try {
    for (const s of group.slice(1)) {
      const joined = lobby.join(s, { code: room.code });
      if (!joined.ok) { lobby.disposeRoom(room, 'matchmaking_failed'); return joined; }
    }
    for (const seat of room.seats) if (seat) seat.ready = true;
    const started = lobby.start(group[0]);
    if (!started.ok) { lobby.disposeRoom(room, 'matchmaking_failed'); return started; }
    delete room.queueCohort;
    return { ok: true, code: room.code };
  } catch (error) {
    lobby.disposeRoom(room, 'matchmaking_failed'); lobby.log.error('[matchmaking] allocation failed', error);
    return fail(ERR.INTERNAL);
  }
}

/** The host opts the whole ready alliance into four-human matchmaking (server/matchmaking.js join {party:true}). */
export function queuePartyMatchmaking(lobby, session) {
  const room = lobby.roomOf(session);
  if (!room) return fail(ERR.NOT_IN_ROOM);
  if (room.matchmaking) return { ok: true }; // already queued: the queue answers with a fresh snapshot
  const queued = lobby.matchmaking.join(session, { difficulty: room.difficulty, party: true });
  if (queued?.ok) { room.matchmaking = true; lobby.broadcastState(room); }
  return queued;
}

/** The host withdraws the whole alliance again; the queue drops every one of its tickets. */
export function cancelPartyMatchmaking(lobby, session, { ticketId } = {}) {
  const room = lobby.roomOf(session);
  if (room?.match) return fail(ERR.ROOM_STARTED);
  if (room) {
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
  }
  return lobby.matchmaking.cancel(session, { ticketId });
}

/** Withdraw a whole room's tickets even when its host's session has already expired. */
export function dropMatchmakingParty(lobby, room, reason = 'cancelled') {
  for (const seat of room.activeHumans()) {
    const session = lobby.registry.byId(seat.playerId);
    if (session) lobby.leaveQueue(session, reason);
  }
  if (room.matchmaking) { room.matchmaking = false; lobby.broadcastState(room); }
}

/** Keep the oldest alliance's code and host; merge whole parties, restoring them if start fails. */
export function mergePartyMatchmaking(lobby, group, difficulty) {
  const origins = group.map((s) => lobby.roomOf(s));
  const parties = [...new Set(origins.filter(Boolean))];
  if (parties.some((r) => r.match || r.disposed || r.mode !== 'coop' || r.difficulty !== difficulty ||
    r.seats.some((s) => s?.isBot) || r.activeHumans().some((s) => !group.some((p) => p.playerId === s.playerId)))) return fail(ERR.NOT_READY);
  const room = parties[0];
  room.fromMatchmaking = true;
  const spectators = parties.flatMap((r) => r.spectators);
  if (spectators.length > MAX_SPECTATORS) return fail(ERR.ROOM_FULL);
  const previous = { seats: room.seats, spectators: room.spectators, matchCount: room.matchCount, replay: room.replay, matchmaking: room.matchmaking };
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
  // lobby.start refuses a room that is still waiting on the queue: these tickets are being committed right now.
  room.matchmaking = false;
  try { result = lobby.start(lobby.registry.byId(room.hostId)); } catch { result = fail(ERR.INTERNAL); }
  delete room.queueCohort;
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
  return result.ok ? { ok: true, code: room.code } : result;
}
