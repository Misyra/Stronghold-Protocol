// render/vfx/wiring.js — the battle's events → official effects, generated from index.json (DESIGN §33.12): every
// unit's normal attack (its mode `Default`, or `S<n>` while skill n is on) casts its `cast` effects at its muzzle
// (`_spawnLocation`), flies its projectile's `main` effect along the sim's flight (the sim's speed: the visual lands
// with the sim's damage) and plays the projectile's `onHit` at the target's HitPoint on arrival (`onReached` where it
// lands); a melee attack's `hit` effects play when its damage lands; status loops (generic.status by the sim's status
// names) follow the unit's mount point while the status lasts; deaths and deploys play the unit's own dead / start
// effect or the generic one. What index.json cannot drive (skills, an unknown unit) stays procedural: each entry point
// returns whether it drew the official effect.
//
//   const w = new FxWiring(ofx, { unitKey: (info) => string|null, speed: (kind) => tiles per game s })
//   await w.begin(infos)          preload the battle's units' effects (prep → battle)
//   w.attack(src, tgt, kind, time) / w.damage(v, type, src, time) / w.heal(v, time) / w.status(v, name, on) /
//   w.death(v) / w.deploy(v) / w.clear()
//
// [ASSUMED] (index.json does not say): a cast list with a direction type other than NONE plays its first effect; a
// non-oneshot cast stops after CAST_LOOP_S; a FLIP_TWO_SIDE hit is mirrored when the blow comes from the right; the
// generic hit by damage type for a melee attack that lists none (an enemy's: `enemy`); a heal that came by no official
// projectile plays the generic heal hit.

import { spawnPoint, mountPoint, unitPoint, spawnKind } from './mounts.js';
import { GROUND_SPAWNS } from './effect.js';
import { UF } from '../../../../shared/constants.js';

/** Battle seconds a non-oneshot cast effect lasts without its end event. */
export const CAST_LOOP_S = 0.6;
/** Battle seconds a melee blow waits for its damage. */
const MELEE_WINDOW = 0.4;
/** Battle seconds a projectile's arrival covers the damage event it stands for. */
const ARRIVAL_WINDOW = 0.35;

const lc = (k) => (typeof k === 'string' && k ? k.toLowerCase() : null);

export class FxWiring {
  /**
   * @param {import('./system.js').OfficialFx} ofx
   * @param {{ unitKey?: (info: any) => string|null, speed?: (kind: string) => number }} [opts]
   */
  constructor(ofx, opts = {}) {
    this.ofx = ofx;
    this.opts = opts;
    this.idx = null;
    this.flights = new Set();     // projectile flights in the air
    this.loops = new Map();       // `${unitId}|${status}` → handle
    this.melee = new Map();       // target id → { keys, src, t, flip }
    this.arrived = new Map();     // target id → battle time of an official projectile hit
    this.healed = new Map();      // target id → battle time of an official heal projectile hit
    this.keyCache = new Map();    // unit id → index unit key | null
  }

  get index() { return this.idx; }

  /** index.json, once. */
  async ready() {
    if (!this.idx) this.idx = await this.ofx.lib.index();
    return !!this.idx;
  }

  /** The index unit of a view (by its info), cached per battle id. */
  unitOf(v) {
    if (!v || !this.idx) return null;
    const id = v.info?.id ?? v.id;
    let k = this.keyCache.get(id);
    if (k === undefined) {
      k = null;
      const cands = this.opts.unitKey ? [].concat(this.opts.unitKey(v.info) || []) : [];
      cands.push(v.info?.spine, v.info?.defId);
      for (const c of cands) {
        if (!c) continue;
        if (this.idx.units[c]) { k = c; break; }
        const base = String(c).replace(/_\d+$/, '');
        if (base !== c && this.idx.units[base]) { k = base; break; }
      }
      this.keyCache.set(id, k);
    }
    return k ? this.idx.units[k] : null;
  }

