// render/vfx/effect.js — one official effect prefab (DESIGN §33.4) as a playing instance: its node hierarchy with
// Unity's TRS order, the particle systems (render/vfx/psys.js), the clips (render/vfx/clips.js), the trail / line /
// mesh renderers and the behaviours of §33.11, on the battle clock.
//
//   const def = compileEffect(descriptor, lib)          shared per prefab (curves baked, materials compiled lazily)
//   const fx = new Effect(def, { seed, lite, emission, hooks })
//   fx.place({ pos, yaw, pitch, mirror, groundZ })      anchor in the Unity battle frame; yaw / pitch (radians) turn the
//                                                       `_rotationZ` helper (or the root); mirror = left/right mirror
//                                                       about the anchor (FLIP_TWO_SIDE, `_flipIfLeft`)
//   fx.track = (fx) => …                                optional per-frame placement update (FollowMountPoint,
//                                                       FollowDirection, a projectile's flight) before the update
//   fx.update(dt); fx.stop({ hit }); fx.kill()
//   fx.collect(cam, fd, sink)                           visible renderers → draw items (render/vfx/system.js sorts them)
//   fx.done                                             finished and its linger (`_delayToFinish`) over: recycle it
//
// Lifecycle (ParticleEffect / ProjectileEffect): the content starts after `_delayToPlay`; a system plays when its node
// becomes active (FxDelay, an m_IsActive clip curve, or the start) and it has playOnAwake (or a playing parent system at
// the start: Unity plays child systems with their parent); sub-emitter systems only play for their parent. The effect
// is finished when every non-looping system has ended with no live particle, the non-looping clips have ended and the
// trails have faded; a looping effect (`_isLoop`, a looping system or clip) runs until `stop()`. `_maxLifetime` ends it
// early; `_inactiveOnFinish` nodes hide during the `_delayToFinish` linger; `stop({ hit: true })` hides a projectile's
// `_inactiveOnHit` nodes at once. The light tier (精簡) applies FxLODSetting (`_disableObjects` removed, the
// `_particleDetailsHookers` shares of emission) on top of its emission × 0.5.

import { compileSystem, PSys } from './psys.js';
import { compileClip, sampleClip, quatToEuler } from './clips.js';
import { compileMaterial } from './materials.js';
import { GradientLut, evalCurve } from './curves.js';
import { quatEuler, quatMul, quatNormalize, quatAxis, mat4, mat4Trs, mat4Mul, mat4Scale } from './math.js';
import { streamLayout, buildParticles, buildMeshInstance, buildRibbon, buildParticleTrails, buildSkinned, linePoints } from './geom.js';

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const on = (v) => v === true || v === 1;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const RENDER_MODE = { 0: 'billboard', 1: 'stretch', 2: 'horizontal', 3: 'vertical', 4: 'mesh', 5: 'none' };
const ALIGN = { 0: 'view', 1: 'world', 2: 'local', 3: 'facing', 4: 'velocity' };
/** ParticleEffect spawn locations on the ground (ranges, decals). */
export const GROUND_SPAWNS = new Set([5, 7, 17, 26, 35]);

/** A mesh reference ({ mesh: key }, { builtin: 'Quad' } or 'builtin:Quad') as a library key. */
export function meshRef(v) {
  if (typeof v === 'string') return v || null;
  if (v && typeof v.mesh === 'string') return v.mesh;
  if (v && typeof v.builtin === 'string') return 'builtin:' + v.builtin;
  return null;
}

/** The renderer info of a ParticleSystemRenderer. */
function psrInfo(r) {
  if (!r) return null;
  const mode = typeof r.renderMode === 'string' ? (r.renderMode === 'horizontalBillboard' ? 'horizontal' : r.renderMode === 'verticalBillboard' ? 'vertical' : r.renderMode) : RENDER_MODE[num(r.m_RenderMode, 0)] || 'billboard';
  return {
    enabled: r.m_Enabled !== false && r.m_Enabled !== 0,
    mode, align: (typeof r.renderAlignment === 'string' ? r.renderAlignment : ALIGN[num(r.m_RenderAlignment, 0)]) || 'view',
    sortMode: num(r.m_SortMode, 0) | 0, fudge: num(r.m_SortingFudge, 0), order: num(r.m_SortingOrder, 0), layer: num(r.m_SortingLayer, 0),
    pivot: Array.isArray(r.m_Pivot) ? r.m_Pivot.map((x) => num(x, 0)) : null,
    flip: Array.isArray(r.m_Flip) ? r.m_Flip.map((x) => num(x, 0)) : null,
    lengthScale: num(r.m_LengthScale, 2), velocityScale: num(r.m_VelocityScale, 0), cameraVelocityScale: num(r.m_CameraVelocityScale, 0),
    minSize: num(r.m_MinParticleSize, 0), maxSize: num(r.m_MaxParticleSize, 0.5),
    mesh: meshRef(r.m_Mesh),
    mats: Array.isArray(r.materials) ? r.materials : [],
    streams: streamLayout(r),
  };
}

function trailParams(p) {
  const P = isObj(p) ? p : {};
  return {
    width: num(P.widthMultiplier, 1), widthCurve: Array.isArray(P.widthCurve) ? P.widthCurve : (isObj(P.widthCurve) && Array.isArray(P.widthCurve.keys) ? P.widthCurve.keys : [[0, 1, 0, 0]]),
    color: new GradientLut(isObj(P.colorGradient) ? P.colorGradient : null),
    alignment: num(P.alignment, 0) | 0, textureMode: num(P.textureMode, 0) | 0,
  };
}

/**
 * Compile a prefab descriptor (shared, immutable).
 * @param {any} desc prefabs/<key>.json
 * @param {{ mesh?: (key: string) => any }} [lib]
 */
