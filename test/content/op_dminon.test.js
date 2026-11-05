// test/content/op_dminon.test.js — the 自选 operator kit of 国度 (char_4246_dminon, 6★ 伏击客; kit
// server/sim/content/kits/ops/op-dminon.js), fielded the production way (a DIY slot + its `diy` pick) in every form: tiers
// 5 / 6, normal (E2 Lv1, skill rank 4) and elite (E2 Lv60, rank 7), the elites with and without AMB-X 空瓶罐们. Every number
// is read back from data/backups.json; the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_dminon.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool } from '../../shared/diy.js';
import { COLS } from '../../server/sim/constants.js';
import { UNEVADE_KEY, TAG_FIELD, TAG_BURST, TAG_SPREAD } from '../../server/sim/content/kits/ops/op-dminon.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const CHESS = JSON.parse(readFileSync(new URL('../../data/chess.json', import.meta.url), 'utf8'));
const DMN = 'char_4246_dminon';
const AMBX = 'uniequip_002_dminon';
const FORMS = BACKUPS.units[DMN].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const S1 = 'skchr_dminon_1', S2 = 'skchr_dminon_2', S3 = 'skchr_dminon_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const bbOf = (elite, id) => formOf(5, elite).skills.find((s) => s.skillId === id).bb;
const skillOf = (elite, id) => formOf(5, elite).skills.find((s) => s.skillId === id);
const talent = (i, tier = 5, elite = true) => formOf(tier, elite).talents[i].bb;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, atk: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
  enemy_walk: dummy('enemy_walk', { speed: 1 }),
};
// [tier, elite, module]
const ALL_FORMS = [[5, false, null], [6, false, null], [5, true, null], [6, true, null], [5, true, AMBX], [6, true, AMBX]];

function field({ tier = 5, elite = true, skill = 0, module = null, row = 10, col = 5, enemies = [], others = [], seed = 5 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 600, autoFinish: false, seed, enemies,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'death', 'dodge'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: DMN, skillIndex: skill, uniEquipId: module }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const fillSp = (u) => { u.skill.sp = u.skill.spCost; u.skill.charges = u.skill.maxCharges; };
const noSp = (u) => { u.skill.sp = 0; u.skill.charges = 0; u.skill.initSp = 0; };
const hitsOf = (h, u, tag) => h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.tags?.includes(tag));
const key = (r, c) => r * COLS + c;
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('国度 in every 自选 form: her kit, all three skills authored, the form\'s stats, 伏击客 (all in range, ground, phys, block 0, 50 % dodge, taunt −1), 协防 + 独行', () => {
  assert.ok(KITTED_CHARS.includes(DMN));
  assert.equal(OPERATOR_KITS[DMN], KITS[DMN]);
  for (const tier of [5, 6]) assert.ok(diyPool(tier, { data: { backups: BACKUPS, chess: CHESS }, kitted: KITTED_CHARS }).includes(DMN), `tier ${tier} picker`);
  for (const [tier, elite, module] of ALL_FORMS) {
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, skill, module });
      const form = formOf(tier, elite);
      const attr = module ? form.modules.find((m) => m.uniEquipId === module).attr : {};
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [DMN, SLOT[tier], form.skills[skill].skillId, false, 'skills']);
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def], [form.stats.maxHp + (attr.maxHp ?? 0), form.stats.atk + (attr.atk ?? 0), form.stats.def + (attr.def ?? 0)], `stats ${tier} ${elite} ${module}`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.canHitFly, u.dmgType, !!u.profile.allInRange], [0, 'melee', false, 'phys', true]);
      assert.deepEqual([u.s.dodgePhys, u.s.dodgeArts, u.s.taunt], [0.5, 0.5, -1], 'the trait: dodge, no second taunt −1');
      assert.deepEqual(u.def.bonds, ['emptyShip', 'soloShip']);
      done(h);
    }
  }
  assert.deepEqual(BACKUPS.diy.operators[DMN].powers, ['ursus']);
  assert.ok(!BACKUPS.diy.excluded.includes(DMN));
});

