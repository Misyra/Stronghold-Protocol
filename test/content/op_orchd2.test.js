// test/content/op_orchd2.test.js — the 自选 operator kit of 焰狐龙梓兰 (char_1048_orchd2, 6★ 重射手; kit
// server/sim/content/kits/ops/op-orchd2.js), fielded the production way (a DIY slot + its `diy` pick, simdata getDiy) in
// every form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module or ARC-X
// “梓兰特制箭靶” at stage 1 (tier 5) / 3 (tier 6). Numbers from data/backups.json; the skill clips' moments from the kit's
// CLIP (the official skeleton); the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_orchd2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool } from '../../shared/diy.js';
import { CLIP, ARROW, NORMAL_HITS } from '../../server/sim/content/kits/ops/op-orchd2.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const ORCHD = 'char_1048_orchd2';
const FORMS = BACKUPS.units[ORCHD].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const X = 'uniequip_002_orchd2';
const S1 = 'skchr_orchd2_1', S2 = 'skchr_orchd2_2', S3 = 'skchr_orchd2_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
/** The form's talents with the module's changes (by talentIndex — no hidden trait part here). */
const talentsOf = (tier, elite, mod) => {
  const out = formOf(tier, elite).talents.map((t) => ({ ...t, bb: { ...t.bb }, bbStr: { ...t.bbStr } }));
  for (const ch of modOf(tier, mod)?.talentChanges ?? []) {
    const t = out.find((x) => x.index === ch.talentIndex);
    Object.assign(t.bb, ch.bb); Object.assign(t.bbStr, ch.bbStr ?? {});
  }
  return out;
};
const tBb = (tier, elite, mod, key) => talentsOf(tier, elite, mod).find((t) => t.bb[key] != null).bb;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }), enemy_def: dummy('enemy_def', { def: 100 }),
  enemy_heavy: dummy('enemy_heavy', { mass: 5 }), enemy_gun: dummy('enemy_gun', { atk: 50, range: 2.5, bat: 1 }),
};
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, X].map((m) => [t, true, m]))];
const POWER = 'power_attack_count';

function field({ tier = 5, elite = false, mod = null, skill = 0, row = 10, col = 5, others = [], seed = 5 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'deploy', 'attack'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ORCHD, skillIndex: skill, uniEquipId: mod }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const mine = (h, u) => h.hooksOf('damaged').filter((c) => c.source === u);
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;
/** Damage events grouped by attack (attackId). */
const rounds = (list) => { const m = new Map(); for (const c of list) { const k = c.dmg.attackId; if (!m.has(k)) m.set(k, []); m.get(k).push(c); } return [...m.values()]; };

test('焰狐龙梓兰 in every 自选 form: her kit, the form\'s stats + ARC-X, redeploy 70 − 25 (ARC-X) − 15 / 18 (翔虫机动) s, 3-6, a 三连击 sniper that hits air, the data triggers', () => {
  assert.equal(OPERATOR_KITS[ORCHD], KITS[ORCHD]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null;
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ORCHD, SLOT[tier], form.skills[skill].skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def], [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0)], `${label(f)}: stats`);
      const rt = tBb(tier, elite, mod, 'respawn_time').respawn_time;
      assert.equal(u.base.respawnTime, form.stats.respawnTime + (m?.attr.respawnTime ?? 0) + rt, `${label(f)}: redeploy time`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.canHitFly, u.profile.dmgType, u.profile.hits, u.base.bat], [1, 'ranged', true, 'phys', NORMAL_HITS, 1.6], `${label(f)}: 重射手, 三连击`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 3-6`);
      assert.equal(u.skill.rule, form.skills[skill].trigger.rule, `${label(f)}: the data's trigger`);
      // S2 is cast at every deployment: airborne right after the first step
      assert.equal(!!u.s.flags.liftoff, skill === 1, `${label(f)}: ground-targetable unless airborne`);
      done(h);
    }
  }
  assert.deepEqual(formOf(6, true).skills.map((s) => s.trigger.rule), ['DEFAULT', 'SKILL_RANGE', 'DEFAULT']);
  assert.deepEqual([55, 30, 27], [[5, false, null], [5, true, X], [6, true, X]].map(([t, e, m]) => formOf(t, e).stats.respawnTime + (modOf(t, m)?.attr.respawnTime ?? 0) + tBb(t, e, m, 'respawn_time').respawn_time));
  assert.ok(KITTED_CHARS.includes(ORCHD) && [5, 6].every((t) => diyPool(t, { data: { chess: CHESS, backups: BACKUPS }, kitted: KITTED_CHARS }).includes(ORCHD)), 'offered at tiers 5 / 6');
});

