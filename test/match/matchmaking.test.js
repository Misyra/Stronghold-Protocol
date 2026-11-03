// server/matchmaking.js — the queue engine. Each event turn may ask for a pool scan several times (one join itself
// sweeps and then joins); these tests pin down that one turn pays for one scan, and that consecutive turns still scan
// and therefore keep forming offers.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DIFFICULTIES, MATCHMAKING_VERSION } from '../../shared/constants.js';
import { Matchmaking } from '../../server/matchmaking.js';
import { NO_PHASES } from '../../server/phaseMetrics.js';

const NOW = 1_000_000;
const session = (playerId) => ({ playerId, matchmakingVersion: MATCHMAKING_VERSION, connected: true });

function engine() {
  const mm = new Matchmaking({
    now: () => NOW, send: () => {}, available: () => true, allocate: () => ({ code: 'ABCD' }),
    options: {}, timers: { setTimeout: () => 1, clearTimeout: () => {} }, metrics: NO_PHASES,
  });
  let scans = 0;
  const scan = mm.pumpPools.bind(mm);
  mm.pumpPools = () => { scans++; return scan(); };
  return { mm, scans: () => scans };
}

test('four parties joining in one event turn scan the queue once and still form one FIFO offer', async () => {
  const { mm, scans } = engine();
  for (const playerId of ['a', 'b', 'c', 'd']) {
    assert.deepEqual(mm.join(session(playerId), { difficulty: DIFFICULTIES[1] }), { ok: true });
  }
  assert.equal(scans(), 0, 'the scan is deferred, never paid once per join');
  await Promise.resolve();
  assert.equal(scans(), 1, 'the whole burst cost one scan');
  assert.equal(mm.offers.size, 1);
  const [offer] = mm.offers.values();
  assert.deepEqual(offer.entries.map((e) => e.session.playerId), ['a', 'b', 'c', 'd']);
  assert.ok(offer.entries.every((e) => e.offerId === offer.id));
});

test('a later event turn scans again, so a second pair completes the next offer', async () => {
  const { mm, scans } = engine();
  mm.join(session('a'), { difficulty: DIFFICULTIES[1] });
  mm.join(session('b'), { difficulty: DIFFICULTIES[1] });
  await Promise.resolve();
  assert.deepEqual([scans(), mm.offers.size], [1, 0], 'half a room forms nothing');
  mm.join(session('c'), { difficulty: DIFFICULTIES[1] });
  mm.join(session('d'), { difficulty: DIFFICULTIES[1] });
  await Promise.resolve();
  assert.deepEqual([scans(), mm.offers.size], [2, 1]);
  assert.deepEqual([...mm.offers.values()][0].entries.map((e) => e.session.playerId), ['a', 'b', 'c', 'd']);
});

test('scanning stays coalesced with removal, cancellation and an unchanged queue', async () => {
  const { mm, scans } = engine();
  mm.join(session('a'), { difficulty: DIFFICULTIES[1] });
  mm.join(session('b'), { difficulty: DIFFICULTIES[1] });
  mm.remove(mm.entries.get('b').session);
  await Promise.resolve();
  assert.deepEqual([scans(), mm.size], [1, 1]);
  // An empty queue still scans once, and idle turns schedule nothing until the next operation.
  mm.cancel(session('a'), { ticketId: mm.entries.get('a').ticketId });
  await Promise.resolve();
  assert.equal(scans(), 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans(), 2, 'no timer keeps rescanning an idle queue');
});

/**
 * A queue whose `members` reads whole rooms from `groups` (names, sizes and experimental rules) and keeps lobby
 * solos as wildcard tickets. Every id in the groups is a session; join the first id with { party: true }.
 */
