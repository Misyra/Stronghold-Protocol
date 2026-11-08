// test/match/battle-pool.test.js — SP_BATTLE_POOL (server/match/match/clientCombat.js): a server-run normal / 联防
// field hands its headless battle to the simulation pool's 'battle' task (server/workers/simulation.js) and mirrors
// its real return shape { result, timeline, time, errors, crashed }. Covered here: the anchor on a REAL pool (the
// worker's own result digest equals the local run's, byte for byte — the workers-room.test.js comparison, now through
// the real _runOnServer consumer), the whole-match trace equality switch on vs off, the timeline fed from the worker's
// progress messages, the errors passthrough into simErrorLog, the POOL_FULL / wrong-shape fallback to the local sliced
// path, and the cancel pairing (dispose cancels the in-flight task once and applies nothing).
// A pooled match runs on the harness's virtual scheduler with the pool's REAL promises: the instant clock arms no
// phase timers while a field waits, so the test pumps virtual bursts and yields real turns between them (worker
// threads compute concurrently, the consumer's promise callbacks run during the yield) — no fake pool answers a battle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PHASE } from '../../shared/constants.js';
import { createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { runHeadless, HeadlessJob } from '../../server/match/fields.js';
import { SimulationPool } from '../../server/workers/pool.js';
import { simWorkerData } from '../../server/data.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';

/** A fresh DataSource over the raw data, like the worker builds one (clientCombat.test.js proves parity with m.ds). */
const DS = new DataSource(DATA, null);

/** A REAL SimulationPool over the sim data subset, as the server builds one (size 2: the tests need little). */
function realPool(size = 2) {
  return new SimulationPool({ data: simWorkerData(DATA), size, maxQueue: 256, timeoutMs: 120000 });
}

/** Rounds the byte-comparison captures (both runs stop at the same point; the pooled loop's final burst must not
 * out-capture the synchronous one). */
const ROUND_CAP = 5;

/** Capture every finished pool-managed server-run field (normal / 联防; boss fields keep the pacer, not the pool):
 * its spec, the consumer's result digest and the field's release state. Runs per scheduler step — settle() clears
 * m.fields, so the window between a result landing and the phase end is the only place the fields still exist. */
function serverRuns(h, seen, bag) {
  for (const f of h.m.fields) {
    if (!f.cc || f.mode !== 'server' || f.kind === 'boss' || f.kind === 'hidden') continue;
    if (!f.result || f.result.synthetic || seen.has(f.spec.battleId) || f.spec.round > ROUND_CAP) continue;
    seen.add(f.spec.battleId);
    bag.push({ battleId: f.spec.battleId, spec: JSON.parse(JSON.stringify(f.spec)), players: f.players.slice(),
      digest: resultDigest(f.result).hash, endGt: f.endGt, source: f.resultSource, battle: !!f.battle });
  }
}

/** A per-step predicate: the burst loop's phase transitions chain inside one h.run call (a virtual prep ends in the
 * same burst it starts), so the settle trace and the finished-field capture must run at every scheduler step. */
function stepper(h, { onSettle = null, runs = null, seen = null } = {}) {
  let last = '';
  return () => {
    if (runs) serverRuns(h, seen, runs);
    const key = `${h.m.phase}:${h.m.round}`;
    if (key === last) return false;
    last = key;
    if (h.m.phase === PHASE.SETTLE && onSettle) onSettle();
    return false;
  };
}

/** Local digest of a captured spec, the comparison the byte-for-byte property is stated against. */
function localDigest(r) {
  const local = runHeadless(createBattleFromSpec(JSON.parse(JSON.stringify(r.spec)), DS, { recordEvents: false, quiet: true }), { players: r.players }).result;
  return resultDigest(local).hash;
}

test('a server-run field\'s battle from the real pool matches the local run byte for byte', async (t) => {
  const pool = realPool(2);
  t.after(() => pool.close());
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 9331, captureFrames: false, clientCombat: true, battlePool: true, simPool: pool });
  h.autoHumans();
  const seen = new Set(), runs = [];
  const step = stepper(h, { runs, seen });
  h.m.start();
  let i = 0;
  while (!h.ended && h.m.round < 6 && i++ < 40000) {
    h.run(step, { maxSteps: 2000 });
    await delay(2);
  }
  serverRuns(h, seen, runs);
  assert.ok(h.m.round >= 6, `round 6 reached (${h.m.phase} R${h.m.round})`);
  assert.ok(runs.length >= 3, `server-run fields seen (${runs.length})`);
  assert.ok(pool.stats().completed >= runs.length, `the pool ran the battles (${pool.stats().completed})`);
  for (const r of runs) {
    assert.equal(r.source, 'server');
    assert.equal(r.battle, false, `${r.battleId}: a pool-run field holds no battle object`);
    assert.equal(Number.isFinite(r.endGt), true, `${r.battleId}: endGt is the battle's own time`);
    assert.equal(r.digest, localDigest(r), `${r.battleId}: pool result equals the local run`);
  }
  assert.equal(h.m.errorCount, 0, h.m.errors.slice(0, 2).map((e) => `${e.label}: ${e.message}`).join('\n'));
  checkInvariants(h.m);
  h.m.dispose();
});

