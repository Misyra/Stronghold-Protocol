// A refused WebSocket upgrade gives the client no HTTP status (browsers report code 1006 only), so a
// stale gate cookie used to look exactly like a dead socket and the client retried forever. These
// tests pin the cure: probe once per window, reload only for explicit gate failure after a real outage,
// and never reload from a background tab or past the session cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, GATE_PROBE } from '../public/js/net.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  let seq = 1;
  const queue = [];
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const id = seq++; queue.push({ id, at: t + ms, fn }); return id; },
      clearTimeout(id) { const i = queue.findIndex((entry) => entry.id === id); if (i >= 0) queue.splice(i, 1); },
      setInterval() { return seq++; },
      clearInterval() {},
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > end) break;
        queue.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    read: (key) => map.get(key),
  };
}

function harness({ statuses = [], hidden = false, storage, probe } = {}) {
  const clock = fakeClock();
  const sockets = [];
  const reloads = [];
  const events = [];
  let probes = 0;
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    send() {}
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const store = storage || memoryStorage();
  const net = new Net({
    url: 'ws://test/ws', WebSocket: Socket, timers: clock.timers, now: clock.now,
    random: () => 0.5, storage: store, isHidden: () => hidden,
    gateProbe: probe === null ? undefined : probe || (() => { probes += 1; return Promise.resolve(statuses.length ? statuses.shift() : false); }),
    reload: () => { reloads.push(clock.now()); },
  });
  net.on('gateReload', (payload) => events.push(['gateReload', payload]));
  net.on('gateBlocked', (payload) => events.push(['gateBlocked', payload]));
  return { clock, net, sockets, reloads, events, store, probes: () => probes };
}

async function flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }

/** Fail the newest socket and let the backoff timer run, the way a refused upgrade repeats. */
async function failRounds(env, rounds, sliceMs = 500) {
  let elapsed = 0;
  for (let i = 0; i < rounds; i += 1) {
    if (env.net._manualClose) break;
    const socket = env.sockets.at(-1);
    assert.equal(typeof socket.onclose, 'function', 'a live socket to refuse');
    socket.onclose({ code: 1006 });
    await flush();
    const before = env.sockets.length;
    for (let guard = 0; guard < 400 && env.sockets.length === before; guard += 1) {
      env.clock.advance(sliceMs);
      elapsed += sliceMs;
      await flush();
    }
  }
  return elapsed;
}

test('an explicit gate failure reloads, spaced out, and never past the session cap', async () => {
  const env = harness({ statuses: Array(50).fill(true) });
  const started = env.clock.now();
  env.net.connect();
  await failRounds(env, 12);
  assert.ok(env.reloads.length >= 1, 'a stuck page gets rescued');
  assert.ok(env.reloads.length <= GATE_PROBE.maxReloadsPerWindow, 'and not more than the cap');
  assert.ok(env.reloads[0] - started >= GATE_PROBE.reloadAfterFailureMs, 'not before the outage is real');
  for (let i = 1; i < env.reloads.length; i += 1) {
    assert.ok(env.reloads[i] - env.reloads[i - 1] >= GATE_PROBE.reloadGapMs, 'reloads stay spaced');
  }
  assert.equal(env.events.filter(([type]) => type === 'gateReload').length, env.reloads.length);
});

test('a 200 probe keeps the plain backoff: the gate is fine, do not reload', async () => {
  const env = harness({ statuses: Array(50).fill(false) });
  env.net.connect();
  await failRounds(env, 12);
  assert.equal(env.probes() > 0, true, 'it did ask');
  assert.equal(env.reloads.length, 0);
  assert.equal(env.net.status, 'reconnecting');
});

test('a hidden tab never probes and never reloads', async () => {
  const env = harness({ statuses: Array(50).fill(true), hidden: true });
  env.net.connect();
  await failRounds(env, 12);
  assert.equal(env.probes(), 0);
  assert.equal(env.reloads.length, 0);
});

test('probes are throttled to one per interval', async () => {
  const env = harness({ statuses: Array(200).fill(true) });
  env.net.connect();
  const elapsed = await failRounds(env, 30);
  const allowed = Math.ceil(elapsed / GATE_PROBE.intervalMs) + 1;
  assert.ok(env.probes() > 0, 'it does probe once the failures pile up');
  assert.ok(env.probes() <= allowed, `probed ${env.probes()} times in ${elapsed} ms, allowed ${allowed}`);
});

