// test/lobby-matchmaking.test.js — the room side of matchmaking over a live Lobby (server/matchmakingRooms.js):
// a failed merge of a party and a solo (the merge rolled back, every ticket kept) tells each member through the
// channel it actually listens on — room.state for members of a real room, the queue engine's own queue.state for a
// member who was never seated anywhere. The solo never receives room.closed: no room ever existed for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function harness() {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quiet, MatchClass: StubMatch, getData: () => ({}) });
  const frames = new Map();
  const player = (name) => {
    const s = registry.create(name);
    s.connected = true;
    s.disconnectedAt = null;
    s.matchmakingVersion = MATCHMAKING_VERSION;
    const box = [];
    frames.set(s.playerId, box);
    s.ws = { readyState: 1, bufferedAmount: 0, send(data) { box.push(JSON.parse(data)); }, terminate() {} };
    return s;
  };
  const sent = (s, t) => frames.get(s.playerId).filter((m) => m.t === t);
  return { lobby, player, sent };
}

test('a failed matchmaking merge informs a never-joined member through the queue, never room.closed', async () => {
  const h = harness();
  const host = h.player('Host');
  const mate1 = h.player('Mate1');
  const mate2 = h.player('Mate2');
  const solo = h.player('Solo');

  // the party: three humans in one co-op room, everyone ready but the host
  assert.deepEqual(h.lobby.create(host, { mode: 'coop', difficulty: 'HARD' }), { ok: true });
  const code = host.roomCode;
  const room = h.lobby.getRoom(code);
  assert.deepEqual(h.lobby.join(mate1, { code }), { ok: true });
  assert.deepEqual(h.lobby.join(mate2, { code }), { ok: true });
  assert.deepEqual(h.lobby.ready(mate1, { ready: true }), { ok: true });
  assert.deepEqual(h.lobby.ready(mate2, { ready: true }), { ok: true });

  // the solo stands in the queue beside it; the party opts in as one unit
  assert.deepEqual(h.lobby.handleMessage(solo, { t: 'queue.join', difficulty: 'HARD' }), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.lobby.handleMessage(host, { t: 'room.matchmaking' }), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  // one offer covers the whole party and the solo; the open version vote makes the merged start refuse
  room.versionVote = { open: true, voters: [] };
  const members = [host, mate1, mate2, solo];
  const states = new Map(members.map((s) => [s.playerId, h.sent(s, 'queue.state').at(-1)]));
  for (const s of members) {
    const st = states.get(s.playerId);
    assert.equal(st.state, 'offered', `${s.playerId}: ${JSON.stringify(st)}`);
    const r = h.lobby.handleMessage(s, { t: 'queue.accept', ticketId: st.ticketId, offerId: st.offerId });
    if (s === solo) assert.equal(r.error, ERR.VERSION_VOTE, JSON.stringify(r));
  }
  await new Promise((resolve) => setImmediate(resolve));

  // the solo was never seated anywhere: no room.closed, only the queue's own snapshot back in the queue
  assert.deepEqual(h.sent(solo, 'room.closed'), [], 'the never-joined member must not see room.closed');
  const back = h.sent(solo, 'queue.state').at(-1);
  assert.equal(back.state, 'queued', JSON.stringify(back));
  assert.equal(back.reason, 'allocation_failed');
  assert.ok(h.lobby.matchmaking.has(solo), 'the solo keeps its ticket');
  assert.equal(solo.roomCode, null, 'the solo was restored to no room');

  // the party is back in its own room (room.state, not room.closed)
  assert.deepEqual(h.sent(host, 'room.closed'), [], 'room members are restored, never closed');
  assert.equal(host.roomCode, code);
  const state = h.sent(host, 'room.state').at(-1);
  assert.equal(state.code, code);
  assert.ok(!room.seatOf(solo.playerId), 'the borrowed seat is gone again');
  for (const s of members) assert.ok(h.lobby.matchmaking.has(s), `${s.playerId} keeps their ticket`);
});
