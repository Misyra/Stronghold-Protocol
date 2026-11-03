// server/sim/content/kits/ops/op-oblvns.js — 丰川祥子 (char_4182_oblvns) 自选 operator kit: 6★ 领主, a collab pick of the tier-5
// and tier-6 自选 slots (data/backups.json `diy.excluded`: offered only in a room with 联动干员 on); every skill, both talents and
// the LOR-Y module at every form. Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Sources: character_table / skill_table / battle_equip_table of the pinned tables as built into backups.json;
// gamedata_const termDescriptionDict (ba.permanentatk 持续攻击, ba.fever, ba.mujica); the client's skill prefabs
// (battle/prefabs/[uc]skills.ab skchr_oblvns_*: env system env_033_fever, `_tryJoinFeverOnSkillStart`, S1
// `_continusCastWhenInFever` 1 and buff `oblvns_s_1[self][no_auto_fever]`, S3 FeverAura → `oblvns_s_3[fever_undead]`); PRTS
// 丰川祥子 备注 (2026-11-02) for the note speeds, the Fever numbers and the undying rule; PRTS 卫戍协议/帮助 for the switch-type
// skill rule.
// - Trait 领主: the profession (professions.js lord: ranged attacks at atk_scale unless she blocks the target or it stands on
//   her tile / the one in front). LOR-Y stage 2+ "技能期间远程攻击不再降低攻击力" (read from the talent text) drops that
//   factor while a skill runs. The module's 「攻击范围内存在2名及以上敌人时攻击速度+12」 is the engine's (content/traitMods.js).
// - 颂乐音符: her attacks are 音符 — slow homing shots (NOTE_SPEED, PRTS "追踪速度2.0"). 持续攻击: with no target she still
//   attacks (an attack for SP and the attack cadence) and plays a 音符 forward within ±attack@angle of her facing, unless the
//   tile in front of her is impassable (PRTS); it flies FREE_SPEED and vanishes `delay` after leaving her range, and homes
//   on the first targetable enemy within TRACK_RANGE [ASSUMED: straight flight, the sine wander of PRTS is not modelled].
//   Every 音符 of hers on the field gives each Ave Mujica member of her player (MUJICA, the character_table team; she is the
//   only 6★ of it, so the only member the mode fields) def_penetrate_ratio DEF and magic_resist_penetrate_ratio RES ignore,
//   at most max_cnt notes.
// - 毋畏遗忘: operators on her attack range (her tile included) ASPD +attack_speed [ASSUMED: operators only, not summons];
//   every damage instance she deals an enemy adds `cnt` Fever (also a dodged one: counted at the hit, PRTS). The range
//   overlap with other Ave Mujica members is inert: none can be fielded.
// - Fever (env_033_fever, shared by our side): at FEVER_MAX (gamedata_const), the next skill a member starts begins Fever for
//   FEVER_SECONDS (the auto release of S1's full charges does not — `no_auto_fever`; the engine's automatic casts of a
//   MANUAL skill stand for the player's: the official strategies automate the manual 开启). During Fever the gauge does not
//   fill and is empty afterwards [ASSUMED]; members keep casting: S1 plays its 8 notes every attack interval at no SP
//   [ASSUMED: the interval of her attack], S2 double-hits, S3 cast into it ends with it (PRTS "持续类技能在Fever结束时结束";
//   one already running pauses until it ends) and while it runs every member survives one lethal hit (priority −3000,
//   PRTS) and leaves the field when Fever ends.
// - S1 新月的苏醒 (charges 2, attack SP): 8 notes spread S1_STEP° apart, arts, atk_scale … atk_scale_8, with the ATK at the
//   cast, homing on the attack target (else free notes) [ASSUMED: all on her first target; PRTS gives only the tracking
//   numbers]. No attack is replaced.
// - S2 满月的舞会: a switch-type skill — the official strategy opens it once per deployment and never switches it (PRTS
//   卫戍协议/帮助 "状态切换类技能…每次部署后仅开启一次技能"), so it stays on 钢琴: ATK +attack@atk, notes at PIANO_SPEED that pass
//   through their target and hit every enemy within PASSBY.radius of the next PASSBY.speed × passby_delay tiles once
//   (physical, the same ATK scale [ASSUMED]); during Fever two hits.
// - S3 残月的余响: duration, the skill's range (3-21); each attack plays 2 钢琴 notes (physical, attack@atk_scale) at the enemy
//   of the range with the highest RES and 2 风琴 notes (arts) at the one with the highest DEF.