export function compileEffect(desc, lib = {}) {
  const nodes = Array.isArray(desc?.nodes) ? desc.nodes : [];
  const n = nodes.length;
  const def = {
    key: desc?.key || '', desc, n, nodes,
    parent: new Int32Array(n).fill(-1), base: new Float32Array(n * 10), activeBase: new Uint8Array(n),
    ps: new Array(n).fill(null), psr: new Array(n).fill(null), mesh: new Array(n).fill(null), skinned: new Array(n).fill(null),
    trail: new Array(n).fill(null), line: new Array(n).fill(null), subNodes: new Set(), hasPsAncestor: new Uint8Array(n),
    clips: (Array.isArray(desc?.clips) ? desc.clips : []).map(compileClip), animators: [],
    pe: null, proj: null, fxDelay: new Map(), tweeners: [], uvRot: [], lod: null, follow: null, direction: null,
    onPlay: [], onFinish: [], switchable: null, colorMod: null, pause: null, materials: [], lite: [],
    textures: Array.isArray(desc?.textures) ? desc.textures : [], meshes: Array.isArray(desc?.meshes) ? desc.meshes : [],
    stats: desc?.stats || {}, refs: Array.isArray(desc?.refs) ? desc.refs : [],
  };
  const res = { mesh: (k) => (lib.mesh ? lib.mesh(k) : null) };
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    def.parent[i] = nd.parent == null ? -1 : nd.parent;
    const p = Array.isArray(nd.pos) ? nd.pos : [0, 0, 0], q = Array.isArray(nd.rot) ? nd.rot : [0, 0, 0, 1], s = Array.isArray(nd.scale) ? nd.scale : [1, 1, 1];
    def.base.set([num(p[0], 0), num(p[1], 0), num(p[2], 0), num(q[0], 0), num(q[1], 0), num(q[2], 0), num(q[3], 1), num(s[0], 1), num(s[1], 1), num(s[2], 1)], i * 10);
    def.activeBase[i] = nd.active === false || nd.active === 0 ? 0 : 1;
    if (nd.particleSystem) {
      def.ps[i] = compileSystem(nd.particleSystem, nd.particleSystemRenderer || null, res);
      const sub = nd.particleSystem.SubModule;
      if (sub && Array.isArray(sub.subEmitters)) for (const se of sub.subEmitters) if (se && se.emitter && se.emitter.node != null) def.subNodes.add(se.emitter.node);
    }
    if (nd.particleSystemRenderer) def.psr[i] = psrInfo(nd.particleSystemRenderer);
    if (nd.meshRenderer && nd.meshFilter !== undefined) {
      const r = nd.meshRenderer;
      def.mesh[i] = { enabled: r.m_Enabled !== false && r.m_Enabled !== 0, mesh: meshRef(nd.meshFilter),
        order: num(r.m_SortingOrder, 0), layer: num(r.m_SortingLayer, 0), mats: Array.isArray(r.materials) ? r.materials : [] };
    }
    if (nd.skinnedMeshRenderer) {
      const r = nd.skinnedMeshRenderer;
      def.skinned[i] = { enabled: r.m_Enabled !== false && r.m_Enabled !== 0, mesh: meshRef(r.m_Mesh),
        bones: Array.isArray(r.m_Bones) ? r.m_Bones.map((b) => (b && b.node != null ? b.node : -1)) : [],
        order: num(r.m_SortingOrder, 0), layer: num(r.m_SortingLayer, 0), mats: Array.isArray(r.materials) ? r.materials : [] };
    }
    if (nd.trailRenderer) {
      const r = nd.trailRenderer;
      def.trail[i] = { enabled: r.m_Enabled !== false && r.m_Enabled !== 0, time: Math.max(0.01, num(r.m_Time, 1)), minDist: Math.max(0, num(r.m_MinVertexDistance, 0.1)),
        emitting: r.m_Emitting !== false && r.m_Emitting !== 0, params: trailParams(r.m_Parameters), order: num(r.m_SortingOrder, 0), layer: num(r.m_SortingLayer, 0),
        mats: Array.isArray(r.materials) ? r.materials : [] };
    }
    if (nd.lineRenderer) {
      const r = nd.lineRenderer;
      def.line[i] = { enabled: r.m_Enabled !== false && r.m_Enabled !== 0, points: Array.isArray(r.m_Positions) ? r.m_Positions.filter(Array.isArray) : [],
        world: on(r.m_UseWorldSpace), loop: on(r.m_Loop), params: trailParams(r.m_Parameters), order: num(r.m_SortingOrder, 0), layer: num(r.m_SortingLayer, 0),
        mats: Array.isArray(r.materials) ? r.materials : [] };
    }
    if (nd.animator && on(nd.animator.enabled ?? true) && nd.animator.default != null) def.animators.push({ node: i, clip: nd.animator.default });
    else if (nd.animation && on(nd.animation.enabled ?? true) && nd.animation.default != null && (nd.animation.playAutomatically ?? true)) def.animators.push({ node: i, clip: nd.animation.default });
    for (const b of Array.isArray(nd.behaviours) ? nd.behaviours : []) {
      if (!b || b.enabled === false) continue;
      const f = isObj(b.fields) ? b.fields : {};
      switch (b.class) {
        case 'ParticleEffect': case 'EmptyEffect': if (!def.pe && i === 0) def.pe = f; else if (!def.pe) def.pe = f; break;
        case 'ProjectileEffect': def.proj = f; break;
        case 'FxDelay': def.fxDelay.set(i, Math.max(0, num(f._delayTime, 0))); break;
        case 'FxUVTweener': case 'FxUVTweenerAdvance':
          def.tweeners.push({ node: i, x: num(f.xspeed, 0), y: num(f.yspeed, 0), second: on(f.useSecondMap) ? String(f.secondMapName || '') : null,
            sx: num(f.secondXSpeed, 0), sy: num(f.secondYSpeed, 0), keep: on(f.keepInitOffset ?? 1),
            period: b.class === 'FxUVTweenerAdvance' && on(f.tweenRepeat) ? Math.max(0, num(f.tweenAnmTime, 0)) : 0,
            extra: Array.isArray(f.extraMapSettings) ? f.extraMapSettings : [] });
          break;
        case 'FxUVRotation': def.uvRot.push({ node: i, flags: [f._rotateTex1, f._rotateTex2, f._rotateTex3, f._rotateTex4].map(on), angles: [num(f.angle1 ?? f._angle1, 0), num(f._angle2, 0), num(f._angle3, 0), num(f._angle4, 0)] }); break;
        case 'FxLODSetting':
          def.lod = { disable: new Set((Array.isArray(f._disableObjects) ? f._disableObjects : []).map((o) => o && o.node).filter((x) => x != null)),
            hook: new Map((Array.isArray(f._particleDetailsHookers) ? f._particleDetailsHookers : []).filter((h) => h && h._particle && h._particle.node != null).map((h) => [h._particle.node, Math.max(0, Math.min(1, num(h._detailPercentage, 1)))])) };
          break;
        case 'FollowMountPoint': def.follow = { mount: num(f._mountPointType, 0) | 0, keepRot: on(f._keepOriginRotation), scale: on(f._followScale) }; break;
        case 'FollowOwner': case 'FollowOwnerRootTileHeight': case 'FollowTileHeight': if (!def.follow) def.follow = { mount: 0, keepRot: true, owner: true }; break;
        case 'FollowDirection': def.direction = { fourDir: on(f._useFourDir), leftIsDefault: on(f._leftIsDefault), reverseBack: on(f._reverseWhenFaceToBack) }; break;
        case 'OnPlayEmitter': case 'OnPlayEmitterIf': def.onPlay.push({ keys: (Array.isArray(f._effects) ? f._effects : []).map((k) => String(k).toLowerCase()), delay: num(f._preDelay, 0), cond: b.class === 'OnPlayEmitterIf' ? f : null }); break;
        case 'OnFinishEmitter': def.onFinish.push(...(Array.isArray(f._effects) ? f._effects : []).map((k) => String(k).toLowerCase())); break;
        case 'SwitchableBackEffect': def.switchable = { ...(def.switchable || {}), back: f._backEffect ? String(f._backEffect).toLowerCase() : null }; break;
        case 'SwitchableRightEffect': def.switchable = { ...(def.switchable || {}), right: f._rightEffect ? String(f._rightEffect).toLowerCase() : null, reverse: on(f._reverseLeftRight) }; break;
        case 'SwitchableEffectByFaceDirection': def.switchable = { ...(def.switchable || {}), up: f._upEffect ? String(f._upEffect).toLowerCase() : null, down: f._downEffect ? String(f._downEffect).toLowerCase() : null, left: f._leftEffect ? String(f._leftEffect).toLowerCase() : null }; break;
        case 'ColorModifier': if (Array.isArray(f._color)) def.colorMod = f._color.map((x) => num(x, 1)); break;
        case 'PauseEffectIf': def.pause = { back: on(f._checkFaceToBack), right: on(f._checkFaceToRight) }; break;
        default: break;
      }
    }
  }
  // systems under another system play with it at the start (Unity plays child systems with their parent)
  for (let i = 0; i < n; i++) {
    let p = def.parent[i];
    while (p >= 0) { if (def.ps[p]) { def.hasPsAncestor[i] = 1; break; } p = def.parent[p]; }
  }
  const pe = def.pe || def.proj || {};
  def.delayToPlay = Math.max(0, num(pe._delayToPlay, 0));
  def.randomDelay = Math.max(0, num(pe._randomPlayDelay, 0));
  def.delayToFinish = Math.max(0, num(pe._delayToFinish, 0));
  def.maxLifetime = num(pe._maxLifetime, -1);
  def.isLoop = on(pe._isLoop);
  def.spawn = num(def.pe?._spawnLocation, 0) | 0;
  def.rotateType = num(def.pe?._rotateType, 0) | 0;
  def.leftIsDefault = on(def.pe?._leftIsDefault);
  def.rotY = def.pe?._rotationY && def.pe._rotationY.node != null ? def.pe._rotationY.node : -1;
  def.rotZ = def.pe?._rotationZ && def.pe._rotationZ.node != null ? def.pe._rotationZ.node : -1;
  def.inactiveOnFinish = (Array.isArray(pe._inactiveOnFinish) ? pe._inactiveOnFinish : []).map((o) => o && o.node).filter((x) => x != null);
  def.inactiveOnHit = (Array.isArray(def.proj?._inactiveOnHit) ? def.proj._inactiveOnHit : []).map((o) => o && o.node).filter((x) => x != null);
  def.flipIfLeft = on(def.proj?._flipIfLeft);
  def.rotate180Y = on(def.proj?._rotate180Y);
  // the art's own direction (ParticleEffect / ProjectileEffect `_mainDir`: the client's Direction enum)
  const md = num(pe._mainDir, 1) | 0;
  def.mainYaw = (def.rotateType === 2 || def.rotateType === 4 || def.proj) && md >= 0 && md <= 3 ? DIR_YAW[md] : 0;
  def.useBodyRotation = on(def.pe?._useBodyRotation);
  def.loops = def.isLoop || def.ps.some((p) => p && p.looping && p.playOnAwake !== false) || def.animators.some((a) => def.clips[a.clip]?.loop);
  def.material = (i, lite) => {
    const list = lite ? def.lite : def.materials;
    if (list[i] === undefined) list[i] = desc?.materials?.[i] ? compileMaterial(desc.materials[i], { lite }) : null;
    return list[i];
  };
  return def;
}

