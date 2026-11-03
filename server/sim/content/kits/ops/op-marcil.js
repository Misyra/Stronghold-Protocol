// server/sim/content/kits/ops/op-marcil.js — 玛露西尔 (char_4141_marcil) 自选 operator kit: 6★ 扩散术师, a collab pick of the
// tier-5 and tier-6 自选 slots (data/backups.json `diy.excluded`: offered only in a room with 联动干员 on); every skill, both talents
// and the SPC-Y module at every form. Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Sources: character_table / skill_table / battle_equip_table of the pinned tables as built into backups.json; gamedata_const
// ba.magicpoint (魔力 "特殊技力，整场战斗继承"), ba.chant (吟唱 "停止攻击一段时间后尝试开启技能，期间被打断则中止"), ba.laiosteam;
// range_table x-1 (the client's projectile_chr_marcil_s3 `_rangeId`); PRTS 玛露西尔 备注 (2026-11-02); PRTS 卫戍协议/帮助
// (MARCILS2: "首次开启技能后，若剩余魔力不少于35，则自动关闭技能（即再次开启技能）").
// - 魔力 is her SP (PRTS "部署时转化为技力，撤退时转化回魔力"): the skill bar, capped at the skill's mana_max, never refilled by
//   time; it starts at the skill's mana_init plus talent 2's, is kept through the whole battle (a knock-out keeps it) and
//   grows mana_add per `interval` s while she is off the field. Gains from content (迅捷 …) are 魔力 too.
// - 建校以来第一才女: with at least 1 魔力, ATK +atk and the splash radius SPLASH_POWER instead of the profession's 1.1 (PRTS).
//   Her skills open whenever she has their skill_cost_min_sp ("可随时开启") — the kit casts them (trigger NEVER): the
//   official strategies' DEFAULT (an enemy in her range) for S1 / S3 [ASSUMED: no attack needed], MARCILS2 for S2.
// - 吟唱: she stops attacking for the chant; anything that keeps her from acting (stun, freeze, sleep, 浮空 …), silence or a
//   knock-out aborts it, and so does 魔力 below the minimum (PRTS: checked every CHANT_CHECK s).
// - 可靠的同伴: initial 魔力 +mana_init; the 莱欧斯小队 bonus needs 4 members of her player — none other is a 6★, so it never
//   holds here (kept by team membership).
// - S1 才女的实力: chant chant_duration, then ATK +atk until 魔力 drops below skill_cost_min_sp; each attack costs sp_cost; with
//   no enemy to attack she heals the most injured ally of her range for her ATK [ASSUMED: 100 %] at the same cost. Never
//   closed by the strategy.
// - S2 召唤使魔 (MARCILS2): chant chant_duration, then sp_cost 魔力 make the familiar: her attacks ATK +atk and 停顿
//   attack@sluggish every enemy hit. Right after, with sp_cost still left, it is closed and opened again: the same chant and
//   cost [ASSUMED], and the familiar is upgraded — range +1, ASPD +attack_speed, the main target 晕眩 attack@stun. Infinite;
//   the count starts over at each deployment.
// - S3 爆破魔法: chant chant_duration, sp_cost_extra 魔力: an explosion centred 2 tiles ahead (moved back towards her when off
//   the map, PRTS "过于靠近地图边缘时中心点内移") on x-1: atk_scale arts to every enemy there, air included; each high-ground tile
//   it covers stuns the enemies on it and the 8 tiles around for `stun` s. Then the extra chant, extra_chant_duration (never
//   stopped by the strategy), then one explosion every `interval` s, sp_cost_extra each, while 魔力 lasts (at most trig_cnt).
//   Leaving the field during the extra chant loses all 魔力 (PRTS).

