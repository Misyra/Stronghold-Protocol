// The bot placement planning handed to the simulation pool (SP_BOT_PLAN_POOL, default off) — the full prep path
// (MatchPrep.scheduleBotPrep → botPrepBeginSteps → arrangeSteps → MatchBotPlan.poolPlan / createBotPlanJob), not
// just the pool module on its own.
//
// What has to hold here:
//   - determinism: the flag-on match plays out exactly like the flag-off run — same boards, funds, levels, LP
//     (the pool changes where the CPU is spent, never what is planned);
//   - the pool path really ran (accepted > 0): a determinism test that silently fell back inline every time would
//     prove nothing;
//   - the fake pool mirrors the real worker's return shape (the d3fffd27 lesson), and one test anchors the SAME
//     payload on the REAL worker (test/workers-room.test.js's role for rehearsals);
//   - fallbacks: a pool that refuses or fails, and a pool whose answer lands after the shared rngBots stream moved
//     on, all fall back inline — costs latency, never a different layout;
//   - cancelled: a prep that ends while the task is in flight cancels it at the pool and nothing of it applies.
//
// The stand-in answers on the match's own virtual scheduler through a thenable (see rehearsal-pool.test.js: a real
// Promise would only settle on the microtask queue, which a synchronous scheduler loop never drains), and computes
// each answer with the very function the real worker runs (botPlanTask.applyPlanTask) — the stub mirrors the real
// contract instead of paraphrasing it. The real-worker anchor runs the one captured payload through a real
// SimulationPool and compares the answer byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { getData, simWorkerData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';
import { applyPlanTask } from '../../server/match/botPlanTask.js';
import { SimulationPool } from '../../server/workers/pool.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { makeMatch, checkInvariants } from './harness.js';

/** Co-op, two humans (both played by the engine) and two AI seats: every seat plans a layout every prep. */
const SEATS = [
  { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true },
  { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, connected: true },
  { seat: 2, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true },
  { seat: 3, playerId: 'ai_1', name: 'AI1', isBot: true, connected: true },
];

/** A wall-clock nanosecond of slice: every prep step gets its own scheduler callback (see rehearsal-pool.test.js). */
const TINY_SLICE = 1e-9;
const ROUNDS = 5;

/** The state a plan (and everything downstream of it) shows up in. */
const stateOf = (m) => JSON.stringify({
  round: m.round,
  players: [...m.players.values()].map((ps) => ({
    id: ps.playerId, board: [...ps.board.entries()].map(([k, p]) => [k, p.id, p.dir ?? null]).sort(),
    hand: ps.hand.map((p) => p && p.id), funds: ps.funds, level: ps.shop.level, lp: ps.lp,
  })).sort((a, b) => (a.id < b.id ? -1 : 1)),
});

/** The GameData the fake pool answers with — the same subset construction the real worker gets. */
const planGd = new GameData(simWorkerData(getData({ log: { info() {}, warn() {}, error() {}, debug() {} } })), 'act2autochess');

/**
 * A stand-in for the simulation pool answering 'botplan' (and nothing else) on the virtual scheduler, with the
 * real worker's return shape. `meddle` runs before the answer (e.g. draws the match's rngBots to simulate another
 * seat's prep having moved the shared stream while the task was in flight).
 */
