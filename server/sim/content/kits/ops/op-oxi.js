// server/sim/content/kits/ops/op-oxi.js — 塔露拉 (char_4247_oxi) 自选 operator kit: 6★ 本源近卫, an owned-6★ pick of the tier-5
// and tier-6 自选 slots; every skill and both talents at every form. She has no module yet. Kit contract and the 自选 rules:
// ../README.md ("How to add an operator (自选)").
//
// Sources: character_table / skill_table of ArknightsGameData 08ba2aea (client 2.7.91, 2026-11-01), as built into
// backups.json, and PRTS 塔露拉 (2026-11-02, launch-day notes). The official mode never fielded her: she went on sale after
// its last period, so her auto-cast rule is the data's default and everything below marked [ASSUMED] is a launch-day gap.
// - 绝不妥协: her attack deals arts damage (the record's dmgType, officialUnitBuilder talentArtsAttack). Every arts
//   hit adds ep_damage_ratio of the damage dealt as 灼燃损伤 [ASSUMED: the base, as 克莱门莎's ep_damage_ratio; PRTS prints
//   "于每次成功造成伤害时产生"]. 怒火 (PRTS 备注): 0 at deployment, +1 every arcane_step_interval, at most arcane_max /
//   arcane_step; a non-skill normal attack spends one and holds the growth for arcane_idle_delay. Her arts and 元素伤害 deal
//   ×(1 + arcane_step × 怒火); a burst is 无来源 and takes none of it.
// - 我即火焰: while she is on the field, an enemy that bursts 灼燃 leaves 足迹 for TRAIL_SECONDS (text only, no blackboard
//   key) on the passable ground it stands on [ASSUMED: PRTS does not say whose steps]; a tile lasts field_duration, at most
//   max_count tiles exist (a full set adds none [ASSUMED]), and each field_interval every ground enemy on one takes
//   field_atk_scale × her live ATK as arts [ASSUMED: live ATK, ground only]. The tiles go when she leaves ("在场时").
// - S1 照霎白夜 (AUTO): at once, every ground enemy on her target's tile takes atk_scale arts and 恐惧 [ASSUMED: no attack is
//   replaced].
// - S2 阂断骤雪 (AUTO, 5 charges, trigger NEVER: the kit casts it): ready and with no effect running, the first damage from an
//   enemy source (PRTS: not a DoT, priority +1000, "且未被成功闪避" — her 闪避 (dodgePhys / dodgeArts of the buffs that come
//   later in the injury pass) is rolled for that instance at the guard, with the pass's own roll and in its order, and not
//   again where those buffs come; a dodged hit casts nothing) casts it. That hit, if physical or arts, falls to damage_remaining_scale.
//   庇护 damage_resistance holds shelter_hold_duration, then fades linearly to 0 at skill_duration. The damage source, else a
//   blocked unit, else a ground enemy of her range takes retaliate_atk_scale arts around it (ability_range_radius, the
//   official blackboard; PRTS's 0.9 is the same circle by collider), healing her heal_ratio of the sum. Each cast adds one
//   layer: ATK / DEF + per layer, her attacks strike every enemy she blocks; stack_duration refreshes on a gain, and on
//   expiry one layer goes and the time refreshes (PRTS 备注).
// - S3 日冕重烈 (MANUAL, data DEFAULT): ATK + for the duration, no attacks (the 怒火 fills meanwhile). Every 80 frames (PRTS:
//   the 2.67 s is a rounding) a wave of 簇火 starts on normal_half_width rows either side of hers, each from the farthest
//   tile up to FLAME_BACK behind her still on the map, and flies wave_speed ahead to wave_exit_distance past the map's edge.
//   At half time it overloads: 60 frames, overload_half_width rows. The waves keep their time whatever her state (PRTS 备注
//   "“簇火”发射间隔固定为80帧（或过载时60帧），不受塔露拉的当前状态影响"; Stardust fork 7c99acc1): stunned or otherwise
//   controlled she still rains. A 簇火 (the client's projectile_chr_oxi_s_3_heatwave:
//   not eliminatable, stops at its first hit, `_exceptFlyCharacter` 0 — air units too) that touches an enemy
//   (projectile_range) is gone and blasts range_radius with the ATK it was created with
//   × heatwave_atk_scale, arts, or 元素伤害 on a target in its 灼燃 burst; a later 簇火 of the same wave deals
//   same_wave_repeat_damage_scale to a target already hit. The first wave comes one interval after the cast [ASSUMED]; 簇火
//   in flight outlive the skill [ASSUMED, as 克莱门莎's shots]. One 塔露拉 channels per field (PRTS); a second only stands.
// - This game's rule, the owner's decision of 2026-11-02 (no official source): while her skill lasts — S3 running, or S2
//   with a layer up; S1 has no duration — every other operator of our side knocked out gives her player DEATH_LAYERS 奥术
//   and 不屈 layers. Her bonds 协防 + 奥术 + 不屈 are the same decision (tools/build-data.mjs DIY_EXTRA_BONDS).

