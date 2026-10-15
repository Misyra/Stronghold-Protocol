// render/vfx/skillfx.js — the official skill, talent and charge effects in a battle (DESIGN §33, 0.3.0 Phase 3b): the
// plans of render/vfx/skills.js played on the signals the field view already receives. render/vfx/wiring.js owns one
// (`FxWiring.skills`) and calls it from its event entry points; client only — no sim, protocol or golden change.
//
//   const s = new SkillFx(wiring)
//   s.of(v)                      the battle unit's record (plan, charge plan, state), resolved once per battle id
//   s.state(v, skillOn?)         { U, on, plan } — on: the look-ahead's value, else the last 'skill' event, else UF.SKILL
//   s.skill(v, on)               b.ev ['skill', id, on] — true when the official layer shows this skill (render/app.js
//                                then skips the procedural activation burst and aura)
//   s.attackFx(v, tgt, kind, skillOn) → the skill's part of one attack of the owner (FxWiring.attack / castStart), or null
//   s.casts(sk, src, tgt, phase, info) / s.landed(m, v)   its cast / range / aim rows and its hit groups
//   s.trigger(v)                 b.ev 'dmg' on the owner while its skill is on
//   s.released(src, tgt, kind, time)   a 秘术师's attack: the stored energies fly from their slots
//   s.deployed(v) / s.release(v) passive loops follow the deployment; a death / leak / retreat stops all of a unit's loops
//   s.status(v, key)             the status wiring started that loop on v: a skill's target loop of the same key hands over
//   s.sync(views)                once per frame: loops of views built mid-battle (UF.SKILL), passive loops, ready loops,
//                                the stored-energy display (b.snap energy), target loops and marks past their time
//   s.simFx(kind, x, y, extra)   a kit 'fx' tuple the official layer stands for (true: the procedural one is skipped)
//   s.keys(views)                every key to preload; s.clear()
//
// What plays when (skills.js header for the roles and signals):
//   * ['skill', id, 1]: `start` and `range` play on the owner, `loop` starts (hold 'skill': it stops on ['skill', id, 0],
//     the unit's death / leak / retreat, the battle's reset — with the effect's own stop fade); the ready loop stops.
//     ['skill', id, 0]: the loops stop, `end` plays. An activation whose 1 and 0 came in the same frame with no 'atk' of
//     the owner between them (an instant skill whose kit deals the damage itself: 23 of the roster's 61 instant casts in
//     a survey of every kit) plays its first attack's cast and range once.
//   * A view built mid-battle (a reconnect, a watched field) has seen no 'skill' event: its loops follow the snapshot
//     flag UF.SKILL (no start one-shots). A passive (`kind: 'passive'`) is on while the unit is deployed: its loops start
//     at the 'deploy' event (or when the view first shows it), its start one-shots once per deployment.
//   * `ready` loops while sp ≥ spMax > 0 and the skill is off (b.snap; [ASSUMED] for a multi-charge skill).
//   * An attack of the owner while the skill is on (`attackFx`): with an attack ability of its own the skill's rows
//     replace the attack mode's — its cast / range on the owner (ON_CAST_START rows with the wind-up, the others at the
//     strike), `aim` on the target, its hit groups on the target (the k-th 'dmg' — or 'heal' — on that target in that
//     frame plays group k) and, for a ranged one, the skill's own projectile (skills.js skillProjectile); without one the
//     attack mode (plan.modeName) plays and the skill adds its `each` rows. `targets` entries of an attack's buffs
//     (skills.js targetsOf `hit`) loop on each target hit for the buff's duration (our record's blackboard), else while
//     the skill lasts; a status loop the status wiring draws for the same key takes over.
//   * `trigger`: a 'dmg' on the owner while on (at most once a frame).
//   * The 秘术师 charge (b.snap energy, PR #636 — sent whatever 设置「秘术师能量」 says): each store plays its one-shots and
//     lights the next slot's loop (FollowMountPoint on its Special point); an attack releases them — the wiring flies the
//     attack's own projectile from the muzzle and this flies one per stored energy from its slot's mount point (the
//     sim's 1 + energy hits: none doubled); a death / redeploy dims them.
//   * Kit 'fx' tuples (simFx; the procedural fx is skipped when this returns true):
//       (1) FX_BINDINGS (skills.js): a kit fx standing for an official effect no plan row places (克莱门莎 S3's mark);
//       (2) pulse: a fx tagged with its skill (`extra.skill`) while the skill is on, when the plan has `pulse` entries —
//           the owner's buff ticks for a fx on the owner, the skill's other hits for a fx away from it — plays them there;
//       (3) the start flash: a cast-flash fx (FLASH archetypes) on the owner in the frame of its official skill start;
//       (4) a cast-flash fx tagged with the skill on the owner while its official skill loops play.
// [ASSUMED] (no client data says): the target-loop duration; a passive is on while deployed; held start rows of a skill
// stop after SKILL_CAST_S; at most one trigger effect per frame; a release's projectiles leave together with the shot;
// the start-flash and loop-cover archetypes.

