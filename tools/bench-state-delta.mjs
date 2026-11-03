// tools/bench-state-delta.mjs — the state-delta transport measured on real m.public views.
//
// Two questions, both answered on the production code path:
//   1. bytes: what do the delta frames cost against sending the same public views whole?
//   2. cpu: what does the current transport (one parse per snapshot, lazily built full frame, one shared transition per
//      broadcast) cost per frame against the previous revision (a per-connection sequence, a full frame string built
//      and byte-counted for every frame, a patch cache per connection)?
//
// Usage:
//   node tools/bench-state-delta.mjs [--views 60] [--connections 4] [--rounds 15] [--seed 11] [--json]
//
// The views are captured from a real co-op match (prep/combat pipeline, the same shape a room broadcasts). The A/B
// runs the same captured bytes through both revisions with a fresh snapshot key per round, so neither side gets a
// warm cache the other does not.

import { performance } from 'node:perf_hooks';
import { diffState } from '../shared/stateDelta.js';
import { negotiateStateDelta, prepareStateFrame, stateDeltaStats } from '../server/stateTransport.js';
import { makeMatch } from '../test/match/harness.js';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const viewsWanted = Number(arg('views', 60));
const connections = Number(arg('connections', 4));
const rounds = Number(arg('rounds', 15));
const seed = Number(arg('seed', 11));
for (const [name, value] of [['views', viewsWanted], ['connections', connections], ['rounds', rounds]]) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid --${name}`);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Every m.public view a real co-op match broadcasts, stopping once there are enough to measure. */
function capturePublicViews() {
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', seed,
    seats: [
      { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true },
      { seat: 1, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true },
      { seat: 2, playerId: 'ai_1', name: 'AI1', isBot: true, connected: true },
    ],
    hostId: 'p_0',
  }).start();
  const views = [];
  h.onBroadcast.push((msg) => { if (msg.t === 'm.public' && views.length < viewsWanted) views.push(msg); });
  h.drive(() => views.length >= viewsWanted || h.ended != null, { maxSteps: 4e6 });
  const encoded = views.map((view) => JSON.stringify(view));
  h.m.dispose();
  return encoded;
}

/**
 * The transport revision before this port, kept here only as the A/B baseline: a sequence per connection, the full
 * frame text built and UTF-8 counted on every frame, a patch cached per connection.
 */
function legacyTransport() {
  const connections = new WeakMap();
  const snapshots = new WeakMap();
  function negotiate(ws) { connections.set(ws, { seq: 0, kinds: new Map() }); }
  function prepare(ws, msg, encoded) {
    const connection = connections.get(ws);
    if (!connection || msg?.t !== 'm.public') return { data: encoded, commit() {} };
    let snapshot = snapshots.get(msg);
    if (!snapshot || snapshot.encoded !== encoded) {
      let view;
      try { view = JSON.parse(encoded); } catch { view = null; }
      if (view === null || typeof view !== 'object' || Array.isArray(view)) return { data: encoded, commit() {} };
      snapshot = { encoded, view, patches: new WeakMap() };
      snapshots.set(msg, snapshot);
    }
    const previous = connection.kinds.get(msg.t);
    const seq = ++connection.seq;
    const head = `{"t":"m.state","kind":${JSON.stringify(msg.t)},"seq":${seq},`;
    const full = `${head}"full":${encoded}}`; // eager: the whole view, per connection, per frame
    if (previous && previous.snapshot !== snapshot) {
      let patch = snapshot.patches.get(previous.snapshot);
      if (patch === undefined) {
        const ops = diffState(previous.snapshot.view, snapshot.view);
        patch = ops ? JSON.stringify(ops) : false;
        snapshot.patches.set(previous.snapshot, patch);
      }
      if (patch) {
        const delta = `${head}"base":${previous.seq},"patch":${patch}}`;
        if (Buffer.byteLength(delta) < Buffer.byteLength(full)) {
          return { data: delta, commit() { connection.kinds.set(msg.t, { snapshot, seq }); } };
        }
      }
    }
    return { data: full, commit() { connection.kinds.set(msg.t, { snapshot, seq }); } };
  }
  return { negotiate, prepare };
}

/** Run every captured view through `connections` sockets of one transport; returns bytes and a frame count. */
function runTransport(prepare, negotiate, encodedViews) {
  const sockets = Array.from({ length: connections }, () => ({}));
  for (const ws of sockets) negotiate(ws);
  let bytes = 0, frames = 0;
  for (const encoded of encodedViews) {
    // A fresh key per view per round: snapshots are keyed by the message object, so this is a cold snapshot each time.
    const key = { t: 'm.public' };
    for (const ws of sockets) {
      const frame = prepare(ws, key, encoded);
      bytes += Buffer.byteLength(frame.data);
      frames++;
      frame.commit();
    }
  }
  return { bytes, frames };
}

const encodedViews = capturePublicViews();
if (encodedViews.length < 10) throw new Error(`the match broadcast too few views (${encodedViews.length})`);

// ---- bytes: whole views vs the frames the transport emits -------------------------------------------------------
const legacy = legacyTransport();
const legacyRun = runTransport(legacy.prepare, legacy.negotiate, encodedViews);
const currentRun = runTransport(prepareStateFrame, (ws) => negotiateStateDelta(ws, 1), encodedViews);
const wholeBytes = encodedViews.reduce((n, encoded) => n + Buffer.byteLength(encoded), 0) * connections;
let patched = 0;
{
  const sockets = Array.from({ length: connections }, () => ({}));
  for (const ws of sockets) negotiateStateDelta(ws, 1);
  for (const encoded of encodedViews) {
    const key = { t: 'm.public' };
    for (const ws of sockets) {
      const frame = prepareStateFrame(ws, key, encoded);
      if (frame.data.includes('"patch":')) patched++;
      frame.commit();
    }
  }
}

// ---- cpu: the same chain, cold snapshots, repeated -------------------------------------------------------------
function timeTransport(prepare, negotiate) {
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    globalThis.gc?.();
    const start = performance.now();
    runTransport(prepare, negotiate, encodedViews);
    samples.push(((performance.now() - start) * 1000) / (encodedViews.length * connections)); // µs per frame
  }
  return median(samples);
}

const legacyUs = timeTransport(legacy.prepare, legacy.negotiate);
const statsBefore = { ...stateDeltaStats };
const currentUs = timeTransport(prepareStateFrame, (ws) => negotiateStateDelta(ws, 1));
const statsAfter = { ...stateDeltaStats };

const result = {
  node: process.version, platform: process.platform, seed,
  views: encodedViews.length, connections, rounds,
  wholeBytes, legacyBytes: legacyRun.bytes, currentBytes: currentRun.bytes,
  savedBytes: wholeBytes - currentRun.bytes,
  ratio: currentRun.bytes / wholeBytes,
  patchedFrames: patched, frames: currentRun.frames,
  bytesIdentical: legacyRun.bytes === currentRun.bytes,
  legacyUsPerFrame: legacyUs, currentUsPerFrame: currentUs,
  cpuReductionPct: 100 * (1 - currentUs / legacyUs),
  parsedBaselinesThisRun: statsAfter.parsedBaselines - statsBefore.parsedBaselines,
  deltaFramesThisRun: statsAfter.deltaFrames - statsBefore.deltaFrames,
  fullFramesThisRun: statsAfter.fullFrames - statsBefore.fullFrames,
};

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`state-sync transport — ${result.views} real m.public views × ${connections} sockets ` +
    `(${result.frames} frames, seed ${seed})`);
  console.log('');
  console.log('bytes');
  console.log(`  ${pad('', 22)}${pad('bytes', 12)}${pad('bytes/frame', 14)}${pad('saved', 14)}`);
  console.log(`  ${pad('whole views', 22)}${pad(wholeBytes, 12)}${pad((wholeBytes / result.frames).toFixed(0), 14)}-`);
  console.log(`  ${pad('delta frames', 22)}${pad(currentRun.bytes, 12)}${pad((currentRun.bytes / result.frames).toFixed(0), 14)}` +
    `${(100 * (1 - result.ratio)).toFixed(1)}%`);
  console.log(`  patched ${patched}/${result.frames} frames; legacy and current bytes identical: ${result.bytesIdentical}`);
  console.log('');
  console.log('cpu (median per frame, cold snapshot per view)');
  console.log(`  ${pad('', 22)}${pad('µs/frame', 12)}${pad('frames/s', 12)}`);
  console.log(`  ${pad('legacy (eager full)', 22)}${pad(legacyUs.toFixed(3), 12)}${pad(Math.round(1e6 / legacyUs), 12)}`);
  console.log(`  ${pad('current (lazy full)', 22)}${pad(currentUs.toFixed(3), 12)}${pad(Math.round(1e6 / currentUs), 12)}`);
  console.log(`  ${currentUs <= legacyUs ? 'saved' : 'cost'} ${Math.abs(result.cpuReductionPct).toFixed(1)}% CPU per frame`);
  console.log('');
  console.log(`  this run: parsedBaselines=${result.parsedBaselinesThisRun} deltaFrames=${result.deltaFramesThisRun} ` +
    `fullFrames=${result.fullFramesThisRun}`);
  console.log('  scope: one process, in-memory frames; not WebSocket writes, compression or client decode');
}
