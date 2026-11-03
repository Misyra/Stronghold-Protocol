// server/sim/content/kits/ops/op-ash.js — 灰烬 (char_456_ash) 自选 operator kit: 6★ 速射手 (狙击), a collab pick of the tier-5
// and tier-6 自选 slots (data/backups.json `diy.excluded`: offered only in a room whose host turned on 联动干员); every skill,
// both talents, the trait and both modules (MAR-Y “破墙榴弹战术收纳包”, MAR-X “刺针式合金爆破弹”) at every form. Kit contract and
// the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_456_ash): normal = E2 Lv1, skills at rank 4, no module; elite = E2 Lv60, rank 7, the
// picked module at stage 1 (tier 5) or 3 (tier 6). Full potential. Sources: character_table / skill_table /
// battle_equip_table (zh_CN, as built into backups.json); PRTS 灰烬 (备注 quoted below); the client's battle data: charpack
// char_456_ash (the flash_bomb ability under Others/Direction: selector of her attack, _preDelay 0.233 s, projectile
// projectile_chr_ash_t1 — speed 10, range circle 1.0, `stun` from the blackboard, no damage —, modes Default / S1 / S2 — S2's
// attack counts 31 shots, `_triggerTimeCount`), skills skchr_ash_1–3, buff templates ash_t_2, ash_s_2[trigger_ability] /
// [atk_scale] / [interrupt], ash_e_t_10, ash_e_003_t[damage_scale], ash_e_003_trait (battle/buff_template_data.json at the
// pinned commit 17759cc8), projectile_chr_ash_s3 (speed 10, collider 1.2, every enemy once).
// - Trait (速射手) "优先攻击空中单位": ranged physical arrows (projectile_chr_ash, speed 15), 3-4 range, hits air units, blocks 1;
//   the fly-first target order and MAR-X's ×atk_scale on her attacks against air units are the profession layer's
//   (professions.js fastshot: priority 'fly', flyScale) — the kit adds MAR-X only to the damage it deals itself (S3), as
//   ash_e_003_trait is an ON_CALCULATE_DAMAGE of every damage she calculates.
// - Module MAR-Y "范围内存在地面敌人时攻击速度+8" (hidden module talent attack_speed; ash_e_t_10): ASPD +attack_speed while a
//   ground enemy stands in her current range (shared/tier3.js groundAspd, as 空弦 / 能天使 MAR-Y — content/traitMods.js leaves
//   that line to the kits). Stage 2+: 突击手 "首次部署时部署费用-5" (no effect, below).
// - Module MAR-X "攻击空中单位时攻击力提升至110%" (trait bb atk_scale). Stage 2+ (stage 3 here): 辅助装备 "…晕眩6秒，且6秒内灰烬对这些
//   敌人造成的物理伤害提升10%" (talent bb stun, scale_duration, damage_scale; ash_e_003_t[damage_scale]: ON_TAKE_DAMAGE on each
//   stunned enemy, DamageScale PHYSICAL when the damage's source is her) — a final ×damage_scale (dmg.mul) on her physical
//   damage to an enemy her flashbang struck, for scale_duration s.
// - T1 辅助装备 "部署后立即对攻击范围内一个敌人投掷闪光弹，使其和周围敌人晕眩4秒": at each deployment (not a 【移动】), FLASH_DELAY
//   s later (the ability's _preDelay), she throws a flashbang at the first enemy of her attack order in her range (ground or
//   air: the selector's _targetMotion 3), chosen as the ability starts — PRTS 备注 "攻击范围内无可选目标时，无法触发本天赋": with
//   none at that moment, nothing happens (it does not wait for one). In this mode the battle starts with the board deployed and the enemies still to come, so the
//   talent mostly acts through S2 (and a redeployment). The shell (FLASH_SPEED, homing, lands where its target was if that
//   one fell) stuns every selectable enemy within FLASH_RADIUS of its landing point (PRTS "闪光弹影响半径为1"; ground and air;
//   the enemy's centre [ASSUMED: PRTS names no 碰撞箱]) `stun` s. It deals no damage (the ability's atk scale is 0).
// - T2 突击手 "首次部署时部署费用-3，部署后立即获得20（+3）技力" (full potential: sp 20; runtime_cost −3): ash_t_2 checks the build
//   count (CheckBuildCnt ≤ 1) before ModifySp, so the SP comes with her first deployment of the battle only; PRTS 备注 "费用减少
//   效果于战斗开始后生效至待部署区的灰烬自己，于灰烬首次部署后失效" — the first deployment of a battle costs nothing in this mode ⇒ no
//   effect (as 推进之王's SOL-Y, op-siege.js).
// - S1 支援射击 (AUTO, 52 / 49 SP, infinite: the skill's switch_mode buff has no life time): ATK +atk, each attack fires
//   attack@times (2) shots (the S1 mode's attack, _triggerDelta 0.05 s between them — both land in the attack here). It acts on
//   herself (_allowNoTarget): it is cast as soon as its SP is full (the owner's AUTO rule, kits/README.md checklist 5).
// - S2 突击战术 (MANUAL, the data's DEFAULT): "立即触发第一天赋" (ash_s_2[trigger_ability]: the flash_bomb ability at once — PRTS 备注
//   "无天赋可选目标也可开启技能": the skill opens anyway), base attack time + base_attack_time s (−0.8: batMod), and ATK raised to
//   ash_s_2[atk_scale].atk_scale on everything she calculates against a 晕眩 target (ash_s_2[atk_scale]: ON_CALCULATE_DAMAGE,
//   CheckAbnormalFlag STUNNED — the catalogue stun, as op-cqbw.js reads STUNNED; _applyWay ALL); an ammo skill of S2_ROUNDS
//   shots (the S2 mode's counter). PRTS 备注 "因弹药数打完而导致当次技能自动结束后，下次开启技能时装有的弹药数将少1发（变为30/31发弹药）;
//   若手动在0弹药情况下关闭技能，下次技能弹药数将依旧为正常的31发": a cast after one that ran out of ammo holds one shot fewer
//   (the auto-battle never closes it by hand) — not cumulative, and reset by a redeployment [ASSUMED].
// - S3 攻坚榴弹 (MANUAL, the data's SKILL_RANGE on its 1×5 line; skchr_ash_3 _maxTriggerTime 2: "每次部署只能释放2次" — a third
//   cast of a deployment is refused and its SP waits [ASSUMED: the client greys the skill]): cast like an attack
//   (_shouldCastLikeAttack: the attack it is cast for fires the breach round instead), towards her facing
//   (_forceFaceToDirection). The round (projectile_chr_ash_s3, SHELL_SPEED) hits every selectable enemy (ground and air:
//   _targetMotion 3) its collider meets once — PRTS 备注 "破墙弹推动半径1.2（碰撞箱判定）" — for atk_scale × ATK physical and pushes it
//   with 力度 `force` along her facing (knockback[dir]: 中力 / 较大力); PRTS 备注 "破墙弹由地面地形飞向高台或者地图边界时，在地块边界
//   中点上爆炸；没有任何阻挡的情况下，将在自身面前第4格的中心处爆炸" and the skill text "从低地撞到高台直接爆炸且造成660%": leaving a LOW
//   tile for a HIGH one, or reaching the edge of the map (from any tile [ASSUMED]), it bursts on that tile edge for
//   hitwall_scale × ATK (hit_wall_flag; the edge counts as the wall [ASSUMED: the 备注 names both]; a HIGH tile entered from
//   a HIGH one — her own 高台 — does not stop it), else on the centre of the 4th tile ahead for not_hitwall_scale × ATK —
//   physical, to every selectable enemy within BLAST_RADIUS of the point (PRTS "爆炸半径1.5（中点判定）"; bb range_radius). Her
//   ATK is the one at the cast [ASSUMED].