import {
  planFor, attackFx as planAttack, slotKey, planKeys, chargeKeys, chargeStep, skillProjectile, targetsOf, buffDuration,
  eventNum, FX_BINDINGS, bindingEffects, bindingKeys,
} from './skills.js';
import { fxSpec } from '../fx/kinds.js';
import { UF } from '../../../../shared/constants.js';

/** Battle seconds a held (non-oneshot) row of a skill's single cast lasts (FxWiring's CAST_LOOP_S for attacks). */
export const SKILL_CAST_S = 0.6;
/** Battle seconds after a release in which a stale energy reading is ignored (the next store takes an attack interval). */
const RELEASE_GUARD_S = 0.35;
/** A fx on the unit: its (x, y) within this many tiles (render/fx/simfx.js ANCHOR_SNAP). */
const ON_UNIT = 0.75;
/** Procedural archetypes (render/fx/kinds.js) that are a cast flash: an official skill start / loop stands for them. */
export const FLASH = Object.freeze(new Set(['blast', 'buff', 'wave', 'pillar', 'strike', 'element', 'shield', 'heal', 'healAoe', 'sp', 'generic']));
/** Archetypes that show a unit's state or a game fact (never replaced by a skill's pulse). */
const NOT_PULSE = new Set(['none', 'dp', 'coin', 'lp', 'crate', 'down', 'reticle', 'mark', 'summon', 'vanish', 'blink', 'move', 'sleep', 'lift', 'dodge', 'crit', 'telegraph', 'zone', 'wall', 'shell']);
const DIRS = ['UP', 'RIGHT', 'DOWN', 'LEFT'];
/** Ability events a row starts with the cast (ON_ATTACHED, ON_CAST_START); the others at the strike. */
const CAST_START = new Set([0, 2]);

const idOf = (v) => v?.info?.id ?? v?.id;
/**
 * The entries of a list with a key of their own (the first of each): the extractor may reach one effect by two paths
 * (a buff's `_buffs` and `_extraBuffs`, two nodes of one skill) — played once, as the one buff it is [ASSUMED].
 */
export function uniq(list) {
  if (!list || list.length < 2) return list || [];
  const seen = new Set();
  return list.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
}
const beyond = (a, b) => ({ x: b.x + (b.x - a.x), y: b.y + (b.y - a.y) });

/** Run `fn` after `s` battle seconds on the effects' clock (FxWiring.tick runs the timers). */
export function later(ofx, s, fn) {
  if (!ofx.timers) ofx.timers = [];
  ofx.timers.push({ at: ofx.time + Math.max(0, s), fn });
}

/** Whether a skill's attack ability is the kind of attack the sim made (a heal, a shot, a blow). */
export function fitsAttack(ability, { heal = false, ranged = false } = {}) {
  if (typeof ability !== 'string') return false;
  if (heal) return /Heal/.test(ability);
  if (/Heal/.test(ability)) return false;
  return ranged ? /Ranged/.test(ability) : !/Ranged/.test(ability);
}

/**
 * When a plan row of an attack plays: 'start' with the cast (its ability event ON_ATTACHED / ON_CAST_START, a buff
 * template's ON_ABILITY_START, or no event), else 'strike' (ON_SPELL_ON, ON_BEFORE_ATTACK, …).
 */
export function castPhase(e) {
  if (e?.startEvent != null) return CAST_START.has(eventNum(e.startEvent)) ? 'start' : 'strike';
  if (e?.event) return e.event === 'ON_ABILITY_START' ? 'start' : 'strike';
  return 'start';
}

