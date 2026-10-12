import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RoomActionLimiter } from '../server/roomProtection.js';
import { SuspendableScheduler, VirtualScheduler } from '../server/match/scheduler.js';
import { SimulationPool } from '../server/workers/pool.js';
import { makeMatch } from './match/harness.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { PHASE } from '../shared/constants.js';
import { captureMatch, snapshotMatch, restoreMatch } from '../server/match/snapshot.js';
import { createRngFromState } from '../server/sim/rng.js';
import { createRehearsal, planLayout, REHEARSAL_VARIANTS, LAYOUT_PARAMS } from '../server/match/bot.js';
import { lobbyOptionsFrom, roomAdminTokenFrom } from '../server/http/config.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';

test('room protection configuration rejects invalid limits and weak admin secrets', async () => {
  assert.equal(roomAdminTokenFrom({}, {}), null);
  assert.throws(() => roomAdminTokenFrom({ roomAdminToken: 'weak' }, {}), RangeError);
  await assert.rejects(startServer({ roomAdminToken: 'weak' }), RangeError);
  assert.throws(() => lobbyOptionsFrom({}, { SP_ROOM_CREATE_BURST: '0' }), RangeError);
  assert.equal(lobbyOptionsFrom({ roomCreateBurst: 8 }, { SP_ROOM_CREATE_BURST: '2' }).roomCreateBurst, 8);
});

test('denial counters retain suppressed requests and sample independently per network/action', () => {
  let now = 0;
  const limiter = new RoomActionLimiter({ now: () => now, createRefillMs: 3600000 });
  limiter.take('a', 'create');
  limiter.take('b', 'create');
  assert.equal(limiter.denied('a', 'create'), 0);
  assert.equal(limiter.denied('a', 'create'), null);
  assert.equal(limiter.denied('b', 'create'), 0);
  assert.equal(limiter.denied('a', 'start'), 0);
  now = 10000;
  assert.equal(limiter.denied('a', 'create'), 1);
  assert.equal(limiter.stats().createDenied, 4);
  assert.equal(limiter.idleMs, 4 * 3600000);
});

test('one match can suspend and dispose without cancelling another owner on the shared clock', () => {
  const base = new VirtualScheduler();
  const a = new SuspendableScheduler(base), b = new SuspendableScheduler(base);
  let ran = 0;
  a.setTimeout(() => assert.fail('disposed callback ran'), 10);
  b.setTimeout(() => ran++, 20);
  a.suspend();
  a.dispose();
  assert.equal(base.disposed, false);
  assert.equal(b.runUntil(() => ran === 1), true);
  assert.equal(base.now(), b.now());
  b.dispose();
});

test('network action budgets survive session churn, refill independently and bound memory', () => {
  let now = 0;
  const limiter = new RoomActionLimiter({ now: () => now, maxKeys: 2 });
  for (let i = 0; i < 4; i++) assert.equal(limiter.take('a', 'create'), true);
  assert.equal(limiter.take('a', 'create'), false);
  assert.equal(limiter.take('a', 'start'), true);
  assert.equal(limiter.take('b', 'create'), true);
  assert.equal(limiter.take('c', 'create'), false);
  now = 15000;
  assert.equal(limiter.take('a', 'create'), true);
  assert.equal(limiter.take('a', 'create'), false);
  now = 400000;
  assert.equal(limiter.take('c', 'create'), true);
  assert.ok(limiter.buckets.size <= 2);
});

test('restoring an old rehearsal budget respects the current zero cap and waits for a human', (t) => {
  const a = makeMatch({ humans: 1, bots: 1, fake: true }).start();
  const b = makeMatch({ humans: 1, bots: 1, fake: true });
  t.after(() => { a.m.dispose(); b.m.dispose(); });
  a.toPrep(1);
  a.run(() => a.m.order.filter((p) => p.isBot).every((p) => p.ready));
  a.m.botRehearsal = 3;
  const checkpoint = snapshotMatch(a.m);
  b.m.botRehearsalLimit = 0;
  assert.equal(restoreMatch(b.m, checkpoint, { createRngFromState }), true);
  assert.equal(b.m.botRehearsal, 0);
  b.m.syncOfflinePause();
  assert.equal(b.m.offlinePaused, true);
  b.sched.advance(60000);
  assert.equal(b.m.round, 1);
  b.m.onReconnect('p_0');
  assert.equal(b.m.offlinePaused, false);
});

test('suspended scheduler preserves remaining delays, intervals and cancellation without callbacks', () => {
  const base = new VirtualScheduler();
  const sched = new SuspendableScheduler(base);
  let timeout = 0, interval = 0;
  sched.setTimeout(() => timeout++, 100);
  const timer = sched.setInterval(() => interval++, 50);
  base.advance(20);
  sched.suspend();
  base.advance(100000);
  assert.equal(timeout + interval, 0);
  assert.equal(base.pending(), 0);
  sched.resume();
  base.advance(30);
  assert.equal(interval, 1);
  base.advance(50);
  assert.equal(timeout, 1);
  sched.clearInterval(timer);
  base.advance(100);
  assert.equal(interval, 2);
  sched.dispose();
});

