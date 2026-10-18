// test/sim/svash2-s3-air.test.js — 凛御银灰 S3 变革已至 against air units (user playtest: the skill never cast on a wave
// of flyers only). Cause: the data's ACTIVE_RANGE trigger asks "is there an enemy in the running range" with the unit's
// BASE attack profile — his melee PIONEER one (data canHitFly false) drops every flyer, so the skill stayed ready forever
// while his S3 range, which covers air, was full of them.
// The engine is left exactly as upstream has it (server/sim identical to copy/xinhai): the fix lives in the kit, where
// content belongs — S3 casts itself once a target its range can actually hit stands in it (the automatic cast a MANUAL
// skill may make, skills.js `opCooling`), declares canHitFly in its `targeting` so its attacks reach air, and picks the
// other enemies on the target's line with an air profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';

const REAL = { skip: !hasGeneratedData() };
const ID = 'chess_char_5_14_a';   // 凛御银灰 (char_1045_svash2)
const S3 = 'skchr_svash2_3';
const flyer = (key) => enemyRec({ key, hp: 1e9, atk: 0, speed: 0, motion: 'FLY', mass: 1 });
const walker = (key) => enemyRec({ key, hp: 1e9, atk: 0, speed: 0, mass: 1 });

function battle(spawns) {
  const h = makeBattle({
    defs: { enemies: { e_fly: flyer('e_fly'), e_fly2: flyer('e_fly2'), e_walk: walker('e_walk'), e_walk2: walker('e_walk2') } },
    units: [{ chessId: ID, row: 10, col: 5, skillIndex: 2 }],
    enemies: spawns, hooks: ['damaged', 'skillStart', 'statusApplied'], captureNoisy: true, autoFinish: false, timeLimit: 30,
  });
  h.step();
  const u = h.unit(ID);
  assert.equal(u.skill.id, S3);
  assert.equal(u.skill.rule, 'ACTIVE_RANGE');
  u.skill.gainSp(u.skill.spCost * (u.skill.maxCharges || 1) + 1, 'test');
  return { h, u };
}

const damageTo = (h, u, e) => h.hooksOf('damaged')
  .filter((c) => c.source === u && c.target === e).reduce((s, c) => s + c.amount, 0);

test('凛御银灰 S3 fires on a wave of flyers only and hurts them', REAL, () => {
  const { h, u } = battle([{ key: 'e_fly', pos: [10, 6] }]);
  const e = h.enemies()[0];
  h.run(6);
  assert.equal(u.skill.activations, 1, 'the flyer in the skill range fires the skill');
  assert.equal(u.skill.active, true, 'it runs (duration 48 s)');
  assert.ok(damageTo(h, u, e) > 0, 'the flyer takes damage');
  const hits = h.hooksOf('damaged').filter((c) => c.source === u && c.target === e);
  assert.ok(hits.every((c) => c.dmg.isSkill && c.dmg.isAttack), 'as the skill mode of his attack');
  assert.ok(h.hooksOf('statusApplied').some((c) => c.source === u && c.target === e && c.status === 'fragile'), '脆弱 applied');
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
  checkInvariants(h.b);
});

test('凛御银灰 S3 hits a flyer on the target line with the same attack', REAL, () => {
  const { h, u } = battle([{ key: 'e_fly', pos: [10, 6] }, { key: 'e_fly2', pos: [10, 7] }]);
  const [main, line] = h.enemies();
  h.run(4);
  assert.equal(u.skill.activations, 1);
  assert.ok(damageTo(h, u, main) > 0, 'the target is hit');
  assert.ok(damageTo(h, u, line) > 0, 'so is the flyer behind it on the same line');
  assert.ok(h.hooksOf('damaged').some((c) => c.source === u && c.target === line && c.dmg.isSkill), 'with skill damage');
  checkInvariants(h.b);
});

test('凛御银灰 S3 on the ground is unchanged', REAL, () => {
  const { h, u } = battle([{ key: 'e_walk', pos: [10, 6] }]);
  const e = h.enemies()[0];
  h.run(6);
  assert.equal(u.skill.activations, 1);
  assert.equal(u.skill.active, true);
  const airless = battle([{ key: 'e_walk2', pos: [11, 6] }]);
  airless.h.run(6);
  assert.ok(damageTo(h, u, e) > 0, 'the ground enemy takes damage');
  assert.equal(airless.u.skill.activations, 1, 'a ground wave off the straight line still fires it');
  checkInvariants(h.b);
});
