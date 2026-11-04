// test/content/op_oxi.test.js — the 自选 operator kit of 塔露拉 (char_4247_oxi, 6★ 本源近卫; kit
// server/sim/content/kits/ops/op-oxi.js), fielded the production way (a DIY slot + its `diy` pick) in every form: tiers 5 / 6,
// normal (E2 Lv1, skill rank 4) and elite (E2 Lv60, rank 7). She has no module. Every number is read back from
// data/backups.json; the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_oxi.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool, diyRecord } from '../../shared/diy.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const CHESS = JSON.parse(readFileSync(new URL('../../data/chess.json', import.meta.url), 'utf8'));
const OXI = 'char_4247_oxi';
const FORMS = BACKUPS.units[OXI].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const S1 = 'skchr_oxi_1', S2 = 'skchr_oxi_2', S3 = 'skchr_oxi_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const bbOf = (elite, id) => formOf(5, elite).skills.find((s) => s.skillId === id).bb;
const talent = (i) => formOf(5, true).talents[i].bb;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, atk: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
  enemy_hit: dummy('enemy_hit', { atk: 500, baseAttackTime: 1 }),
};
const ALL_FORMS = [[5, false], [6, false], [5, true], [6, true]];

function field({ tier = 5, elite = true, skill = 0, row = 10, col = 5, enemies = [], others = [], seed = 5 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 600, autoFinish: false, seed, enemies,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'attack'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: OXI, skillIndex: skill, uniEquipId: null }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const fillSp = (u) => { u.skill.sp = u.skill.spCost; u.skill.charges = u.skill.maxCharges; };
const hitsOf = (h, u, tag) => h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.tags?.includes(tag));
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('塔露拉 in every 自选 form: her kit, all three skills authored, the form\'s stats, blocks 2, melee arts, 协防 + 奥术 + 不屈, no 特质', () => {
  assert.ok(KITTED_CHARS.includes(OXI));
  assert.equal(OPERATOR_KITS[OXI], KITS[OXI]);
  for (const tier of [5, 6]) assert.ok(diyPool(tier, { data: { backups: BACKUPS, chess: CHESS }, kitted: KITTED_CHARS }).includes(OXI), `tier ${tier} picker`);
  for (const [tier, elite] of ALL_FORMS) {
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, skill });
      const form = formOf(tier, elite);
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [OXI, SLOT[tier], form.skills[skill].skillId, false, 'skills']);
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def], [form.stats.maxHp, form.stats.atk, form.stats.def]);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.canHitFly, u.dmgType], [2, 'melee', false, 'arts']);
      assert.deepEqual(u.def.bonds, ['emptyShip', 'arcaneShip', 'indomShip']);
      assert.deepEqual(u.def.raw.garrisonIds, []);
      done(h);
    }
  }
  assert.deepEqual(BACKUPS.diy.operators[OXI].powers, ['ursus']);
  assert.deepEqual(FORMS['2/1/4/0'].modules ?? [], [], 'no module was released with her');
  assert.ok(!BACKUPS.diy.excluded.includes(OXI));
});

test('绝不妥协: attacks deal arts; every arts hit adds ep_damage_ratio of the damage as 灼燃损伤', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  u.skill.sp = 0; u.skill.charges = 0;
  u.mem.oxi.anger = 0; u.mem.oxi.growAt = Infinity;
  h.runUntil(() => hitsOf(h, u, 'oxi:burn').length >= 1 || h.hooksOf('damaged').some((c) => c.source === u && c.type === 'arts'), 5);
  h.step();
  const hit = h.hooksOf('damaged').find((c) => c.source === u && c.type === 'arts' && c.dmg?.isAttack);
  assert.ok(hit, 'an arts attack');
  const e = h.enemies()[0];
  approx(e.elem.burn, hit.amount * talent(0).ep_damage_ratio, 'gauge', 1e-3);
  done(h);
});

test('绝不妥协 怒火: 0 at deployment, +1 per step, capped at arcane_max / arcane_step; an attack spends one and holds 3 s', () => {
  const { h, u } = field({ skill: 2 });
  const t = talent(0), m = u.mem.oxi, cap = Math.round(t.arcane_max / t.arcane_step);
  assert.equal(cap, 6);
  assert.ok(m.anger <= 1);
  h.run(t.arcane_step_interval * (cap + 2));
  assert.equal(m.anger, cap);
  h.b.emit('attack', { attacker: u, targets: [], isSkill: false });
  assert.equal(m.anger, cap - 1);
  h.run(t.arcane_idle_delay - 0.1);
  assert.equal(m.anger, cap - 1, 'held for arcane_idle_delay');
  h.run(0.2);
  assert.equal(m.anger, cap);
  h.b.emit('attack', { attacker: u, targets: [], isSkill: true });
  assert.equal(m.anger, cap, 'a skill attack spends none');
  done(h);
});