test('trait (PRTS 特性备注): a normal attack is 3 hits of 100 % ATK, each ×0.333 after DEF; skill attacks are not cut; air units are hit', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, X]]) {
    const cut = tBb(tier, elite, mod, 'attack@damage_scale')['attack@damage_scale'];
    assert.equal(cut, 0.333);
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    u.skill.sp = 0;
    const e = h.spawn('enemy_def', { pos: [10, 7] });
    h.run(20);
    const r = rounds(mine(h, u).filter((c) => c.dmg.isAttack && c.target === e));
    assert.ok(r.length >= 5, `T${tier}: ${r.length} attacks`);
    for (const g of r) {
      assert.equal(g.length, NORMAL_HITS, `T${tier}: 三连击`);
      for (const c of g) { approx(c.amount, (u.s.atk - 100) * cut, `T${tier}: (ATK − DEF) × 33.3 %`); assert.deepEqual([c.type, c.dmg.isSkill], ['phys', false]); }
    }
    h.b.kill(e, null);
    const f = h.spawn('enemy_fly', { pos: [11, 6] });
    h.run(5);
    assert.ok(mine(h, u).some((c) => c.target === f), `T${tier}: the flyer is attacked`);
    done(h);
  }
});

test('S1 刚射 (MANUAL, charges 2 / 3, data DEFAULT): one charge — 4 arrows of 100 % / 120 %; a charge left — it is spent for 刚连射 1.167 s later, 5 arrows of 140 % / 160 %; no normal attack until the clip ends; no target for 刚连射 ⇒ the charge comes back; each 刚连射 arrow 20 % to stun 2 s', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, X]]) {
    const sk = skillOf(tier, elite, S1);
    const pw = tBb(tier, elite, mod, POWER).power_attack_scale;
    assert.deepEqual([sk.bb.atk_scale_1, sk.bb.atk_scale_2, sk.bb.stun_prob, sk.bb.stun, sk.maxChargeTime, sk.spCost, sk.initSp],
      elite ? [1.2, 1.6, 0.2, 2, 3, 5, 10] : [1, 1.4, 0.2, 2, 2, 7, 7], `T${tier}`);
    // (a) one charge: the 4 arrows only, the next normal attack once the clip and the attack interval are over
    {
      const { h, u } = field({ tier, elite, mod, skill: 0, seed: 17 });
      assert.deepEqual([u.skill.kind, u.skill.rule, u.skill.maxCharges, u.skill.charges], ['charges', 'DEFAULT', sk.maxChargeTime, Math.floor(sk.initSp / sk.spCost)], `T${tier}`);
      u.skill.charges = 1;
      h.spawn('enemy_dummy', { pos: [10, 7] });
      assert.ok(h.runUntil(() => u.skill.activations === 1, 2));
      const t0 = h.b.time;
      assert.equal(u.skill.charges, 0, `T${tier}: one charge spent`);
      h.run(3);
      const first = rounds(mine(h, u).filter((c) => c.dmg.isSkill));
      assert.deepEqual(first.map((g) => g.length), [4], `T${tier}: one round of 4 arrows`);
      for (const c of first[0]) approx(c.amount, u.s.atk * sk.bb.atk_scale_1 * pw, `T${tier}: ×atk_scale_1 (×强击瓶专家)`);
      const plain = h.hooksOf('attack').filter((c) => c.attacker === u && !c.isSkill && c.t > t0 + 1e-6);
      assert.ok(plain.length && plain[0].t >= t0 + Math.max(CLIP.s1End1 - CLIP.s1Shot, 1.6) - 0.04, `T${tier}: the next normal attack after the clip`);
      done(h);
    }
    // (b) full charges: 刚连射 too, 1.167 s after the first shot, both charges spent, no normal attack inside the 2.0 s clip
    {
      const { h, u } = field({ tier, elite, mod, skill: 0, seed: 17 });
      u.skill.gainSp(999);
      const ch0 = u.skill.charges;
      h.spawn('enemy_dummy', { pos: [10, 7] });
      assert.ok(h.runUntil(() => u.skill.activations === 1, 2));
      const t1 = h.b.time;
      assert.equal(u.skill.charges, ch0 - 2, `T${tier}: two charges for 刚射 + 刚连射`);
      h.run(3);
      const shots = h.hooksOf('attack').filter((c) => c.attacker === u && c.isSkill);
      approx(shots[1].t - shots[0].t, CLIP.s1BurstShot - CLIP.s1Shot, `T${tier}: 1.167 s apart`, 0.04);
      const sec = rounds(mine(h, u).filter((c) => c.dmg.isSkill));
      assert.deepEqual(sec.map((g) => g.length), [4, 5], `T${tier}: 4 then 5 arrows`);
      for (const c of sec[1]) approx(c.amount, u.s.atk * sk.bb.atk_scale_2 * pw, `T${tier}: ×atk_scale_2`);
      const plain = h.hooksOf('attack').filter((c) => c.attacker === u && !c.isSkill);
      assert.ok(plain.length && plain[0].t >= t1 + CLIP.s1End2 - CLIP.s1Shot - 0.04, `T${tier}: no normal attack inside the 2.0 s clip (${plain[0]?.t} vs ${t1})`);
      done(h);
    }
    // (c) its target gone before 刚连射: nothing more, the charge back
    {
      const { h, u } = field({ tier, elite, mod, skill: 0, seed: 17 });
      u.skill.gainSp(999);
      const ch0 = u.skill.charges;
      const e = h.spawn('enemy_dummy', { pos: [10, 7] });
      assert.ok(h.runUntil(() => u.skill.activations === 1, 2));
      h.b.kill(e, null);
      h.run(1.5);
      assert.equal(u.skill.charges, ch0 - 1, `T${tier}: the second charge is back`);
      assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.isSkill).length, 1, `T${tier}: no 刚连射`);
      assert.equal(u.findBuff('orchd2:lock'), null, `T${tier}: the skill stopped (no clip left)`);
      done(h);
    }
  }
  // (d) the stun: every 刚连射 arrow rolls stun_prob for `stun` s
  const { h, u } = field({ tier: 6, elite: true, mod: X, skill: 0, seed: 9 });
  const e = h.spawn('enemy_dummy', { pos: [10, 7] });
  for (let i = 0; i < 60; i++) {
    u.skill.gainSp(999);
    const n = u.skill.activations;
    h.runUntil(() => u.skill.activations > n, 5);
    h.run(3.5);
  }
  const arrows = mine(h, u).filter((c) => c.dmg.tags?.includes('orchd2:burst'));
  const stuns = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun' && c.target === e);
  assert.equal(arrows.length, 60 * 5);
  assert.ok(Math.abs(stuns.length / arrows.length - 0.2) < 0.06, `stun rate ${stuns.length} / ${arrows.length}`);
  for (const c of stuns) assert.equal(c.duration, 2);
  done(h);
});

