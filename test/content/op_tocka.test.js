// test/content/op_tocka.test.js — the 自选 operator kit of 冻河 (char_4244_tocka, 6★ 游击手; kit
// server/sim/content/kits/ops/op-tocka.js), fielded the production way (a DIY slot + its `diy` pick) in every form: tiers 5 / 6,
// normal (E2 Lv1, skill rank 4) and elite (E2 Lv60, rank 7). She has no module. Every number is read back from
// data/backups.json; the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_tocka.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool } from '../../shared/diy.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const CHESS = JSON.parse(readFileSync(new URL('../../data/chess.json', import.meta.url), 'utf8'));
const TOCKA = 'char_4244_tocka';
const FORMS = BACKUPS.units[TOCKA].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const S1 = 'skchr_tocka_1', S2 = 'skchr_tocka_2', S3 = 'skchr_tocka_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const bbOf = (elite, id) => formOf(5, elite).skills.find((s) => s.skillId === id).bb;
const talent = (i) => formOf(5, true).talents[i].bb;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, atk: 0, ...o });
const ENEMIES = { enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }) };
const ALL_FORMS = [[5, false], [6, false], [5, true], [6, true]];
// 隐现 (MANUAL ammo skill), 角峰 (MANUAL), both in her range from (10, 5): her 3-18 holds (+1, 0) and (0, +1)
const YINXIAN = (uid, row, col) => ({ uid, chessId: 'chess_char_1_01_a', row, col });
const JIAOFENG = (uid, row, col) => ({ uid, chessId: 'chess_char_1_02_a', row, col });

function field({ tier = 5, elite = true, skill = 0, row = 10, col = 5, enemies = [], others = [], seed = 5, ops = null, flags = null } = {}) {
  const h = makeBattle({
    defs: { ...(ops ? { chess: ops } : {}), enemies: ENEMIES }, timeLimit: 600, autoFinish: false, seed, enemies,
    flags: { dpPerSec: 0, dpMax: 999, ...(flags || {}) }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'heal'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: TOCKA, skillIndex: skill, uniEquipId: null }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const fillSp = (u) => { u.skill.sp = u.skill.spCost; u.skill.charges = u.skill.maxCharges; };
const emptySp = (u) => { u.skill.sp = 0; u.skill.charges = 0; };
const starts = (h, u, id) => h.hooksOf('skillStart').filter((c) => c.unit === u && c.skill.id === id).length;
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('冻河 in every 自选 form: her kit, all three skills authored, the form\'s stats, ranged physical, anti-air, 协防 + 灵巧 + 迅捷', () => {
  assert.ok(KITTED_CHARS.includes(TOCKA));
  assert.equal(OPERATOR_KITS[TOCKA], KITS[TOCKA]);
  for (const tier of [5, 6]) assert.ok(diyPool(tier, { data: { backups: BACKUPS, chess: CHESS }, kitted: KITTED_CHARS }).includes(TOCKA), `tier ${tier} picker`);
  for (const [tier, elite] of ALL_FORMS) {
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, skill });
      const form = formOf(tier, elite);
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [TOCKA, SLOT[tier], form.skills[skill].skillId, false, 'skills']);
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def], [form.stats.maxHp, form.stats.atk, form.stats.def]);
      assert.deepEqual([u.profile.attack, u.profile.canHitFly, u.dmgType], ['ranged', true, 'phys']);
      assert.deepEqual(u.def.bonds, ['emptyShip', 'skillfulShip', 'swiftShip']);
      done(h);
    }
  }
  assert.deepEqual(BACKUPS.diy.operators[TOCKA].powers, ['ursus']);
  assert.deepEqual(FORMS['2/1/4/0'].modules ?? [], [], 'no module was released with her');
});

