// server/sim/content/kits/ops/op-yato2.js — 麒麟R夜刀 (char_1029_yato2) 自选 operator kit: 6★ 处决者 (特种), a collab pick of
// the tier-5 and tier-6 自选 slots (data/backups.json diy.excluded: offered only in a room with 联动干员 on); every skill, both
// talents, the trait and both modules (EXE-X 训练用木桩, EXE-Y 罗德岛制式双刀) at every form. Kit contract and the 自选 rules:
// ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_1029_yato2, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module;
// elite = E2 Lv60, rank 7, the picked module at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of
// 2026-10-07). Sources: character_table / skill_table / battle_equip_table (zh_CN, as built into backups.json); PRTS
// 麒麟R夜刀 (鬼人化 备注 "技能期间对每个目标的每第三次攻击变为六连击；六连击占用2个攻击间隔（前4连击+后2连击）"; 乱舞 备注
// "固定攻击动画不受攻击速度影响" / "攻击力提升效果实际为攻击倍率提升，同时应用于普通攻击与第一天赋" / "技能结束前，持有效果：晕眩免疫，
// 冻结免疫，沉睡免疫"; 空中回旋乱舞 备注 "部署瞬间即进入技能状态；技能期间获得效果：无敌，不可阻挡，晕眩免疫，冻结免疫，沉睡免疫…" /
// "触发技能时从自身所在格中心释放一个弹道，其拥有0.51的碰撞半径，8格/秒…的移动速度，每帧判定一次攻击，每造成一次技能伤害使弹道
// 突进距离+0.3格（最大突进距离受视野影响，不会超出地图边界）" / "攻击倍率同时应用于第一天赋"; 双雷剑麒麟 备注 "本天赋的伤害不触发
// 敌人的受击回复"); the client's battle data — charpack char_1029_yato2 (the talent-scale formulas: S2 multiplies the talent's
// attack@atk_scale_1 by talent_scale, S3 by atk_scale; modes Default / S1 (ThirdAttack = ThirdAttack1 Skill_Attack3 +
// ThirdAttack2 Skill_Attack4, NormalAttack) / S2 / S3), the skill prefabs skchr_yato2_2 (one attack of 16 hits:
// `_additionalTimes` 15, its anim Skill_2, `_timeMode` follow-anim; yato2_s2_taunt for the skill; then switch to mode 0) /
// skchr_yato2_3 (SkillBeginAnim Start_3, Dash = projectile_chr_yato2_s3 `_waitForProjectileInvalid`, SkillEndAnim
// Skill_3_End; yato2_s3_invincible for the skill: abnormal flags 无敌 + 不可阻挡, immune to 晕眩 / 冻结 / 沉睡), the
// projectile projectile_chr_yato2_s3 (speed 8, `_canHitSameTargetMultipleTimes` 0, interval 0, min / max / interval
// distance and extension the skill's min_dist / max_dist / dist_interval / dist_unit, targets ground and air), the
// battle skeleton (Skill_2 3.433 s with 16 OnAttack at 0.4 … 2.967 s; Start_3 1 s; Skill_3_End 0.667 s), the equips
// yato2_equip_* and buff_template_data (yato2_t1_mag_dmg: MAGICAL `atk_scale_1`, `_ignoreForSp`; yato2_t2_atk: ATK for the
// skill, then for `duration` s; yato2_e_002[atk]: ATK for the skill; yato2_e_003_t_2[magic_damage_up][trigger]: +1 stack
// per arts damage dealt up to max_stack_cnt, damage_scale = damage_up × stacks on her arts damage; yato2_e_003_t_2
// [respawn_time]: once per battle, the next redeploy time × respawn_time (0)).
// - Trait (处决者) "再部署时间大幅度减少": the data's respawnTime; melee physical, 1-1, blocks 1, ground-only (data canHitFly
//   false), the engine's blocked-first rule.
// - Module EXE-X 训练用木桩: "撤退时返还大量该次部署费用" — no manual retreat in battle in this mode ⇒ no effect (as 弑君者's /
//   砾's EXE-X); stats; stage 2+ changes T2 (+18 %, and +yato2_e_002[atk].atk while the skill runs). EXE-Y 罗德岛制式双刀:
//   "周围四格没有友方干员时攻击力+10%" (trait bb atk; op-phatom.js noOperatorBeside); stats; stage 2+ changes T1 (25 %, 术法充盈,
//   the first leave's redeploy time 0).
// - T1 双雷剑麒麟 "攻击额外造成攻击力20%的法术伤害": every damage instance of her attacks (normal, S1's, S2's slashes, S3's dash)
//   adds atk_scale_1 × ATK arts damage on that enemy, ×talent_scale while S2 runs and ×atk_scale while S3 runs (the client's
//   formulas); no 受击回复 (noSp). EXE-Y stage 2+: 术法充盈 — each arts damage she deals ×(1 + damage_up × stacks), then
//   +1 stack (up to max_stack_cnt), the stacks gone when she leaves the field; the first time she leaves the field in a
//   battle her redeploy time is 0 [ASSUMED: in this mode she leaves it by a knock-out — the card buff the client keeps
//   for her next spawn, whatever the leave].
// - T2 鬼人强化状态 "技能期间及技能结束后的10秒内攻击力+16%": ATK +atk while her skill runs and `duration` s after it.
// - S1 鬼人化 (被动, at each deployment, the skill's duration 20 s): ASPD +attack_speed; her attacks hit twice; per target,
//   every third attack hits four times and the next attack interval twice more (the six-hit taking two intervals), the
//   counts gone when it ends. [ASSUMED] the two finishing hits strike whatever that interval's attack targets.
// - S2 乱舞 (被动, at each deployment, the attack animation's 3.433 s, not paced by attack speed): no normal attacks; 16
//   slashes at the skeleton's OnAttack times, each on every selectable ground enemy of her 1-1 at atk_scale × ATK
//   physical; taunt level +taunt_level; 晕眩 / 冻结 / 沉睡 refused. [ASSUMED] the 16 hits count from her deployment (the
//   deployment's own animation is not modelled).
// - S3 空中回旋乱舞 (被动, at each deployment): 无敌 (invulnerable, untargetable), 不可阻挡 (blocks 0), 晕眩 / 冻结 / 沉睡 refused,
//   no normal attacks; 1 s in (Start_3) the dash leaves her tile centre the way she faces at 8 tiles/s, every frame
//   slashing each selectable enemy (ground or air) within 0.51 of it once — atk_scale × ATK physical —, each slash
//   carrying it dist_unit tiles further, from min_dist up to max_dist, never past the map's edge; the skill ends
//   Skill_3_End's 0.667 s after the dash stops. She stays on her tile (the dash is the client's projectile).
// Triggers: the three skills are 被动 ON_DEPLOY — timed deployment skills (activateOnDeploy, trigger NEVER).