test('S2 飞翔瞪射: cast free at every deployment (SP untouched); 起飞 (no ground enemy blocks / hits her) and no normal attack; volleys of 3 / 4 / 5 arrows ×135 % / 150 % at every target of the 4-4 (air too), landing ×255 % / 270 % on the 1-3; the first cast 0.833 s longer; then the data\'s SKILL_RANGE', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, X]]) {
    const sk = skillOf(tier, elite, S2);
    const pw = tBb(tier, elite, mod, POWER).power_attack_scale;
    assert.deepEqual([sk.bb['attack@atk_scale_loop'], sk.bb['attack@atk_scale_end'], sk.duration, sk.maxChargeTime, sk.initSp, sk.spCost, sk.rangeId],
      elite ? [1.5, 2.7, 4.2, 3, 14, 20, '4-4'] : [1.35, 2.55, 4.2, 2, 11, 20, '4-4'], `T${tier}`);
    const h = makeBattle({ defs: { enemies: ENEMIES }, timeLimit: 300, autoFinish: false, seed: 6, flags: { dpPerSec: 0, dpMax: 999 },
      hooks: ['damaged', 'skillStart', 'skillEnd', 'attack'], captureNoisy: true,
      enemies: [{ key: 'enemy_dummy', pos: [10, 7] }, { key: 'enemy_fly', pos: [11, 9] }, { key: 'enemy_dummy', pos: [9, 6] }, { key: 'enemy_gun', pos: [11, 5] }],
      units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ORCHD, skillIndex: 1, uniEquipId: mod }, elite, row: 10, col: 5 }] });
    h.step();
    const u = h.unit(1);
    const [front, fly, near, gun] = h.b.enemies;
    assert.deepEqual([u.skill.active, h.hooksOf('skillStart')[0]?.reason, u.skill.charges, u.skill.sp], [true, 'deploy', 0, sk.initSp], `T${tier}: the free deploy cast`);
    assert.ok(u.s.flags.liftoff && u.s.flags.blockFly, `T${tier}: airborne`);
    const lead = CLIP.s2BeginFirst; // the first cast of the deployment
    const landAt = lead + 3 * CLIP.s2Loop + CLIP.s2EndShot;
    h.run(landAt + 0.3);
    const shots = h.hooksOf('attack').filter((c) => c.attacker === u);
    assert.equal(shots.length, 4, `T${tier}: three volleys and the landing — no normal attack`);
    shots.slice(0, 3).forEach((c, i) => approx(c.t, lead + i * CLIP.s2Loop + CLIP.s2LoopShot, `T${tier}: volley ${i + 1}`, 0.04));
    approx(shots[3].t, landAt, `T${tier}: landing`, 0.04);
    const dmg = mine(h, u);
    const vol = rounds(dmg.filter((c) => c.dmg.attackId !== dmg.at(-1).dmg.attackId));
    assert.deepEqual(vol.map((g) => g.length), [6, 8, 10], `T${tier}: 3 / 4 / 5 arrows at each of the two 4-4 targets`);
    for (const g of vol) {
      assert.deepEqual([...new Set(g.map((c) => c.target))].sort((a, b) => a.id - b.id), [front, fly].sort((a, b) => a.id - b.id), `T${tier}: the 4-4 targets (the flyer too)`);
      for (const c of g) approx(c.amount, u.base.atk * sk.bb['attack@atk_scale_loop'] * pw, `T${tier}: ×loop`);
    }
    const land = dmg.filter((c) => c.dmg.attackId === dmg.at(-1).dmg.attackId);
    assert.deepEqual(land.map((c) => c.target), [near], `T${tier}: the landing hits the 1-3 only`);
    approx(land[0].amount, u.base.atk * sk.bb['attack@atk_scale_end'] * pw, `T${tier}: ×end`);
    assert.ok(!u.s.flags.liftoff, `T${tier}: landed`);
    assert.equal(h.hooksOf('damaged').filter((c) => c.source === gun && c.target === u && c.t < landAt - 1e-6).length, 0, `T${tier}: the ground shooter could not hit her airborne`);
    assert.ok(h.runUntil(() => !u.skill.active, 2));
    approx(h.hooksOf('skillEnd')[0].t, sk.duration + (CLIP.s2BeginFirst - CLIP.s2Begin), `T${tier}: 4.2 + 0.833 s`, 0.05);
    h.run(3);
    assert.ok(h.hooksOf('damaged').some((c) => c.source === gun && c.target === u), `T${tier}: on the ground she is hit`);
    // later casts: SKILL_RANGE on 4-4 (the 1-3 neighbour alone does not cast it), the 0.667 s start
    for (const e of [front, fly]) h.b.kill(e, null);
    u.skill.charges = 1;
    u.skill.sp = 0;
    h.run(4);
    assert.equal(u.skill.activations, 1, `T${tier}: nobody on the 4-4, no cast`);
    h.spawn('enemy_dummy', { pos: [9, 8] });
    assert.ok(h.runUntil(() => u.skill.active, 1), `T${tier}: an enemy on the 4-4 casts it`);
    const tc = h.b.time;
    assert.equal(h.hooksOf('skillStart').at(-1).reason, 'SKILL_RANGE');
    h.runUntil(() => !u.skill.active, 6);
    approx(h.b.time - tc, sk.duration, `T${tier}: 4.2 s`, 0.06);
    const v2 = h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= tc - 1e-6);
    approx(v2[0].t - tc, CLIP.s2Begin + CLIP.s2LoopShot, `T${tier}: first volley 0.833 s in`, 0.04);
    done(h);
  }
});

