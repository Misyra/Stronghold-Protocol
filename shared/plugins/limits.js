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