import { num, talentBb, skillRec, up, posKey, holdProtect, byEnemyDamage, enemiesInGrid } from '../shared/tier1.js';
import { canTargetEnemy } from '../../../targeting.js';
import { dirVec } from '../../../dir.js';
import { COLS } from '../../../constants.js';
import { hasHp, damageDodgeMode } from '../../../attack.js';

const S1 = 'skchr_oxi_1', S2 = 'skchr_oxi_2', S3 = 'skchr_oxi_3';
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
const AIR = Object.freeze({ canHitFly: true });
const TRAIL_SECONDS = 5;
const FLAME_BACK = 11;
const FLAME_GAP = 80 / 30, OVERLOAD_GAP = 60 / 30;
const LAYERS = 'oxi:layers';
const DEATH_LAYERS = 1;
const DEATH_BONDS = Object.freeze(['arcaneShip', 'indomShip']);
/** battle → the 塔露拉 channelling S3 (PRTS: "场上只有一名塔露拉可以引导簇火"). */
const CHANNEL = new WeakMap();

const stateOf = (unit) => (unit.mem.oxi ??= { anger: 0, growAt: 0, castAt: -Infinity, layers: 0, source: null, fire: null });
const targetOf = (battle, unit) => battle.blockedTargets(unit, GROUND)[0]
  ?? enemiesInGrid(battle, unit, null, { n: 1, canHitFly: false, groundOnly: true })[0] ?? null;
const isDot = (dmg) => dmg?.attackType === 'BUFF' || !!dmg?.tags?.includes('dot');

function installAnger(battle, unit, t0) {
  const m = stateOf(unit);
  const step = num(t0.arcane_step), every = num(t0.arcane_step_interval, 0.5), hold = num(t0.arcane_idle_delay, 3);
  const cap = step > 0 ? Math.round(num(t0.arcane_max) / step) : 0;
  m.growAt = every;
  battle.on('deploy', ({ unit: u }) => { if (u === unit) { m.anger = 0; m.growAt = battle.time + every; } }, { owner: unit });
  battle.on('tick', () => {
    if (!up(unit) || m.anger >= cap || battle.time < m.growAt - 1e-9) return;
    m.anger++;
    m.growAt = battle.time + every;
  }, { owner: unit });
  battle.on('attack', ({ attacker, isSkill }) => {
    if (attacker !== unit || isSkill) return;
    m.anger = Math.max(0, m.anger - 1);
    m.growAt = battle.time + hold;
  }, { owner: unit });
  battle.on('hit', ({ source, dmg }) => {
    if (source === unit && m.anger > 0 && (dmg.type === 'arts' || dmg.type === 'elemental')) dmg.mul *= 1 + step * m.anger;
  }, { owner: unit });
  battle.on('damaged', ({ source, target, amount, type }) => {
    if (source !== unit || type !== 'arts' || !(amount > 0) || target?.side !== 'enemy') return;
    battle.dealElementDamage({ source: unit, target, element: 'burn', amount: amount * num(t0.ep_damage_ratio), tags: ['oxi:burn'] });
  }, { owner: unit });
}