const _m = mat4(), _q = [0, 0, 0, 1], _q2 = [0, 0, 0, 1], _p3 = [0, 0, 0], _s3 = [1, 1, 1];
const MIRROR = mat4();

let seq = 0;

export class Effect {
  /**
   * @param {any} def compileEffect(...)
   * @param {{ seed?: number, lite?: boolean, emission?: number, lib?: any, rngSeed?: number }} [opts]
   */
  constructor(def, opts = {}) {
    this.def = def;
    this.id = ++seq;
    this.lite = !!opts.lite;
    this.lib = opts.lib || null;
    const n = def.n;
    this.loc = new Float32Array(def.base);             // animated local TRS
    this.act = new Uint8Array(def.activeBase);         // own active flags (FxDelay / clips / LOD / inactive lists)
    this.hier = new Uint8Array(n);                     // active in hierarchy this frame
    this.prevHier = new Uint8Array(n);
    this.actAt = new Float32Array(n).fill(-1);         // content time a node became active in hierarchy
    this.world = Array.from({ length: n }, () => mat4());
    this.forcedOff = new Uint8Array(n);                // hidden for good (_inactiveOnHit / _inactiveOnFinish / LOD)
    this.matOv = new Map();                            // node → { prop: number | number[] } material overrides
    this.rendOv = new Map();                           // node → { widthMultiplier, time }
    this.sys = new Array(n).fill(null);
    this.trails = new Map();                           // node → { pts: Float32Array(cap × 4), n, head, emitting }
    this.linePts = new Map();                          // node → [[x,y,z]…] overrides (beams, chains: set by the game)
    this.anchor = [0, 0, 0];
    this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.mirror = false;
    this.flipY = false;                                // FLIP_TWO_SIDE with a `_rotationY` helper
    this.groundZ = 0;
    this.time = 0;                                     // s since spawn (battle clock)
    this.delay = def.delayToPlay + (def.randomDelay > 0 ? Math.random() * def.randomDelay : 0);
    this.state = 'play';                               // 'play' | 'stopping' | 'linger' | 'done'
    this.linger = 0;
    this.started = false;
    this.track = null;
    this.hidden = false;                               // PauseEffectIf (owner facing)
    this.owner = null;
    this.tint = def.colorMod || null;
    this.speed = 1;                                    // playback speed (1 = the battle clock)
    this.onFinish = null;                              // callback (chained effects)
    this.data = null;                                  // the caller's own record (wiring)
    const emission = num(opts.emission, 1) * (this.lite ? 0.5 : 1);
    const seed0 = (num(opts.seed, 0) >>> 0) || ((Math.random() * 4294967296) >>> 0);
    for (let i = 0; i < n; i++) {
      if (!def.ps[i]) continue;
      let e = emission;
      if (this.lite && def.lod && def.lod.hook.has(i)) e *= def.lod.hook.get(i);
      this.sys[i] = new PSys(def.ps[i], { seed: (seed0 + i * 7919) >>> 0, emission: e, sub: def.subNodes.has(i) });
    }
    // sub-emitter wiring
    for (let i = 0; i < n; i++) {
      const pd = def.ps[i];
      if (!pd || !pd.sub) continue;
      this.sys[i].children = pd.sub.filter((s) => this.sys[s.node]).map((s) => ({ sys: this.sys[s.node], type: s.type, props: s.props, prob: s.prob }));
    }
    if (this.lite && def.lod) for (const nd of def.lod.disable) if (nd >= 0 && nd < n) { this.act[nd] = 0; this.forcedOff[nd] = 1; }
    // FxDelay nodes wait (inactive) until their delay
    for (const nd of def.fxDelay.keys()) if (nd >= 0 && nd < n) this.act[nd] = 0;
  }