import { num, talentBb, skillRec, up, installAura } from '../shared/tier1.js';
import { resolveHit, effectiveProfile } from '../../../ai.js';
import { canTargetEnemy } from '../../../targeting.js';
import { dirVec } from '../../../dir.js';
import { hypot, sin, cos, atan2 } from '../../../detmath.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_oblvns_1', S2 = 'skchr_oblvns_2', S3 = 'skchr_oblvns_3';
/** character_table team `mujica` (gamedata_const ba.mujica: 丰川祥子、八幡海铃、三角初华、祐天寺若麦、若叶睦). */
export const MUJICA = Object.freeze(new Set(['char_4182_oblvns', 'char_4183_mortis', 'char_4184_dolris', 'char_4185_amoris', 'char_4186_tmoris']));
/** gamedata_const ba.fever: "Fever累计至450点时…20秒内会持续释放当前技能". */
const FEVER_MAX = 450, FEVER_SECONDS = 20;
/** PRTS 备注 (tiles/s): a targeted note, a target-less one, S1's, S2 钢琴's, S3's. */
const NOTE_SPEED = 2, FREE_SPEED = 1.3, S1_SPEED = 2.2, PIANO_SPEED = 3.5, S3_SPEED = 1.3;
const TRACK_RANGE = 1;
const S1_STEP = 3.75;
const PASSBY = Object.freeze({ radius: 0.8, speed: 3 });
const FEVER_UNDEAD_PRIORITY = -3000;
const DEG = Math.PI / 180;

const FEVER = new WeakMap();
function feverOf(battle) {
  let f = FEVER.get(battle);
  if (!f) FEVER.set(battle, (f = { gauge: 0, until: -Infinity, undying: false, saved: new Set(), paused: new Map(), hooked: false }));
  return f;
}
/** The Fever state of a battle (`gauge`, `until`, …): read by the tests. */
export const feverState = (battle) => feverOf(battle);
export const feverOn = (battle) => feverOf(battle).until > battle.time + 1e-9;
const member = (u) => !!u && u.side === 'ally' && MUJICA.has(u.def?.charId);
const notesOf = (battle, unit) => {
  let n = 0;
  for (const p of battle.projectiles.list) if (p.source === unit) n++;
  return n;
};
const lordMul = (battle, unit, t) => (typeof unit.profile?.dmgMul === 'function' ? unit.profile.dmgMul(battle, unit, t) : 1);

/**
 * A note of hers: a homing shot on `target` (or a free one along `angle`) that runs `onLand(target, x, y)`. The sim's
 * projectiles reach no client: fx `kind` (FX_BINDINGS `flight`: 'oblvnsNote' a free note, 'oblvnsS1' / 'oblvnsOrgan' the
 * skills') draws it from her to where its target stood, in the time it needs at that speed.
 */
let noteSeq = 0;
function playNote(battle, unit, { target = null, angle = null, speed, onLand, reach = 3, delay = 1, kind = 'oblvnsNote' }) {
  const flame = `${unit.id}:note${++noteSeq}`;
  if (target) {
    const d = hypot(target.x - unit.x, target.y - unit.y);
    battle.fx(kind, { x: unit.x, y: unit.y, tx: target.x, ty: target.y, t: Math.max(0.05, d / speed), id: unit.id, flame });
    return battle.addProjectile({ from: unit, target, speed, visual: 'none', source: unit, data: { oblvnsNote: true },
      onHit: (c) => { if (c.target) onLand(c.target, c.x, c.y); } });
  }
  const dist = reach + 0.5 + FREE_SPEED * delay;
  const to = { x: unit.x + cos(angle) * dist, y: unit.y + sin(angle) * dist };
  battle.fx('oblvnsNote', { x: unit.x, y: unit.y, tx: to.x, ty: to.y, t: dist / FREE_SPEED, id: unit.id, flame });
  return battle.addProjectile({ from: unit, to, speed: FREE_SPEED, visual: 'none', source: unit, maxAge: dist / FREE_SPEED + 0.05,
    data: { oblvnsNote: true, oblvnsFree: true, speed, onLand }, onHit: (c) => { if (c.target) onLand(c.target, c.x, c.y); } });
}