test('S3 龙之箭: the arrow leaves 3.1 s after the cast (3.767 s for the first cast), flies straight ahead out of the field, hits every enemy on its way (air too, beyond her range) for ×240 % / 300 % physical then ×30 % / 40 % arts each 0.25 tile, pushes the light ones (中等力度) — not the off-line ones; no normal attack until its clip ends; her range stays', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, X]]) {
    const sk = skillOf(tier, elite, S3);
    const pw = tBb(tier, elite, mod, POWER).power_attack_scale;
    assert.deepEqual([sk.bb.atk_scale, sk.bb.atk_scale_magic, sk.bb.wait_duration, sk.bb.dist_interval, sk.bb.force, sk.bb.knockback_duration, sk.maxChargeTime],
      elite ? [3, 0.4, 1.5, 0.25, 1, 1, 2] : [2.4, 0.3, 1.5, 0.25, 1, 1, 1], `T${tier}`);
    const { h, u } = field({ tier, elite, mod, skill: 2, seed: 2, col: 2 });
    assert.deepEqual([u.skill.kind, u.skill.rule], [elite ? 'charges' : 'instant', 'DEFAULT']);
    const light = h.spawn('enemy_dummy', { pos: [10, 3] });
    const heavy = h.spawn('enemy_heavy', { pos: [10, 6] }); // outside her 3-6 range
    const fly = h.spawn('enemy_fly', { pos: [10, 8] });
    const off = h.spawn('enemy_dummy', { pos: [11, 6] });
    u.skill.gainSp(999);
    assert.ok(h.runUntil(() => u.skill.active, 2));
    const tc = h.b.time, n0 = mine(h, u).length;
    assert.deepEqual(u.liveRangeGrid, formOf(tier, elite).rangeGrid, `T${tier}: range unchanged`);
    const shot = tc + CLIP.s3BeginFirst + sk.bb.wait_duration + CLIP.s3EndShot;
    h.run(shot - tc + 2);
    const arrow = mine(h, u).slice(n0).filter((c) => c.dmg.tags?.includes('orchd2:arrow'));
    approx(Math.min(...arrow.map((c) => c.t)), shot + 1 / 30, `T${tier}: shot at +3.767 s (first cast; the tile next to her is reached the tick after)`, 0.04);
    for (const e of [light, heavy, fly]) {
      const on = arrow.filter((c) => c.target === e);
      const ph = on.filter((c) => c.type === 'phys'), ar = on.filter((c) => c.type === 'arts');
      assert.ok(ph.length >= 4 && ph.length === ar.length, `T${tier}: ${e.defId}: ${ph.length} strikes`);
      for (const c of ph) approx(c.amount, u.base.atk * sk.bb.atk_scale * pw, `T${tier}: physical`);
      for (const c of ar) approx(c.amount, u.base.atk * sk.bb.atk_scale_magic * pw, `T${tier}: arts`);
    }
    assert.equal(arrow.filter((c) => c.target === off).length, 0, `T${tier}: off the line, untouched`);
    approx(light.x, 3 + 2.14, `T${tier}: the light one pushed 2.14 tiles (中力 − weight 0)`, 0.02);
    assert.equal(heavy.x, 6, `T${tier}: weight 5 does not move`);
    const plain = h.hooksOf('attack').filter((c) => c.attacker === u && c.t > tc + 1e-6);
    assert.ok(plain.every((c) => c.t >= tc + CLIP.s3BeginFirst + sk.bb.wait_duration + CLIP.s3End - 0.04), `T${tier}: no normal attack inside the clip`);
    assert.ok(!u.skill.active, `T${tier}: the clip is over`);
    // a later cast: 3.1 s
    for (const e of [heavy, fly, off]) h.b.kill(e, null);
    h.b.relocate?.(light, 10, 3);
    light.x = 3; light.y = 10;
    u.skill.gainSp(999);
    const a0 = u.skill.activations;
    assert.ok(h.runUntil(() => u.skill.activations > a0, 5));
    const t2 = h.b.time, n1 = mine(h, u).length;
    h.run(4.5);
    const later = mine(h, u).slice(n1).filter((c) => c.dmg.tags?.includes('orchd2:arrow'));
    approx(later[0].t - t2, CLIP.s3Begin + sk.bb.wait_duration + CLIP.s3EndShot + 1 / 30, `T${tier}: shot at +3.1 s`, 0.04);
    done(h);
  }
  assert.deepEqual([ARROW.speed, ARROW.radius], [10, 0.5]);
});