  /** Place the effect (see the header). */
  place(o) {
    if (o.pos) { this.anchor[0] = o.pos[0]; this.anchor[1] = o.pos[1]; this.anchor[2] = o.pos[2]; }
    if (typeof o.yaw === 'number') this.yaw = o.yaw;
    if (typeof o.pitch === 'number') this.pitch = o.pitch;
    if (typeof o.roll === 'number') this.roll = o.roll;
    if (typeof o.mirror === 'boolean') this.mirror = o.mirror;
    if (typeof o.flipY === 'boolean') this.flipY = o.flipY;
    if (typeof o.groundZ === 'number') this.groundZ = o.groundZ;
    return this;
  }

  get done() { return this.state === 'done'; }

  /** Content time (after `_delayToPlay`). */
  get ctime() { return this.time - this.delay; }

  /** Stop: a looping effect stops emitting and ends when its particles are gone; `hit` hides `_inactiveOnHit`. */
  stop(o = {}) {
    if (this.state === 'done') return;
    if (o.hit) for (const nd of this.def.inactiveOnHit) { this.forcedOff[nd] = 1; this.act[nd] = 0; }
    for (const s of this.sys) if (s) s.stopEmitting();
    for (const t of this.trails.values()) t.emitting = false;
    if (this.state === 'play') { this.state = 'stopping'; this.stopT = 0; }
  }

  /** Remove at once. */
  kill() {
    this.state = 'done';
    for (const s of this.sys) if (s) s.clear();
    this.trails.clear();
  }

  /** Clip sink: writes animated values into this instance. */
  _sink() {
    if (this.__sink) return this.__sink;
    const self = this;
    this.__sink = {
      transform(node, pos, rot, scale, euler) {
        const o = node * 10, L = self.loc;
        if (pos) for (let k = 0; k < 3; k++) if (!Number.isNaN(pos[k])) L[o + k] = pos[k];
        if (rot) {
          for (let k = 0; k < 4; k++) if (!Number.isNaN(rot[k])) L[o + 3 + k] = rot[k];
          const l = Math.hypot(L[o + 3], L[o + 4], L[o + 5], L[o + 6]) || 1;
          L[o + 3] /= l; L[o + 4] /= l; L[o + 5] /= l; L[o + 6] /= l;
        } else if (euler) {
          // missing axes keep the node's own Euler angles
          const b = self._baseEuler(node);
          quatEuler(Number.isNaN(euler[0]) ? b[0] : euler[0], Number.isNaN(euler[1]) ? b[1] : euler[1], Number.isNaN(euler[2]) ? b[2] : euler[2], _q2);
          L[o + 3] = _q2[0]; L[o + 4] = _q2[1]; L[o + 5] = _q2[2]; L[o + 6] = _q2[3];
        }
        if (scale) for (let k = 0; k < 3; k++) if (!Number.isNaN(scale[k])) L[o + 7 + k] = scale[k];
      },
      active(node, v) { if (!self.forcedOff[node] && !self.def.fxDelay.has(node)) self.act[node] = v ? 1 : 0; },
      material(node, _type, prop, comp, v) {
        let ov = self.matOv.get(node);
        if (!ov) { ov = {}; self.matOv.set(node, ov); }
        if (comp < 0) ov[prop] = v;
        else {
          let a = ov[prop];
          if (!Array.isArray(a)) { a = self._baseVec(node, prop); ov[prop] = a; }
          a[comp] = v;
        }
      },
      renderer(node, _type, path, v) {
        let ov = self.rendOv.get(node);
        if (!ov) { ov = {}; self.rendOv.set(node, ov); }
        if (path === 'm_Parameters.widthMultiplier') ov.width = v;
        else if (path === 'm_Time') ov.time = v;
        else if (path === 'm_Enabled') ov.enabled = v > 0.5;
      },
      system(node, path, v) { const s = self.sys[node]; if (s) s.overrideField(path, v); },
    };
    return this.__sink;
  }

