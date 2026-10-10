// i18n-ignore-file: server-only moderation policy, no UI strings.
import { maskSensitiveText } from './nickname.js';
import { ERR } from '../../shared/constants.js';
export const CHAT_MUTE_MS = 12 * 60 * 60 * 1000;
export const CHAT_COOLDOWN_MS = 1000;
export function chatEnabled(value = process.env.SP_CHAT_ENABLED) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['', '0', 'false', 'off'].includes(v)) return false;
  if (['1', 'true', 'on'].includes(v)) return true;
  throw new RangeError('SP_CHAT_ENABLED must be on or off');
}
/** State belongs to the secret reconnect identity, never to a nickname or a room. */
export function moderateChat(session, text, now) {
  if (session.chatMutedUntil > now) return { error: ERR.CHAT_MUTED };
  if (typeof text !== 'string' || !text.trim() || [...text].length > 30 || /[\p{Cc}\p{Cs}]/u.test(text)) return { error: ERR.BAD_MSG };
  if (now - session.chatLastSentAt < CHAT_COOLDOWN_MS) return { error: ERR.RATE };
  if (session.chatMutedUntil) { session.chatMutedUntil = 0; session.chatStrikes = 0; }
  const result = maskSensitiveText(text.trim());
  session.chatLastSentAt = now;
  session.chatStrikes = result.hit ? session.chatStrikes + 1 : 0;
  if (session.chatStrikes >= 5) {
    session.chatMutedUntil = now + CHAT_MUTE_MS;
    session.chatStrikes = 0;
  }
  return { text: result.text, hit: result.hit };
}
