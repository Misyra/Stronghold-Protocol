// test/content/op_ash.test.js — the 自选 operator kit of 灰烬 (char_456_ash, 6★ 速射手, a collab pick of `diy.excluded`; kit
// server/sim/content/kits/ops/op-ash.js), fielded the production way (a DIY slot + its `diy` pick) in every form: tiers 5 / 6,
// normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module, MAR-Y or MAR-X at stage 1 (tier 5) /
// 3 (tier 6). Numbers from data/backups.json; the fidelity checklist of kits/README.md.
// Run: node --test test/content/op_ash.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { FLASH_DELAY, FLASH_SPEED, FLASH_RADIUS, SHELL_REACH, SHELL_SPEED, BLAST_RADIUS, S2_ROUNDS, S3_USES } from '../../server/sim/content/kits/ops/op-ash.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const BACKUPS = load('backups');
const ASH = 'char_456_ash';
const FORMS = BACKUPS.units[ASH].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const Y = 'uniequip_002_ash', X = 'uniequip_003_ash';
const S1 = 'skchr_ash_1', S2 = 'skchr_ash_2', S3 = 'skchr_ash_3';
const statusOf = (tier, elite) => (elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0');
const formOf = (tier, elite) => FORMS[statusOf(tier, elite)];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
const talentOf = (tier, elite, mod, i) => modOf(tier, mod)?.talentChanges.find((t) => t.talentIndex === i)?.bb ?? formOf(tier, elite).talents[i].bb;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 5, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }), enemy_light: dummy('enemy_light', { mass: 0 }),
};
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, Y, X].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;
const ROW = 10, COL = 4;

/** 灰烬 as uid 1 at (row, col) facing RIGHT. */
function field({ tier = 5, elite = false, mod = null, skill = 0, seed = 5, row = ROW, col = COL, dp = 0, others = [] } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999, dpInit: dp }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'deploy', 'death'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ASH, skillIndex: skill, uniEquipId: mod }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const fxOf = (h, kind) => h.eventsOf('fx').filter((x) => x[1] === kind).map((x) => ({ x: x[2], y: x[3], ...(x[4] || {}) }));
/** Her damage on `e` (the 'damaged' hook). */
const hitsOn = (h, u, e, tag = null) => h.hooksOf('damaged').filter((c) => c.source === u && c.target === e && c.type !== 'element' && (!tag || c.dmg?.tags?.includes(tag)));
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
/** Take her off the field and put her back (a redeployment). */
function redeploy(h, u) {
  h.b.retreat(u, { reason: 'retreat' });
  h.step();
  assert.ok(h.b.redeploy(u, { free: true }), 'redeployed');
  h.step();
}

