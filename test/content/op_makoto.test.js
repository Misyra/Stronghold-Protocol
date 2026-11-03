// test/content/op_makoto.test.js — the 自选 operator kit of 结城理 (char_4217_makoto, 6★ 傀儡师, a collab pick; kit
// server/sim/content/kits/ops/op-makoto.js), fielded the production way (a DIY slot + its `diy` pick) in every form. Every
// number is read back from data/backups.json.
// Run: node --test test/content/op_makoto.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const ID = 'char_4217_makoto';
const FORMS = BACKUPS.units[ID].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const S3 = 'skchr_makoto_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const bbOf = (id, tier = 5, elite = true) => formOf(tier, elite).skills.find((s) => s.skillId === id).bb;
const talent = (i, tier = 5, elite = true) => formOf(tier, elite).talents[i].bb;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, atk: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_armor: dummy('enemy_armor', { def: 1500, res: 0 }), enemy_res: dummy('enemy_res', { def: 0, res: 80 }),
  enemy_weak: dummy('enemy_weak', { hp: 3000, res: 95 }),
};
const ALL_FORMS = [[5, false], [6, false], [5, true], [6, true]];

function field({ tier = 5, elite = true, skill = 0, row = 10, col = 5, enemies = [], others = [], seed = 5, module = null } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 600, autoFinish: false, seed, enemies,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'skillStart', 'statusApplied', 'heal'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ID, skillIndex: skill, uniEquipId: module }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const fillSp = (u) => { u.skill.sp = u.skill.spCost; u.skill.charges = u.skill.maxCharges; };
const hitsBy = (h, u, pred = () => true, from = 0) => h.hooksOf('damaged').slice(from).filter((c) => c.source === u && pred(c));
const stepFor = (h, s) => { for (let i = 0; i < Math.round(s * 30); i++) h.step(); };
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('结城理 in every 自选 form: her kit, all three skills authored, 傀儡师, 拉特兰 + 不屈', () => {
  assert.ok(KITTED_CHARS.includes(ID));
  assert.equal(OPERATOR_KITS[ID], KITS[ID]);
  for (const [tier, elite] of ALL_FORMS) {
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, skill });
      assert.deepEqual([u.def.charId, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ID, formOf(tier, elite).skills[skill].skillId, false, 'skills']);
      assert.deepEqual(u.def.bonds, ['lateranoShip', 'indomShip']);
      done(h);
    }
  }
});

test('the skill switches to the <替身> at once: range x-1, ATK / HP / attack interval of 不羁之力, nearby enemies 停顿', () => {
  const { h, u } = field({ skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const t0 = talent(0);
  const atk0 = u.s.atk, iv0 = u.s.interval;
  fillSp(u);
  u.skill.activate('manual');
  assert.ok(u.trait.doll, '<替身>');
  stepFor(h, 1.2);
  approx(u.s.atk, atk0 * (1 + t0.atk) / 1, 'ATK', 0.02);
  approx(u.s.interval, iv0 * (1 + t0.base_attack_time / formOf(5, true).stats.bat), 'interval', 0.02);
  assert.equal(u.rangeGrid.length, 13, 'x-1');
  assert.ok(h.hooksOf('statusApplied').some((c) => c.source === u && c.status === 'sluggish'), '停顿');
  done(h);
});

test('S1 俄耳甫斯: arts attacks; an ally at or below half HP is healed instead', () => {
  const { h, u } = field({ skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }],
    others: [{ uid: 2, chessId: 'chess_char_1_02_a', row: 10, col: 4 }] });
  fillSp(u);
  u.skill.activate('manual');
  stepFor(h, 1.1);
  const n0 = h.hooksOf('damaged').length;
  stepFor(h, 3);
  const persona = hitsBy(h, u, (c) => c.dmg?.isAttack, n0);
  assert.ok(persona.length && persona.every((c) => c.dmg.type === 'arts'), 'the persona deals arts');
  const ally = h.unit(2);
  ally.hp = ally.s.maxHp * 0.3;
  stepFor(h, 3);
  assert.ok(h.hooksOf('heal').some((c) => c.source === u && c.target === ally), 'healed');
  done(h);
});

test('S2 塔纳托斯: a 恐惧 enemy below the threshold is executed', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_weak', pos: [10, 6] }] });
  fillSp(u);
  u.skill.activate('manual');
  stepFor(h, 1.2);
  const e = h.b.enemies[0];
  h.b.applyStatus(e, 'fear', { duration: 3, source: u, force: true });
  stepFor(h, 0.5);
  assert.ok(!e.alive, 'executed');
  done(h);
});

test('S3: 弱点伤害 picks the type the target takes more of; a lethal hit on 塔纳托斯·改 switches to 俄耳甫斯·改', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_armor', pos: [10, 6] }, { key: 'enemy_res', pos: [10, 7] }] });
  fillSp(u);
  u.skill.activate('manual');
  stepFor(h, 1.1);
  const n0 = h.hooksOf('damaged').length;
  stepFor(h, 5);
  const armor = h.b.enemies.find((e) => e.s.def > 1000), res = h.b.enemies.find((e) => e.s.res > 50);
  const onArmor = hitsBy(h, u, (c) => c.target === armor && c.dmg?.isAttack, n0), onRes = hitsBy(h, u, (c) => c.target === res && c.dmg?.isAttack, n0);
  assert.ok(onArmor.length && onArmor.every((c) => c.dmg.type === 'arts'), 'arts on the armoured one');
  assert.ok(onRes.length && onRes.every((c) => c.dmg.type === 'phys'), 'physical on the resistant one');
  h.b.dealDamage({ source: null, target: u, amount: 1e9, type: 'true' });
  assert.ok(u.alive && u.trait.doll, 'still the <替身>');
  assert.equal(u.mem.makotoPersona, 'orpheusEx');
  assert.equal(u.s.blockCnt, bbOf(S3)['attack@block_cnt']);
  done(h);
});

test('S.E.E.S.队长: when the <替身> ends, enemies on x-1 take atk_scale × ATK true damage', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const t1 = talent(1);
  fillSp(u);
  u.skill.activate('manual');
  stepFor(h, 22.5);
  assert.ok(!u.trait.doll, 'back to the 本体');
  const all = hitsBy(h, u, (c) => c.dmg?.tags?.includes('allOut'));
  assert.equal(all.length, 1);
  assert.equal(all[0].type ?? all[0].dmg.type, 'true');
  approx(all[0].dmg.amount, u.s.atk * t1.atk_scale, 'damage', 0.02);
  done(h);
});