import { num, talentBb, moduleBb, traitBb, up, skillRec, batMod } from '../shared/tier1.js';
import { groundAspd } from '../shared/tier3.js';
import { sortEnemyTargets, canTargetEnemy } from '../../../targeting.js';
import { hasHp } from '../../../attack.js';
import { dirVec } from '../../../dir.js';
import { hypot } from '../../../detmath.js';

const S1 = 'skchr_ash_1';
const S2 = 'skchr_ash_2';
const S3 = 'skchr_ash_3';
/** The flash_bomb ability's _preDelay (s). */
export const FLASH_DELAY = 0.233;
/** projectile_chr_ash_t1 _speed (tiles / s). */
export const FLASH_SPEED = 10;
/** PRTS 备注 "闪光弹影响半径为1" (projectile_chr_ash_t1's range circle 1.0). */
export const FLASH_RADIUS = 1;
/** projectile_chr_ash_s3 _speed. */
export const SHELL_SPEED = 10;
/** PRTS 备注 "破墙弹推动半径1.2（碰撞箱判定）" (the projectile's CircleCollider2D 1.2). */
export const SHELL_RADIUS = 1.2;
/** PRTS 备注 "没有任何阻挡的情况下，将在自身面前第4格的中心处爆炸". */
export const SHELL_REACH = 4;
/** PRTS 备注 "爆炸半径1.5（中点判定）" (bb range_radius). */
export const BLAST_RADIUS = 1.5;
/** S2's magazine: the S2 mode's attack counter (_triggerTimeCount 31; the skill text "攻击装有31发子弹"). */
export const S2_ROUNDS = 31;
/** skchr_ash_3 _maxTriggerTime: casts per deployment. */
export const S3_USES = 2;
const AIR = Object.freeze({ canHitFly: true });
const MARK_KEY = 'ash:flash';
const S3_TAG = 'ash:s3';

