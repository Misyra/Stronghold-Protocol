// server/sim/content/kits/ops/op-orchd2.js — 焰狐龙梓兰 (char_1048_orchd2) 自选 operator kit: 6★ 重射手 (狙击), a collab pick of
// the tier-5 and tier-6 自选 slots (data/backups.json diy.excluded: offered only in a room with 联动干员 on); every skill, the
// talents (with the two hidden ones), the trait and the module (ARC-X 梓兰特制箭靶) at every form. Kit contract and the 自选
// rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_1048_orchd2): normal = E2 Lv1, skills at rank 4, no module; elite = E2 Lv60, rank 7,
// the module at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of 2026-10-07). Sources:
// character_table / skill_table / battle_equip_table (zh_CN, as built into backups.json); PRTS 焰狐龙梓兰 (分支 备注 "普通攻击为
// 三连击，每击造成攻击力100%的物理伤害…若为普通攻击的伤害，则使该伤害降低至33.3%"; 强击瓶专家 备注 "天赋启动后，每轮普通攻击三连击、
// 每轮技能三/四/五连击、每次二技能的降落攻击、每次三技能的龙之箭都会消耗一层攻击力提升效果的层数" / "攻击力提升效果为攻击力倍率提升…"
// / "首次开启技能时…采用不同的技能开启动画"; 翔虫机动 备注 "离场后将在原地留下一个静止弹道…部署于该弹道范围后将获得攻击力加成效果"; 刚射 备注
// "若在已有2次充能所需技力的情况下触发技能…会消耗2次充能所需的技力来释放技能；在这种情况下，如果自身发动刚连射时找不到目标，将立刻终止
// 技能并返还与1次充能等额的技力"; 飞翔瞪射 备注 "部署后的“立即释放”可以无视技力开启技能；每次部署后首次开启此技能时焰狐龙梓兰不会消耗技力"
// / "技能期间发动的三轮攻击的时间模式均为跟随动画…（不受攻击速度影响）"; 龙之箭 备注 "“蓄力3秒后”实为从技能开启动画播放完毕后开始1.5秒
// 蓄力计时…首次开启时将需要约110帧（≈3.67秒）、非首次开启需要约90帧（≈3秒）才能开始发射龙之箭，随后约3帧（0.1秒）后产生弹道" / "…向自身
// 正前方发射持续存在30秒的龙之箭弹道：其具有10格/秒…的飞行速度与0.5的碰撞半径，每帧判定一次碰撞，推动效果对每个敌人具有1秒的冷却" /
// "先造成物理伤害，后造成法术伤害" / "该技能为固定方向推动，不会因为角度过大而改变推动的方向或削减力度"); the client's battle data —
// charpack char_1048_orchd2 (DefaultMode attack projectile_chr_orchd2_attack, modifier normal_attack; Talents 1 / 2 / 3;
// modes S2_FlyStart / S2_FlyLoop (Attack1–3: `_additionalTimes` 2 / 3 / 4, `_triggerDelta` 0.1, no target limit,
// atk_scale_loop, use_power each) / S2_FlyEnd (atk_scale_end on range 1-3, use_power)), the skill prefabs skchr_orchd2_1
// (Begin / Begin_First, then End_2 when one more charge's SP is there — Skill_1_End_2: projectile_chr_orchd2_s1 × atk_scale_1,
// then projectile_chr_orchd2_s1_2 × atk_scale_2 with orchd2_s_1[stun_creator] on that last volley and orchd2_s_1[reduce_sp]
// — else End_1: projectile_chr_orchd2_s1; use_power once a cast) / skchr_orchd2_2 (orchd2_s_2[duration], ExtraAbility
// orchd2_s_2[auto_once]) / skchr_orchd2_3 (Begin / Begin_First, Wait `wait_duration`, Attack Skill_3_End firing
// projectile_chr_orchd2_s3 with orchd2_s_3[knockback] for knockback_duration s, use_power), the projectiles (s1 / s1_2 /
// attack: speed 15, one hit; s3: speed 10, `_canHitSameTargetMultipleTimes`, `_hitPasserby`, life 30 s, distance interval
// 0.25, the ATK cached at launch, physical then MAGICAL atk_scale_magic `ADDITION`), the battle skeleton (Attack 1.6 s, hit
// 0.6; Skill_1_Begin 0.1 / _First 1 s; Skill_1_End_1 1.5 s, hit 0.667; Skill_1_End_2 2.667 s, hits 0.667 / 1.833;
// Skill_2_Begin 0.667 / _First 1.5 s; Skill_2_Loop_1–3 0.833 s, hit 0.167; Skill_2_End 1 s, hit 0.233; Skill_3_Begin 1.5 /
// _First 2.167 s; Skill_3_End 1.233 s, hit 0.1), buff_template_data (orchd2_s_1[damage_scale]: normal_attack ×damage_scale;
// orchd2_t_2[*]: the power — power_attack_count uses at power_attack_scale, created by the first skill of a deployment;
// orchd2_t_1_2[born]: deployed in its projectile's range ⇒ ATK +atk for atk_duration s; orchd2_s_2[fly_mode]: block mode FLY).
// - Trait (重射手) "高精度的近距离射击": ranged physical, her 3-6, can hit air (data). Hidden talent (index 2): every normal
//   attack is three hits of attack@atk_scale × ATK, each ×attack@damage_scale after DEF (hitDmgMul; PRTS).
// - T1 强击瓶专家: the first skill activation of a deployment arms power_attack_count uses at power_attack_scale (攻击倍率):
//   one per normal attack, per 刚射 cast, per 飞翔瞪射 round and landing, per 龙之箭; gone when she leaves the field.
// - T2 翔虫机动: redeploy time +respawn_time (hidden talent 3: −15 s; ARC-X stage 3 −18 s; the module's own −25 s is a stat);
//   "不提高部署费用" — no deployment cost in this mode; a redeployment (not the first deployment of the battle) is on her own
//   tile, inside the projectile she left there ⇒ ATK +atk for atk_duration s [ASSUMED: a 自选 piece always redeploys on its
//   tile]; "可以部署在近战位" concerns the first deployment's tile only ⇒ no effect.
// - S1 刚射 (MANUAL, charges, data trigger): the cast (Skill_1_Begin, the first of a deployment Skill_1_Begin_First) then
//   4 arrows of atk_scale_1 × ATK on its target; with one more charge spent at once (刚连射) 5 more arrows of atk_scale_2 ×
//   ATK, each 晕眩 stun s with stun_prob; arrows fly at 15 tiles/s and land on their target. No normal attacks meanwhile.
//   A volley with no target left in her range ends the skill and gives back one charge. "充能至最大层数时自动释放一次": the
//   mode's 技能策略 already casts it whenever it is ready [ASSUMED: no further effect].
// - S2 飞翔瞪射 (MANUAL, charges, data SKILL_RANGE on its 4-4): cast free at every deployment (orchd2_s_2[auto_once]); 起飞
//   for the skill (blocks no ground enemy, ground enemies cannot select her); three rounds of 3 / 4 / 5 shots 0.1 s apart,
//   each shot on every selectable enemy (ground or air) of the 4-4 at atk_scale_loop × ATK physical; then the landing:
//   atk_scale_end × ATK physical on every enemy of her 1-3. Timed by the animations (not by attack speed).
// - S3 龙之箭 (MANUAL, charges, data trigger): Skill_3_Begin (_First), wait_duration s, then Skill_3_End fires the arrow 0.1 s
//   in: straight ahead at 10 tiles/s for 30 s (until it leaves the map), every frame (its 0.25-tile interval is shorter)
//   striking each selectable enemy (ground or air) within 0.5 of it — atk_scale × the launch ATK physical, then
//   atk_scale_magic × it arts — and pushing it with force `force` the way she faces (fixed direction), once per
//   knockback_duration s per enemy. No normal attacks during the cast.

