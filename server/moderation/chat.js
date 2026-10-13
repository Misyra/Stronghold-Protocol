// i18n-ignore-file: server-only moderation policy, no UI strings.
import { CHAT_FORBIDDEN_RE } from './characters.js';
import { hasSensitiveText } from './nickname.js';
import { ERR } from '../../shared/constants.js';
import { CHAT_MUTE_LADDER, activeChatStrikes } from './chatState.js';
export { CHAT_MUTE_LADDER, CHAT_MUTE_MAX_MS, CHAT_WINDOW_MS } from './chatState.js';
const CHAT_COOLDOWN_MS = 1000;
export function chatEnabled(value = process.env.SP_CHAT_ENABLED) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['', '0', 'false', 'off'].includes(v)) return false;
  if (['1', 'true', 'on'].includes(v)) return true;
  throw new RangeError('SP_CHAT_ENABLED must be on or off');
}
/** State belongs to the secret reconnect identity, never to a nickname or a room. */
export function moderateChat(session, text, now) {
  if (session.chatMutedUntil > now) return { error: ERR.CHAT_MUTED };
  if (typeof text !== 'string' || !text.trim() || [...text].length > 30 || CHAT_FORBIDDEN_RE.test(text)) return { error: ERR.BAD_MSG };
  if (now - session.chatLastSentAt < CHAT_COOLDOWN_MS) return { error: ERR.RATE };
  session.chatLastSentAt = now;
  if (!hasSensitiveText(text.trim())) return { text: text.trim() };
  // A flagged message is never broadcast: the refusal climbs the ban ladder. The expired mute timestamp is
  // kept on purpose — the state stays hot for one hour after the last violation or the served mute,
  // whichever is later, so the ladder can only be climbed by re-offending after serving each run.
  session.chatStrikes = activeChatStrikes(session.chatStrikes, session.chatLastHitAt, now, session.chatMutedUntil) + 1;
  session.chatLastHitAt = now;
  const mute = CHAT_MUTE_LADDER[Math.min(session.chatStrikes, CHAT_MUTE_LADDER.length) - 1];
  if (mute > 0) session.chatMutedUntil = now + mute;
  return { error: ERR.CHAT_BLOCKED };
}
