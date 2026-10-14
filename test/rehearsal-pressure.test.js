import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RehearsalPressure } from '../server/rehearsalPressure.js';
import { makeMatch } from './match/harness.js';
import { PHASE } from '../shared/constants.js';
import { createRehearsal, planLayout, REHEARSAL_VARIANTS, LAYOUT_PARAMS } from '../server/match/bot.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

function fixture({ fallback = false } = {}) {
  let now = 0, user = 0, active = 0, idle = 0, reads = 0;
  const pressure = new RehearsalPressure({ autoStart: false, now: () => now,
    cpuUsage: fallback ? null : () => { reads++; return { user, system: 0 }; },
    eluNow: () => ({ active, idle }) });
  return { pressure, reads: () => reads, sample(percent, ms = 1000) {
    now += ms; user += percent / 100 * ms * 1000;
    active += percent / 100 * ms; idle += (1 - percent / 100) * ms;
    pressure.sample();
  } };
}

test('main-thread thresholds are strictly above 60/70 and hot AI reads never sample CPU', () => {
  const f = fixture(), p = f.pressure;
  assert.equal(p.stats().percent, null);
  f.sample(60);
  assert.equal(p.cap(3), 3);
  f.sample(61);
  assert.equal(p.cap(3), 1);
  f.sample(70);
  assert.equal(p.cap(3), 1);
  f.sample(71);
  assert.equal(p.cap(3), 0);
  const reads = f.reads();
  for (let i = 0; i < 10000; i++) assert.equal(p.cap(3), 0);
  assert.equal(f.reads(), reads);
  assert.equal(p.stats().source, 'main-thread-cpu');
  assert.equal(p.cap(0), 0);
});

test('recovery needs five low samples; threshold jitter cannot flap rehearsal budgets', () => {
  const f = fixture(), p = f.pressure;
  f.sample(80);
  for (let i = 0; i < 5; i++) f.sample(66);
  assert.equal(p.cap(3), 0);
  for (let i = 0; i < 4; i++) f.sample(65);
  assert.equal(p.cap(3), 0);
  f.sample(65);
  assert.equal(p.cap(3), 1);
  for (let i = 0; i < 5; i++) f.sample(56);
  assert.equal(p.cap(3), 1);
  for (let i = 0; i < 4; i++) f.sample(55);
  f.sample(59);
  f.sample(55);
  assert.equal(p.cap(3), 1, 'a high sample resets recovery');
  for (let i = 0; i < 4; i++) f.sample(55);
  assert.equal(p.cap(3), 3);
  assert.equal(p.cap(0), 0, 'configured zero never turns itself on');
});

test('old Node fallback and delayed sampling use actual window time, not a fixed one second divisor', () => {
  for (const fallback of [false, true]) {
    const f = fixture({ fallback });
    f.sample(50, 5000);
    assert.equal(f.pressure.stats().percent, 50);
    assert.equal(f.pressure.cap(3), 3);
    f.sample(80, 5000);
    assert.equal(f.pressure.cap(3), 0);
    assert.equal(f.pressure.stats().source, fallback ? 'event-loop-utilization' : 'main-thread-cpu');
  }
});

test('AI captures 3/1/0 effective budgets without mutating its configured budget or board', (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 4 });
  const m = h.m, ps = m.order[0], f = fixture();
  t.after(() => m.dispose());
  ps.autoplay = true;
  h.start();
  h.run(() => m.phase === PHASE.PREP && m.round === 3);
  m.botRehearsal = 3;
  m.rehearsalPressure = f.pressure;
  m.workerPool = { load: () => ({ size: 2, busy: 0, queued: 0 }) };
  const chosen = ps.allChess().slice(0, ps.deployCap);
  const plans = REHEARSAL_VARIANTS.map((v) => planLayout(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));
  const before = JSON.stringify([...ps.board]);
  const normal = createRehearsal(m, ps, chosen, plans);
  assert.ok(normal.workerPayload.options.length >= 2 && normal.workerPayload.options.length <= 3);
  f.sample(61);
  assert.equal(createRehearsal(m, ps, chosen, plans).workerPayload.options.length, 1);
  f.sample(71);
  assert.equal(createRehearsal(m, ps, chosen, plans), null);
  assert.equal(m.botRehearsal, 3);
  assert.equal(JSON.stringify([...ps.board]), before);
});

test('server shares its monitor with new matches and exposes pressure without collecting on read', async (t) => {
  let captured;
  class ProbeMatch extends StubMatch {
    constructor(opts) { super(opts); captured = opts.rehearsalPressure; }
  }
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: ProbeMatch });
  const pressure = srv.network.diagnostics.rehearsalPressure;
  t.after(() => srv.close());
  assert.equal(srv.lobby.rehearsalPressure, pressure);
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => client.close());
  await client.hello('pressure');
  await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  await client.request({ t: 'room.start' });
  assert.equal(captured, pressure);
  const publicHealth = await (await fetch(srv.url + '/healthz')).json();
  assert.equal(publicHealth.rehearsalPressure, undefined, 'the pressure sampler is /metrics-only');
  const health = await (await fetch(srv.url + '/metrics')).json();
  assert.equal(health.rehearsalPressure.thresholds.disableAbovePercent, 70);
  await srv.close();
  assert.equal(pressure.timer, null);
});