test('last human disconnect freezes a cooperative match; a spectator cannot resume it', (t) => {
  const h = makeMatch({ humans: 2, bots: 1, fake: true, spectators: ['watcher'] }).start();
  const m = h.m;
  t.after(() => m.dispose());
  m.onDisconnect('p_0');
  assert.ok(!m.offlinePaused);
  m.onDisconnect('p_1');
  assert.equal(m.offlinePaused, true);
  const phase = m.phase, deadline = m.deadline;
  const capture = captureMatch(m);
  h.sched.advance(60000);
  assert.equal(m.phase, phase);
  assert.equal(h.sched.pending(), 0);
  assert.equal(captureMatch(m).clocks.deadlineRemainingMs, capture.clocks.deadlineRemainingMs);
  m.onReconnect('watcher');
  assert.equal(m.offlinePaused, true);
  m.onReconnect('p_0');
  assert.equal(m.offlinePaused, false);
  assert.equal(m.paused, false);
  assert.equal(m.deadline, deadline + 60000);
  h.sched.advance(1);
  assert.equal(m.phase, phase);
  assert.equal(m.errorCount, 0);
});

test('server combat resumes at its frozen tick without catching up offline wall time', (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1, fake: true, instant: false }).start();
  const m = h.m;
  t.after(() => m.dispose());
  h.drive(() => m.phase === PHASE.COMBAT);
  h.sched.advance(100);
  const ticks = m.runner.ticks;
  assert.ok(ticks > 0);
  m.onDisconnect('p_0');
  h.sched.advance(60000);
  assert.equal(m.runner.ticks, ticks);
  m.onReconnect('p_0');
  h.sched.advance(34);
  assert.ok(m.runner.ticks - ticks <= 2, 'offline time must not become catch-up combat ticks');
  assert.equal(m.errorCount, 0);
});

test('worker rejection is counted and audited with bounded logging; optional AI uses its base layout', async (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 4 });
  const m = h.m, ps = m.order[0], audit = [];
  t.after(() => m.dispose());
  ps.autoplay = true;
  h.start();
  h.run(() => m.phase === PHASE.PREP && m.round === 3);
  m.botRehearsal = 3;
  m.timerScale = 0;
  m.onAudit = (action, extra) => audit.push({ action, ...extra });
  m.maybeEndPrep = () => {};
  m.workerPool = { submit: () => ({ promise: Promise.reject(Object.assign(new Error('busy'), { code: 'REHEARSAL_BUSY' })), cancel() {} }) };
  m.scheduleBotPrep(ps);
  h.sched.advance(0);
  await delay(0);
  h.sched.advance(0);
  assert.equal(ps.ready, true);
  assert.equal(m.workerStats.rejected, 1);
  assert.equal(audit[0].action, 'worker.rejected');
  assert.equal(audit[0].type, 'rehearsal');
  assert.equal(m.errorCount, 0);
});

test('new identities on the same IP cannot reset the room creation budget', async (t) => {
  const logs = [], clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', roomCreateBurst: 1, roomCreateRefillMs: 3600000,
    log: { info: (line) => logs.push(line), warn() {}, error() {}, debug() {} } });
  t.after(async () => { for (const client of clients) await client.close(); await srv.close(); });
  const create = async (ip, name) => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { headers: { 'X-Real-IP': ip } } });
    clients.push(client);
    await client.hello(name);
    return client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  };
  assert.equal((await create('198.51.100.42', 'first')).t, 'ok');
  assert.equal((await create('198.51.100.42', 'second')).code, 'RATE');
  assert.equal((await create('198.51.100.43', 'third')).t, 'ok');
  const denied = logs.filter((line) => line.startsWith('[audit] ')).map((line) => JSON.parse(line.slice(8)))
    .find((entry) => entry.action === 'room.create.denied');
  assert.equal(denied.ip, '198.51.100.42');
  assert.equal(denied.name, 'second');
  assert.equal(denied.reason, 'action_budget');
  assert.equal(srv.lobby.roomActions.stats().createDenied, 1);
});

test('offline suspension cancels computation and resumes one logical job, ignoring stale completion', async (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1, fake: true }).start();
  const m = h.m;
  t.after(() => m.dispose());
  const pending = [];
  let cancelled = 0, completed = 0;
  m.workerPool = { submit: () => ({ promise: new Promise((resolve) => pending.push(resolve)), cancel: () => cancelled++ }) };
  m._submitWorker('battle', {}, { valid: () => true, complete: () => completed++, failed: () => assert.fail('fallback') });
  m.onDisconnect('p_0');
  assert.equal(cancelled, 1);
  pending[0]({});
  await delay(0);
  assert.equal(completed, 0);
  m.onReconnect('p_0');
  assert.equal(pending.length, 2);
  pending[1]({});
  await delay(0);
  assert.equal(completed, 1);
  assert.equal(m._workerTasks.size, 0);
});