  skinOf(u) { return u && u.skin && this.idx ? this.idx.skins[u.skin] || null : null; }

  /** Where a view stands: board feet + facing, as mounts.js reads it. */
  pose(v) {
    return { x: v.x, y: v.y, z: (v.z || 0) + (v.hover || 0), left: (v.visFacing ?? v.facing ?? 1) < 0, back: typeof v._wantsBack === 'function' ? !!v._wantsBack() && !!v.entryBack : false };
  }

  /** The battle's units' effect keys (for preloading). */
  keysFor(views) {
    const keys = new Set();
    const g = this.idx?.generic;
    if (g) {
      for (const k of Object.values(g.hit || {})) if (k) keys.add(k);
      for (const k of Object.values(g.die || {})) if (k) keys.add(k);
      for (const k of Object.values(g.birth || {})) if (k) keys.add(k);
      for (const k of Object.values(g.status || {})) if (k) keys.add(k);
    }
    for (const v of views) {
      const u = this.unitOf(v);
      if (!u) continue;
      for (const m of u.modes || []) {
        const a = m.attack || {};
        for (const list of [a.cast, a.hit]) for (const e of list || []) for (const k of e.effects || []) keys.add(k);
        for (const pk of [a.projectileKey, ...(a.extraProjectileKeys || [])]) {
          const p = pk && this.idx.projectiles[lc(pk)];
          if (p) for (const k of p.effects || []) keys.add(k);
        }
        if (m.overrideStartEffect) keys.add(m.overrideStartEffect);
        if (m.overrideDeadEffect) keys.add(m.overrideDeadEffect);
      }
      if (u.startEffect) keys.add(u.startEffect);
      if (u.deadEffect) keys.add(u.deadEffect);
    }
    return [...keys].map(lc).filter((k) => k && this.ofx.lib.has(k));
  }

  /** Preload the effects of the battle's units (views) — the prep → battle switch. */
  async begin(views) {
    if (!this.ofx.active) return 0;
    await this.ready();
    if (!this.idx) return 0;
    const keys = this.keysFor(views);
    const n = await this.ofx.lib.preload(keys, { half: this.ofx.lite });
    this.ofx.warm?.(keys);
    return n;
  }

  /** The attack mode of a unit now (`S<n>` while its skill n is on and the unit has such a mode). */
  mode(u, v) {
    const modes = u?.modes || [];
    if (!modes.length) return null;
    const skillOn = !!(v.flags & UF.SKILL);
    if (skillOn && Number.isInteger(v.info?.skillIndex)) {
      const m = modes.find((x) => x.name === `S${v.info.skillIndex + 1}`);
      if (m && m.attack) return m;
    }
    return modes.find((x) => x.name === 'Default') || modes[0];
  }

  /**
   * The facing variant a prefab names for its owner (SwitchableBackEffect for a unit facing up, SwitchableRightEffect,
   * SwitchableEffectByFaceDirection), or null to keep it; 'common_empty' means none.
   */
  _variant(sw, v, pose) {
    const dir = typeof v?.dir === 'string' ? v.dir.toUpperCase() : null;
    if (sw.back && (pose.back || dir === 'UP')) return sw.back;
    if (sw.right && (!pose.left !== !!sw.reverse)) return sw.right;
    if (dir === 'UP' && sw.up) return sw.up;
    if (dir === 'DOWN' && sw.down) return sw.down;
    if (dir === 'LEFT' && sw.left) return sw.left;
    return null;
  }

  /** PauseEffectIf: the effect hides while its owner shows a condition (facing, abnormal flags). */
  _paused(pz, v, pose) {
    const conds = [];
    if (pz.back) conds.push(pose.back || v?.dir === 'UP');
    if (pz.right) conds.push(!pose.left);
    if (pz.flags.length) conds.push(pz.flags.some((f) => abnormal(v, f)));
    if (!conds.length) return false;
    return pz.all ? conds.every(Boolean) : conds.some(Boolean);
  }

