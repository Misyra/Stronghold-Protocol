// Waiting-room cues (ui/roomCues.js, ported from the Stardust fork): which room-state change makes which sound, and the
// rate limit. audio.js plays 'ready' out of its own edge; the join/leave cues come from here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatedHumans, roomCue, cueGate } from '../../public/js/ui/roomCues.js';

const seat = (playerId, extra = {}) => ({ playerId, isBot: false, ...extra });
const room = (seats, extra = {}) => ({ code: 'ABCD', mode: 'coop', inMatch: false, seats, ...extra });

test('seatedHumans leaves bots and empty seats out', () => {
  assert.deepEqual([...seatedHumans(room([seat('a'), seat('bot', { isBot: true }), {}, null, { playerId: 7 }]))], ['a']);
  assert.deepEqual([...seatedHumans(null)], []);
  assert.deepEqual([...seatedHumans({ seats: 'nope' })], []);
});

test('entering a room I am seated in sounds the join cue; a room I am not in does not', () => {
  assert.equal(roomCue(null, room([seat('me')]), 'me'), 'joinRoom');
  assert.equal(roomCue(null, room([seat('other')]), 'me'), null, 'a spectator is not seated');
});

test('another doctor taking or leaving a seat is heard; my own moving is not', () => {
  const before = room([seat('me'), seat('other')]);
  assert.equal(roomCue(before, room([seat('me'), seat('other'), seat('new')]), 'me'), 'joinRoom');
  assert.equal(roomCue(before, room([seat('me')]), 'me'), 'disconnect');
  assert.equal(roomCue(before, room([seat('me'), seat('other'), seat('bot', { isBot: true })]), 'me'), null, 'a bot is no doctor');
});

test('a match, a welcome\'s first state, a reconnect and a returning room stay silent', () => {
  const before = room([seat('me')]);
  assert.equal(roomCue(before, room([seat('me')], { inMatch: true }), 'me'), null, 'the match has its own input');
  assert.equal(roomCue(null, room([seat('me')]), 'me', { quiet: true }), null, 'a welcome re-sends the room as it is');
  assert.equal(roomCue(room([seat('me')], { inMatch: true }), before, 'me'), null, 'back from a match is not a join');
  assert.equal(roomCue(before, room([seat('me')], { code: 'EFGH' }), 'other'), null, 'another room, and I am not in it');
});

test('cueGate allows one cue of a kind per gap', () => {
  const gate = cueGate(1000);
  assert.equal(gate('joinRoom', 0), true);
  assert.equal(gate('joinRoom', 500), false, 'the same kind waits');
  assert.equal(gate('ready', 500), true, 'another kind is its own bucket');
  assert.equal(gate('joinRoom', 1000), true);
});