import { num, talentBb, skillRec } from '../shared/tier1.js';
import { absoluteRangeKeys, canTargetEnemy, sortEnemyTargets } from '../../../targeting.js';
import { TICK } from '../../../constants.js';

const S1 = 'skchr_orchd2_1';
const S2 = 'skchr_orchd2_2';
const S3 = 'skchr_orchd2_3';
/** PRTS 分支备注: a normal attack is three hits. */
const NORMAL_HITS = 3;
/** Battle skeleton timings (s). */
const S1_BEGIN = 0.1, S1_BEGIN_FIRST = 1, S1_END_1 = 1.5, S1_END_2 = 2.667, S1_VOLLEYS = Object.freeze([0.667, 1.833]);
const S2_BEGIN = 0.667, S2_BEGIN_FIRST = 1.5, S2_LOOP = 0.833, S2_LOOP_HIT = 0.167, S2_END = 1, S2_END_HIT = 0.233;
const S3_BEGIN = 1.5, S3_BEGIN_FIRST = 2.167, S3_END = 1.233, S3_FIRE = 0.1;
/** 飞翔瞪射's three rounds (prefab `_additionalTimes` 2 / 3 / 4) and their shots' spacing (`_triggerDelta`). */
const S2_SHOTS = Object.freeze([3, 4, 5]);
const S2_SHOT_GAP = 0.1;
/** 刚射's two volleys (PRTS / skill text): 4 arrows, then 刚连射's 5. */
const S1_ARROWS = Object.freeze([4, 5]);
const ARROW_SPEED = 15;
/** projectile_chr_orchd2_s3: 10 tiles/s, collider 0.5 (PRTS), 30 s. */
const DRAGON_SPEED = 10, DRAGON_RADIUS = 0.5, DRAGON_LIFE = 30;
/** 飞翔瞪射's landing: range 1-3 (S2_FlyEnd's selector). */
const LANDING = Object.freeze([[1, 1], [0, 0], [0, 1], [-1, 1]]);
const AIR = Object.freeze({ canHitFly: true });
const LIFTOFF = Object.freeze({ liftoff: true });