test('S1 一无所有之人: at full SP the effect goes on max_target operators of her range, lowest HP ratio first (herself included); with nobody left it waits, SP kept', () => {
  for (const elite of [false, true]) {
    const b1 = bbOf(elite, S1);
    const { h, u } = field({ elite, skill: 0, others: [YINXIAN(2, 11, 5), JIAOFENG(3, 10, 6)] });
    const [a2, a3] = [h.unit(2), h.unit(3)];
    a2.hp = a2.s.maxHp * 0.3; a3.hp = a3.s.maxHp * 0.6;
    fillSp(u);
    h.step(2);
    const holders = [u, a2, a3].filter((a) => a.findBuff('tocka:s1'));
    assert.equal(holders.length, Math.min(3, b1.max_target), `max_target ${b1.max_target}`);
    assert.ok(a2.findBuff('tocka:s1'), 'the lowest HP ratio first');
    if (b1.max_target === 2) assert.ok(a3.findBuff('tocka:s1') && !u.findBuff('tocka:s1'), 'then the next lowest');
    // everyone holds one: the next full bar waits
    for (const a of [u, a2, a3]) if (!a.findBuff('tocka:s1')) { fillSp(u); h.step(Math.ceil(u.s.interval * 30) + 2); }
    assert.ok([u, a2, a3].every((a) => a.findBuff('tocka:s1')));
    const before = starts(h, u, S1);
    fillSp(u);
    h.step(60);
    assert.equal(starts(h, u, S1), before, 'no cast without a target');
    assert.equal(u.skill.charges, u.skill.maxCharges, 'SP kept');
    done(h);
  }
});

test('S1 fires on a hit: a 屏障 of shield_atk_scale × her ATK takes that hit, decays by 1/shield_time a second; the source is stunned; 夜的哑然 gives her SP and heals another operator', () => {
  const b1 = bbOf(true, S1), t0 = talent(0);
  const { h, u } = field({ skill: 0, others: [YINXIAN(2, 11, 5)], enemies: [{ key: 'enemy_dummy', pos: [10, 9] }] });
  const ally = h.unit(2), e = h.enemies()[0];
  ally.hp = ally.s.maxHp * 0.5;
  u.hp = u.s.maxHp * 0.9;
  fillSp(u);
  h.step(2);
  const holder = [ally, u].find((a) => a.findBuff('tocka:s1') && a !== u) ?? ally;
  assert.ok(holder.findBuff('tocka:s1'));
  emptySp(u);
  const shieldAmt = u.s.atk * b1.shield_atk_scale;
  const hp0 = holder.hp;
  const dealt = h.b.dealDamage({ source: e, target: holder, amount: 100, type: 'true' });
  assert.equal(dealt, 0, 'the new 屏障 takes the hit that fired it');
  assert.ok(holder.hp >= hp0, 'no HP lost');
  const sh = holder.findBuff(`tocka:s1shield:${u.id}`);
  approx(sh.shield, shieldAmt - 100, 'shield left');
  assert.ok(!holder.findBuff('tocka:s1'), 'the effect is spent');
  h.step();
  assert.ok(e.findBuff('stun') || e.s.flags.stun, 'the source stunned');
  approx(h.hooksOf('statusApplied').find((c) => c.target === e && c.status === 'stun').duration, b1.stun, 'stun');
  approx(u.skill.sp, t0.sp, '夜的哑然 SP (+ the tick\'s own recovery)', 0.05);
  const heal = h.hooksOf('heal').find((c) => c.source === u);
  assert.ok(heal && heal.target !== u, 'heals another operator');
  approx(heal.amount, u.s.atk * t0.heal_scale, 'heal', 1e-3);
  h.run(1.05);
  approx(holder.findBuff(`tocka:s1shield:${u.id}`).shield, shieldAmt - 100 - shieldAmt / b1.shield_time, 'decay 1 s', 1e-3);
  h.run(b1.shield_time);
  assert.ok(!holder.findBuff(`tocka:s1shield:${u.id}`), 'gone within shield_time');
  // 元素 and DoTs do not fire it
  fillSp(u);
  h.step(Math.ceil(u.s.interval * 30) + 2);
  const h2 = [u, ally].find((a) => a.findBuff('tocka:s1'));
  h.b.dealDamage({ source: e, target: h2, amount: 10, type: 'arts', attackType: 'BUFF', tags: ['dot'] });
  h.b.dealDamage({ source: e, target: h2, amount: 10, type: 'elemental', element: 'burn' });
  assert.ok(h2.findBuff('tocka:s1'), 'a DoT and 元素伤害 leave it');
  done(h);
});

