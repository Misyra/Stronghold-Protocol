// Connection-local baselines. Snapshot and diff encoding are shared only for the SAME message/baseline objects,
// never across players' private views. Weak maps release disconnected sockets and superseded snapshots.
//
// A snapshot's sequence number comes from one process-global counter, assigned the first time its encoding is seen:
// every connection handed that snapshot sends the same number, so one broadcast costs one number, not one per
// recipient. A connection's baseline is still its own, and every frame it is handed is strictly newer than the
// baseline it replaces — content that is already its baseline is re-sent full under a fresh number.
//
// perf/state-sync notes, measured with tools/bench-state-delta.mjs:
//   * The "对象 → JSON → 解析回对象 → 差分 → JSON" round trip is real in shape but NOT one per socket: a snapshot's
//     parsed form is memoized (`snapshot.parsed`), so each state frame is parsed exactly ONCE for the whole process,
//     not once per recipient and not twice per transition — `stateDeltaStats.parsedBaselines` counts it.
//   * A transition is cached on the NEW snapshot, keyed by the baseline it was computed from, and shared by every
//     socket holding that baseline.
//   * The full frame text is built only when a full frame is actually sent; its byte length is derived arithmetically
//     from the header, the encoded view and the closing brace.
//   * SP_STATE_DELTA_VERIFY=1 replays every emitted delta through the client's own decoder path and compares the
//     result with the state it describes. A mismatch counts in stateDeltaStats and is reported, never silently
//     repaired.
import { applyStatePatch, diffState, isStateKind, STATE_DELTA_VERSION } from '../shared/stateDelta.js';

/**
 * The channels this build compresses. Both state views ride the delta transport: m.public is the shared room frame,
 * m.private is per player, and the receiver keeps a separate baseline per kind (shared/stateDelta.js), so a private
 * patch can never be applied against a public view. The whole-match replay in test/state-delta.test.js (with
 * SP_STATE_DELTA_VERIFY) checks every delta of both channels against the state it describes before emit.
 */
export const DELTA_KINDS = new Set(['m.public', 'm.private']);

const connections = new WeakMap();   // ws -> { roomCode, kinds: Map<kind, snapshot> }
const snapshots = new WeakMap();     // msg -> snapshot { encoded, kind, seq, parsed, transitions, full, fullBytes, headerBytes }
let sequence = 0;                    // process-global snapshot sequence

/** Read per transition (not at module load) so a test or a canary can switch it on in-process. */
const verifyEnabled = () => process.env.SP_STATE_DELTA_VERIFY === '1';

/** Delta-transport counters since process start (diagnostics, tests and the benchmarks). */
export const stateDeltaStats = {
  frames: 0, fullFrames: 0, deltaFrames: 0, parsedBaselines: 0, verifyMismatches: 0, verifyChecked: 0,
};

/** The frame prefix shared by a full frame and a patch, `…"kind":"m.public","seq":<n>,`. */
const fullHeader = (kind, seq) => `{"t":"m.state","kind":${JSON.stringify(kind)},"seq":${seq},"full":`;

/** The full frame text, built only when a full frame is actually sent. */
const snapshotFull = (snapshot) => (snapshot.full ??= `${fullHeader(snapshot.kind, snapshot.seq)}${snapshot.encoded}}`);

/** Diff input of a snapshot: the parse memoized at creation, shared by every recipient and transition. */
const snapshotView = (snapshot) => snapshot.parsed;

export function negotiateStateDelta(ws, version) {
  const enabled = version === STATE_DELTA_VERSION;
  const old = connections.get(ws);
  // A repeated hello keeps the baseline it already has: dropping it would turn the next frame into a full one for no
  // reason, and the client would have to decode a full frame it did not need.
  if (enabled) { if (!old) connections.set(ws, { roomCode: null, kinds: new Map() }); return; }
  connections.delete(ws);
}

/** The already negotiated capability, for an internal identity handover on the same socket. */
export function stateDeltaVersion(ws) { return connections.has(ws) ? STATE_DELTA_VERSION : undefined; }

/** Forget the baselines (a new negotiation, or a client that asked for a full resync). The sequence never rewinds. */
export function resetStateDelta(ws) { connections.get(ws)?.kinds.clear(); }

/** Keep negotiation and sequence, but never carry a previous room's state into a new room. */
export function setStateDeltaRoom(ws, roomCode) {
  const connection = connections.get(ws);
  if (!connection || connection.roomCode === roomCode) return;
  connection.roomCode = roomCode;
  connection.kinds.clear();
}

/**
 * Create the snapshot an encoding owns. The parse happens here, once, and is what makes the encoding — not the
 * mutable game object behind it — the baseline: an upstream view may borrow a live array and change afterwards.
 */