test('T1 强击瓶专家: from the first cast of a deployment the next 50 attack rounds ×115 % (a 三连击 is one round), none before, none after; a redeploy starts over', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, X]]) {
    const pb = tBb(tier, elite, mod, POWER);
    assert.deepEqual([pb.power_attack_count, pb.power_attack_scale], [50, 1.15]);
    const { h, u } = field({ tier, elite, mod, skill: 0, seed: 1 });
    const cut = tBb(tier, elite, mod, 'attack@damage_scale')['attack@damage_scale'];
    u.skill.charges = 0; u.skill.sp = 0;
    h.b.addBuff(u, { key: 'test:noSp', flags: { noSp: true } });
    const e = h.spawn('enemy_dummy', { pos: [10, 7] });
    h.run(8);
    const before = rounds(mine(h, u));
    assert.ok(before.length >= 4 && before.every((g) => g.every((c) => Math.abs(c.amount - u.s.atk * cut) < 1e-6)), `T${tier}: no bonus before a cast`);
    u.skill.addCharge(1);
    assert.ok(h.runUntil(() => u.skill.activations === 1, 3));
    const n0 = mine(h, u).length;
    h.run(1.6 * 60);
    const after = rounds(mine(h, u).slice(n0));
    const boosted = after.filter((g) => g[0].amount > (g[0].dmg.isSkill ? u.s.atk * skillOf(tier, elite, S1).bb.atk_scale_1 : u.s.atk * cut) * 1.01);
    assert.equal(boosted.length, 50, `T${tier}: 50 rounds`);
    assert.ok(after.indexOf(boosted.at(-1)) === 49 && after.length > 51, `T${tier}: the first 50, then none`);
    assert.equal(u.mem.orchdPower, 0);
    h.b.retreat(u);
    h.b.redeploy(u);
    assert.equal(u.mem.orchdPower, 0, `T${tier}: a redeploy starts over`);
    assert.ok(e.alive);
    done(h);
  }
});