  /** Spawn an effect key on a view at its spawn location; o: { toward (view|point), flipFrom (view), track }. */
  playOn(key, v, o = {}) {
    let k = lc(key);
    if (!k || !this.ofx.lib.has(k)) return null;
    let def = this.ofx.lib.def(k);
    if (def && def.switchable) {
      const alt = lc(this._variant(def.switchable, v, this.pose(v)));
      if (alt === 'common_empty') return null;
      if (alt && alt !== k && this.ofx.lib.has(alt)) { k = alt; def = this.ofx.lib.def(k); }
    }
    const u = this.unitOf(v);
    const skin = this.skinOf(u);
    const spawn = def ? def.spawn : 2;
    const pose = this.pose(v);
    const pos = spawnPoint(skin, spawn, pose);
    const ground = (v.z || 0);
    if (def && GROUND_SPAWNS.has(spawn)) pos[2] = -ground;
    const place = { pos, groundZ: -ground, yaw: 0, mirror: false, flipY: false };
    this._orient(def, place, pose, o, v);
    const opts = { track: o.track || null, data: o.data ?? null, loop: !!o.loop, important: !!o.important };
    // the owner each frame: FollowMountPoint keeps the effect on the unit's point (status loops: o.follow), FollowDirection
    // turns it with the unit, PauseEffectIf hides it while the unit shows a condition
    const follow = o.follow && def?.follow, turn = !!def?.direction, pause = def?.pause;
    if (!o.track && (follow || turn || pause)) {
      opts.track = (fx) => {
        if (!v || v.destroyed) return;
        const p = this.pose(v);
        if (follow) { mountPoint(skin, def.follow.mount, p, fx.anchor); fx.groundZ = -(v.z || 0); }
        if (turn) {
          const pl = { yaw: fx.yaw, mirror: fx.mirror, flipY: fx.flipY };
          this._orient(def, pl, p, {}, v);
          fx.yaw = pl.yaw; fx.mirror = pl.mirror; fx.flipY = pl.flipY;
        }
        if (pause) fx.hidden = this._paused(pause, v, p);
      };
    }
    return this.ofx.spawn(k, place, opts);
  }

  /**
   * Direction of an effect (ParticleEffect `_rotateType`): FLIP_TWO_SIDE turns the `_rotationY` helper 180° (or
   * mirrors the effect without one) for a left-facing owner — a hit by the blow's side —; FOUR_DIRECTION / ANY_DIR
   * turn towards the target, or along the owner's body direction (`_useBodyRotation`: an operator's deploy direction,
   * an enemy's facing); FOUR_DIRECTION snaps to the four directions.
   */
  _orient(def, place, pose, o, v) {
    if (!def) return;
    const rt = def.rotateType;
    if (rt === 1) {
      let left = pose.left;
      if (o.flipFrom) left = o.flipFrom.x > pose.x; // a blow from the right splashes to the left
      const flip = left !== def.leftIsDefault;
      if (def.rotY >= 0) place.flipY = flip; else place.mirror = flip;
    } else if (rt === 2 || rt === 4) {
      let a;
      if (def.useBodyRotation || !o.toward) a = bodyYaw(v, pose);
      else {
        const dx = o.toward.x - pose.x, dy = o.toward.y - pose.y;
        a = Math.abs(dx) + Math.abs(dy) > 1e-4 ? Math.atan2(dy, dx) : bodyYaw(v, pose);
      }
      if (rt === 2) a = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
      place.yaw = a;
    }
  }