test('绝不妥协: ×(1 + step × 怒火) on her arts and 元素伤害, nothing on physical damage', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 8] }] });
  const t = talent(0), e = h.enemies()[0], m = u.mem.oxi;
  const deal = (type) => {
    const before = h.hooksOf('damaged').length;
    h.b.dealDamage({ source: u, target: e, amount: 1000, type, ...(type === 'elemental' ? { element: 'burn' } : {}), tags: ['probe'] });
    return h.hooksOf('damaged')[before].amount;
  };
  m.anger = 0;
  const arts0 = deal('arts'), el0 = deal('elemental'), ph0 = deal('phys');
  m.anger = 6;
  approx(deal('arts'), arts0 * (1 + t.arcane_step * 6), 'arts');
  approx(deal('elemental'), el0 * (1 + t.arcane_step * 6), 'elemental');
  approx(deal('phys'), ph0, 'phys');
  done(h);
});

test('我即火焰: a burst lets its enemy leave 足迹; each pulse hits ground enemies on them with live ATK arts; they end with her', () => {
  const { h, u } = field({ skill: 2, row: 10, col: 5, enemies: [{ key: 'enemy_dummy', pos: [12, 8] }, { key: 'enemy_fly', pos: [12, 8] }] });
  const t = talent(1), [e] = h.enemies();
  u.mem.oxi.anger = 0; u.mem.oxi.growAt = Infinity;
  h.b.dealElementDamage({ source: u, target: e, element: 'burn', amount: 1e6, tags: ['probe'] });
  h.step();
  const tiles = u.mem.oxiTiles;
  assert.equal(tiles.size, 1);
  h.run(t.field_interval * 3 + 0.05);
  const hits = hitsOf(h, u, 'oxi:field');
  assert.ok(hits.length >= 3 && hits.every((c) => c.target === e && c.type === 'arts'), 'ground only');
  assert.ok(h.b.time < t.field_duration);
  u.alive = false;
  h.step();
  assert.equal(tiles.size, 0, 'gone when she leaves');
  u.alive = true;
});

test('我即火焰: at most max_count tiles, a tile lasts field_duration, a burst trails for 5 s', () => {
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [12, 3] }] });
  const t = talent(1), [e] = h.enemies();
  h.b.dealElementDamage({ source: u, target: e, element: 'burn', amount: 1e6, tags: ['probe'] });
  h.step();
  assert.equal(u.mem.oxiTiles.size, 1);
  h.run(5.1 + t.field_duration + 0.1);
  assert.equal(u.mem.oxiTiles.size, 0, 'no new tile after 5 s, the old one expired');
  done(h);
});