/** battle → the 龙之箭 in flight. */
const DRAGONS = new WeakMap();

/** T1: arm the power at the deployment's first skill; true when this was that first skill (its longer opening). */
function armPower(unit, t0) {
  if (unit.mem.orchdPower) return false;
  unit.mem.orchdPower = { left: Math.max(0, Math.floor(num(t0.power_attack_count))), scale: num(t0.power_attack_scale, 1) };
  return true;
}
/** T1: one use of the power — its scale, or 1 when spent / not armed. */
function usePower(unit) {
  const p = unit.mem.orchdPower;
  if (!p || p.left <= 0) return 1;
  p.left--;
  return p.scale;
}
/** The enemy a volley of hers aims at: the cast's target while selectable in her range, else the default order's first. */
function aimOf(battle, unit, prev) {
  const list = battle.enemiesInKeys(unit.rangeKeys || [], unit, unit.profile);
  if (prev && prev.alive && list.includes(prev)) return prev;
  if (!list.length) return null;
  sortEnemyTargets(battle, unit, list, unit.profile?.priority ?? null);
  return list[0];
}

function stepDragons(battle) {
  const list = DRAGONS.get(battle);
  if (!list || !list.length) return;
  const R = battle.grid.rect, dt = battle.dt > 0 ? battle.dt : TICK;
  for (const a of list) {
    if (a.done) continue;
    a.age += dt;
    a.travel += DRAGON_SPEED * dt;
    const x = a.sx + a.vx * a.travel, y = a.sy + a.vy * a.travel;
    // 30 s, or until it leaves the map (nothing to strike past its edge)
    if (a.age >= DRAGON_LIFE || x < R.c0 - 1 || y < R.r0 - 1 || x > R.c1 + 1 || y > R.r1 + 1) { a.done = true; continue; }
    const u = a.unit;
    for (const e of battle.foesInColliderRadius(x, y, DRAGON_RADIUS)) {
      if (!e.alive || !canTargetEnemy(u, e, AIR)) continue;
      battle.dealDamage(u, e, { amount: a.atk * a.phys, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', 'orchd2:dragon'] });
      if (e.alive && a.arts > 0) battle.dealDamage(u, e, { amount: a.atk * a.arts, type: 'arts', isSkill: true, tags: ['skill', 'orchd2:dragon', 'addition'] });
      const last = a.fxAt.get(e);
      if (last == null || battle.time - last >= 0.25 - 1e-9) { a.fxAt.set(e, battle.time); battle.fx('strike', { x: e.x, y: e.y, id: u.id, target: e.id }); }
      const pushed = a.pushAt.get(e);
      if (e.alive && a.force != null && (pushed == null || battle.time - pushed >= a.cool - 1e-9)) {
        a.pushAt.set(e, battle.time);
        battle.push(e, a.force, { from: { x, y }, dir: { x: a.vx, y: a.vy }, fixed: true });
      }
    }
  }
  if (list.every((a) => a.done)) list.length = 0;
}

export default {
  char_1048_orchd2: (bb, chess) => {
    const t0 = talentBb(chess, 0);   // 强击瓶专家
    const t1 = talentBb(chess, 1);   // 翔虫机动 (ARC-X stage 3: +20 %)
    const t2 = talentBb(chess, 2);   // hidden: the normal attack's attack@atk_scale / attack@damage_scale
    const t3 = talentBb(chess, 3);   // hidden: respawn_time (−15; ARC-X stage 3 −18)
    const r1 = skillRec(chess, S1), r2 = skillRec(chess, S2), r3 = skillRec(chess, S3);
    const b1 = r1?.bb ?? {}, b2 = r2?.bb ?? {}, b3 = r3?.bb ?? {};
    const s2Grid = Array.isArray(r2?.rangeGrid) && r2.rangeGrid.length ? r2.rangeGrid.map((p) => [p[0], p[1]]) : [[1, 2], [1, 3], [1, 4], [0, 2], [0, 3], [0, 4], [-1, 2], [-1, 3], [-1, 4]];
    const keysOf = (unit, grid) => absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);

    // ---- S1 刚射 -------------------------------------------------------------------------------------------------------
    const volley = (battle, unit, m, k) => {
      const t = aimOf(battle, unit, m.target);
      if (!t) return false;
      m.target = t;
      const n = S1_ARROWS[k], scale = num(k === 0 ? b1.atk_scale_1 : b1.atk_scale_2, 1) * m.power;
      const stunP = k === 1 ? num(b1.stun_prob) : 0, stun = num(b1.stun);
      battle.fx('volley', { x: unit.x, y: unit.y, tx: t.x, ty: t.y, id: unit.id, target: t.id, n });
      for (let i = 0; i < n; i++) { // loop-cap: S1_ARROWS (≤ 5)
        battle.addProjectile({ from: unit, target: t, speed: ARROW_SPEED, visual: 'none', source: unit,
          onHit: (c) => {
            const e = c.target;
            if (!e || !e.alive) return;
            battle.dealDamage(unit, e, { amount: unit.s.atk * scale, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', 'orchd2:s1'] });
            if (e.alive && stunP > 0 && stun > 0 && (stunP >= 1 || battle.rng() < stunP)) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
          } });
      }
      return true;
    };

    // ---- S2 飞翔瞪射 ---------------------------------------------------------------------------------------------------
    const s2Shot = (battle, unit, scale) => {
      for (const e of battle.enemiesInKeys(keysOf(unit, s2Grid), unit, AIR)) {
        if (!e.alive) continue;
        battle.dealDamage(unit, e, { amount: unit.s.atk * scale, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', 'orchd2:s2'] });
        battle.fx('strike', { x: e.x, y: e.y, id: unit.id, target: e.id });
      }
    };
    const s2Land = (battle, unit, scale) => {
      const keys = keysOf(unit, LANDING);
      for (const e of battle.enemiesInKeys(keys, unit, AIR)) {
        if (e.alive) battle.dealDamage(unit, e, { amount: unit.s.atk * scale, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', 'orchd2:landing'] });
      }
      battle.fx('aoe', { x: unit.x + (unit.fwd?.[1] ?? 1) * 0.5, y: unit.y + (unit.fwd?.[0] ?? 0) * 0.5, radius: 1, id: unit.id, skill: 'orchd2_2' });
    };

    return {
      skills: {
        [S1]: {
          kind: 'duration', duration: S1_BEGIN + S1_END_1, attack: { noAttack: true },
          onStart({ battle, unit, skill }) {
            const first = armPower(unit, t0);
            // 刚连射: one more charge there ⇒ spent at once (orchd2_s_1[reduce_sp])
            const two = skill.charges >= 1;
            if (two) skill.charges--;
            const begin = first ? S1_BEGIN_FIRST : S1_BEGIN;
            unit.mem.orchdS1 = { start: battle.time, begin, two, k: 0, target: aimOf(battle, unit, null), power: usePower(unit) };
            skill.timeLeft = begin + (two ? S1_END_2 : S1_END_1);
          },
          onTick({ battle, unit, skill }) {
            const m = unit.mem.orchdS1;
            if (!m || !unit.canAct) return;
            const n = m.two ? 2 : 1;
            if (m.k >= n || battle.time - m.start + 1e-9 < m.begin + S1_VOLLEYS[m.k]) return;
            const k = m.k++;
            if (!volley(battle, unit, m, k)) {
              // no target left: the skill ends and one charge comes back (PRTS 备注; orchd2_s_1[recover_sp_checker])
              unit.mem.orchdS1 = null;
              skill.end('noTarget');
              skill.addCharge(1);
            }
          },
          onEnd({ unit }) { unit.mem.orchdS1 = null; },
        },
        [S2]: {
          kind: 'duration', duration: S2_BEGIN + 3 * S2_LOOP + S2_END, flags: LIFTOFF, attack: { noAttack: true },
          onStart({ battle, unit, skill }) {
            const first = armPower(unit, t0);
            const begin = first ? S2_BEGIN_FIRST : S2_BEGIN;
            battle.releaseBlocked(unit);
            battle.fx('takeoff', { x: unit.x, y: unit.y, id: unit.id });
            const plan = [];
            for (let r = 0; r < S2_SHOTS.length; r++) {
              for (let j = 0; j < S2_SHOTS[r]; j++) plan.push({ at: begin + r * S2_LOOP + S2_LOOP_HIT + j * S2_SHOT_GAP, round: r, first: j === 0 });
            }
            plan.push({ at: begin + 3 * S2_LOOP + S2_END_HIT, land: true });
            unit.mem.orchdS2 = { start: battle.time, plan, i: 0, scale: 1 };
            skill.timeLeft = begin + 3 * S2_LOOP + S2_END;
          },
          onTick({ battle, unit }) {
            const m = unit.mem.orchdS2;
            if (!m) return;
            const t = battle.time - m.start + 1e-9;
            while (m.i < m.plan.length && m.plan[m.i].at <= t) { // loop-cap: the plan (3 + 4 + 5 shots + the landing)
              const p = m.plan[m.i++];
              if (p.land) { s2Land(battle, unit, num(b2['attack@atk_scale_end'], 1) * usePower(unit)); continue; }
              if (p.first) m.scale = num(b2['attack@atk_scale_loop'], 1) * usePower(unit);
              s2Shot(battle, unit, m.scale);
            }
          },
          onEnd({ unit }) { unit.mem.orchdS2 = null; },
        },
        [S3]: {
          kind: 'duration', duration: S3_BEGIN + num(b3.wait_duration, 1.5) + S3_END, attack: { noAttack: true },
          onStart({ battle, unit, skill }) {
            const first = armPower(unit, t0);
            const begin = first ? S3_BEGIN_FIRST : S3_BEGIN;
            unit.mem.orchdS3 = { fireAt: battle.time + begin + num(b3.wait_duration, 1.5) + S3_FIRE, fired: false };
            skill.timeLeft = begin + num(b3.wait_duration, 1.5) + S3_END;
          },
          onTick({ battle, unit }) {
            const m = unit.mem.orchdS3;
            if (!m || m.fired || battle.time + 1e-9 < m.fireAt) return;
            m.fired = true;
            const [dr, dc] = Array.isArray(unit.fwd) ? unit.fwd : [0, 1];
            const power = usePower(unit);
            const a = { unit, sx: unit.x, sy: unit.y, vx: dc, vy: dr, travel: 0, age: 0, done: false, atk: unit.s.atk,
              phys: num(b3.atk_scale, 1) * power, arts: num(b3.atk_scale_magic) * power,
              force: b3.force == null ? null : num(b3.force), cool: num(b3.knockback_duration, 1), pushAt: new Map(), fxAt: new Map() };
            DRAGONS.get(battle)?.push(a);
            const R = battle.grid.rect;
            const reach = Math.max(R.c1 - R.c0, R.r1 - R.r0) + 2;
            battle.fx('dash', { x: unit.x, y: unit.y, tx: unit.x + dc * reach, ty: unit.y + dr * reach, t: reach / DRAGON_SPEED, id: unit.id, flame: `${unit.id}:${battle.time.toFixed(3)}` });
          },
          onEnd({ unit }) { unit.mem.orchdS3 = null; },
        },
      },
      // hidden talent: a normal attack is NORMAL_HITS hits of attack@atk_scale × ATK, each ×attack@damage_scale after DEF;
      // T1's power scales it (攻击倍率) — the use is taken in beforeAttack below
      trait: {
        hits: NORMAL_HITS, hitDmgMul: num(t2['attack@damage_scale'], 1),
        dmgMul: (b, u) => num(t2['attack@atk_scale'], 1) * (u.mem.orchdShot ?? 1),
      },
      talents: [
        { install(battle, unit) { // 强击瓶专家: armed by the first skill of each deployment (the skills' onStart), gone with it
          battle.on('deploy', (c) => { if (c.unit === unit && !c.move) { unit.mem.orchdPower = null; unit.mem.orchdShot = 1; } }, { owner: unit, priority: 10 });
          battle.on('beforeAttack', (c) => { if (c.attacker === unit) unit.mem.orchdShot = usePower(unit); }, { owner: unit });
        } },
        { install(battle, unit) { // 翔虫机动
          if (!unit.mem.orchdRespawn) { // base stats are per unit: never apply twice
            unit.mem.orchdRespawn = true;
            unit.base.respawnTime = Math.max(0, num(unit.base.respawnTime) + num(t3.respawn_time));
          }
          const atk = num(t1.atk), dur = num(t1.atk_duration, 30);
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            if (unit.mem.orchdDeployed && atk) battle.addBuff(unit, { key: 'orchd2:wirebug', duration: dur, mods: { atkPct: atk }, visible: true, source: unit });
            unit.mem.orchdDeployed = true;
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // S2: "部署后立即释放一次" — free at every deployment (orchd2_s_2[auto_once], its first cast costs no SP)
        battle.on('deploy', (c) => {
          if (c.unit !== unit || c.move || unit.skill?.id !== S2 || unit.skill.active) return;
          unit.skill.activate('deploy', { free: true });
        }, { owner: unit, priority: -10 });
        // 龙之箭: the arrows in flight, one battle-wide stepper (an arrow flies on whatever its archer does)
        if (!DRAGONS.has(battle)) {
          DRAGONS.set(battle, []);
          battle.on('tick', () => stepDragons(battle));
        }
      },
    };
  },
};
