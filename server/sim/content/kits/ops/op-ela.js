// server/sim/content/kits/ops/op-ela.js — 艾拉 (char_4123_ela) 自选 operator kit: 6★ 陷阱师 (特种), a collab pick of the tier-5
// and tier-6 自选 slots (data/backups.json `diy.excluded`: offered only in a room whose host turned on 联动干员); every skill,
// both talents, the trait, the module (TRP-Δ “社会期望背包”) at every form, and the kit of her trap 雷鸣地雷
// (token_10033_ela_grzmot). Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_4123_ela): normal = E2 Lv1, skills at rank 4, no module; elite = E2 Lv60, rank 7, TRP-Δ
// at stage 1 (tier 5) or 3 (tier 6), or none. Full potential. Sources: character_table / skill_table / battle_equip_table /
// the token record (zh_CN, as built into backups.json); PRTS 艾拉 (备注 quoted below); the client's battle data: charpack
// char_4123_ela (Talents/1: charge_token[refresh] + ela_t_1[dead]; Talents/2: ela_t_2; CommonAbilities/KillTokens:
// die_to_kill_token; modes S2 / S3 — S3's selector prefers `ela_token_influence`), skills skchr_ela_1–3 (their DeadBoom /
// WithdrawBoom abilities) and sktok_ela_1–3 (SkillTrigger circle 1.35, Selector circle 1.7, ground targets,
// force_withdraw_on_start), buff templates ela_t_2, ela_t_1[dead], ela_s_2and3 (battle/buff_template_data.json at the pinned
// commit 17759cc8), projectiles projectile_chr_ela_dead_s1–3 (_delayToStart 0.8 s) / _withdraw_s1–3 (at once).
// - Trait (陷阱师) "可以使用陷阱来协助作战，但陷阱无法放置于敌人已在的格子中": ranged physical arrows (projectile_chr_ela), 3-4, hits air
//   units, blocks 1. Her traps never (re)deploy on a tile a ground enemy stands on and leave when she leaves the field
//   (die_to_kill_token), as 多萝西's (op-doroth.js).
// - The traps in this mode: her 雷鸣地雷 are hand pieces the player places (data `placeable`; the prep hands out a stack of the
//   deploy limit — content/tokens.js, server/match/player/diy.js). Placed pieces deploy with the board, free and ignoring her
//   stock (PRTS 卫戍协议/帮助 "所有手动部署的召唤物，无视所属干员的持有状态…作战开始时立即部署一次"); a used-up one stays its tile's piece
//   and comes back there once: she is on the field, her stock holds a trap, the card's redeploy time (data respawnTime 5 s) has
//   run since the last trap deployment, its player has its cost in DP (5), fewer of her traps than the deploy limit stand
//   (data deployLimit 4; PRTS 备注 "陷阱部署上限与最多拥有数量相同") and no ground enemy is on the tile; one piece per check (uid
//   order), paying the cost and spending one trap — op-doroth.js's rule.
// - T1 雷鸣地雷 "可以使用4（+1）个雷鸣地雷（最多拥有4个），经过周围的第一个敌人会触发其效果，撤退时以自身为中心触发一次雷鸣地雷效果" (full
//   potential: cnt 4): her stock is refilled to cnt at each deployment (charge_token[refresh]) and holds at most the deploy limit.
//   A standing trap (its kit below) goes off when a selectable ground enemy comes within TRIGGER_RADIUS (sktok_ela_* SkillTrigger;
//   PRTS 备注 "雷鸣地雷触发半径1.35") — at once [ASSUMED: the trap's cast clip is not timed] — on every selectable ground enemy
//   within EFFECT_RADIUS (the Selector; PRTS "效果影响半径1.7"; the enemies' centres, as op-cqbw.js's mine), with the token skill
//   of her pick (bySkill), then withdraws (force_withdraw_on_start; the fx carries `consumed`). ela_t_1[dead]: when she is
//   knocked out (ON_OWNER_KILLED: DeadBoom) the same effect — her own skill's blackboard — goes off where she fell DEAD_DELAY s
//   later (projectile_chr_ela_dead_s*), and when she leaves the field otherwise (ON_OWNER_FINISH, WithdrawBoom) at once where she
//   stood — PRTS 备注 "以任何方式离场均可触发本天赋"; not at the end of the battle [ASSUMED].
// - The effects (sktok_ela_* active buffs; the DeadBoom / WithdrawBoom of each skill alike): S1 眩目阻滞 停顿 `sluggish` s and
//   `ela_token_influence` `duration` s with 物理 / 法术命中率 ×(1 + damage_hitrate_*) (attributes 33 / 34, FINAL_SCALER); S2 震荡坚守
//   晕眩 `stun` s and the influence `stun` s; S3 “博萨克风暴” 停顿 `sluggish` s, the influence `sluggish` s and 脆弱 damage_scale − 1
//   for `weak[limit]` s (the catalogue `fragile`). The 命中率 cut: PRTS 命中率 — one roll per attack of an influenced enemy (its
//   first damage instance) that cancels every hit of it, a battle-wide `hit` handler as Raidian's / 弑君者's (the strongest of
//   her influences holding the attacker; other kinds of 命中率 cut roll apart [ASSUMED, as theirs]); physical and arts attacks
//   only.
// - T2 “正中靶心” "攻击有30%几率造成相当于攻击力160%（+10%）的物理伤害，对受到雷鸣地雷效果影响的目标必定触发" (full potential: prob 0.3,
//   atk_scale 1.6; TRP-Δ stage 2+: 0.5 / 1.8): ela_t_2 — ON_CALCULATE_DAMAGE (and its cached-projectile twin): ×atk_scale on
//   everything she calculates (AtkScaleUp), always against an enemy that holds an influence of hers, else on a `prob` roll per
//   damage instance (a splash target rolls on its own).
// - S1 眩目阻滞 (AUTO, 24 / 21 SP): 被动 = the trap's effect above; 主动 "立即获得一个陷阱" (trigger_charge_token, 1): +1 to her stock.
//   It acts on herself (_allowNoTarget): cast as soon as its SP is full (the owner's AUTO rule, kits/README.md checklist 5). 阻回
//   while her stock is full (skchr_ela_1 _stopSpWhenTokenIsFull; PRTS 备注) — at full potential her deployment stock 4 fills the
//   limit 4: 阻回 until a trap is spent.
// - S2 震荡坚守 (MANUAL, attack SP 22 / 19, 20 s; the data's DEFAULT): 被动 = the stun trap; 主动 DEF +def (×, the S2 mode's
//   attribute 2), 无视 def_penetrate_fixed DEF on her damage (attribute 25), range = the skill's 3×3 forward (攻击范围缩小), each
//   attack splashes attack@projectile_range around its target (PRTS "普通攻击溅射半径1.1"; projectile_chr_ela_s2 hits every
//   enemy of the circle); at the end +1 trap (ela_s_2and3 RechargeToken — no `cnt` on S2's blackboard: 1, the text's "一个").
// - S3 “博萨克风暴” (MANUAL ammo, 44 / 40 SP; the data's DEFAULT): 被动 = the fragile trap; 主动 ATK +atk, base attack time
//   + base_attack_time s (batMod), attack@trigger_time (40) shots, and her attack picks an enemy holding an influence of hers
//   first (the S3 mode's selector `_secondaryFilter` with ela_token_influence; then her usual order); at the end +cnt (2) traps.
// - TRP-Δ “社会期望背包”: ATK / DEF in the stats; T2 at stage 2+; "自身可以额外部署在近战位，陷阱可以额外部署在远程位" (hidden talent
//   buildable_type 3) is a placement rule of the prep, not of the battle — nothing in this kit (as 帕拉斯's INS-Y, op-pallas.js).

