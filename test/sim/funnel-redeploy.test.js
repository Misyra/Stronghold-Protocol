// PRTS 分支特性信息/data §驭械术师: changing targets / redeploying resets the drone ramp.
// Controlled battle inputs here; the real Match route is covered in test/match/funnel-redeploy.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';

const make = (id = 'chess_char_2_10_a', extra = []) => makeBattle({
  units: [{ chessId: id, row: 10, col: 4 }, ...extra],
  defs: { enemies: { dummy: enemyRec({ key: 'dummy', hp: 1e7, speed: 0 }) } },
  enemies: [{ key: 'dummy', pos: [10, 6] }], timeLimit: 300, autoFinish: false,
  hooks: ['damaged'], captureNoisy: true,
});
const hits = (h, u) => h.hooksOf('damaged').filter(c => c.source === u && c.target.side === 'enemy');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const ramp = (h, u) => {
  h.runUntil(() => hits(h, u).length >= 8, 20);
  assert.ok(hits(h, u).length >= 8);
};

for (const id of ['chess_char_2_10_a', 'chess_char_2_10_b', 'chess_char_4_03_a', 'chess_char_4_03_b']) {
  test(`${id}: same living target starts at the configured initial scale after automatic redeployment`, () => {
    const h = make(id), u = h.unit(id);
    ramp(h, u);
    const e = h.enemies()[0];
    assert.ok(u.trait.funnelScale > u.profile.funnel.init);
    const before = hits(h, u).length;
    h.b.dealDamage(e, u, { amount: 1e7, type: 'true' });
    assert.equal(u.alive, false);
    h.runUntil(() => u.alive, 100);
    assert.equal(u.alive, true);
    assert.equal(e.alive, true);
    assert.equal(u.trait.funnelTarget, null);
    near(u.trait.funnelScale, u.profile.funnel.init);
    assert.equal(h.runUntil(() => hits(h, u).length > before, 5), true);
    assert.ok(hits(h, u).length > before);
    assert.equal(hits(h, u).at(-1).target, e);
    near(u.trait.funnelScale, u.profile.funnel.init);
    checkInvariants(h.b);
    assert.deepEqual(h.b.errors, []);
  });
}

for (const id of ['chess_char_3_13_a', 'chess_char_3_13_b', 'chess_char_3_20_a', 'chess_char_3_20_b']) {
  test(`${id}: per-target funnel map restarts on redeployment`, () => {
    const h = make(id), u = h.unit(id);
    ramp(h, u);
    const e = h.enemies()[0];
    assert.ok(u.trait.funnelMap.get(e.id).s > u.profile.funnel.init);
    h.b.retreat(u);
    assert.equal(h.b.redeploy(u), true);
    assert.equal(u.trait.funnelMap.size, 0);
    const before = hits(h, u).length;
    assert.equal(h.runUntil(() => hits(h, u).length > before, 5), true);
    assert.ok(hits(h, u).length > before);
    near(u.trait.funnelMap.get(e.id).s, u.profile.funnel.init);
    checkInvariants(h.b);
  });
}

test('continuous attacks ramp and cap; changing the living target resets normally', () => {
  const h = make(), u = h.unit('chess_char_2_10_a');
  ramp(h, u);
  near(u.trait.funnelScale, u.profile.funnel.max);
  const replacement = h.spawn('dummy', { pos: [10, 5] });
  const before = hits(h, u).length;
  assert.equal(h.runUntil(() => hits(h, u).length > before, 5), true);
  assert.ok(hits(h, u).length > before);
  assert.equal(hits(h, u).at(-1).target, replacement);
  near(u.trait.funnelScale, u.profile.funnel.init);
});

test('another unit deployment and a free move keep this ramp; unrelated trait state survives redeployment', () => {
  const h = make('chess_char_2_10_a', [{ chessId: 'chess_char_1_02_a', row: 12, col: 3 }]);
  const u = h.unit('chess_char_2_10_a'), other = h.unit('chess_char_1_02_a');
  ramp(h, u);
  const scale = u.trait.funnelScale, target = u.trait.funnelTarget;
  u.trait.testUnrelated = { value: 7 }; // controlled sentinel: no production trait object may be replaced
  const sentinel = u.trait.testUnrelated;
  h.b.retreat(other);
  assert.equal(h.b.redeploy(other), true);
  assert.equal(u.trait.funnelTarget, target);
  near(u.trait.funnelScale, scale);
  assert.equal(h.b.moveRedeploy(u, 10, 3), true); // owner-approved move carry, DESIGN §22.3
  assert.equal(u.trait.funnelTarget, target);
  near(u.trait.funnelScale, scale);
  h.b.retreat(u);
  assert.equal(h.b.redeploy(u), true);
  assert.equal(u.trait.testUnrelated, sentinel);
  near(u.trait.funnelScale, u.profile.funnel.init);
});