export class SkillFx {
  /** @param {import('./wiring.js').FxWiring} w */
  constructor(w) {
    this.w = w;
    this.units = new Map();    // battle id → unit record | null (nothing official to play)
    this.tloops = new Map();   // `${target id}|${key}` → { h, until, U, tgt, bySkill } (skills.js targetsOf `hit`)
    this.marks = [];           // FX_BINDINGS reached effects: { owner, r, c, until, h, cover }
    this.frame = 0;            // FxWiring.tick counts frames: events of one frame share a value
    this.sweep = 0;
    this.tier = null;
    this.wasActive = false;
  }

  active() { return !!this.w.ofx.active && !!this.w.idx; }

  // ---- resolution -------------------------------------------------------------------------------------------------

  /** The record of a battle unit (resolved once per battle id), or null when nothing official belongs to it. */
  of(v) {
    if (!v || !this.w.idx) return null;
    const id = idOf(v);
    if (id == null) return null;
    let U = this.units.get(id);
    if (U === undefined) {
      U = null;
      const info = v.info || null;
      if (info && info.kind !== 'device' && info.kind !== 'item') {
        const unitKey = this.w.unitKeyOf(v);
        const r = unitKey ? planFor(this.w.idx, { info, rec: this._recordOf(info), unitKey }) : null;
        if (r && (r.plan || r.charge)) U = this._record(id, r);
      }
      this.units.set(id, U);
    }
    if (U) U.v = v;
    return U;
  }

  /** The unit's data record (FxWiring opts.record: render/app.js ctx.lookupDef), or null. */
  _recordOf(info) {
    if (typeof this.w.opts.record !== 'function') return null;
    try { return this.w.opts.record(info) || null; } catch { return null; }
  }

  _record(id, r) {
    const idx = this.w.idx, plan = r.plan;
    const has = (k) => !!k && this.w.ofx.lib.has(k);
    let draws = false;
    if (plan) {
      draws = [...plan.start, ...plan.loop, ...plan.range].some((e) => has(e.key) || (e.slots || []).some(has))
        || plan.attacks.some((a) => [...a.cast, ...a.range].some((e) => has(e.key)));
      const mode = plan.modeName ? (idx.units[r.unitKey]?.modes || []).find((m) => m.name === plan.modeName) : null;
      const a = mode?.attack;
      if (a && ((a.cast || []).length || (a.hit || []).length || a.projectileKey)) draws = true;
    }
    return {
      id, v: null, key: r.unitKey, skillId: r.skillId, plan, charge: r.charge, srec: r.srec,
      buffS: buffDuration(r.srec), tHit: plan ? targetsOf(idx, plan).hit : [], drawsStart: draws,
      on: null, startFrame: -1, atkN: 0, attacked: false, byFlag: false, loopsOn: false,
      loops: [], ready: [], readyOn: false, passiveOn: false, passiveShots: false, passiveDraws: false, passiveDone: false, timed: false,
      energy: 0, slotLoops: [], guardUntil: -Infinity, quiet: false, trigFrame: -1, seen: 0,
    };
  }

  /**
   * Whether a unit's skill is on, and its plan: `skillOn` (the wind-up's look-ahead) wins, then the last 'skill' event,
   * then the snapshot flag UF.SKILL; a passive is on while the unit stands.
   */
  state(v, skillOn) {
    const U = this.of(v);
    let on = typeof skillOn === 'boolean' ? skillOn : U && U.on !== null ? U.on : !!((v?.flags | 0) & UF.SKILL);
    if (U && this._passive0(U)) on = v.alive !== false;
    return { U, on, plan: U ? U.plan : null };
  }

  /** A passive the sim keeps on while deployed (it never set UF.SKILL; a kit may run a PASSIVE skill as a timed one). */
  _passive0(U) { return U.plan?.kind === 'passive' && !U.timed; }

  _on(U) { return !!U && (this._passive0(U) ? U.v?.alive !== false : U.on !== null ? U.on : !!((U.v?.flags | 0) & UF.SKILL)); }

  // ---- playing ----------------------------------------------------------------------------------------------------