test('实质坍缩: every second from her deployment each ground enemy on 国度 takes atk_scale × ATK arts and ASPD −15 for 1 s; air units and enemies outside are spared', () => {
  for (const [tier, elite, module] of [[5, false, null], [5, true, AMBX], [6, true, AMBX]]) {
    const { h, u } = field({ tier, elite, module, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_fly', pos: [10, 7] }, { key: 'enemy_dummy', pos: [10, 9] }] });
    noSp(u);
    // AMB-X stage 3 changes the talent (its talentChanges), stage 1 does not
    const change = module ? formOf(tier, elite).modules.find((m) => m.uniEquipId === module).talentChanges.find((t) => t.talentIndex === 0) : null;
    const expect = change ? change.bb : talent(0, tier, elite);
    if (tier === 6 && module) assert.deepEqual([expect.atk_scale, expect.attack_speed], [0.2, -20], 'stage 3');
    else assert.deepEqual([expect.atk_scale, expect.attack_speed], [0.13, -15], 'the base talent');
    const [inside, flyer, far] = h.enemies();
    h.run(0.1);
    const ticks = () => hitsOf(h, u, TAG_FIELD).filter((c) => c.target === inside);
    assert.equal(ticks().length, 1, 'the first at once');
    approx(inside.s.aspd, 100 + expect.attack_speed, 'ASPD');
    h.run(2);
    assert.equal(ticks().length, 3, 'one a second');
    const t = ticks()[0];
    assert.deepEqual([t.type, t.dmg.attackType, t.dmg.isAttack ?? false], ['arts', 'NORMAL', false]);
    approx(t.amount, u.s.atk * expect.atk_scale, 'atk_scale × ATK');
    assert.equal(hitsOf(h, u, TAG_FIELD).filter((c) => c.target === flyer || c.target === far).length, 0, 'air / outside');
    approx(flyer.s.aspd, 100, 'the flyer');
    approx(far.s.aspd, 100, 'outside');
    done(h);
  }
});

test('此身为界: knocked out — and on a 撤退 — a burst 0.6 s later stuns the ground enemies of 国度 `stun` s and deals atk_scale × her ATK arts; not on the 突袭 jump', () => {
  for (const reason of ['killed', 'retreat', 'raid']) {
    const { h, u } = field({ elite: true, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 9] }] });
    noSp(u);
    const [inside, far] = h.enemies();
    h.run(0.5);
    const atk = u.s.atk;
    if (reason === 'killed') h.b.dealDamage({ source: inside, target: u, amount: 1e9, type: 'true' });
    else h.b.retreat(u, { reason });
    assert.ok(!u.alive, reason);
    h.run(0.5);
    assert.equal(hitsOf(h, u, TAG_BURST).length, 0, `${reason}: not before 0.6 s`);
    h.run(0.2);
    const burst = hitsOf(h, u, TAG_BURST);
    if (reason === 'raid') { assert.equal(burst.length, 0, 'the 突袭 jump'); done(h); continue; }
    assert.deepEqual(burst.map((c) => c.target), [inside], reason);
    assert.equal(burst[0].type, 'arts');
    approx(burst[0].amount, atk * talent(1).atk_scale, 'atk_scale × ATK');
    const stun = h.hooksOf('statusApplied').find((c) => c.target === inside && c.status === 'stun');
    assert.ok(stun, 'stunned');
    approx(stun.duration, talent(1).stun, 'stun');
    assert.ok(!h.hooksOf('statusApplied').some((c) => c.target === far && c.status === 'stun'));
    done(h);
  }
});

test('停步: ASPD + attack_speed; each ground enemy on 国度 is 停顿 `sluggish` s once per cast, 0.15 s after it', () => {
  for (const elite of [false, true]) {
    const b1 = bbOf(elite, S1);
    const { h, u } = field({ elite, skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 9] }] });
    noSp(u);
    h.run(0.2);
    const [inside, far] = h.enemies();
    const base = u.s.aspd;
    fillSp(u);
    u.skill.activate('manual');
    approx(u.s.aspd, base + b1.attack_speed, 'ASPD');
    const slugs = () => h.hooksOf('statusApplied').filter((c) => c.status === 'sluggish' && c.source === u);
    h.run(0.1);
    assert.equal(slugs().length, 0, 'not at the cast');
    h.run(0.1);
    assert.deepEqual(slugs().map((c) => c.target), [inside], '0.15 s after');
    approx(slugs()[0].duration, b1.sluggish, 'its time');
    h.run(b1.sluggish + 2);
    assert.equal(slugs().length, 1, 'once per cast');
    assert.ok(!slugs().some((c) => c.target === far));
    done(h);
  }
});

