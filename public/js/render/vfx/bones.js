// render/vfx/bones.js — FollowMountPoint on the skeleton bone (the client's BoneFollower): a skin point that names a
// bone (index.json skins[…].points[name].front / back `.bone`, DESIGN §33.12 Skin) is the bone's place in the model's
// Idle pose; an effect that follows it moves with the bone as the model plays (a floating unit bobbing with its
// operator's idle, swinging with her attack). Client only; reads the view's Spine actor (render/spine.js SpineActor):
// no actor, no such bone or no Idle clip → no shift (the skin's static point).
//
//   boneShift(v, skin, kind, pose, out) → true when it added the bone's offset from its Idle place to `out` (Unity frame)
//
// The numbers (round 46, the four 驭械术士's funnel bones against their skins): a Special point's x is the bone's x in the
// Idle pose × SKEL_UNIT (F_Funnel_Muzzle_1–3, F_UVA_01, F_Fly, F_Rock_1 / _2: −192.32 × 0.0027 = −0.519, …), its height
// in the Graphic plane the same scale about the skeleton's origin (0.157 under the root); the Graphic plane is turned
// −30° about x (skins[…].graphic.rot), so a rise h of the bone is (0, h·cos 30°, −h·sin 30°) in the unit's frame.
// pixi-spine poses with y down. [ASSUMED] SKEL_UNIT for every model (the four agree to the third digit); the offset is
// taken from the Idle clip's first frame (the skins' points match it to within the idle bob).

import { POINT_NAMES } from './mounts.js';

/** Unity units per skeleton unit of the battle models (module header). */
export const SKEL_UNIT = 0.0027;
const COS = Math.cos(Math.PI / 6), SIN = Math.sin(Math.PI / 6);
const special = (n) => [`Special${n}`, `SpecialPoint${n}`, `Special_${n}`];

/** fn() or null when it throws (a skeleton of a runtime that cannot be posed here). */
const safe = (fn) => { try { return fn(); } catch { return null; } };

/** spineData → Map(bone name → [x, y] in the Idle pose's first frame | null) */
const REF = new WeakMap();
/** skeleton → Map(bone name → bone | null) */
const BONES = new WeakMap();

/** The bone name of a skin point kind ('s0', 'muzzle', …) for the facing, or null. */
export function boneOf(skin, kind, back) {
  const pts = skin && skin.points;
  if (!pts || !kind) return null;
  const names = kind[0] === 's' ? special(kind.slice(1)) : POINT_NAMES[kind] || [];
  for (const nm of names) {
    const p = pts[nm];
    if (!p) continue;
    const f = (back ? p.back : p.front) || p.all || p.front || p.back;
    return f && typeof f.bone === 'string' && f.bone ? f.bone : null;
  }
  return null;
}

/** The bone's place in the Idle clip's first frame (a scratch skeleton of the same runtime), or null. */
function refOf(actor, name) {
  const data = actor?.spine?.spineData || actor?.spine?.skeleton?.data;
  if (!data) return null;
  let m = REF.get(data);
  if (!m) { m = new Map(); REF.set(data, m); }
  if (m.has(name)) return m.get(name);
  const r = safe(() => {
    const Sk = actor.spine.skeleton.constructor;
    const sk = new Sk(data);
    const idle = actor.entry?.anims?.idle || 'Idle';
    const anim = typeof data.findAnimation === 'function' ? data.findAnimation(idle) || data.findAnimation('Idle') : null;
    sk.setToSetupPose();
    if (anim && typeof anim.apply === 'function') anim.apply(sk, 0, 0, false, null, 1, 0, 0);
    sk.updateWorldTransform();
    const bone = sk.findBone(name);
    return bone && anim ? [bone.worldX, bone.worldY] : null;
  });
  m.set(name, r);
  return r;
}

/** The live bone of an actor's current skeleton, cached per skeleton. */
function liveBone(actor, name) {
  const sk = actor?.spine?.skeleton;
  if (!sk || typeof sk.findBone !== 'function') return null;
  let m = BONES.get(sk);
  if (!m) { m = new Map(); BONES.set(sk, m); }
  if (!m.has(name)) m.set(name, safe(() => sk.findBone(name)) || null);
  return m.get(name);
}

/**
 * Add a following effect's bone offset (module header) to `out` — a point already placed at the skin's static point
 * (mounts.js unitPoint) — for view `v` with pose { left, back, scale? }. Returns whether it did.
 */
export function boneShift(v, skin, kind, pose, out) {
  const actor = v && v.actor;
  if (!actor || !v.spineReady || !out) return false;
  const name = boneOf(skin, kind, !!pose.back);
  if (!name) return false;
  const b = liveBone(actor, name);
  const ref = b ? refOf(actor, name) : null;
  if (!b || !ref || !Number.isFinite(b.worldX) || !Number.isFinite(b.worldY)) return false;
  const k = (Number.isFinite(pose.scale) ? pose.scale : 1) * SKEL_UNIT;
  const dx = (b.worldX - ref[0]) * k * (pose.left ? -1 : 1);
  const up = -(b.worldY - ref[1]) * k;
  // a model swapped mid-clip or posed far off (a bone of another skeleton): ignored past a tile
  if (Math.abs(dx) > 1 || Math.abs(up) > 1) return false;
  out[0] += dx;
  out[1] += up * COS;
  out[2] -= up * SIN;
  return true;
}