function stubPool(h, { delayMs = 0, fail = false, meddle = null, refuse = false } = {}) {
  const pool = { submits: [], cancels: [], received: 0, assigned: 0, released: 0, answers: [] };
  pool.assign = () => { pool.assigned++; };
  pool.release = () => { pool.released++; };
  pool.submit = (type, payload) => {
    if (type !== 'botplan') throw new Error(`stubPool: unexpected task ${type}`);
    pool.submits.push(payload);
    if (refuse) {
      const err = Object.assign(new Error('simulation pool unavailable'), { code: 'POOL_FULL' });
      return { promise: { then: (_ok, onErr) => { if (onErr) onErr(err); } }, cancel() {} };
    }
    const ok = [], bad = [];
    const settle = () => {
      pool.received++;
      let value = null, error = null;
      try {
        if (fail) throw new Error('botplan: task failed (stub)');
        if (meddle) meddle();
        // the real worker's semantics: the batch was captured atomically (one entry state), the calls share one
        // mulberry32 stream, each continuing where the previous stopped
        const tasks = payload.tasks;
        if (!Array.isArray(tasks) || !tasks.length) throw new Error('botplan: empty batch');
        const entry = tasks[0].rngState;
        const rng = createRngFromState(entry);
        const results = [];
        for (const c of tasks) {
          if (c.rngState !== entry) throw new Error(`botplan: batch entry states differ at task ${c.seq}`);
          const r = applyPlanTask(planGd, c, rng);
          results.push({ seq: c.seq, plan: r.plan, rngState: r.rngState });
        }
        value = { results, rngState: rng.state() };
        pool.answers.push(value);
      } catch (e) { error = e; }
      for (const fn of ok) fn(value);
      for (const fn of bad) fn(error);
    };
    if (delayMs == null) {
      // never answers: the task is still in flight for the rest of the match
    } else h.sched.setTimeout(settle, delayMs);
    return {
      promise: { then: (fn, onErr) => { ok.push(fn); if (onErr) bad.push(onErr); } },
      cancel: () => pool.cancels.push(payload.tasks?.[0]?.seq),
    };
  };
  return pool;
}

/** A match wired for the flag: env set around the construction, pool attached before start, tiny slices. */
function play({ flag = true, makePool = null } = {}) {
  const prev = process.env.SP_BOT_PLAN_POOL;
  if (flag) process.env.SP_BOT_PLAN_POOL = '1';
  else delete process.env.SP_BOT_PLAN_POOL;
  try {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: SEATS, seed: 5, botRehearsal: 3, botSliceMs: TINY_SLICE });
    if (makePool) h.m.simPool = makePool(h);
    h.start();
    h.autoHumans();
    return h;
  } finally {
    if (prev === undefined) delete process.env.SP_BOT_PLAN_POOL;
    else process.env.SP_BOT_PLAN_POOL = prev;
  }
}

const reached = (h, round) => () => h.ended != null || (h.m.phase === PHASE.SETTLE && h.m.round === round);

/** The flag-off reference digest: run once, memoized for the comparisons below. */
let reference = null;
function referenceDigest() {
  if (reference == null) {
    const h = play({ flag: false });
    assert.ok(h.run(reached(h, ROUNDS), { maxSteps: 8e6 }), `reference run reached R${ROUNDS} (${h.m.phase} R${h.m.round})`);
    assert.equal(h.m.botPlanPoolOn, false, 'the env flag stays off');
    assert.equal(h.m.errorCount, 0, h.logs.error.join('\n'));
    reference = stateOf(h.m);
    h.m.dispose();
  }
  return reference;
}

test('flag off (default): the reference run exists and the flag is not a default', () => {
  assert.ok(referenceDigest().length > 10, 'the reference produced a state digest');
});

/** The flag-on mirroring run: a stub pool that answers with the real worker's own function. */
function mirrorRun({ stubOpts = {} } = {}) {
  let pool = null;
  const h = play({ makePool: (h2) => (pool = stubPool(h2, stubOpts)) });
  return { h, pool };
}

test('flag on + a contract-mirroring pool: the same digest, and the pool path really ran', () => {
  const { h, pool } = mirrorRun();
  assert.ok(h.run(reached(h, ROUNDS), { maxSteps: 8e6 }), `round ${ROUNDS} reached (${h.m.phase} R${h.m.round})`);
  assert.equal(h.m.errorCount, 0, h.logs.error.join('\n'));
  checkInvariants(h.m);
  const stats = h.m.botPlanPoolStats;
  assert.ok(stats.pooled >= ROUNDS, `every prep's final arrange was offered to the pool (${stats.pooled})`);
  assert.equal(stats.accepted, stats.pooled, 'every answered batch was applied');
  assert.equal(stats.fallbacks, 0, 'nothing had to fall back inline');
  assert.equal(stateOf(h.m), referenceDigest(), 'the same boards, funds, levels and LP as the flag-off run');
  h.m.dispose();
  return { pool, h };
});