  _baseEuler(node) {
    if (!this.__eul) this.__eul = new Map();
    let e = this.__eul.get(node);
    if (!e) {
      const o = node * 10, b = this.def.base;
      const q = [b[o + 3], b[o + 4], b[o + 5], b[o + 6]];
      e = quatToEuler(q);
      this.__eul.set(node, e);
    }
    return e;
  }

  /** The material vector a renderer starts from (its first material's value). */
  _baseVec(node, prop) {
    const def = this.def;
    const mats = def.psr[node]?.mats || def.mesh[node]?.mats || def.trail[node]?.mats || def.line[node]?.mats || def.skinned[node]?.mats || [];
    const mi = mats.find((x) => x != null);
    const m = mi != null ? def.material(mi, this.lite) : null;
    const v = m && m.vecs[prop];
    return v ? v.slice() : (prop.endsWith('_ST') ? [1, 1, 0, 0] : [1, 1, 1, 1]);
  }

  /** Advance by dt battle seconds. */
  update(dt) {
    if (this.state === 'done') return;
    if (this.track) { try { this.track(this); } catch { /* the owner went away: the effect stays where it was */ } }
    dt *= this.speed;
    this.time += dt;
    const def = this.def;
    const ct = this.ctime;
    if (ct < 0) return;
    const first = !this.started;
    this.started = true;
    // FxDelay activations
    for (const [nd, d] of def.fxDelay) if (!this.forcedOff[nd] && ct >= d) this.act[nd] = 1;
    // hierarchy activity (parents come before children in the node list)
    const n = def.n;
    for (let i = 0; i < n; i++) {
      const p = def.parent[i];
      this.prevHier[i] = this.hier[i];
      this.hier[i] = this.act[i] && (p < 0 || this.hier[p]) ? 1 : 0;
      if (this.hier[i] && !this.prevHier[i]) this.actAt[i] = ct;
    }
    // clips (from their node's activation), behaviours
    for (const a of def.animators) {
      if (!this.hier[a.node]) continue;
      const c = def.clips[a.clip];
      if (c) sampleClip(c, ct - Math.max(0, this.actAt[a.node]), this._sink());
    }
    // a clip may have toggled nodes: recompute activity
    if (def.animators.length) {
      for (let i = 0; i < n; i++) {
        const p = def.parent[i];
        const h = this.act[i] && (p < 0 || this.hier[p]) ? 1 : 0;
        if (h && !this.hier[i] && !this.prevHier[i]) this.actAt[i] = ct;
        this.hier[i] = h;
      }
    }
    for (const tw of def.tweeners) {
      if (!this.hier[tw.node]) continue;
      let t = ct - Math.max(0, this.actAt[tw.node]);
      if (tw.period > 0) t %= tw.period;
      this._tween(tw.node, '_MainTex_ST', tw.x * t, tw.y * t, tw.keep);
      if (tw.second) this._tween(tw.node, tw.second + '_ST', tw.sx * t, tw.sy * t, tw.keep);
      for (const ex of tw.extra) if (ex && ex.name) this._tween(tw.node, String(ex.name) + '_ST', num(ex.xspeed, 0) * t, num(ex.yspeed, 0) * t, tw.keep);
    }
    for (const r of def.uvRot) {
      let ov = this.matOv.get(r.node);
      if (!ov) { ov = {}; this.matOv.set(r.node, ov); }
      ov._HG_UV_ROTATION = r.flags.some(Boolean) ? 1 : 0;
      for (let k = 0; k < 4; k++) {
        const a = r.flags[k] ? r.angles[k] * Math.PI / 180 : 0, c = Math.cos(a), s = Math.sin(a);
        ov['_Rotation' + k] = [c, s, -s, c];
      }
    }
    // world matrices
    this._matrices();
    // systems
    for (let i = 0; i < n; i++) {
      const s = this.sys[i];
      if (!s) continue;
      const h = this.hier[i];
      if (!h) { if (s.playing && this.prevHier[i]) { s.clear(); s.playing = false; } continue; }
      const frame = this._frame(i);
      if (!s.playing && !s.isSub) {
        const becameActive = !this.prevHier[i] || first;
        if (becameActive && (s.def.playOnAwake || (first && def.hasPsAncestor[i])) && this.state === 'play') s.play(frame);
      }
      if (s.playing) s.update(dt, frame);
      else if (s.isSub) s.setFrame(frame);
    }
    // trail renderers follow their node
    for (let i = 0; i < n; i++) {
      const tr = def.trail[i];
      if (!tr) continue;
      let st = this.trails.get(i);
      if (!st) { st = { pts: new Float32Array(256 * 4), n: 0, head: 0, emitting: tr.emitting }; this.trails.set(i, st); }
      const life = this.rendOv.get(i)?.time ?? tr.time;
      // drop expired points
      while (st.n > 0) {
        const o = ((st.head - st.n + 256) % 256) * 4;
        if (this.time - st.pts[o + 3] > life) st.n--; else break;
      }
      if (!this.hier[i] || !st.emitting || this.state !== 'play') continue;
      const w = this.world[i];
      const x = w[12], y = w[13], z = w[14];
      if (st.n > 0) {
        const o = ((st.head - 1 + 256) % 256) * 4;
        const dx = x - st.pts[o], dy = y - st.pts[o + 1], dz = z - st.pts[o + 2];
        if (dx * dx + dy * dy + dz * dz < tr.minDist * tr.minDist) continue;
      }
      const o = st.head * 4;
      st.pts[o] = x; st.pts[o + 1] = y; st.pts[o + 2] = z; st.pts[o + 3] = this.time;
      st.head = (st.head + 1) % 256;
      if (st.n < 255) st.n++;
    }
    this._lifecycle(dt);
  }