function installFootprints(battle, unit, t1) {
  const life = num(t1.field_duration), every = num(t1.field_interval, 0.3), scale = num(t1.field_atk_scale);
  const cap = Math.floor(num(t1.max_count, 25));
  const trails = new Map(), tiles = new Map();
  let pulse = 0;
  unit.mem.oxiTiles = tiles;
  battle.on('elementBurst', ({ target, element }) => {
    if (element === 'burn' && target?.side === 'enemy' && up(unit)) trails.set(target, battle.time + TRAIL_SECONDS);
  }, { owner: unit });
  battle.on('tick', ({ dt }) => {
    if (!up(unit)) { trails.clear(); tiles.clear(); pulse = 0; return; }
    for (const [key, until] of tiles) if (until <= battle.time + 1e-9) tiles.delete(key);
    for (const [e, until] of trails) {
      if (!e.alive || until < battle.time - 1e-9) { trails.delete(e); continue; }
      const r = Math.round(e.y), c = Math.round(e.x), key = r * COLS + c;
      if (e.isFlying || !battle.grid.groundPassable(r, c)) continue;
      if (!tiles.has(key)) {
        if (tiles.size >= cap) continue;
        battle.fx('zone', { x: c, y: r, radius: 0.5, dur: life, id: unit.id, skill: 'oxi_field' });
      }
      tiles.set(key, battle.time + life);
    }
    if (!tiles.size) { pulse = 0; return; }
    pulse += dt;
    if (pulse < every - 1e-9) return;
    pulse -= every;
    for (const e of battle.enemiesOnTiles([...tiles.keys()], unit, GROUND)) {
      battle.dealDamage({ source: unit, target: e, amount: unit.s.atk * scale, type: 'arts', canDodge: false, tags: ['dot', 'oxi:field'] });
    }
  }, { owner: unit });
}

function installDeathLayers(battle, unit) {
  battle.on('death', (c) => {
    const u = c.unit, sk = unit.skill;
    if (c.reason !== 'killed' || c.revivedBy || u === unit || u?.side !== 'ally' || u.kind !== 'op' || !up(unit)) return;
    if (!(sk?.id === S3 ? sk.active : sk?.id === S2 && stateOf(unit).layers > 0)) return;
    for (const bond of DEATH_BONDS) battle.addLayers(unit.ownerId, bond, DEATH_LAYERS, 'oxi', { source: unit });
  }, { owner: unit });
}

/** The S2 layers: one buff whose mods carry the count, so an expiry can take one layer and restart the time. */
function setLayers(battle, unit, b2) {
  const m = stateOf(unit);
  battle.removeBuff(unit, LAYERS);
  if (m.layers <= 0) return;
  battle.addBuff(unit, {
    key: LAYERS, duration: num(b2.stack_duration, 5), visible: true, tags: ['skill'],
    mods: { atkPct: num(b2.atk) * m.layers, defPct: num(b2.def) * m.layers },
    onExpire() { m.layers--; setLayers(battle, unit, b2); },
  });
}

function installShelter(battle, unit, b2) {
  const m = stateOf(unit);
  const value = num(b2.damage_resistance), hold = num(b2.shelter_hold_duration), life = num(b2.skill_duration, 1.3);
  // an injury effect (PRTS 优先级 +1000): the hit that casts the skill is cut here, the 庇护 only reaches the later ones
  battle.addBuff(unit, {
    key: 'oxi:guard', persist: true, allowDead: true, injuryPriority: 1000,
    injury(ev) {
      const sk = unit.skill;
      if (!sk?.ready || battle.time < m.castAt + life - 1e-9 || !unit.canAct || unit.s.flags.silence) return;
      if (!byEnemyDamage(ev) || isDot(ev.dmg)) return;
      // PRTS "且未被成功闪避": her 闪避 (dodgePhys / dodgeArts of her buffs that come later in this pass) is rolled for
      // this hit now, with the pass's own roll (ev.dodge: battle.rng, the MISS, the dodge hook) in the pass's order —
      // a dodged hit casts nothing; one that is not dodged is not rolled again where those buffs come
      const key = ev.type === 'phys' ? 'dodgePhys' : ev.type === 'arts' ? 'dodgeArts' : null, own = ev.buff;
      const later = (b) => (b.injuryPriority ?? 0) < own.injuryPriority || ((b.injuryPriority ?? 0) === own.injuryPriority && b.seq > own.seq);
      const held = key ? unit.buffs.filter((b) => b !== own && b.mods && b.mods[key] > 0 && later(b))
        .sort((a, b) => (b.injuryPriority ?? 0) - (a.injuryPriority ?? 0) || a.seq - b.seq) : [];
      const cancels = damageDodgeMode(ev.dmg) !== 'uncancellable';
      for (const b of held) {
        for (let i = 0; i < b.stacks; i++) {   // one roll per stack until one succeeds (attack/effects.js)
          if (!ev.dodge(b.mods[key])) continue;
          if (cancels) return;
          break;
        }
      }
      for (const b of held) {
        const mods = b.mods, once = { ...mods, [key]: 0 };
        b.mods = once;
        ev.defer(() => { if (b.mods === once) b.mods = mods; unit.markDirty(); });
      }
      m.castAt = battle.time;
      if (ev.type === 'phys' || ev.type === 'arts') ev.amount *= num(b2.damage_remaining_scale, 0.1);
      const source = ev.source;
      ev.defer(() => { m.source = source; sk.activate('TAKE_DAMAGE'); });
    },
  });
  battle.on('tick', ({ dt }) => {
    const age = battle.time - m.castAt;
    if (!up(unit) || !(age >= 0) || age >= life) return;
    const left = age <= hold ? 1 : (life - age) / (life - hold);
    holdProtect(battle, unit, value * left, dt * 2, unit);
  }, { owner: unit });
  // "攻击所有阻挡的敌人" while a layer lasts
  battle.on('beforeAttack', (c) => {
    if (c.attacker !== unit || !m.layers) return;
    const held = battle.blockedTargets(unit, c.profile);
    if (held.length) c.targets = held;
  }, { owner: unit });
}