  /** The key an entry plays for the unit's facing (a directional row's slot; skills.js slotKey). */
  _key(e, v) {
    if (!e.directionType || !Array.isArray(e.slots) || !e.slots.some(Boolean)) return e.key;
    return slotKey(e, DIRS[this.w._dirIndex(e.directionType, v)]);
  }

  /** Play an entry on a view; held ones (skill / ready / deploy) follow the unit's mount point and are never dropped. */
  _play(e, v, o = {}) {
    if (!v) return null;
    const k = this._key(e, v);
    if (!k) return null;
    const held = e.hold === 'skill' || e.hold === 'ready' || e.hold === 'cast';
    return this.w.playOn(k, v, { follow: held, loop: e.hold === 'skill' || e.hold === 'ready', important: held || !!o.important, toward: o.toward, flipFrom: o.flipFrom, skip: o.skip });
  }

  /** Keep a started entry by its hold: the skill's loops, the ready loops, or stopped at the cast's end. */
  _keep(U, e, h, castS = SKILL_CAST_S) {
    if (!h) return;
    if (e.hold === 'skill') U.loops.push(h);
    else if (e.hold === 'ready') U.ready.push(h);
    else if (e.hold === 'cast' || e.loop) later(this.w.ofx, castS, () => h.stop());
  }

  _stopLoops(U) {
    for (const h of U.loops) h.stop();
    U.loops = [];
    U.loopsOn = false;
    U.byFlag = false;
  }

  _startReady(U, v) {
    U.readyOn = true;
    for (const e of uniq(U.plan.ready)) this._keep(U, e, this._play(e, v));
  }

  _stopReady(U) {
    for (const h of U.ready) h.stop();
    U.ready = [];
    U.readyOn = false;
  }

  /** The loops of a skill that is on without its start (a view built mid-battle, the layer switched on): no one-shots. */
  _loopsOnly(U, v, byFlag) {
    U.loopsOn = true;
    U.byFlag = byFlag;
    for (const e of uniq([...U.plan.start, ...U.plan.range, ...U.plan.loop])) if (e.hold === 'skill') this._keep(U, e, this._play(e, v));
  }

  /** A passive's loops (while deployed) and, once per deployment, its start one-shots. */
  _passive(U, v, shots) {
    let drew = false;
    if (!U.passiveOn) {
      U.passiveOn = true;
      U.loopsOn = true;
      for (const e of uniq([...U.plan.start, ...U.plan.range, ...U.plan.loop])) {
        if (e.hold !== 'skill') continue;
        const h = this._play(e, v);
        if (h) { drew = true; this._keep(U, e, h); }
      }
    }
    if (shots && !U.passiveShots) {
      U.passiveShots = true;
      for (const e of uniq([...U.plan.start, ...U.plan.range])) {
        if (e.hold === 'skill') continue;
        const h = this._play(e, v);
        if (h) { drew = true; this._keep(U, e, h); }
      }
    }
    U.passiveDraws = U.passiveDraws || drew || U.drawsStart;
    return U.passiveDraws;
  }

  // ---- the skill events -------------------------------------------------------------------------------------------

  /** b.ev ['skill', id, on] (module header). Returns true when the official layer shows this skill. */
  skill(v, on) {
    const U = this.of(v);
    if (!U || !U.plan) return false;
    const live = this.active();
    if (U.plan.kind === 'passive') {
      // a passive: its loops follow the deployment (the sim's 1 / 0 frame its 0.5 s clip) — unless the kit runs it as a
      // timed skill (UF.SKILL seen: `timed`), whose 0 ends it
      U.on = !!on;
      if (on) { U.passiveDone = false; return live ? this._passive(U, v, true) : false; }
      if (U.timed) {
        U.passiveDone = true;
        U.passiveOn = false;
        if (live) { this._stopLoops(U); for (const e of uniq(U.plan.end)) this._keep(U, e, this._play(e, v)); }
      }
      return live && U.passiveDraws;
    }
    if (on) {
      U.on = true;
      U.startFrame = this.frame;
      U.atkN = 0;
      U.attacked = false;
      if (!live) return false;
      this._stopReady(U);
      this._stopLoops(U);          // a cast while on (onEnd re-cast) starts afresh
      let drew = false;
      for (const e of uniq([...U.plan.start, ...U.plan.range, ...U.plan.loop])) {
        const h = this._play(e, v);
        if (h) { drew = true; this._keep(U, e, h); }
      }
      U.loopsOn = true;
      return drew || U.drawsStart;
    }
    const was = U.on === true;
    U.on = false;
    if (!live) return false;
    // an instant skill whose kit made no attack between 1 and 0: its own attack's cast plays once (skills.js: one cast)
    if (was && !U.attacked && U.startFrame === this.frame && U.plan.attacks.length) {
      const a = U.plan.attacks[0];
      for (const e of uniq([...a.cast, ...a.range])) this._keep(U, e, this._play(e, v));
    }
    this._stopLoops(U);
    for (const e of uniq(U.plan.end)) this._keep(U, e, this._play(e, v));
    return U.drawsStart;
  }

