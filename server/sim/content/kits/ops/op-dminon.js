// server/sim/content/kits/ops/op-dminon.js — 国度 (char_4246_dminon) 自选 operator kit: 6★ 伏击客 (特种), an owned-6★ pick of the
// tier-5 and tier-6 自选 slots; every skill, both talents, the trait and her module (AMB-X “空瓶罐们”) at every form. Kit
// contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Sources: character_table / skill_table / battle_equip_table of ArknightsGameData 08ba2aea (client 2.7.91, 2026-11-01),
// as built into backups.json; the battle templates of the same commit (battle/buff_template_data.json: dminon_t_1,
// dminon_t_1[target] / [dmg], dminon_t_2 / [dead], dminon_s_1 / [mark], dminon_s_2 / [unevadeable], dminon_s_3 /
// [ally] / [spread]) and her prefabs in the local client (charpack/char_4246_dminon: the CommonAbility "Kingdom" — the
// ground enemies of her range, its tile effect dminon_talent_range_01 —, the talent and trait buffs, the modes;
// [uc]skills.ab skchr_dminon_1/2/3: each skill buff's trigger interval and its blackboard; [uc]projectiles.ab
// projectile_chr_dminon_dead / _withdraw). The official mode never fielded her: [ASSUMED] marks what neither settles.
// - “国度” is her current attack range — the ability's range carries no range id of its own, and S2 judges "“国度”上的敌人"
//   with the current mode's range (`_useCurrentModeRange`) — widened during S3 by the tiles it spreads to (her range's
//   extra keys, Battle.setExtraRange). An enemy is on it as it is in her range (the collider rule of every range
//   [ASSUMED]); the ground ones only (the selector's WALK_ONLY).
// - Trait (伏击客) "对攻击范围内所有敌人造成伤害；拥有50%的物理和法术闪避且不容易成为敌人的攻击目标": the stalker profile — every
//   ground enemy of her range at once, melee, physical — and 50 % physical / arts dodge (trait bb prob, the client's
//   evade template). Her taunt level −1 is in her data stats already: the kit installs the dodge without the profile's
//   own extra −1, as 阿斯卡纶's kit.
// - T1 实质坍缩 (dminon_t_1: a trigger every 1 s from her deployment, the first at once): every ground enemy on 国度 gets
//   for 1 s ASPD + attack_speed (−15; AMB-X stage 3: −20) — one per enemy whatever the number of 国度 (the derived buff
//   is not per source: the strongest holds) — and takes atk_scale × her current ATK as arts damage (13 %; stage 3: 20 %;
//   AdvancedApplyDamage MAGICAL, attack type NORMAL, applied MELEE — no 持续伤害 tag).
// - T2 此身为界 (dminon_t_2): when she is knocked out (ON_OWNER_KILLED) — and when she otherwise leaves the field, a 撤退
//   (ON_OWNER_FINISH, once: the `Boomed` flag) — a projectile lands 0.6 s later (_delayToStart) on 国度: every ground enemy
//   there is stunned `stun` s and takes atk_scale × her cached ATK as arts damage. The text says only "撤退时"; the
//   template fires on the knock-out too, which the kit follows. Not on the 突袭 jump ('raid': the owner's decision of
//   2026-11-02) nor on the 联防 setup (FORCED_EXIT). 国度 and ATK are those of her last tick on the field [ASSUMED: the skill
//   that ends with her still counts].
// - S1 停步 (MANUAL, data DEFAULT): ASPD + attack_speed; every 0.15 s (the first 0.15 s after the cast) each ground enemy on
//   国度 not yet marked by this cast is marked and 停顿 for `sluggish` s ("首次踏上": the mark lasts the skill —
//   _finishDerivedBuffIfParentFinish).
// - S2 受戮 (MANUAL, ACTIVE_RANGE): range y-3, ATK + atk; every 0.15 s from the cast the ground enemies of her range cannot
//   dodge physical / arts damage for 0.2 s (whoever deals it: SetIgnoreCancelReasonMask MISS on their incoming damage;
//   the engine's 'dodge' cancellation). From her second use (`_extraBuffs`, dminon_s_2[second]) also ASPD + attack_speed
//   and an infinite duration (its time held full). The count is the battle's casts [ASSUMED: a redeploy keeps it].
// - S3 无人的国度 (MANUAL, ACTIVE_RANGE): range y-10, ATK + atk, ASPD + attack_speed; her attacks strike every ground enemy on
//   国度 (the trait over the widened range). A unit of our side on 国度 hit by a ground enemy (any damage but HP loss; not
//   by one in its disappear state) — at most once per attack@cd s per unit (the [cd] buff on the unit) — spreads 国度 over
//   the x-5 cross around the source's tile and deals attack@aoe_atk_scale × her ATK physical to the ground enemies there
//   (AOEDamage x-5). The [ally] buff is resampled every 0.15 s; the kit tests the unit's tile at the hit [ASSUMED: the
//   same within one interval]. "技能结束后，重置场上的“国度”状态": the spread goes at the skill's end.
// - Module AMB-X 空瓶罐们 (stage 1 / 3): the attributes (data), "攻击范围内所有敌人移动速度-20%" (hidden talent move_speed):
//   every enemy of her current range, air units too, moves ×(1 + move_speed), one slow per 国度 (伏击客 X modules stack:
//   阿斯卡纶's kit, PRTS); stage 3 changes T1 (attack_speed −20, atk_scale 0.2: the talent's own blackboard).
// fx: 'zone' on each 国度 tile (renewed while it lasts: KINGDOM_FX_HOLD) and a keyed 'domain' field with the whole of
// her range every DOMAIN_FX_IV s (the darkened tile field of render/fx/zones.js domainField, Stardust fork b3f13f31;
// both read 国度, neither replaces the other), 'aoe' on each tile S3 spreads to and each tile T2 strikes (FX_BINDINGS
// skchr_dminon_*: dminon_talent_range_01 / dminon_talent_range_hit_01).