function fireWave(battle, unit, b3, f) {
  const [dr, dc] = dirVec(unit.dir), half = Math.floor(num(f.over ? b3.overload_half_width : b3.normal_half_width));
  const speed = num(b3.wave_speed, 2.3), exit = num(b3.wave_exit_distance, 5), wave = ++f.wave;
  const on = (r, c) => battle.grid.inRect(r, c);
  for (let o = -half; o <= half; o++) {
    const r = unit.tileR + o * dc, c = unit.tileC + o * dr;
    if (!on(r, c)) continue;
    let back = FLAME_BACK, ahead = 0;
    while (back > 0 && !on(r - dr * back, c - dc * back)) back--; // loop-cap: FLAME_BACK
    while (on(r + dr * (ahead + 1), c + dc * (ahead + 1))) ahead++; // loop-cap: the board's edge
    const reach = back + ahead + exit, flame = `${unit.id}:${wave}:${o}`;
    const from = { x: c - dc * back, y: r - dr * back }, to = { x: c + dc * (ahead + exit), y: r + dr * (ahead + exit) };
    battle.addProjectile({ from, to, speed, visual: 'none', source: unit, maxAge: reach / speed + 1,
      data: { oxiFlame: unit, wave, atk: unit.s.atk, flame } });
    // the client draws it from this fx (FX_BINDINGS skchr_oxi_3): a projectile of the sim sends nothing to the view
    battle.fx('heatwave', { x: from.x, y: from.y, tx: to.x, ty: to.y, t: reach / speed, id: unit.id, flame });
  }
}

function installFlames(battle, unit, b3) {
  const m = stateOf(unit);
  const touch = num(b3.projectile_range, 0.5), blast = num(b3.range_radius, 1.5), scale = num(b3.heatwave_atk_scale);
  const repeat = num(b3.same_wave_repeat_damage_scale), struck = new Map();
  battle.on('projectileStep', (ctx) => {
    const p = ctx.projectile, d = p.data;
    if (d?.oxiFlame !== unit) return;
    if (!battle.foesInColliderRadius(p.x, p.y, touch).some((e) => canTargetEnemy(unit, e, AIR))) return;
    ctx.cancel = true;
    battle.fx('heatwaveHit', { x: p.x, y: p.y, r: blast, id: unit.id, flame: d.flame });
    if (!struck.has(d.wave)) struck.set(d.wave, new Set());
    const seen = struck.get(d.wave);
    for (const e of battle.foesInRadius(p.x, p.y, blast)) {
      if (!canTargetEnemy(unit, e, AIR)) continue;
      const burning = !!e.findBuff('burnBurst');
      battle.dealDamage({ source: unit, target: e, amount: d.atk * scale * (seen.has(e) ? repeat : 1),
        type: burning ? 'elemental' : 'arts', ...(burning ? { element: 'burn' } : {}), isSkill: true, tags: ['skill', 'oxi:flame'] });
      seen.add(e);
    }
  }, { owner: unit });
  battle.on('deploy', ({ unit: u }) => { if (u === unit) m.fire = null; }, { owner: unit });
}

