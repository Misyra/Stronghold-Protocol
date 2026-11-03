// test/content/op_ela.test.js — the 自选 operator kit of 艾拉 (char_4123_ela, 6★ 陷阱师, a collab pick of `diy.excluded`; kit
// server/sim/content/kits/ops/op-ela.js) and of her trap 雷鸣地雷 (token_10033_ela_grzmot), fielded the production way (a DIY
// slot + its `diy` pick; her traps as the placed hand pieces of her player) in every form: tiers 5 / 6, normal (E2 Lv1, skill
// rank 4, no module) and elite (E2 Lv60, rank 7) with no module or TRP-Δ at stage 1 (tier 5) / 3 (tier 6). Numbers from
// data/backups.json; the fidelity checklist of kits/README.md.
// Run: node --test test/content/op_ela.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { TRIGGER_RADIUS, EFFECT_RADIUS, DEAD_DELAY } from '../../server/sim/content/kits/ops/op-ela.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const BACKUPS = load('backups');
const ELA = 'char_4123_ela';
const MINE = 'token_10033_ela_grzmot';
const FORMS = BACKUPS.units[ELA].forms;
const TOKREC = BACKUPS.tokens[MINE];
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const D = 'uniequip_002_ela';
const S1 = 'skchr_ela_1', S2 = 'skchr_ela_2', S3 = 'skchr_ela_3';
const statusOf = (tier, elite) => (elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0');
const formOf = (tier, elite) => FORMS[statusOf(tier, elite)];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
const talentOf = (tier, elite, mod, i) => modOf(tier, mod)?.talentChanges.find((t) => t.talentIndex === i)?.bb ?? formOf(tier, elite).talents[i].bb;
const tokOf = (tier, elite, skill, mod) => {
  let v = TOKREC.variants[`${ELA}@${statusOf(tier, elite)}`];
  if (v.bySkill?.[skill]) v = { ...v, ...v.bySkill[skill] };
  if (mod && v.byModule?.[mod]) v = { ...v, ...v.byModule[mod] };
  return v;
};
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 5, ...o });
const ENEMIES = { enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }) };
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, D].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;
const ROW = 10, COL = 4;
const TRAP_AT = [9, 8];

/** 艾拉 as uid 1 at (10, 4) facing RIGHT; `pieces` = the tiles of her placed traps (uids 2…). */
function field({ tier = 5, elite = false, mod = null, skill = 0, pieces = [], dp = 0, seed = 5, others = [] } = {}) {
  const units = [{ uid: 1, diy: { slot: SLOT[tier], charId: ELA, skillIndex: skill, uniEquipId: mod }, elite, row: ROW, col: COL }];
  pieces.forEach(([r, c], i) => units.push({ uid: 2 + i, kind: 'token', tokenId: MINE, ownerUid: 1, row: r, col: c }));
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999, dpInit: dp }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'deploy', 'death'], captureNoisy: true,
    units: [...units, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const traps = (h) => h.b.allyUnits.filter((t) => t.kind === 'token' && t.defId === MINE);
const piece = (h, uid) => traps(h).find((t) => t.uid === uid);
const fxOf = (h, kind) => h.eventsOf('fx').filter((x) => x[1] === kind).map((x) => ({ x: x[2], y: x[3], ...(x[4] || {}) }));
const ST = (u) => u.trait.ela;
const statusOn = (h, e, status) => h.hooksOf('statusApplied').filter((c) => c.target === e && c.status === status);
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('艾拉 in every 自选 form: her operator kit (all three skills authored; S1 SP_FULL), the form\'s stats + module attributes, 3-4, ranged physical arrows that hit air units, blocks 1, 协防 + 不屈; her traps untargetable, blocking nothing, no attack, with the token skill of her pick', () => {
  assert.equal(OPERATOR_KITS[ELA], KITS[ELA]);
  assert.ok(KITTED_CHARS.includes(ELA));
  assert.ok(BACKUPS.diy.excluded.includes(ELA) && !BACKUPS.diy.ownedPool.includes(ELA), 'a collab pick (diy.excluded)');
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill, pieces: [TRAP_AT] });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null;
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ELA, SLOT[tier], form.skills[skill].skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def], [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0)], `${label(f)}: stats`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.dmgType, u.profile.canHitFly, u.profile.projectile, u.base.bat], [1, 'ranged', 'phys', true, 'arrow', 0.85], `${label(f)}: 陷阱师`);
      assert.deepEqual(u.def.bonds, ['emptyShip', 'indomShip'], `${label(f)}: bonds`);
      assert.equal(u.skill.rule, skill === 0 ? 'SP_FULL' : 'DEFAULT', `${label(f)}: trigger`);
      const t = piece(h, 2);
      const v = tokOf(tier, elite, skill, mod);
      assert.ok(t.alive && !t.kit.generic, `${label(f)}: the placed trap deployed with its kit`);
      assert.deepEqual([t.def.skill.id, t.s.flags.untargetable, t.s.blockCnt, t.profile.noAttack, t.base.cost], [v.skill.skillId, true, 0, true, v.stats.cost], `${label(f)}: the trap`);
      done(h);
    }
  }
  // the trap card: cost 5, redeploy 5 s, deploy limit 4
  assert.deepEqual([tokOf(6, true, 0, null).stats.cost, tokOf(6, true, 0, null).stats.respawnTime, tokOf(6, true, 0, null).stats.deployLimit, tokOf(6, true, 0, D).stats.deployLimit], [5, 5, 4, 4]);
});

