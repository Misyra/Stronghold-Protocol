// Main-thread watchdog (server/health/watchdog.js, ported from the Stardust fork): the unit level drives the worker's
// loop on an injected clock (progress resets the baseline, a short GC pause never fires, the JSON line is written and
// the SIGKILL comes strictly after it), and the end-to-end level runs real children — a main thread that spins (or
// blocks in Atomics.wait) is captured through the inspector WITHOUT --inspect and killed, one that keeps answering is
// left alone, and stop() ends the watch. Incident that shaped it: Stardust game-08, 2026-11-04 — a 维多利亚 payout
// held the main thread at 100 % for 1 h 43 min.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWatchLoop, watchdogMs, startMainWatchdog, WATCHDOG_DEFAULT_MS, WATCHDOG_MIN_MS, WATCHDOG_MAX_MS }
  from '../server/health/watchdog.js';

const MODULE = new URL('../server/health/watchdog.js', import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('watchdogMs: unset = 30 s, 0 = off, the 5 s / 600 s bounds hold, out of bounds = the default', () => {
  assert.equal(WATCHDOG_DEFAULT_MS, 30_000);
  assert.equal(WATCHDOG_MIN_MS, 5_000);
  assert.equal(WATCHDOG_MAX_MS, 600_000);
  assert.equal(watchdogMs(undefined), WATCHDOG_DEFAULT_MS);
  assert.equal(watchdogMs(null), WATCHDOG_DEFAULT_MS);
  assert.equal(watchdogMs(''), WATCHDOG_DEFAULT_MS);
  assert.equal(watchdogMs('   '), WATCHDOG_DEFAULT_MS);
  assert.equal(watchdogMs('0'), 0);
  assert.equal(watchdogMs(0), 0);
  assert.equal(watchdogMs('5000'), 5_000);
  assert.equal(watchdogMs('600000'), 600_000);
  assert.equal(watchdogMs('45000'), 45_000);
  // Number() quirks kept from the fork: scientific notation within bounds is a value, junk is the default
  assert.equal(watchdogMs('1.5e4'), 15_000);
  for (const bad of ['100', '4999', '600001', 'x', '-1', '30s', NaN]) assert.equal(watchdogMs(bad), WATCHDOG_DEFAULT_MS, String(bad));
});

/** A runWatchLoop over a fake clock: `beat()` is the main thread's heartbeat, `tick()` one check of the worker. */
function harness({ thresholdMs = 30_000, captureMs, capture = async () => [{ fn: 'payForever', at: 'server/x.js:1:1' }] } = {}) {
  const shared = new SharedArrayBuffer(4), counter = new Int32Array(shared);
  const ops = []; // ['beat' … 'write' / 'kill'] in call order — the write-before-kill order is the contract
  let t = 0, tick = null;
  const captureCalls = [];
  const loop = runWatchLoop({
    counter, thresholdMs, checkMs: 100, ...(captureMs !== undefined ? { captureMs } : {}),
    now: () => t,
    schedule: (fn) => { tick = fn; return fn; },
    unschedule: () => { tick = null; },
    capture: (ms, root) => { captureCalls.push({ ms, root }); return capture(ms, root); },
    write: (line) => { ops.push(['write', line]); },
    kill: () => { ops.push(['kill']); },
    rss: () => 12345678, uptime: () => 42.5,
  });
  return {
    loop, ops, captureCalls,
    beat: () => { Atomics.add(counter, 0, 1); ops.push(['beat']); },
    advance: (ms) => { t += ms; },
    tick: () => tick?.(),
    /** Drain the microtask queue until fire()'s async chain has fully landed (a macrotask boundary is enough). */
    settle: () => new Promise((r) => setImmediate(r)),
    get time() { return t; },
  };
}

test('a main thread that keeps answering never fires (each beat resets the baseline)', async () => {
  const h = harness();
  for (let i = 0; i < 600; i++) { h.beat(); h.advance(100); h.tick(); } // 60 s of healthy beats over a 30 s threshold
  assert.deepEqual(h.ops.filter(([op]) => op === 'write' || op === 'kill'), []);
});

test('a short GC pause (silent, but under the threshold) does not fire; the beats resume', async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) { h.beat(); h.advance(100); h.tick(); }
  h.advance(2000); // one 2 s pause on a 30 s threshold
  h.tick(); h.tick();
  assert.deepEqual(h.ops.filter(([op]) => op === 'write' || op === 'kill'), []);
  h.beat(); h.advance(100); h.tick(); // the loop comes back
  h.advance(29_000); h.tick(); // 29 s after the resume: still under
  assert.deepEqual(h.ops.filter(([op]) => op === 'write' || op === 'kill'), []);
});