/** A free note homes on the first targetable enemy within TRACK_RANGE of it (once per battle). */
function installTracking(battle) {
  const f = feverOf(battle);
  if (f.hooked) return;
  f.hooked = true;
  battle.on('projectileStep', ({ projectile: p }) => {
    const d = p.data;
    if (!d || !d.oblvnsFree || p.target) return;
    const src = p.source;
    if (!src || !src.alive) return;
    for (const e of battle.foesInRadius(p.x, p.y, TRACK_RANGE)) {
      if (!canTargetEnemy(src, e, { canHitFly: true })) continue;
      p.target = e;
      p.tseq = e.deploySeq;
      p.speed = d.speed;
      p.maxAge = p.age + 10;
      d.oblvnsFree = false;
      return;
    }
  });
}

function facingAngle(unit) {
  const [dr, dc] = dirVec(unit.dir);
  return atan2(dr, dc);
}

function rangeReach(unit) {
  let m = 1;
  for (const [, dc] of unit.rangeGrid || []) if (dc > m) m = dc;
  return m;
}

export default {
  char_4182_oblvns: (bb, chess) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const spread = num(t0['attack@angle'], 20) * DEG;
    const vanish = num(t0.delay, 1);
    const feverGain = num(t1.cnt);
    const aspd = num(t1.attack_speed);
    const noRangedCut = (chess?.talents ?? []).some((t) => typeof t?.desc === 'string' && t.desc.includes('技能期间远程攻击不再降低攻击力'));
    const s1 = skillRec(chess, S1)?.bb ?? {}, s2 = skillRec(chess, S2)?.bb ?? {}, s3 = skillRec(chess, S3)?.bb ?? {};
    const s3Grid = skillRec(chess, S3)?.rangeGrid ?? null;
    const s1Scales = ['atk_scale', 'atk_scale_2', 'atk_scale_3', 'atk_scale_4', 'atk_scale_5', 'atk_scale_6', 'atk_scale_7', 'atk_scale_8'].map((k) => num(s1[k]));

    /** An attack with no target (持续攻击): a free note forward, unless the tile in front is impassable. */
    const freeAttack = (battle, unit) => {
      const [dr, dc] = dirVec(unit.dir);
      const fr = unit.tileR + dr, fc = unit.tileC + dc;
      if (!battle.grid.inRect(fr, fc) || battle.grid.tile(fr, fc)?.pass === 'NONE') return false;
      const prof = effectiveProfile(unit);
      const angle = facingAngle(unit) + battle.rng.range(-spread, spread);
      const info = { isSkill: !!prof.isSkill, index: 0, attackId: 0 };
      playNote(battle, unit, { angle, speed: prof.projectileSpeed || NOTE_SPEED, reach: rangeReach(unit), delay: vanish,
        onLand: (t, x, y) => resolveHit(battle, unit, prof, t, info, x, y) });
      unit.lastAttackAt = battle.time;
      if (unit.skill) unit.skill.onAttackPerformed([], !!prof.isSkill);
      return true;
    };

    const volley = (battle, unit) => {
      const atk = unit.s.atk;
      const target = battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true })[0] ?? null;
      const base = facingAngle(unit);
      s1Scales.forEach((sc, i) => {
        const angle = base + (i - (s1Scales.length - 1) / 2) * S1_STEP * DEG;
        playNote(battle, unit, { target, angle, speed: S1_SPEED, reach: rangeReach(unit), delay: vanish, kind: 'oblvnsS1',
          onLand: (t) => { if (sc > 0) battle.dealDamage(unit, t, { amount: atk * sc * lordMul(battle, unit, t), type: 'arts', isSkill: true, tags: ['skill', 'note'] }); } });
      });
    };

    return {
      trait: { projectileSpeed: NOTE_SPEED, storeEnergy: freeAttack },
      skills: {
        [S1]: { kind: 'instant', onStart({ battle, unit }) { volley(battle, unit); } },
        [S2]: {
          kind: 'toggle', mods: { atkPct: num(s2['attack@atk']) },
          attack: {
            projectileSpeed: PIANO_SPEED,
            hitsFn: (battle) => (feverOn(battle) ? 2 : 1),
            onEachHit({ battle, unit, target, kind, attackId }) {
              if (kind !== 'main' || !target) return;
              const len = PASSBY.speed * num(s2['attack@passby_delay'], 0.5);
              const d = hypot(target.x - unit.x, target.y - unit.y) || 1;
              const ux = (target.x - unit.x) / d, uy = (target.y - unit.y) / d;
              const hit = new Set([target]);
              const atk = unit.s.atk;
              for (let s = 0.25; s <= len + 1e-9; s += 0.25) { // loop-cap: len / 0.25 samples
                for (const e of battle.foesInRadius(target.x + ux * s, target.y + uy * s, PASSBY.radius)) {
                  if (hit.has(e) || !canTargetEnemy(unit, e, { canHitFly: true })) continue;
                  hit.add(e);
                  battle.dealDamage(unit, e, { amount: atk * lordMul(battle, unit, e), type: 'phys', isAttack: true, isSkill: true, attackId, tags: ['skill', 'pierce'] });
                }
              }
            },
          },
        },
        [S3]: {
          kind: 'duration',
          targeting: s3Grid ? { rangeGrid: s3Grid } : undefined,
          attack: { atkScale: num(s3['attack@atk_scale'], 1), hits: 2, projectileSpeed: S3_SPEED },
          onAttack({ battle, unit }) {
            const organ = unit.mem.oblvnsOrgan;
            unit.mem.oblvnsOrgan = null;
            if (!organ || !organ.alive) return;
            const atk = unit.s.atk, sc = num(s3['attack@atk_scale'], 1);
            for (let i = 0; i < 2; i++) {
              playNote(battle, unit, { target: organ, speed: S3_SPEED, kind: 'oblvnsOrgan',
                onLand: (t) => battle.dealDamage(unit, t, { amount: atk * sc * lordMul(battle, unit, t), type: 'arts', isAttack: true, isSkill: true, tags: ['skill', 'note', 'organ'] }) });
            }
          },
        },
      },
      install(battle, unit) {
        installTracking(battle);
        const sid = unit.skill?.id;
        if (noRangedCut && unit.profile) {
          const base = unit.profile.dmgMul;
          unit.profile.dmgMul = (b, u, t) => (u.skill?.active ? 1 : (typeof base === 'function' ? base(b, u, t) : 1));
        }
        // 颂乐音符: the notes on the field → DEF / RES ignore of the members of her player
        const dp = num(t0.def_penetrate_ratio), rp = num(t0.magic_resist_penetrate_ratio), cap = Math.max(0, Math.floor(num(t0.max_cnt, 10)));
        const key = `oblvns:notes:${unit.id}`;
        let last = -1;
        battle.on('tick', () => {
          const n = Math.min(cap, notesOf(battle, unit));
          if (n === last) return;
          last = n;
          for (const a of battle.allyUnits) {
            if (!member(a) || a.ownerId !== unit.ownerId) continue;
            if (n > 0 && (dp > 0 || rp > 0)) battle.addBuff(a, { key, mods: { defIgnorePct: n * dp, resIgnorePct: n * rp }, tags: ['talent'], data: { notes: n } });
            else battle.removeBuff(a, key);
          }
        }, { owner: unit });
        // 毋畏遗忘
        if (aspd > 0) {
          installAura(battle, unit, { key: 'oblvns:aspd', value: aspd, mods: { aspd },
            select: (a) => a.kind === 'op' && !!unit.rangeKeySet?.has(a.tileR * COLS + a.tileC) });
        }
        if (feverGain > 0) {
          battle.on('hit', ({ source, target, dmg }) => {
            if (source !== unit || !target || target.side !== 'enemy' || !dmg || dmg.sourceless) return;
            if (feverOn(battle)) return;
            const f = feverOf(battle);
            f.gauge = Math.min(FEVER_MAX, f.gauge + feverGain);
          }, { owner: unit });
        }
        installFever(battle);
        // the Fever gauge under her HP bar (snapshot.js feverView, b.snap `fever`; display only): while it fills, its share of
        // FEVER_MAX; during Fever, the share of FEVER_SECONDS left
        unit.feverView = () => {
          const f = feverOf(battle);
          return feverOn(battle) ? [(f.until - battle.time) / FEVER_SECONDS, 1] : [f.gauge / FEVER_MAX, 0];
        };
        // S3: the 钢琴 notes at the highest RES, the 风琴 notes at the highest DEF of the range
        if (sid === S3) {
          battle.on('beforeAttack', (ctx) => {
            if (ctx.attacker !== unit || !unit.skill?.active) return;
            const cands = battle.enemiesInKeys(unit.rangeKeys, unit, ctx.profile);
            for (const e of battle.blockedTargets(unit, ctx.profile)) if (!cands.includes(e)) cands.push(e);
            if (!cands.length) return;
            let res = cands[0], def = cands[0];
            for (const e of cands) {
              if (e.s.res > res.s.res + 1e-9) res = e;
              if (e.s.def > def.s.def + 1e-9) def = e;
            }
            ctx.targets = [res];
            unit.mem.oblvnsOrgan = def;
          }, { owner: unit });
        }
        // S1 in Fever: the 8 notes every attack interval, at no SP
        if (sid === S1) {
          unit.mem.oblvnsVolleyAt = 0;
          battle.on('tick', () => {
            if (!feverOn(battle) || !up(unit) || !unit.canAct || unit.s.flags.silence) return;
            if (battle.time < (unit.mem.oblvnsVolleyAt ?? 0) - 1e-9) return;
            unit.mem.oblvnsVolleyAt = battle.time + Math.max(0.1, unit.s.interval);
            volley(battle, unit);
          }, { owner: unit });
        }
      },
    };
  },
};

