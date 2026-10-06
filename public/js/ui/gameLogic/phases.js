// ui/gameLogic/phases.js — phase families, banners and countdowns. Re-exported from ../gameLogic.js.

import { PHASE } from '../../../../shared/constants.js';
import { bossLevelSeconds } from '../matchStatus.js';
import { clamp, int, isObj, sortedPlayers } from './shared.js';
import { normalizeSp } from './draft.js';
import { t } from '../../../../shared/i18n.js';


// ---- phases ----------------------------------------------------------------------------------------

const COMBAT_PHASES = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);
const PREP_PHASES = new Set([PHASE.PREP, PHASE.SP_DRAFT, PHASE.ROUND_START]);

/**
 * Which screen family a phase belongs to.
 * @param {string} phase
 * @returns {'loading'|'briefing'|'draft'|'boot'|'prep'|'combat'|'settle'|'result'}
 */
export function phaseMode(phase) {
  if (!phase) return 'loading';
  if (phase === PHASE.INFO_CHECK) return 'briefing';
  if (phase === PHASE.BAND_DRAFT) return 'draft';
  if (phase === PHASE.BATTLE_CHECK) return 'boot';
  if (phase === PHASE.RESULT) return 'result';
  if (phase === PHASE.SETTLE) return 'settle';
  if (COMBAT_PHASES.has(phase)) return 'combat';
  if (PREP_PHASES.has(phase)) return 'prep';
  return 'prep';
}

export const isCombatPhase = (phase) => COMBAT_PHASES.has(phase);
/**
 * The HUD's "你已被淘汰 · 可继续观战队友" pill of an eliminated player: outside combat only — in combat and in the SETTLE
 * after it the combat HUD (screens/game.js CombatHud, rendered for mode 'settle' too) already says it, and two
 * elimination banners never show at once.
 * @param {boolean} alive
 * @param {string|null|undefined} phase
 */
export const showDeadPill = (alive, phase) => !alive && !COMBAT_PHASES.has(phase) && phase !== PHASE.SETTLE;
export const isBossPhase = (phase) => phase === PHASE.FINAL_ASSAULT || phase === PHASE.HIDDEN_CORE;

/** Banner shown when a phase starts: { title, sub?, tone } or null. */
export function phaseBanner(phase, pub) {
  const r = int(pub?.round, 0);
  switch (phase) {
    case PHASE.BATTLE_CHECK: return { title: t('协议启动'), micro: 'PROTOCOL START', tone: 'mint', sub: t('模拟即将开始'), duration: 2600 };
    case PHASE.ROUND_START: return { title: t('第 {r} 回合', { r }), micro: `ROUND ${String(r).padStart(2, '0')}`, tone: 'mint', sub: t('资金已到账') };
    case PHASE.SP_DRAFT: return { title: t('机变阶段'), micro: 'CONTINGENCY', tone: 'gold', sub: t('依次选择机变') };
    case PHASE.PREP: return { title: t('休整期'), micro: `ROUND ${String(r).padStart(2, '0')} // REST`, tone: 'mint', sub: t('部署干员，准备迎敌') };
    case PHASE.COMBAT: return { title: t('作战开始'), micro: 'COMBAT', tone: 'orange', sub: t('各自行动阶段') };
    case PHASE.UNITE: {
      const names = new Map(sortedPlayers(pub).map((p) => [p.playerId, p.name || t('博士')]));
      const helpers = Array.isArray(pub?.unite?.helpers) ? pub.unite.helpers.map((id) => names.get(id)).filter(Boolean) : [];
      return { title: t('联防阶段'), micro: 'JOINT DEFENSE', tone: 'orange', sub: helpers.length ? t('联防：{names}', { names: helpers }) : t('完美作战的博士迎战突破防线的敌人') };
    }
    case PHASE.FINAL_ASSAULT: return { title: t('最终攻势'), micro: 'FINAL ASSAULT', tone: 'red', sub: t('击败敌方领袖') };
    case PHASE.HIDDEN_CORE: return { title: t('隐秘核心'), micro: 'HIDDEN CORE', tone: 'red', sub: t('被源石侵蚀的假想敌') };
    case PHASE.SETTLE: return null;
    default: return null;
  }
}

/** Label of the prep capsule ("休息一下" in the original). */
export function prepCapsuleLabel(phase) {
  if (phase === PHASE.SP_DRAFT) return t('机变阶段');
  if (phase === PHASE.ROUND_START) return t('回合开始');
  if (phase === PHASE.BATTLE_CHECK) return t('协议启动');
  if (phase === PHASE.SETTLE) return t('回合结算');
  return t('休息一下');
}

// ---- countdown -------------------------------------------------------------------------------------

/**
 * Countdown display state.
 * @param {number|null|undefined} deadline server epoch ms (0/null = untimed)
 * @param {number} now server-corrected epoch ms
 * @param {number} [total] total seconds of the phase (for the 5-bar gauge)
 * @param {number} [warnAt] seconds at/below which the digits turn orange
 * @returns {{ remain: number|null, warn: boolean, bars: number, text: string, frac: number }}
 */
export function countdownState(deadline, now, total, warnAt = 10) {
  if (!(Number.isFinite(deadline) && deadline > 0) || !Number.isFinite(now)) {
    return { remain: null, warn: false, bars: 0, text: '--', frac: 0 };
  }
  const remain = Math.max(0, Math.ceil((deadline - now) / 1000));
  const t = Number.isFinite(total) && total > 0 ? total : null;
  const frac = t ? clamp(remain / t, 0, 1) : 1;
  const bars = remain === 0 ? 0 : t ? clamp(Math.ceil(frac * 5), 0, 5) : 5;
  return { remain, warn: remain <= warnAt, bars, text: String(Math.min(999, remain)).padStart(2, '0'), frac };
}

/**
 * Nominal length (s) of the current timed phase from data/config.json, or null when unknown/untimed.
 * @param {any} pub m.public
 * @param {any} config data/config.json
 * @param {string|null} [myId]
 */
export function phaseTotalSeconds(pub, config, myId = null) {
  if (!isObj(pub)) return null;
  const timers = isObj(config?.timers) ? config.timers : {};
  const mode = isObj(config?.modes) ? config.modes[pub.modeId] : null;
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  switch (pub.phase) {
    case PHASE.INFO_CHECK: return num(timers.infoCheck) ?? 25;
    // one countdown: the current turn's (m.public.draft.turnSeconds = Match.BAND_TURN_SECONDS; user playtest #4 item 4)
    case PHASE.BAND_DRAFT: return num(pub.draft?.turnSeconds) ?? num(timers.bandTurn) ?? 30;
    case PHASE.BATTLE_CHECK: return num(timers.battleCheck) ?? 3;
    case PHASE.SP_DRAFT: {
      const sp = normalizeSp(pub.sp, pub.players);
      const first = !sp || sp.pickedCount === 0;
      return first ? (num(timers.spFirst) ?? 30) : (num(timers.spTurn) ?? 16);
    }
    case PHASE.PREP: return num(mode?.rounds?.[String(pub.round)]?.prepTime);
    case PHASE.COMBAT:
    case PHASE.UNITE: return num(mode?.rounds?.[String(pub.round)]?.combatTimeLimit);
    // 最终攻势 / 隐秘核心: m.public.deadline is the level's 120 s countdown (maxPlayTime; the battle goes on past it)
    case PHASE.FINAL_ASSAULT:
    case PHASE.HIDDEN_CORE: return bossLevelSeconds(pub, config);
    default: return null;
  }
}
