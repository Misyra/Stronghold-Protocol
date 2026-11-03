// test/content/op_orchd2.test.js — the 自选 operator kit of 焰狐龙梓兰 (char_1048_orchd2, 6★ 重射手, a collab pick: diy.excluded;
// kit server/sim/content/kits/ops/op-orchd2.js), fielded the production way (a DIY slot + its `diy` pick) in every form:
// tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module or ARC-X 梓兰特制箭靶 at
// stage 1 (tier 5) / 3 (tier 6). Every number is read back from data/backups.json.
// Run: node --test test/content/op_orchd2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const ORCHID = 'char_1048_orchd2';
const FORMS = BACKUPS.units[ORCHID].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const AX = 'uniequip_002_orchd2';
const S1 = 'skchr_orchd2_1', S2 = 'skchr_orchd2_2', S3 = 'skchr_orchd2_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
const talentOf = (tier, elite, mod, i) => {
  const base = formOf(tier, elite).talents.find((t) => t.index === i)?.bb ?? {};
  const ch = (elite ? modOf(tier, mod)?.talentChanges ?? [] : []).find((t) => t.talentIndex === i)?.bb ?? {};
  return { ...base, ...ch };
};
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = { enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }), enemy_heavy: dummy('enemy_heavy', { mass: 1 }) };
const FORMS_ALL = [[5, false, null], [6, false, null], [5, true, null], [5, true, AX], [6, true, null], [6, true, AX]];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

/** A battle with 焰狐龙梓兰 as uid 1 at (row, col) facing RIGHT; every damage she deals logged with its time. */
function field({ tier = 5, elite = false, mod = null, skill = 0, row = 10, col = 3, seed = 9, opCooldown } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999, ...(opCooldown != null ? { startOpCooldown: opCooldown } : {}) }, hooks: ['skillStart', 'skillEnd'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ORCHID, skillIndex: skill, uniEquipId: mod }, elite, row, col }],
  });
  const log = [], stuns = [];
  h.b.on('damaged', (c) => { if (c.source && c.source.uid === 1) log.push({ t: h.b.time, e: c.target, type: c.type, amount: c.amount, tags: c.dmg?.tags ?? [], id: c.dmg?.attackId, isAttack: !!c.dmg?.isAttack }); });
  h.b.on('statusApplied', (c) => { if (c.status === 'stun' && c.source?.uid === 1) stuns.push({ t: h.b.time, e: c.target }); });
  h.step();
  return { h, u: h.unit(1), log, stuns };
}
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
const tagged = (log, tag) => log.filter((d) => d.tags.includes(tag));

test('焰狐龙梓兰 in every 自选 form: her operator kit (all three skills authored), stats + module attributes, redeploy time −15 s (ARC-X stage 3 −18 s, its stat −25 s), 3-6 ranged physical anti-air, 协防 + 精准', () => {
  assert.equal(OPERATOR_KITS[ORCHID], KITS[ORCHID]);
  assert.ok(KITTED_CHARS.includes(ORCHID));
  assert.ok(BACKUPS.diy.excluded.includes(ORCHID), 'a collab pick');
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null, rec = form.skills[skill];
      assert.deepEqual([u.def.charId, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ORCHID, rec.skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def], [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0)], `${label(f)}: stats`);
      assert.equal(u.base.respawnTime, form.stats.respawnTime + (m?.attr.respawnTime ?? 0) + talentOf(tier, elite, mod, 3).respawn_time, `${label(f)}: redeploy time`);
      assert.deepEqual([u.profile.attack, u.profile.dmgType, u.profile.canHitFly], ['ranged', 'phys', true], `${label(f)}: 重射手`);
      assert.deepEqual(u.def.bonds, ['emptyShip', 'preciShip'], `${label(f)}: bonds`);
      assert.deepEqual([u.skill.kind, u.skill.maxCharges, u.skill.rule], ['duration', rec.maxChargeTime, rec.trigger.rule], `${label(f)}: S${skill + 1}`);
      done(h);
    }
  }
  assert.deepEqual([talentOf(5, false, null, 3).respawn_time, talentOf(6, true, AX, 3).respawn_time], [-15, -18]);
});

test('normal attack: three hits of 100 % ATK, each ×0.333 after DEF (PRTS 分支备注); T1 not armed before her first skill', () => {
  const { h, u, log } = field({ tier: 5, skill: 2 });   // S3 at rank 4 waits for 27 SP: 9 s of normal attacks
  const t2 = talentOf(5, false, null, 2);
  assert.deepEqual([t2['attack@atk_scale'], t2['attack@damage_scale']], [1, 0.333]);
  h.spawn('enemy_dummy', { pos: [10, 5] });
  h.run(8);
  assert.equal(u.skill.activations, 0);
  const hits = log.filter((d) => d.isAttack && d.type === 'phys');
  const ids = [...new Set(hits.map((d) => d.id))];
  assert.ok(ids.length >= 4, `attacks: ${ids.length}`);
  for (const id of ids) assert.equal(hits.filter((d) => d.id === id).length, 3, 'three hits');
  for (const d of hits) approx(d.amount, u.s.atk * 0.333, 'each ×0.333');
  assert.equal(u.mem.orchdPower ?? null, null, 'not armed');
  done(h);
});