test('T1 雷鸣地雷: at her deployment her stock is cnt (4), the deploy limit 4; S1 阻回 while full, +1 at full SP below it', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    assert.equal(talentOf(tier, elite, mod, 0).cnt, 4, label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    assert.deepEqual([ST(u).stock, ST(u).limit], [4, 4], `${label(f)}: stock / limit`);
    assert.ok(u.findBuff('talent:ela:full') && u.s.flags.noSp, `${label(f)}: 阻回 at full stock`);
    ST(u).stock = 2;
    h.step();
    const sk = skillOf(tier, elite, S1);
    assert.ok(h.runUntil(() => u.skill.activations === 1, sk.spCost + 2), `${label(f)}: cast at full SP`);
    assert.equal(ST(u).stock, 3, `${label(f)}: +1`);
    done(h);
  }
  // S2 / S3 carry no 阻回
  const { u } = field({ tier: 5, skill: 1 });
  assert.ok(!u.findBuff('talent:ela:full'));
});

test('the trap goes off when a selectable ground enemy comes within 1.35 (flyers never) on every ground enemy within 1.7, then withdraws — S1: 停顿 + the influence (命中率 cut) for duration s', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const tb = tokOf(tier, elite, 0, mod).skill.bb;
    assert.deepEqual([tb.sluggish, tb.duration, tb.damage_hitrate_physical, tb.projectile_range], [elite ? 9 : 8, elite ? 9 : 8, elite ? -0.3 : -0.2, EFFECT_RADIUS], label(f));
    assert.equal(TRIGGER_RADIUS, 1.35);
    const { h, u } = field({ tier, elite, mod, skill: 0, pieces: [TRAP_AT] });
    const t = piece(h, 2);
    h.spawn('enemy_fly', { pos: TRAP_AT });
    const away = h.spawn('enemy_dummy', { pos: [TRAP_AT[0], TRAP_AT[1] + 2] }); // 2 > 1.35
    h.run(0.5);
    assert.ok(t.alive, `${label(f)}: neither a flyer nor an enemy at 2`);
    const e = h.spawn('enemy_dummy', { pos: [TRAP_AT[0] + 1, TRAP_AT[1]] }); // 1 ≤ 1.35
    const out = h.spawn('enemy_dummy', { pos: [TRAP_AT[0], TRAP_AT[1] - 2] }); // 2 > 1.7
    h.step();
    assert.ok(!t.alive, `${label(f)}: used up`);
    for (const x of [e]) {
      const s = statusOn(h, x, 'sluggish');
      assert.equal(s.length, 1, `${label(f)}: 停顿`);
      approx(s[0].duration, tb.sluggish, `${label(f)}: ${tb.sluggish} s`);
    }
    assert.equal(statusOn(h, away, 'sluggish').length, 0, `${label(f)}: 2 tiles off is outside 1.7`);
    assert.equal(statusOn(h, out, 'sluggish').length, 0, `${label(f)}: outside 1.7`);
    const blast = fxOf(h, 'elaMineBlast');
    assert.ok(blast.some((x) => x.mine === t.id && x.consumed && x.id === u.id), `${label(f)}: the blast fx`);
    done(h);
  }
});