  _tween(node, prop, dx, dy, keep) {
    let ov = this.matOv.get(node);
    if (!ov) { ov = {}; this.matOv.set(node, ov); }
    const base = this._baseVec(node, prop);
    let a = ov[prop];
    if (!Array.isArray(a)) { a = base.slice(); ov[prop] = a; }
    a[2] = (keep ? base[2] : 0) + dx;
    a[3] = (keep ? base[3] : 0) + dy;
  }

  /** World matrices of every node: anchor · direction · local TRS down the hierarchy, then the mirror. */
  _matrices() {
    const def = this.def, L = this.loc, n = def.n;
    for (let i = 0; i < n; i++) {
      const o = i * 10;
      _p3[0] = L[o]; _p3[1] = L[o + 1]; _p3[2] = L[o + 2];
      _q[0] = L[o + 3]; _q[1] = L[o + 4]; _q[2] = L[o + 5]; _q[3] = L[o + 6];
      _s3[0] = L[o + 7]; _s3[1] = L[o + 8]; _s3[2] = L[o + 9];
      // the direction: a `_rotationZ` helper's rotation is set to it (the client's script replaces the helper's
      // authored rotation — ifrit_attack_01_start's is a leftover 90°), else the root turns; yaw about Z relative to
      // the art's `_mainDir`, pitch about the turned Y. A `_rotationY` helper turns 180° about Y for a flipped owner.
      if (i === def.rotZ) {
        dirQuat(this.yaw - def.mainYaw, this.pitch, this.roll, _q);
      } else if (i === 0 && def.rotZ < 0 && (this.yaw || this.pitch || this.roll || def.mainYaw)) {
        dirQuat(this.yaw - def.mainYaw, this.pitch, this.roll, _q2);
        quatMul(_q2, _q, _q);
        quatNormalize(_q);
      }
      if (i === def.rotY) { if (this.flipY) quatAxis(0, 1, 0, Math.PI, _q); else { _q[0] = 0; _q[1] = 0; _q[2] = 0; _q[3] = 1; } }
      if (i === 0 && def.rotate180Y) { quatMul(quatAxis(0, 1, 0, Math.PI, _q2), _q, _q); }
      mat4Trs(_p3, _q, _s3, _m);
      const p = def.parent[i];
      if (p < 0) {
        // root: at the anchor
        _m[12] += this.anchor[0]; _m[13] += this.anchor[1]; _m[14] += this.anchor[2];
        this.world[i].set(_m);
      } else mat4Mul(this.world[p], _m, this.world[i]);
    }
    if (this.mirror) {
      // reflect x about the anchor: S = T(a) · diag(−1, 1, 1) · T(−a)
      MIRROR.fill(0); MIRROR[0] = -1; MIRROR[5] = 1; MIRROR[10] = 1; MIRROR[15] = 1; MIRROR[12] = 2 * this.anchor[0];
      for (let i = 0; i < n; i++) mat4Mul(MIRROR, this.world[i], this.world[i]);
    }
  }

  /** The render frame of system node i: world rotation / position with the scale of its scaling mode. */
  _frame(i) {
    const s = this.sys[i], w = this.world[i];
    const f = this.__frame || (this.__frame = { m: mat4(), scale: [1, 1, 1] });
    const mode = s.def.scalingMode;
    if (mode === 0) { f.m.set(w); mat4Scale(w, f.scale); return f; }
    // Local: the node's own scale on the world basis; Shape: no scale (the shape takes the world scale at birth). A
    // mirrored world keeps its reflection: the basis columns are only normalised.
    const o = i * 10, L = this.loc;
    const sx = mode === 1 ? L[o + 7] : 1, sy = mode === 1 ? L[o + 8] : 1, sz = mode === 1 ? L[o + 9] : 1;
    const k0 = Math.hypot(w[0], w[1], w[2]) || 1, k1 = Math.hypot(w[4], w[5], w[6]) || 1, k2 = Math.hypot(w[8], w[9], w[10]) || 1;
    const m = f.m;
    for (let r = 0; r < 3; r++) { m[r] = w[r] / k0 * sx; m[4 + r] = w[4 + r] / k1 * sy; m[8 + r] = w[8 + r] / k2 * sz; }
    m[3] = 0; m[7] = 0; m[11] = 0; m[12] = w[12]; m[13] = w[13]; m[14] = w[14]; m[15] = 1;
    if (mode === 1) { f.scale[0] = sx; f.scale[1] = sy; f.scale[2] = sz; } else mat4Scale(w, f.scale);
    return f;
  }