/** ash state of a unit (deployments of the battle, S2's next magazine, S3's casts of this deployment, shot ids). */
const stateOf = (unit) => unit.mem.ash ?? (unit.mem.ash = { builds: 0, s2Short: false, s3Used: 0, shot: 0 });

/** The first enemy of her attack order in her range (ground or air), or null. */
function flashTarget(battle, unit) {
  const pool = battle.enemiesInKeys(unit.rangeKeys, unit, AIR);
  for (const e of battle.blockedTargets(unit, AIR)) if (!pool.includes(e)) pool.push(e);
  if (!pool.length) return null;
  sortEnemyTargets(battle, unit, pool, unit.profile?.priority ?? null); // her attack's order (速射手: flyers first)
  return pool[0];
}

/**
 * 辅助装备's flashbang (T1 and S2): the ability starts only with a selectable enemy in her range (its Trigger, _minTargetNum
 * 1 — PRTS "攻击范围内无可选目标时，无法触发本天赋"), picks the first of her order then and throws at it FLASH_DELAY s later (at the
 * new first one should it have fallen meanwhile [ASSUMED]).
 */
function flashbang(battle, unit, t0) {
  const stun = num(t0.stun), scale = num(t0.damage_scale, 1), keep = num(t0.scale_duration);
  if (!(stun > 0) && !(scale > 1)) return;
  const first = flashTarget(battle, unit);
  if (!first) return; // 攻击范围内无可选目标时，无法触发本天赋
  const seq = unit.deploySeq;
  battle.after(FLASH_DELAY, () => {
    if (!up(unit) || unit.deploySeq !== seq) return;
    const target = first.alive && !first.hidden ? first : flashTarget(battle, unit);
    if (!target) return;
    const m = stateOf(unit);
    const flame = `${unit.id}:f${++m.shot}`;
    const t = hypot(target.x - unit.x, target.y - unit.y) / FLASH_SPEED;
    battle.fx('ashFlashDash', { x: unit.x, y: unit.y, tx: target.x, ty: target.y, t, id: unit.id, flame });
    battle.addProjectile({
      from: { x: unit.x, y: unit.y }, target, speed: FLASH_SPEED, visual: 'none', source: unit, hitDead: true,
      onHit: ({ x, y }) => {
        battle.fx('ashFlashBlast', { x, y, r: FLASH_RADIUS, id: unit.id, flame });
        for (const e of battle.foesInRadius(x, y, FLASH_RADIUS, true)) {
          if (!canTargetEnemy(unit, e, AIR)) continue;
          if (stun > 0 && hasHp(e)) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
          // MAR-X stage 3: her physical damage to it ×damage_scale for scale_duration s
          if (scale > 1 && keep > 0 && e.alive) battle.addBuff(e, { key: `${MARK_KEY}:${unit.id}`, source: unit, duration: keep, refresh: 'replace', tags: ['debuff'] });
        }
      },
    });
  }, { owner: unit });
}

