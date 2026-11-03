// test/content/op_yato2.test.js — the 自选 operator kit of 麒麟R夜刀 (char_1029_yato2, 6★ 处决者, a collab pick: diy.excluded;
// kit server/sim/content/kits/ops/op-yato2.js), fielded the production way (a DIY slot + its `diy` pick) in every form:
// tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module, EXE-X 训练用木桩 or
// EXE-Y 罗德岛制式双刀 at stage 1 (tier 5) / 3 (tier 6). Every number is read back from data/backups.json.
// Run: node --test test/content/op_yato2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';

const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));
const YATO = 'char_1029_yato2';
const FORMS = BACKUPS.units[YATO].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const EX = 'uniequip_002_yato2', EY = 'uniequip_003_yato2';
const S1 = 'skchr_yato2_1', S2 = 'skchr_yato2_2', S3 = 'skchr_yato2_3';
const YAK = 'chess_char_1_02_a';
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
const ENEMIES = { enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }) };
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, EX, EY].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

/** A battle with 麒麟R夜刀 as uid 1 at (row, col) facing RIGHT; every damage she deals logged with its time. */
function field({ tier = 5, elite = false, mod = null, skill = 0, row = 10, col = 3, others = [], seed = 7 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['skillStart', 'skillEnd'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: YATO, skillIndex: skill, uniEquipId: mod }, elite, row, col }, ...others],
  });
  const log = [];
  h.b.on('damaged', (c) => { if (c.source && c.source.uid === 1) log.push({ t: h.b.time, e: c.target, type: c.type, amount: c.amount, tags: c.dmg?.tags ?? [], id: c.dmg?.attackId, isAttack: !!c.dmg?.isAttack }); });
  h.step();
  return { h, u: h.unit(1), log };
}
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
const tagged = (log, tag) => log.filter((d) => d.tags.includes(tag));