import { num, talentBb, moduleBb, traitBb, skillRec, up } from '../shared/tier1.js';
import { COLS, ROWS, TICK } from '../../../constants.js';

const S1 = 'skchr_dminon_1', S2 = 'skchr_dminon_2', S3 = 'skchr_dminon_3';
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
const ANY = Object.freeze({ canHitFly: true });
/** The skill buffs' trigger interval (skchr_dminon_1/2, dminon_s_3[ally]: triggerInterval 0.15). */
const SKILL_IV = 0.15;
/** dminon_t_1: triggerInterval 1, its [target] / [atk_speed] buffs lifeTime 1 (one sim tick more: no gap between two). */
const T1_IV = 1;
const T1_LIFE = 1 + TICK;
/** dminon_s_2[unevadeable]: lifeTime 0.2. */
const UNEVADE_LIFE = 0.2;
/** projectile_chr_dminon_dead / _withdraw: _delayToStart 0.6. */
const BURST_DELAY = 0.6;
/** range_table x-5: the tile and the four next to it. */
const X5 = Object.freeze([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]);
/** 'zone' fx of a 国度 tile: held this long, renewed when less than KINGDOM_FX_RENEW is left. */
const KINGDOM_FX_HOLD = 3;
const KINGDOM_FX_RENEW = 1;
/** The 国度 on screen: her field's tiles in a keyed 'domain' fx this often (render/fx/zones.js domainField, as
 *  “邪魔的利刃”'s 3×3 — Stardust fork b3f13f31). */
const DOMAIN_FX_IV = 0.5;
/** AMB-X slow: the kits' range-aura convention (refresh period / length). */
const AURA_IV = 0.25;
const AURA_DUR = 0.4;
/** Death reasons that fire 此身为界: the knock-out, a 撤退. */
const BURST_EXITS = new Set(['killed', 'retreat']);
export const UNEVADE_KEY = 'dminon:unevadeable';
const T1_ASPD = 'dminon:t1:aspd';
const S2_SECOND = 'dminon:s2:second';
const S3_CD = 'dminon:s3:cd';
export const TAG_FIELD = 'dminon:kingdom', TAG_BURST = 'dminon:burst', TAG_SPREAD = 'dminon:spread';

const stateOf = (unit) => (unit.mem.dminon ??= { t1At: 0, keys: [], atk: 0, fx: new Map(), marks: null, s1At: 0, s2At: 0, s2Endless: false, spread: null, boomed: false });
const tileOf = (k) => [Math.floor(k / COLS), k % COLS];
/** The ground enemies on 国度. */
const onKingdom = (battle, unit, keys = unit.rangeKeys) => battle.enemiesInKeys(keys || [], unit, GROUND);

// ---- S2: one battle-wide handler — incoming damage of an enemy marked unevadeable ignores the dodge -------------------
const UNEVADE = new WeakSet();
function installUnevade(battle) {
  if (UNEVADE.has(battle)) return;
  UNEVADE.add(battle);
  battle.on('hit', ({ target, dmg }) => {
    if (!target || target.side !== 'enemy' || !dmg || (dmg.type !== 'phys' && dmg.type !== 'arts') || !target.findBuff(UNEVADE_KEY)) return;
    const list = Array.isArray(dmg.ignoreCancelReasons) ? dmg.ignoreCancelReasons : [];
    if (!list.includes('dodge')) dmg.ignoreCancelReasons = [...list, 'dodge'];
  });
}

