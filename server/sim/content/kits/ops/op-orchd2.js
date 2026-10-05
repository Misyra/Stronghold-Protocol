// server/sim/content/kits/ops/op-orchd2.js — 焰狐龙梓兰 (char_1048_orchd2) 自选 operator kit: 6★ 重射手 (狙击), an owned-6★
// pick of the tier-5 and tier-6 自选 slots; every skill, both talents, the trait and her module (ARC-X 梓兰特制箭靶) at every
// form. Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_1048_orchd2): normal = E2 Lv1, skills at rank 4, no module; elite = E2 Lv60, rank 7,
// ARC-X at stage 1 (tier 5) or 3 (tier 6) — the owner's decision of 2026-10-05. Potential 0 [ASSUMED: no account].
// Sources: character_table / skill_table / battle_equip_table (zh_CN, as built into backups.json); PRTS 焰狐龙梓兰 (特性备注,
// the 备注 of both talents and all three skills, quoted where used); the official skeleton of char_1048_orchd2 (front .skel:
// the Skill_X animations and their OnAttack events) for the moments the skills act — PRTS 飞翔瞪射 备注 "三轮攻击的时间模式
// 均为跟随动画", 龙之箭 备注 (frame counts of the first / later casts). NB she came with a 联动寻访 (PRTS 获得方式; Monster
// Hunter); her team is 预备行动组 (reserve6), not one of build-data DIY_EXCLUDED_TEAMS, so the data offers her — reported.
// - Trait (重射手) "高精度的近距离射击": ranged physical arrows, 3-6, can hit air units (PRTS 分支特性信息 重射手 "可对空"),
//   blocks 1, ground enemies target her except while airborne (S2). PRTS 特性备注: her normal attack is a 三连击 of 100 %
//   ATK each, and every normal-attack damage is cut to 33.3 % after DEF / RES (hidden talent attack@damage_scale 0.333):
//   profile hits 3 (the count is in no blackboard: NORMAL_HITS) and dmg.mul × damage_scale on her non-skill attack damage.
// - T1 强击瓶专家 "部署后首次开启技能时，接下来50次攻击的攻击力提升至115%": the first cast of each deployment gives
//   power_attack_count stacks; each attack ROUND (备注: a normal attack's three hits, a skill volley, 飞翔瞪射's landing, one
//   龙之箭) spends one and all of that round's damage is ×power_attack_scale (an ATK-scale multiplier, 备注). A round spends
//   it at its first hit, a 龙之箭 when it is shot [ASSUMED: the 备注 spends it "于弹道脱手前" — only a round whose arrows all
//   fizzle differs]. The first cast also uses the longer Skill_X_Begin_First clip (备注): its waits below are the longer ones.
// - T2 翔虫机动 "再部署时间-15秒且不提高部署费用；部署至上次部署位置周围时，30秒内攻击力+15%…可以部署在近战位": the hidden
//   talent's respawn_time (−15; ARC-X stage 3 −18) shortens her redeploy time; when she leaves the field a mark stays on her
//   tile (备注) and a later deployment inside its range (bbStr ignore_build_type_target_range: x-1, ARC-X stage 3 x-2, from
//   range_table) gives ATK +atk for atk_duration s — the mode's redeploy brings her back on that very tile, so every
//   redeploy does. "不提高部署费用" and "可以部署在近战位": nothing in battle (the mode never raises a redeploy cost; the
//   board places her).
// - Module ARC-X “梓兰特制箭靶”: "再部署时间减少" (attribute respawn_time −25, in the stats) + ATK / DEF; stage 3 upgrades T2.
// - S1 刚射 (MANUAL, charges 2 / 3, data DEFAULT): the cast's attack is 4 arrows of atk_scale_1 × ATK (the text's counts:
//   "发射4支", "发射5支" — parsed); with a charge left it spends one more (备注: "消耗2次充能所需的技力") for 刚连射 1.167 s
//   later (Skill_1_End_2: OnAttack at 0.667 / 1.833 s): 5 arrows of atk_scale_2 × ATK, each stun_prob to stun `stun` s;
//   no target then ⇒ the skill stops and the charge comes back (备注). No normal attack until the end clip is over.
//   "充能至最大层数时自动释放一次": the DEFAULT rule casts it as soon as she is about to attack — the 3 s operation cooldown
//   never binds at max charges (a refill takes ≥ 10 s), so no extra rule.
// - S2 飞翔瞪射 (MANUAL, charges 2 / 3, data SKILL_RANGE on its 4-4): 起飞 (liftoff + blockFly, as 蒂比: no ground enemy
//   blocked or attacking her) for 4.2 s, no normal attack (备注 "自身丢失全部视野"), three volleys at every target of the 4-4
//   (air units too) of 3 / 4 / 5 arrows × attack@atk_scale_loop each, then she lands with attack@atk_scale_end × ATK on every
//   enemy of the 1-3 (备注 "降落时伤害范围为1-3"; air units too [ASSUMED]). Timeline from the skeleton: volleys 0.167 s into
//   each 0.833 s Skill_2_Loop after the 0.667 s Skill_2_Begin (first cast: Begin_First 1.5 s, the skill 0.833 s longer),
//   the landing 0.233 s into Skill_2_End. "部署后立即释放一次": every deployment casts it at once, free (备注 "无视技力…不会消耗
//   技力").
// - S3 龙之箭 (MANUAL, charges 1 / 2, data DEFAULT): after 3 s (Skill_3_Begin 1.5 s + wait_duration; first cast
//   Begin_First 2.167 s, 备注 ≈110 frames) and 0.1 s more (Skill_3_End OnAttack) a piercing arrow flies straight ahead from
//   her at 10 tiles/s (备注), collision radius 0.5 (备注), until it leaves the field: every dist_interval tiles it deals
//   atk_scale × ATK physical, then atk_scale_magic × ATK arts (备注 order) to every enemy around it (air units too
//   [ASSUMED]), and it pushes each enemy it touches with 力度 `force` (中等力度) along its flight, once per
//   knockback_duration s per enemy (备注). ATK is read when it is shot [ASSUMED]. Her range does not change (备注 "不影响
//   实际视野"). No normal attack until Skill_3_End is over (1.233 s).
// [ASSUMED] for the three skills: a stun / freeze does not cancel the scheduled volleys, bursts and arrow (no animation
// model); the wind-up of 刚射 before its first shot (Skill_1_Begin + 0.667 s) is not modelled, as no attack's wind-up is.