  /** b.ev 'deploy': a passive's loops and start one-shots; a redeployed 秘术师 starts with no energy. */
  deployed(v) {
    const U = this.of(v);
    if (!U) return false;
    U.energy = 0;
    if (!U.plan || U.plan.kind !== 'passive') return false;
    U.passiveDone = false;
    if (!this.active() || (U.timed && !U.on)) return false;
    return this._passive(U, v, true);
  }

  /** Stop every loop of a unit (its death / leak / retreat, its view gone) and every target loop on it. */
  release(v) {
    const id = idOf(v);
    const U = id != null ? this.units.get(id) : null;
    if (U) this._releaseU(U);
    for (const [slot, t] of this.tloops) if (idOf(t.tgt) === id) { t.h.stop(); this.tloops.delete(slot); }
  }

  _releaseU(U) {
    this._stopLoops(U);
    this._stopReady(U);
    for (const hs of U.slotLoops) for (const h of hs || []) h.stop();
    U.slotLoops = [];
    U.energy = 0;
    U.passiveOn = false;
    U.passiveShots = false;
    U.passiveDone = false;
    U.on = null;
  }

  /** The status wiring draws `key` on v from now on: a skill's target loop of the same key hands over (never twice). */
  status(v, key) {
    const t = this.tloops.get(`${idOf(v)}|${key}`);
    if (t) { t.h.stop(); this.tloops.delete(`${idOf(v)}|${key}`); }
  }

  // ---- attacks ----------------------------------------------------------------------------------------------------

  /**
   * The skill's part of one attack of `src` on `tgt` (null when the skill is off or adds nothing): `fx` (skills.js
   * attackFx: cast / range / aim / hit groups, `each` merged), `replace` (the skill's own attack ability: its rows replace
   * the attack mode's), `projectile` (a ranged one's: the skill's own), `buffs` (targetsOf `hit`).
   */
  attackFx(src, tgt, kind, skillOn) {
    const st = this.state(src, skillOn);
    if (!st.on || !st.plan) return null;
    const ranged = !!kind && kind !== 'none';
    const heal = !!tgt && !tgt.isEnemy && !src.isEnemy;
    const fx = planAttack(st.plan, { heal, ranged });
    // the skill's own ability replaces the mode's rows when it is this kind of attack: a melee blow is no shield throw
    // (斩业星熊 S2: her MultiMelee mode attacks while the skill's AroundTargetRangedAttack throws on its own)
    const replace = !!fx.ability && fitsAttack(fx.ability, { heal, ranged });
    if (fx.ability && !replace) { fx.cast = fx.cast.filter((e) => e.ability !== fx.ability); fx.range = []; fx.aim = []; fx.hit = st.plan.each.hit[0].length ? [st.plan.each.hit[0]] : []; }
    const projectile = replace && ranged ? skillProjectile(this.w.idx, st.plan) : null;
    if (!replace && !fx.cast.length && !fx.hit.length && !st.U.tHit.length) return null;
    return { U: st.U, fx, replace, projectile, buffs: st.U.tHit };
  }

