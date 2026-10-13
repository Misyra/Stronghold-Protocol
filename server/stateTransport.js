// Adapted from xinhai-ai/Stronghold-Protocol commit 2abc60f0 (GPL-3.0-or-later).
// Connection-local baselines. Snapshot and diff encoding are shared only for the SAME message/baseline objects,
// never across players' private views. Weak maps release disconnected sockets and superseded snapshots.
//
// perf/state-sync (priority 1) notes, measured with tools/state-sync-micro.mjs:
//   * The "对象 → JSON → 解析回对象 → 差分 → JSON" round trip is real in shape but NOT one per socket: a snapshot's
//     parsed form is memoized (`snapshot.parsed`), so each state frame is parsed exactly ONCE for the whole process,
//     not once per recipient and not twice per transition — `stateDeltaStats.parsedBaselines` counts it. Measured at
//     ~14 µs per frame against a ~49 µs diff segment (parse + diff + patch stringify) and ~165 µs for the whole
//     per-action chain, i.e. ~8 %. Keeping the live view object instead of the parse would buy that 8 % and cost the
//     transport its "a mutable source view can never corrupt the baseline" guarantee (test/state-delta.test.js) —
//     the match does mutate objects a view borrows (waves.js rewrites `factions.schedule` at round start). Declined.
//   * What is NOT needed and was removed: the full frame text used to be built for every state frame (~4–5 KiB string
//     per delta frame too). It is now built lazily, and its byte length is derived arithmetically.
//   * SP_STATE_DELTA_VERIFY=1 replays every emitted delta through the client's own decoder path and compares the
//     result with the server's current state. It is the invariant "差分基线必须跟实际发送一致" as a runtime check;
//     a mismatch counts in stateDeltaStats and is reported, never silently repaired.
import { applyStatePatch, diffState, isStateKind, STATE_DELTA_VERSION } from '../shared/stateDelta.js';

const connections = new WeakMap();
const snapshots = new WeakMap();
let sequence = 0;
/** Read per transition (not at module load) so a test or a canary can switch it on in-process. */
const verifyEnabled = () => process.env.SP_STATE_DELTA_VERIFY === '1';

/** Delta-transport counters since process start (diagnostics, tests and the benchmarks). */
export const stateDeltaStats = { frames: 0, fullFrames: 0, deltaFrames: 0, parsedBaselines: 0, verifyMismatches: 0, verifyChecked: 0 };

export function negotiateStateDelta(ws, version) {
  const enabled = version === STATE_DELTA_VERSION;
  const old = connections.get(ws);
  if (enabled && old) return; // repeated hello is coalesced by the lobby; do not invalidate queued deltas early
  if (enabled) connections.set(ws, new Map());
  else connections.delete(ws);
}

export function resetStateDelta(ws) { connections.get(ws)?.clear(); }

/** Reserve a shared state's sequence in enqueue order; parse/diff work stays in the send slice. */
export function reserveStateFrame(msg, encoded) {
  if (isStateKind(msg?.t)) snapshotFor(msg, encoded);
}

const fullHeader = (kind, seq) => `{"t":"m.state","kind":${JSON.stringify(kind)},"seq":${seq},"full":`;

function snapshotFor(msg, encoded) {
  let snapshot = snapshots.get(msg);
  if (!snapshot || snapshot.encoded !== encoded) {
    const seq = ++sequence;
    snapshot = {
      encoded, kind: msg.t, seq, parsed: undefined, transitions: new WeakMap(),
      full: undefined, fullBytes: undefined,
      // A full frame is header + encoded + '}'. All three parts are known without building the string, and the header
      // is pure ASCII (bytes === length), so a frame that sends a delta never allocates its own copy of the state.
      headerBytes: fullHeader(msg.t, seq).length,
    };
    snapshots.set(msg, snapshot);
  }
  return snapshot;
}

/** The full frame text, built only when a full frame is actually sent. */
function snapshotFull(snapshot) {
  return (snapshot.full ??= `${fullHeader(snapshot.kind, snapshot.seq)}${snapshot.encoded}}`);
}

/** Diff input of a snapshot: the parse of its encoding, memoized so a frame is parsed once for every recipient. */
function snapshotView(snapshot) {
  if (snapshot.parsed === undefined) { snapshot.parsed = JSON.parse(snapshot.encoded); stateDeltaStats.parsedBaselines++; }
  return snapshot.parsed;
}

/** Key-order-insensitive JSON text: the wire forms differ in key order (m.public splices serverNow to the front). */
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
    ? { data: delta, bytes: deltaBytes, delta: true }
    : { data: snapshotFull(snapshot), bytes: fullBytes, delta: false };
  snapshot.transitions.set(previous, transition);
  return transition;
}

/** Return an encoded state and commit its baseline ONLY after the caller successfully queues the reliable frame. */
export function prepareStateFrame(ws, msg, encoded, bytes = Buffer.byteLength(encoded)) {
  const states = connections.get(ws);
  if (!states || !isStateKind(msg?.t)) return { data: encoded, bytes, commit() {} };
  // The encoding, not mutable game objects, owns this immutable baseline.
  const snapshot = snapshotFor(msg, encoded);
  const previous = states.get(msg.t);
  let data, wireBytes;
  if (previous && previous !== snapshot && snapshot.seq > previous.seq) {
    const transition = transitionFor(snapshot, previous);
    data = transition.data;
    wireBytes = transition.bytes;
    if (transition.delta) stateDeltaStats.deltaFrames++; else stateDeltaStats.fullFrames++;
  } else {
    data = snapshotFull(snapshot);
    wireBytes = snapshot.fullBytes ??= snapshot.headerBytes + bytes + 1;
    stateDeltaStats.fullFrames++;
  }
  stateDeltaStats.frames++;
  return { data, bytes: wireBytes, commit() { states.set(msg.t, snapshot); } };
}