test('the influence: an influenced enemy\'s physical / arts attacks miss with |damage_hitrate_*| (one roll per attack); her T2 always crits it', () => {
  const tier = 6, elite = true;
  const tb = tokOf(tier, elite, 0, null).skill.bb;
  const { h, u } = field({ tier, elite, skill: 0, pieces: [TRAP_AT] });
  const e = h.spawn('enemy_dummy', { pos: [TRAP_AT[0], TRAP_AT[1]] });
  h.step();
  assert.ok(!piece(h, 2).alive);
  // the miss roll, on the battle's hit hook: 2000 synthetic attacks of e
  let missed = 0;
  for (let i = 0; i < 2000; i++) {
    const dmg = { amount: 100, type: 'phys', isAttack: true, attackId: `test:${i}`, tags: [] };
    h.b.emit('hit', { source: e, target: u, dmg });
    if (dmg.cancel) missed++;
  }
  approx(missed / 2000, -tb.damage_hitrate_physical, 'miss rate', 0.15);
  // T2: ×atk_scale on her damage to it, every time
  const t1 = talentOf(tier, elite, null, 1);
  const other = h.spawn('enemy_dummy', { pos: [ROW + 5, COL] });
  const amounts = [];
  for (let i = 0; i < 20; i++) amounts.push(h.b.dealDamage(u, e, { amount: 1000, type: 'phys', tags: ['test'] }));
  assert.ok(amounts.every((a) => Math.abs(a - 1000 * t1.atk_scale) < 1e-6), `always ×${t1.atk_scale}: ${amounts}`);
  assert.ok(other.alive);
  h.run(tb.duration + 0.5);
  let crit = 0;
  for (let i = 0; i < 400; i++) if (h.b.dealDamage(u, e, { amount: 1000, type: 'phys', tags: ['test'] }) > 1000 + 1e-6) crit++;
  approx(crit / 400, t1.prob, 'after the influence: the prob roll', 0.25);
  done(h);
});

test('TRP-Δ stage 3: T2 50 % / ×1.8 — and her prob roll on an uninfluenced enemy', () => {
  const t1 = talentOf(6, true, D, 1);
  assert.deepEqual([t1.prob, t1.atk_scale], [0.5, 1.8]);
  const { h, u } = field({ tier: 6, elite: true, mod: D, skill: 1 });
  const e = h.spawn('enemy_dummy', { pos: [ROW, COL + 2] });
  let crit = 0;
  for (let i = 0; i < 400; i++) {
    const a = h.b.dealDamage(u, e, { amount: 1000, type: 'phys', tags: ['test'] });
    if (a > 1000 + 1e-6) { crit++; approx(a, 1800, 'crit amount'); }
  }
  approx(crit / 400, 0.5, 'prob 0.5', 0.2);
  done(h);
});

test('S2 / S3 traps: S2 晕眩 stun s (+ influence), S3 停顿 + 脆弱 (damage_scale − 1) for weak[limit] s (+ influence)', () => {
  for (const f of [[5, false, null], [6, true, D]]) {
    const [tier, elite, mod] = f;
    {
      const tb = tokOf(tier, elite, 1, mod).skill.bb;
      const { h, u } = field({ tier, elite, mod, skill: 1, pieces: [TRAP_AT] });
      const e = h.spawn('enemy_dummy', { pos: TRAP_AT });
      h.step();
      const s = statusOn(h, e, 'stun');
      assert.equal(s.length, 1, `${label(f)}: S2 stun`);
      approx(s[0].duration, tb.stun, `${label(f)}: ${tb.stun} s`);
      const a = h.b.dealDamage(u, e, { amount: 1000, type: 'phys', tags: ['test'] });
      approx(a, 1000 * talentOf(tier, elite, mod, 1).atk_scale, `${label(f)}: influenced`);
      done(h);
    }
    {
      const tb = tokOf(tier, elite, 2, mod).skill.bb;
      const { h } = field({ tier, elite, mod, skill: 2, pieces: [TRAP_AT] });
      const e = h.spawn('enemy_dummy', { pos: TRAP_AT });
      h.step();
      const sl = statusOn(h, e, 'sluggish'), fr = statusOn(h, e, 'fragile');
      assert.equal(sl.length, 1, `${label(f)}: S3 停顿`);
      approx(sl[0].duration, tb.sluggish, `${label(f)}: ${tb.sluggish} s`);
      assert.equal(fr.length, 1, `${label(f)}: S3 脆弱`);
      approx(fr[0].value, tb.damage_scale - 1, `${label(f)}: +${tb.damage_scale - 1}`);
      approx(fr[0].duration, tb['weak[limit]'], `${label(f)}: ${tb['weak[limit]']} s`);
      done(h);
    }
  }
});

test('a used-up placed trap comes back on its tile: her stock −1, its cost in DP, the card\'s 5 s, never on a tile a ground enemy stands on', () => {
  const { h, u } = field({ tier: 5, skill: 1, pieces: [TRAP_AT], dp: 50 });
  const t = piece(h, 2);
  const e = h.spawn('enemy_dummy', { pos: TRAP_AT });
  h.step();
  assert.ok(!t.alive);
  h.run(6);
  assert.ok(!t.alive, 'the enemy still stands on its tile');
  h.b.kill(e, null);
  const dp0 = h.b.getPlayer(u.ownerId).dp, s0 = ST(u).stock;
  assert.ok(h.runUntil(() => t.alive, 2), 'back');
  assert.deepEqual([t.tileR, t.tileC], TRAP_AT);
  assert.equal(ST(u).stock, s0 - 1, 'one trap spent');
  approx(h.b.getPlayer(u.ownerId).dp, dp0 - t.base.cost, 'its cost');
  done(h);
});