function installKingdom(battle, unit, t0) {
  const m = stateOf(unit);
  const scale = num(t0.atk_scale), aspd = Math.abs(num(t0.attack_speed));
  // The field on screen (no gameplay part): her range's tiles every DOMAIN_FX_IV s, keyed by the unit so the renderer
  // updates one field in place and fades it once she has left (render/fx/zones.js domainField). The per-tile 'zone'
  // events in the tick below stay: both read 国度 (Stardust fork b3f13f31).
  battle.every(DOMAIN_FX_IV, () => {
    if (!up(unit) || !unit.rangeKeys?.length) return;
    battle.fx('domain', { x: unit.x, y: unit.y, id: unit.id, key: `domain:${unit.id}`, tiles: unit.rangeKeys.map(tileOf), dur: 1.5 * DOMAIN_FX_IV });
  }, { owner: unit, immediate: true });
  battle.on('deploy', ({ unit: u }) => {
    if (u !== unit) return;
    m.t1At = battle.time;
    m.boomed = false;
    m.fx.clear();
  }, { owner: unit });
  battle.on('tick', () => {
    if (!up(unit)) return;
    const keys = unit.rangeKeys || [];
    m.keys = keys.slice();
    m.atk = unit.s.atk;
    const now = battle.time;
    for (const k of keys) {
      if ((m.fx.get(k) ?? -Infinity) > now + KINGDOM_FX_RENEW) continue;
      const [r, c] = tileOf(k);
      battle.fx('zone', { x: c, y: r, radius: 0.5, dur: KINGDOM_FX_HOLD, id: unit.id, skill: 'dminon_kingdom' });
      m.fx.set(k, now + KINGDOM_FX_HOLD);
    }
    if (now < m.t1At - 1e-9) return;
    m.t1At += T1_IV;
    for (const e of onKingdom(battle, unit, keys)) {
      if (aspd > 0) battle.applyStrongest(e, T1_ASPD, { duration: T1_LIFE, value: aspd, mods: (v) => ({ aspd: -v }), source: unit });
      if (scale > 0) battle.dealDamage({ source: unit, target: e, amount: unit.s.atk * scale, type: 'arts', attackType: 'NORMAL', applyWay: 'MELEE', tags: ['talent', TAG_FIELD] });
    }
  }, { owner: unit });
}

function installBurst(battle, unit, t1) {
  const m = stateOf(unit);
  const scale = num(t1.atk_scale), stun = num(t1.stun);
  battle.on('death', (c) => {
    if (c.unit !== unit || !BURST_EXITS.has(c.reason) || m.boomed) return;
    m.boomed = true;
    const keys = m.keys.slice(), atk = m.atk;
    m.fx.clear();
    battle.after(BURST_DELAY, () => {
      for (const k of keys) {
        const [r, c2] = tileOf(k);
        battle.fx('aoe', { x: c2, y: r, radius: 0.5, id: unit.id, dmgType: 'arts', skill: 'dminon_burst' });
      }
      for (const e of onKingdom(battle, unit, keys)) {
        if (stun > 0) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
        if (scale > 0) battle.dealDamage({ source: unit, target: e, amount: atk * scale, type: 'arts', attackType: 'NORMAL', applyWay: 'NONE', tags: ['talent', TAG_BURST] });
      }
    }, { owner: unit });
  }, { owner: unit });
}

/** S3: a unit of our side on 国度, hit by a ground enemy, spreads it over the x-5 cross around the source. */
function installSpread(battle, unit, b3) {
  const m = stateOf(unit);
  const cd = num(b3['attack@cd'], 0.5), scale = num(b3['attack@aoe_atk_scale']);
  battle.on('damaged', (ctx) => {
    const t = ctx.target, src = ctx.source, sk = unit.skill;
    if (!m.spread || !sk?.active || sk.id !== S3 || !up(unit)) return;
    if (!t || t.side !== 'ally' || !t.alive || !t.deployed || t.kind === 'device' || ctx.dmg?.tags?.includes('hpLoss')) return;
    if (!src || src.side !== 'enemy' || src.isFlying || !src.alive || src.hidden) return;
    if (!unit.rangeKeySet?.has(t.tileR * COLS + t.tileC) || t.findBuff(S3_CD)) return;
    battle.addBuff(t, { key: S3_CD, duration: cd, source: unit, tags: ['skill'] });
    const r0 = Math.round(src.y), c0 = Math.round(src.x), cross = [];
    for (const [dr, dc] of X5) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
      const k = r * COLS + c;
      cross.push(k);
      m.spread.add(k);
      battle.fx('aoe', { x: c, y: r, radius: 0.5, id: unit.id, dmgType: 'phys', skill: 'dminon_spread' });
    }
    battle.setExtraRange(unit, [...m.spread]);
    if (scale > 0) {
      for (const e of battle.enemiesInKeys(cross, unit, GROUND)) {
        battle.dealDamage({ source: unit, target: e, amount: unit.s.atk * scale, type: 'phys', attackType: 'NORMAL', applyWay: 'MELEE', isSkill: true, tags: ['skill', TAG_SPREAD] });
      }
    }
  }, { owner: unit });
}

