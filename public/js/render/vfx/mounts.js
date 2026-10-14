// render/vfx/mounts.js — where an official effect sits on a unit (DESIGN §33.11 `_spawnLocation`, §33.12 skins): the
// mount points of the unit's skin (in its root frame: Unity axes, through its Graphic node and FaceSwitcher scale),
// mirrored for a left-facing unit and taken from the Back skeleton for one facing up, placed at the unit's feet in the
// battle's Unity frame. Pure functions (Node tests).
//
//   spawnPoint(skin, spawn, unit, out)   unit = { x, y, z (board: col, row, height), left: bool, back: bool, scale? }
//   mountPoint(skin, type, unit, out)    FollowMountPoint's MountPointType (0 FOOT, 1 HIT, 2 MUZZLE, 3 HEAD, …)
//   POINT_NAMES                          the skin point names tried per point kind (names vary by skin)

/** Point names per kind, in the order tried (§33.12: HitPoint, HeadPoint / HeadAnchor, Muzzle / MuzzlePoint, …). */
export const POINT_NAMES = Object.freeze({
  hit: ['HitPoint', 'Hit', 'hitPoint'],
  muzzle: ['Muzzle', 'MuzzlePoint', 'muzzle'],
  head: ['HeadPoint', 'HeadAnchor', 'Head'],
});
const special = (n) => [`Special${n}`, `SpecialPoint${n}`, `Special_${n}`];

/** The point kind of a ParticleEffect spawn location (null = the unit's feet / the ground). */
export function spawnKind(spawn) {
  switch (spawn) {
    case 2: return 'hit';
    case 3: case 6: return 'muzzle';
    case 4: return 'head';
    case 8: return 's0'; case 9: return 's1'; case 10: return 's2'; case 11: return 's3';
    default:
      if (spawn >= 13 && spawn <= 16) return 's' + (spawn - 9);
      if (spawn >= 18 && spawn <= 25) return 's' + (spawn - 10);
      if (spawn >= 27 && spawn <= 34) return 's' + (spawn - 11);
      return null;
  }
}

/** The point kind of a FollowMountPoint MountPointType. */
export function mountKind(type) {
  switch (type) {
    case 1: return 'hit';
    case 2: return 'muzzle';
    case 3: return 'head';
    case 5: return 's0'; case 6: return 's1'; case 8: return 's2'; case 9: return 's3';
    default:
      if (type >= 10 && type <= 29) return 's' + (type - 6);
      return null; // FOOT, UI, GROUND
  }
}

/** A skin point's offset (Unity, unit root frame) by kind and facing; null when the skin lacks it. */
export function pointOffset(skin, kind, back) {
  const pts = skin && skin.points;
  if (!pts || !kind) return null;
  const names = kind[0] === 's' ? special(kind.slice(1)) : POINT_NAMES[kind] || [];
  for (const nm of names) {
    const p = pts[nm];
    if (!p) continue;
    const f = (back ? p.back : p.front) || p.all || p.front || p.back;
    if (f && Array.isArray(f.pos)) return f.pos;
  }
  return null;
}

/**
 * The Unity battle-frame position of a point of a unit: its feet (board x, y, z → (x − 10, y − 9, −z)) plus the
 * skin offset (x mirrored when the unit faces left; `scale` multiplies the offset).
 */
export function unitPoint(skin, kind, unit, out = [0, 0, 0]) {
  const k = Number.isFinite(unit.scale) ? unit.scale : 1;
  out[0] = unit.x - 10; out[1] = unit.y - 9; out[2] = -(unit.z || 0);
  const o = pointOffset(skin, kind, !!unit.back);
  if (o) {
    out[0] += (unit.left ? -o[0] : o[0]) * k;
    out[1] += o[1] * k;
    out[2] += o[2] * k;
  } else if (kind) {
    // no such point: a plausible fallback over the feet (hit ≈ a third of a tile up, muzzle a little higher, head ×2)
    const h = kind === 'head' ? 0.75 : kind === 'muzzle' ? 0.4 : 0.3;
    out[1] += h * 0.866 * k; out[2] -= h * 0.5 * k;
  }
  return out;
}

export function spawnPoint(skin, spawn, unit, out) { return unitPoint(skin, spawnKind(spawn), unit, out); }

export function mountPoint(skin, type, unit, out) { return unitPoint(skin, mountKind(type), unit, out); }