import { num, up, skillRec } from '../shared/tier1.js';
import { performAttack, acquireTargets } from '../../../ai.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { dirVec } from '../../../dir.js';
import { hasHp } from '../../../damage.js';

const S1 = 'skchr_orchd2_1';
const S2 = 'skchr_orchd2_2';
const S3 = 'skchr_orchd2_3';
/** PRTS 特性备注 "普通攻击为三连击": the hits of her normal attack (no blackboard key). */
export const NORMAL_HITS = 3;
/**
 * The official skeleton of char_1048_orchd2 (front .skel), seconds: clip lengths and their OnAttack events.
 * Skill_1: Begin 0.1 (First 1.0), End_1 1.5 (shot 0.667), End_2 2.667 (shots 0.667, 1.833); Skill_2: Begin 0.667 (First
 * 1.5), three Loop clips 0.833 (shot 0.167), End 1.0 (landing 0.233); Skill_3: Begin 1.5 (First 2.167), End 1.233 (shot 0.1).
 */
export const CLIP = Object.freeze({
  s1Shot: 0.667, s1BurstShot: 1.833, s1End1: 1.5, s1End2: 2.667,
  s2Begin: 0.667, s2BeginFirst: 1.5, s2Loop: 0.833, s2LoopShot: 0.167, s2EndShot: 0.233,
  s3Begin: 1.5, s3BeginFirst: 2.167, s3EndShot: 0.1, s3End: 1.233,
});
/** 龙之箭 (PRTS 备注): flight speed (tiles/s), collision radius (tiles), lifetime (s). */
export const ARROW = Object.freeze({ speed: 10, radius: 0.5, life: 30 });
/** 1-3 (range_table): 飞翔瞪射's landing area (PRTS 备注). */
const GRID_1_3 = Object.freeze([[1, 1], [0, 0], [0, 1], [-1, 1]]);
/** 翔虫机动's mark ranges (range_table): x-1 = |dr| + |dc| ≤ 2; x-2 = the 5 × 5 square without its corners. */
const MARK_RANGE = Object.freeze({
  'x-1': (dr, dc) => Math.abs(dr) + Math.abs(dc) <= 2,
  'x-2': (dr, dc) => Math.abs(dr) <= 2 && Math.abs(dc) <= 2 && !(Math.abs(dr) === 2 && Math.abs(dc) === 2),
});
const TAG_BURST = 'orchd2:burst';
const TAG_ARROW = 'orchd2:arrow';
const LOCK = 'orchd2:lock';
const LIFT = 'orchd2:liftoff';
const WIREBUG = 'talent:orchd2:wirebug';

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
/** A talent of the record by a blackboard key it carries (index-independent: hidden talents included). */
const talentWith = (chess, key) => (chess?.talents ?? []).find((t) => t && t.bb && t.bb[key] != null) ?? null;
/** Numbers of a skill text ("发射4支…发射5支", "分别射出3、4、5支"), or `fallback`. */
function textCounts(desc, re, fallback) {
  const m = re.exec(String(desc ?? ''));
  if (!m) return fallback;
  const out = m[1].split(/[、,，]/).map((s) => Number.parseInt(s, 10)).filter((n) => n > 0);
  return out.length ? out : fallback;
}

