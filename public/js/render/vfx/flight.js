// render/vfx/flight.js — how an official projectile flies (DESIGN §33.12 Projectile; the client's movement classes,
// read from its native code): which effect flies, the lobbed arc of a ParacurveMovement and the wobble of an
// AmiyaS2Movement. The wiring (render/vfx/wiring.js `_fly`) keeps the sim's flight time; these give the path's shape.
// Pure functions (Node tests).
//
//   projectileEffects(proj)              { main, rope, chain }: the flying effect, a HarpoonRenderer's rope, a chain line
//   paracurve(mv, hs, ht, dist, seed)    a ParacurveMovement's arc for a start / end height and a distance, or null
//   arcHeight(arc, k, ht)                the height at flight fraction k (0…1), landing at the end height `ht`
//   wobble(mv, seed)                     an AmiyaS2Movement's sideways wobble { amp, hz, phase }, or null

/**
 * The effects a projectile entry names by role. index.json's `main` is the last `_mainEffect` its behaviours carry
 * (tools/local-extract/fx.py), and a chain-lightning or harpoon projectile carries two: its projectile behaviour's own
 * (SimpleProjectile, HarpoonProjectile, LassoProjectile, LaserProjectile …: the effect that flies) and its line
 * renderer's (ChainLightningEffectBehaviour: the lightning between the chain's links; HarpoonRenderer: the rope from the
 * shooter to the head), so 32 projectiles of the full set flew their line effect — a LineRenderer authored in world
 * space, drawn where it was authored. `main` is the projectile behaviour's own effect (index `main` without one; null
 * when that behaviour names none: a rope alone), `rope` a HarpoonRenderer's line, `chain` a chain line.
 */
export function projectileEffects(proj) {
  const out = { main: null, rope: null, chain: null };
  if (!proj) return out;
  const lc = (k) => (typeof k === 'string' && k ? k.toLowerCase() : null);
  let own = null;
  for (const b of Array.isArray(proj.behaviours) ? proj.behaviours : []) {
    const k = b && b.fields ? b.fields._mainEffect : undefined;
    if (typeof k !== 'string') continue;
    const cls = String(b.class || '');
    if (cls === 'HarpoonRenderer' || /Renderer$/.test(cls)) out.rope = out.rope || lc(k);
    else if (cls === 'ChainLightningEffectBehaviour') out.chain = out.chain || lc(k);
    else if (own === null && /Projectile$/.test(cls)) own = k;
  }
  out.main = own !== null ? lc(own) : (out.rope || out.chain ? null : lc(proj.main));
  return out;
}

/** A deterministic 0…1 of a seed (the random height / inverse coin of a ParacurveMovement: replayable). */
function unit01(seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A ParacurveMovement's arc (Torappu.Battle.Projectiles.ParacurveMovement, read from the client's GameAssembly.dll —
 * OnInit, OnTick, _CalculateNextPosition): the projectile crosses the ground at its speed `m_speed` (= `_speed`)
 * homing on the target, and climbs ballistically: the raise height h = `raiseHeight` (`useRandomHeight`: a value in
 * `randomHeightRange`) — 0 when the ground distance is not above `noRaiseHeightThreshold` —, the drop
 * H = max(0, hs + h − ht) from the top to the end height, flight time T = distance / speed, gravity
 * g = 2(√h + √H)² / T² and initial climb √(2gh): it tops out h above its start (heights in tiles, the start the
 * shooter's mount point) and comes down on the target's point. After the top the client re-solves g each tick to land
 * on the target's current height (a homing end). `inverseParacurve` (`randomInverseParacurve`: a coin) flies the mirror
 * image: climb √(2gh) − gT under −g, a sag below the line. As a function of the flight fraction k = t / T the height is
 * hs + 2√h·s·k − s²·k² with s = √h + √H (inverse: hs + 2s(√h − s)·k + s²·k²) whatever T is, so the remake's own flight
 * time (the sim's) flies the same path. Returns null for another movement class.
 * @param {any} mv the projectile's `movement`
 * @param {number} hs start height (tiles above the ground plane)
 * @param {number} ht end height
 * @param {number} dist ground distance (tiles)
 * @param {number} [seed] the random height / coin
 * @returns {{ h: number, inverse: boolean, hs: number }|null}
 */
export function paracurve(mv, hs, ht, dist, seed = 0) {
  if (!mv || mv.class !== 'ParacurveMovement') return null;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  let h = Math.max(0, num(mv.raiseHeight, 0));
  if (Number(mv.useRandomHeight) === 1 && Array.isArray(mv.randomHeightRange)) {
    const a = num(mv.randomHeightRange[0], h), b = num(mv.randomHeightRange[1], h);
    h = Math.max(0, a + (b - a) * unit01(seed));
  }
  if (!(dist > num(mv.noRaiseHeightThreshold, 0))) h = 0;
  const inverse = Number(mv.randomInverseParacurve) === 1 ? unit01(seed ^ 0x5bd1e995) < 0.5 : Number(mv.inverseParacurve) === 1;
  return { h, inverse, hs };
}

/**
 * The arc's height at flight fraction k (paracurve): it lands on `ht`, the end height now (a homing end; an end above
 * the top — the drop clamped to 0 — is reached by a linear share of the difference [ASSUMED: the client's re-solve
 * after the top]).
 */
export function arcHeight(arc, k, ht) {
  const kk = k < 0 ? 0 : k > 1 ? 1 : k;
  const rh = Math.sqrt(arc.h);
  const s = rh + Math.sqrt(Math.max(0, arc.hs + arc.h - ht));
  if (!(s > 0)) return arc.hs + (ht - arc.hs) * kk;
  const y = arc.inverse ? arc.hs + 2 * s * (rh - s) * kk + s * s * kk * kk : arc.hs + 2 * rh * s * kk - s * s * kk * kk;
  const y1 = arc.hs + 2 * rh * s - s * s;
  return y + (ht - y1) * kk;
}

/**
 * An AmiyaS2Movement's wobble (Torappu.Battle.Projectiles.AmiyaS2Movement: _UpdateBodyAnimation sets the body's local
 * position to (0, sin φ · `yAnimateOffset`, 0), φ advancing by 2π · `yAnimateSpeed` per second from a random start; the
 * body faces its flight, so the wobble runs across it): { amp (tiles), hz, phase (radians) }, or null for another
 * class or a zero amplitude. Its flight is straight and homing, in `time` s after a start phase of `startDuration` s
 * towards `startDistance` in a random direction (both 0 for the roster's 安洁莉娜 S2); the remake keeps the sim's time.
 */
export function wobble(mv, seed = 0) {
  if (!mv || mv.class !== 'AmiyaS2Movement') return null;
  const amp = Number(mv.yAnimateOffset) || 0;
  const hz = Number(mv.yAnimateSpeed) || 0;
  if (!amp) return null;
  return { amp, hz, phase: unit01(seed) * Math.PI * 2 };
}