test('S1 刚射 (charges): 4 arrows of 100 % / 120 % ATK; with one more charge at once 5 more of 140 % / 160 % (晕眩 2 s, 20 %), spending two charges; the first skill of a deployment arms T1 (50 uses at ×1.15 / ×1.2), the cast itself one use', () => {
  const { h, u, log, stuns } = field({ tier: 6, elite: true, skill: 0, opCooldown: 0 });
  const sk = skillOf(6, true, S1), t0 = talentOf(6, true, null, 0);
  assert.deepEqual([sk.spCost, sk.initSp, sk.maxChargeTime, sk.bb.atk_scale_1, sk.bb.atk_scale_2, sk.bb.stun_prob, sk.bb.stun], [5, 10, 3, 1.2, 1.6, 0.2, 2]);
  assert.deepEqual([t0.power_attack_count, t0.power_attack_scale], [50, 1.2]);
  assert.equal(u.skill.charges, 2, 'two charges from its initial SP');
  const e = h.spawn('enemy_dummy', { pos: [10, 4] });
  assert.ok(h.runUntil(() => u.skill.active, 3), 'cast');
  assert.equal(u.skill.charges, 0, '刚连射: both charges spent');
  assert.equal(u.mem.orchdPower.left, 49, 'armed, the cast one use');
  assert.ok(h.runUntil(() => !u.skill.active, 5), 'over');
  const s1 = tagged(log, 'orchd2:s1');
  assert.equal(s1.length, 9, '4 + 5 arrows');
  const atk = u.s.atk;
  for (const d of s1.slice(0, 4)) approx(d.amount, atk * 1.2 * 1.2, '4 arrows ×atk_scale_1 ×power');
  for (const d of s1.slice(4)) approx(d.amount, atk * 1.6 * 1.2, '5 arrows ×atk_scale_2 ×power');
  assert.ok(s1.slice(4)[0].t - s1[0].t > 1, 'the second volley 1.166 s after the first');
  assert.ok(stuns.every((s) => s.e === e && s.t >= s1[4].t - 1e-9), 'stun only from 刚连射');
  // the next normal attack: ×1.2, one use
  const n0 = log.length;
  assert.ok(h.runUntil(() => log.slice(n0).some((d) => d.isAttack && !d.tags.includes('orchd2:s1')), 3));
  approx(log.slice(n0).find((d) => d.isAttack && !d.tags.includes('orchd2:s1')).amount, u.s.atk * 1.2 * 0.333, 'normal attack ×power');
  done(h);
});

test('S1 刚射: a volley with no target left ends the skill and gives one charge back', () => {
  const { h, u } = field({ tier: 6, elite: true, skill: 0, opCooldown: 0 });
  const e = h.spawn('enemy_dummy', { pos: [10, 4] });
  assert.ok(h.runUntil(() => u.skill.active, 3));
  const c0 = u.skill.charges;
  h.b.kill(e, null);
  assert.ok(h.runUntil(() => !u.skill.active, 3), 'over');
  assert.equal(u.skill.charges, c0 + 1, 'one charge back');
  done(h);
});