test('S1 照霎白夜: fires with an enemy in reach, atk_scale arts and 恐惧 on the ground enemies of the target tile, nobody else', () => {
  for (const [tier, elite] of ALL_FORMS) {
    const { h, u } = field({ tier, elite, skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_fly', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 7] }] });
    const bb = bbOf(elite, S1);
    u.mem.oxi.anger = 0; u.mem.oxi.growAt = Infinity;
    assert.equal(u.skill.manual, false);
    fillSp(u);
    h.runUntil(() => hitsOf(h, u, 'oxi:s1').length > 0, 3);
    const hits = hitsOf(h, u, 'oxi:s1');
    assert.equal(hits.length, 2, 'both ground enemies of the tile');
    const fears = h.hooksOf('statusApplied').filter((c) => c.status === 'fear');
    assert.equal(fears.length, 2);
    approx(fears[0].duration, bb.fear, 'fear', 1e-3);
    assert.ok(h.hooksOf('skillEnd').some((c) => c.unit === u), 'instant');
    done(h);
  }
});

test('S2 阂断骤雪: 5 charges from initSp, cast by an enemy hit: that hit ×0.1, retaliation around the source, a heal, a layer', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_hit', pos: [10, 6] }] });
  const bb = bbOf(true, S2), sk = u.skill, e = h.enemies()[0];
  assert.equal(sk.maxCharges, 5);
  assert.equal(sk.rule, 'NEVER');
  const start = formOf(5, true).skills.find((s) => s.skillId === S2);
  assert.equal(sk.spTotal >= start.initSp - 1, true, 'starts from initSp');
  fillSp(u);
  const charges = sk.charges, def = u.s.def;
  u.hp = u.s.maxHp * 0.5;
  const hp = u.hp;
  h.b.dealDamage({ source: e, target: u, amount: 2000, type: 'phys', tags: ['probe'] });
  const first = h.hooksOf('damaged').find((c) => c.target === u);
  approx(first.amount, (2000 - def) * bb.damage_remaining_scale, 'the casting hit falls to 10 %', 1e-3);
  assert.equal(sk.charges, charges - 1);
  const ret = hitsOf(h, u, 'oxi:s2');
  assert.equal(ret.length, 1);
  assert.equal(ret[0].target, e);
  assert.equal(ret[0].type, 'arts');
  assert.equal(u.mem.oxi.layers, 1);
  approx(u.hp, hp - first.amount + ret[0].amount * bb.heal_ratio, 'heals heal_ratio of the damage', 1e-3);
  done(h);
});

test('S2: no second cast while the effect runs; 庇护 holds, then fades to 0 at skill_duration; DoT and source-less hits never cast it', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const bb = bbOf(true, S2), sk = u.skill, e = h.enemies()[0];
  fillSp(u);
  const n = sk.charges;
  h.b.dealDamage({ source: e, target: u, amount: 100, type: 'arts', tags: ['dot'], attackType: 'BUFF' });
  h.b.dealDamage({ source: null, target: u, amount: 100, type: 'arts', tags: ['probe'] });
  assert.equal(sk.charges, n, 'a DoT and a source-less hit do not cast');
  h.b.dealDamage({ source: e, target: u, amount: 100, type: 'phys', tags: ['probe'] });
  assert.equal(sk.charges, n - 1);
  h.b.dealDamage({ source: e, target: u, amount: 100, type: 'phys', tags: ['probe'] });
  assert.equal(sk.charges, n - 1, 'the effect runs: no recast');
  h.run(0.1);
  const taken = () => {
    const i = h.hooksOf('damaged').length;
    u.hp = u.s.maxHp;
    h.b.dealDamage({ source: e, target: u, amount: 2000, type: 'arts', tags: ['probe'] });
    return h.hooksOf('damaged').slice(i).find((c) => c.target === u).amount;
  };
  const res = 1 - u.s.res / 100;
  approx(taken(), 2000 * res * (1 - bb.damage_resistance), '庇护 at full strength', 1e-2);
  h.run(bb.skill_duration - bb.shelter_hold_duration - 0.3); // about 0.8 s in: fading, not gone
  const fading = taken();
  assert.ok(fading > 2000 * res * (1 - bb.damage_resistance) * 1.2 && fading < 2000 * res, `庇护 fading: ${fading}`);
  h.run(0.6);
  sk.charges = 0; sk.sp = 0;
  approx(taken(), 2000 * res, '庇护 gone', 1e-3);
  fillSp(u);
  h.b.dealDamage({ source: e, target: u, amount: 100, type: 'phys', tags: ['probe'] });
  assert.equal(sk.charges, sk.maxCharges - 1, 'castable again');
  done(h);
});