test('her own effect when she leaves: knocked out — where she fell, 0.8 s later (her skill\'s effect); withdrawn otherwise — at once; her standing traps leave with her', () => {
  for (const reason of ['killed', 'retreat']) {
    const { h, u } = field({ tier: 6, elite: true, skill: 1, pieces: [[13, 4]] });
    const t = piece(h, 2);
    const e = h.spawn('enemy_dummy', { pos: [ROW, COL + 1] });
    const sb = skillOf(6, true, S2).bb;
    h.step();
    if (reason === 'killed') h.b.dealDamage(e, u, { amount: 1e9, type: 'true', tags: ['test'] });
    else h.b.retreat(u, { reason: 'retreat' });
    assert.ok(!u.alive, `${reason}: gone`);
    assert.ok(!t.alive, `${reason}: her trap left with her`);
    if (reason === 'killed') {
      h.run(DEAD_DELAY - 0.2);
      assert.equal(statusOn(h, e, 'stun').length, 0, 'not yet');
      h.run(0.4);
    } else h.step();
    const s = statusOn(h, e, 'stun');
    assert.equal(s.length, 1, `${reason}: S2's stun around her`);
    approx(s[0].duration, sb.stun, `${reason}: ${sb.stun} s`);
    done(h);
  }
});

test('S2 震荡坚守: DEF +def, ignores def_penetrate_fixed DEF, the skill\'s 3×3 range, splash 1.1 around the target; +1 trap at the end', () => {
  const tier = 6, elite = true;
  const sk = skillOf(tier, elite, S2);
  assert.deepEqual([sk.bb.def, sk.bb.def_penetrate_fixed, sk.bb['attack@projectile_range']], [2.5, 500, 1.1]);
  const { h, u } = field({ tier, elite, skill: 1 });
  const def0 = u.s.def;
  const e = h.spawn('enemy_dummy', { pos: [ROW, COL + 1] });
  const n1 = h.spawn('enemy_dummy', { pos: [ROW + 1, COL + 1] });   // 1 ≤ 1.1
  const n2 = h.spawn('enemy_dummy', { pos: [ROW - 1, COL + 2] });   // √2 > 1.1
  ST(u).stock = 1;
  assert.ok(h.runUntil(() => u.skill.active, 60), 'cast');
  approx(u.s.def, def0 * (1 + sk.bb.def), 'DEF ×3.5', 1e-3);
  assert.deepEqual(u.liveRangeGrid, sk.rangeGrid, '3×3');
  assert.ok(h.runUntil(() => h.hooksOf('damaged').some((c) => c.source === u && c.target === n1), 5), 'the splash');
  assert.ok(!h.hooksOf('damaged').some((c) => c.source === u && c.target === n2 && c.dmg?.isSplash), 'not at √2');
  assert.ok(e.alive);
  assert.ok(h.runUntil(() => !u.skill.active, sk.duration + 1), 'ends');
  assert.equal(ST(u).stock, 2, '+1');
  done(h);
});

test('S3 “博萨克风暴”: ATK +atk, base attack time −0.35 s, 40 shots, an influenced enemy first; +2 traps at the end', () => {
  const tier = 5, elite = false;
  const sk = skillOf(tier, elite, S3);
  assert.deepEqual([sk.bb.atk, sk.bb.base_attack_time, sk.bb['attack@trigger_time'], sk.bb.cnt], [0.45, -0.35, 40, 2]);
  const { h, u } = field({ tier, elite, skill: 2, pieces: [[ROW + 1, COL + 3]] });
  const atk0 = u.s.atk;
  const first = h.spawn('enemy_dummy', { pos: [ROW, COL + 1] });
  ST(u).stock = 0;
  assert.ok(h.runUntil(() => u.skill.active, sk.spCost + 2), 'cast');
  approx(u.s.atk, atk0 * (1 + sk.bb.atk), 'ATK', 1e-3);
  assert.equal(u.skill.ammoMax, 40);
  const marked = h.spawn('enemy_dummy', { pos: [ROW + 1, COL + 3] });
  h.step();
  assert.ok(!piece(h, 2).alive, 'the trap influenced it');
  h.run(1); // (arrows already in flight at the other one land)
  const n0 = h.hooksOf('damaged').length;
  h.run(2);
  const later = h.hooksOf('damaged').slice(n0).filter((c) => c.source === u && c.dmg?.isAttack);
  assert.ok(later.length > 0 && later.every((c) => c.target === marked), 'the influenced enemy first');
  assert.ok(first.alive);
  assert.ok(h.runUntil(() => !u.skill.active, 60), 'ends');
  assert.equal(ST(u).stock, 2, '+2');
  done(h);
});