test('T2 翔虫机动: knocked out, she comes back after 70 − 15 s (ARC-X: −25 −15 / −18) on her tile with ATK +15 % (ARC-X stage 3: +20 %) for 30 s; never at the first deployment', () => {
  for (const f of [[5, false, null], [5, true, X], [6, true, X]]) {
    const [tier, elite, mod] = f;
    const wb = tBb(tier, elite, mod, 'atk_duration');
    assert.deepEqual([wb.atk, wb.atk_duration], [tier === 6 && mod === X ? 0.2 : 0.15, 30], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    assert.equal(u.findBuff('talent:orchd2:wirebug'), null, `${label(f)}: not at the first deployment`);
    h.b.players[0].dp = 999;
    const at = [u.tileR, u.tileC];
    h.b.kill(u, null);
    approx(u.respawnAt - u.deathAt, u.base.respawnTime, label(f));
    assert.ok(h.runUntil(() => u.alive, u.base.respawnTime + 1), `${label(f)}: back`);
    approx(h.b.time - u.deathAt, u.base.respawnTime, `${label(f)}: after ${u.base.respawnTime} s`, 0.05);
    assert.deepEqual([u.tileR, u.tileC], at, `${label(f)}: on her tile`);
    const b = u.findBuff('talent:orchd2:wirebug');
    assert.deepEqual(b?.mods, { atkPct: wb.atk }, label(f));
    approx(b.timeLeft, wb.atk_duration, label(f), 0.01);
    approx(u.s.atk, u.base.atk * (1 + wb.atk), label(f));
    h.run(31);
    assert.equal(u.findBuff('talent:orchd2:wirebug'), null, `${label(f)}: gone after 30 s`);
    done(h);
  }
});