test('optional rehearsals cannot fill the battle queue', async (t) => {
  const pool = new SimulationPool({ size: 1, maxQueue: 8, workerUrl: new URL('./fixtures/pool-worker.mjs', import.meta.url) });
  t.after(() => pool.close());
  const first = pool.submit('battle', { ms: 150 });
  const a = pool.submit('rehearsal', {}), b = pool.submit('rehearsal', {});
  await assert.rejects(pool.submit('rehearsal', {}).promise, { code: 'REHEARSAL_BUSY' });
  const battle = pool.submit('battle', {}, { priority: 1 });
  assert.equal(pool.stats().queuedByType.battle, 1);
  await Promise.all([first.promise, a.promise, b.promise, battle.promise]);
});

test('busy AI captures one candidate without changing the configured normal budget', (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 4 });
  const m = h.m, ps = m.order[0];
  t.after(() => m.dispose());
  ps.autoplay = true;
  h.start();
  h.run(() => m.phase === PHASE.PREP && m.round === 3);
  m.botRehearsal = 3;
  m.workerPool = { load: () => ({ size: 2, busy: 2, queued: 1 }) };
  const chosen = ps.allChess().slice(0, ps.deployCap);
  const plans = REHEARSAL_VARIANTS.map((v) => planLayout(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));
  const job = createRehearsal(m, ps, chosen, plans);
  assert.equal(job.workerPayload.options.length, 1);
  assert.equal(m.botRehearsal, 3);
});

test('private room enumeration authenticates, paginates and correlates IP/name/id without tokens', async (t) => {
  const token = 'room-admin-test-secret-32-characters';
  const roomAdminStateFile = path.join(tmpdir(), `sp-room-admin-test-${process.pid}-${Date.now()}.json`);
  const logs = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', roomAdminPort: 0, roomAdminStateFile, roomAdminToken: token, MatchClass: StubMatch,
    log: { info: (...args) => logs.push(args.join(' ')), warn() {}, error() {}, debug() {} } });
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { headers: { 'X-Real-IP': '198.51.100.42' } } });
  t.after(async () => { await client.close(); await srv.close(); await rm(roomAdminStateFile, { force: true }); });
  const welcome = await client.hello('audit-player');
  await client.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const query = (path, auth) => fetch(`${srv.roomAdminUrl}${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  assert.equal((await query('/api/rooms')).status, 401);
  assert.equal((await query('/api/rooms', 'wrong')).status, 401);
  assert.equal((await query('/api/rooms?limit=201', token)).status, 400);
  const response = await query('/api/rooms?limit=1', token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.json();
  assert.equal(body.total, 1);
  assert.deepEqual(body.rooms[0].players[0], { playerId: welcome.playerId, name: 'audit-player', ip: '198.51.100.42', connected: true, left: false, seat: 0 });
  assert.ok(!JSON.stringify(body).includes(welcome.token));
  assert.equal((await fetch(`${srv.url}/api/rooms?limit=1`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  const config = await (await query('/api/room-config', token)).json();
  assert.equal(config.maxRooms, 1000);
  const changed = await fetch(`${srv.roomAdminUrl}/api/room-config`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ maxRooms: 700 }) });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).persisted, true);
  const staleClose = await fetch(`${srv.roomAdminUrl}/api/rooms/${body.rooms[0].code}/close`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ createdAt: body.rooms[0].createdAt + 1 }) });
  assert.equal(staleClose.status, 409);
  const audit = logs.filter((l) => l.startsWith('[audit] ')).map((l) => JSON.parse(l.slice(8)));
  const created = audit.find((r) => r.action === 'room.created');
  assert.equal(created.ip, '198.51.100.42');
  assert.equal(created.playerId, welcome.playerId);
  assert.equal(created.roomCode, body.rooms[0].code);
  assert.equal(created.roomCreatedAt, body.rooms[0].createdAt);
  assert.ok(!logs.join('\n').includes(welcome.token));
  await client.request({ t: 'room.addBot' });
  await client.request({ t: 'room.removeBot', seat: 1 });
  await client.request({ t: 'room.start' });
  await client.request({ t: 'g.infoReady' });
  await client.request({ t: 'room.leave' });
  const lifecycle = logs.filter((line) => line.startsWith('[audit] ')).map((line) => JSON.parse(line.slice(8)))
    .filter((entry) => entry.roomCode === created.roomCode);
  for (const action of ['room.botAdded', 'room.botRemoved', 'match.started', 'match.ended', 'room.left', 'room.disposed']) {
    assert.ok(lifecycle.some((entry) => entry.action === action), action);
  }
  assert.ok(lifecycle.every((entry) => entry.roomCreatedAt === created.roomCreatedAt));
  await client.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const current = await (await query('/api/rooms?limit=1', token)).json();
  const close = await fetch(`${srv.roomAdminUrl}/api/rooms/${current.rooms[0].code}/close`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ createdAt: current.rooms[0].createdAt }) });
  assert.equal(close.status, 200);
  assert.equal(srv.lobby.rooms.size, 0);
});