/** S3: the breach round from her tile towards her facing (see the header). */
function fireShell(battle, unit, b3) {
  const [dr, dc] = dirVec(unit.dir);
  const m = stateOf(unit);
  const flame = `${unit.id}:s${++m.shot}`;
  const from = { x: unit.tileC, y: unit.tileR };
  const to = { x: from.x + dc * SHELL_REACH, y: from.y + dr * SHELL_REACH };
  battle.fx('ashShellDash', { x: from.x, y: from.y, tx: to.x, ty: to.y, t: SHELL_REACH / SHELL_SPEED, id: unit.id, flame });
  battle.addProjectile({
    from, to, speed: SHELL_SPEED, visual: 'none', source: unit, maxAge: SHELL_REACH / SHELL_SPEED + 1,
    data: {
      ashShell: unit, flame, dr, dc, atk: unit.s.atk, hit: new Set(), done: false,
      r: from.y, c: from.x, low: battle.grid.isLow(from.y, from.x),
    },
    onHit: ({ projectile: p }) => { if (!p.data.done) shellBurst(battle, unit, b3, p.data, to.x, to.y, false); },
  });
}

/** The round bursts at (x, y): `wall` = it struck high ground / the map edge from the ground (hitwall_scale). */
function shellBurst(battle, unit, b3, d, x, y, wall) {
  d.done = true;
  const scale = num(wall ? b3.hitwall_scale : b3.not_hitwall_scale);
  battle.fx('ashShellBlast', { x, y, r: BLAST_RADIUS, id: unit.id, flame: d.flame, wall: wall || undefined });
  for (const e of battle.foesInRadius(x, y, BLAST_RADIUS, true)) {
    if (!canTargetEnemy(unit, e, AIR)) continue;
    battle.dealDamage(unit, e, { amount: d.atk * scale, type: 'phys', isSkill: true, tags: ['skill', S3_TAG, wall ? 'ash:wall' : 'ash:blast'] });
  }
}

/** S3's round in flight (one handler per unit): the wall / edge test, then the path hits with their push. */
function installShell(battle, unit, b3) {
  const force = Math.round(num(b3.force, 1)), path = num(b3.atk_scale);
  battle.on('projectileStep', (ctx) => {
    const p = ctx.projectile, d = p.data;
    if (d?.ashShell !== unit || d.done) return;
    const r = Math.round(p.y), c = Math.round(p.x);
    if (r !== d.r || c !== d.c) {
      // the next tile: off the map, or high ground entered from a low tile ⇒ it bursts on the tile edge it crossed
      const edge = { x: d.c + d.dc * 0.5, y: d.r + d.dr * 0.5 };
      const off = !battle.grid.inRect(r, c);
      if (off || (d.low && !battle.grid.isLow(r, c))) {
        ctx.cancel = true;
        p.x = edge.x; p.y = edge.y;
        hitPath(battle, unit, d, p.x, p.y, path, force);
        shellBurst(battle, unit, b3, d, edge.x, edge.y, true);
        return;
      }
      d.r = r; d.c = c; d.low = battle.grid.isLow(r, c);
    }
    hitPath(battle, unit, d, p.x, p.y, path, force);
  }, { owner: unit });
}

/** The round's collider meets enemies at (x, y): each once, atk_scale × ATK physical and a push along her facing. */
function hitPath(battle, unit, d, x, y, scale, force) {
  for (const e of battle.foesInColliderRadius(x, y, SHELL_RADIUS)) {
    if (d.hit.has(e) || !canTargetEnemy(unit, e, AIR)) continue;
    d.hit.add(e);
    battle.dealDamage(unit, e, { amount: d.atk * scale, type: 'phys', isSkill: true, tags: ['skill', S3_TAG, 'ash:path'] });
    if (hasHp(e) && force > -3) battle.push(e, force, { from: unit, dir: { x: d.dc, y: d.dr } });
  }
}