test('the switch reproduces the local match round for round (real pool, same seed)', async (t) => {
  const pool = realPool(2);
  t.after(() => pool.close());
  const runMatch = async (pooled) => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 9332, captureFrames: false, clientCombat: true,
      ...(pooled ? { battlePool: true, simPool: pool } : { battlePool: false }) });
    h.autoHumans();
    const seen = new Set(), runs = [], trace = [];
    const settle = () => trace.push(`SETTLE:${h.m.round} ${h.m.order.map((p) => `${p.lp}/${p.funds}+${p.pendingFunds}/${JSON.stringify(p.layers)}`).join(' ')}`);
    const step = stepper(h, { onSettle: settle, runs, seen });
    if (pooled) {
      h.m.start();
      let i = 0;
      while (!h.ended && h.m.round < 6 && i++ < 40000) {
        h.run(step, { maxSteps: 2000 });
        await delay(2);
      }
      serverRuns(h, seen, runs);
    } else {
      h.m.start();
      h.run(() => { step(); return h.ended != null || h.m.round >= 6; }, { maxSteps: 5e6 });
    }
    const out = { trace, digests: runs.sort((a, b) => (a.battleId < b.battleId ? -1 : 1)).map((r) => `${r.battleId}=${r.digest}`), errors: h.m.errorCount };
    h.m.dispose();
    return out;
  };
  const local = await runMatch(false);
  const pooled = await runMatch(true);
  assert.ok(local.trace.length >= 4, `local rounds (${local.trace.length})`);
  assert.deepEqual(pooled.trace, local.trace, 'LP / funds / layers every round, pool or no pool');
  assert.deepEqual(pooled.digests, local.digests, 'every battle result identical by battleId');
  assert.equal(pooled.errors, 0);
});

/** A stub pool in the rehearsal-pool.test.js shape: the answer is scripted and delivered on the virtual clock, so the
 * synchronous h.run loop observes it. `answer(entry, h)` returns the value; `rejectCode` fails the task instead;
 * `delayMs` null never answers (the cancel test). `sched` is bound after makeMatch (the stub is built first). */
function stubPool({ answer = null, rejectCode = null, delayMs = 1 } = {}) {
  const stub = { submits: [], cancels: 0, sched: null };
  stub.submit = (type, payload, o = {}) => {
    const entry = { type, payload, onProgress: o && typeof o.onProgress === 'function' ? o.onProgress : null };
    stub.submits.push(entry);
    let settled = false;
    const ok = [], bad = [];
    const handle = {
      promise: { then: (fn, onError) => { if (settled) (settled === 'ok' ? fn(entry.value) : onError(entry.error)); else { ok.push(fn); if (onError) bad.push(onError); } } },
      cancel: () => { stub.cancels++; },
    };
    if (delayMs != null) {
      stub.sched.setTimeout(() => {
        if (rejectCode) {
          entry.error = Object.assign(new Error('simulation pool unavailable'), { code: rejectCode });
          settled = 'bad';
          for (const fn of bad) fn(entry.error);
          return;
        }
        entry.value = answer(entry, hOf);
        settled = 'ok';
        for (const fn of ok) fn(entry.value);
      }, delayMs);
    }
    return handle;
  };
  let hOf = null;
  stub.bind = (h) => { stub.sched = h.sched; hOf = h; };
  return stub;
}

/** The worker's own return shape, computed by the same code the worker runs (this thread). */
function workerShapeValue(entry, h) {
  const battle = createBattleFromSpec(JSON.parse(JSON.stringify(entry.payload.spec)), h.m.ds, { recordEvents: false, quiet: true });
  const job = new HeadlessJob(battle, { players: entry.payload.players });
  job.run(Infinity);
  const out = job.output();
  return { result: out.result, timeline: out.timeline, time: out.battle.time, errors: out.battle.errors, crashed: out.crashed };
}

function pooledMatch(stubOpts = {}, extra = {}) {
  const pool = stubPool({ answer: workerShapeValue, ...stubOpts });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 9333, captureFrames: false, clientCombat: true, battlePool: true,
    simPool: pool, ...extra });
  pool.bind(h);
  return h;
}