import { num, talentBb, moduleBb, traitBb, skillRec, toggleBuff, up } from '../shared/tier1.js';
import { canTargetEnemy } from '../../../targeting.js';
import { noOperatorBeside } from './op-phatom.js';
import { TICK } from '../../../constants.js';

const S1 = 'skchr_yato2_1';
const S2 = 'skchr_yato2_2';
const S3 = 'skchr_yato2_3';
/** 乱舞's 16 hits: the OnAttack times of the battle skeleton's Skill_2 (3.433 s), from the skill's start. */
const S2_HITS = Object.freeze([0.4, 1.067, 1.133, 1.4, 1.667, 1.933, 2, 2.2, 2.267, 2.633, 2.7, 2.767, 2.8, 2.867, 2.9, 2.967]);
const S2_LEN = 3.433;
/** 空中回旋乱舞: Start_3 before the dash, Skill_3_End after it (battle skeleton). */
const S3_BEGIN = 1;
const S3_END = 0.667;
/** projectile_chr_yato2_s3: 8 tiles/s; PRTS 备注 "0.51的碰撞半径". */
const DASH_SPEED = 8;
const DASH_RADIUS = 0.51;
/** A cap on the S3 skill's own length (the dash ends it long before: 1 + 5 / 8 + 0.667 s). */
const S3_CAP = 10;
const TIMED = Object.freeze({ kind: 'duration', activateOnDeploy: true, spCost: 0, spType: 'none', trigger: 'NEVER' });
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
const AIR = Object.freeze({ canHitFly: true });
const IMMUNE = Object.freeze(new Set(['stun', 'freeze', 'sleep']));
const T1_TAG = 'yato2:t1';
const SLASH_TAG = 'yato2:slash';
const DASH_TAG = 'yato2:dash';
const skillOn = (u, id) => !!(u.skill && u.skill.active && (id == null || u.skill.id === id));

