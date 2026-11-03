// Parent-side validation, independent of the child API. [ASSUMED] Limits allow full battle event batches.
// A match payload crosses the IPC in one of two shapes: the view object (every frame but the two state lanes) or —
// for m.public / m.private, whose one-stringify-two-uses bytes MatchMessaging already produced
// (server/match/match/messaging.js) — the pre-encoded string alone (entry.js posts `encoded` and drops the view
// object, so the child never clones it and the parent never stringifies it again). The string is checked at the
// same strength as the object: type, both length caps, no view mixed in; and at the consumer (proxy.js) it is
// parsed once — a JSON.parse of a capped string is exactly as bounded as the object path's traversal (no cycles,
// no accessors, finite numbers), so the parsed frame carries nothing the object path could not.
import { S2C } from '../../../shared/protocol.js';

export const HOST_IPC_LIMITS = Object.freeze({ message: 16 * 1024 * 1024, reply: 1024 * 1024, log: 4000, error: 300, depth: 64, nodes: 500000 });
const object = v => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const str = (v, n) => typeof v === 'string' && v.length <= n && Buffer.byteLength(v) <= n;
const matchFrames = new Set(S2C.filter(t => t.startsWith('m.') || t.startsWith('b.')));

/** Bound traversal before serializing; reject cycles/non-JSON values and never invoke accessors. */
export function boundedJson(value, limit) {
  let bytes = 0, nodes = 0;
  const active = new Set();
  function visit(v, depth) {
    if (++nodes > HOST_IPC_LIMITS.nodes || depth > HOST_IPC_LIMITS.depth || bytes > limit) return false;
    if (typeof v === 'string') { if (v.length > limit) return false; bytes += Buffer.byteLength(v) + 2; }
    else if (v == null || typeof v === 'boolean') bytes += 5;
    else if (typeof v === 'number') { if (!Number.isFinite(v)) return false; bytes += String(v).length; }
    else if (typeof v === 'object' && (Array.isArray(v) || object(v))) {
      if (active.has(v)) return false;
      active.add(v); bytes += 2;
      for (const key of Object.keys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d || !Object.hasOwn(d, 'value') || !str(key, limit)) return false;
        bytes += Buffer.byteLength(key) + 4;
        if (!visit(d.value, depth + 1)) return false;
      }
      active.delete(v);
    } else return false;
    return bytes <= limit;
  }
  try { return visit(value, 0) && Buffer.byteLength(JSON.stringify(value) ?? '') <= limit; } catch { return false; }
}

/**
 * A pre-encoded match payload: the string alone, no view object beside it, within the message caps. A non-string
 * `encoded` fails closed (the message is malformed, the object branch is refused too).
 * @param {object} m @returns {boolean}
 */
export function isEncodedFrame(m) {
  return typeof m.encoded === 'string' && !('msg' in m)
    && m.encoded.length <= HOST_IPC_LIMITS.message && Buffer.byteLength(m.encoded) <= HOST_IPC_LIMITS.message;
}

/**
 * The message of a pre-encoded frame, parsed and checked at its one consumer (proxy.js deliver). Anything but a
 * plain object carrying a match frame type is null — the same test the object path puts `m.msg` through.
 * @param {string} encoded @returns {object | null}
 */
export function encodedFrameMessage(encoded) {
  let msg;
  try { msg = JSON.parse(encoded); } catch { return null; }
  return msg != null && typeof msg === 'object' && !Array.isArray(msg) && matchFrames.has(msg.t) ? msg : null;
}

export function validHostMessage(m) {
  if (!object(m)) return false;
  if (m.type === 'hb' || m.type === 'ready') return Object.keys(m).length === 1;
  if (m.type === 'log') return ['info','warn','error','debug'].includes(m.level) && str(m.text, HOST_IPC_LIMITS.log)
    && boundedJson(m, HOST_IPC_LIMITS.log + 128);
  if (m.type === 'boot-error') return str(m.error, HOST_IPC_LIMITS.error) && boundedJson(m, HOST_IPC_LIMITS.error + 128);
  if (!str(m.matchId, 160) || !m.matchId) return false;
  // a match payload rides as the view object (checked like any child object) or as the pre-encoded string alone
  const payload = isEncodedFrame(m)
    || (m.encoded === undefined && object(m.msg) && matchFrames.has(m.msg.t) && boundedJson(m, HOST_IPC_LIMITS.message));
  switch (m.type) {
    case 'send':
      if (!str(m.playerId, 128) || !m.playerId) return false;
      // falls through to the shared match-frame validation below
      return payload;
    case 'broadcast': return payload;
    case 'reply': return Number.isSafeInteger(m.id) && m.id > 0 && object(m.result)
      && (m.result.error === undefined || str(m.result.error, 80))
      && (m.result.ok === undefined || typeof m.result.ok === 'boolean') && boundedJson(m, HOST_IPC_LIMITS.reply);
    case 'end': return (m.summary == null || object(m.summary)) && boundedJson(m, HOST_IPC_LIMITS.reply);
    // 挂机移出 (移植自用户分支): the match removed a human (opts.onRemove) — the lobby detaches the seat
    case 'remove': return str(m.playerId, 128) && !!m.playerId && object(m.removal)
      && str(m.removal.reason, 40) && Number.isSafeInteger(m.removal.rounds) && boundedJson(m, HOST_IPC_LIMITS.reply);
    case 'failed': return str(m.error, HOST_IPC_LIMITS.error) && boundedJson(m, HOST_IPC_LIMITS.error + 512);
    default: return false;
  }
}