test('silence past the threshold fires once: the line is written BEFORE the kill, with the shape the docs promise', async () => {
  const h = harness({ captureMs: 1234 });
  for (let i = 0; i < 10; i++) { h.beat(); h.advance(100); h.tick(); }
  h.advance(30_000); h.tick(); // exactly the threshold
  await h.settle();
  const fired = h.ops.filter(([op]) => op === 'write' || op === 'kill');
  assert.equal(fired.length, 2);
  assert.equal(fired[0][0], 'write');
  assert.equal(fired[1][0], 'kill');
  h.tick(); h.advance(60_000); h.tick(); // firing guards re-entry: no second line, no second kill
  await h.settle();
  assert.equal(h.ops.filter(([op]) => op === 'kill').length, 1);

  const [write] = fired;
  const line = write[1];
  assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'), 'one single line');
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, 'watchdog');
  assert.equal(parsed.role, 'server');
  assert.ok(parsed.blockedMs >= 30_000, String(parsed.blockedMs));
  assert.equal(parsed.thresholdMs, 30_000);
  assert.equal(parsed.captured, true);
  assert.deepEqual(parsed.frames, [{ fn: 'payForever', at: 'server/x.js:1:1' }]);
  assert.equal(parsed.rssBytes, 12345678);
  assert.equal(parsed.uptimeSec, 42.5);
  assert.deepEqual(h.captureCalls, [{ ms: 1234, root: '' }], 'the capture got its budget');
});

test('a capture that answers null (or throws) still writes the line and still kills', async () => {
  for (const bad of [async () => null, () => { throw new Error('no inspector'); }]) {
    const h = harness({ capture: bad });
    h.advance(30_000); h.tick();
    await h.settle(); await h.settle();
    const fired = h.ops.filter(([op]) => op === 'write' || op === 'kill');
    assert.equal(fired.length, 2, h.ops.join());
    assert.equal(fired[0][0], 'write');
    assert.equal(fired[1][0], 'kill');
    const parsed = JSON.parse(fired[0][1]);
    assert.equal(parsed.captured, false);
    assert.deepEqual(parsed.frames, []);
  }
});

test('a write that fails does not stop the kill', async () => {
  const shared = new SharedArrayBuffer(4), counter = new Int32Array(shared);
  const kills = [];
  let tick = null, t = 0;
  const loop = runWatchLoop({
    counter, thresholdMs: 30_000, checkMs: 100, now: () => t,
    schedule: (fn) => { tick = fn; return fn; }, unschedule: () => {},
    capture: async () => null,
    write: () => { throw new Error('fd 1 gone'); },
    kill: () => { kills.push(1); },
  });
  assert.ok(loop);
  t = 30_000;
  tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(kills.length, 1);
});

test('runWatchLoop refuses to run without an explicit write and kill (a test must not bet the real fd 1)', () => {
  const counter = new Int32Array(new SharedArrayBuffer(4));
  assert.throws(() => runWatchLoop({ counter, thresholdMs: 30_000, checkMs: 100 }), TypeError);
  assert.throws(() => runWatchLoop({ counter, thresholdMs: 30_000, checkMs: 100, write: () => {} }), TypeError);
});