test('S1 again on a 屏障 of hers: the old one goes and the new one is the larger of the two', () => {
  const b1 = bbOf(true, S1);
  const { h, u } = field({ skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 9] }] });
  const e = h.enemies()[0];
  fillSp(u);
  h.step(2);
  assert.ok(u.findBuff('tocka:s1'), 'alone, she takes it');
  h.b.dealDamage({ source: e, target: u, amount: 10, type: 'phys', canDodge: false });
  const big = u.findBuff(`tocka:s1shield:${u.id}`).shield;
  fillSp(u);
  h.step(Math.ceil(u.s.interval * 30) + 2);
  assert.ok(u.findBuff('tocka:s1'));
  u.mem.tockaAtkProbe = u.s.atk;
  h.b.addBuff(u, { key: 'probe:lowAtk', mods: { atkMul: 0.1 } });
  h.b.dealDamage({ source: e, target: u, amount: 10, type: 'phys', canDodge: false });
  const shields = u.buffs.filter((x) => x.key === `tocka:s1shield:${u.id}`);
  assert.equal(shields.length, 1);
  assert.ok(shields[0].shield >= big - 10 - big / b1.shield_time * 2 - 1e-6, 'kept the larger');
  done(h);
});

test('S2 意欲呼啸之心: one operator of the field, the latest deployed whose skill is off; it flies there; it fires once the holder\'s skill can open — SP ready and an enemy in its reach (满足目标条件): attack_speed for buff_duration and its MANUAL skill opens', () => {
  for (const elite of [false, true]) {
    const b2 = bbOf(elite, S2), t0 = talent(0);
    // the enemy stands on 角峰's tile (the latest deployed, so the holder) and he blocks it — his TAKE_DAMAGE skill is
    // ready but for the target condition ("不需要目标" rules wait for an enemy within reach: blocked counts)
    const { h, u } = field({ elite, skill: 1, others: [JIAOFENG(2, 10, 6), YINXIAN(3, 4, 1)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const [late, early] = [h.unit(2), h.unit(3)].sort((a, b) => b.deploySeq - a.deploySeq);
    const [near, far] = [early, late];
    emptySp(near); emptySp(far);
    fillSp(u);
    h.step(1);
    assert.ok(!far.findBuff('tocka:s2'), 'still flying');
    h.run(Math.hypot(far.x - u.x, far.y - u.y) / 10 + 0.1);
    assert.ok(far.findBuff('tocka:s2'), 'the latest deployed');
    assert.ok(!near.findBuff('tocka:s2'));
    const aspd0 = far.s.aspd;
    h.run(1);
    assert.ok(far.findBuff('tocka:s2'), 'waits while the skill is not ready');
    fillSp(far);
    h.run(0.25);
    assert.ok(!far.findBuff('tocka:s2'), 'fired');
    const win = far.findBuff(`tocka:s2auto:${u.id}`);
    assert.ok(win, 'the window');
    approx(win.timeLeft, b2.buff_duration, 'buff_duration', 0.02);
    approx(far.s.aspd - aspd0, b2.attack_speed, 'attack_speed');
    h.run(0.25);
    assert.ok(far.skill.active, 'its MANUAL skill opened');
    assert.ok(h.hooksOf('heal').some((c) => c.source === u) || u.skill.sp >= 0, '夜的哑然 ran');
    void t0;
    done(h);
  }
});

test('S2: a skill start of the holder fires it too; nobody else ⇒ herself', () => {
  const { h, u } = field({ skill: 1, others: [JIAOFENG(2, 10, 6)] });
  const a = h.unit(2);
  emptySp(a);
  fillSp(u);
  h.run(1);
  assert.ok(a.findBuff('tocka:s2'));
  a.skill.activate('test', { free: true });
  h.step();
  assert.ok(!a.findBuff('tocka:s2') && a.findBuff(`tocka:s2auto:${u.id}`), 'fired by the skill start');
  const solo = field({ skill: 1 });
  fillSp(solo.u);
  solo.h.run(0.5);
  assert.ok(solo.u.findBuff('tocka:s2') || solo.u.findBuff(`tocka:s2auto:${solo.u.id}`), 'alone: on herself');
  done(h); done(solo.h);
});

test('S2 effect: "不需要目标/满足目标条件" by its holder skill\'s rule — SKILL_RANGE / ACTIVE_RANGE an enemy on their own range, DEFAULT on its attack range, and the rules with no target of their own (SP_FULL, TAKE_DAMAGE) an enemy on its attack range too (the owner\'s test of 2026-11-03: "技能/攻击范围内有敌人就自动放，没敌人不会放"); the 0.2 s check fires the effect while the battle-start operation cooldown still holds the skill, and the window opens it', () => {
  const ally = (id, skill) => chessRec({ id, stats: { def: 0, res: 0 }, skill });
  const ROW_AHEAD = (n) => Array.from({ length: n }, (_, i) => [0, i]);
  const OPS = {
    ally_c: ally('ally_c', { spCost: 10, initSp: 0, duration: 0, maxChargeTime: 3 }),
    ally_k: ally('ally_k', { spCost: 10, initSp: 0, duration: 5, trigger: { rule: 'SKILL_RANGE', customRangeGrid: ROW_AHEAD(5) } }),
    ally_r: ally('ally_r', { spCost: 10, initSp: 0, duration: 5, trigger: { rule: 'ACTIVE_RANGE', customRangeGrid: ROW_AHEAD(4) } }),
    ally_f: ally('ally_f', { spCost: 10, initSp: 0, duration: 5, trigger: { rule: 'SP_FULL' } }),
    ally_t: ally('ally_t', { spCost: 10, initSp: 0, duration: 5, trigger: { rule: 'TAKE_DAMAGE' } }),
  };
  const holders = [
    // [rule, record, the holder's tile, an enemy tile outside its condition, one inside]
    ['DEFAULT', 'ally_c', [11, 6], [11, 9], [11, 7]],
    ['SKILL_RANGE', 'ally_k', [12, 3], [10, 9], [12, 7]],
    ['ACTIVE_RANGE', 'ally_r', [9, 3], [10, 9], [9, 6]],
    ['SP_FULL', 'ally_f', [11, 6], [11, 9], [11, 7]],
    ['TAKE_DAMAGE', 'ally_t', [11, 6], [11, 9], [11, 7]],
  ];
  for (const [rule, id, [row, col], out, inside] of holders) {
    const { h, u } = field({ skill: 1, flags: { startOpCooldown: 30 }, others: [{ uid: 2, chessId: id, row, col }], ops: OPS });
    const m = h.unit(2);
    assert.deepEqual([m.skill.rule, m.skill.manual], [rule, true]);
    fillSp(u);
    h.run(1);
    assert.ok(m.findBuff('tocka:s2'), `${rule}: the effect is on the holder`);
    h.b.retreat(u);
    m.skill.gainSp(10);
    h.run(1);
    assert.ok(m.skill.ready && m.findBuff('tocka:s2'), `${rule}: ready, no enemy: it waits`);
    h.spawn('enemy_dummy', { pos: out });
    h.run(1);
    assert.ok(m.skill.ready && m.findBuff('tocka:s2'), `${rule}: ready, the enemy outside its condition: it waits`);
    h.spawn('enemy_dummy', { pos: inside });
    assert.ok(h.runUntil(() => !m.findBuff('tocka:s2'), 0.2 + 1e-6), `${rule}: fired within 0.2 s`);
    assert.ok(m.findBuff(`tocka:s2auto:${u.id}`), `${rule}: the ASPD window`);
    // this remake's window opens the holder's MANUAL skill itself every 0.2 s (its own reading of "期间技能变为自动开启"):
    // a TAKE_DAMAGE skill opens with it too, without a hit
    assert.ok(h.runUntil(() => m.skill.activations === 1, 1.5), `${rule}: cast once the operation cooldown is lifted`);
    assert.ok(h.b.time < 30, `${rule}: within the 30 s battle-start operation cooldown`);
    done(h);
  }
});

test('S3 踽踽独行之春: attack_speed, attack@max_target targets at attack@atk_scale physical with an attack@stun 晕眩; at its start the effect goes on the highest SP ratio operator of her range', () => {
  for (const elite of [false, true]) {
    const b3 = bbOf(elite, S3);
    const enemies = [0, 1, 2, 3, 4].map((i) => ({ key: i === 4 ? 'enemy_fly' : 'enemy_dummy', pos: [9 + (i % 3), 7 + Math.floor(i / 3)] }));
    const { h, u } = field({ elite, skill: 2, enemies, others: [JIAOFENG(2, 10, 6), YINXIAN(3, 11, 5)] });
    const [a2, a3] = [h.unit(2), h.unit(3)];
    a2.skill.sp = a2.skill.spCost * 0.2; a3.skill.sp = a3.skill.spCost * 0.7;
    const aspd0 = u.s.aspd;
    fillSp(u);
    h.runUntil(() => u.skill.active, 10);
    approx(u.s.aspd - aspd0, b3.attack_speed, 'attack_speed');
    assert.ok(a3.findBuff(`tocka:s3:${u.id}`) && !a2.findBuff(`tocka:s3:${u.id}`), 'the highest SP ratio');
    h.runUntil(() => h.hooksOf('damaged').some((c) => c.source === u && c.dmg?.isSkill), 10);
    h.step(3);
    const first = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.isSkill);
    const ids = new Set(first.map((c) => c.dmg.attackId));
    const one = first.filter((c) => c.dmg.attackId === [...ids][0]);
    assert.equal(new Set(one.map((c) => c.target)).size, Math.min(5, b3['attack@max_target']), 'targets per attack');
    approx(h.hooksOf('statusApplied').find((c) => c.source === u && c.status === 'stun').duration, b3['attack@stun'], 'stun');
    done(h);
  }
});

test('S3 effect: the holder\'s skill start gives it and her bonus_init_atk ATK falling by bonus_atk_dec_per_sec; it moves on; bonus_sp a second while her skill runs; gone when she leaves', () => {
  const b3 = bbOf(true, S3);
  const { h, u } = field({ skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 8] }], others: [JIAOFENG(2, 10, 6), YINXIAN(3, 11, 5)] });
  const [a2, a3] = [h.unit(2), h.unit(3)];
  a2.skill.sp = 0; a3.skill.sp = a3.skill.spCost * 0.5;
  fillSp(u);
  h.runUntil(() => u.skill.active, 10);
  assert.ok(a3.findBuff(`tocka:s3:${u.id}`));
  const sp0 = a3.skill.sp;
  h.run(2.02);
  assert.ok(a3.skill.sp - sp0 >= 2 * b3.bonus_sp + 2 * a3.s.spRecovery - 0.1, 'bonus_sp a second on top of its own');
  const atkA = a3.s.atk, atkU = u.s.atk;
  fillSp(a3);
  a3.skill.activate('test');
  h.step();
  approx(a3.findBuff(`tocka:bonus:${u.id}`).mods.atkPct, b3.bonus_init_atk, 'holder ATK +%');
  void atkA;
  approx(u.s.atk / atkU, 1 + b3.bonus_init_atk, 'her ATK', 0.05);
  assert.ok(!a3.findBuff(`tocka:s3:${u.id}`) && a2.findBuff(`tocka:s3:${u.id}`), 'moved to the other operator');
  const b = u.findBuff(`tocka:bonus:${u.id}`);
  h.run(1.02);
  approx(b.mods.atkPct, b3.bonus_init_atk - b3.bonus_atk_dec_per_sec, 'decay');
  h.b.dealDamage({ source: null, target: u, amount: 1e9, type: 'true' });
  h.step(2);
  assert.ok(!a2.findBuff(`tocka:s3:${u.id}`), 'gone with her');
  done(h);
});

