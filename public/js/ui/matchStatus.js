// Pure match-status helpers of the in-match HUD (no DOM, no Preact — unit-tested in test/ui/leftovers.test.js):
//
//   * Boss-round clock (最终攻势 / 隐秘核心, research 00-INDEX §5, 01 §10): m.public.deadline is the level's
//     maxPlayTime countdown (120 real s, config modes[…].rounds[r].levelMaxPlayTime) — "计时结束后战斗仍然会继续" —
//     and m.public.overtimeAt is when the overtime drain starts (bossTurnHpReduceTime, 150 real s): from then on the
//     merged team LP loses config.bossOvertimeDrainPerSec (1) per whole real second (server gamedata.js
//     bossOvertimeDue: the first point at overtimeAt + 1 s). `overtimeState` says what the red DOT warning shows.
//   * Solo pause (official 独立模拟 battles): C2S g.pause {on}; the server says so in m.public.paused (optionally
//     m.public.pausedAt, ms epoch). Only solo battles offer it (`pauseAvailable`); while paused every HUD clock is
//     frozen at the pause moment (`frozenNow`).

import { PHASE } from '../../../shared/constants.js';

const isObj = (v) => !!v && typeof v === 'object';
const BOSS_PHASES = new Set([PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);
const BATTLE_PHASES = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);
/** Game seconds per real second of a normal battle — the official forced 2× (server/match/fields.js GAME_SPEED). */
export const BASE_BATTLE_SPEED = 2;
/** Battle phases a solo player may pause (a solo run has no 联防). */
const PAUSE_PHASES = new Set([PHASE.COMBAT, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

/** Level time of a boss round when the config does not say (research 01 §3: maxPlayTime 120 s). */
export const BOSS_LEVEL_SECONDS = 120;
/** The pending overtime warning shows this many seconds before the drain even while the level countdown still runs. */
export const OVERTIME_WARN_BEFORE = 30;

/**
 * The level's countdown length (s) of a boss round — the gauge total of the 120 s countdown.
 * @param {any} pub m.public
 * @param {any} config data/config.json
 * @returns {number|null} null outside boss rounds
 */
export function bossLevelSeconds(pub, config) {
  if (!isObj(pub) || !BOSS_PHASES.has(pub.phase)) return null;
  const mode = isObj(config?.modes) ? config.modes[pub.modeId] : null;
  const v = mode?.rounds?.[String(pub.round)]?.levelMaxPlayTime;
  return Number.isFinite(v) && v > 0 ? v : BOSS_LEVEL_SECONDS;
}

/** Team LP lost per real second of overtime (config.bossOvertimeDrainPerSec, default 1) at `pub`'s battle speed. */
export function overtimeDrainPerSec(config, pub = null) {
  const v = config?.bossOvertimeDrainPerSec;
  const base = Number.isFinite(v) && v >= 0 ? v : 1;
  return base * battleSpeedScale(pub);
}

/**
 * How much faster than the nominal clock a battle phase runs (战斗 2 倍速, server/match/match/speedVote.js):
 * `m.public.speedVote.speed` over the base battle speed. 1 outside a battle phase — prep / draft timers are never
 * scaled — and 1 without a running 2× vote. The countdown gauge's total and the overtime LP projection are real seconds
 * of the clock the server gave the field, so they divide / multiply by this.
 * @param {any} pub m.public
 * @returns {number} 1 (normal) or the battle speed / BASE_BATTLE_SPEED (2 for the vote's SPEED_UP)
 */
export function battleSpeedScale(pub) {
  if (!isObj(pub) || !BATTLE_PHASES.has(pub.phase)) return 1;
  const v = pub.speedVote;
  if (!isObj(v) || v.on !== true) return 1;
  const speed = Number(v.speed);
  return Number.isFinite(speed) && speed > 0 ? speed / BASE_BATTLE_SPEED : BASE_BATTLE_SPEED;
}

/**
 * What the red overtime (DOT) warning of a boss round shows at `now` (server-corrected ms epoch):
 *   null                                  nothing (not a boss round, no overtimeAt, or the drain is still far away)
 *   { state: 'pending', secs }            the drain starts in `secs` s (shown once the level countdown ran out, or
 *                                         within OVERTIME_WARN_BEFORE s of the drain)
 *   { state: 'drain', secs, lost, perSec } draining for `secs` whole seconds: `lost` LP so far, `perSec` LP/s
 * @param {any} pub m.public
 * @param {number} now
 * @param {{ perSec?: number, warnBefore?: number }} [o]
 */
export function overtimeState(pub, now, { perSec = 1, warnBefore = OVERTIME_WARN_BEFORE } = {}) {
  if (!isObj(pub) || !BOSS_PHASES.has(pub.phase) || !Number.isFinite(now)) return null;
  const at = Number(pub.overtimeAt);
  if (!(Number.isFinite(at) && at > 0)) return null;
  if (now < at) {
    const secs = Math.ceil((at - now) / 1000);
    const levelOver = Number.isFinite(pub.deadline) && pub.deadline > 0 && now >= pub.deadline;
    if (!levelOver && secs > warnBefore) return null;
    return { state: 'pending', secs };
  }
  const secs = Math.floor((now - at) / 1000);
  const rate = Number.isFinite(perSec) && perSec >= 0 ? perSec : 1;
  return { state: 'drain', secs, lost: secs * rate, perSec: rate };
}

/**
 * Whether the solo pause control is offered: solo runs only (hidden in co-op), while the player's own battle runs
 * (server Match.setPause: WRONG_PHASE once no battle is live). While paused the control stays (to resume).
 * @param {any} pub m.public
 * @param {{ solo?: boolean, alive?: boolean, done?: boolean }} [o] done: the own battle is over
 */
export function pauseAvailable(pub, { solo = false, alive = true, done = false } = {}) {
  if (!solo || !isObj(pub) || alive === false) return false;
  if (done && !pub.paused) return false;
  return PAUSE_PHASES.has(pub.phase);
}

/** Whether m.public says the (solo) match is paused. */
export const isPaused = (pub) => isObj(pub) && !!pub.paused;

/** The pause intent (C2S g.pause {on}). */
export const pauseIntent = (on) => ({ t: 'g.pause', fields: { on: !!on } });

/**
 * The clock every HUD countdown reads: the live server time, or — while paused — the moment the pause began
 * (m.public.pausedAt when the server sends it, else the first time this client saw `paused`).
 * @param {any} pub m.public
 * @param {number} now live server-corrected ms epoch
 * @param {number|null} seenAt when this client first saw the pause (ms epoch), or null
 */
export function frozenNow(pub, now, seenAt = null) {
  if (!isPaused(pub)) return now;
  const at = Number(pub.pausedAt);
  if (Number.isFinite(at) && at > 0) return Math.min(now, at);
  return Number.isFinite(seenAt) ? Math.min(now, seenAt) : now;
}

/**
 * Seconds left on a deadline at `now` (ceil, ≥ 0), or null without a deadline.
 * @param {number|null|undefined} deadline ms epoch
 * @param {number} now ms epoch
 */
export function remainAt(deadline, now) {
  if (!(Number.isFinite(deadline) && deadline > 0) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
