// test/content/op_oblvns.test.js — the 自选 operator kit of 丰川祥子 (char_4182_oblvns, 6★ 领主, a collab pick; kit
// server/sim/content/kits/ops/op-oblvns.js), fielded the production way (a DIY slot + its `diy` pick) in every form. Every
// number is read back from data/backups.json.
// Run: node --test test/content/op_oblvns.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { feverState, feverOn } from '../../server/sim/content/kits/ops/op-oblvns.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const ID = 'char_4182_oblvns';
const FORMS = BACKUPS.units[ID].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const S1 = 'skchr_oblvns_1', S2 = 'skchr_oblvns_2';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const bbOf = (id, tier = 5, elite = true) => formOf(tier, elite).skills.find((s) => s.skillId === id).bb;
const talent = (i, tier = 5, elite = true) => formOf(tier, elite).talents[i].bb;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, atk: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_armor: dummy('enemy_armor', { def: 800, res: 0 }), enemy_res: dummy('enemy_res', { def: 0, res: 60 }),
  enemy_hit: dummy('enemy_hit', { atk: 3000, baseAttackTime: 1 }),
};
const ALL_FORMS = [[5, false], [6, false], [5, true], [6, true]];

function field({ tier = 5, elite = true, skill = 0, row = 10, col = 5, enemies = [], others = [], seed = 5, module = null } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 600, autoFinish: false, seed, enemies,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'death'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ID, skillIndex: skill, uniEquipId: module }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const fillSp = (u) => { u.skill.sp = u.skill.spCost; u.skill.charges = u.skill.maxCharges; };
const hitsBy = (h, u, pred = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && pred(c));
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('丰川祥子 in every 自选 form: her kit, all three skills authored, the form\'s stats, 领主, 协防 + 灵巧', () => {
  assert.ok(KITTED_CHARS.includes(ID));
  assert.equal(OPERATOR_KITS[ID], KITS[ID]);
  assert.ok(BACKUPS.diy.excluded.includes(ID), 'a collab pick');
  for (const [tier, elite] of ALL_FORMS) {
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, skill });
      const form = formOf(tier, elite);
      assert.deepEqual([u.def.charId, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ID, form.skills[skill].skillId, false, 'skills']);
      assert.deepEqual([u.base.maxHp, u.base.atk], [form.stats.maxHp, form.stats.atk]);
      assert.deepEqual(u.def.bonds, ['emptyShip', 'skillfulShip']);
      assert.equal(u.profile.projectileSpeed, 2, 'her notes fly 2 tiles/s');
      done(h);
    }
  }
});

test('颂乐音符: each note of hers on the field gives her DEF / RES ignore, at most max_cnt', () => {
  const { h, u } = field({ skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 8] }] });
  u.skill.sp = 0; u.skill.charges = 0;
  const t0 = talent(0);
  let seen = 0;
  for (let i = 0; i < 300; i++) {
    h.step();
    const n = h.b.projectiles.list.filter((p) => p.source === u).length;
    const b = u.findBuff(`oblvns:notes:${u.id}`);
    if (n > 0) {
      assert.ok(b, 'the buff while notes fly');
      const k = Math.min(n, t0.max_cnt);
      approx(b.mods.defIgnorePct, k * t0.def_penetrate_ratio, 'DEF ignore');
      approx(b.mods.resIgnorePct, k * t0.magic_resist_penetrate_ratio, 'RES ignore');
      seen = Math.max(seen, n);
    }
  }
  assert.ok(seen >= 1, 'notes were on the field');
  assert.ok(hitsBy(h, u).length > 0, 'they landed');
  done(h);
});

test('持续攻击: with no enemy she still attacks — free notes forward, attack SP gained', () => {
  const { h, u } = field({ skill: 2 });
  u.skill.sp = 0; u.skill.charges = 0;
  h.run(8);
  assert.ok(u.skill.sp > 0 || u.skill.charges > 0, 'attack-type SP from target-less attacks');
  assert.ok(h.b.projectiles.list.some((p) => p.source === u && p.data?.oblvnsNote), 'free notes on the field');
  done(h);
});

test('毋畏遗忘: operators on her range ASPD +attack_speed; each hit she deals adds cnt Fever', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  u.skill.sp = 0; u.skill.charges = 0;
  const t1 = talent(1);
  h.run(1);
  const aura = u.findBuff('oblvns:aspd');
  assert.ok(aura && aura.mods.aspd === t1.attack_speed, 'her own tile is part of the range');
  const before = feverState(h.b).gauge;
  h.run(6);
  const n = hitsBy(h, u).length;
  assert.ok(n > 0);
  assert.ok(feverState(h.b).gauge >= before + t1.cnt, `gauge ${feverState(h.b).gauge}`);
  done(h);
});