const grid = (rec) => (rec?.rangeGrid ? { rangeGrid: rec.rangeGrid.map((p) => [p[0], p[1]]) } : undefined);

export default {
  char_4246_dminon: (bb, chess) => {
    const r1 = skillRec(chess, S1), r2 = skillRec(chess, S2), r3 = skillRec(chess, S3);
    const b1 = r1?.bb ?? {}, b2 = r2?.bb ?? {}, b3 = r3?.bb ?? {};
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const hidden = moduleBb(chess);
    const dodge = num(traitBb(chess).prob, 0.5);
    const picked = chess?.skill?.skillId ?? null;
    return {
      trait: {
        // 伏击客: the dodge; the taunt level −1 is in her stats (no second −1)
        install(battle, unit) {
          const p = num(unit.profile?.dodge, dodge);
          if (p > 0) battle.addBuff(unit, { key: 'trait:stalker', mods: { dodgePhys: p, dodgeArts: p }, persist: true, allowDead: true });
        },
      },
      skills: {
        [S1]: {
          kind: 'duration', mods: { aspd: num(b1.attack_speed) },
          onStart({ battle, unit }) { const m = stateOf(unit); m.marks = new Set(); m.s1At = battle.time + SKILL_IV; },
          onTick({ battle, unit }) {
            const m = stateOf(unit);
            if (!m.marks || battle.time < m.s1At - 1e-9) return;
            m.s1At += SKILL_IV;
            for (const e of onKingdom(battle, unit)) {
              if (m.marks.has(e)) continue;
              m.marks.add(e);
              battle.applyStatus(e, 'sluggish', { duration: num(b1.sluggish), source: unit });
            }
          },
          onEnd({ unit }) { stateOf(unit).marks = null; },
        },
        [S2]: {
          kind: 'duration', mods: { atkPct: num(b2.atk) }, targeting: grid(r2),
          onStart({ battle, unit, skill }) {
            installUnevade(battle);
            const m = stateOf(unit);
            m.s2At = battle.time;
            m.s2Endless = skill.activations >= 2;
            if (m.s2Endless) {
              const v = num(b2.attack_speed);
              if (v) battle.addBuff(unit, { key: S2_SECOND, mods: { aspd: v }, tags: ['skill'] });
            }
          },
          onTick({ battle, unit, skill }) {
            const m = stateOf(unit);
            // 持续时间无限: the time is held full (a finite timeLeft: the bar stays full, the engine's invariants hold)
            if (m.s2Endless) skill.timeLeft = Math.max(skill.timeLeft, skill.duration);
            if (battle.time < m.s2At - 1e-9) return;
            m.s2At += SKILL_IV;
            for (const e of onKingdom(battle, unit)) battle.addBuff(e, { key: UNEVADE_KEY, duration: UNEVADE_LIFE, source: unit, tags: ['skill'] });
          },
          onEnd({ battle, unit }) { stateOf(unit).s2Endless = false; battle.removeBuff(unit, S2_SECOND); },
        },
        [S3]: {
          kind: 'duration', mods: { atkPct: num(b3.atk), aspd: num(b3.attack_speed) }, targeting: grid(r3),
          onStart({ unit }) { stateOf(unit).spread = new Set(); },
          onEnd({ battle, unit }) {
            stateOf(unit).spread = null;
            battle.setExtraRange(unit, null);
          },
        },
      },
      talents: [
        { install(battle, unit) { installKingdom(battle, unit, t0); } },
        { install(battle, unit) { installBurst(battle, unit, t1); } },
      ],
      install(battle, unit) {
        // AMB-X: every enemy of her range moves ×(1 + move_speed), one slow per 国度 (伏击客 X modules stack)
        const mx = num(hidden.move_speed);
        if (mx < 0) {
          const key = `dminon:ambx#${unit.id}`;
          battle.every(AURA_IV, () => {
            if (!up(unit)) return;
            for (const e of battle.enemiesInKeys(unit.rangeKeys, unit, ANY)) battle.addBuff(e, { key, duration: AURA_DUR, mods: { moveMul: Math.max(0, 1 + mx) }, source: unit, tags: ['module'] });
          }, { owner: unit, immediate: true });
        }
        if (picked === S3) installSpread(battle, unit, b3);
      },
    };
  },
};