test('S2: a dodged hit casts nothing (PRTS 未被成功闪避) — her 闪避 is rolled for it once, at the guard; a hit not dodged casts as before and is not rolled again', () => {
  const bb = bbOf(true, S2);
  const taggedAll = (h, tag) => h.hooksOf('damaged').filter((c) => c.dmg?.tags?.includes(tag));
  for (const [type, mod] of [['phys', 'dodgePhys'], ['arts', 'dodgeArts']]) {
    // a certain dodge: no charge, no window, no 庇护, no layer, no retaliation
    const { h, u } = field({ skill: 1 });
    fillSp(u);
    h.b.addBuff(u, { key: 'test:dodge', mods: { [mod]: 1 } });
    const src = h.spawn('enemy_dummy', { pos: [10, 7] });
    const hp0 = u.hp;
    const dodges = () => h.eventsOf('fx').filter((e) => e[1] === 'dodge').length;
    h.b.dealDamage(src, u, { amount: 2000, type });
    assert.deepEqual([u.hp, dodges(), u.skill.charges, u.skill.activations], [hp0, 1, u.skill.maxCharges, 0], `${type}: one MISS, every charge kept`);
    h.run(0.2);
    assert.deepEqual([!!u.findBuff('protect'), u.mem.oxi.layers, taggedAll(h, 'oxi:s2').length], [false, 0, 0], `${type}: nothing of the cast`);
    // an undodgeable hit still casts it (no roll; base DEF / RES: the cast's layer would raise s.def)
    const i = h.hooksOf('damaged').length;
    h.b.dealDamage(src, u, { amount: 2000, type, canDodge: false });
    const dmg = h.hooksOf('damaged').slice(i).find((c) => c.target === u);
    approx(dmg.amount, (type === 'phys' ? 2000 - u.base.def : 2000 * (1 - u.base.res / 100)) * bb.damage_remaining_scale, `${type}: undodgeable, ×0.1`, 1e-3);
    assert.equal(u.skill.activations, 1, `${type}: cast`);
    done(h);
  }
  // a 50 % dodge that fails: the hit is rolled exactly once (at the guard), casts, and the buff's 闪避 comes back afterwards
  const { h, u } = field({ skill: 1 });
  fillSp(u);
  h.b.addBuff(u, { key: 'test:dodge', mods: { dodgePhys: 0.5 } });
  const src = h.spawn('enemy_dummy', { pos: [10, 7] });
  let draws = 0;
  h.b.rng = Object.assign(() => { draws++; return 0.7; }, h.b.rng);
  const def0 = u.s.def;
  const i = h.hooksOf('damaged').length;
  h.b.dealDamage(src, u, { amount: 2000, type: 'phys' });
  const dmg = h.hooksOf('damaged').slice(i).find((c) => c.target === u);
  approx(dmg.amount, (2000 - def0) * bb.damage_remaining_scale, 'not dodged: ×0.1', 1e-3);
  assert.deepEqual([draws, u.skill.activations, u.findBuff('test:dodge').mods.dodgePhys], [1, 1, 0.5], 'one roll, cast, the 闪避 restored');
  draws = 0;
  h.b.dealDamage(src, u, { amount: 2000, type: 'phys' });
  assert.deepEqual([draws, u.skill.activations], [1, 1], 'inside the window: the pass rolls it itself, once, and nothing casts');
  done(h);
});

test('S2 layers: ATK / DEF per layer up to 5; expiry takes one and restarts the time', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const bb = bbOf(true, S2), m = u.mem.oxi, e = h.enemies()[0], base = u.s.atk;
  fillSp(u);
  h.b.dealDamage({ source: e, target: u, amount: 1, type: 'phys', tags: ['probe'] });
  assert.equal(m.layers, 1);
  approx(u.s.atk, base * (1 + bb.atk), 'one layer', 1e-3);
  m.layers = 5;
  m.castAt = -Infinity;
  fillSp(u);
  h.b.dealDamage({ source: e, target: u, amount: 1, type: 'phys', tags: ['probe'] });
  assert.equal(m.layers, 5, 'capped');
  approx(u.s.atk, base * (1 + bb.atk * 5), 'five layers', 1e-3);
  h.run(bb.stack_duration + 0.1);
  assert.equal(m.layers, 4, 'expiry takes one');
  h.run(bb.stack_duration - 0.3);
  assert.equal(m.layers, 4, 'and restarts the time');
  h.run(bb.stack_duration * 4 + 1);
  assert.equal(m.layers, 0);
  approx(u.s.atk, base, 'all gone', 1e-3);
  done(h);
});

test('S2 layers: an attack strikes every enemy she blocks', () => {
  const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 5] }] });
  const [a, b] = h.enemies();
  h.run(0.2);
  assert.equal(u.blocking.length, 2, 'she blocks both');
  fillSp(u);
  h.b.dealDamage({ source: a, target: u, amount: 1, type: 'phys', tags: ['probe'] });
  assert.ok(u.mem.oxi.layers >= 1);
  const c = { attacker: u, targets: [a], isSkill: false, profile: u.profile };
  h.b.emit('beforeAttack', c);
  assert.deepEqual(new Set(c.targets), new Set([a, b]));
  done(h);
});