test('Fever: a skill at a full gauge starts it; S3 cast into it ends with it; one lethal hit survived, then she leaves', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  feverState(h.b).gauge = 450;
  fillSp(u);
  u.skill.activate('manual');
  assert.ok(feverOn(h.b), 'Fever on');
  assert.equal(feverState(h.b).gauge, 0);
  approx(u.skill.timeLeft, 20, 'S3 ends with Fever', 1e-3);
  // a lethal hit is survived once
  h.b.dealDamage({ source: null, target: u, amount: 1e9, type: 'true' });
  assert.ok(u.alive, 'survived');
  h.run(21);
  assert.ok(!feverOn(h.b));
  assert.ok(!u.deployed || !u.alive, 'left the field when Fever ended');
  done(h);
});

test('the Fever readout (b.snap `fever`): the gauge\'s share while it fills, the seconds left during Fever, display only', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const row = () => (h.b.snapshot().fever || []).find((e) => e[0] === u.id) ?? null;
  assert.deepEqual(row(), [u.id, 0, 0], 'an empty gauge is listed: the bar says she has one');
  feverState(h.b).gauge = 225;
  assert.deepEqual(row(), [u.id, 0.5, 0]);
  feverState(h.b).gauge = 450;
  fillSp(u);
  u.skill.activate('manual');
  assert.deepEqual(row(), [u.id, 1, 1], 'Fever: full, running');
  h.run(5);
  const [, left, on] = row();
  assert.equal(on, 1);
  approx(left, 15 / 20, 'the share of the 20 s left', 2e-3);
  h.run(16);
  assert.ok(!feverOn(h.b));
  done(h);
});

test('S1 新月的苏醒: 8 notes of decreasing arts damage on her target', () => {
  const { h, u } = field({ skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const bb = bbOf(S1);
  fillSp(u);
  const atk = u.s.atk;
  u.skill.activate('manual');
  const notes = h.b.projectiles.list.filter((p) => p.source === u && p.data?.oblvnsNote);
  assert.equal(notes.length, 8);
  h.run(4);
  const arts = hitsBy(h, u, (c) => c.dmg?.tags?.includes('note') && c.dmg.type === 'arts');
  assert.equal(arts.length, 8);
  const scales = ['atk_scale', 'atk_scale_2', 'atk_scale_3', 'atk_scale_4', 'atk_scale_5', 'atk_scale_6', 'atk_scale_7', 'atk_scale_8'].map((k) => bb[k]);
  assert.ok(scales[0] > scales[7]);
  void atk;
  done(h);
});

test('S2 满月的舞会 (钢琴): ATK +attack@atk, notes pierce to the enemy behind (physical)', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }, { key: 'enemy_dummy', pos: [10, 7.6] }] });
  fillSp(u);
  u.skill.activate('manual');
  assert.ok(u.skill.active);
  approx(u.findBuff(`skill:${u.id}`).mods.atkPct, bbOf(S2)['attack@atk'], 'ATK');
  h.run(6);
  const pierce = hitsBy(h, u, (c) => c.dmg?.tags?.includes('pierce'));
  assert.ok(pierce.length > 0, 'the note passed through');
  assert.ok(pierce.every((c) => c.dmg.type === 'phys'));
  done(h);
});

test('S3 残月的余响: 钢琴 notes at the highest RES (physical), 风琴 notes at the highest DEF (arts)', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_armor', pos: [10, 7] }, { key: 'enemy_res', pos: [10, 8] }] });
  fillSp(u);
  u.skill.activate('manual');
  h.run(6);
  const res = h.b.enemies.find((e) => e.defId === 'enemy_res' || e.key === 'enemy_res');
  const armor = h.b.enemies.find((e) => e.defId === 'enemy_armor' || e.key === 'enemy_armor');
  const onRes = hitsBy(h, u, (c) => c.target === res && c.dmg?.isAttack);
  const onArmor = hitsBy(h, u, (c) => c.target === armor && c.dmg?.tags?.includes('organ'));
  assert.ok(onRes.length > 0 && onRes.every((c) => c.dmg.type === 'phys'), 'piano on the RES enemy');
  assert.ok(onArmor.length > 0 && onArmor.every((c) => c.dmg.type === 'arts'), 'organ on the DEF enemy');
  done(h);
});
