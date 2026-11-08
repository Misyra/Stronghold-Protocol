// 手动指定卡池编组 in a match (experimental poolPlan, feedback #49; shared/poolPlan.js, server/match/pool.js): the seats draw
// from the pools the host set, in any room size, through a setup reroll, a checkpoint and a whole match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolGroups, SharedPool } from '../../server/match/pool.js';
import { collectViolations } from '../../server/match/invariants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { makeMatch } from './harness.js';

const exp = (capacity, poolPlan, o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...(capacity > 4 ? { playerCapacity: capacity } : {}), poolPlan, ...o });
const shape = (m) => m.poolGroups.map(({ id, playerIds, scale }) => ({ id, ids: playerIds.map((p) => Number(p.slice(2))), scale }));
const players = (...seats) => seats.map((seat) => ({ seat, playerId: `p_${seat}` }));

/** The seat whose chess a test takes: any tier-one chess of the match's pools. */
const tierOne = (m) => [...m.pool.entries.keys()].find((id) => m.gd.chess(id).tier === 1);

test('createPoolGroups: the plan decides, pools without a seated player do not exist, the rest number from 1', (t) => {
  const h = makeMatch({ humans: 1, seed: 11, fake: true }); t.after(() => h.m.dispose());
  const gd = h.m.gd;
  const groups = createPoolGroups(gd, players(0, 1, 2, 5, 7), { plan: [0, 0, 1, 1, 2, 2, 3, 3] });
  assert.deepEqual(groups.map((g) => [g.id, g.playerIds, g.scale]), [[1, ['p_0', 'p_1'], 1], [2, ['p_2'], 1], [3, ['p_5'], 1], [4, ['p_7'], 1]]);
  const dropped = createPoolGroups(gd, players(0, 1, 6, 7), { plan: [0, 0, 1, 1, 2, 2, 3, 3] });
  assert.deepEqual(dropped.map((g) => [g.id, g.playerIds]), [[1, ['p_0', 'p_1']], [2, ['p_6', 'p_7']]], 'pools 1 and 2 had nobody');
  assert.throws(() => createPoolGroups(gd, players(9), { plan: [0, 0] }), /no such seat/);
});

test('createPoolGroups: up to four seats a complete pool, more scale with the seats and the copies follow', (t) => {
  const h = makeMatch({ humans: 1, seed: 11, fake: true }); t.after(() => h.m.dispose());
  const gd = h.m.gd, id = gd.visibleChess.find((c) => gd.poolCopies(c) > 0);
  const seats = Array.from({ length: 12 }, (_, i) => i);
  const [one] = createPoolGroups(gd, players(...seats), { plan: new Array(12).fill(0) });
  assert.equal(one.scale, 3);
  assert.equal(one.pool.cap(id), Math.ceil(gd.poolCopies(id) * 3));
  const twenty = createPoolGroups(gd, players(...Array.from({ length: 20 }, (_, i) => i)), { plan: new Array(20).fill(0) });
  assert.equal(twenty[0].scale, 5, 'the largest room in one pool');
  assert.throws(() => new SharedPool(gd, { scale: 5.5 }), /pool scale/);
});

test('a four-seat room can split: seats route to their pool, stock and equipment do not mix', (t) => {
  const h = makeMatch({ humans: 4, seed: 21, fake: true, experimental: exp(4, [0, 0, 1, 1]) }).start();
  const m = h.m; t.after(() => m.dispose());
  h.toPrep(1);
  assert.equal(m.capacityExperiment, false);
  assert.deepEqual(shape(m), [{ id: 1, ids: [0, 1], scale: 1 }, { id: 2, ids: [2, 3], scale: 1 }]);
  assert.strictEqual(m.poolFor('p_0'), m.poolFor('p_1'));
  assert.notStrictEqual(m.poolFor('p_0'), m.poolFor('p_2'));
  assert.strictEqual(m.itemPoolFor('p_2'), m.itemPoolFor('p_3'));
  assert.notStrictEqual(m.itemPoolFor('p_0'), m.itemPoolFor('p_2'));
  assert.throws(() => m.poolFor('stranger'), /player card pool/);
  const base = tierOne(m), before = [m.poolFor('p_0').left(base), m.poolFor('p_2').left(base)];
  assert.ok(h.ps('p_2').acquireChess(base));
  assert.deepEqual([m.poolFor('p_0').left(base), m.poolFor('p_2').left(base)], [before[0], before[1] - 1], 'the other pool keeps its copies');
  assert.deepEqual(collectViolations(m), []);
  const view = m.publicView();
  assert.deepEqual(view.poolGroups.map((g) => g.playerIds.length), [2, 2], 'the roster groups them in a four-seat room too');
  assert.equal('playerCapacity' in view, false, 'a four-seat room is no expanded room');
});

test('an ordinary room keeps its shape and its one pool', (t) => {
  const h = makeMatch({ humans: 4, seed: 21, fake: true, experimental: { revivalEnabled: false, disableSharedPool: false } }).start();
  t.after(() => h.m.dispose());
  assert.equal(h.m.poolPlan, null);
  assert.equal(h.m.playerPools, null);
  assert.equal('poolGroups' in h.m.publicView(), false);
});

test('without a plan six seats stay 3 + 3, five stay one enlarged pool', (t) => {
  for (const [humans, sizes] of [[6, [3, 3]], [5, [5]]]) {
    const h = makeMatch({ humans, seed: 31, fake: true, experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 } }).start();
    t.after(() => h.m.dispose());
    assert.deepEqual(h.m.poolGroups.map((g) => g.playerIds.length), sizes);
  }
});

