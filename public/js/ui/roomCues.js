// Waiting-room sounds (ported from the Stardust fork's ui/roomCues.js; feedback #10 / #14: 「希望有准备音效，进入房间音效」
// 「玩家加入和退出的音效」): the official 卫戍协议 UI banks the art manifest already maps (tools/assets/audio.mjs) —
// PLAYER_JOINROOM when I enter a room or another doctor takes a seat, DISCONNECT when one leaves (the official mode has
// no own "left" sound). Only between two room states of the same waiting room: nothing in a match, nothing for bots, for
// my own seat, for connected/ready flips, or for the first state after a welcome (a reconnect or a restored page re-sends
// the room as it is). 准备 stays with audio.js (the accepted g.infoReady edge); every cue passes `cueGate`.

/** The human players seated in a room state (bots and empty seats left out). */
export function seatedHumans(room) {
  const out = new Set();
  for (const s of Array.isArray(room?.seats) ? room.seats : []) {
    if (s && !s.isBot && typeof s.playerId === 'string') out.add(s.playerId);
  }
  return out;
}

/**
 * The cue for a room-state change: 'joinRoom' | 'disconnect' | null.
 * @param {any} prev the room before (null when I was in none)
 * @param {any} next the new room state
 * @param {string|null} myId
 * @param {{ quiet?: boolean }} [o] quiet: the first state after a welcome
 * @returns {'joinRoom'|'disconnect'|null}
 */
export function roomCue(prev, next, myId, { quiet = false } = {}) {
  if (quiet || !next || next.inMatch) return null;
  if (!prev || prev.code !== next.code) return seatedHumans(next).has(myId) ? 'joinRoom' : null;
  if (prev.inMatch) return null; // back from a match: the room is not newly joined
  const before = seatedHumans(prev), after = seatedHumans(next);
  before.delete(myId); after.delete(myId);
  for (const id of after) if (!before.has(id)) return 'joinRoom';
  for (const id of before) if (!after.has(id)) return 'disconnect';
  return null;
}

/**
 * Rate limit: a function answering true when `kind` may play now (one per kind per `gapMs`).
 * @param {number} [gapMs]
 * @returns {(kind: string, now?: number) => boolean}
 */
export function cueGate(gapMs = 1000) {
  const last = new Map();
  return (kind, now = Date.now()) => {
    if (now - (last.get(kind) ?? -Infinity) < gapMs) return false;
    last.set(kind, now);
    return true;
  };
}
