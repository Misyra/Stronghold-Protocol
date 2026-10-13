// Shared numeric bounds for data plugins (DESIGN §32.5). The battle imports these same numbers so a later
// writer cannot bypass validateData. [ASSUMED] each cap is above every official table and far below ±1e9.

/** Spawn rows in one wave, or in one branch phase. Official waves stay at or below 28. */
export const PLUGIN_SPAWN_ENTRIES = 64;
/**
 * Living enemies one wave or branch phase may ask for, and the per-row count. Must equal
 * server/sim/constants.js MAX_ALIVE_ENEMIES. Shared code does not import the server; the regression test locks the two.
 */
export const PLUGIN_SPAWN_TOTAL = 600;
/** Enemy blackboard `times` / keys ending in `times`. Official values stay at or below 8. JSON SkillSpec hits stay at 100. */
export const PLUGIN_TIMES_MAX = 100;
/** Per-count card grants. Official `global_special_choice_gain_equip` and bond-chess counts stay at or below 2. */
export const PLUGIN_GAIN_COUNT_MAX = 32;
export const PLUGIN_GAIN_COUNT_KEYS = Object.freeze([
  'global_special_choice_gain_equip',
  'single_special_choice_gain_bond_chess',
]);
/**
 * Systematic cap for every other numeric blackboard key and the loop fields in officialBounds.js.
 * [ASSUMED] DESIGN §32.5: `|v| ≤ max(10 × official absolute max, 64)`. A key the official tables never
 * have uses the floor. Official inputs of the clamped loops are at or below 55, so the floor alone does
 * not change a vanilla fight.
 */
export const PLUGIN_BOUND_FACTOR = 10;
export const PLUGIN_BOUND_FLOOR = 64;

/**
 * Cap for one official absolute maximum. A missing or negative maximum uses the floor.
 * @param {unknown} officialMax
 * @returns {number}
 */
export function dataBound(officialMax) {
  const m = Number(officialMax);
  if (!Number.isFinite(m) || m < 0) return PLUGIN_BOUND_FLOOR;
  return Math.max(PLUGIN_BOUND_FACTOR * m, PLUGIN_BOUND_FLOOR);
}

/**
 * A finite count capped to [0, max] without flooring: a 2.5 loop still runs three times. Non-finite values use fallback.
 * @param {unknown} value
 * @param {number} max
 * @param {number} fallback
 */
export function boundedCount(value, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, n));
}