import { num, talentBb, skillRec, up, enemyInRange, alliesInGridOf } from '../shared/tier1.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { dirVec } from '../../../dir.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_marcil_1', S2 = 'skchr_marcil_2', S3 = 'skchr_marcil_3';
/** character_table team `laios` (gamedata_const ba.laiosteam). */
export const LAIOS = Object.freeze(new Set(['char_4141_marcil', 'char_4142_laios', 'char_4143_sensi', 'char_4144_chilc']));
const LAIOS_NEEDED = 4;
const SPLASH_POWER = 1.5;
const CHANT = 'marcil:chant';
const CHANT_CHECK = 0.5;
const FAMILIAR2 = 'marcil:familiar2';
const BLAST_AHEAD = 2;
/** range_table x-1. */
const X1 = Object.freeze([[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, -1], [-1, 0], [-1, 1], [-2, 0]]);

export default {
  char_4141_marcil: (bb, chess) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const base = { kind: 'toggle', spType: 'none', initSp: 0, trigger: 'NEVER' };
    const s2 = skillRec(chess, S2)?.bb ?? {};
    return {
      skills: {
        [S1]: { ...base, mods: { atkPct: num(skillRec(chess, S1)?.bb?.atk) } },
        [S2]: {
          ...base, mods: { atkPct: num(s2.atk) },
          attack: {
            onEachHit({ battle, unit, target, kind }) {
              if (!target?.alive) return;
              battle.applyStatus(target, 'sluggish', { duration: num(s2['attack@sluggish']), source: unit });
              if (kind === 'main' && unit.mem.marcilFamiliar >= 2) battle.applyStatus(target, 'stun', { duration: num(s2['attack@stun']), source: unit });
            },
          },
        },
        [S3]: { ...base },
      },
      install(battle, unit) {
        const sk = unit.skill;
        const sid = sk?.id;
        const sb = sk?.bb ?? {};
        const m = unit.mem;
        const cap = () => Math.max(1, sk?.spCost || num(sb.mana_max, 80));
        const minSp = num(sb.skill_cost_min_sp, 1);
        const getMana = () => (up(unit) && sk ? sk.sp : num(m.marcilMana));
        const setMana = (v) => {
          const x = Math.max(0, Math.min(cap(), v));
          if (up(unit) && sk) { sk.sp = x; sk.charges = x >= sk.spCost - 1e-9 ? 1 : 0; }
          m.marcilMana = x;
        };
        if (m.marcilMana == null) m.marcilMana = Math.min(cap(), num(sb.mana_init, sk?.def?.initSp ?? 0) + num(t1.mana_init));
        // 魔力 ⇄ 技力 at each deployment / exit
        battle.on('deploy', ({ unit: u }) => {
          if (u !== unit) return;
          m.marcilFamiliar = 0;
          setMana(m.marcilMana);
        }, { owner: unit });
        battle.on('death', ({ unit: u }) => {
          if (u !== unit) return;
          if (m.marcilChant) abortChant();
          if (m.marcilExtra) { m.marcilMana = 0; m.marcilExtra = false; }
          else if (sk) m.marcilMana = Math.max(0, Math.min(cap(), sk.sp));
        }, { owner: unit });
        // off the field: +mana_add per interval
        const every = Math.max(0.1, num(t0.interval, 1));
        battle.every(every, () => {
          if (unit.alive && unit.deployed) return;
          if (unit.removed) return;
          m.marcilMana = Math.min(cap(), num(m.marcilMana) + num(t0.mana_add, 1));
        }, { owner: unit });
        // 建校以来第一才女
        const baseSplash = unit.profile?.splashRadius ?? 1.1;
        battle.on('tick', () => {
          if (!up(unit) || !unit.profile) return;
          const has = getMana() >= 1 - 1e-9;
          unit.profile.splashRadius = has ? SPLASH_POWER : baseSplash;
          const on = !!unit.findBuff('marcil:power');
          if (has && !on && num(t0.atk) > 0) battle.addBuff(unit, { key: 'marcil:power', mods: { atkPct: num(t0.atk) }, tags: ['talent'] });
          else if (!has && on) battle.removeBuff(unit, 'marcil:power');
        }, { owner: unit });
        // 可靠的同伴: the 莱欧斯小队 bonus
        battle.on('battleStart', () => {
          const team = new Set(battle.allyUnits.filter((a) => a.ownerId === unit.ownerId && LAIOS.has(a.def?.charId)).map((a) => a.def.charId));
          if (team.size < LAIOS_NEEDED) return;
          for (const a of battle.allyUnits) {
            if (a.ownerId !== unit.ownerId || !LAIOS.has(a.def?.charId)) continue;
            battle.addBuff(a, { key: 'marcil:laios', mods: { aspd: num(t1.attack_speed), defPct: num(t1.def) }, persist: true, allowDead: true, tags: ['talent'] });
          }
        }, { owner: unit });

        // 吟唱
        const abortChant = () => {
          const c = m.marcilChant;
          if (!c) return;
          m.marcilChant = null;
          c.timer?.cancel();
          battle.removeBuff(unit, CHANT);
          if (c.onAbort) c.onAbort();
        };
        const chant = (seconds, onDone, { min = minSp, onAbort = null } = {}) => {
          battle.addBuff(unit, { key: CHANT, duration: seconds + 0.05, flags: { disarm: true }, tags: ['skill'] });
          const c = { min, onAbort, nextCheck: battle.time + CHANT_CHECK };
          c.timer = battle.after(seconds, () => {
            if (m.marcilChant !== c) return;
            m.marcilChant = null;
            battle.removeBuff(unit, CHANT);
            if (up(unit)) onDone();
          }, { owner: unit });
          m.marcilChant = c;
        };
        battle.on('tick', () => {
          const c = m.marcilChant;
          if (!c) return;
          if (!up(unit) || !unit.canAct || unit.s.flags.silence) { abortChant(); return; }
          if (battle.time >= c.nextCheck - 1e-9) {
            c.nextCheck = battle.time + CHANT_CHECK;
            if (getMana() < c.min - 1e-9) abortChant();
          }
        }, { owner: unit });
        const canOpen = (need) => up(unit) && unit.canAct && !unit.s.flags.silence && !m.marcilChant && !sk.active
          && !sk.opCooling && getMana() >= need - 1e-9 && enemyInRange(battle, unit);
        const open = (reason) => sk.activate(reason, { free: true });

        if (sid === S1) {
          const cost = num(sb.sp_cost, 2);
          battle.on('tick', () => {
            if (!sk.active) { if (canOpen(minSp)) chant(num(sb.chant_duration, 1.5), () => { if (getMana() >= minSp - 1e-9) open('DEFAULT'); }); return; }
            if (getMana() < minSp - 1e-9) { sk.end('mana'); return; }
            // no enemy to attack: the most injured ally of her range takes the attack's place
            if (!up(unit) || !unit.canAct || unit.s.flags.disarm || unit.atkCd > 0) return;
            if (battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile).length) return;
            let best = null;
            for (const a of alliesInGridOf(battle, unit)) {
              if (a.kind === 'device' || a.s.flags.noHeal || !(a.hp < a.s.maxHp - 1e-9)) continue;
              if (!best || a.hpRatio < best.hpRatio - 1e-9) best = a;
            }
            if (!best) return;
            battle.heal(unit, best, unit.s.atk);
            setMana(getMana() - cost);
            unit.lastAttackAt = battle.time;
            unit.atkCd = Math.max(unit.atkCd, unit.s.interval);
          }, { owner: unit });
          battle.on('attack', ({ attacker }) => {
            if (attacker !== unit || !sk.active) return;
            setMana(getMana() - cost);
            if (getMana() < minSp - 1e-9) sk.end('mana');
          }, { owner: unit });
        }

        if (sid === S2) {
          const cost = num(sb.sp_cost, 35);
          const make = (level) => {
            if (getMana() < cost - 1e-9) return;
            setMana(getMana() - cost);
            m.marcilFamiliar = level;
            open(level > 1 ? 'MARCILS2' : 'AUTO');
            if (level > 1) battle.addBuff(unit, { key: FAMILIAR2, mods: { aspd: num(sb.attack_speed), rangeExtend: 1 }, tags: ['skill'] });
          };
          battle.on('skillEnd', ({ unit: u }) => { if (u === unit) battle.removeBuff(unit, FAMILIAR2); }, { owner: unit });
          battle.on('tick', () => {
            const lv = m.marcilFamiliar ?? 0;
            if (lv === 0 && !sk.active && canOpen(cost)) { chant(num(sb.chant_duration, 11), () => make(1), { min: cost }); return; }
            // MARCILS2: with sp_cost still left, close it and open it again (the second use)
            if (lv === 1 && sk.active && !m.marcilChant && getMana() >= cost - 1e-9 && up(unit) && unit.canAct && !unit.s.flags.silence) {
              sk.end('MARCILS2');
              chant(num(sb.chant_duration, 11), () => make(2), { min: cost, onAbort: () => { m.marcilFamiliar = 1; } });
            }
          }, { owner: unit });
        }

        if (sid === S3) {
          const cost = num(sb.sp_cost_extra, 8);
          const blast = () => {
            if (getMana() < cost - 1e-9 || !up(unit)) return false;
            setMana(getMana() - cost);
            const [dr, dc] = dirVec(unit.dir);
            let r = unit.tileR, c = unit.tileC;
            for (let k = BLAST_AHEAD; k >= 0; k--) { // loop-cap: BLAST_AHEAD + 1 tiles
              if (battle.grid.inRect(unit.tileR + dr * k, unit.tileC + dc * k)) { r = unit.tileR + dr * k; c = unit.tileC + dc * k; break; }
            }
            const keys = absoluteRangeKeys(X1, r, c, unit.dir, 0);
            const atk = unit.s.atk;
            battle.fx('aoe', { x: c, y: r, radius: 2, id: unit.id, skill: S3 });
            for (const e of battle.enemiesInKeys(keys, unit, { canHitFly: true })) {
              battle.dealDamage(unit, e, { amount: atk * num(sb.atk_scale, 1), type: 'arts', isSkill: true, tags: ['skill', 'blast'] });
            }
            const shards = new Set();
            for (const k of keys) {
              const kr = Math.floor(k / COLS), kc = k % COLS;
              if (battle.grid.tile(kr, kc)?.height !== 'HIGH') continue;
              for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (battle.grid.inRect(kr + a, kc + b)) shards.add((kr + a) * COLS + kc + b);
            }
            if (shards.size) for (const e of battle.enemiesOnTiles([...shards], unit, { canHitFly: true })) battle.applyStatus(e, 'stun', { duration: num(sb.stun), source: unit });
            return true;
          };
          const finish = () => { m.marcilExtra = false; battle.removeBuff(unit, 'marcil:extraChant'); if (sk.active) sk.end('done'); };
          const barrage = (left) => {
            if (left <= 0 || !sk.active || !blast()) { finish(); return; }
            battle.after(num(sb.interval, 0.45), () => barrage(left - 1), { owner: unit });
          };
          battle.on('tick', () => {
            if (sk.active || !canOpen(cost)) return;
            chant(num(sb.chant_duration, 5), () => {
              if (!open('DEFAULT')) return;
              if (!blast()) { finish(); return; }
              m.marcilExtra = true;
              // no attack from here until the last explosion [ASSUMED: the barrage is part of the chant's cast]
              battle.addBuff(unit, { key: 'marcil:extraChant', flags: { disarm: true }, tags: ['skill'] });
              chant(num(sb.extra_chant_duration, 10), () => { m.marcilExtra = false; barrage(Math.max(1, Math.floor(num(sb.trig_cnt, 49)))); },
                { min: cost, onAbort: finish });
            }, { min: cost });
          }, { owner: unit });
        }
      },
    };
  },
};