export default {
  char_456_ash: (bb, chess) => {
    const t0 = talentBb(chess, 0);   // 辅助装备: stun (MAR-X stage 3: + scale_duration, damage_scale)
    const t1 = talentBb(chess, 1);   // 突击手: sp, runtime_cost (no effect)
    const hidden = moduleBb(chess);  // MAR-Y: attack_speed
    const flyScale = num(traitBb(chess).atk_scale, 1); // MAR-X
    const b1 = skillRec(chess, S1)?.bb ?? {}, b2 = skillRec(chess, S2)?.bb ?? {}, b3 = skillRec(chess, S3)?.bb ?? {};
    const s2Scale = num(b2['ash_s_2[atk_scale].atk_scale'], 1);
    return {
      skills: {
        [S1]: {
          kind: 'toggle', trigger: 'SP_FULL',
          mods: { atkPct: num(b1.atk) },
          attack: { hits: Math.max(1, Math.floor(num(b1['attack@times'], 2))) },
        },
        [S2]: {
          kind: 'ammo', ammo: S2_ROUNDS,
          mods: { batPct: batMod(b2.base_attack_time, chess) },
          onStart({ battle, unit, skill }) {
            const m = stateOf(unit);
            if (m.s2Short) { skill.ammoLeft = Math.max(1, S2_ROUNDS - 1); skill.ammoMax = skill.ammoLeft; }
            flashbang(battle, unit, t0); // 立即触发第一天赋
          },
          onEnd({ unit, reason }) { stateOf(unit).s2Short = reason === 'ammo'; },
        },
        [S3]: {
          kind: 'instant',
          onStart({ battle, unit }) {
            const m = stateOf(unit);
            m.s3Used++;
            unit.mem.ashCastAt = battle.time; // this attack fires the round instead
            fireShell(battle, unit, b3);
          },
        },
      },
      talents: [
        { install(battle, unit) { // 辅助装备 (+ MAR-X stage 3's mark)
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit || ctx.move) return;
            flashbang(battle, unit, t0);
          }, { owner: unit });
          const scale = num(t0.damage_scale, 1);
          if (scale > 1) {
            const key = `${MARK_KEY}:${unit.id}`;
            battle.on('hit', (ctx) => {
              const e = ctx.target, d = ctx.dmg;
              if (ctx.source !== unit || !e || e.side !== 'enemy' || !d || d.type !== 'phys' || !e.findBuff(key)) return;
              d.mul *= scale;
            }, { owner: unit });
          }
        } },
        { install(battle, unit) { // 突击手: SP with her first deployment of the battle (ash_t_2 CheckBuildCnt ≤ 1)
          const sp = num(t1.sp);
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit || ctx.move) return;
            const m = stateOf(unit);
            m.builds++;
            m.s2Short = false;
            m.s3Used = 0;
            if (m.builds === 1 && sp > 0 && unit.skill && !unit.skill.noSkill) unit.skill.gainSp(sp, 'init');
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        const sid = unit.skill?.id;
        // MAR-Y: 范围内存在地面敌人时攻击速度+8
        if (num(hidden.attack_speed) > 0) groundAspd('trait:ash:ground', num(hidden.attack_speed))(battle, unit);
        // MAR-X on the damage she deals herself (her attacks: the profession layer)
        if (flyScale !== 1) {
          battle.on('damageCalculate', (c) => {
            if (c.source === unit && c.target?.isFlying && c.dmg?.tags?.includes(S3_TAG)) c.dmg.amount *= flyScale;
          }, { owner: unit });
        }
        if (sid === S2 && s2Scale !== 1) {
          // ash_s_2[atk_scale]: while S2 runs, ×atk_scale on everything she calculates against a stunned target
          battle.on('damageCalculate', (c) => {
            if (c.source !== unit || !unit.skill?.active || !c.target || c.target.side !== 'enemy' || !c.target.hasBuff('stun')) return;
            c.dmg.amount *= s2Scale;
          }, { owner: unit });
        }
        if (sid === S3) {
          installShell(battle, unit, b3);
          // cast like an attack: the attack it is cast for makes no hit of its own
          battle.on('beforeAttack', (ctx) => {
            if (ctx.attacker !== unit || unit.mem.ashCastAt !== battle.time) return;
            unit.mem.ashCastAt = null;
            ctx.targets = [];
          }, { owner: unit, priority: 100 });
          // 每次部署只能释放2次: a third cast of a deployment is refused (non-enumerable: never serialised; op-cqbw.js's pattern)
          const sk = unit.skill;
          if (sk && !Object.prototype.hasOwnProperty.call(sk, 'activate')) {
            const activate = sk.activate;
            Object.defineProperty(sk, 'activate', {
              configurable: true, writable: true, enumerable: false,
              value(reason, opts) { return stateOf(unit).s3Used < S3_USES ? activate.call(this, reason, opts) : false; },
            });
          }
        }
      },
    };
  },
};
