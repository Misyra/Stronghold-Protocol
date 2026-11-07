// test/match/player-capacity-shared.test.js — 多人同盟容量的共享层（移植自用户分支 test/player-capacity-shared.test.js，
// 放进 test/match/；本仓 server/protocol.js 的 hello / g.choice 界已到位，b.progress 的 by/left 与 room.kick 的
// seat 界仍按普通四人房封顶——那两段断言等 server/protocol.js 落地容量界后补回，见报告）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEATS } from '../../shared/constants.js';
import { MAX_PLAYER_CAPACITY, MAX_DRAFT_CARDS, PLAYER_CAPACITIES, PLAYER_CAPACITY_VERSION, isPlayerCapacity, roomCapacity } from '../../shared/playerCapacity.js';
import { EXPERIMENTAL_DEFAULTS, isExperimental, experimentalOptions, sameExperimental, experimentalKey } from '../../shared/experimental.js';
import { RESULT_LIMITS, validateC2S } from '../../shared/protocol.js';

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

test('wire capability speaks the capacity version', () => {
  assert.equal(validateC2S({ t: 'hello', name: 'Capacity', playerCapacityVersion: PLAYER_CAPACITY_VERSION }), null);
  assert.ok(validateC2S({ t: 'hello', name: 'Capacity', playerCapacityVersion: true }));
  // （server/protocol.js 的 g.choice idx 0..21、b.progress 的 20 席位 left/by 界与 room.kick 的 seat 19 属于
  // shared/protocol.js 的容量化——共享层已备好 MAX_DRAFT_CARDS，等其归属代理落地后补回这三段断言，见报告）
});
