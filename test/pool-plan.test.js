// 手动指定卡池编组 (feedback #49): the plan's own rules (shared/poolPlan.js) and how the room's options carry it
// (shared/experimental.js). The match side: test/match/manual-pools.test.js; the editor rides the room-settings suite
// (test/ui/room-settings-dialog.test.js) — this repo has no pool-editor e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { experimentalKey, experimentalOptions, isExperimental, sameExperimental } from '../shared/experimental.js';
import { autoPoolPlan, autoPoolSizes, canonicalPoolPlan, evenPoolPlan, isPoolPlan, mergeLastPool, moveSeat, poolCount, poolScale, poolSeats, splitPool } from '../shared/poolPlan.js';

const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const twelve = (poolPlan, o = {}) => rules({ playerCapacity: 12, poolPlan, ...o });
const THREE = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];

test('a plan names every seat of the room with a pool below its capacity', () => {
  assert.equal(isPoolPlan([0, 0, 1, 1], 4), true);
  for (const bad of [[0, 0, 1], [0, 0, 1, 1, 1], [0, 0, 1, 4], [0, 0, 1, -1], [0, 0, 1, 1.5], [0, 0, 1, '1'], [0, 0, 1, null], new Array(4), 'abcd', null]) {
    assert.equal(isPoolPlan(bad, 4), false, String(bad));
  }
});

test('isExperimental: the plan fits the room\'s capacity; the option stays optional', () => {
  assert.equal(isExperimental(twelve(THREE)), true);
  assert.equal(isExperimental(rules({ poolPlan: [0, 0, 1, 1] })), true, 'a four-seat room can split too');
  assert.equal(isExperimental(twelve([0, 0, 1, 1])), false, 'a plan of another capacity');
  assert.equal(isExperimental(rules({ poolPlan: 'x' })), false);
  assert.equal(isExperimental(rules()), true);
  // every optional key at once still passes the size bound
  assert.equal(isExperimental(twelve(THREE, { disableDuckLord: true, disableLayerCap: true, disableHitLimit: true, uniteHumansFirst: true })), true);
});

test('experimentalOptions: pools numbered by first appearance, frozen, replacing 禁用共享卡池; no plan, no key', () => {
  const options = experimentalOptions(rules({ disableSharedPool: true, poolPlan: [1, 1, 0, 0] }));
  assert.deepEqual(options.poolPlan, [0, 0, 1, 1]);
  assert.equal(Object.isFrozen(options.poolPlan), true);
  assert.equal(options.disableSharedPool, false, 'a plan already says every seat\'s pool');
  assert.equal('poolPlan' in experimentalOptions(rules()), false);
  assert.deepEqual(experimentalOptions(rules({ disableSharedPool: true })), rules({ disableSharedPool: true }), 'without a plan the switch stands');
  assert.throws(() => experimentalOptions(twelve([0])), TypeError);
});

test('one layout in any numbering is one key; another layout is another key', () => {
  const a = experimentalOptions(rules({ poolPlan: [0, 0, 1, 1] })), b = experimentalOptions(rules({ poolPlan: [1, 1, 0, 0] }));
  const c = experimentalOptions(rules({ poolPlan: [0, 1, 0, 1] })), plain = experimentalOptions(rules());
  assert.equal(experimentalKey(a), experimentalKey(b));
  assert.notEqual(experimentalKey(a), experimentalKey(c));
  assert.notEqual(experimentalKey(a), experimentalKey(plain));
  assert.equal(experimentalKey(plain), '00', 'a standard room keeps its key');
  assert.equal(sameExperimental(a, b), true);
  assert.equal(sameExperimental(rules({ poolPlan: [1, 1, 0, 0] }), a), true, 'an unnumbered request is the same layout');
  assert.equal(sameExperimental(a, c), false);
  assert.equal(sameExperimental(a, plain), false);
});

test('the options survive every copy a room\'s rules go through', () => {
  const options = experimentalOptions(twelve(THREE));
  for (const copy of [structuredClone(options), JSON.parse(JSON.stringify(options)), { ...options }]) {
    assert.equal(isExperimental(copy), true);
    assert.equal(isDeepStrictEqual(experimentalOptions(copy), options), true);
    assert.equal(sameExperimental(copy, options), true);
  }
});

test('the scale: up to four seats a complete pool, more scale with the seats', () => {
  assert.deepEqual([1, 3, 4, 5, 6, 12, 20].map(poolScale), [1, 1, 1, 1.25, 1.5, 3, 5]);
});

