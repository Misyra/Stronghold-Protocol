// test/content/op_marcil.test.js — the 自选 operator kit of 玛露西尔 (char_4141_marcil, 6★ 扩散术师, a collab pick; kit
// server/sim/content/kits/ops/op-marcil.js), fielded the production way (a DIY slot + its `diy` pick) in every form. Every
// number is read back from data/backups.json.
// Run: node --test test/content/op_marcil.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const ID = 'char_4141_marcil';
const FORMS = BACKUPS.units[ID].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const S1 = 'skchr_marcil_1', S2 = 'skchr_marcil_2', S3 = 'skchr_marcil_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const bbOf = (id, tier = 5, elite = true) => formOf(tier, elite).skills.find((s) => s.skillId === id).bb;
const talent = (i, tier = 5, elite = true) => formOf(tier, elite).talents[i].bb;
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, atk: 0, ...o });
const ENEMIES = { enemy_dummy: dummy('enemy_dummy') };
const ALL_FORMS = [[5, false], [6, false], [5, true], [6, true]];

function field({ tier = 5, elite = true, skill = 0, row = 10, col = 5, enemies = [], others = [], seed = 5 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 600, autoFinish: false, seed, enemies,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'heal'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ID, skillIndex: skill, uniEquipId: null }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const stepFor = (h, s) => { for (let i = 0; i < Math.round(s * 30); i++) h.step(); };
const hitsBy = (h, u, pred = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && pred(c));
const setMana = (u, v) => { u.skill.sp = v; u.skill.charges = v >= u.skill.spCost ? 1 : 0; u.mem.marcilMana = v; };
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('玛露西尔 in every 自选 form: her kit, all three skills authored, 协防 + 奥术, 魔力 = mana_init of the skill + talent 2', () => {
  assert.ok(KITTED_CHARS.includes(ID));
  assert.equal(OPERATOR_KITS[ID], KITS[ID]);
  for (const [tier, elite] of ALL_FORMS) {
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, skill });
      const form = formOf(tier, elite);
      assert.deepEqual([u.def.charId, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ID, form.skills[skill].skillId, false, 'skills']);
      assert.deepEqual(u.def.bonds, ['emptyShip', 'arcaneShip']);
      const sb = form.skills[skill].bb;
      assert.equal(u.skill.sp, Math.min(sb.mana_max, sb.mana_init + form.talents[1].bb.mana_init));
      done(h);
    }
  }
});

test('魔力 never refills by time; with 魔力 ATK +atk and splash 1.5, without the profession\'s 1.1', () => {
  const { h, u } = field({ skill: 2 });
  const m0 = u.skill.sp;
  stepFor(h, 10);
  assert.equal(u.skill.sp, m0, 'no natural recovery');
  assert.equal(u.profile.splashRadius, 1.5);
  assert.equal(u.findBuff('marcil:power').mods.atkPct, talent(0).atk);
  setMana(u, 0);
  stepFor(h, 0.2);
  assert.equal(u.profile.splashRadius, 1.1);
  assert.ok(!u.findBuff('marcil:power'));
  done(h);
});

test('S1 才女的实力: chant (no attack), then ATK +atk, sp_cost per attack, ends below the minimum', () => {
  const { h, u } = field({ skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const bb = bbOf(S1);
  setMana(u, 6);
  stepFor(h, 0.2);
  assert.ok(u.findBuff('marcil:chant'), 'chanting');
  const n0 = h.hooksOf('attack').filter((c) => c.attacker === u).length;
  stepFor(h, bb.chant_duration - 0.3);
  assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, n0, 'no attack while chanting');
  stepFor(h, 0.3);
  assert.ok(u.skill.active, 'open');
  stepFor(h, 20);
  assert.ok(!u.skill.active, 'closed when 魔力 ran out');
  assert.ok(u.skill.sp < bb.skill_cost_min_sp);
  done(h);
});

test('S2 召唤使魔: chant, sp_cost, 停顿 on hit; with sp_cost left the second use upgrades it (range +1)', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const bb = bbOf(S2);
  setMana(u, 80);
  stepFor(h, bb.chant_duration + 0.5);
  // MARCILS2: opened once, then at once closed and chanted again with sp_cost still left
  assert.equal(u.mem.marcilFamiliar, 1);
  assert.equal(u.skill.sp, 80 - bb.sp_cost);
  assert.ok(u.findBuff('marcil:chant'), 'the second chant');
  stepFor(h, bb.chant_duration + 1);
  assert.equal(u.mem.marcilFamiliar, 2, 'upgraded');
  assert.ok(u.skill.active);
  assert.equal(u.skill.sp, 80 - 2 * bb.sp_cost);
  assert.ok(u.findBuff('marcil:familiar2'));
  stepFor(h, 4);
  assert.ok(h.hooksOf('statusApplied').some((c) => c.source === u && c.status === 'sluggish'));
  assert.ok(h.hooksOf('statusApplied').some((c) => c.source === u && c.status === 'stun'));
  done(h);
});

test('S3 爆破魔法: chant, a blast 2 tiles ahead on x-1, the extra chant, then a blast every interval while 魔力 lasts', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const bb = bbOf(S3);
  setMana(u, 40);
  stepFor(h, bb.chant_duration + 0.2);
  const blasts = () => hitsBy(h, u, (c) => c.dmg?.tags?.includes('blast')).length;
  assert.equal(blasts(), 1);
  stepFor(h, bb.extra_chant_duration + 0.2 + bb.interval * 6);
  assert.equal(blasts(), Math.floor(40 / bb.sp_cost_extra));
  assert.ok(!u.skill.active);
  assert.ok(u.skill.sp < bb.sp_cost_extra);
  done(h);
});
