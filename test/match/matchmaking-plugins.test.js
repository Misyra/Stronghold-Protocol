// A room that plays gameplay plugins is unofficial: it must not enter the official matchmaking queue, and a queue
// allocation must not drop matched strangers into it. Cosmetic plugins leave `vanilla` true and stay queueable.
// These are the pure seams (server/matchmakingRooms.js), so the check needs no lobby harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchmakingAvailable, matchmakingMembers, mergePartyMatchmaking, queuePartyMatchmaking } from '../../server/matchmakingRooms.js';
import { ERR } from '../../shared/constants.js';
import { EXPERIMENTAL_DEFAULTS } from '../../shared/experimental.js';

const session = { playerId: 'p_1', connected: true };

/** Just enough of a Room for the guards: they run before anything touches seats or matches. */
const room = (needsContent) => ({
  code: 'ABCD', needsContent, disposed: false, match: null, hostId: 'p_1', mode: 'coop', consoleEnabled: false,
  spectatorOf: () => false,
  // the guards read the capacity contract (server/matchmakingRooms.js): a fake must mirror the real Room's shape
  capacity: 4, experimental: EXPERIMENTAL_DEFAULTS, seats: [], validCapacity: () => true,
  activeHumans: () => [{ playerId: 'p_1', connected: true }],
});

/** Just enough of a Lobby for the guards: the capacity seams answer like an ordinary four-seat room. */
const lobbyFor = (r) => ({
  roomOf: () => r, registry: { byId: () => ({ connected: true }) },
  capacityClients: () => true, isOnline: () => true,
});
/** One party ticket the queue could have handed out (Matchmaking.join's unit shape). */
const ticket = { party: { roomCode: 'ABCD', required: 4, leaderId: 'p_1', experimental: EXPERIMENTAL_DEFAULTS, entries: [{ session }] } };

test('a gameplay-plugin room is not available to the queue', () => {
  const modded = room(true);
  const lobby = lobbyFor(modded);
  assert.equal(matchmakingAvailable(lobby, session, ticket), false);
  const vanillaRoom = room(false);
  const vanilla = lobbyFor(vanillaRoom);
  assert.equal(matchmakingAvailable(vanilla, session, ticket), true);
});

test('another official version room is not available either (needsContent, not only modded)', () => {
  const versionRoom = room(true); // a non-default version needs its own content just like a plugin room
  const lobby = lobbyFor(versionRoom);
  assert.equal(matchmakingAvailable(lobby, session, ticket), false);
  assert.deepEqual(matchmakingMembers(lobby, session, 'HARD', true), { error: ERR.ROOM_MODDED });
  assert.deepEqual(matchmakingMembers(lobby, session, 'HARD', false), { error: ERR.ROOM_MODDED });
  assert.deepEqual(queuePartyMatchmaking(lobby, session), { error: ERR.ROOM_MODDED });
  assert.deepEqual(mergePartyMatchmaking(lobby, [session], 'HARD'), { error: ERR.ROOM_MODDED });
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