test('S3 日冕重烈: ATK +, no attacks, 5 rows every 80 frames, 13 rows and 60 frames from half time, the skill ends at its duration', () => {
  const { h, u } = field({ skill: 2, row: 10, col: 5, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const bb = bbOf(true, S3), sk = u.skill, base = u.s.atk;
  u.mem.oxi.anger = 0;
  fillSp(u);
  assert.ok(sk.activate('manual'));
  assert.ok(u.s.flags.disarm, 'no attacks');
  approx(u.s.atk, base * (1 + bb.atk), 'ATK', 1e-3);
  const flames = () => h.b.projectiles.list.filter((p) => p.data?.oxiFlame === u);
  h.run(80 / 30 + 0.05);
  const first = flames();
  assert.ok(first.length >= 3 && first.length <= 5, 'at most 5 rows');
  assert.equal(new Set(first.map((p) => p.data.wave)).size, 1);
  assert.ok(first.every((p) => p.data.atk > 0));
  approx(first[0].speed, bb.wave_speed, 'speed');
  h.run(sk.duration / 2 - 80 / 30 + 0.2);
  assert.ok(u.mem.oxi.fire.over, 'overload at half time');
  h.run(sk.timeLeft + 0.1);
  assert.equal(sk.active, false);
  assert.ok(!u.s.flags.disarm);
  done(h);
});

test('S3 簇火: touching an enemy it blasts arts with the ATK it was created with; 元素伤害 on a burst target; 15 % on a repeat of the wave', () => {
  const { h, u } = field({ skill: 2, row: 10, col: 5, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const bb = bbOf(true, S3), sk = u.skill, e = h.enemies()[0];
  u.mem.oxi.anger = 0; u.mem.oxi.growAt = Infinity;
  fillSp(u);
  sk.activate('manual');
  const atk = u.s.atk;
  const add = (wave, burn = false) => h.b.addProjectile({ from: { x: 7, y: 10 }, to: { x: 8, y: 10 }, speed: 2.3, visual: 'bolt', source: u, maxAge: 3, data: { oxiFlame: u, wave, atk: burn ? atk : atk } });
  add(900);
  h.step();
  add(900);
  h.step();
  const hits = hitsOf(h, u, 'oxi:flame');
  assert.equal(hits.length, 2);
  approx(hits[1].dmg.amount ?? hits[1].amount, (hits[0].dmg.amount ?? hits[0].amount) * bb.same_wave_repeat_damage_scale, 'repeat', 1e-3);
  h.b.dealElementDamage({ source: u, target: e, element: 'burn', amount: 1e6, tags: ['probe'] });
  add(901);
  h.step();
  const last = hitsOf(h, u, 'oxi:flame').at(-1);
  assert.equal(last.type, 'elemental');
  done(h);
});

test('S3: one 塔露拉 channels per field', () => {
  const { h, u } = field({ skill: 2, row: 10, col: 5, others: [{ uid: 2, diy: { slot: SLOT[6], charId: OXI, skillIndex: 2, uniEquipId: null }, elite: true, row: 11, col: 5 }] });
  const v = h.unit(2);
  fillSp(u); fillSp(v);
  u.skill.activate('manual');
  v.skill.activate('manual');
  assert.ok(u.mem.oxi.fire);
  assert.equal(v.mem.oxi.fire, null);
  done(h);
});

test('an operator of ours knocked out while her skill lasts gives 奥术 and 不屈 layers; S1, her own death and an idle S3 give none', () => {
  const ally = { uid: 2, chessId: 'chess_char_1_01_a', row: 11, col: 5 };
  const gains = (h, u) => { const g = h.b._pp(u.ownerId).layerGains; return [g.arcaneShip ?? 0, g.indomShip ?? 0]; };
  const down = (h) => h.b.kill(h.unit(2), { reason: 'killed' });
  for (const [skill, cast, want] of [[2, false, 0], [2, true, 1], [0, false, 0]]) {
    const { h, u } = field({ skill, others: [ally] });
    h.b.flags.layerGainsEnabled = true;
    if (cast) { fillSp(u); u.skill.activate('manual'); }
    down(h);
    h.step();
    assert.deepEqual(gains(h, u), [want, want], `skill ${skill} cast ${cast}`);
    done(h);
  }
  const { h, u } = field({ skill: 1, others: [ally] });
  h.b.flags.layerGainsEnabled = true;
  u.mem.oxi.layers = 1;
  down(h);
  h.step();
  assert.deepEqual(gains(h, u), [1, 1], 'S2 with a layer up');
  done(h);
});

test('her talent card states this game\'s rule, in every form', () => {
  for (const form of Object.values(FORMS)) assert.match(form.talents[0].desc, /技能持续期间我方干员阵亡时，【奥术】和【不屈】层数\+1/);
});

test('the composed record names her bonds: 协防, 奥术 and 不屈', () => {
  const rec = diyRecord('chess_char_6_diy1_a', { charId: OXI, skillIndex: 2, uniEquipId: null }, { elite: true, data: { chess: CHESS, backups: BACKUPS } });
  assert.deepEqual(rec.bonds, ['emptyShip', 'arcaneShip', 'indomShip']);
  assert.equal(rec.dmgType, 'arts');
});
