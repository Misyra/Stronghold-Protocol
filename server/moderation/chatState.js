// Shared by moderation, session expiry and persistence; does not load the private dictionary.
/** A violation stops counting toward the ban ladder this long after the last one (a clean stretch restarts at a warning). */
export const CHAT_WINDOW_MS = 30 * 60 * 1000;
/** Ban ladder by violation count in ms: 1st a warning only, then 10 min, 30 min, 6 h; 5th and beyond 24 h. */
export const CHAT_MUTE_LADDER = [0, 10 * 60 * 1000, 30 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
export const CHAT_MUTE_MAX_MS = CHAT_MUTE_LADDER.at(-1);

/** Violations still counting toward the ladder: none once 30 minutes have passed since the last violation or the end of the served mute. */
export function activeChatStrikes(strikes, lastHitAt, now, mutedUntil = 0) {
  const count = Number.isInteger(strikes) && strikes > 0 ? strikes : 0;
  const hot = Math.max(Number.isFinite(lastHitAt) && lastHitAt > 0 ? lastHitAt : 0,
    Number.isFinite(mutedUntil) && mutedUntil > 0 ? mutedUntil : 0);
  return count && now - hot < CHAT_WINDOW_MS ? count : 0;
}

/** Keep the reconnect identity while either an active violation or a mute still belongs to it. */
export function chatRetentionUntil(session, now) {
  const strikes = activeChatStrikes(session.chatStrikes, session.chatLastHitAt, now, session.chatMutedUntil);
  return Math.max(Number.isFinite(session.chatMutedUntil) ? session.chatMutedUntil : 0,
    strikes ? Math.max(session.chatLastHitAt, Number(session.chatMutedUntil) || 0) + CHAT_WINDOW_MS : 0);
}