import { num, talentBb, up, toggleBuff, skillRec, batMod } from '../shared/tier1.js';
import { canTargetEnemy, sortEnemyTargets } from '../../../targeting.js';
import { bodyOnTile } from '../../../body.js';
import { cancelDamage, hasHp } from '../../../attack.js';
import { atPotential } from '../../../../../shared/potential.js';
import { textCount } from '../../../../../shared/plugins/textNumber.js';

const S1 = 'skchr_ela_1';
const S2 = 'skchr_ela_2';
const S3 = 'skchr_ela_3';
/** 雷鸣地雷, her trap. */
export const MINE = 'token_10033_ela_grzmot';
const TS = Object.freeze({ sktok_ela_1: 1, sktok_ela_2: 2, sktok_ela_3: 3, [S1]: 1, [S2]: 2, [S3]: 3 });
/** sktok_ela_* SkillTrigger CircleCollider2D (PRTS 备注 "雷鸣地雷触发半径1.35"). */
export const TRIGGER_RADIUS = 1.35;
/** sktok_ela_* Selector CircleCollider2D (PRTS 备注 "效果影响半径1.7"; the blackboards' projectile_range). */
export const EFFECT_RADIUS = 1.7;
/** projectile_chr_ela_dead_s* _delayToStart: the knock-out's effect, after her fall. */
export const DEAD_DELAY = 0.8;
/** S2's splash when its blackboard carries none (PRTS 备注 "普通攻击溅射半径1.1"). */
const S2_SPLASH = 1.1;
/** How often a used-up piece checks its redeploy conditions (op-doroth.js). */
const WATCH = 0.25;
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
/** Her 命中率 handler runs after Raidian's (300), 阿斯卡纶's (290), 弑君者's (280), before the enemy content's riders (200). */
const MISS_PRIORITY = 270;