function snapshotFor(msg, encoded, parsed) {
  const seq = ++sequence;
  const snapshot = {
    encoded, kind: msg.t, seq, parsed, transitions: new WeakMap(),
    full: undefined, fullBytes: undefined,
    // header + encoded + '}'. The header is pure ASCII (the two state kinds and a decimal number), so `.length` is bytes.
    headerBytes: fullHeader(msg.t, seq).length,
  };
  snapshots.set(msg, snapshot);
  stateDeltaStats.parsedBaselines++;
  return snapshot;
}

/** The bytes are already this connection's baseline (or older): re-send them full under a fresh number. */
function forkSnapshot(snapshot) {
  const seq = ++sequence;
  return {
    ...snapshot, seq, transitions: new WeakMap(), full: undefined, fullBytes: undefined,
    headerBytes: fullHeader(snapshot.kind, seq).length,
  };
}

/** Key-order-insensitive JSON text: the wire forms can differ in key order (publicView splices serverNow to the front). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Verification mode: apply the delta the client would receive (decoded from the actual wire text) to the baseline the
 * client holds and compare it with the state this frame describes. Returns true when the two agree.
 */
function verifyTransition(previous, snapshot, delta) {
  stateDeltaStats.verifyChecked++;
  try {
    const wire = JSON.parse(delta);
    if (!Array.isArray(wire.patch)) return false;
    const replayed = applyStatePatch(snapshotView(previous), wire.patch);
    return canonicalJson(replayed) === canonicalJson(snapshotView(snapshot));
  } catch { return false; }
}

/** The transition (shared by every socket holding this baseline) from one snapshot to another. */
function transitionFor(snapshot, previous) {
  let transition = snapshot.transitions.get(previous);
  if (transition !== undefined) return transition;
  const patch = diffState(snapshotView(previous), snapshotView(snapshot));
  const delta = patch && JSON.stringify({ t: 'm.state', kind: snapshot.kind, seq: snapshot.seq, base: previous.seq, patch });
  const usable = delta && (!verifyEnabled() || verifyTransition(previous, snapshot, delta));
  if (delta && !usable) stateDeltaStats.verifyMismatches++;
  // Compare actual UTF-8 bytes, not JS string length. Large changes fall back to full.
  const deltaBytes = usable && Buffer.byteLength(delta);
  const fullBytes = snapshot.fullBytes ??= snapshot.headerBytes + Buffer.byteLength(snapshot.encoded) + 1;
  transition = usable && deltaBytes < fullBytes
    ? { data: delta, delta: true }
    : { data: snapshotFull(snapshot), delta: false };
  snapshot.transitions.set(previous, transition);
  return transition;
}

/** Return an encoded state and commit its baseline ONLY after the caller successfully queues the reliable frame.
 * `usable: false` means the given bytes cannot be a baseline (they are not a JSON object) and the caller should send a
 * full frame it encoded itself; this connection keeps the baseline it already had. */
export function prepareStateFrame(ws, msg, encoded) {
  const connection = connections.get(ws);
  if (!connection || !isStateKind(msg?.t) || !DELTA_KINDS.has(msg.t)) {
    return { data: encoded, commit() {}, usable: true };
  }
  let snapshot = snapshots.get(msg);
  if (snapshot && snapshot.encoded !== encoded) snapshot = undefined;
  // Bytes a caller pre-encoded can be anything: never throw out of the send path because of them.
  if (!snapshot) {
    let view;
    try { view = JSON.parse(encoded); } catch { view = null; }
    if (view === null || typeof view !== 'object' || Array.isArray(view)) {
      return { data: encoded, commit() {}, usable: false };
    }
    snapshot = snapshotFor(msg, encoded, view);
  }
  const previous = connection.kinds.get(msg.t);
  let data, delta = false;
  if (previous && previous !== snapshot && snapshot.seq > previous.seq) {
    // The patch is content-only, so the transition is shared between connections; the number is the snapshot's own.
    const transition = transitionFor(snapshot, previous);
    data = transition.data;
    delta = transition.delta;
  } else if (!previous) {
    data = snapshotFull(snapshot);
  } else {
    // The bytes are already this connection's baseline, or they belong to an older snapshot than the one it holds.
    // Reusing that number would not advance the receiver's baseline, so hand out a full frame under a fresh one.
    snapshot = forkSnapshot(snapshot);
    data = snapshotFull(snapshot);
  }
  stateDeltaStats.frames++;
  if (delta) stateDeltaStats.deltaFrames++; else stateDeltaStats.fullFrames++;
  return { data, commit() { connection.kinds.set(msg.t, snapshot); }, usable: true };
}