/** No normal attack for `s` seconds (the rest of a skill clip). */
function lock(battle, unit, s) {
  if (s > 0) battle.addBuff(unit, { key: LOCK, duration: s, flags: { disarm: true }, tags: ['skill'] });
}

export default {
  char_1048_orchd2: (bb, chess) => {
    const s1 = skillRec(chess, S1), s2 = skillRec(chess, S2), s3 = skillRec(chess, S3);
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const shots = [...String(s1?.desc ?? '').matchAll(/发射(\d+)支/g)].map((m) => Number(m[1]));
    const arrows1 = shots[0] > 0 ? shots[0] : 4, arrows2 = shots[1] > 0 ? shots[1] : 5;
    const volleys = textCounts(s2?.desc, /射出([\d、]+)支/, [3, 4, 5]);
    const power = talentWith(chess, 'power_attack_count')?.bb ?? {};
    const wire = talentWith(chess, 'atk_duration') ?? { bb: {}, bbStr: {} };
    const respawn = num(talentWith(chess, 'respawn_time')?.bb?.respawn_time);
    const normalCut = num(talentWith(chess, 'attack@damage_scale')?.bb?.['attack@damage_scale'], 1);
    const markIn = MARK_RANGE[wire.bbStr?.ignore_build_type_target_range] ?? MARK_RANGE['x-1'];

    /** The first cast of this deployment: T1's stacks and the longer first clip. */
    const firstCast = (unit) => {
      if (unit.mem.orchdCast) return false;
      unit.mem.orchdCast = true;
      unit.mem.orchdPower = Math.max(0, Math.floor(num(power.power_attack_count)));
      return true;
    };
    /** T1: one stack for a round ⇒ its multiplier (1 without stacks). */
    const takePower = (unit) => {
      if (!(unit.mem.orchdPower > 0)) return 1;
      unit.mem.orchdPower--;
      return num(power.power_attack_scale, 1);
    };
    /** A skill attack profile: her own (targeting, projectile) with the skill's scale and hit count. */
    const skillProfile = (unit, atkScale, hits, extra = {}) => ({ ...unit.profile, isSkill: true, atkScale, hits, tags: [], ...extra });
    /** Targetable enemies of a facing-RIGHT grid around her (air units too: she can hit them). */
    const inGrid = (battle, unit, grid) => battle.enemiesInKeys(absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0), unit, { canHitFly: true });
    /** The skill still runs this very activation (scheduled steps of a cast). */
    const running = (unit, seq, act) => up(unit) && unit.deploySeq === seq && !!unit.skill?.active && unit.skill.activations === act;

    /** 龙之箭: shot from her tile straight ahead (see the header). */
    const shootArrow = (battle, unit) => {
      const mul = takePower(unit);
      const atk = unit.s.atk;
      const [fr, fc] = dirVec(unit.dir);
      const ux = fc, uy = fr; // x = column, y = row
      const every = Math.max(0.05, num(b3.dist_interval, 0.25));
      const maxDist = num(b3.max_dist, 99);
      const force = num(b3.force, 1), cd = num(b3.knockback_duration, 1);
      const phys = atk * num(b3.atk_scale) * mul, arts = atk * num(b3.atk_scale_magic) * mul;
      const pushReady = new Map();
      let x = unit.x, y = unit.y, acc = 0, flown = 0, age = 0;
      battle.fx('dragonArrow', { x, y, id: unit.id, dx: ux, dy: uy, speed: ARROW.speed });
      const strike = () => {
        for (const e of battle.foesInRadius(x, y, ARROW.radius)) {
          if (phys > 0) battle.dealDamage(unit, e, { amount: phys, type: 'phys', isSkill: true, tags: ['skill', TAG_ARROW] });
          if (arts > 0 && e.alive) battle.dealDamage(unit, e, { amount: arts, type: 'arts', isSkill: true, tags: ['skill', TAG_ARROW] });
        }
      };
      const h = battle.on('tick', ({ dt }) => {
        const step = ARROW.speed * dt;
        let moved = 0;
        while (moved < step - 1e-9) {
          const s = Math.min(step - moved, every - acc);
          x += ux * s; y += uy * s; moved += s; acc += s; flown += s;
          if (acc >= every - 1e-9) { acc = 0; strike(); }
        }
        // the collision (push) is checked once per frame (备注), each enemy at most once per knockback_duration
        for (const e of battle.foesInRadius(x, y, ARROW.radius)) {
          if ((pushReady.get(e) ?? -Infinity) > battle.time + 1e-9) continue;
          pushReady.set(e, battle.time + cd);
          battle.push(e, force, { from: { x, y }, dir: { x: ux, y: uy }, fixed: true });
        }
        age += dt;
        if (age >= ARROW.life || flown >= maxDist || !battle.grid.inRect(Math.round(y), Math.round(x))) battle.off(h);
      }, { owner: unit });
    };

    return {
      trait: { hits: NORMAL_HITS },
      skills: {
        [S1]: {
          kind: num(s1?.maxChargeTime, 1) > 1 ? 'charges' : 'instant',
          attack: { atkScale: num(b1.atk_scale_1, 1), hits: arrows1 },
          onStart({ battle, unit, skill }) {
            firstCast(unit);
            const burst = skill.charges >= 1;
            if (burst) skill.charges -= 1; // "若还有充能则额外消耗1层施展刚连射"
            lock(battle, unit, (burst ? CLIP.s1End2 : CLIP.s1End1) - CLIP.s1Shot);
            battle.fx('quadShot', { x: unit.x, y: unit.y, id: unit.id });
            if (!burst) return;
            const seq = unit.deploySeq;
            battle.after(CLIP.s1BurstShot - CLIP.s1Shot, () => {
              if (!up(unit) || unit.deploySeq !== seq) return;
              const prof = skillProfile(unit, num(b1.atk_scale_2, 1), arrows2, { tags: [TAG_BURST], maxTargets: 1, allInRange: false });
              const targets = acquireTargets(battle, unit, prof).slice(0, 1);
              if (!targets.length) { // "找不到目标，将立刻终止技能并返还与1次充能等额的技力"
                unit.skill?.addCharge(1);
                battle.removeBuff(unit, LOCK);
                return;
              }
              performAttack(battle, unit, prof, targets);
            }, { owner: unit });
          },
        },
        [S2]: {
          kind: 'duration',
          attack: { noAttack: true },
          onStart({ battle, unit, skill }) {
            const lead = firstCast(unit) ? CLIP.s2BeginFirst : CLIP.s2Begin;
            if (lead > CLIP.s2Begin) skill.extend(lead - CLIP.s2Begin);
            battle.addBuff(unit, { key: LIFT, flags: { liftoff: true, blockFly: true }, tags: ['skill'] });
            battle.releaseBlocked(unit);
            battle.fx('takeoff', { x: unit.x, y: unit.y, id: unit.id });
            const seq = unit.deploySeq, act = skill.activations;
            const grid = s2?.rangeGrid ?? [];
            volleys.forEach((n, i) => battle.after(lead + i * CLIP.s2Loop + CLIP.s2LoopShot, () => {
              if (!running(unit, seq, act)) return;
              const targets = inGrid(battle, unit, grid);
              if (targets.length) performAttack(battle, unit, skillProfile(unit, num(b2['attack@atk_scale_loop'], 1), n, { allInRange: true }), targets);
            }, { owner: unit }));
            battle.after(lead + volleys.length * CLIP.s2Loop + CLIP.s2EndShot, () => {
              if (!running(unit, seq, act)) return;
              battle.removeBuff(unit, LIFT);
              battle.releaseBlocked(unit);
              const targets = inGrid(battle, unit, GRID_1_3);
              battle.fx('aoe', { x: unit.x, y: unit.y, radius: 1, id: unit.id, skill: 'orchd2:landing' });
              if (targets.length) performAttack(battle, unit, skillProfile(unit, num(b2['attack@atk_scale_end'], 1), 1, { allInRange: true, projectile: 'none', attack: 'melee' }), targets);
            }, { owner: unit });
          },
          onEnd({ battle, unit }) {
            if (unit.findBuff(LIFT)) { battle.removeBuff(unit, LIFT); battle.releaseBlocked(unit); }
          },
        },
        [S3]: {
          kind: num(s3?.maxChargeTime, 1) > 1 ? 'charges' : 'instant',
          attack: { noAttack: true }, // the clip: the cast waits (pending) with no normal attack until it ends below
          onStart({ battle, unit, skill }) {
            const lead = (firstCast(unit) ? CLIP.s3BeginFirst : CLIP.s3Begin) + num(b3.wait_duration, 1.5);
            const seq = unit.deploySeq, act = skill.activations;
            battle.after(lead + CLIP.s3EndShot, () => { if (running(unit, seq, act)) shootArrow(battle, unit); }, { owner: unit });
            battle.after(lead + CLIP.s3End, () => { if (running(unit, seq, act)) skill.end('clip'); }, { owner: unit });
          },
        },
      },
      talents: [
        { install(battle, unit) { // 强击瓶专家: a round's first hit spends one stack; every hit of that round ×scale
          const rounds = new Map();
          battle.on('hit', (ctx) => {
            const d = ctx.dmg;
            if (ctx.source !== unit || !ctx.target || ctx.target.side !== 'enemy' || !d.isAttack || !d.attackId || d.type === 'element') return;
            let mul = rounds.get(d.attackId);
            if (mul === undefined) {
              mul = takePower(unit);
              rounds.set(d.attackId, mul);
              if (rounds.size > 16) rounds.delete(rounds.keys().next().value);
            }
            if (mul !== 1) d.amount *= mul;
          }, { owner: unit });
        } },
        { install(battle, unit) { // 翔虫机动: shorter redeploy; the mark on her last tile ⇒ ATK +atk for atk_duration s
          if (respawn && !unit.mem.orchdRespawn) {
            unit.mem.orchdRespawn = true;
            unit.base.respawnTime = Math.max(0, unit.base.respawnTime + respawn);
          }
          const a = num(wire.bb?.atk), dur = num(wire.bb?.atk_duration);
          battle.on('death', (ctx) => {
            if (ctx.unit === unit) unit.mem.orchdMark = [unit.tileR, unit.tileC];
          }, { owner: unit });
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit) return;
            const mark = unit.mem.orchdMark;
            unit.mem.orchdMark = null; // "持续存在直至下次焰狐龙梓兰部署"
            if (!mark || !(a > 0) || !(dur > 0) || !markIn(unit.tileR - mark[0], unit.tileC - mark[1])) return;
            battle.addBuff(unit, { key: WIREBUG, duration: dur, mods: { atkPct: a }, visible: true, tags: ['talent'] });
            battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id, kind: 'wirebug' });
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // every deployment: T1 and the first-clip rule start over; S2 "部署后立即释放一次" (free, after the deployment
        // is done — a 联防 SP carry is applied first)
        battle.on('deploy', (ctx) => {
          if (ctx.unit !== unit) return;
          unit.mem.orchdCast = false;
          unit.mem.orchdPower = 0;
          if (unit.skill?.id !== S2) return;
          const seq = unit.deploySeq;
          battle.after(0, () => {
            if (up(unit) && unit.deploySeq === seq && unit.skill && !unit.skill.active) unit.skill.activate('deploy', { free: true });
          }, { owner: unit });
        }, { owner: unit, priority: 10 });
        // 特性备注: every normal-attack damage ×damage_scale after DEF / RES
        if (normalCut !== 1) {
          battle.on('hit', (ctx) => {
            const d = ctx.dmg;
            if (ctx.source === unit && d.isAttack && !d.isSkill && d.type !== 'element') d.mul *= normalCut;
          }, { owner: unit });
        }
        // 刚连射: every arrow stun_prob to stun the target hit
        if (unit.skill?.id === S1) {
          const p = num(b1.stun_prob), s = num(b1.stun);
          battle.on('damaged', (ctx) => {
            if (ctx.source !== unit || !ctx.dmg?.tags?.includes(TAG_BURST) || !hasHp(ctx.target) || ctx.target.side !== 'enemy') return;
            if (p > 0 && s > 0 && battle.rng.chance(p)) battle.applyStatus(ctx.target, 'stun', { duration: s, source: unit });
          }, { owner: unit });
        }
      },
    };
  },
};