test('麒麟R夜刀 in every 自选 form: her operator kit (all three skills authored), the form\'s stats + module attributes, 1-1 melee ground-only, 16 s redeploy, 协防 + 不屈; each skill a timed deployment skill (被动 ON_DEPLOY) running from the deployment', () => {
  assert.equal(OPERATOR_KITS[YATO], KITS[YATO]);
  assert.ok(KITTED_CHARS.includes(YATO));
  assert.ok(BACKUPS.diy.excluded.includes(YATO), 'a collab pick');
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null, rec = form.skills[skill];
      assert.deepEqual([u.def.charId, u.skill.id, !!u.kit.generic, u.kit.skillSource], [YATO, rec.skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.respawnTime],
        [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0), form.stats.respawnTime], `${label(f)}: stats`);
      assert.deepEqual([u.profile.attack, u.profile.dmgType, u.profile.canHitFly], ['melee', 'phys', false], `${label(f)}: 处决者`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 1-1`);
      assert.deepEqual(u.def.bonds, ['emptyShip', 'indomShip'], `${label(f)}: bonds`);
      assert.deepEqual([rec.skillType, rec.spType, u.skill.kind, u.skill.rule, u.skill.active, u.skill.activations], ['PASSIVE', 'ON_DEPLOY', 'duration', 'NEVER', true, 1], `${label(f)}: S${skill + 1} from the deployment`);
      done(h);
    }
  }
});

test('S1 鬼人化 (被动, 20 s): ASPD +45 / +70; every attack two hits, per target every third attack four hits and the next interval two more; T1 adds 20 % ATK arts on every hit; it ends at 20 s', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, EX]]) {
    const sk = skillOf(tier, elite, S1), t0 = talentOf(tier, elite, mod, 0);
    assert.deepEqual([sk.duration, sk.bb.attack_speed, t0['attack@atk_scale_1']], [20, elite ? 70 : 45, 0.2]);
    const { h, u, log } = field({ tier, elite, mod, skill: 0 });
    assert.equal(u.s.aspd, 100 + sk.bb.attack_speed, 'ASPD');
    h.spawn('enemy_dummy', { pos: [10, 4] });
    h.run(19.5);
    const phys = log.filter((d) => d.type === 'phys' && d.isAttack);
    const per = [];
    for (const d of phys) { if (!per.length || per[per.length - 1].id !== d.id) per.push({ id: d.id, n: 0 }); per[per.length - 1].n++; }
    const seq = per.map((p) => p.n);
    assert.ok(seq.length >= 12, `attacks: ${seq.length}`);
    for (let i = 0; i < seq.length; i++) assert.equal(seq[i], i % 4 === 2 ? 4 : 2, `attack ${i + 1}: ${seq.join(',')}`);
    const arts = tagged(log, 'yato2:t1');
    assert.equal(arts.length, phys.length, 'one T1 arts damage per hit');
    for (let i = 0; i < phys.length; i++) approx(arts[i].amount, phys[i].amount * t0['attack@atk_scale_1'], `T1 on hit ${i + 1}`);
    assert.ok(h.runUntil(() => !u.skill.active, 1), 'over at 20 s');
    approx(h.b.time, 20, 'ends at its duration', 0.01);
    const before = log.length;
    h.run(5);
    const after = log.slice(before).filter((d) => d.type === 'phys' && d.isAttack);
    const ids = new Set(after.map((d) => d.id));
    assert.equal(after.length, ids.size, 'single hits once it is over');
    done(h);
  }
});

test('S2 乱舞 (被动, 3.433 s): no normal attacks, 16 slashes at the skeleton\'s times on every ground enemy of her 1-1 at 116 % / 130 % ATK; T1 ×talent_scale (2.088 / 2.73); taunt level +1; 晕眩 refused until it ends', () => {
  const TIMES = [0.4, 1.067, 1.133, 1.4, 1.667, 1.933, 2, 2.2, 2.267, 2.633, 2.7, 2.767, 2.8, 2.867, 2.9, 2.967];
  for (const [tier, elite, mod] of [[5, false, null], [6, true, EY]]) {
    const sk = skillOf(tier, elite, S2), t0 = talentOf(tier, elite, mod, 0);
    assert.deepEqual([sk.bb.atk_scale, sk.bb.talent_scale, sk.bb.taunt_level], elite ? [1.3, 2.73, 1] : [1.16, 2.088, 1]);
    const { h, u, log } = field({ tier, elite, mod, skill: 1 });
    const t0s = h.b.time - h.b.dt;
    assert.equal(u.s.taunt, 1, 'taunt level +1');
    const front = h.spawn('enemy_dummy', { pos: [10, 4] }), far = h.spawn('enemy_dummy', { pos: [10, 5] }), fly = h.spawn('enemy_fly', { pos: [10, 4] });
    assert.equal(h.b.applyStatus(u, 'stun', { duration: 1 }), false, '晕眩 refused');
    h.run(3.3);
    const slashes = tagged(log, 'yato2:slash');
    assert.deepEqual([...new Set(slashes.map((d) => d.e))], [front], 'the ground enemy of her 1-1 only');
    assert.equal(slashes.length, 16, '16 slashes');
    // at the first tick at or after each OnAttack (ticks of 1/30 s)
    slashes.forEach((d, i) => assert.ok(d.t - t0s >= TIMES[i] - 0.034 && d.t - t0s <= TIMES[i] + 0.034 + 1e-9, `slash ${i + 1} time: ${d.t - t0s} vs ${TIMES[i]}`));
    assert.equal(log.filter((d) => d.type === 'phys' && !d.tags.includes('yato2:slash')).length, 0, 'no normal attack meanwhile');
    const arts = tagged(log, 'yato2:t1');
    assert.equal(arts.length, 16);
    // EXE-Y stage 3: 术法充盈 — each arts damage ×(1 + damage_up × the stacks before it), +1 stack after it (up to max)
    const mb = elite && mod === EY ? (modOf(tier, mod).talentChanges.find((t) => t.talentIndex === -1)?.bb ?? {}) : {};
    arts.forEach((d, i) => approx(d.amount, slashes[i].amount * t0['attack@atk_scale_1'] * sk.bb.talent_scale / sk.bb.atk_scale
      * (1 + (mb.damage_up ?? 0) * Math.min(i, mb.max_stack_cnt ?? 0)), `T1 on slash ${i + 1}`));
    assert.ok(far.alive && fly.alive);
    assert.ok(h.runUntil(() => !u.skill.active, 0.5), 'over');
    approx(h.b.time - t0s, 3.433, 'ends with the animation', 0.04);
    assert.equal(u.s.taunt, 0, 'taunt back');
    assert.equal(h.b.applyStatus(u, 'stun', { duration: 0.5 }), true, '晕眩 lands once it is over');
    done(h);
  }
});

test('S3 空中回旋乱舞 (被动): 无敌 + 不可阻挡 (block 0), 晕眩 refused; 1 s in the dash leaves her tile the way she faces at 8 tiles/s, slashing each enemy within 0.51 once (air too) at 230 % / 260 % ATK + T1 ×atk_scale, every slash +0.3 tiles from 2 up to 5; she stays; it ends 0.667 s after the dash', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, EX]]) {
    const sk = skillOf(tier, elite, S3), t0 = talentOf(tier, elite, mod, 0);
    assert.deepEqual([sk.bb.atk_scale, sk.bb.min_dist, sk.bb.max_dist, sk.bb.dist_unit], [elite ? 2.6 : 2.3, 2, 5, 0.3]);
    const { h, u, log } = field({ tier, elite, mod, skill: 2 });
    const t0s = h.b.time - h.b.dt;
    assert.deepEqual([!!u.s.flags.invulnerable, !!u.s.flags.untargetable, u.s.blockCnt], [true, true, 0], '无敌, 不可阻挡');
    assert.equal(h.b.applyStatus(u, 'stun', { duration: 1, force: true }), false, '晕眩 refused');
    // 1 tile: reach 2.3; 2 tiles: 2.6; the flyer 3 tiles ahead (≥ 2.49 needed): 2.9; 4 tiles ahead (≥ 3.49): out of reach
    const a = h.spawn('enemy_dummy', { pos: [10, 4] }), b = h.spawn('enemy_dummy', { pos: [10, 5] }), c = h.spawn('enemy_fly', { pos: [10, 6] });
    const d = h.spawn('enemy_dummy', { pos: [10, 7] }), side = h.spawn('enemy_dummy', { pos: [9, 5] });
    h.run(0.9);
    assert.equal(tagged(log, 'yato2:dash').length, 0, 'nothing before 1 s');
    assert.ok(h.runUntil(() => !u.skill.active, 3), 'over');
    const dash = tagged(log, 'yato2:dash');
    assert.deepEqual(dash.map((x) => x.e), [a, b, c], 'in order, each once; out of reach / off the line untouched');
    assert.ok(!dash.some((x) => x.e === d || x.e === side));
    for (const x of dash) {
      const arts = log.find((y) => y.e === x.e && y.tags.includes('yato2:t1'));
      approx(arts.amount, x.amount * t0['attack@atk_scale_1'], 'T1 ×atk_scale (= the slash × 0.2)');
    }
    const t1 = talentOf(tier, elite, mod, 1);
    approx(dash[0].amount, u.base.atk * (1 + t1.atk + (t1['yato2_e_002[atk].atk'] ?? 0)) * sk.bb.atk_scale, 'the slash (T2 on)');
    const end = h.b.time - t0s;
    approx(end, 1 + 2.9 / 8 + 0.667, 'the end', 0.08);
    assert.deepEqual([u.tileR, u.tileC], [10, 3], 'she stays on her tile');
    assert.deepEqual([!!u.s.flags.invulnerable, u.s.blockCnt], [false, 1], 'all back');
    done(h);
  }
  // the reach grows to 5 and no further: 4 on the first tile ahead, 3 on the second, then one per tile
  const { h, u, log } = field({ tier: 6, elite: true, skill: 2 });
  const rows = [[10, 4], [10, 4], [10, 4], [10, 4], [10, 5], [10, 5], [10, 5], [10, 6], [10, 7], [10, 8], [10, 9]];
  const es = rows.map((p) => h.spawn('enemy_dummy', { pos: p }));
  assert.ok(h.runUntil(() => !u.skill.active, 4));
  const hit = new Set(tagged(log, 'yato2:dash').map((x) => x.e));
  assert.deepEqual(es.map((e) => hit.has(e)), [true, true, true, true, true, true, true, true, true, true, false], 'col 8 (5 tiles) is the last');
  done(h);
});

test('T2 鬼人强化状态: ATK +16 % while her skill runs and 10 s after (EXE-X stage 3: +18 %, +5 % more while it runs)', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, EX]]) {
    const t1 = talentOf(tier, elite, mod, 1);
    const extra = t1['yato2_e_002[atk].atk'] ?? 0;
    assert.deepEqual([t1.atk, t1.duration, extra], elite ? [0.18, 10, 0.05] : [0.16, 10, 0]);
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    approx(u.s.atk, u.base.atk * (1 + t1.atk + extra), 'during the skill');
    h.run(20.2);
    assert.ok(!u.skill.active);
    approx(u.s.atk, u.base.atk * (1 + t1.atk), 'after it');
    h.run(10);
    approx(u.s.atk, u.base.atk, 'gone 10 s later');
    done(h);
  }
});

test('EXE-Y 罗德岛制式双刀: ATK +10 % while no allied operator stands beside her; stage 3: T1 25 % and 术法充盈, and the first leave of the battle redeploys at once', () => {
  const { h, u } = field({ tier: 6, elite: true, mod: EY, skill: 0, others: [{ uid: 2, chessId: YAK, row: 11, col: 3 }] });
  const t1 = talentOf(6, true, EY, 1);
  approx(u.s.atk, u.base.atk * (1 + t1.atk), 'an operator beside her: no lonely ATK');
  const yak = h.unit(2);
  h.b.kill(yak, null);
  h.step();
  approx(u.s.atk, u.base.atk * (1 + t1.atk + 0.1), 'alone: +10 %');
  assert.equal(talentOf(6, true, EY, 0)['attack@atk_scale_1'], 0.25);
  h.b.kill(u, null);
  approx(u.respawnAt, h.b.time, 'the first leave: redeploy time 0');
  assert.ok(h.b.redeploy(u, { free: true }), 'back');
  h.b.kill(u, null);
  approx(u.respawnAt - h.b.time, u.base.respawnTime, 'the second: its redeploy time');
  done(h);
});