function partyEngine(groups, solos = []) {
  const sessions = new Map(), byId = new Map();
  for (const def of Object.values(groups)) for (const id of def.ids) {
    sessions.set(id, session(id));
    byId.set(id, def);
  }
  for (const id of solos) sessions.set(id, session(id));
  const mm = new Matchmaking({
    now: () => NOW, send: () => {}, available: () => true, allocate: () => ({ code: 'ABCD' }),
    members: (member, difficulty, party) => {
      const def = byId.get(member.playerId);
      if (!party || !def) return { sessions: [member], roomCode: null, leaderId: member.playerId };
      return { sessions: def.ids.map((id) => sessions.get(id)), roomCode: def.roomCode || `room_${def.ids[0]}`,
        leaderId: def.ids[0], ...(def.experimental ? { experimental: def.experimental } : {}) };
    },
    options: {}, timers: { setTimeout: () => 1, clearTimeout: () => {} }, metrics: NO_PHASES,
  });
  return { mm, sessions };
}

const joinParty = (mm, sessions, def) => {
  const joined = mm.join(sessions.get(def.ids[0]), { difficulty: DIFFICULTIES[1], party: true });
  assert.deepEqual(joined, { ok: true });
};

test('waitingCount counts only parties that fit: a 3-party beside a 2-party is 3/4, never 5/4', () => {
  const groups = { big: { ids: ['a', 'b', 'c'] }, pair: { ids: ['d', 'e'] } };
  const { mm, sessions } = partyEngine(groups);
  joinParty(mm, sessions, groups.big);
  joinParty(mm, sessions, groups.pair);
  const big = mm.state(sessions.get('a'));
  const pair = mm.state(sessions.get('d'));
  assert.deepEqual([big.required, big.waitingCount], [4, 3], 'the 2-party cannot fit beside a 3-party');
  assert.deepEqual([pair.required, pair.waitingCount], [4, 2], 'and the 3-party cannot fit beside a 2-party');
});

test('waitingCount never exceeds the target when two 3-parties wait for a 4-seat room', () => {
  const groups = { one: { ids: ['a', 'b', 'c'] }, two: { ids: ['d', 'e', 'f'] } };
  const { mm, sessions } = partyEngine(groups);
  joinParty(mm, sessions, groups.one);
  joinParty(mm, sessions, groups.two);
  assert.equal(mm.state(sessions.get('a')).waitingCount, 3);
  assert.equal(mm.state(sessions.get('d')).waitingCount, 3);
});

test('waitingCount follows pumpPools\' experimental buckets: other rules do not count, solos do', () => {
  const groups = {
    rev: { ids: ['a', 'b'], experimental: { revivalEnabled: true, disableSharedPool: false } },
    plain: { ids: ['c'], experimental: { revivalEnabled: false, disableSharedPool: false } },
  };
  const { mm, sessions } = partyEngine(groups, ['solo']);
  joinParty(mm, sessions, groups.rev);
  joinParty(mm, sessions, groups.plain);
  mm.join(sessions.get('solo'), { difficulty: DIFFICULTIES[1] });
  // the revived room cannot merge with the default-rules room, but a lobby solo is a wildcard
  assert.equal(mm.state(sessions.get('a')).waitingCount, 3);
  assert.equal(mm.state(sessions.get('c')).waitingCount, 2, 'the default room does not count the revived room');
});

test('waitingCount stays sane when everyone in the pool is compatible', () => {
  const groups = { pair: { ids: ['a', 'b'] } };
  const { mm, sessions } = partyEngine(groups, ['s1', 's2']);
  joinParty(mm, sessions, groups.pair);
  mm.join(sessions.get('s1'), { difficulty: DIFFICULTIES[1] });
  mm.join(sessions.get('s2'), { difficulty: DIFFICULTIES[1] });
  assert.equal(mm.state(sessions.get('a')).waitingCount, 4, '2 + 1 + 1 fills the room');
  assert.equal(mm.state(sessions.get('s1')).waitingCount, 4);
});

test('a room whose party changed replaces its old ticket (no stale ticket left behind)', () => {
  const groups = { room: { ids: ['a', 'b'] } };
  const { mm, sessions } = partyEngine(groups, ['c']);
  joinParty(mm, sessions, groups.room);
  const oldTicket = mm.entries.get('a').ticketId;
  groups.room.ids = ['a', 'b', 'c'];
  joinParty(mm, sessions, groups.room);
  assert.notEqual(mm.entries.get('a').ticketId, oldTicket, 'the ticket was reissued');
  assert.equal(mm.entries.get('a').party.entries.length, 3, 'the party now has all three');
  assert.equal(mm.entries.has('c'), true);
});
