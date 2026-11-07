// test/match/pacer-skip-budget.test.js — the boss takeover's sliced fast-forward under a wall-clock budget
// (SP_PACER_SKIP_BUDGET_MS, docs/history 0.3.4 §37.137): one pacing interval's skip stops once the budget is spent
// (checked every tick, with a one-tick minimum so a slice never starves), 0 restores the fixed
// CATCHUP_TICKS_PER_INTERVAL tick cap alone (the rollback path), and whatever the budget the catch-up still
// completes — same total ticks, same battle state as the one-shot skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TICK } from '../../server/sim/constants.js';
import { HeadlessPacer, _setPacerSkipBudgetForTests } from '../../server/match/fields.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { FakeBattle } from './fakeBattle.js';

const pacerOf = () => {
  const errs = [];
  const sched = new VirtualScheduler({ instantCombat: false });
  const m = { sched, gameSpeed: 2, guard: (fn) => fn(), reportError: (l, e) => errs.push(`${l}: ${e && e.message}`) };
  return { pacer: new HeadlessPacer(m), sched, errs };
};

/** A clock advancing `per` ms on every read (a tick costs one read). */
const stepClock = (per) => {
  let t = 0;
  return () => (t += per);
};

test('a wall-clock budget stops a skip round at the budget: at most budget + 1 tick of overshoot, never 0 ticks', () => {
  FakeBattle.reset();
  const { pacer } = pacerOf();
  const battle = new FakeBattle({ kind: 'boss', fieldId: 'b1', players: [], timeLimit: Infinity });
  const entry = { battle };
  const now = stepClock(1); // 1 ms per clock read ≙ 1 ms per tick
  assert.equal(pacer._skip(entry, 1e9, 1e9, 8, now), 8, 'budget 8 ms at 1 ms/tick → 8 ticks (0 overshoot, ≤ budget + 1)');
  assert.equal(pacer._skip(entry, 1e9, 1e9, 0.5, now), 1, 'the one-tick minimum: a starving slice still steps one tick');
  assert.equal(pacer._skip(entry, battle.tickCount + 5, 1e9, 8, now), 5, 'not forced to spend the budget: the cap ends the round');
  assert.equal(pacer._skip(entry, 1e9, 7, 8, now), 7, 'the tick cap (max) still bounds the round under a budget');
});

test('budget 0 is the rollback path: the fixed tick cap alone, the clock is never read', () => {
  FakeBattle.reset();
  const { pacer } = pacerOf();
  const battle = new FakeBattle({ kind: 'boss', fieldId: 'b1', players: [], timeLimit: Infinity });
  const entry = { battle };
  let reads = 0;
  const now = () => { reads++; return 1e9; }; // a spent clock: any budget > 0 would stop at once
  assert.equal(pacer._skip(entry, 1e9, 241, 0, now), 241, 'budget 0 runs the full tick cap');
  assert.equal(reads, 0, 'the off path reads no clock at all');
});

test('a budgeted catch-up conserves the total: the same final state as the one-shot skip', () => {
  FakeBattle.reset();
  const { pacer } = pacerOf();
  const cap = Math.ceil(100 / TICK); // 100 game s = 3000 ticks behind
  const budgeted = new FakeBattle({ kind: 'boss', fieldId: 'a', players: [], timeLimit: Infinity });
  const oneshot = new FakeBattle({ kind: 'boss', fieldId: 'a', players: [], timeLimit: Infinity });
  const now = stepClock(0.125); // 8 ms budget ≙ 64 ticks a round — well under the 241-tick cap
  let rounds = 0;
  let maxRound = 0;
  while (!budgeted.finished && budgeted.tickCount < cap && rounds++ < 1000) {
    maxRound = Math.max(maxRound, pacer._skip({ battle: budgeted }, cap, 241, 8, now));
  }
  assert.ok(rounds > Math.ceil(cap / 241), `the budget sliced the catch-up finer than the tick cap (${rounds} rounds)`);
  assert.ok(maxRound <= 65, `every round stayed within budget + 1 tick (${maxRound})`);
  pacer._skip({ battle: oneshot }, cap, Infinity);
  assert.equal(budgeted.tickCount, cap);
  assert.equal(budgeted.tickCount, oneshot.tickCount);
  assert.equal(budgeted.time, oneshot.time);
  assert.deepEqual(budgeted.result(), oneshot.result(), 'identical battle state however the slices fall');
});

test('_pump hands the module budget to _skip, and env = 0 hands 0 (read once at import, tests may retune)', () => {
  FakeBattle.reset();
  const { pacer, sched } = pacerOf();
  const battle = new FakeBattle({ kind: 'boss', fieldId: 'b1', players: [], timeLimit: Infinity });
  const entry = pacer.add({ battle, onDone: () => {} });
  pacer.skipTo(entry, 100, { budgetTicks: 240 });
  const seen = [];
  const orig = HeadlessPacer.prototype._skip;
  HeadlessPacer.prototype._skip = function (...args) { seen.push(args[3]); return orig.apply(this, args); };
  try {
    _setPacerSkipBudgetForTests(8);
    sched.advance(34);
    _setPacerSkipBudgetForTests(0);
    sched.advance(34);
  } finally {
    HeadlessPacer.prototype._skip = orig;
    _setPacerSkipBudgetForTests(undefined); // back to the env default
  }
  assert.deepEqual(seen, [8, 0]);
  assert.equal(entry.skipTicks != null, true, 'still catching up (the fake battle is fast, the tick cap binds)');
});

test('with the budget binding in the real pump, a round steps ~budget worth of ticks and the catch-up still completes', () => {
  FakeBattle.reset();
  const { pacer, sched, errs } = pacerOf();
  class SlowBattle extends FakeBattle {
    step() {
      const t0 = performance.now();
      while (performance.now() - t0 < 1) { /* ~1 ms a tick: the budget cuts the round off long before the tick cap */ }
      super.step();
    }
  }
  const battle = new SlowBattle({ kind: 'boss', fieldId: 'b1', players: [], timeLimit: Infinity });
  const entry = pacer.add({ battle, onDone: () => {} });
  pacer.skipTo(entry, 3, { budgetTicks: 240 }); // 3 game s = 90 ticks behind
  assert.equal(entry.skipTicks, 90, 'nothing stepped synchronously');
  const first = battle.tickCount;
  sched.advance(34);
  assert.ok(battle.tickCount - first <= 9, `one round: ≤ budget + 1 tick through the real pump (${battle.tickCount - first})`);
  assert.ok(entry.skipTicks != null, 'the slice continues over the following intervals');
  let maxAdvance = 0;
  for (let i = 0; i < 60 && entry.skipTicks != null; i++) {
    const t0 = performance.now();
    sched.advance(34);
    maxAdvance = Math.max(maxAdvance, performance.now() - t0);
  }
  assert.equal(entry.skipTicks, null, `caught up with the moving field clock (${battle.tickCount} ticks)`);
  assert.ok(maxAdvance <= 33, `a budgeted round never costs a pacing interval (${maxAdvance.toFixed(1)} ms)`);
  const before = battle.tickCount;
  sched.advance(1000);
  assert.ok(Math.abs(battle.tickCount - before - 60) <= 8, `normal 2× pacing afterwards (${battle.tickCount - before} ticks / s)`);
  assert.deepEqual(errs, []);
  pacer.stop();
});