test('the pool path feeds the timeline from progress messages and releases at the natural end', () => {
  const h = pooledMatch({ delayMs: 2 }); // the progress messages are scheduled at +1 ms, before the +2 ms answer
  h.autoHumans();
  const raw = h.m.simPool.submit.bind(h.m.simPool);
  let scheduled = false;
  h.m.simPool.submit = (type, payload, o = {}) => {
    const handle = raw(type, payload, o);
    if (type === 'battle' && !scheduled) {
      scheduled = true;
      const entry = h.m.simPool.submits[h.m.simPool.submits.length - 1];
      // the worker's progress stream, once the consumer holds the task: reset opens, the samples append
      h.sched.setTimeout(() => {
        entry.onProgress({ reset: true, samples: [[0, 0, 4, 0]] });
        entry.onProgress({ reset: false, samples: [[1, 1, 4, 1]] });
      }, 1);
    }
    return handle;
  };
  h.start();
  h.run(() => scheduled && h.m.fields.some((f) => f.cc && f.mode === 'server' && Array.isArray(f.timeline) && f.timeline.length >= 2), { maxSteps: 2e6 });
  const f = h.m.fields.find((x) => x.cc && x.mode === 'server');
  assert.ok(f, 'a pooled field is in flight');
  assert.deepEqual(f.timeline, [[0, 0, 4, 0], [1, 1, 4, 1]], 'the progress samples opened and appended');
  assert.equal(f.battle, null, 'a pool-run field holds no battle object');
  const progress = h.m._fieldProgress(f);
  assert.equal(progress.total, 4, 'the capsule reads the fed timeline');
  h.run(() => h.m.round >= 2, { maxSteps: 4e6 });
  assert.ok(f.done && f.result && f.resultSource === 'server', 'the pool result landed and released');
  assert.ok(Number.isFinite(f.endGt), 'endGt set from the worker value');
  assert.ok(Array.isArray(f.timeline) && f.timeline.length > 2, 'the full timeline replaced the fed prefix');
  h.m.dispose();
});

test('the battle\'s error records reach simErrorLog through the pool return', () => {
  const h = pooledMatch({ answer: (entry, match) => {
    const value = workerShapeValue(entry, match);
    value.result = { ...value.result, errors: (value.result.errors || 0) + 1 };
    value.errors = [{ label: 'kitTest', who: 'enemy_x', message: 'boom', stack: null }];
    return value;
  } });
  h.autoHumans();
  h.start();
  h.run(() => h.m.round >= 2, { maxSteps: 4e6 });
  assert.ok(h.m.simErrors >= 1, `simErrors counted (${h.m.simErrors})`);
  const rec = [...h.m.simErrorLog.values()].find((r) => r.label === 'kitTest');
  assert.ok(rec, 'the worker\'s error record reached the match log');
  h.m.dispose();
});

test('POOL_FULL falls back to the local sliced path and completes byte for byte', () => {
  const pool = stubPool({ rejectCode: 'POOL_FULL' });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 9334, captureFrames: false, clientCombat: true, battlePool: true,
    simPool: pool });
  pool.bind(h);
  h.autoHumans();
  const seen = new Set(), runs = [];
  h.start();
  h.run(() => { serverRuns(h, seen, runs); return h.m.round >= 2; }, { maxSteps: 4e6 });
  serverRuns(h, seen, runs);
  assert.ok(runs.length >= 1, 'the field finished anyway');
  for (const r of runs) assert.equal(r.digest, localDigest(r), 'the fallback result is the local run');
  assert.ok(runs.some((r) => r.battle), 'the fallback ran on this thread (a battle object exists)');
  h.m.dispose();
});

test('a payload that is not the worker\'s shape falls back to the local path (never guessed)', () => {
  const pool = stubPool({ answer: () => ({ result: null, timeline: [], time: 0, errors: [], crashed: false }) });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 9335, captureFrames: false, clientCombat: true, battlePool: true,
    simPool: pool });
  pool.bind(h);
  h.autoHumans();
  const seen = new Set(), runs = [];
  h.start();
  h.run(() => { serverRuns(h, seen, runs); return h.m.round >= 2; }, { maxSteps: 4e6 });
  serverRuns(h, seen, runs);
  assert.ok(runs.length >= 1, 'the field finished anyway');
  for (const r of runs) assert.equal(r.digest, localDigest(r), 'the fallback result is the local run');
  assert.ok(h.m.errorCount >= 1, 'the bad shape was reported, not swallowed');
  h.m.dispose();
});

test('dispose cancels the in-flight pool task once and applies nothing', () => {
  const pool = stubPool({ answer: workerShapeValue, delayMs: null }); // never answers
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 9336, captureFrames: false, clientCombat: true, battlePool: true,
    simPool: pool });
  pool.bind(h);
  h.autoHumans();
  h.start();
  h.run(() => h.m.simPool.submits.length > 0 && h.m.fields.some((f) => f.poolTask), { maxSteps: 2e6 });
  assert.ok(h.m.fields.some((f) => f.poolTask), 'a task is in flight');
  h.m.dispose();
  assert.equal(h.m.simPool.cancels, 1, 'the in-flight task was cancelled exactly once');
  h.m.dispose(); // idempotent
  assert.equal(h.m.simPool.cancels, 1);
});

test('battlePool: false keeps the local path even with a pool attached', () => {
  const pool = stubPool({ answer: workerShapeValue });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 9337, captureFrames: false, clientCombat: true, battlePool: false,
    simPool: pool });
  pool.bind(h);
  h.autoHumans();
  h.start();
  h.run(() => h.m.round >= 2, { maxSteps: 4e6 });
  assert.equal(h.m.simPool.submits.length, 0, 'no battle task was submitted');
  h.m.dispose();
});
