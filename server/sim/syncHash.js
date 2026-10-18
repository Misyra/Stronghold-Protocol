// server/sim/syncHash.js — the state digest a server-run battle and a browser's display replica of it compare (DESIGN §14
// "Local display replicas"). Pure ESM (served at /sim/syncHash.js).
//
//   SYNC_TICKS                 a digest is taken right after every step that ends on a multiple of this tick count
//                              (2 game seconds: once a real second at 2×), and after the step that finishes the battle
//   isSyncTick(battle)         whether the step just taken is one of those
//   stateHash(battle)          uint32 digest of the battle state after a step
//
// The digest reads only plain fields the steps write (the rng state, counters, every unit's id / alive / deployed / hidden /
// hp / x / y / skill sp) — never a lazy getter such as `unit.s`, whose first read after a buff change rescales `hp`. Both
// sides take it right after `step()`, before anything renders that state, so a server and a browser that simulated the
// same ticks give the same 32 bits; doubles go in by their IEEE bits (−0 as +0, every NaN as one NaN).

export const SYNC_TICKS = 60;

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

/** @param {number} h @param {number} w */
const mix = (h, w) => {
  let k = Math.imul(w | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  const x = h ^ k;
  return (Math.imul((x << 13) | (x >>> 19), 5) + 0xe6546b64) | 0;
};

/** @param {number} h @param {number} v */
const mixNum = (h, v) => {
  if (typeof v !== 'number' || v !== v) return mix(mix(h, 0x7ff80000), 1);
  F64[0] = v === 0 ? 0 : v;
  return mix(mix(h, U32[0]), U32[1]);
};

/** @param {any} battle */
export function isSyncTick(battle) {
  const n = Number(battle && battle.tickCount) || 0;
  return !!battle && (battle.finished || (n > 0 && n % SYNC_TICKS === 0));
}

/**
 * @param {any} battle
 * @returns {number} uint32
 */
export function stateHash(battle) {
  let h = 0x5d1c7a11;
  h = mix(h, Number(battle.tickCount) | 0);
  h = mix(h, battle.finished ? 1 : 0);
  h = mix(h, battle.rng && typeof battle.rng.state === 'function' ? battle.rng.state() : 0);
  h = mix(h, Number(battle.killed) | 0);
  h = mix(h, Number(battle.total) | 0);
  h = mix(h, Number(battle.leakedCount) | 0);
  const units = Array.isArray(battle.units) ? battle.units : [];
  h = mix(h, units.length);
  for (const u of units) {
    h = mix(h, Number(u.id) | 0);
    h = mix(h, (u.alive ? 1 : 0) | (u.deployed ? 2 : 0) | (u.hidden ? 4 : 0) | (u.removed ? 8 : 0));
    h = mixNum(h, u.hp);
    h = mixNum(h, u.x);
    h = mixNum(h, u.y);
    h = mixNum(h, u.skill ? u.skill.sp : 0);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