test('a solo room ignores a plan', (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 41, fake: true, experimental: exp(4, [0, 1, 2, 3]) }).start();
  t.after(() => h.m.dispose());
  assert.equal(h.m.poolPlan, null);
  assert.equal(h.m.poolGroups.length, 1);
  assert.equal(h.m.playerPools, null);
});

test('AI seats belong to the pools like anybody, and the plan reads room seats, not the order of the seated', (t) => {
  const seats = [{ seat: 1, playerId: 'p_1', name: 'A', isBot: false, connected: true }, { seat: 2, playerId: 'ai_2', name: 'B', isBot: true, connected: true },
    { seat: 7, playerId: 'p_7', name: 'C', isBot: false, connected: true }];
  const h = makeMatch({ seats, seed: 51, fake: true, experimental: exp(8, [0, 0, 1, 1, 1, 1, 2, 2]) }).start();
  t.after(() => h.m.dispose());
  assert.deepEqual(h.m.poolGroups.map((g) => g.playerIds), [['p_1'], ['ai_2'], ['p_7']]);
});

test('a setup reroll rebuilds the same groups on new pools', (t) => {
  const h = makeMatch({ humans: 6, seed: 61, difficulty: 'HARD', experimental: exp(8, [0, 0, 1, 1, 1, 1, 0, 0]) }).start();
  const m = h.m; t.after(() => m.dispose());
  const before = shape(m), old = m.poolGroups.map((g) => g.pool);
  assert.deepEqual(before.map((g) => g.ids), [[0, 1], [2, 3, 4, 5]]);
  assert.deepEqual(m.requestSetupReroll('p_0', 0), { ok: true });
  for (const ps of m.order.slice(1)) if (m.setupVote) assert.deepEqual(m.handle(ps.playerId, { t: 'g.rerollVote', voteId: m.setupVote.id, agree: true }), { ok: true });
  assert.equal(m.setupRevision, 1);
  assert.deepEqual(shape(m), before);
  for (const ps of m.order) {
    const group = m.poolGroups.find((g) => g.playerIds.includes(ps.playerId));
    assert.strictEqual(m.poolFor(ps), group.pool);
    assert.ok(!old.includes(m.poolFor(ps)));
  }
  h.invariants();
});

for (const [name, capacity, humans, plan, sizes] of [
  ['a four-seat room, 2 + 2', 4, 4, [0, 0, 1, 1], [2, 2]],
  ['six seats, 2 + 4', 8, 6, [0, 0, 1, 1, 1, 1, 1, 1], [2, 4]],
  ['twelve seats in one pool (×3)', 12, 12, new Array(12).fill(0), [12]],
]) {
  test(`checkpoint round trip: ${name}`, (t) => {
    const h = makeMatch({ humans, seed: 71, fake: true, experimental: exp(capacity, plan) }).start();
    t.after(() => h.m.dispose());
    h.toPrep(1);
    assert.deepEqual(h.m.poolGroups.map((g) => g.playerIds.length), sizes);
    const base = tierOne(h.m);
    assert.ok(h.ps('p_0').acquireChess(base));
    const left = h.m.poolGroups.map((g) => g.pool.left(base));
    const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
    assert.equal(doc.poolGroups.length, sizes.length);
    const r = makeMatch({ humans, seed: 71, fake: true, experimental: exp(capacity, plan) });
    t.after(() => r.m.dispose());
    assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: { warn() {} } }), true);
    assert.deepEqual(shape(r.m), shape(h.m));
    assert.deepEqual(r.m.poolGroups.map((g) => g.pool.left(base)), left);
    assert.strictEqual(r.m.poolFor('p_0'), r.m.poolGroups[0].pool);
    assert.deepEqual(collectViolations(r.m), []);
  });
}

test('a checkpoint restores its own layout: the saved plan rules, not the room\'s current one', (t) => {
  // This repo saves poolPlan with the checkpoint (like the capacity scalars), so the restore rebuilds the saved
  // layout; the fork (whose checkpoints carry no plan) refuses a mismatching room instead — same guard, different
  // authority: the group-count check still refuses what the saved document cannot rebuild.
  const h = makeMatch({ humans: 4, seed: 73, fake: true, experimental: exp(4, [0, 0, 1, 1]) }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  const base = tierOne(h.m);
  assert.ok(h.ps('p_1').acquireChess(base));
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  const r = makeMatch({ humans: 4, seed: 73, fake: true, experimental: exp(4, [0, 0, 0, 0]) });
  t.after(() => r.m.dispose());
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: { warn() {} } }), true);
  assert.deepEqual(shape(r.m), [{ id: 1, ids: [0, 1], scale: 1 }, { id: 2, ids: [2, 3], scale: 1 }], 'the saved 2 + 2, not the room\'s one pool');
  assert.strictEqual(r.m.poolFor('p_1'), r.m.poolGroups[0].pool);
  assert.equal(r.m.poolGroups[0].pool.left(base), h.m.poolGroups[0].pool.left(base));
  assert.deepEqual(collectViolations(r.m), []);
});

test('a whole match of AI-played seats in uneven pools ends clean', (t) => {
  const h = makeMatch({ humans: 2, bots: 6, seed: 83, fake: true, experimental: exp(8, [0, 0, 0, 1, 1, 2, 2, 2]) }).start();
  t.after(() => h.m.dispose());
  h.autoHumans();
  h.runToEnd();
  assert.ok(h.ended != null, 'the match ended');
  assert.deepEqual(h.m.poolGroups.map((g) => g.playerIds.length), [3, 2, 3]);
  assert.deepEqual(h.logs.error, []);
  assert.deepEqual(collectViolations(h.m), []);
});