export default {
  char_4247_oxi: (bb, raw) => {
    const t0 = talentBb(raw, 0), t1 = talentBb(raw, 1);
    const b1 = skillRec(raw, S1)?.bb ?? {}, b2 = skillRec(raw, S2)?.bb ?? {}, b3 = skillRec(raw, S3)?.bb ?? {};
    return {
      skills: {
        [S1]: {
          kind: 'instant',
          onStart({ battle, unit }) {
            const t = targetOf(battle, unit);
            if (!t) return;
            battle.fx('aoe', { x: t.x, y: t.y, radius: 0.6, id: unit.id, dmgType: 'arts', skill: 'oxi_1' });
            for (const e of battle.enemiesOnTiles([posKey(t)], unit, GROUND)) {
              battle.dealDamage({ source: unit, target: e, amount: unit.s.atk * num(b1.atk_scale), type: 'arts', isSkill: true, tags: ['skill', 'oxi:s1'] });
              if (hasHp(e)) battle.applyStatus(e, 'fear', { duration: num(b1.fear), source: unit });
            }
          },
        },
        [S2]: {
          kind: 'charges', charges: Math.floor(num(b2.max_stack_cnt, 5)), trigger: { rule: 'NEVER' },
          onStart({ battle, unit }) {
            const m = stateOf(unit), src = m.source;
            m.source = null;
            const t = src?.alive && !src.hidden ? src : targetOf(battle, unit);
            let dealt = 0;
            if (t) {
              const r = num(b2.ability_range_radius, 1);
              battle.fx('aoe', { x: t.x, y: t.y, radius: r, id: unit.id, dmgType: 'arts', skill: 'oxi_2' });
              const hit = battle.foesInRadius(t.x, t.y, r).filter((e) => canTargetEnemy(unit, e, AIR));
              if (!hit.includes(t)) hit.unshift(t);
              for (const e of hit) dealt += battle.dealDamage({ source: unit, target: e, amount: unit.s.atk * num(b2.retaliate_atk_scale),
                type: 'arts', isSkill: true, tags: ['skill', 'oxi:s2'] });
            }
            if (dealt > 0) battle.heal({ source: unit, target: unit, amount: dealt * num(b2.heal_ratio) });
            m.layers = Math.min(Math.floor(num(b2.max_stack_cnt, 5)), m.layers + 1);
            setLayers(battle, unit, b2);
          },
        },
        [S3]: {
          kind: 'duration', mods: { atkPct: num(b3.atk) }, flags: { disarm: true },
          onStart({ battle, unit }) {
            const owner = CHANNEL.get(battle);
            if (up(owner) && owner !== unit && owner.skill?.active) return;
            CHANNEL.set(battle, unit);
            stateOf(unit).fire = { next: battle.time + FLAME_GAP, over: false, wave: 0 };
          },
          onTick({ battle, unit, skill }) {
            // no canAct test (PRTS 备注, see the header): the field she channels rains on while she is controlled
            const f = stateOf(unit).fire;
            if (!f) return;
            if (!f.over && skill.timeLeft <= skill.duration / 2 + 1e-9) {
              f.over = true;
              f.next = Math.min(f.next, battle.time + OVERLOAD_GAP);
              battle.fx('overload', { x: unit.x, y: unit.y, id: unit.id });
            }
            if (battle.time < f.next - 1e-9) return;
            f.next = battle.time + (f.over ? OVERLOAD_GAP : FLAME_GAP);
            fireWave(battle, unit, b3, f);
          },
          onEnd({ battle, unit }) {
            stateOf(unit).fire = null;
            if (CHANNEL.get(battle) === unit) CHANNEL.delete(battle);
          },
        },
      },
      talents: [
        { install(battle, unit) { installAnger(battle, unit, t0); } },
        { install(battle, unit) { installFootprints(battle, unit, t1); } },
      ],
      install(battle, unit) {
        const m = stateOf(unit);
        battle.on('deploy', ({ unit: u }) => { if (u === unit) { m.layers = 0; m.castAt = -Infinity; } }, { owner: unit });
        installDeathLayers(battle, unit);
        if (unit.skill?.id === S2) installShelter(battle, unit, b2);
        if (unit.skill?.id === S3) installFlames(battle, unit, b3);
      },
    };
  },
};
