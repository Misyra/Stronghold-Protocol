// Shared by moderation, session expiry and persistence; does not load the private dictionary.
export const CHAT_WINDOW_MS = 10 * 60 * 1000;
export const CHAT_MUTE_MS = 12 * 60 * 60 * 1000;

/** At most four unexpired hits: the fifth starts a mute and consumes the window. */
export function recentChatHits(times, now) {
  return (Array.isArray(times) ? times : []).filter(at => Number.isFinite(at) && at >= 0 && at > now - CHAT_WINDOW_MS && at <= now)
    .sort((a, b) => a - b).slice(-4);
}

/** Keep the reconnect identity while either an active hit or a mute still belongs to it. */
export function chatRetentionUntil(session, now) {
  const hits = recentChatHits(session.chatHitTimes, now);
  return Math.max(Number.isFinite(session.chatMutedUntil) ? session.chatMutedUntil : 0,
    hits.length ? hits.at(-1) + CHAT_WINDOW_MS : 0);
}