/** The selectable ground enemies of her 1-1 now. */
const frontFoes = (battle, unit) => battle.enemiesInKeys(unit.rangeKeys || [], unit, GROUND);

export default {
  char_1029_yato2: (bb, chess) => {
    const t0 = talentBb(chess, 0);   // 双雷剑麒麟 (EXE-Y stage 2+: 0.25)
    const t1 = talentBb(chess, 1);   // 鬼人强化状态 (EXE-X stage 2+: 0.18 + yato2_e_002[atk].atk)
    const mb = moduleBb(chess);      // EXE-Y stage 2+: damage_up, max_stack_cnt, respawn_time
    const lonelyAtk = num(traitBb(chess).atk);   // EXE-Y trait (EXE-X: withdraw_cost_recover_ratio)
    const b1 = skillRec(chess, S1)?.bb ?? {}, b2 = skillRec(chess, S2)?.bb ?? {}, b3 = skillRec(chess, S3)?.bb ?? {};
    const t1Scale = num(t0['attack@atk_scale_1']);
    const arcUp = num(mb.damage_up), arcMax = Math.max(0, Math.floor(num(mb.max_stack_cnt)));
    const freeRespawn = arcUp > 0 || mb.respawn_time != null;
    const skillAtk = num(t1['yato2_e_002[atk].atk']);
    const minDist = num(b3.min_dist, 2), maxDist = num(b3.max_dist, 5), unitDist = num(b3.dist_unit, 0.3);
    const s3Scale = num(b3.atk_scale, 1);

    /** T1 on one damage instance of her attack: the scale of the skill that runs. */
    const talentScale = (u) => t1Scale * (skillOn(u, S2) ? num(b2.talent_scale, 1) : skillOn(u, S3) ? s3Scale : 1);

    const slashS2 = (battle, unit) => {
      const foes = frontFoes(battle, unit);
      for (const e of foes) {
        if (!e.alive) continue;
        battle.dealDamage(unit, e, { amount: unit.s.atk * num(b2.atk_scale, 1), type: 'phys', isAttack: true, isSkill: true, tags: ['skill', SLASH_TAG] });
        battle.fx('slash', { x: e.x, y: e.y, id: unit.id, target: e.id });
      }
    };

    /** The dash's step this tick: move, slash what it touches, stop at its reach or the map's edge. */
    const dashStep = (battle, unit, d, dt) => {
      const before = d.travel;
      d.travel = Math.min(d.reach, d.travel + DASH_SPEED * dt);
      const x = d.sx + d.vx * d.travel, y = d.sy + d.vy * d.travel;
      const R = battle.grid.rect;   // "不会超出地图边界"
      const off = x < R.c0 - 0.5 || y < R.r0 - 0.5 || x > R.c1 + 0.5 || y > R.r1 + 0.5;
      if (!off) {
        for (const e of battle.foesInColliderRadius(x, y, DASH_RADIUS)) {
          if (d.hit.has(e) || !e.alive || !canTargetEnemy(unit, e, AIR)) continue;
          d.hit.add(e);
          battle.dealDamage(unit, e, { amount: unit.s.atk * s3Scale, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', DASH_TAG] });
          battle.fx('slash', { x: e.x, y: e.y, id: unit.id, target: e.id });
          // "每造成一次技能伤害使弹道突进距离+0.3格": the reach grows, up to max_dist
          const reach = Math.min(maxDist, d.reach + unitDist);
          if (reach > d.reach + 1e-9) {
            battle.fx('dash', { x, y, tx: d.sx + d.vx * reach, ty: d.sy + d.vy * reach, t: (reach - d.travel) / DASH_SPEED, id: unit.id, flame: `${d.flame}:${++d.seg}` });
            d.reach = reach;
          }
        }
      }
      if (off || d.travel >= d.reach - 1e-9 || d.travel <= before) {
        d.done = true;
        d.endAt = battle.time + S3_END;
      }
    };

    return {
      skills: {
        [S1]: { ...TIMED, duration: num(skillRec(chess, S1)?.duration, 20), mods: { aspd: num(b1.attack_speed) },
          onStart({ unit }) { unit.mem.yatoCount = new Map(); unit.mem.yatoTail = false; unit.mem.yatoHits = 2; },
          onEnd({ unit }) { unit.mem.yatoCount = null; unit.mem.yatoTail = false; } },
        [S2]: {
          ...TIMED, duration: S2_LEN, mods: { taunt: num(b2.taunt_level) }, attack: { noAttack: true },
          onStart({ battle, unit }) { unit.mem.yatoS2 = { start: battle.time, i: 0 }; },
          onTick({ battle, unit }) {
            const m = unit.mem.yatoS2;
            if (!m || !unit.canAct) return;
            const t = battle.time - m.start + 1e-9;
            while (m.i < S2_HITS.length && S2_HITS[m.i] <= t) { m.i++; slashS2(battle, unit); } // loop-cap: S2_HITS (16)
          },
          onEnd({ unit }) { unit.mem.yatoS2 = null; },
        },
        [S3]: {
          ...TIMED, duration: S3_CAP, flags: { invulnerable: true, untargetable: true }, mods: { blockCnt: -99 }, attack: { noAttack: true },
          onStart({ battle, unit }) {
            battle.releaseBlocked(unit);
            unit.mem.yatoDash = { launchAt: battle.time + S3_BEGIN, launched: false, done: false, endAt: Infinity };
          },
          onTick({ battle, unit, skill }) {
            const d = unit.mem.yatoDash;
            if (!d) return;
            if (!d.launched && battle.time + 1e-9 >= d.launchAt) {
              const [dr, dc] = Array.isArray(unit.fwd) ? unit.fwd : [0, 1];
              Object.assign(d, { launched: true, sx: unit.x, sy: unit.y, vx: dc, vy: dr, travel: 0, reach: minDist, hit: new Set(), seg: 0, flame: `${unit.id}:${battle.time.toFixed(3)}` });
              battle.fx('dash', { x: unit.x, y: unit.y, tx: unit.x + dc * minDist, ty: unit.y + dr * minDist, t: minDist / DASH_SPEED, id: unit.id, flame: `${d.flame}:0` });
              return;
            }
            if (d.launched && !d.done) dashStep(battle, unit, d, TICK);
            if (d.done && battle.time + 1e-9 >= d.endAt) skill.end('dash');
          },
          onEnd({ unit }) { unit.mem.yatoDash = null; },
        },
      },
      // S1: 二连击, per target every third attack 4 + 2 hits (beforeAttack below sets the count of the coming attack)
      trait: { hitsFn: (b, u) => (skillOn(u, S1) ? Math.max(1, u.mem.yatoHits ?? 2) : 1) },
      talents: [
        { install(battle, unit) { // 双雷剑麒麟 (+ EXE-Y stage 2+: 术法充盈, the first leave's redeploy time)
          battle.on('damaged', (c) => {
            const e = c.target, d = c.dmg;
            if (c.source !== unit || !e || e.side !== 'enemy' || !d || !d.isAttack || c.type !== 'phys' || d.tags?.includes(T1_TAG)) return;
            const sc = talentScale(unit);
            if (sc > 0 && e.alive) battle.dealDamage(unit, e, { amount: unit.s.atk * sc, type: 'arts', noSp: true, tags: ['talent', T1_TAG] });
          }, { owner: unit });
          if (arcUp > 0 && arcMax > 0) {
            battle.on('deploy', (c) => { if (c.unit === unit) unit.mem.yatoArc = 0; }, { owner: unit, priority: 10 });
            battle.on('hit', (c) => {
              const d = c.dmg;
              if (c.source !== unit || !d || d.type !== 'arts' || !(unit.mem.yatoArc > 0)) return;
              d.mul *= 1 + arcUp * unit.mem.yatoArc;
            }, { owner: unit });
            battle.on('damaged', (c) => {
              if (c.source !== unit || c.type !== 'arts' || !up(unit)) return;
              unit.mem.yatoArc = Math.min(arcMax, (unit.mem.yatoArc ?? 0) + 1);
            }, { owner: unit });
          }
          if (freeRespawn) {
            battle.on('death', (c) => {
              if (c.unit !== unit || unit.removed || c.reason === 'raid' || unit.mem.yatoFreeRespawn) return;
              unit.mem.yatoFreeRespawn = true;
              unit.respawnAt = Math.min(unit.respawnAt ?? battle.time, battle.time + Math.max(0, num(mb.respawn_time)) * num(unit.base.respawnTime));
            }, { owner: unit });
          }
        } },
        { install(battle, unit) { // 鬼人强化状态 (+ EXE-X stage 2+: ATK while the skill runs)
          const atk = num(t1.atk), dur = num(t1.duration, 10);
          battle.on('skillStart', (c) => {
            if (c.unit !== unit) return;
            battle.removeBuff(unit, 'yato2:t2:after');
            battle.addBuff(unit, { key: 'yato2:t2', mods: { atkPct: atk + skillAtk }, visible: true, source: unit });
          }, { owner: unit });
          battle.on('skillEnd', (c) => {
            if (c.unit !== unit) return;
            battle.removeBuff(unit, 'yato2:t2');
            if (unit.alive && dur > 0 && atk) battle.addBuff(unit, { key: 'yato2:t2:after', duration: dur, mods: { atkPct: atk }, visible: true, source: unit });
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // S1: the per-target count of the coming attack (每第三次 ⇒ 4 hits now, 2 at the next interval)
        battle.on('beforeAttack', (c) => {
          if (c.attacker !== unit || !skillOn(unit, S1) || !unit.mem.yatoCount) return;
          if (unit.mem.yatoTail) { unit.mem.yatoTail = false; unit.mem.yatoHits = 2; return; }
          const t = (c.targets || [])[0];
          if (!t) return;
          const n = (unit.mem.yatoCount.get(t) ?? 0) + 1;
          unit.mem.yatoCount.set(t, n);
          if (n % 3 === 0) { unit.mem.yatoHits = 4; unit.mem.yatoTail = true; } else unit.mem.yatoHits = 2;
        }, { owner: unit });
        // S2 / S3: 晕眩 / 冻结 / 沉睡 refused while the skill runs (PRTS 备注; yato2_s3_invincible)
        battle.on('beforeStatus', (c) => {
          if (c.target === unit && IMMUNE.has(c.status) && (skillOn(unit, S2) || skillOn(unit, S3))) c.cancel = true;
        }, { owner: unit });
        // EXE-Y "周围四格没有友方干员时攻击力+10%"
        if (lonelyAtk > 0) toggleBuff(battle, unit, 'trait:yato2:lonely', () => noOperatorBeside(battle, unit), { atkPct: lonelyAtk });
      },
    };
  },
};
