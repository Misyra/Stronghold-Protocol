// 窗口算术与资源归属,全用注入的时钟/计数器,不睡真钟(移植自 Stardust fork 的 test/health-metrics.test.js;
// B 无 publicLoadDetails/共享归一化,增加 phases 记录器轮转的覆盖)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthMetrics, PERFORMANCE_UNAVAILABLE, serverLoadState } from '../server/healthMetrics.js';

function fixture(overrides = {}) {
  const calls = { now: 0, cpu: 0, elu: 0, memory: 0, create: 0, enable: 0, disable: 0, reset: 0, percentiles: [],
    schedule: 0, clear: 0, unref: 0 };
  const state = {
    at: 1000, wall: 1_800_000_000_000,
    cpu: { user: 5_000_000, system: 1_000_000 }, elu: { active: 400, idle: 600, utilization: 0.4 },
    memory: { rss: 80_000_000, heapUsed: 10_000_000, heapTotal: 20_000_000, external: 3_000_000, arrayBuffers: 2_000_000 },
    count: 5, delays: { 50: 20_500_000, 95: 32_000_000, 99: 44_000_000 }, max: 60_000_000,
  };
  const histogram = {
    enable() { calls.enable++; }, disable() { calls.disable++; }, reset() { calls.reset++; },
    get count() { return state.count; }, get max() { return state.max; },
    percentile(p) { assert.ok(state.count > 0, 'never query an empty histogram'); calls.percentiles.push(p); return state.delays[p]; },
  };
  const timer = { unref() { calls.unref++; } };
  let tick;
  const metrics = createHealthMetrics({
    log: { warn: (message) => warnings.push(message) },
    now: () => { calls.now++; return state.at; }, wallNow: () => state.wall,
    cpuUsage: () => { calls.cpu++; return { ...state.cpu }; },
    eventLoopUtilization: () => { calls.elu++; return { ...state.elu }; },
    memoryUsage: () => { calls.memory++; return { ...state.memory }; },
    createHistogram: (opts) => { calls.create++; assert.deepEqual(opts, { resolution: 20 }); return histogram; },
    setInterval: (t, ms) => { calls.schedule++; assert.equal(ms, 10_000); tick = t; return timer; },
    clearInterval: (value) => { assert.equal(value, timer); calls.clear++; },
    ...overrides,
  });
  const warnings = [];
  return { metrics, state, calls, histogram, timer, warnings, tick: () => tick() };
}

function assertNullMeasurements(snapshot) {
  assert.equal(snapshot.sampledAt, null);
  assert.equal(snapshot.windowMs, null);
  for (const value of Object.values(snapshot.mainThread.eventLoopDelayMs)) assert.equal(value, null);
  assert.equal(snapshot.mainThread.eventLoopUtilization, null);
  for (const value of Object.values(snapshot.mainThread.memory)) assert.equal(value, null);
  for (const value of Object.values(snapshot.process.cpu)) assert.equal(value, null);
  assert.equal(snapshot.process.rssBytes, null);
}