/** Fever: started by a member's skill at a full gauge, joined by the members' later skills (once per battle). */
function installFever(battle) {
  const f = feverOf(battle);
  if (f.feverHooks) return;
  f.feverHooks = true;
  const join = (u, sk, fresh) => {
    if (!sk || sk.id !== S3 || !sk.active) return;
    if (fresh) sk.timeLeft = Math.max(0.01, f.until - battle.time);
    else if (!f.paused.has(sk)) { f.paused.set(sk, sk.timeLeft); sk.timeLeft = Infinity; }
    f.undying = true;
  };
  const end = () => {
    for (const [sk, left] of f.paused) if (sk.active) sk.timeLeft = left;
    f.paused.clear();
    f.undying = false;
    for (const u of f.saved) if (u.alive && u.deployed) battle.retreat(u, { reason: 'retreat', dying: true });
    f.saved.clear();
  };
  battle.on('skillStart', ({ unit: u, skill }) => {
    if (!member(u)) return;
    if (feverOn(battle)) { join(u, skill, skill.lastStart === battle.time); return; }
    if (f.gauge < FEVER_MAX - 1e-9) return;
    f.gauge = 0;
    f.until = battle.time + FEVER_SECONDS;
    for (const a of battle.allyUnits) {
      if (!member(a) || !up(a) || !a.skill) continue;
      join(a, a.skill, a === u);
    }
    battle.after(FEVER_SECONDS, end);
  });
  battle.on('fatal', (ctx) => {
    if (ctx.prevented || !f.undying || !feverOn(battle) || !member(ctx.unit) || f.saved.has(ctx.unit)) return;
    ctx.prevented = true;
    f.saved.add(ctx.unit);
  }, { priority: FEVER_UNDEAD_PRIORITY });
}
