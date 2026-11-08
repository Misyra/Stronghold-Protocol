// 点赞 on the settlement's 同盟 page (the owner's request of 2026-11-05; screens/settle.js TeamPage): back in the room after a
// match, each human player of it may like each other one once (C2S room.like {playerId}). The room hears room.likes
// { match, counts, from?, to?, mine? } (server/lobby.js Lobby.like): the counts of that match on every like, and after
// a result replay a player's own copy with `mine` (whom it liked). Shown on that one settlement only: nothing is stored —
// store.match.likes goes with the match (emptyMatch) and a new m.result starts again from none.

import { t } from '../../../shared/i18n.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;

/**
 * store.match.likes after one room.likes: `{ match, counts: { [playerId]: n }, mine: [playerId] }`, or `prev` for a frame
 * that is not one. `mine` is the frame's own list when it has one (the resync), else the earlier one of the same match
 * plus `to` when the like was my own.
 * @param {{ match: number, counts: Record<string, number>, mine: string[] } | null | undefined} prev
 * @param {any} msg @param {string | null | undefined} myId
 */
export function applyLikes(prev, msg, myId) {
  if (!isObj(msg) || !Number.isSafeInteger(msg.match) || !isObj(msg.counts)) return prev ?? null;
  const counts = {};
  for (const [id, n] of Object.entries(msg.counts)) if (isId(id) && Number.isSafeInteger(n) && n > 0) counts[id] = n;
  const same = !!prev && prev.match === msg.match;
  const mine = new Set(Array.isArray(msg.mine) ? msg.mine.filter(isId) : same ? prev.mine : []);
  if (myId && msg.from === myId && isId(msg.to)) mine.add(msg.to);
  return { match: msg.match, counts, mine: [...mine] };
}

/**
 * Who liked: the name the settlement shows for that player (m.result), else its room seat or spectator seat — the
 * player may have left the page already — else 博士.
 * @param {any} state the store state @param {string} playerId
 */
export function likerName(state, playerId) {
  const rows = Array.isArray(state?.match?.result?.players) ? state.match.result.players : [];
  const seats = Array.isArray(state?.room?.seats) ? state.room.seats : [];
  const spectators = Array.isArray(state?.room?.spectators) ? state.room.spectators : [];
  const hit = [...rows, ...seats, ...spectators].find((p) => isObj(p) && p.playerId === playerId && typeof p.name === 'string' && p.name);
  return hit ? hit.name : t('博士');
}

/**
 * The toast of a like I got — null when the frame is no like to me (a resync, somebody else's, my own).
 * @param {any} state @param {any} msg @returns {string | null}
 */
export function likedToast(state, msg) {
  const myId = state?.me?.playerId;
  if (!myId || !isObj(msg) || msg.to !== myId || !isId(msg.from) || msg.from === myId) return null;
  return t('{name} 赞了你', { name: likerName(state, msg.from) });
}

/**
 * What a team card shows: the count it got, and whether I may like it (`can`), have (`liked`). I may like while I am a
 * human player of the settlement still in its room, the card is another human player's and that player did not leave.
 * @param {{ playerId: string, isBot?: boolean, left?: boolean }} card a normalizeResult row
 * @param {{ me: { isBot?: boolean, left?: boolean } | null, inRoom: boolean, off?: boolean,
 *   likes: { counts: Record<string, number>, mine: string[] } | null, extra?: Set<string> }} ctx
 * @returns {{ count: number, can: boolean, liked: boolean, self: boolean } | null} null for an AI card
 */
export function cardLike(card, { me, inRoom, off = false, likes, extra = new Set() }) {
  if (!card || card.isBot) return null;
  const count = Number.isSafeInteger(likes?.counts?.[card.playerId]) ? likes.counts[card.playerId] : 0;
  const self = !!me && me.playerId === card.playerId;
  const liked = (likes?.mine || []).includes(card.playerId) || extra.has(card.playerId);
  const can = !self && !off && inRoom && !!me && !me.isBot && !me.left && !card.left;
  return { count, can, liked, self };
}