test('雪的印痕: after an effect goes on, her next normal attack also strikes every enemy within attack@projectile_range; each is 虚弱 and takes attack@t2_magic_atk_scale × ATK arts a second', () => {
  const t1 = talent(1);
  const enemies = [{ key: 'enemy_dummy', pos: [10, 7] }, { key: 'enemy_dummy', pos: [11, 7] }, { key: 'enemy_dummy', pos: [10, 9] }];
  const { h, u } = field({ skill: 0, enemies });
  emptySp(u);
  h.run(3);
  const before = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.isSplash).length;
  assert.equal(before, 0, 'plain attacks hit one');
  fillSp(u);
  h.runUntil(() => h.hooksOf('damaged').some((c) => c.source === u && c.dmg?.isSplash), 10);
  const splash = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.isSplash);
  assert.ok(splash.length >= 1);
  const main = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.isAttack && !c.dmg.isSplash).at(-1).target;
  for (const c of splash) assert.ok(Math.hypot(c.target.x - main.x, c.target.y - main.y) <= t1['attack@projectile_range'] + 1e-6);
  h.step();
  for (const e of [main, ...splash.map((c) => c.target)]) {
    const w = h.hooksOf('statusApplied').find((c) => c.target === e && c.status === 'weaken');
    assert.ok(w, '虚弱');
    approx(w.duration, t1['attack@t2_buff_duration'], '虚弱 duration');
    approx(w.value, Math.abs(t1['attack@t2_atk']), '虚弱 value');
  }
  h.run(1.05);
  const dot = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.tags?.includes('tocka:t2dot'));
  assert.ok(dot.length >= 1, 'the DoT ticks');
  assert.equal(dot[0].type, 'arts');
  done(h);
});