function assertFiniteOrNull(value) {
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertFiniteOrNull(child);
  else if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite value: ${value}`);
}

test('health metrics: cold reads do not allocate, read counters, sample or reset; start is idempotent and timer unrefed', () => {
  const f = fixture();
  const cold = f.metrics.snapshot();
  assert.equal(cold.status, 'warming');
  assertNullMeasurements(cold);
  for (let i = 0; i < 4; i++) assert.equal(f.metrics.snapshot(), cold);
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.cpu, 0);
  f.metrics.start(); f.metrics.start();
  assert.equal(f.metrics.snapshot(), cold);
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.enable, 1);
  assert.equal(f.calls.schedule, 1);
  assert.equal(f.calls.unref, 1);
  assert.equal(f.calls.cpu, 1);
  assert.equal(f.calls.elu, 1);
  assert.equal(f.calls.reset, 0);
  f.metrics.dispose();
});

test('health metrics: cached reads never sample, query Workers, reset or move baselines', () => {
  const f = fixture(); f.metrics.start();
  f.state.at += 10_000;
  f.state.cpu.user += 150_000_000;
  f.state.elu.active += 4000; f.state.elu.idle += 6000;
  f.tick();
  const cached = f.metrics.snapshot(), reads = structuredClone(f.calls);
  for (let i = 0; i < 100; i++) assert.equal(f.metrics.snapshot(), cached);
  assert.deepEqual(f.calls, reads, 'cache reads do not move sampling or cumulative baselines');
  f.metrics.dispose();
});

test('health metrics: CPU uses the real monotonic window, allows >100%, ns/us convert to ms, memory stays bytes', () => {
  const f = fixture(); f.metrics.start();
  f.state.at += 12_500; // A delayed interval, NOT the nominal 10 seconds.
  f.state.wall -= 60_000; // Wall-clock correction does not shorten the CPU window.
  f.state.cpu = { user: 35_000_000, system: 6_000_000 };
  f.state.elu = { active: 2400, idle: 8600, utilization: 0.2 };
  f.tick();
  const first = f.metrics.snapshot();
  assert.equal(first.status, 'ready');
  assert.equal(first.sampledAt, f.state.wall);
  assert.equal(first.windowMs, 12_500);
  assert.deepEqual(first.process.cpu, { userMs: 30_000, systemMs: 5000, totalMs: 35_000, percent: 280 });
  assert.deepEqual(first.mainThread.eventLoopDelayMs, { p50: 20.5, p95: 32, p99: 44, max: 60 });
  assert.equal(first.mainThread.eventLoopUtilization, 0.2);
  assert.equal(first.process.rssBytes, 80_000_000);
  assert.deepEqual(first.mainThread.memory, {
    heapUsedBytes: 10_000_000, heapTotalBytes: 20_000_000, externalBytes: 3_000_000, arrayBuffersBytes: 2_000_000,
  });
  const reads = { ...f.calls, percentiles: [...f.calls.percentiles] };
  for (let i = 0; i < 20; i++) assert.equal(f.metrics.snapshot(), first);
  assert.deepEqual(f.calls, reads, 'cache reads do not move sampling or cumulative baselines');
  f.state.at += 15_000;
  f.state.cpu = { user: 35_000_000, system: 6_000_000 }; // Real zero CPU is allowed in a warm window.
  f.state.elu = { active: 3900, idle: 12_100, utilization: 0.7 };
  f.tick();
  const second = f.metrics.snapshot();
  assert.equal(second.windowMs, 15_000);
  assert.deepEqual(second.process.cpu, { userMs: 0, systemMs: 0, totalMs: 0, percent: 0 });
  assert.equal(second.mainThread.eventLoopUtilization, 0.3, 'subtract the previous cumulative ELU, not its delta');
  assert.equal(f.calls.reset, 2, 'exactly one reset per interval');
  assert.equal(first.windowMs, 12_500, 'a later sample does not mutate the old cache');
  f.metrics.dispose();
});

test('health metrics: empty histograms and zero ELU windows are null, never sentinels or invented zero delays', () => {
  const f = fixture(); f.metrics.start();
  f.state.at += 10_000;
  f.state.count = 0;
  f.state.delays = { 50: 2 ** 63, 95: 2 ** 63, 99: 2 ** 63 };
  f.state.max = 0;
  f.tick();
  const sample = f.metrics.snapshot();
  assert.equal(sample.status, 'ready');
  assert.equal(sample.mainThread.eventLoopUtilization, null);
  assert.deepEqual(sample.mainThread.eventLoopDelayMs, { p50: null, p95: null, p99: null, max: null });
  assert.deepEqual(f.calls.percentiles, []);
  assert.equal(f.calls.reset, 1);
  f.metrics.dispose();
});

test('health metrics: nonpositive clock windows are cold and still advance cumulative baselines once', () => {
  const f = fixture(); f.metrics.start();
  for (const at of [1000, 900]) {
    f.state.at = at; f.tick();
    assert.equal(f.metrics.snapshot().status, 'warming');
    assertNullMeasurements(f.metrics.snapshot());
  }
  f.state.at = 10_900; f.tick();
  assert.equal(f.metrics.snapshot().windowMs, 10_000);
  assert.equal(f.calls.reset, 3);
  f.metrics.dispose();
});

test('health metrics: invalid counters, histogram sentinels, and memory values cannot escape as NaN/Infinity/negative', () => {
  const f = fixture(); f.metrics.start();
  f.state.at += 10_000;
  f.state.cpu = { user: NaN, system: -1000 };
  f.state.elu = { active: Infinity, idle: -1 };
  f.state.memory = { rss: Infinity, heapUsed: NaN, heapTotal: -1, external: undefined, arrayBuffers: null };
  f.state.delays = { 50: NaN, 95: Infinity, 99: 2 ** 63 };
  f.state.max = -1;
  f.tick();
  const sample = f.metrics.snapshot();
  assertFiniteOrNull(sample);
  assert.deepEqual(sample.process.cpu, { userMs: null, systemMs: null, totalMs: null, percent: null });
  assert.equal(sample.process.rssBytes, null);
  assert.equal(sample.mainThread.eventLoopUtilization, null);
  assert.ok(Object.values(sample.mainThread.memory).every((v) => v === null));
  assert.ok(Object.values(sample.mainThread.eventLoopDelayMs).every((v) => v === null));
  f.metrics.dispose();
});

test('health metrics: missing/null cumulative counters are null, not coerced to a fabricated zero', () => {
  const f = fixture();
  f.state.cpu = { user: null, system: undefined };
  f.state.elu = { active: null, idle: undefined };
  f.metrics.start();
  f.state.at += 10_000;
  f.state.cpu = { user: 0, system: 0 };
  f.state.elu = { active: 0, idle: 10_000 };
  f.tick();
  assert.deepEqual(f.metrics.snapshot().process.cpu, { userMs: null, systemMs: null, totalMs: null, percent: null });
  assert.equal(f.metrics.snapshot().mainThread.eventLoopUtilization, null);
  f.metrics.dispose();
});

test('health metrics: separate collectors own their caches/resources and dispose is terminal/idempotent', () => {
  const a = fixture(), b = fixture(); a.metrics.start(); b.metrics.start();
  a.state.at += 10_000; a.tick();
  assert.equal(a.metrics.snapshot().status, 'ready');
  assert.equal(b.metrics.snapshot().status, 'warming');
  a.metrics.dispose(); a.metrics.dispose(); a.metrics.start(); a.tick();
  assert.equal(a.calls.clear, 1);
  assert.equal(a.calls.disable, 1);
  assert.equal(a.calls.reset, 1);
  assert.equal(a.calls.schedule, 1);
  assert.equal(a.metrics.snapshot().status, 'stopped');
  assertNullMeasurements(a.metrics.snapshot());
  assert.equal(b.calls.disable, 0);
  b.metrics.dispose();
  const cold = fixture(); cold.metrics.dispose(); cold.metrics.start();
  assert.equal(cold.calls.create, 0, 'closing before start cannot later allocate resources');
});

test('health metrics: partially failed startup releases histogram/timer and logs once without throwing', async (t) => {
  for (const step of ['create', 'enable', 'cpu', 'elu', 'schedule', 'unref']) {
    await t.test(step, () => {
      const error = () => { throw new Error(`injected ${step} failure`); };
      let f;
      const overrides = {
        create: { createHistogram: error },
        enable: { createHistogram: () => ({ enable: error, disable: () => f.calls.disable++ }) },
        cpu: { cpuUsage: error }, elu: { eventLoopUtilization: error },
        schedule: { setInterval: error },
        unref: { setInterval: () => { f.timer.unref = error; return f.timer; } },
      };
      f = fixture(overrides[step]);
      assert.doesNotThrow(() => f.metrics.start());
      assert.equal(f.metrics.snapshot().status, 'unavailable');
      assertNullMeasurements(f.metrics.snapshot());
      assert.equal(f.calls.disable, step === 'create' ? 0 : 1);
      assert.equal(f.calls.clear, step === 'unref' ? 1 : 0);
      assert.equal(f.warnings.length, 1);
      f.metrics.start(); f.metrics.dispose(); f.metrics.dispose();
      assert.equal(f.warnings.length, 1);
      assert.equal(f.calls.disable, step === 'create' ? 0 : 1);
    });
  }
});

test('health metrics: sample/read/reset failures stop the sampler, publish unavailable, and never retry on cache reads', async (t) => {
  for (const step of ['cpu', 'elu', 'memory', 'percentile', 'reset']) {
    await t.test(step, () => {
      let fail = false;
      const error = () => { throw new Error(`injected ${step} failure`); };
      const f = fixture(step === 'memory' ? { memoryUsage: error }
        : step === 'cpu' ? { cpuUsage: () => fail ? error() : { user: 0, system: 0 } }
        : step === 'elu' ? { eventLoopUtilization: () => fail ? error() : { active: 0, idle: 0 } } : {});
      f.metrics.start(); fail = true; f.state.at += 10_000;
      if (step === 'percentile') f.histogram.percentile = error;
      if (step === 'reset') f.histogram.reset = error;
      assert.doesNotThrow(() => f.tick());
      assert.equal(f.metrics.snapshot().status, 'unavailable');
      assertNullMeasurements(f.metrics.snapshot());
      assert.equal(f.calls.clear, 1);
      assert.equal(f.calls.disable, 1);
      assert.equal(f.warnings.length, 1);
      f.tick(); f.metrics.snapshot(); f.metrics.start(); f.metrics.dispose();
      assert.equal(f.calls.disable, 1);
      assert.equal(f.warnings.length, 1);
    });
  }
});

test('health metrics: a phase recorder is rotated with each ready sample and survives its failures', () => {
  let rotations = 0, boom = false;
  const phases = { rotate: () => { rotations++; if (boom) throw new Error('rotor'); return { 'match.commit': { count: 3 } }; } };
  const f = fixture({ phases });
  assert.equal('phases' in f.metrics.snapshot(), true, 'the snapshot reserves the phases key');
  assert.equal(f.metrics.snapshot().phases, null);
  f.metrics.start();
  f.state.at += 10_000; f.tick();
  assert.equal(rotations, 1);
  assert.deepEqual(f.metrics.snapshot().phases, { 'match.commit': { count: 3 } });
  boom = true;
  f.state.at += 10_000; f.tick();
  assert.equal(f.metrics.snapshot().phases, null, 'a broken recorder is diagnostics only');
  f.metrics.dispose();
});

test('health metrics: PERFORMANCE_UNAVAILABLE keeps the snapshot shape with everything null', () => {
  assert.equal(PERFORMANCE_UNAVAILABLE.status, 'unavailable');
  assertNullMeasurements(PERFORMANCE_UNAVAILABLE);
});

test('health metrics: serverLoadState grades the cached window, unknown when stale or malformed', () => {
  const ready = { status: 'ready', sampledAt: 1_000, windowMs: 10_000,
    mainThread: { eventLoopUtilization: 0.4, eventLoopDelayMs: { p95: 20 } } };
  assert.equal(serverLoadState(ready, 2_000), 'normal');
  assert.equal(serverLoadState({ ...ready, mainThread: { ...ready.mainThread, eventLoopUtilization: 0.9 } }, 2_000), 'busy');
  assert.equal(serverLoadState({ ...ready, mainThread: { ...ready.mainThread, eventLoopDelayMs: { p95: 120 } } }, 2_000), 'overloaded');
  assert.equal(serverLoadState({ ...ready, mainThread: { ...ready.mainThread, eventLoopUtilization: 0.96, eventLoopDelayMs: { p95: 60 } } }, 2_000), 'overloaded');
  for (const bad of [null, undefined,
    { ...ready, sampledAt: 1_000, mainThread: null },
    { ...ready, status: 'warming' },
    { ...ready, sampledAt: 40_000 },
    { ...ready, sampledAt: NaN },
    { ...ready, windowMs: 0 },
    { ...ready, mainThread: { ...ready.mainThread, eventLoopUtilization: 1.5 } },
    { ...ready, mainThread: { ...ready.mainThread, eventLoopDelayMs: { p95: -3 } } }]) {
    assert.equal(serverLoadState(bad, 2_000), 'unknown', JSON.stringify(bad));
  }
});