  /**
   * b.ev 'atk': casts, the projectile and the melee blow. Returns true when the unit's official attack was drawn
   * (the procedural shot is skipped).
   */
  attack(src, tgt, kind, time) {
    if (!this.ofx.active || !src || !this.idx) return false;
    const u = this.unitOf(src);
    const m = this.mode(u, src);
    const a = m?.attack;
    if (!a) return false;
    // casts at the attacker
    for (const e of a.cast || []) {
      const keys = (e.effects || []).filter(Boolean);
      const list = e.directionType ? keys.slice(0, 1) : keys;
      for (const k of list) {
        const h = this.playOn(k, src, { toward: tgt });
        if (h && !e.oneshot) setTimeout0(this.ofx, h, CAST_LOOP_S);
      }
    }
    const pk = lc(a.projectileKey);
    const proj = pk ? this.idx.projectiles[pk] : null;
    const isShot = kind && kind !== 'none';
    if (proj && tgt && isShot) {
      this._fly(proj, src, tgt, kind, time);
      return true;
    }
    if (!isShot && tgt) {
      // melee: the hit effects wait for the damage (else the generic hit by damage type)
      const keys = [];
      for (const e of a.hit || []) {
        const list = (e.effects || []).filter(Boolean);
        keys.push(...(e.directionType ? list.slice(0, 1) : list));
      }
      this.melee.set(tgt.id ?? tgt.info?.id, { keys, src, t: time });
      return true;
    }
    // a ranged attack without a projectile of its own (direct / chain): the hits play on the damage
    if (tgt && (a.hit || []).length) {
      const keys = (a.hit || []).flatMap((e) => (e.effects || []).filter(Boolean));
      this.melee.set(tgt.id ?? tgt.info?.id, { keys, src, t: time });
    }
    return false;
  }

  /** A projectile's flight: `main` from the attacker's muzzle to the target's HitPoint in the sim's flight time. */
  _fly(proj, src, tgt, kind, time) {
    const su = this.unitOf(src), tu = this.unitOf(tgt);
    const sp = this.pose(src), tp = this.pose(tgt);
    const from = unitPoint(this.skinOf(su), 'muzzle', sp);
    const to0 = unitPoint(this.skinOf(tu), 'hit', tp);
    const dist = Math.hypot(to0[0] - from[0], to0[1] - from[1]);
    const speed = this.opts.speed ? this.opts.speed(kind) : 12;
    const dur = Math.max(0.04, Math.min(3, Math.hypot(tgt.x - src.x, tgt.y - src.y) / Math.max(0.1, speed)));
    const mv = proj.movement || {};
    const lob = mv.class === 'ParacurveMovement';
    const rise = lob ? Math.max(0, Number(mv.raiseHeight) || 0) * Math.max(1, dist) * 2 : 0;
    const mainKey = lc(proj.main);
    for (const k of proj.onStart || []) this.playOn(k, src, { toward: tgt });
    if (!mainKey || !this.ofx.lib.has(mainKey)) { this._arrive(proj, tgt, to0, time + dur); return; }
    const def = this.ofx.lib.def(mainKey);
    const flight = { t: 0, dur, from, to: to0.slice(), done: false };
    const flipIfLeft = def ? def.flipIfLeft : false;
    const handle = this.ofx.spawn(mainKey, { pos: from.slice(), groundZ: -(src.z || 0) }, {
      important: true,
      track: (fx) => {
        if (flight.done) return;
        // home on the target's current HitPoint while it lives
        if (tgt && !tgt.destroyed && tgt.alive !== false) unitPoint(this.skinOf(tu), 'hit', this.pose(tgt), flight.to);
        flight.t = Math.min(flight.dur, fx.time);
        const k = flight.t / flight.dur;
        const ax = from[0] + (flight.to[0] - from[0]) * k, ay = from[1] + (flight.to[1] - from[1]) * k;
        let az = from[2] + (flight.to[2] - from[2]) * k;
        if (rise > 0) az -= rise * 4 * k * (1 - k);
        // direction of travel (Unity frame): yaw in the board plane, pitch with the climb
        const k2 = Math.min(1, k + 0.02);
        const bx = from[0] + (flight.to[0] - from[0]) * k2, by = from[1] + (flight.to[1] - from[1]) * k2;
        let bz = from[2] + (flight.to[2] - from[2]) * k2;
        if (rise > 0) bz -= rise * 4 * k2 * (1 - k2);
        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const horiz = Math.hypot(dx, dy);
        fx.anchor[0] = ax; fx.anchor[1] = ay; fx.anchor[2] = az;
        if (flipIfLeft && dx < 0) { fx.mirror = true; fx.yaw = Math.atan2(dy, -dx); } // mirrored art: +x after the mirror
        else { fx.mirror = false; fx.yaw = Math.atan2(dy, dx); }
        fx.pitch = horiz > 1e-5 || Math.abs(dz) > 1e-5 ? Math.atan2(-dz, horiz) : 0;
        if (fx.time >= flight.dur) {
          flight.done = true;
          fx.stop({ hit: true });
          this.flights.delete(flight);
          this._arrive(proj, tgt, flight.to, null);
        }
      },
    });
    if (handle) this.flights.add(flight);
    else this._arrive(proj, tgt, to0, time + dur);
  }