test('startMainWatchdog: 0 = off, below 200 is a contract error, a healthy main thread is left alone and stop() ends it', async () => {
  assert.equal(startMainWatchdog({ thresholdMs: 0 }), null);
  assert.throws(() => startMainWatchdog({ thresholdMs: 100 }), RangeError);
  // Real worker, real beat: the process lives far past the threshold while the beats run, and after stop() the
  // terminated worker cannot fire even though the beats have stopped — surviving this is the assertion.
  const w = startMainWatchdog({ thresholdMs: 400, role: 'test' });
  assert.ok(w && typeof w.stop === 'function');
  await sleep(1300);
  await w.stop();
  await sleep(700); // the beats stopped with stop(); a worker that survived terminate() would SIGKILL this test process
});

/** Run `source` as an ES module file in a child process (the watchdog runs in the real server process entry). */
function run(source, ms = 20_000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-watchdog-')), file = path.join(dir, 'child.mjs');
  writeFileSync(file, source);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child did not end: ${out} ${err}`)); }, ms);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('a main thread that never yields is captured (no --inspect anywhere) and killed', async () => {
  const started = Date.now();
  const r = await run(`
    import { startMainWatchdog } from ${JSON.stringify(MODULE)};
    startMainWatchdog({ thresholdMs: 500, role: 'game' });
    function payForever() { let n = 0; for (;;) n++; }
    setTimeout(function spinSoon() { payForever(); }, 100);
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.signal, 'SIGKILL', `${r.code} ${r.err}`);
  const lines = r.out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, r.out);
  const [line] = lines;
  assert.equal(line.event, 'watchdog');
  assert.equal(line.role, 'game');
  assert.equal(line.captured, true);
  assert.ok(line.blockedMs >= 500, String(line.blockedMs));
  assert.equal(line.thresholdMs, 500);
  assert.ok(line.frames.length >= 2 && line.frames.length <= 30);
  assert.equal(line.frames[0].fn, 'payForever');
  assert.ok(line.frames.some((f) => f.fn === 'spinSoon'));
  assert.match(line.frames[0].at, /child\.mjs:\d+:\d+$/);
  // the fields this port adds: the process's RSS and uptime, so the operator sees size and age at once
  assert.ok(Number.isFinite(line.rssBytes) && line.rssBytes > 0, String(line.rssBytes));
  assert.ok(Number.isFinite(line.uptimeSec) && line.uptimeSec >= 0, String(line.uptimeSec));
  assert.ok(Date.now() - started < 15_000);
});

test('a main thread blocked in Atomics.wait is interrupted and captured too (the native-block shape)', async () => {
  const r = await run(`
    import { startMainWatchdog } from ${JSON.stringify(MODULE)};
    startMainWatchdog({ thresholdMs: 500, role: 'game' });
    setTimeout(function blockSoon() {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }, 100);
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.signal, 'SIGKILL', `${r.code} ${r.err}`);
  const [line] = r.out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(line.event, 'watchdog');
  assert.equal(line.captured, true, r.out);
  assert.ok(line.blockedMs >= 500, String(line.blockedMs));
  assert.ok(line.frames.some((f) => f.fn === 'blockSoon'), JSON.stringify(line.frames));
});

test('a main thread that keeps answering is left alone, and stop() ends the watch', async () => {
  const r = await run(`
    import { startMainWatchdog } from ${JSON.stringify(MODULE)};
    const w = startMainWatchdog({ thresholdMs: 600, role: 'game' });
    const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
    let left = 8;
    const step = () => { busy(150); if (--left > 0) setTimeout(step, 50); else w.stop().then(() => console.log('stopped')); };
    setTimeout(step, 50);
  `);
  assert.equal(r.signal, null, r.out);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'stopped');
  assert.ok(!r.out.includes('"watchdog"'), r.out);
});
