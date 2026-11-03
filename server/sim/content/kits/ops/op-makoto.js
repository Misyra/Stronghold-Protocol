// server/sim/content/kits/ops/op-makoto.js — 结城理 (char_4217_makoto) 自选 operator kit: 6★ 傀儡师, a collab pick of the tier-5
// and tier-6 自选 slots (data/backups.json `diy.excluded`: offered only in a room with 联动干员 on); every skill, both talents and
// the PUM-Y module at every form. Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Sources: character_table / skill_table / battle_equip_table of the pinned tables as built into backups.json; gamedata_const
// ba.sees (S.E.E.S.: 结城理、埃癸斯、岳羽由加莉、虎狼丸), ba.weaknessatk (弱点伤害); PRTS 结城理 备注 (2026-11-02).
// - Trait 傀儡师: the profession (professions.js installDollkeeper: a lethal hit on the 本体 switches to the <替身> for the
//   trait's 20 s, HP reset, 阻回, block 0). PUM-Y: the <替身> HP + trait max_hp.
// - 不羁之力: entering the <替身> from the 本体, enemies on the persona's range (the skills' x-1 around her) are 停顿 for
//   `sluggish` s (not on a switch between personas, PRTS). In the <替身> a persona fights: range x-1, attack interval
//   +base_attack_time s (batPct of her own BAT), ATK +atk, HP +max_hp_t1; what it does follows the selected skill.
// - S.E.E.S.队长: when the <替身> ends (the switch back to the 本体; not when it is knocked out), every S.E.E.S. member of
//   our side on the field strikes every enemy on x-1 around it — air units too — for atk_scale × her ATK (the 本体's, no
//   persona bonus) true damage; only she can be fielded [ASSUMED: at once, the 1 s switch animation covers the
//   invulnerability PRTS describes].
// - Skills (MANUAL, the data's SKILL_RANGE on x-1): 主动 = switch to the <替身> at once (the `dollSwitch` hook).
//   - S1 俄耳甫斯: arts attacks at attack@atk_scale on ground enemies; with an ally of the range at or below 50 % HP the
//     attack heals the lowest such one for attack@heal_scale × ATK instead (also with no enemy in range).
//   - S2 塔纳托斯: arts at attack@atk_scale on up to attack@max_target ground enemies, each hit attack@prob 恐惧 for
//     attack@fear s; every 0.1 s an enemy of the range that is 恐惧 with HP below attack@kill_atk_scale × her ATK takes
//     attack@kill_damage 无来源 true damage, once per entry into the range (PRTS).
//   - S3 开辟明日的剑刃: 塔纳托斯·改 first — ASPD +talent@attack_speed, up to attack@max_target ground enemies at
//     attack@atk_scale 弱点伤害 (the hit becomes physical or arts, whichever the target takes more of; arts on a tie, PRTS);
//     with it on the field, a cast or a lethal hit (prevented) switches to 俄耳甫斯·改 until the <替身> ends: HP reset,
//     block attack@block_cnt, no normal attack, every attack@interval s it heals up to attack@max_target_heal injured
//     allies of the range for attack@heal_scale × ATK, and allies of the range have attack@prob physical / arts dodge.
//   [ASSUMED] the personas hit ground units only (PRTS: 俄耳甫斯 "无法对空"; the others say nothing).

import { num, talentBb, traitBb, skillRec, up, enemiesInGrid, alliesInGridOf } from '../shared/tier1.js';
import { absoluteRangeKeys } from '../../../targeting.js';

const S1 = 'skchr_makoto_1', S2 = 'skchr_makoto_2', S3 = 'skchr_makoto_3';
/** character_table team `sees` (gamedata_const ba.sees). */
export const SEES = Object.freeze(new Set(['char_4217_makoto', 'char_4218_aigis', 'char_4219_yukari', 'char_4220_kormr']));
const HEAL_BELOW = 0.5;
const EXECUTE_EVERY = 0.1;
const PERSONA = 'makoto:persona';
const ORPHEUS_EX = 'makoto:orpheusEx';
const ORPHEUS_AURA = 'makoto:orpheusEx:dodge';
const ORPHEUS_SAVE_PRIORITY = -60;

const enemyDamageOf = (amount, target, type, unit) => {
  if (type === 'phys') {
    const def = Math.max(0, num(target.s.def) - num(unit.s.defIgnoreFlat)) * (1 - Math.min(1, Math.max(0, num(unit.s.defIgnorePct))));
    return Math.max(amount - def, amount * 0.05);
  }
  const res = Math.max(0, num(target.s.res) - num(unit.s.resIgnoreFlat)) * (1 - Math.min(1, Math.max(0, num(unit.s.resIgnorePct))));
  return Math.max(amount * (1 - res / 100), amount * 0.05);
};