  _lifecycle(dt) {
    const def = this.def;
    if (this.state === 'stopping') {
      // a stopped effect fades out within STOP_FADE (long-lived one-shot particles — a status ring of a 10 s
      // lifetime — must not outlive their status) [ASSUMED]
      this.stopT += dt;
      const end = Math.max(STOP_FADE, def.delayToFinish + 0.3);
      if (this.stopT >= end) { this.state = 'done'; return; }
      this.fade = Math.min(1, Math.max(0, (end - this.stopT) / 0.3));
    }
    if (this.state === 'linger') {
      this.linger -= dt;
      if (this.linger <= 0) this.state = 'done';
      return;
    }
    const ct = this.ctime;
    let busy = false;
    for (let i = 0; i < def.n; i++) {
      const s = this.sys[i];
      if (s && (s.alive || (s.isSub && s.count > 0))) { busy = true; break; }
    }
    if (!busy) for (const t of this.trails.values()) if (t.n > 0) { busy = true; break; }
    if (!busy) for (const [nd, d] of def.fxDelay) if (!this.forcedOff[nd] && ct < d) { busy = true; break; }
    if (!busy && this.state === 'play') {
      for (const a of def.animators) {
        const c = def.clips[a.clip];
        if (!c) continue;
        if (c.loop) { busy = true; break; }
        if (this.hier[a.node] && ct - Math.max(0, this.actAt[a.node]) < c.length) { busy = true; break; }
      }
      // a static effect (no systems, no clip): its authored duration
      if (!busy && !this.sys.some(Boolean) && !def.animators.length && !this.trails.size) {
        const dur = def.maxLifetime > 0 ? def.maxLifetime : num(def.stats.duration, 0) || 1;
        if (ct < dur) busy = true;
      }
      if (!busy && def.isLoop && this.state === 'play') busy = true; // a looping effect waits for stop()
    }
    if (def.maxLifetime > 0 && ct >= def.maxLifetime) busy = false;
    if (!busy) this._finish();
  }

  _finish() {
    const def = this.def;
    for (const nd of def.inactiveOnFinish) { this.forcedOff[nd] = 1; this.act[nd] = 0; }
    for (const s of this.sys) if (s) s.stopEmitting();
    if (this.onFinish) { const f = this.onFinish; this.onFinish = null; try { f(this); } catch { /* chained effects are optional */ } }
    if (def.delayToFinish > 0) { this.state = 'linger'; this.linger = def.delayToFinish; }
    else this.state = 'done';
  }

  /**
   * Visible renderers as draw items: sink(item) with item = { kind: 'quad'|'mesh'|'strip', first, count, mat, ov,
   * order, layer, queue, dist, ground, node, meshKey, submesh, effect }.
   */
  collect(cam, fd, sink, frameNo) {
    if (this.state === 'done' || this.ctime < 0 || this.hidden) return;
    const def = this.def, n = def.n, lite = this.lite;
    const camPos = cam.pos;
    for (let i = 0; i < n; i++) {
      if (!this.hier[i]) continue;
      const w = this.world[i];
      const dx = w[12] - camPos[0], dy = w[13] - camPos[1], dz = w[14] - camPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const nearGround = Math.abs(w[14] - this.groundZ) < 0.25;
      const ov = this.matOv.get(i) || null;
      const tint = this._tint();
      // particles (+ the trail module with materials[1])
      const r = def.psr[i], s = this.sys[i];
      if (r && s && r.enabled && r.mode !== 'none' && (s.count > 0 || s.orphans.length)) {
        const m0 = r.mats[0] != null ? def.material(r.mats[0], lite) : null;
        if (m0 && s.count > 0) {
          const meshData = r.mode === 'mesh' ? (r.mesh && this.lib ? this.lib.mesh(r.mesh) : null) : null;
          const info = this.__ri || (this.__ri = {});
          Object.assign(info, r, { meshData, tint });
          const res = buildParticles(s, info, cam, fd, frameNo);
          if (res) {
            const flat = isFlatParticles(r, w, meshData);
            sink(item(res.kind, res.first, res.count, m0, ov, r.order, r.layer, dist + r.fudge, flat && nearGround, i, this, r.mode === 'mesh' ? r.mesh : null, 0));
          }
        }
        if (s.def.trail && r.mats[1] != null) {
          const m1 = def.material(r.mats[1], lite);
          if (m1) {
            const res = buildParticleTrails(s, cam, fd, tint);
            if (res) sink(item('strip', res.first, res.count, m1, ov, r.order, r.layer, dist + r.fudge, false, i, this, null, 0));
          }
        }
      }
      // mesh renderer
      const mr = def.mesh[i];
      if (mr && mr.enabled && mr.mesh && (this.rendOv.get(i)?.enabled ?? true)) {
        const md = this.lib ? this.lib.mesh(mr.mesh) : null;
        if (md) {
          const flat = isFlatMesh(md, w);
          const inst = buildMeshInstance(w, fd, tint);
          for (let k = 0; k < mr.mats.length; k++) {
            if (mr.mats[k] == null) continue;
            const mat = def.material(mr.mats[k], lite);
            if (!mat || !md.submeshes || !md.submeshes[k]) continue;
            sink(item('mesh', inst, 1, mat, ov, mr.order, mr.layer, dist, flat && nearGround, i, this, mr.mesh, k));
          }
        }
      }
      // skinned mesh (CPU skinning)
      const sk = def.skinned[i];
      if (sk && sk.enabled && sk.mesh) {
        const md = this.lib ? this.lib.mesh(sk.mesh) : null;
        if (md && md.boneWeights) {
          const bones = sk.bones.map((b) => (b >= 0 && b < n ? this.world[b] : null));
          for (let k = 0; k < sk.mats.length; k++) {
            if (sk.mats[k] == null || !md.submeshes[k]) continue;
            const mat = def.material(sk.mats[k], lite);
            if (!mat) continue;
            const res = buildSkinned(md, bones, k, fd, tint);
            if (res) sink(item('strip', res.first, res.count, mat, ov, sk.order, sk.layer, dist, false, i, this, null, 0));
          }
        }
      }
      // trail renderer
      const tr = def.trail[i];
      if (tr && tr.enabled && tr.mats[0] != null) {
        const st = this.trails.get(i);
        if (st && st.n > 0) {
          const mat = def.material(tr.mats[0], lite);
          if (mat) {
            const res = this._trailStrip(i, tr, st, cam, fd);
            if (res) sink(item('strip', res.first, res.count, mat, ov, tr.order, tr.layer, dist, false, i, this, null, 0));
          }
        }
      }
      // line renderer
      const ln = def.line[i];
      if (ln && ln.enabled && ln.mats[0] != null) {
        const mat = def.material(ln.mats[0], lite);
        const pts = this.linePts.get(i) || ln.points;
        if (mat && pts.length >= 2) {
          const buf = this.__lb && this.__lb.length >= (pts.length + 1) * 3 ? this.__lb : (this.__lb = new Float32Array((pts.length + 1) * 3 + 12));
          const world = this.linePts.has(i) ? true : ln.world;
          const cnt = linePoints(pts, world, w, ln.loop, buf);
          const P = ln.params, wm = this.rendOv.get(i)?.width ?? P.width;
          const res = buildRibbon(buf, cnt, (k, u) => evalCurve(P.widthCurve, u) * wm / 2, (k, u, out) => {
            P.color.at(u, out);
            if (tint) { out[0] *= tint[0]; out[1] *= tint[1]; out[2] *= tint[2]; out[3] *= tint[3]; }
          }, fd, { texMode: P.textureMode, cam, alignZ: P.alignment === 1 ? [w[8], w[9], w[10]] : null });
          if (res) sink(item('strip', res.first, res.count, mat, ov, ln.order, ln.layer, dist, false, i, this, null, 0));
        }
      }
    }
  }

