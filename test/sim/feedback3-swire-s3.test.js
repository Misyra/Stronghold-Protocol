// test/sim/feedback3-swire-s3.test.js — 琳琅诗怀雅 S3 千金一掷. Owner 2026-10-04: the written purse cap
// (「金币上限为10」) is the close. At the cap the coins are shot (skill.end('manual'): damage + radial push).
// Below the cap the skill stays open. No mark still spends and hits nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';

const REAL = { skip: !hasGeneratedData() };
const ID = 'chess_char_3_04_a';
const foe = enemyRec({ key: 'e_sw', hp: 1e9, atk: 0, speed: 0, def: 0, res: 0, mass: 1 });

function battle(withEnemy) {
  return makeBattle({
    defs: { enemies: { e_sw: foe } },
    units: [{ chessId: ID, row: 10, col: 5, skillIndex: 2 }],
    enemies: withEnemy ? [{ key: 'e_sw', pos: [10, 6] }] : [],
    hooks: ['damaged', 'skillEnd'], autoFinish: false, timeLimit: 30,
  });
}
const arm = (h) => {
  h.step();
  const u = h.unit(ID);
  assert.equal(u.skill.id, 'skchr_swire2_3');
  assert.ok(u.skill.active || u.skill.activate('test', { free: true }));
  return u;
};

test('琳琅诗怀雅 S3 shoots the purse when it reaches the cap of 10, and stays open below it', REAL, () => {
  const under = battle(true);
  const u9 = arm(under);
  u9.mem.coins = 9;
  // shorter than the merchant trait's 3 s payment, which would add a coin and reach the cap
  under.run(2);
  assert.equal(u9.skill.active, true, '9 coins do not close it');
  assert.equal(u9.mem.coins, 9);

  const h = battle(true);
  const u = arm(h);
  const e = h.enemies()[0];
  const hp0 = e.hp;
  u.mem.coins = 10;
  h.run(0.2);
  assert.equal(u.skill.active, false, 'the cap shoots');
  assert.equal(u.mem.coins, 0, 'every coin is spent');
  assert.ok(e.hp < hp0, 'the coins hit the enemy in range');
  assert.equal(h.b.errors.length, 0);
  checkInvariants(h.b);
});

test('琳琅诗怀雅 S3: the cap with no markable target still ends and spends, and does not throw', REAL, () => {
  const h = battle(false);
  const u = arm(h);
  u.mem.coins = 10;
  assert.doesNotThrow(() => h.run(0.2));
  assert.equal(u.skill.active, false);
  assert.equal(u.mem.coins, 0);
  assert.equal(h.hooksOf('damaged').length, 0, 'nothing to pay');
  assert.equal(h.b.errors.length, 0);
  checkInvariants(h.b);
});

test('琳琅诗怀雅 S3: a manual close below the cap still spends', REAL, () => {
  const h = battle(false);
  const u = arm(h);
  u.mem.coins = 4;
  assert.doesNotThrow(() => u.skill.end('manual'));
  assert.equal(u.skill.active, false);
  assert.equal(u.mem.coins, 0);
  assert.equal(h.hooksOf('damaged').length, 0);
  checkInvariants(h.b);
});