const tokenOf = (t) => t && t.kind === 'token' && t.defId === MINE;

/** A ground enemy stands on tile (r, c) — a huge one on any tile of its body; air units never count (op-doroth.js). */
function groundEnemyOn(battle, r, c) {
  for (const e of battle.enemies) {
    if (!e.alive || e.hidden || e.isFlying) continue;
    if (e.hitArea ? bodyOnTile(e, r, c) : Math.abs(e.x - c) <= 0.5 && Math.abs(e.y - r) <= 0.5) return true;
  }
  return false;
}

// ---- ela_token_influence: battle → { by: WeakMap(enemy → Map(艾拉 → { until, phys, arts })), last: WeakMap } -----------
const INFLUENCE = new WeakMap();

function influenceState(battle) {
  let st = INFLUENCE.get(battle);
  if (!st) {
    st = { by: new WeakMap(), last: new WeakMap() };
    INFLUENCE.set(battle, st);
    // no owner: it serves every 艾拉 of the battle
    battle.on('hit', (ctx) => missHit(battle, st, ctx), { priority: MISS_PRIORITY });
  }
  return st;
}

/** `e` holds an influence of `unit` now. */
function influenced(battle, e, unit) {
  const m = INFLUENCE.get(battle)?.by.get(e)?.get(unit);
  return !!m && m.until > battle.time + 1e-9;
}

/** Give `e` her influence for `dur` s (a later one replaces it: one buff per source). */
function influence(battle, unit, e, dur, phys = 0, arts = 0) {
  if (!(dur > 0) || !e.alive) return;
  const st = influenceState(battle);
  let m = st.by.get(e);
  if (!m) st.by.set(e, (m = new Map()));
  m.set(unit, { until: battle.time + dur, phys: Math.max(0, -phys), arts: Math.max(0, -arts) });
}

function missHit(battle, st, ctx) {
  const e = ctx.source, d = ctx.dmg;
  if (!e || e.side !== 'enemy' || !d || !d.isAttack || d.cancel || (d.type !== 'phys' && d.type !== 'arts')) return;
  const prev = d.attackId ? st.last.get(e) : null;
  let miss;
  if (prev && prev.id === d.attackId) miss = prev.miss;
  else {
    let cut = 0;
    for (const v of st.by.get(e)?.values() ?? []) if (v.until > battle.time + 1e-9) cut = Math.max(cut, d.type === 'arts' ? v.arts : v.phys);
    miss = cut > 0 && battle.rng() < Math.min(1, cut);
    if (d.attackId) st.last.set(e, { id: d.attackId, miss });
  }
  if (!miss) return;
  if (cancelDamage(d, 'miss')) ctx.stopPropagation = true;
  if (ctx.target) battle.fx('dodge', { x: ctx.target.x, y: ctx.target.y, id: ctx.target.id });
}

/**
 * The 雷鸣地雷 effect of skill `kind` (1 / 2 / 3) with blackboard `bb` at (x, y): `src` = the trap (or 艾拉 for her talent's
 * effect), `unit` = 艾拉 (the influence is hers).
 */
function mineEffect(battle, unit, src, x, y, kind, bb) {
  for (const e of battle.foesInRadius(x, y, EFFECT_RADIUS, true)) {
    if (!canTargetEnemy(src, e, GROUND)) continue;
    if (kind === 2) {
      if (num(bb.stun) > 0 && hasHp(e)) battle.applyStatus(e, 'stun', { duration: num(bb.stun), source: src });
      influence(battle, unit, e, num(bb.stun));
    } else {
      if (num(bb.sluggish) > 0 && hasHp(e)) battle.applyStatus(e, 'sluggish', { duration: num(bb.sluggish), source: src });
      if (kind === 3) {
        influence(battle, unit, e, num(bb.sluggish));
        const v = num(bb.damage_scale, 1) - 1, dur = num(bb['weak[limit]']);
        if (v > 0 && dur > 0 && e.alive) battle.applyStatus(e, 'fragile', { duration: dur, value: v, source: src });
      } else {
        influence(battle, unit, e, num(bb.duration), num(bb.damage_hitrate_physical), num(bb.damage_hitrate_magical));
      }
    }
  }
}