  /**
   * The skill's cast rows of an attack for a phase ('start' | 'strike' | 'all'; FxWiring._casts): cast and range on the
   * owner (not for another target of the same attack: `info.owner` false), aim on the target.
   */
  casts(sk, src, tgt, phase, info = {}) {
    const nth = sk.U.atkN;
    for (const [rows, onTarget] of [[sk.fx.cast, false], [sk.fx.range, false], [sk.fx.aim, true]]) {
      if (!onTarget && info.owner === false) continue;
      for (const e of uniq(rows)) {
        const first = castPhase(e) === 'start';
        if ((phase === 'start' && !first) || (phase === 'strike' && first) || (onTarget && !tgt)) continue;
        if ((e.firstOnly && nth > 0) || (e.afterFirst && nth === 0)) continue;
        const skip = phase === 'start' ? info.skip : 0;
        const h = onTarget ? this._play(e, tgt, { toward: beyond(src, tgt), flipFrom: src, skip }) : this._play(e, src, { toward: tgt, skip });
        if (h && (e.hold === 'cast' || e.loop)) later(this.w.ofx, phase === 'start' && info.left > 0 ? Math.min(3, info.left) : SKILL_CAST_S, () => h.stop());
      }
    }
  }

  /** The attack was made (FxWiring.attack, after its rows): the activation's attack count. */
  attacked(sk) { sk.U.atkN++; sk.U.attacked = true; }

  /**
   * A hit of a skill attack landed on v ('dmg' / 'heal'; FxWiring keeps the record `m` = { groups, buffs, U, src, k,
   * hitT } and drops it once a later frame's damage arrives): the k-th hit of the frame plays group k (the last one again
   * past the end); the first one also starts the buffs' loops.
   */
  landed(m, v, time) {
    let drew = false;
    if (m.hitT == null) { m.hitT = time; m.k = 0; }
    const g = m.groups.length ? m.groups[Math.min(m.k, m.groups.length - 1)] : [];
    m.k++;
    for (const e of uniq(g)) if (this._play(e, v, { flipFrom: m.src })) drew = true;
    if (m.k === 1) for (const e of uniq(m.buffs)) if (this._targetLoop(m.U, e, v)) drew = true;
    return drew;
  }

  /** A buff an attack of the skill put on v (targetsOf `hit`): its loop for the buff's duration, else while on. */
  _targetLoop(U, e, v) {
    const key = this._key(e, v);
    if (!key || this.w.statusShows(v, key)) return null;
    const lasting = U.plan.kind === 'lasting' || U.plan.kind === 'ammo';
    if (!(U.buffS > 0) && !lasting) return null;
    const slot = `${idOf(v)}|${key}`;
    const until = U.buffS > 0 ? this.w.ofx.time + U.buffS : Infinity;
    const t = this.tloops.get(slot);
    if (t && t.h.alive) { t.until = Math.max(t.until, until); t.U = U; return t.h; }
    const h = this.w.playOn(key, v, { follow: true, loop: true, important: true, flipFrom: U.v || undefined });
    if (h) this.tloops.set(slot, { h, until, U, tgt: v, bySkill: !(U.buffS > 0) });
    return h;
  }

  /** b.ev 'dmg' on v: its skill's `trigger` while the skill is on (once a frame). */
  trigger(v) {
    const id = idOf(v);
    const U = id != null ? this.units.get(id) : null;
    if (!U || !U.plan || !U.plan.trigger.length || !this.active() || !this._on(U) || U.trigFrame === this.frame) return false;
    U.trigFrame = this.frame;
    let drew = false;
    for (const e of uniq(U.plan.trigger)) { const h = this._play(e, v); if (h) { drew = true; this._keep(U, e, h); } }
    return drew;
  }

  // ---- the 秘术师 charge ------------------------------------------------------------------------------------------

  /**
   * An attack of a unit with stored energies (FxWiring.attack): one projectile per energy leaves its slot's mount point
   * for the target (the store ability's projectile of the current mode, chargePlan onRelease) and the slots go dark.
   * Returns the number flown.
   */
  released(src, tgt, kind, time) {
    const U = this.of(src);
    if (!U || !U.charge || !(U.energy > 0) || !tgt || !this.active()) return 0;
    const n = U.energy;
    const rel = U.charge.onRelease;
    const mode = this.w.mode(this.w.unitOf(src), src);
    const pk = rel.projectiles[mode?.name] || rel.projectiles[(mode?.name || '').replace(/_T\d+$/, '')] || rel.projectiles.Default;
    const proj = pk ? this.w.idx.projectiles[pk] : null;
    let flown = 0;
    for (let i = 0; i < n; i++) {
      if (proj && kind && kind !== 'none') { this.w._fly(proj, src, tgt, kind, time, { mount: rel.mountTypes?.[i] ?? null }); flown++; }
      for (const h of U.slotLoops[i] || []) h.stop();
      U.slotLoops[i] = null;
    }
    U.energy = 0;
    U.guardUntil = this.w.ofx.time + RELEASE_GUARD_S;
    return flown;
  }