  /** The colour multiplier of this frame: ColorModifier × the stop fade. */
  _tint() {
    const f = this.fade ?? 1;
    if (f >= 1) return this.tint;
    const t = this.__t4 || (this.__t4 = [1, 1, 1, 1]);
    const b = this.tint || [1, 1, 1, 1];
    t[0] = b[0]; t[1] = b[1]; t[2] = b[2]; t[3] = b[3] * f;
    return t;
  }

  /** A TrailRenderer's ribbon: the node now (head) and its points newest → oldest. */
  _trailStrip(i, tr, st, cam, fd) {
    const w = this.world[i];
    const cnt = st.n + 1;
    const buf = this.__tb && this.__tb.length >= cnt * 3 ? this.__tb : (this.__tb = new Float32Array(Math.max(cnt, 64) * 3));
    let k = 0;
    if (this.hier[i] && st.emitting && this.state === 'play') { buf[0] = w[12]; buf[1] = w[13]; buf[2] = w[14]; k = 1; }
    for (let j = 0; j < st.n; j++) {
      const o = ((st.head - 1 - j + 512) % 256) * 4;
      buf[k * 3] = st.pts[o]; buf[k * 3 + 1] = st.pts[o + 1]; buf[k * 3 + 2] = st.pts[o + 2];
      k++;
    }
    if (k < 2) return null;
    const P = tr.params, wm = this.rendOv.get(i)?.width ?? P.width;
    const tint = this._tint();
    return buildRibbon(buf, k, (j, u) => evalCurve(P.widthCurve, u) * wm / 2, (j, u, out) => {
      P.color.at(u, out);
      if (tint) { out[0] *= tint[0]; out[1] *= tint[1]; out[2] *= tint[2]; out[3] *= tint[3]; }
    }, fd, { texMode: P.textureMode, cam, alignZ: P.alignment === 1 ? [w[8], w[9], w[10]] : null });
  }
}
const _qa = [0, 0, 0, 1];

/** Rotation of a direction: yaw about Z, then pitch about the turned Y, then roll about the turned X. */
function dirQuat(yaw, pitch, roll, out) {
  quatAxis(0, 0, 1, yaw, out);
  if (pitch) quatMul(out, quatAxis(0, 1, 0, pitch, _qa), out);
  if (roll) quatMul(out, quatAxis(1, 0, 0, roll, _qa), out);
  return quatNormalize(out);
}

/** The world yaw of the client's direction enum (Torappu.SharedConsts.Direction: UP 0, RIGHT 1, DOWN 2, LEFT 3). */
export const DIR_YAW = Object.freeze([Math.PI / 2, 0, -Math.PI / 2, Math.PI]);

/** Battle seconds a stopped effect takes at most to fade out (see _lifecycle). */
export const STOP_FADE = 0.6;

function item(kind, first, count, mat, ov, order, layer, dist, ground, node, effect, meshKey, submesh) {
  return { kind, first, count, mat, ov, order, layer, queue: mat.queue, dist, ground, node, effect, meshKey, submesh };
}

/** Particles drawn flat on the board: world / vertical billboards, local quads (or flat meshes) lying in XY. */
function isFlatParticles(r, w, meshData) {
  if (r.mode === 'vertical') return true;
  if (r.mode === 'stretch' || r.mode === 'horizontal') return false;
  if (r.align === 'world') return r.mode !== 'mesh' || flatZ(meshData);
  if (r.align !== 'local') return false;
  if (r.mode === 'mesh' && !flatZ(meshData)) return false;
  const l = Math.hypot(w[8], w[9], w[10]) || 1;
  return Math.abs(w[10] / l) > 0.82;
}

/** A planar mesh in its XY plane. */
function flatZ(md) {
  if (!md) return false;
  if (md.__flat !== undefined) return md.__flat;
  const P = md.positions || [];
  let zmin = Infinity, zmax = -Infinity, ext = 0;
  for (let k = 0; k < P.length; k += 3) {
    zmin = Math.min(zmin, P[k + 2]); zmax = Math.max(zmax, P[k + 2]);
    ext = Math.max(ext, Math.abs(P[k]), Math.abs(P[k + 1]));
  }
  md.__flat = P.length > 0 && zmax - zmin <= Math.max(1e-4, ext * 0.05);
  return md.__flat;
}

function isFlatMesh(md, w) {
  if (!flatZ(md)) return false;
  const l = Math.hypot(w[8], w[9], w[10]) || 1;
  return Math.abs(w[10] / l) > 0.82;
}