test('poolSeats and poolCount read a plan in any numbering', () => {
  assert.deepEqual(poolSeats([2, 2, 0, 1]), [[0, 1], [2], [3]]);
  assert.equal(poolCount([2, 2, 0, 1]), 3);
  assert.deepEqual(canonicalPoolPlan([2, 2, 0, 1]), [0, 0, 1, 2]);
});

test('the automatic rule as sizes: what createPoolGroups always built', () => {
  const sizes = (n, o) => autoPoolSizes(n, { experimental: true, ...o }).sizes;
  assert.deepEqual(sizes(5), [5]);
  assert.deepEqual(sizes(6), [3, 3]);
  assert.deepEqual(sizes(6, { legacySix: true }), [6]);
  assert.deepEqual(sizes(7), [4, 3]);
  assert.deepEqual(sizes(9), [3, 3, 3]);
  assert.deepEqual(sizes(6, { fixedChunks: true }), [4, 2]);
  assert.deepEqual(sizes(4, { independent: true }), [1, 1, 1, 1]);
  assert.deepEqual(autoPoolSizes(4).sizes, [4]);
  assert.equal(autoPoolSizes(5, { experimental: true }).enlarged, true);
  assert.equal(autoPoolSizes(6, { experimental: true }).enlarged, false);
});

test('where the editor starts: the room\'s capacity while filling, its taken seats past a standard team', () => {
  assert.deepEqual(autoPoolPlan(4), [0, 0, 0, 0]);
  assert.deepEqual(autoPoolPlan(8), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(autoPoolPlan(12, { seats: [0] }), THREE, 'a host alone sees the full room');
  assert.deepEqual(autoPoolPlan(20), Array.from({ length: 20 }, (_, i) => Math.floor(i / 4)));
  assert.deepEqual(autoPoolPlan(8, { seats: [0, 1, 2, 3, 4, 5] }), [0, 0, 0, 1, 1, 1, 1, 1], 'six of eight: 3 + 3, the empty seats behind the last taken');
  assert.deepEqual(autoPoolPlan(8, { seats: [0, 2, 3, 4, 6, 7] }), [0, 0, 0, 0, 1, 1, 1, 1], 'an empty seat follows the seat before it');
  assert.deepEqual(autoPoolPlan(4, { independent: true }), [0, 1, 2, 3]);
});

test('均分: balanced pools in seat order, the earlier ones the larger', () => {
  assert.deepEqual(evenPoolPlan(8, 2), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(evenPoolPlan(8, 3), [0, 0, 0, 1, 1, 1, 2, 2]);
  assert.deepEqual(evenPoolPlan(4, 4), [0, 1, 2, 3]);
  assert.deepEqual(evenPoolPlan(4, 1), [0, 0, 0, 0]);
});

test('＋ cuts the largest pool in two and leaves the others alone; a plan of single seats stays', () => {
  assert.deepEqual(splitPool([0, 0, 0, 0]), [0, 0, 1, 1]);
  assert.deepEqual(splitPool([0, 0, 1, 1, 1, 1, 1, 2]), [0, 0, 1, 1, 1, 3, 3, 2].map((p, i, a) => canonicalPoolPlan(a)[i]));
  assert.equal(poolCount(splitPool(THREE)), 4);
  assert.deepEqual(splitPool([0, 1, 2, 3]), [0, 1, 2, 3]);
});

test('－ joins the last pool to the one before it; a single pool stays', () => {
  assert.deepEqual(mergeLastPool(THREE), [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(mergeLastPool([0, 0, 0, 0]), [0, 0, 0, 0]);
  assert.deepEqual(mergeLastPool([0, 1, 0, 2]), [0, 1, 0, 1]);
});

test('moving a seat renumbers by first appearance, and a pool left empty is gone', () => {
  assert.deepEqual(moveSeat([0, 0, 1, 1], 1, 1), [0, 1, 1, 1]);
  assert.deepEqual(moveSeat([0, 1, 1, 1], 0, 1), [0, 0, 0, 0], 'the last seat of a pool leaves: one pool');
  assert.deepEqual(moveSeat([0, 0, 1, 1], 0, 1), [0, 1, 0, 0], 'seat 0 is always in pool 0: the pools swap numbers');
  assert.equal(poolCount(moveSeat(THREE, 3, 2)), 3);
});
