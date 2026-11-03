// server/match/match/common.js — constants and small helpers shared by the Match method modules
// (server/match/match/*.js); server/match/Match.js re-exports FLOW_TICKER_PRIORITY, DELAYS, BAND_TURN_SECONDS and
// AFK_REMOVE_ROUNDS.

/**
 * Ticker priority of the remake's match-flow notices (隐秘核心已解锁, 联防阶段, a player out or gone): the official lines
 * (research 06 §9.2) go BOSS_HIT 30 > CHAR_DAMAGE 20 > SHOP_LEVEL 11 > GOLDEN_CHAR 2 > CHAR_GIFT 1; ours sit under the
 * leader-damage lines [ASSUMED].
 */
export const FLOW_TICKER_PRIORITY = 25;
/** 掉线由 AI 接管: prep ends a seat spends offline before the AI plays it (MatchPlatform._checkOffline). */
export const OFFLINE_TAKEOVER_ROUNDS = 2;
/**
 * 挂机移出 (移植自用户分支; Match opts.afkRemoveRounds, 0 = off): the rounds in a row without a substantive intent after
 * which a human seat of a match that started with ≥ 2 humans is removed like a g.leave (MatchPlatform._checkIdle).
 */
export const AFK_REMOVE_ROUNDS = 2;
/**
 * The intents that count as playing for that rule — accepted ones only. g.ready, g.infoReady, g.emote, g.watch,
 * g.unitStats, g.pause, g.art, g.bandFocus, g.autoplay, g.rerollVote, g.bondPlan, the battle reports and anything else
 * do not.
 */
export const AFK_ACTIONS = new Set(['g.buy', 'g.sell', 'g.move', 'g.refresh', 'g.levelUp', 'g.freeze', 'g.equip', 'g.unequip',
  'g.destroy', 'g.choice', 'g.reward', 'g.band', 'g.bandSkip']);
/** Boss clock period (overtime drain, end checks, silence watchdog) in real ms. */
export const BOSS_CLOCK_MS = 250;
export const OK = Object.freeze({ ok: true });
export const fail = (error, detail) => (detail ? { error, detail } : { error });

/** Fixed presentation delays (real ms, × timerScale). */
export const DELAYS = Object.freeze({
  ROUND_START: 2000,
  COMBAT_END: 1500,
  SETTLE: 3000,
  BOT_ACTION: 900,
  BOT_STAGGER: 350,
  PUBLIC_THROTTLE: 100,
  /** Coalescing window of Match.flushSoon (real ms, NOT scaled: view latency, not game time). */
  PRIVATE_FLUSH: 50,
});

/**
 * Seconds of one turn of the co-op strategy draft (user playtest #4 item 4: the old 12 s per turn — research 06 §724,
 * itself [ASSUMED] — inside the 50 s step was far too little and counted apart from the header's 50 s). [ASSUMED]: the
 * official data only gives the whole BAND_CHECK step (autoChessData.enterStepList: 50 s, hint 15 s); the turn clock is
 * the remake's (50 s per turn per the owner's 2026-10-10 official-play report). It is also the step's only countdown (m.public.deadline = draft.turnDeadline). × timerScale.
 */
export const BAND_TURN_SECONDS = 50;
