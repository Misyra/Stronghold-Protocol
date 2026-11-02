// A room that plays gameplay plugins is unofficial: it must not enter the official matchmaking queue, and a queue
// allocation must not drop matched strangers into it. Cosmetic plugins leave `vanilla` true and stay queueable.
// These are the pure seams (server/matchmakingRooms.js), so the check needs no lobby harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchmakingAvailable, matchmakingMembers, mergePartyMatchmaking, queuePartyMatchmaking } from '../../server/matchmakingRooms.js';
import { ERR } from '../../shared/constants.js';

const session = { playerId: 'p_1', connected: true };

/** Just enough of a Room for the guards: they run before anything touches seats or matches. */
const room = (modded) => ({
  code: 'ABCD', modded, disposed: false, match: null, hostId: 'p_1', mode: 'coop', consoleEnabled: false,
  spectatorOf: () => false,
  activeHumans: () => [{ playerId: 'p_1' }],
});

test('a gameplay-plugin room is not available to the queue', () => {
  const modded = room(true);
  const lobby = { roomOf: () => modded, registry: { byId: () => ({ connected: true }) } };
  assert.equal(matchmakingAvailable(lobby, session, { party: { roomCode: 'ABCD' } }), false);
  const vanillaRoom = room(false);
  const vanilla = { roomOf: () => vanillaRoom, registry: { byId: () => ({ connected: true }) } };
  assert.equal(matchmakingAvailable(vanilla, session, { party: { roomCode: 'ABCD' } }), true);
});

test('a party ticket from a gameplay-plugin room is refused with ROOM_MODDED', () => {
  const lobby = { roomOf: () => room(true) };
  assert.deepEqual(matchmakingMembers(lobby, session, 'HARD', true), { error: ERR.ROOM_MODDED });
});

test('a solo ticket from a gameplay-plugin room is refused too', () => {
  const lobby = { roomOf: () => room(true) };
  assert.deepEqual(matchmakingMembers(lobby, session, 'HARD', false), { error: ERR.ROOM_MODDED });
});

test('room.matchmaking refuses a gameplay-plugin room', () => {
  const lobby = { roomOf: () => room(true) };
  assert.deepEqual(queuePartyMatchmaking(lobby, session), { error: ERR.ROOM_MODDED });
});

test('a merge never pulls other parties into a gameplay-plugin room', () => {
  const lobby = { roomOf: () => room(true) };
  assert.deepEqual(mergePartyMatchmaking(lobby, [session], 'HARD'), { error: ERR.ROOM_MODDED });
});

test('cosmetic-only rooms stay queueable (vanilla stays true)', () => {
  const lobby = { roomOf: () => room(false) };
  const members = matchmakingMembers(lobby, session, 'HARD', false);
  assert.deepEqual(members, { sessions: [session], roomCode: null, leaderId: 'p_1' });
});