test('灰烬 in every 自选 form: her operator kit (all three skills authored), the form\'s stats + module attributes, 3-4, ranged physical arrows that hit air units and prefer them, blocks 1, 协防 + 精准, no 特质; a collab pick', () => {
  assert.equal(OPERATOR_KITS[ASH], KITS[ASH]);
  assert.ok(KITTED_CHARS.includes(ASH));
  assert.ok(BACKUPS.diy.excluded.includes(ASH) && !BACKUPS.diy.ownedPool.includes(ASH), 'a collab pick (diy.excluded)');
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null;
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ASH, SLOT[tier], form.skills[skill].skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def], [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0)], `${label(f)}: stats`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.dmgType, u.profile.canHitFly, u.profile.projectile, u.profile.priority], [1, 'ranged', 'phys', true, 'arrow', 'fly'], `${label(f)}: 速射手`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 3-4`);
      assert.deepEqual([u.def.bonds, u.def.raw.garrisonIds], [['emptyShip', 'preciShip'], []], `${label(f)}: bonds / 特质`);
      const rule = { 0: 'SP_FULL', 1: 'DEFAULT', 2: 'SKILL_RANGE' }[skill];
      assert.equal(u.skill.rule, rule, `${label(f)}: trigger`);
      done(h);
    }
  }
});

test('T2 突击手: +sp (20) SP with her first deployment of the battle only (ash_t_2 CheckBuildCnt ≤ 1); the cost cut has no effect', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const t1 = talentOf(tier, elite, mod, 1);
    assert.equal(t1.sp, 20, label(f));
    const { h, u } = field({ tier, elite, mod, skill: 1 });
    approx(u.skill.sp, Math.min(skillOf(tier, elite, S2).spCost, skillOf(tier, elite, S2).initSp + 20), `${label(f)}: +20 SP`, 0.05);
    redeploy(h, u);
    assert.ok(u.skill.sp < 1, `${label(f)}: no SP on the second deployment (${u.skill.sp})`);
    done(h);
  }
});

test('T1 辅助装备: at each deployment, with an enemy in her range then, a flashbang FLASH_DELAY s later at the first enemy of her order (flyers first) stuns every enemy within 1 of its landing — none in range at her deployment, nothing (one arriving during the delay is not waited for); no damage', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const t0 = talentOf(tier, elite, mod, 0);
    assert.equal(t0.stun, mod === X && tier === 6 ? 6 : 4, label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    const early = h.spawn('enemy_dummy', { pos: [ROW, COL + 2] }); // arrives during the delay
    h.run(1);
    assert.equal(fxOf(h, 'ashFlashDash').length, 0, `${label(f)}: no enemy in range at her deployment: no throw`);
    assert.ok(!early.hasBuff('stun'));
    h.b.kill(early, null);
    const fly = h.spawn('enemy_fly', { pos: [ROW, COL + 3] });
    const near = h.spawn('enemy_dummy', { pos: [ROW, COL + 3] });
    const near2 = h.spawn('enemy_dummy', { pos: [ROW + 1, COL + 3] });
    const far = h.spawn('enemy_dummy', { pos: [ROW, COL + 1] });
    redeploy(h, u);
    const t = (FLASH_DELAY + 3 / FLASH_SPEED) + 0.2;
    h.run(t);
    const st = h.hooksOf('statusApplied').filter((c) => c.status === 'stun' && c.source === u);
    assert.deepEqual(st.map((c) => c.target.id).sort(), [fly, near, near2].map((x) => x.id).sort(), `${label(f)}: the flyer (first in her order) and those within ${FLASH_RADIUS}`);
    for (const c of st) approx(c.duration, t0.stun, `${label(f)}: ${t0.stun} s`, 1e-6);
    assert.ok(!far.hasBuff('stun'));
    assert.equal(h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.tags?.includes('ash:flash')).length, 0, 'no damage');
    assert.equal(fxOf(h, 'ashFlashBlast').length, 1);
    done(h);
  }
});

test('MAR-X stage 3: her physical damage to the enemies her flashbang struck is ×1.1 for 6 s', () => {
  const { h, u } = field({ tier: 6, elite: true, mod: X, skill: 0 });
  const a = h.spawn('enemy_dummy', { pos: [ROW, COL + 3] });
  const b = h.spawn('enemy_dummy', { pos: [ROW + 3, COL + 3] });
  redeploy(h, u);
  h.run(FLASH_DELAY + 0.5);
  assert.ok(a.hasBuff('stun') && !b.hasBuff('stun'));
  const da = h.b.dealDamage(u, a, { amount: 1000, type: 'phys', tags: ['test'] });
  const db = h.b.dealDamage(u, b, { amount: 1000, type: 'phys', tags: ['test'] });
  approx(da / db, 1.1, 'ash_e_003_t[damage_scale]', 1e-6);
  h.run(6.2);
  const da2 = h.b.dealDamage(u, a, { amount: 1000, type: 'phys', tags: ['test'] });
  approx(da2 / db, 1, 'gone after scale_duration', 1e-6);
  done(h);
});

test('S1 支援射击: cast at full SP (SP_FULL), infinite — ATK +atk and two shots per attack', () => {
  for (const f of [[5, false, null], [6, true, Y]]) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S1);
    assert.deepEqual([sk.skillType, sk.bb['attack@times'], sk.bb.atk], ['AUTO', 2, elite ? 0.11 : 0.08], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    const atk0 = u.s.atk;
    assert.ok(h.runUntil(() => u.skill.active, sk.spCost + 2), `${label(f)}: cast with no enemy`);
    approx(u.s.atk, atk0 * (1 + sk.bb.atk) / 1, `${label(f)}: ATK +${sk.bb.atk}`, 1e-3);
    const e = h.spawn('enemy_dummy', { pos: [ROW, COL + 2] });
    assert.ok(h.runUntil(() => hitsOn(h, u, e).length >= 2, 5));
    const first = hitsOn(h, u, e);
    assert.equal(new Set(first.map((c) => c.dmg.attackId)).size, 1, `${label(f)}: two shots of one attack`);
    h.run(60);
    assert.ok(u.skill.active, 'still on');
    done(h);
  }
});

test('S2 突击战术: the flashbang at once, base attack time −0.8 s, ATK ×atk_scale against a stunned target, 31 shots — one fewer after a cast that ran out', () => {
  for (const f of [[5, false, null], [6, true, X]]) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S2);
    const scale = sk.bb['ash_s_2[atk_scale].atk_scale'];
    assert.deepEqual([sk.skillType, sk.bb.base_attack_time, scale], ['MANUAL', -0.8, elite ? 2.1 : 1.8], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 1 });
    const iv0 = u.s.interval;
    const a = h.spawn('enemy_dummy', { pos: [ROW, COL + 2] });
    const b = h.spawn('enemy_dummy', { pos: [ROW + 4, COL + 2] }); // out of the flashbang's 1
    assert.ok(h.runUntil(() => u.skill.active, sk.spCost + 3), `${label(f)}: cast`);
    approx(u.s.interval, iv0 * (1 - 0.8 / u.base.bat), `${label(f)}: base attack time −0.8 s`, 1e-6);
    assert.equal(u.skill.ammoLeft <= S2_ROUNDS && u.skill.ammoMax, S2_ROUNDS, `${label(f)}: ${S2_ROUNDS} shots`);
    assert.ok(h.runUntil(() => a.hasBuff('stun'), 1), `${label(f)}: the flashbang`);
    // ×scale on a stunned target, not on another
    const sa = h.b.dealDamage(u, a, { amount: 1000, type: 'phys', tags: ['test'] });
    const sb = h.b.dealDamage(u, b, { amount: 1000, type: 'phys', tags: ['test'] });
    approx(sa / sb, scale * (mod === X && tier === 6 ? 1.1 : 1), `${label(f)}: ×${scale} vs stunned`, 1e-6);
    assert.ok(h.runUntil(() => !u.skill.active, 30), 'ends');
    const end = h.hooksOf('skillEnd').find((c) => c.unit === u);
    assert.equal(end?.reason, 'ammo');
    assert.ok(h.runUntil(() => u.skill.active, sk.spCost + 3), 'cast again');
    assert.equal(u.skill.ammoMax, S2_ROUNDS - 1, `${label(f)}: one fewer after running out`);
    done(h);
  }
});

/** Where S3's round should burst for 灰烬 at (r, c) facing RIGHT on this stage: [x, y, wall]. */
function burstOf(h, r, c) {
  const g = h.b.grid;
  let low = g.isLow(r, c);
  for (let k = 1; k <= SHELL_REACH; k++) {
    const nc = c + k;
    if (!g.inRect(r, nc)) return [nc - 0.5, r, true];
    if (low && !g.isLow(r, nc)) return [nc - 0.5, r, true];
    low = g.isLow(r, nc);
  }
  return [c + SHELL_REACH, r, false];
}

test('S3 攻坚榴弹: cast on its 1×5 line, the round flies her facing — atk_scale × ATK physical and a push to every enemy its 1.2 collider meets, once — then bursts on the 4th tile ahead (not_hitwall_scale) or a wall it struck from the ground (hitwall_scale) on every enemy within 1.5; two casts per deployment', () => {
  for (const f of [[5, false, null], [6, true, null], [6, true, X]]) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S3);
    assert.deepEqual([sk.skillType, sk.trigger.rule, sk.bb.atk_scale, sk.bb.not_hitwall_scale, sk.bb.hitwall_scale, sk.bb.force, sk.bb.range_radius],
      ['MANUAL', 'SKILL_RANGE', elite ? 2.6 : 2.3, elite ? 3.6 : 3.3, elite ? 7.2 : 6.6, elite ? 2 : 1, BLAST_RADIUS], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    const [bx, by, wall] = burstOf(h, ROW, COL);
    h.run(0.5);
    const e1 = h.spawn('enemy_dummy', { pos: [ROW, COL + 1] });
    const fly = h.spawn('enemy_fly', { pos: [ROW, COL + 1] });
    const atk = u.s.atk;
    assert.ok(h.runUntil(() => u.skill.activations === 1, sk.spCost + 2), `${label(f)}: cast with an enemy on the line`);
    h.run(SHELL_REACH / SHELL_SPEED + 0.3);
    const path = hitsOn(h, u, e1, 'ash:path');
    assert.equal(path.length, 1, `${label(f)}: hit once on the path`);
    approx(path[0].amount, atk * sk.bb.atk_scale, `${label(f)}: path ${sk.bb.atk_scale} × ATK`, 1e-3);
    const fp = hitsOn(h, u, fly, 'ash:path');
    assert.equal(fp.length, 1, `${label(f)}: air units too`);
    approx(fp[0].amount, atk * sk.bb.atk_scale * (mod === X ? 1.1 : 1), `${label(f)}: MAR-X ×1.1 on air units`, 1e-3);
    const blast = fxOf(h, 'ashShellBlast');
    assert.equal(blast.length, 1);
    approx(blast[0].x, bx, `${label(f)}: burst x`, 1e-6);
    approx(blast[0].y, by, `${label(f)}: burst y`, 1e-6);
    assert.equal(!!blast[0].wall, wall, `${label(f)}: wall`);
    done(h);
  }
});

test('S3: the burst damages every enemy within 1.5 of its point (centre) for the scale of its stop; heavy enemies stay, light ones are pushed along her facing', () => {
  const tier = 6, elite = true;
  const sk = skillOf(tier, elite, S3);
  const { h, u } = field({ tier, elite, skill: 2 });
  const [bx, by, wall] = burstOf(h, ROW, COL);
  const scale = wall ? sk.bb.hitwall_scale : sk.bb.not_hitwall_scale;
  const near = h.spawn('enemy_dummy', { pos: [by + 1, Math.round(bx)] });
  const out = h.spawn('enemy_dummy', { pos: [by + 2, Math.round(bx)] });
  const light = h.spawn('enemy_light', { pos: [ROW, COL + 1] });
  const x0 = light.x;
  const atk = u.s.atk;
  assert.ok(h.runUntil(() => u.skill.activations === 1, sk.spCost + 2));
  h.run(SHELL_REACH / SHELL_SPEED + 0.3);
  const nb = hitsOn(h, u, near, 'ash:blast').concat(hitsOn(h, u, near, 'ash:wall'));
  assert.equal(nb.length, 1, 'within 1.5');
  approx(nb[0].amount, atk * scale, `burst ${scale} × ATK`, 1e-3);
  assert.equal(hitsOn(h, u, out, 'ash:blast').length + hitsOn(h, u, out, 'ash:wall').length, 0, 'not at 2');
  assert.ok(light.x > x0 + 0.5, `pushed along her facing (${x0} → ${light.x})`);
  done(h);
});

test('S3: two casts per deployment; a redeployment allows two more', () => {
  const sk = skillOf(5, false, S3);
  const { h, u } = field({ tier: 5, skill: 2 });
  h.spawn('enemy_dummy', { pos: [ROW, COL + 2] });
  assert.ok(h.runUntil(() => u.skill.activations === S3_USES, (sk.spCost + 4) * S3_USES));
  h.run(sk.spCost * 2 + 4);
  assert.equal(u.skill.activations, S3_USES, 'no third cast');
  redeploy(h, u);
  assert.ok(h.runUntil(() => u.skill.activations === S3_USES + 1, sk.spCost + 4), 'again after a redeployment');
  done(h);
});

test('MAR-Y: ASPD +attack_speed while a ground enemy is in her range (not for a flyer alone)', () => {
  for (const tier of [5, 6]) {
    const { h, u } = field({ tier, elite: true, mod: Y, skill: 1 });
    const as = modOf(tier, Y).talentChanges.find((t) => t.talentIndex === -1).bb.attack_speed;
    assert.equal(as, 8);
    const a0 = u.s.aspd;
    const fly = h.spawn('enemy_fly', { pos: [ROW, COL + 2] });
    h.run(0.3);
    assert.equal(u.s.aspd, a0, `T${tier}: a flyer alone`);
    h.spawn('enemy_dummy', { pos: [ROW, COL + 2] });
    h.run(0.3);
    assert.equal(u.s.aspd, a0 + as, `T${tier}: +${as}`);
    assert.ok(fly.alive);
    done(h);
  }
});