test('受戮: range y-3, ATK + atk; the ground enemies of her range cannot dodge; from the second use ASPD + attack_speed and no end', () => {
  for (const elite of [false, true]) {
    const b2 = bbOf(elite, S2), rec = skillOf(elite, S2);
    const { h, u } = field({ elite, skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 8] }] });
    noSp(u);
    const e = h.enemies()[0];
    h.b.addBuff(e, { key: 'test:dodge', mods: { dodgePhys: 1, dodgeArts: 1 }, persist: true });
    assert.ok(!u.rangeKeySet.has(key(10, 8)), '[0,3] is not in her own range');
    const base = { atk: u.s.atk, aspd: u.s.aspd };
    fillSp(u);
    u.skill.activate('manual');
    assert.equal(rec.rangeId, 'y-3');
    assert.ok(u.rangeKeySet.has(key(10, 8)), 'y-3 reaches [0,3]');
    approx(u.s.atk, base.atk * (1 + b2.atk), 'ATK');
    approx(u.s.aspd, base.aspd, 'no ASPD the first time');
    h.run(0.05);
    assert.ok(e.findBuff(UNEVADE_KEY), 'marked at once');
    const dodged = () => h.hooksOf('dodge').filter((c) => c.target === e && c.cancelled).length;
    const d1 = dodged();
    h.b.dealDamage({ source: u, target: e, amount: 100, type: 'phys' });
    h.b.dealDamage({ source: u, target: e, amount: 100, type: 'arts' });
    assert.equal(dodged(), d1, 'no dodge');
    assert.ok(h.hooksOf('damaged').filter((c) => c.source === u && c.target === e).length >= 2, 'both landed');
    h.runUntil(() => !u.skill.active, rec.duration + 1);
    assert.ok(!u.skill.active, 'the first use ends');
    h.run(0.5);
    // a dodging enemy off the mark dodges again
    const d0 = dodged();
    h.b.dealDamage({ source: u, target: e, amount: 100, type: 'phys' });
    assert.equal(dodged(), d0 + 1, 'dodged after the skill');
    fillSp(u);
    u.skill.activate('manual');
    approx(u.s.aspd, base.aspd + b2.attack_speed, 'the second use: ASPD');
    approx(u.s.atk, base.atk * (1 + b2.atk), 'and ATK');
    h.run(rec.duration * 3);
    assert.ok(u.skill.active, 'no end');
    done(h);
  }
});

