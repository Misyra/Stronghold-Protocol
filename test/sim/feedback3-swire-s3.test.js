// test/sim/feedback3-swire-s3.test.js — GitHub #89-1: 琳琅诗怀雅 S3 千金一掷 used to call skill.end('manual')
// from onTick once her coins were full and a ground enemy stood in the coin range. PRTS 卫戍协议/帮助 技能操作
// 「通常不会自动关闭技能」 and the skill text 「可随时主动关闭技能；携带此技能时金币上限为10」: she keeps it
// open. The close is still skill.end('manual') — the same call the old onTick used, and feedback1d-push.test.js —
// which spends the coins and pushes. No markable target still ends and does not throw.

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

test('琳琅诗怀雅 S3 stays open with a full purse and a coin target; skill.end(\'manual\') still spends', REAL, () => {
  const h = battle(true);
  const u = arm(h);
  const full = 10; // S3 blackboard sp: the purse cap 「金币上限为10」
  u.mem.coins = full;
  h.run(6);
  assert.equal(u.skill.active, true, 'several seconds do not close it');
  assert.equal(u.mem.coins, full, 'the coins are still hers');
  const e = h.enemies()[0];
  const hp0 = e.hp;
  u.skill.end('manual');
  assert.equal(u.skill.active, false);
  assert.equal(u.mem.coins, 0, 'the close spends every coin');
  assert.ok(e.hp < hp0, 'and the coins hit the enemy in range');
  assert.equal(h.b.errors.length, 0);
  checkInvariants(h.b);
});

test('琳琅诗怀雅 S3: closing with no markable target still ends and spends, and does not throw', REAL, () => {
  const h = battle(false);
  const u = arm(h);
  u.mem.coins = 4;
  assert.doesNotThrow(() => u.skill.end('manual'));
  assert.equal(u.skill.active, false);
  assert.equal(u.mem.coins, 0);
  assert.equal(h.hooksOf('damaged').length, 0, 'nothing to pay');
  assert.equal(h.b.errors.length, 0);
  checkInvariants(h.b);
});