  /** The stored count in the snapshot changed: the stores' one-shots, the slots' loops (skills.js chargeStep). */
  _charge(U, v, n) {
    if (n === U.energy) return;
    if (n > U.energy && this.w.ofx.time < U.guardUntil) return;   // the released energies' last reading
    const st = chargeStep(U.charge, U.energy, n);
    U.energy = n;
    if (!U.quiet) for (const k of st.gain) this.w.playOn(k, v, { follow: true });
    for (const i of st.light) {
      for (const h of U.slotLoops[i] || []) h.stop();
      U.slotLoops[i] = U.charge.slots[i].hold.map((k) => this.w.playOn(k, v, { follow: true, loop: true, important: true })).filter(Boolean);
    }
    for (const i of st.dim) { for (const h of U.slotLoops[i] || []) h.stop(); U.slotLoops[i] = null; }
  }

  // ---- the frame --------------------------------------------------------------------------------------------------

  /** Once per frame, after the views took the frame's sample (module header). */
  sync(views) {
    const active = this.active();
    const tier = this.w.ofx.tier;
    if (this.tier === null) { this.tier = tier; this.wasActive = active; }   // the first frame: nothing was cleared
    if (tier !== this.tier || active !== this.wasActive) {
      // the effects were cleared (a tier switch) or not drawn: what should run starts again below, quietly
      for (const U of this.units.values()) {
        if (!U) continue;
        for (const h of [...U.loops, ...U.ready, ...U.slotLoops.flat().filter(Boolean)]) h.stop();
        U.loops = []; U.ready = []; U.slotLoops = []; U.loopsOn = false; U.readyOn = false; U.passiveOn = false; U.energy = 0; U.quiet = true;
      }
      for (const t of this.tloops.values()) t.h.stop();
      this.tloops.clear();
      this.tier = tier;
      this.wasActive = active;
    }
    if (!active) return;
    const sweep = ++this.sweep;
    const now = this.w.ofx.time;
    for (const v of views) {
      const U = this.of(v);
      if (!U) continue;
      U.seen = sweep;
      const up = v.alive !== false && !v.destroyed && !v.down;
      if (!up) { if (U.loopsOn || U.readyOn || U.passiveOn || U.energy) this._releaseU(U); continue; }
      if (U.plan) {
        const flag = !!((v.flags | 0) & UF.SKILL);
        if (U.plan.kind === 'passive') {
          if (flag) U.timed = true;   // the kit runs it as a timed skill: its events start and end it
          if (!U.passiveOn && !U.passiveDone && (!U.timed || (U.on ?? flag))) this._passive(U, v, false);
        } else {
          const on = U.on !== null ? U.on : flag;
          if (on && !U.loopsOn) this._loopsOnly(U, v, U.on === null);
          else if (!on && U.loopsOn && U.byFlag) this._stopLoops(U);
          const ready = U.plan.ready.length > 0 && !on && !flag && v.spMax > 0 && v.sp >= v.spMax - 1e-3;
          if (ready !== U.readyOn) { if (ready) this._startReady(U, v); else this._stopReady(U); }
        }
      }
      if (U.charge) this._charge(U, v, Array.isArray(v.energy) ? Math.max(0, Math.floor(Number(v.energy[0]) || 0)) : 0);
      U.quiet = false;
    }
    for (const U of this.units.values()) {
      if (U && U.seen !== sweep && (U.loopsOn || U.readyOn || U.passiveOn || U.energy)) this._releaseU(U);
    }
    for (const [slot, t] of this.tloops) {
      const tv = t.tgt;
      if (!tv || tv.destroyed || tv.alive === false || now >= t.until || (t.bySkill && !this._on(t.U)) || !t.h.alive) {
        t.h.stop();
        this.tloops.delete(slot);
      }
    }
    if (this.marks.length) this.marks = this.marks.filter((m) => m.until > now);
  }

  // ---- kit fx -----------------------------------------------------------------------------------------------------