test('无人的国度: range y-10, ATK / ASPD +; a unit of ours on 国度 hit by a ground enemy spreads 国度 over the x-5 cross of the source (her attacks reach it) and deals attack@aoe_atk_scale × ATK phys there, once per attack@cd s; reset at the end', () => {
  for (const elite of [false, true]) {
    const b3 = bbOf(elite, S3), rec = skillOf(elite, S3);
    const { h, u } = field({ elite, skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 9] }, { key: 'enemy_dummy', pos: [10, 10] }, { key: 'enemy_fly', pos: [9, 9] }] });
    noSp(u);
    const [src, next, flyer] = h.enemies();
    const base = { atk: u.s.atk, aspd: u.s.aspd };
    fillSp(u);
    u.skill.activate('manual');
    assert.equal(rec.rangeId, 'y-10');
    approx(u.s.atk, base.atk * (1 + b3.atk), 'ATK');
    approx(u.s.aspd, base.aspd + b3.attack_speed, 'ASPD');
    assert.ok(!u.rangeKeySet.has(key(10, 9)), 'the source stands outside');
    h.b.dealDamage({ source: src, target: u, amount: 1, type: 'phys', canDodge: false });
    for (const k of [key(10, 9), key(11, 9), key(9, 9), key(10, 10), key(10, 8)]) assert.ok(u.rangeKeySet.has(k), `spread ${k}`);
    const spread = hitsOf(h, u, TAG_SPREAD);
    assert.deepEqual(new Set(spread.map((c) => c.target)), new Set([src, next]), 'the ground enemies of the cross');
    approx(spread[0].amount, u.s.atk * b3['attack@aoe_atk_scale'], 'aoe_atk_scale × ATK');
    assert.equal(spread[0].type, 'phys');
    assert.ok(!spread.some((c) => c.target === flyer), 'not the flyer');
    h.b.dealDamage({ source: src, target: u, amount: 1, type: 'phys', canDodge: false });
    assert.equal(hitsOf(h, u, TAG_SPREAD).length, spread.length, `the cooldown ${b3['attack@cd']} s`);
    h.run(b3['attack@cd'] + 0.05);
    h.b.dealDamage({ source: src, target: u, amount: 1, type: 'phys', canDodge: false });
    assert.equal(hitsOf(h, u, TAG_SPREAD).length, spread.length * 2, 'after it');
    // her attacks reach the spread tiles (the trait over the widened range)
    h.runUntil(() => h.hooksOf('damaged').some((c) => c.source === u && c.target === next && c.dmg?.isAttack), 6);
    assert.ok(h.hooksOf('damaged').some((c) => c.source === u && c.target === next && c.dmg?.isAttack), 'attacked on the spread');
    h.runUntil(() => !u.skill.active, rec.duration + 1);
    assert.ok(!u.skill.active);
    assert.equal(u.extraRangeKeys ?? null, null, 'reset at the end');
    assert.ok(!u.rangeKeySet.has(key(10, 9)));
    done(h);
  }
});

test('AMB-X 空瓶罐们: every enemy of her range, air units too, moves ×(1 + move_speed) at stages 1 and 3; no slow without the module', () => {
  for (const [tier, module, slow] of [[5, AMBX, true], [6, AMBX, true], [5, null, false]]) {
    const { h, u } = field({ tier, elite: true, module, enemies: [{ key: 'enemy_walk', pos: [10, 6] }, { key: 'enemy_fly', pos: [10, 7] }] });
    noSp(u);
    h.run(0.3);
    const mv = formOf(tier, true).modules.find((m) => m.uniEquipId === AMBX).talentChanges.find((t) => t.talentIndex === -1).bb.move_speed;
    for (const e of h.enemies()) {
      const b = e.buffs.find((x) => x.key === `dminon:ambx#${u.id}`);
      if (slow) { assert.ok(b, `${e.defId} slowed`); approx(b.mods.moveMul, 1 + mv, 'moveMul'); } else assert.ok(!b, 'no module');
    }
    done(h);
  }
});

test('国度 runs with every skill against a moving wave and keeps the invariants', () => {
  for (const [tier, elite, module] of ALL_FORMS) {
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, skill, module, enemies: [{ key: 'enemy_walk', count: 6, interval: 1 }] });
      h.run(40);
      assert.ok(u.alive);
      done(h);
    }
  }
});

test('国度 on screen: a \'domain\' fx with her field\'s tiles every 0.5 s, keyed by the unit (render/fx/zones.js domainField)', () => {
  const { h, u } = field({ tier: 6, elite: true, module: AMBX });
  h.run(1.1);
  const fx = h.eventsOf('fx').filter((f) => f[1] === 'domain' && f[4]?.id === u.id);
  assert.ok(fx.length >= 2, `a pulse every 0.5 s: ${fx.length}`);
  const last = fx.at(-1)[4];
  assert.equal(last.key, `domain:${u.id}`);
  assert.deepEqual(last.tiles.map(([r, c]) => r * COLS + c).sort((a, b) => a - b), [...u.rangeKeys].sort((a, b) => a - b), 'her range tiles');
  assert.ok(last.dur > 0.5, 'it outlives the next pulse');
  done(h);
});