test('the same payload through the REAL worker returns the answer the mirroring pool gave', async () => {
  // the mirroring run captures its payloads and answers; the real pool must agree byte for byte
  let pool = null;
  const h = play({ makePool: (h2) => (pool = stubPool(h2)) });
  assert.ok(h.run(reached(h, ROUNDS), { maxSteps: 8e6 }), `round ${ROUNDS} reached (${h.m.phase} R${h.m.round})`);
  h.m.dispose();
  assert.ok(pool.submits.length > 0 && pool.answers.length === pool.submits.length, 'the stub answered every batch');
  const real = new SimulationPool({ data: simWorkerData(getData({ log: { info() {}, warn() {}, error() {}, debug() {} } })), size: 1, maxQueue: 64, timeoutMs: 120000 });
  try {
    // the first batch, plus one from a late round (a different stage/wave shape if the run grew one)
    const picks = [0, pool.submits.length - 1];
    for (const i of [...new Set(picks)]) {
      const value = await real.submit('botplan', pool.submits[i]).promise;
      assert.deepEqual(value, pool.answers[i], `the real worker agrees with the mirroring pool (batch ${i})`);
    }
  } finally {
    await real.close();
  }
});

test('a pool that refuses (POOL_FULL) falls back inline — the same digest as the flag-off run', () => {
  const { h, pool } = mirrorRun({ stubOpts: { refuse: true } });
  assert.ok(h.run(reached(h, ROUNDS), { maxSteps: 8e6 }), `round ${ROUNDS} reached (${h.m.phase} R${h.m.round})`);
  assert.equal(h.m.errorCount, 0, h.logs.error.join('\n'));
  checkInvariants(h.m);
  const stats = h.m.botPlanPoolStats;
  assert.equal(stats.accepted, 0, 'nothing was accepted');
  assert.equal(stats.fallbacks, stats.pooled, 'every refused batch ran inline');
  assert.equal(stateOf(h.m), referenceDigest(), 'the inline fallback plays exactly the flag-off match');
  void pool;
  h.m.dispose();
});

test('a pool task that fails after acceptance falls back inline the same way', () => {
  const { h } = mirrorRun({ stubOpts: { fail: true } });
  assert.ok(h.run(reached(h, ROUNDS), { maxSteps: 8e6 }), `round ${ROUNDS} reached (${h.m.phase} R${h.m.round})`);
  assert.equal(h.m.errorCount, 0, h.logs.error.join('\n'));
  checkInvariants(h.m);
  const stats = h.m.botPlanPoolStats;
  assert.equal(stats.accepted, 0, 'nothing was accepted');
  assert.equal(stats.fallbacks, stats.pooled, 'every failed batch ran inline');
  assert.equal(stateOf(h.m), referenceDigest(), 'the inline fallback plays exactly the flag-off match');
  h.m.dispose();
});

test('an answer that lands after the shared rngBots stream moved on is discarded (inline fallback)', () => {
  const { h, pool } = mirrorRun({ stubOpts: { delayMs: 30, meddle: () => { h.m.rngBots(); h.m.rngBots(); h.m.rngBots(); } } });
  assert.ok(h.run(reached(h, ROUNDS), { maxSteps: 8e6 }), `round ${ROUNDS} reached (${h.m.phase} R${h.m.round})`);
  assert.equal(h.m.errorCount, 0, h.logs.error.join('\n'));
  checkInvariants(h.m);
  const stats = h.m.botPlanPoolStats;
  assert.equal(stats.accepted, 0, 'every answer failed the stream-state verification');
  assert.equal(stats.fallbacks, stats.pooled, 'every verified batch ran inline instead');
  h.m.dispose();
});

test('a prep that ends while the plan task is in flight cancels it and applies nothing of it', () => {
  const { h, pool } = mirrorRun({ stubOpts: { delayMs: null } }); // never answers
  assert.ok(h.run(() => pool.submits.length > 0, { maxSteps: 4e6 }), 'a plan batch reached the pool');
  // the prep deadline ends the phase with the task still in flight: nothing of it may apply
  assert.ok(h.run(reached(h, ROUNDS), { maxSteps: 8e6 }), `round ${ROUNDS} reached (${h.m.phase} R${h.m.round})`);
  assert.equal(h.m.errorCount, 0, h.logs.error.join('\n'));
  checkInvariants(h.m);
  assert.ok(pool.cancels.length > 0, 'the in-flight batches were cancelled at the pool');
  const stats = h.m.botPlanPoolStats;
  assert.equal(stats.accepted, 0, 'nothing of the unanswered batches was applied');
  h.m.dispose();
});