test('the session cap stops a reload loop and says so instead', async () => {
  const clockStart = 1_000_000;
  const storage = memoryStorage({
    'sp.gateReload': JSON.stringify([clockStart - 3000, clockStart - 2000, clockStart - 1000]),
  });
  const env = harness({ statuses: Array(50).fill(true), storage });
  env.net.connect();
  await failRounds(env, 12);
  assert.equal(env.reloads.length, 0, 'three reloads already spent');
  assert.equal(env.events.filter(([type]) => type === 'gateBlocked').length >= 1, true);
  assert.equal(env.net.status, 'closed');
  assert.equal(env.net.lastError.code, 'GATE_REQUIRED');
  const sockets = env.sockets.length;
  env.clock.advance(GATE_PROBE.windowMs);
  env.net.retryNow();
  assert.equal(env.sockets.length, sockets, 'no timer or focus event resumes a known refused page');
});

test('a successful open re-arms the outage timer', async () => {
  const env = harness({ statuses: Array(50).fill(true) });
  env.net.connect();
  await failRounds(env, 3);
  assert.ok(env.net._failedSince > 0);
  const socket = env.sockets.at(-1);
  socket.readyState = 1;
  socket.onopen();
  assert.equal(env.net._failedSince, 0);
  assert.equal(env.net.attempt, 0);
});

test('the default probe requires its own marker, never an ordinary rate limit or error', async (t) => {
  let response;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return response; });
  const env = harness({ probe: null });
  for (const [status, marker, required] of [[200, '1', true], [200, null, false], [204, null, false],
    [429, null, false], [429, '1', false], [503, '1', false], [404, null, false]]) {
    response = new Response(null, { status, headers: marker ? { 'X-Gate-Required': marker } : {} });
    assert.equal(await env.net.gateProbe(), required, `${status} / ${marker}`);
  }
  assert.ok(requests.every(({ url, options }) => url === '/_gate/status' &&
    options.credentials === 'same-origin' && options.cache === 'no-store' && options.signal instanceof AbortSignal));
  env.net.connect();
  await failRounds(env, 12);
  assert.equal(env.reloads.length, 0, 'missing endpoint on an older server never reloads');
});

test('late probes cannot reload after recovery, manual close or a tab becoming hidden', async () => {
  for (const action of ['recover', 'close', 'hidden', 'newOutage']) {
    let resolve;
    const env = harness({ probe: () => new Promise((r) => { resolve = r; }) });
    env.net.connect();
    env.net._failedSince = env.clock.now();
    env.clock.advance(30000);
    env.net._probeGate();
    if (action === 'close') env.net.close();
    else if (action === 'hidden') env.net.isHidden = () => true;
    else {
      env.sockets.at(-1).readyState = 1;
      env.sockets.at(-1).onopen();
      if (action === 'newOutage') {
        env.sockets.at(-1).onclose({ code: 1006 });
        env.clock.advance(30000);
      }
    }
    resolve(true); await flush();
    assert.equal(env.reloads.length, 0, action);
    env.net.close();
  }
});

test('reload gap survives a new page', () => {
  const env = harness({ storage: memoryStorage({ 'sp.gateReload': JSON.stringify([999_000]) }) });
  env.net._failedSince = 970_000;
  env.net._reloadForGate();
  assert.equal(env.reloads.length, 0);
  env.clock.advance(GATE_PROBE.reloadGapMs);
  env.net._reloadForGate();
  assert.equal(env.reloads.length, 1);
});

test('a rejected or throwing probe leaves normal reconnect available', async () => {
  for (const probe of [() => Promise.reject(new Error('timeout')), () => { throw new Error('offline'); }]) {
    const env = harness({ probe });
    env.net.connect(); await failRounds(env, 12);
    assert.equal(env.net._gateProbeInFlight, false);
    assert.equal(env.reloads.length, 0);
    assert.equal(env.net.status, 'reconnecting');
  }
});

test('the gate probe does not replace the existing focus/latency probe', () => {
  const env = harness();
  let heartbeats = 0;
  env.net._heartbeat = () => { heartbeats++; };
  env.net.probe();
  assert.equal(heartbeats, 1);
  assert.equal(env.probes(), 0);
});