export default {
  char_4217_makoto: (bb, chess) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const trait = traitBb(chess);
    const grid = skillRec(chess, S1)?.rangeGrid ?? chess?.trait?.rangeGrid ?? null;
    const s1 = skillRec(chess, S1)?.bb ?? {}, s2 = skillRec(chess, S2)?.bb ?? {}, s3 = skillRec(chess, S3)?.bb ?? {};
    const toPersona = ({ battle, unit }) => {
      if (!unit.trait.doll) { battle.emit('dollSwitch', { unit, reason: 'skill', done: false }); return; }
      if (unit.mem.makotoPersona === 'thanatosEx') unit.mem.makotoSwitch?.('skill');
    };
    return {
      skills: {
        [S1]: { kind: 'instant', onStart: toPersona },
        [S2]: { kind: 'instant', onStart: toPersona },
        [S3]: { kind: 'instant', onStart: toPersona },
      },
      install(battle, unit) {
        const sid = unit.skill?.id;
        const m = unit.mem;
        const bat0 = Math.max(0.1, num(unit.base?.bat, 1.2));
        const personaMods = () => {
          const mods = { atkPct: num(t0.atk), hpPct: num(t0.max_hp_t1) + num(trait.max_hp), batPct: num(t0.base_attack_time) / bat0 };
          if (sid === S3 && m.makotoPersona === 'thanatosEx') mods.aspd = num(s3['talent@attack_speed']);
          return mods;
        };
        const personaProfile = (kind) => {
          const base = m.makotoBaseProfile;
          const p = { ...base, attack: 'ranged', projectile: 'none', canHitFly: false, onEachHit: null, heal: null };
          if (kind === 'orpheus') Object.assign(p, { dmgType: 'arts', atkScale: num(s1['attack@atk_scale'], 1) });
          else if (kind === 'thanatos') {
            Object.assign(p, { dmgType: 'arts', atkScale: num(s2['attack@atk_scale'], 1), maxTargets: Math.max(1, num(s2['attack@max_target'], 1)),
              onEachHit: (b, u, victim) => {
                if (!victim?.alive || victim.side !== 'enemy') return;
                if (b.rng.chance(num(s2['attack@prob']))) b.applyStatus(victim, 'fear', { duration: num(s2['attack@fear']), source: u });
              } });
          } else if (kind === 'thanatosEx') {
            Object.assign(p, { dmgType: 'arts', atkScale: num(s3['attack@atk_scale'], 1), maxTargets: Math.max(1, num(s3['attack@max_target'], 1)) });
          } else if (kind === 'orpheusEx') Object.assign(p, { noAttack: true });
          return p;
        };
        const setPersona = (kind) => {
          m.makotoPersona = kind;
          unit.profile = personaProfile(kind);
          battle.addBuff(unit, { key: PERSONA, mods: personaMods(), tags: ['talent'] });
        };
        // the <替身> starts / ends (professions.js installDollkeeper `dollSwap`)
        battle.on('dollSwap', ({ unit: u, form }) => {
          if (u !== unit) return;
          if (form === 'doll') {
            if (!m.makotoBaseProfile) m.makotoBaseProfile = unit.profile;
            if (!m.makotoBaseGrid) m.makotoBaseGrid = unit.rangeGrid;
            if (grid) { unit.rangeGrid = grid; battle.refreshRange(unit); }
            setPersona(sid === S1 ? 'orpheus' : sid === S2 ? 'thanatos' : 'thanatosEx');
            m.makotoExecuted = new Set();
            const sl = num(t0.sluggish);
            if (sl > 0) for (const e of enemiesInGrid(battle, unit, grid, { canHitFly: true })) battle.applyStatus(e, 'sluggish', { duration: sl, source: unit });
            return;
          }
          // back to the 本体
          leavePersona();
          allOutAttack();
        }, { owner: unit });
        battle.on('death', ({ unit: u }) => { if (u === unit) leavePersona(); }, { owner: unit });
        const leavePersona = () => {
          if (!m.makotoPersona) return;
          m.makotoPersona = null;
          battle.removeBuff(unit, PERSONA);
          battle.removeBuff(unit, ORPHEUS_EX);
          for (const a of battle.allyUnits) if (a.findBuff?.(ORPHEUS_AURA)?.source === unit) battle.removeBuff(a, ORPHEUS_AURA);
          if (m.makotoBaseProfile) unit.profile = m.makotoBaseProfile;
          m.makotoBaseProfile = null;
          if (m.makotoBaseGrid) { unit.rangeGrid = m.makotoBaseGrid; m.makotoBaseGrid = null; if (unit.alive && unit.deployed) battle.refreshRange(unit); }
        };
        // S.E.E.S.队长 总攻击
        const allOutAttack = () => {
          const sc = num(t1.atk_scale);
          if (!(sc > 0) || !unit.alive) return;
          const atk = unit.s.atk;
          for (const a of battle.allyUnits) {
            if (!up(a) || a.side !== 'ally' || !SEES.has(a.def?.charId) || a.ownerId !== unit.ownerId) continue;
            const keys = grid ? absoluteRangeKeys(grid, a.tileR, a.tileC, a.dir, 0) : a.rangeKeys;
            for (const e of battle.enemiesInKeys(keys, a, { canHitFly: true })) {
              battle.dealDamage(unit, e, { amount: atk * sc, type: 'true', isSkill: true, tags: ['talent', 'allOut'] });
            }
          }
        };
        // S1 俄耳甫斯: an ally at or below half HP takes the attack's place
        const lowAlly = () => {
          let best = null;
          for (const a of alliesInGridOf(battle, unit)) {
            if (a.kind === 'device' || !(a.hpRatio <= HEAL_BELOW + 1e-9) || a.s.flags.noHeal) continue;
            if (!best || a.hpRatio < best.hpRatio - 1e-9) best = a;
          }
          return best;
        };
        const orpheusHeal = (a) => {
          battle.heal(unit, a, unit.s.atk * num(s1['attack@heal_scale']));
          unit.lastAttackAt = battle.time;
          unit.atkCd = Math.max(unit.atkCd, unit.s.interval);
        };
        if (sid === S1) {
          battle.on('beforeAttack', (ctx) => {
            if (ctx.attacker !== unit || m.makotoPersona !== 'orpheus') return;
            const a = lowAlly();
            if (!a) return;
            ctx.targets = [];
            orpheusHeal(a);
          }, { owner: unit });
          battle.on('tick', () => {
            if (m.makotoPersona !== 'orpheus' || !up(unit) || !unit.canAct || unit.s.flags.disarm || unit.atkCd > 0) return;
            if (battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile).length) return;
            const a = lowAlly();
            if (a) orpheusHeal(a);
          }, { owner: unit });
        }
        // S2 塔纳托斯: the 恐惧 execution
        if (sid === S2) {
          battle.every(EXECUTE_EVERY, () => {
            if (m.makotoPersona !== 'thanatos' || !up(unit)) return;
            const inRange = new Set(battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true }));
            for (const e of m.makotoExecuted) if (!inRange.has(e)) m.makotoExecuted.delete(e);
            const thr = unit.s.atk * num(s2['attack@kill_atk_scale']);
            for (const e of inRange) {
              if (m.makotoExecuted.has(e) || !e.alive || !e.s.flags.fear || !(e.hp < thr)) continue;
              m.makotoExecuted.add(e);
              battle.dealDamage({ source: null, credit: unit, target: e, amount: num(s2['attack@kill_damage'], 9999999), type: 'true',
                canDodge: false, ignoreCancelReasons: ['dodge', 'block'], tags: ['skill', 'execute'] });
            }
          }, { owner: unit });
        }
        if (sid === S3) {
          // 弱点伤害
          battle.on('hit', ({ source, target, dmg }) => {
            if (source !== unit || m.makotoPersona !== 'thanatosEx' || !dmg || !dmg.isAttack || !target || target.side !== 'enemy') return;
            if (dmg.type !== 'phys' && dmg.type !== 'arts') return;
            const a = num(dmg.amount);
            const p = enemyDamageOf(a, target, 'phys', unit), r = enemyDamageOf(a, target, 'arts', unit);
            if (Math.abs(p - r) <= 1e-6 * Math.max(1, a)) return;
            dmg.type = p > r ? 'phys' : 'arts';
          }, { owner: unit });
          // 塔纳托斯·改 → 俄耳甫斯·改
          m.makotoSwitch = () => {
            if (m.makotoPersona !== 'thanatosEx' || !unit.alive) return false;
            setPersona('orpheusEx');
            battle.addBuff(unit, { key: ORPHEUS_EX, mods: { blockCnt: 99 + num(s3['attack@block_cnt']) - num(unit.base?.blockCnt, 0) }, flags: { disarm: true }, tags: ['skill'] });
            unit.markDirty?.();
            unit.hp = unit.s.maxHp;
            return true;
          };
          battle.on('fatal', (ctx) => {
            if (ctx.unit !== unit || ctx.prevented || !unit.trait.doll || unit.trait.dollSwitching) return;
            if (m.makotoPersona === 'thanatosEx' && m.makotoSwitch()) ctx.prevented = true;
          }, { owner: unit, priority: ORPHEUS_SAVE_PRIORITY });
          battle.every(num(s3['attack@interval'], 1), () => {
            if (m.makotoPersona !== 'orpheusEx' || !up(unit)) return;
            const n = Math.max(1, Math.floor(num(s3['attack@max_target_heal'], 1)));
            const hurt = alliesInGridOf(battle, unit).filter((a) => a.kind !== 'device' && a.hp < a.s.maxHp - 1e-9 && !a.s.flags.noHeal)
              .sort((x, y) => x.hpRatio - y.hpRatio || x.aggroSeq - y.aggroSeq).slice(0, n);
            for (const a of hurt) battle.heal(unit, a, unit.s.atk * num(s3['attack@heal_scale']));
          }, { owner: unit });
          battle.every(0.2, () => {
            if (m.makotoPersona !== 'orpheusEx' || !up(unit)) return;
            const p = num(s3['attack@prob']);
            for (const a of alliesInGridOf(battle, unit)) {
              if (a.kind === 'device') continue;
              battle.addBuff(a, { key: ORPHEUS_AURA, duration: 0.3, mods: { dodgePhys: p, dodgeArts: p }, source: unit, tags: ['aura'] });
            }
          }, { owner: unit });
        }
      },
    };
  },
};