  /** A projectile reached its target: onHit at the target's HitPoint, onReached where it landed. */
  _arrive(proj, tgt, at, laterAt) {
    const go = () => {
      const now = this.ofx.time;
      if (tgt && !tgt.destroyed) {
        for (const k of proj.onHit || []) this.playOn(k, tgt, {});
        const id = tgt.id ?? tgt.info?.id;
        this.arrived.set(id, now);
        if ((proj.onHit || []).some((k) => /heal/.test(k))) this.healed.set(id, now);
      }
      for (const k of proj.onReached || []) {
        const kk = lc(k);
        if (kk && this.ofx.lib.has(kk)) this.ofx.spawn(kk, { pos: at.slice(), groundZ: at[2] }, {});
      }
    };
    if (laterAt == null) go();
    else setTimeout0(this.ofx, { stop: go }, Math.max(0, laterAt - this.ofx.time), true);
  }

  /**
   * b.ev 'dmg' on view v: the waiting melee blow's hits (or the generic hit), or nothing when an official projectile
   * just arrived. Returns true when the official effect stands for this damage (no procedural spark).
   */
  damage(v, type, src, time) {
    if (!this.ofx.active || !v || !this.idx) return false;
    const id = v.id ?? v.info?.id;
    const arr = this.arrived.get(id);
    if (arr != null && this.ofx.time - arr < ARRIVAL_WINDOW) return true;
    const m = this.melee.get(id);
    if (!m || time - m.t > MELEE_WINDOW) return false;
    this.melee.delete(id);
    let keys = m.keys;
    if (!keys.length) {
      const g = this.idx.generic?.hit || {};
      const side = m.src?.isEnemy ? 'enemy' : null;
      const k = side ? g.enemy : (type === 'arts' ? g.arts : g.phys);
      keys = k ? [k] : [];
    }
    let drawn = false;
    for (const k of keys) if (this.playOn(k, v, { flipFrom: m.src })) drawn = true;
    return drawn;
  }

  /** b.ev 'heal' on view v: covered by an official heal projectile, else the generic heal hit. */
  heal(v) {
    if (!this.ofx.active || !v || !this.idx) return false;
    const id = v.id ?? v.info?.id;
    const t = this.healed.get(id) ?? this.arrived.get(id);
    if (t != null && this.ofx.time - t < ARRIVAL_WINDOW) return true;
    const k = this.idx.generic?.hit?.heal;
    return !!(k && this.playOn(k, v, {}));
  }

  /** b.ev 'status' on / off: the status loop follows the unit's mount point while it lasts. */
  status(v, name, on) {
    if (!v || !this.idx) return false;
    const id = v.id ?? v.info?.id;
    const slot = `${id}|${name}`;
    const prev = this.loops.get(slot);
    if (!on) { if (prev) { prev.stop(); this.loops.delete(slot); } return !!prev; }
    if (!this.ofx.active) return false;
    if (prev && prev.alive) return true;
    const key = this.idx.generic?.status?.[name];
    if (!key) return false;
    const h = this.playOn(key, v, { follow: true, loop: true, important: true });
    if (h) this.loops.set(slot, h);
    return !!h;
  }