  /** b.ev ['fx', kind, x, y, extra]: true when the official layer stands for it (module header: bindings 1–4). */
  simFx(kind, x, y, extra) {
    if (!this.active() || !extra || typeof extra !== 'object' || typeof kind !== 'string') return false;
    const now = this.w.ofx.time;
    // (1) explicit bindings and what they cover
    for (const m of this.marks) {
      if (m.until > now && m.cover.includes(kind) && extra.id === m.owner && Math.round(y) === m.r && Math.round(x) === m.c) return true;
    }
    for (const field of ['src', 'id']) {
      const U = extra[field] != null ? this.units.get(extra[field]) : null;
      const bind = U ? FX_BINDINGS[U.skillId]?.[kind] : null;
      if (bind && bind.owner === field) return this._bound(U, bind, x, y, extra);
    }
    const U = this.units.get(extra.id ?? extra.src);
    if (!U || !U.plan || !U.v) return false;
    const v = U.v;
    const a = fxSpec(kind, extra).a;
    const near = !Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(v.x - x, v.y - y) <= ON_UNIT;
    const on = this._on(U);
    // (2) the skill's pulse: the kit's own fx of the moment its plan's tick / hit rows have no event for
    if (extra.skill != null && on && U.plan.pulse.length && !NOT_PULSE.has(a)) {
      const list = U.plan.pulse.filter((e) => (e.at === 'owner') === near);
      if (list.length) {
        const at = near ? v : (this.w.view(extra.target ?? extra.to) || { id: 'fx:point', x, y, z: 0 });
        let drew = false;
        for (const e of uniq(list)) { const h = this._play(e, at, { flipFrom: near ? undefined : v }); if (h) { drew = true; this._keep(U, e, h); } }
        if (drew) return true;
      }
    }
    if (!near || !FLASH.has(a)) return false;
    // (3) the frame of the official skill start, (4) a skill-tagged flash while the official loops play
    if (U.startFrame === this.frame && U.drawsStart) return true;
    return extra.skill != null && on && U.loops.some((h) => h.alive);
  }

  /** An FX_BINDINGS entry: the projectile's reached effects where the fx happens, held as the binding says. */
  _bound(U, bind, x, y, extra) {
    const keys = bindingEffects(this.w.idx, bind).filter((k) => this.w.ofx.lib.has(k));
    if (!keys.length) return false;
    const tv = this.w.view(extra.id);
    const at = bind.at === 'point' || !tv ? { id: 'fx:point', x, y, z: tv ? tv.z || 0 : 0 } : tv;
    const bb = U.srec?.bb || {};
    const holdS = Number(bb[bind.hold]) > 0 ? Number(bb[bind.hold]) : bind.holdS || SKILL_CAST_S;
    let drew = false;
    for (const k of keys) {
      const h = this.w.playOn(k, at, { loop: true, important: true });
      if (!h) continue;
      drew = true;
      later(this.w.ofx, holdS, () => h.stop());
      this.marks.push({ owner: U.id, r: Math.round(y), c: Math.round(x), until: this.w.ofx.time + holdS, h, cover: bind.cover || [] });
    }
    return drew;
  }

  // ---- preload ----------------------------------------------------------------------------------------------------

  /** Every key the battle's units' skills, charges and bindings can play (FxWiring.begin / more). */
  keys(views) {
    const idx = this.w.idx;
    const out = new Set();
    const proj = (pk) => { const p = pk && idx.projectiles?.[pk]; if (p) for (const k of p.effects || []) out.add(String(k).toLowerCase()); };
    for (const v of views) {
      const U = this.of(v);
      if (!U) continue;
      if (U.plan) {
        for (const k of planKeys(U.plan)) out.add(k);
        for (const pk of U.plan.projectiles) proj(pk);
        for (const k of bindingKeys(idx, U.skillId)) out.add(k);
      }
      if (U.charge) {
        for (const k of chargeKeys(U.charge)) out.add(k);
        for (const pk of Object.values(U.charge.onRelease.projectiles || {})) proj(pk);
      }
    }
    return [...out];
  }

  /** Battle reset: forget every unit (the effects themselves are cleared by OfficialFx.clear). */
  clear() {
    this.units.clear();
    this.tloops.clear();
    this.marks = [];
  }
}