export default {
  char_4123_ela: (bb, chess) => {
    const t0 = talentBb(chess, 0);   // 雷鸣地雷: cnt
    const t1 = talentBb(chess, 1);   // 正中靶心: prob, atk_scale (TRP-Δ stage 2+)
    const b2 = skillRec(chess, S2)?.bb ?? {}, b3 = skillRec(chess, S3)?.bb ?? {};
    const grid2 = skillRec(chess, S2)?.rangeGrid;
    const stockRefill = Math.max(0, Math.floor(num(t0.cnt, 0)));
    // her trap stock, the card's ready time, the deploy limit (per unit; also `unit.trait.ela` for diagnostics and tests)
    const D = { stock: 0, readyAt: -Infinity, limit: Infinity };

    const traps = (battle, unit) => battle.allyUnits.filter((t) => tokenOf(t) && t.ownerUnit === unit);
    const standing = (battle, unit) => traps(battle, unit).filter((t) => t.alive).length;
    const gain = (n) => { D.stock = Math.min(D.limit, D.stock + Math.max(0, Math.floor(n))); };

    /** The token's deploy limit for her loadout (variant stats, the module's when it carries one); her max stock too. */
    function limitOf(battle, unit) {
      const raw = battle.data.rawToken?.(MINE);
      const v = atPotential(raw?.variants?.[unit.def?.tokenOwner], unit.def?.loadout?.potential);
      const mod = unit.def?.loadout?.moduleId;
      const n = num(v?.byModule?.[mod]?.stats?.deployLimit, num(v?.stats?.deployLimit, num(raw?.deployLimit, 0)));
      if (n > 0) return n;
      const owned = textCount(String(chess?.talents?.find((t) => t && t.index === 0)?.desc ?? ''), /最多拥有(\d+)个/, NaN, 'own-max');
      return Number.isFinite(owned) && owned > 0 ? owned : Infinity;
    }

    /** The trap `t` goes off (the effect of its token skill), then withdraws. */
    function fire(battle, unit, t) {
      if (!t.alive || t.mem.elaFired) return;
      t.mem.elaFired = true;
      const sk = t.def?.skill ?? null;
      const kind = TS[sk?.id] ?? 1;
      mineEffect(battle, unit, t, t.x, t.y, kind, sk?.bb ?? {});
      battle.fx('elaMineBlast', { x: t.x, y: t.y, r: EFFECT_RADIUS, id: unit.id, mine: t.id, consumed: true });
      battle.retreat(t, { reason: 'expired', permanent: true });
    }

    /** 雷鸣地雷's kit (`unit` = 艾拉): its trigger and a placed piece kept for its redeploys. */
    function trapKit(unit) {
      return {
        skill: null,
        trait: { noAttack: true },
        install(battle, t) {
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== t) return;
            t.mem.elaFired = false;
            D.readyAt = battle.time + Math.max(0, num(t.base.respawnTime, 0));
          }, { owner: t });
          battle.on('tick', () => {
            if (!t.alive || t.mem.elaFired) return;
            if (battle.foesInRadius(t.x, t.y, TRIGGER_RADIUS, true).some((e) => canTargetEnemy(t, e, GROUND))) fire(battle, unit, t);
          }, { owner: t });
          // a placed piece stays its tile's piece (redeployed by her kit's watch), whatever took it off the field
          if (t.uid != null) battle.on('death', (ctx) => { if (ctx.unit === t && !battle.finished) t.removed = false; }, { owner: t, priority: -10 });
        },
      };
    }

    const recharge = (n) => ({ onEnd() { gain(n); } }); // ela_s_2and3 RechargeToken at the skill's end (any reason)

    return {
      skills: {
        [S1]: {
          kind: 'instant', trigger: 'SP_FULL',
          onStart() { gain(1); }, // trigger_charge_token: 立即获得一个陷阱
        },
        [S2]: {
          kind: 'duration',
          mods: { defPct: num(b2.def), defIgnoreFlat: num(b2.def_penetrate_fixed) },
          ...(grid2 && grid2.length ? { targeting: { rangeGrid: grid2.map((p) => [p[0], p[1]]) } } : {}),
          attack: { splashRadius: num(b2['attack@projectile_range'], S2_SPLASH) },
          ...recharge(Math.max(1, num(b2.cnt, 1))),
        },
        [S3]: {
          kind: 'ammo', ammo: Math.max(1, Math.floor(num(b3['attack@trigger_time'], 40))),
          mods: { atkPct: num(b3.atk), batPct: batMod(b3.base_attack_time, chess) },
          ...recharge(Math.max(1, num(b3.cnt, 2))),
        },
      },
      talents: [
        { install(battle, unit) { // 雷鸣地雷: the pieces' kit, the stock, the redeploys, her own effect when she leaves
          D.limit = limitOf(battle, unit);
          unit.trait.ela = D;
          for (const t of battle.allyUnits) {
            if (!tokenOf(t) || t.ownerUnit !== unit || t.alive || t.deployed) continue;
            if (t.kit) battle.offOwner(t);   // a piece set up before her: drop its generic kit's hooks
            battle._setupUnit(t, trapKit(unit));
          }
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit || ctx.move) return;
            D.stock = Math.min(D.limit, stockRefill);   // charge_token[refresh]
          }, { owner: unit });
          battle.on('death', (ctx) => {
            if (ctx.unit !== unit) return;
            // her traps leave with her (die_to_kill_token); the placed pieces wait for her return
            for (const t of traps(battle, unit)) if (t.alive) battle.retreat(t, { reason: 'expired', permanent: true });
            if (battle.finished) return;
            // ela_t_1[dead]: DeadBoom where she fell (after the shell's delay) or WithdrawBoom where she stood
            const sid = unit.skill?.id, kind = TS[sid] ?? 1, sbb = skillRec(chess, sid)?.bb ?? {};
            const x = unit.x, y = unit.y;
            const boom = () => {
              mineEffect(battle, unit, unit, x, y, kind, sbb);
              battle.fx('elaMineBlast', { x, y, r: EFFECT_RADIUS, id: unit.id, boom: ctx.reason === 'killed' ? 'dead' : 'withdraw' });
            };
            if (ctx.reason === 'killed') battle.after(DEAD_DELAY, () => { if (!battle.finished) boom(); });
            else boom();
          }, { owner: unit });
          // a used-up / withdrawn piece comes back on its tile once the deployment conditions hold (see the header)
          battle.every(WATCH, () => {
            if (!up(unit) || D.stock < 1 || battle.time + 1e-9 < D.readyAt || standing(battle, unit) >= D.limit) return;
            const pieces = traps(battle, unit).filter((t) => t.uid != null && !t.alive && !t.removed).sort((a, b) => a.uid - b.uid);
            for (const p of pieces) {
              if (groundEnemyOn(battle, p.homeR, p.homeC)) continue;
              if (battle.redeploy(p, { free: false })) { D.stock--; break; }
            }
          }, { owner: unit });
          // 阻回 while her stock is full (skchr_ela_1 _stopSpWhenTokenIsFull: S1 only)
          if (unit.skill?.id === S1) toggleBuff(battle, unit, 'talent:ela:full', () => D.stock >= D.limit, {}, { flags: { noSp: true } });
        } },
        { install(battle, unit) { // 正中靶心 (ela_t_2): ×atk_scale on what she calculates — always vs her influenced targets
          const scale = num(t1.atk_scale, 1), prob = num(t1.prob);
          if (!(scale > 1)) return;
          influenceState(battle);
          battle.on('damageCalculate', (c) => {
            const e = c.target;
            if (c.source !== unit || !e || e.side !== 'enemy' || !c.dmg || c.dmg.type === 'element') return;
            if (influenced(battle, e, unit) || (prob > 0 && battle.rng.chance(prob))) c.dmg.amount *= scale;
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        if (unit.skill?.id !== S3) return;
        // S3: her attack picks an enemy holding an influence of hers first (the S3 mode's selector), then her usual order
        battle.on('beforeAttack', (ctx) => {
          if (ctx.attacker !== unit || !unit.skill?.active || !ctx.targets?.length) return;
          if (influenced(battle, ctx.targets[0], unit)) return;
          const pool = battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile);
          for (const e of battle.blockedTargets(unit, unit.profile)) if (!pool.includes(e)) pool.push(e);
          const marked = pool.filter((e) => influenced(battle, e, unit));
          if (!marked.length) return;
          sortEnemyTargets(battle, unit, marked, null);
          ctx.targets = [marked[0], ...ctx.targets.slice(1).filter((e) => e !== marked[0])];
        }, { owner: unit, priority: 50 });
      },
    };
  },
};