  /** Stop every loop of a unit (it died / left). */
  release(v) {
    const id = v?.id ?? v?.info?.id;
    for (const [slot, h] of this.loops) if (slot.startsWith(`${id}|`)) { h.stop(); this.loops.delete(slot); }
  }

  /** b.ev 'die': the unit's own death effect or the generic one. */
  death(v) {
    if (!v) return false;
    this.release(v);
    if (!this.ofx.active || !this.idx) return false;
    const u = this.unitOf(v);
    const m = u ? this.mode(u, v) : null;
    const g = this.idx.generic?.die || {};
    const key = lc(m?.overrideDeadEffect) || lc(u?.deadEffect) || (v.isEnemy ? g.enemy : g.char);
    return !!(key && this.playOn(key, v, {}));
  }

  /** b.ev 'deploy': the unit's own start effect or the generic deploy (operators and summons). */
  deploy(v) {
    if (!this.ofx.active || !v || !this.idx || v.isEnemy) return false;
    const u = this.unitOf(v);
    const m = u ? this.mode(u, v) : null;
    const key = lc(m?.overrideStartEffect) || lc(u?.startEffect) || this.idx.generic?.birth?.char;
    return !!(key && this.playOn(key, v, {}));
  }

  /** Battle reset. */
  clear() {
    this.flights.clear();
    this.loops.clear();
    this.melee.clear();
    this.arrived.clear();
    this.healed.clear();
    this.keyCache.clear();
    this.ofx.timers = [];
  }

  /** Called once per frame: delayed actions on the battle clock. */
  tick() {
    const T = this.ofx.timers;
    if (!T || !T.length) return;
    const now = this.ofx.time;
    let w = 0;
    for (const t of T) {
      if (now >= t.at) { try { t.fn(); } catch { /* ignore */ } }
      else T[w++] = t;
    }
    T.length = w;
  }
}

/**
 * Whether a view shows an abnormal flag (Torappu.AbnormalFlag): the ones a client view knows from its b.snap flags
 * and statuses — STUNNED 0, INVISIBLE 9 / CAMOUFLAGE 17 (stealth), FROZEN 16, COLD 23, LEVITATE 25, SILENCED 12,
 * DISARMED 11, FEARED 33, DOZE 43 (sleep). Others read as absent.
 */
function abnormal(v, flag) {
  const f = v?.flags | 0, st = v?.statuses;
  const has = (k) => !!(st && (typeof st.has === 'function' ? st.has(k) : st[k]));
  switch (flag) {
    case 0: return !!(f & UF.STUNNED) || has('stun');
    case 9: case 17: return !!(f & UF.STEALTH);
    case 16: return !!(f & UF.FROZEN) || has('freeze');
    case 23: return !!(f & UF.COLD) || has('cold');
    case 25: return has('levitate');
    case 12: return has('silence');
    case 11: return has('disarm');
    case 33: return has('fear');
    case 43: return !!(f & UF.SLEEP) || has('sleep');
    default: return false;
  }
}

/** The world yaw a unit faces: an operator's deploy direction (UP = +row), else its facing (±x). */
function bodyYaw(v, pose) {
  const d = typeof v?.dir === 'string' ? v.dir.toUpperCase() : null;
  if (d === 'UP') return Math.PI / 2;
  if (d === 'DOWN') return -Math.PI / 2;
  if (d === 'LEFT') return Math.PI;
  if (d === 'RIGHT') return 0;
  return pose.left ? Math.PI : 0;
}

/** Run `h.stop()` (or a function) after `s` battle seconds on the effects' clock. */
function setTimeout0(ofx, h, s, isFn = false) {
  if (!ofx.timers) ofx.timers = [];
  ofx.timers.push({ at: ofx.time + s, fn: isFn ? h.stop : () => h.stop() });
}

export { spawnKind };
