import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEATS } from '../shared/constants.js';
import { MAX_PLAYER_CAPACITY, MAX_DRAFT_CARDS, PLAYER_CAPACITIES, PLAYER_CAPACITY_VERSION, isPlayerCapacity, roomCapacity } from '../shared/playerCapacity.js';
import { EXPERIMENTAL_DEFAULTS, isExperimental, experimentalOptions, sameExperimental, experimentalKey } from '../shared/experimental.js';
import { RESULT_LIMITS, validateC2S } from '../shared/protocol.js';

const rules = () => ({ revivalEnabled: false, disableSharedPool: false });

test('ordinary capacity and result-player budget stay distinct from the experimental maximum', () => {
  assert.equal(MAX_SEATS, 4); assert.equal(MAX_PLAYER_CAPACITY, 20); assert.equal(MAX_DRAFT_CARDS, 22);
  assert.deepEqual(PLAYER_CAPACITIES, [4, 8, 12, 16, 20]); assert.ok(Object.isFrozen(PLAYER_CAPACITIES));
  assert.equal(RESULT_LIMITS.players, 4, 'one battlefield still has at most two participating players, not the full alliance');
  assert.equal(roomCapacity('coop', null), 4);
  for (const capacity of PLAYER_CAPACITIES) {
    assert.equal(isPlayerCapacity(capacity), true);
    assert.equal(roomCapacity('coop', { playerCapacity: capacity }), capacity);
    assert.equal(roomCapacity('solo', { playerCapacity: capacity }), 1);
  }
  for (const capacity of [0, 1, 5, 7, 21, 20.1, '20', NaN, Infinity, null, true]) {
    assert.equal(isPlayerCapacity(capacity), false);
    assert.equal(isExperimental({ ...rules(), playerCapacity: capacity }), false);
    assert.equal(roomCapacity('coop', { playerCapacity: capacity }), 4);
  }
});

test('default canonical rules retain the original two-field shape and immutable independent copies', () => {
  assert.deepEqual(EXPERIMENTAL_DEFAULTS, rules());
  const plain = experimentalOptions(rules()), explicit = experimentalOptions({ ...rules(), playerCapacity: 4 });
  assert.deepEqual(plain, rules()); assert.deepEqual(explicit, rules());
  assert.ok(Object.isFrozen(plain)); assert.ok(Object.isFrozen(explicit));
  assert.equal(sameExperimental(plain, explicit), true); assert.equal(experimentalKey(explicit), '00');
  for (const capacity of PLAYER_CAPACITIES.slice(1)) {
    const input = { ...rules(), playerCapacity: capacity }, parsed = experimentalOptions(input);
    assert.notEqual(parsed, input); assert.ok(Object.isFrozen(parsed)); assert.deepEqual(parsed, input);
    assert.equal(experimentalKey(parsed), `00:${capacity}`);
    assert.equal(sameExperimental(plain, parsed), false);
    input.playerCapacity = 4; assert.equal(parsed.playerCapacity, capacity);
  }
});

test('capacity schema rejects unknown, accessor, inherited, symbol and non-enumerable properties without invoking getters', () => {
  let invoked = false;
  const accessor = Object.defineProperty(rules(), 'playerCapacity', { enumerable: true, get() { invoked = true; throw new Error('getter'); } });
  assert.equal(roomCapacity('coop', accessor), 4);
  for (const value of [accessor, Object.assign(Object.create(rules()), { playerCapacity: 8 }),
    { ...rules(), capacity: 8 }, { ...rules(), playerCapacity: 8, extra: false }, { ...rules(), [Symbol('capacity')]: 8 },
    Object.defineProperty(rules(), 'playerCapacity', { value: 8 }), { playerCapacity: 8 }, { ...rules(), revivalEnabled: 1 }]) {
    assert.equal(isExperimental(value), false); assert.throws(() => experimentalOptions(value), TypeError);
  }
  assert.equal(invoked, false);
});

test('wire indices and leaker-source maps have finite expanded bounds; damage and result participants do not', () => {
  assert.equal(validateC2S({ t: 'hello', name: 'Capacity', playerCapacityVersion: PLAYER_CAPACITY_VERSION }), null);
  assert.ok(validateC2S({ t: 'hello', name: 'Capacity', playerCapacityVersion: true }));
  for (const seat of [4, 19]) assert.equal(validateC2S({ t: 'room.kick', seat, playerId: 'p1' }), null);
  for (const seat of [-1, 20, 19.5]) assert.ok(validateC2S({ t: 'room.removeBot', seat }));
  assert.equal(validateC2S({ t: 'g.choice', idx: 21 }), null); assert.ok(validateC2S({ t: 'g.choice', idx: 22 }));
  const left = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, i]));
  const progress = { t: 'b.progress', battleId: 'b1', gt: 1, killed: 0, total: 1, left };
  assert.equal(validateC2S(progress), null);
  assert.ok(validateC2S({ ...progress, left: { ...left, p20: 0 } }));
  assert.ok(validateC2S({ ...progress, left: { p1: -1 } }));
  assert.ok(validateC2S({ ...progress, by: { p1: 1, p2: 1, p3: 1, p4: 1, p5: 1 } }));
});