test('S2 飞翔瞪射 (charges, SKILL_RANGE): cast free at every deployment; 起飞 for the skill; 3 / 4 / 5 shots of 135 % / 150 % on every enemy of the 4-4 (air too), then the landing 255 % / 270 % on her 1-3; each round and the landing one T1 use', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const sk = skillOf(tier, elite, S2);
    const { h, u, log } = field({ tier, elite, skill: 1 });
    assert.deepEqual([u.skill.active, u.skill.activations, u.skill.charges, !!u.s.flags.liftoff], [true, 1, Math.floor(sk.initSp / sk.spCost), true], 'free at the deployment, 起飞');
    let normals = 0;   // normal attacks loosed (each one T1 use, its arrows landing later)
    h.b.on('beforeAttack', (c) => { if (c.attacker === u) normals++; });
    const front = h.spawn('enemy_dummy', { pos: [10, 4] }), diag = h.spawn('enemy_dummy', { pos: [11, 4] });
    const in1 = h.spawn('enemy_dummy', { pos: [10, 5] }), in2 = h.spawn('enemy_fly', { pos: [9, 7] }), out = h.spawn('enemy_dummy', { pos: [10, 8] });
    assert.ok(h.runUntil(() => !u.skill.active, 6), 'over');
    approx(h.b.time, 1.5 + 3 * 0.833 + 1, 'the first cast of a deployment: Begin_First + 3 rounds + the landing', 0.02);
    const shots = tagged(log, 'orchd2:s2');
    for (const e of [in1, in2]) {
      const mine = shots.filter((d) => d.e === e);
      assert.equal(mine.length, 12, '3 + 4 + 5 shots');
      for (const d of mine) approx(d.amount, u.s.atk * sk.bb['attack@atk_scale_loop'] * 1.2, 'atk_scale_loop × power');
    }
    assert.ok(!shots.some((d) => d.e === front || d.e === diag || d.e === out), 'only the 4-4');
    const land = tagged(log, 'orchd2:landing');
    assert.deepEqual(new Set(land.map((d) => d.e)), new Set([front, diag]), 'the landing on her 1-3');
    for (const d of land) approx(d.amount, u.s.atk * sk.bb['attack@atk_scale_end'] * 1.2, 'atk_scale_end × power');
    assert.equal(u.mem.orchdPower.left, 50 - 4 - normals, 'three rounds + the landing (+ a normal attack loosed right after it)');
    assert.equal(!!u.s.flags.liftoff, false, 'landed');
    // a redeployment casts it again, free
    h.b.kill(u, null);
    assert.ok(h.b.redeploy(u, { free: true }));
    assert.deepEqual([u.skill.active, u.skill.activations], [true, 2], 'again at the redeployment');
    done(h);
  }
});

test('S3 龙之箭 (charges): Skill_3_Begin(_First) + 1.5 s + 0.1 s, then the arrow straight ahead at 10 tiles/s, every frame on each enemy within 0.5 (air too): 240 % / 300 % of the launch ATK physical, then 30 % / 40 % arts, ×T1; pushed forward (中等力度), once a second per enemy', () => {
  for (const [tier, elite] of [[6, true]]) {
    const sk = skillOf(tier, elite, S3);
    assert.deepEqual([sk.spCost, sk.initSp, sk.maxChargeTime, sk.bb.atk_scale, sk.bb.atk_scale_magic, sk.bb.wait_duration, sk.bb.force, sk.bb.knockback_duration], [25, 20, 2, 3, 0.4, 1.5, 1, 1]);
    const { h, u, log } = field({ tier, elite, skill: 2, opCooldown: 0 });
    const a = h.spawn('enemy_heavy', { pos: [10, 5] }), f = h.spawn('enemy_fly', { pos: [10, 7] }), side = h.spawn('enemy_dummy', { pos: [9, 5] });
    const x0 = a.x;
    assert.ok(h.runUntil(() => u.skill.active, 8), 'cast');
    const t0 = h.b.time - h.b.dt, atk = u.s.atk;
    assert.ok(h.runUntil(() => tagged(log, 'orchd2:dragon').length > 0, 5), 'the arrow strikes');
    const first = tagged(log, 'orchd2:dragon')[0];
    assert.ok(first.t - t0 >= 2.167 + 1.5 + 0.1 - 1e-6, `fired after Begin_First + wait + 0.1 s: ${first.t - t0}`);
    h.run(3);
    const dr = tagged(log, 'orchd2:dragon');
    const physA = dr.filter((d) => d.e === a && d.type === 'phys'), artsA = dr.filter((d) => d.e === a && d.type === 'arts');
    assert.ok(physA.length >= 2 && artsA.length === physA.length, `hits on it: ${physA.length}`);
    for (const d of physA) approx(d.amount, atk * sk.bb.atk_scale * 1.2, 'physical × launch ATK × power');
    for (const d of artsA) approx(d.amount, atk * sk.bb.atk_scale_magic * 1.2, 'arts × launch ATK × power');
    assert.ok(dr.some((d) => d.e === f), 'air too');
    assert.ok(!dr.some((d) => d.e === side), 'off its line: untouched');
    assert.ok(a.x > x0 + 0.1, `pushed forward: ${x0} → ${a.x}`);
    done(h);
  }
});

test('T2 翔虫机动: no ATK at the first deployment; a redeployment (on her tile, inside the arrow she left) ATK +15 % (ARC-X stage 3 +20 %) for 30 s', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, AX]]) {
    const t1 = talentOf(tier, elite, mod, 1);
    assert.deepEqual([t1.atk, t1.atk_duration], [elite ? 0.2 : 0.15, 30]);
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    approx(u.s.atk, u.base.atk, 'first deployment: none');
    h.b.kill(u, null);
    assert.ok(h.b.redeploy(u, { free: true }));
    approx(u.s.atk, u.base.atk * (1 + t1.atk), 'redeployed');
    h.run(30.2);
    approx(u.s.atk, u.base.atk, '30 s later');
    done(h);
  }
});
