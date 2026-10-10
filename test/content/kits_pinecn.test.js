// 松果 S2: the ATK ramp belongs to a deployment, while Skill.activations stays cumulative.
// Sources: PRTS 松果 S2 备注; data/chess.json rank-4 / rank-7 blackboards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';

const FORMS = [
  { label: 'normal', id: 'chess_char_3_10_a', ramp: [0.25, 0.45, 0.65, 0.85, 0.85] },
  { label: 'elite without module', id: 'chess_char_3_10_b', moduleId: 'none', ramp: [0.4, 0.6, 0.8, 1, 1] },
  { label: 'elite RPR-X', id: 'chess_char_3_10_b', ramp: [0.4, 0.6, 0.8, 1, 1] },
];
const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: ${actual} ≈ ${expected}`);
const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors, []); };
function field(form, { atk = 0, units = null } = {}) {
  return makeBattle({
    seed: 5, timeLimit: 600, autoFinish: false,
    flags: { startOpCooldown: 3, dpInit: 99, dpPerSec: 10, dpMax: 999 },
    units: units ?? [{ chessId: form.id, moduleId: form.moduleId, uid: 1, row: 10, col: 4 }],
    defs: { enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e7, speed: 0, atk, range: 5, bat: 2 }) } },
    enemies: [{ key: 'enemy_dummy', pos: [10, 5] }],
  });
}

for (const form of FORMS) {
  test(`松果 S2 ${form.label}: natural casts grow within one deployment and stop at the fourth step`, () => {
    const h = field(form), u = h.unit(1);
    h.step();
    assert.equal(u.skill.id, 'skchr_pinecn_2');
    const wide = u.rangeKeys.length;
    for (const [i, atkPct] of form.ramp.entries()) {
      assert.ok(h.runUntil(() => u.skill.activations === i + 1, 60), `cast ${i + 1}`);
      close(u.s.atk, u.base.atk * (1 + atkPct), `cast ${i + 1} ATK`);
      assert.ok(u.rangeKeys.length < wide, 'the skill still shortens her range');
      assert.ok(h.runUntil(() => !u.skill.active, 21), 'the duration ends');
      close(u.s.atk, u.base.atk, 'ATK restored');
      assert.equal(u.rangeKeys.length, wide, 'range restored');
    }
    done(h);
  });

  test(`松果 S2 ${form.label}: a knock-out during the fourth cast restarts the ramp on redeployment`, () => {
    const h = field(form), u = h.unit(1);
    assert.ok(h.runUntil(() => u.skill.activations === 4, 240), 'four natural casts');
    close(u.s.atk, u.base.atk * (1 + form.ramp[3]), 'at the cap before the knock-out');
    h.b.kill(u, h.enemy('enemy_dummy'));
    assert.equal(u.findBuff('skill:pinecn_atk'), null, 'the active skill buff leaves with her');
    assert.ok(h.runUntil(() => u.alive && u.deployed, 90), 'automatic paid redeployment');
    assert.equal(u.skill.activations, 4, 'the engine activation sequence is still cumulative');
    assert.ok(h.runUntil(() => u.skill.activations === 5, 30), 'first natural cast after redeployment');
    close(u.s.atk, u.base.atk * (1 + form.ramp[0]), 'first ATK step again');
    assert.ok(h.runUntil(() => u.skill.activations === 6, 60), 'second natural cast after redeployment');
    close(u.s.atk, u.base.atk * (1 + form.ramp[1]), 'second ATK step again');
    done(h);
  });
}

test('松果 S2 normal: natural enemy damage, knock-out and redeployment give +25% on both first casts', () => {
  const h = field(FORMS[0], { atk: 225 }), u = h.unit(1);
  assert.ok(h.runUntil(() => u.skill.activations === 1, 30), 'first cast');
  close(u.s.atk, 735, '588 × 1.25');
  assert.ok(h.runUntil(() => !u.alive, 40), 'enemy attacks knock her out');
  assert.ok(h.runUntil(() => u.alive && u.deployed, 90), 'automatically redeployed');
  assert.equal(u.skill.activations, 1, 'the earlier cast remains in the engine sequence');
  assert.ok(h.runUntil(() => u.skill.activations === 2, 30), 'next natural cast');
  close(u.s.atk, 735, 'new deployment: 588 × 1.25');
  done(h);
});

test('松果 S2: redeploying one piece does not restart another piece\'s ramp', () => {
  const h = field(FORMS[0], { units: [
    { chessId: FORMS[0].id, uid: 1, row: 10, col: 4 },
    { chessId: FORMS[0].id, uid: 2, row: 11, col: 4 },
  ] });
  const a = h.unit(1), b = h.unit(2);
  assert.ok(h.runUntil(() => a.skill.activations === 2 && b.skill.activations === 2, 90));
  h.b.retreat(a, { reason: 'raid' });
  assert.ok(h.b.redeploy(a, { free: true }), 'only the first piece redeployed');
  close(b.s.atk, b.base.atk * 1.45, 'the second piece keeps its running second step');
  assert.ok(h.runUntil(() => a.skill.activations === 3, 30));
  close(a.s.atk, a.base.atk * 1.25, 'the first piece starts again');
  assert.ok(h.runUntil(() => b.skill.activations === 3, 60));
  close(b.s.atk, b.base.atk * 1.65, 'the second piece progresses to its third step');
  done(h);
});
