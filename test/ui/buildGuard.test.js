// test/ui/buildGuard.test.js — public/js/ui/buildGuard.js: the "this page runs an outdated build" guard that lets a
// deploy reach a tab that was already open (a page keeps its imported ES modules for its whole lifetime — the reason a
// client-only battle fix stayed invisible on the reporting player's page).
//
// Review-driven contract: a check that cannot read a build NEVER reloads, a new build is acted on only after two checks
// in a row agree, and a match on screen is never thrown away — the guard waits for it (and its settlement) to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBuildOnce, startBuildGuard, fetchBuild, probeGateRequired, BUILD_CHECK_MS, BUILD_FETCH_TIMEOUT_MS,
  HEALTH_CACHE_MS, GATE_PROBE_URL, GATE_RELOAD_KEY } from '../../public/js/ui/buildGuard.js';

/** A fake fetch answering /healthz with `build` (null → the frame carries none). */
const fetchOf = (build) => async (url, init) => {
  assert.equal(url, '/healthz?build=1');
  assert.equal(init.cache, 'no-store');
  return { ok: true, status: 200, json: async () => ({ ok: true, build }) };
};

test('hidden tabs pause build polling, resume immediately and detach listeners on stop', async () => {
  const doc = new EventTarget(); doc.hidden = true;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  let tick, calls = 0, reloads = 0, build = 'aaa', clock = 0;
  const guard = startBuildGuard({ document: doc,
    fetchFn: async () => { calls++; return { ok: true, json: async () => ({ build }) }; },
    setInterval: fn => { tick = fn; return 1; }, clearInterval: () => {}, reload: () => reloads++,
    now: () => clock,
  });
  await settle(); tick(); await settle();
  assert.equal(calls, 0);
  assert.equal((await guard.check()).status, 'paused');
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(calls, 1); assert.equal(guard.known(), 'aaa');
  build = 'bbb'; await guard.check();
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  tick(); await settle(); assert.equal(calls, 2);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(reloads, 0, 'returning to a tab still requires two fresh agreeing checks');
  assert.equal(calls, 2, 'a resume inside the cache window does not re-ask the server');
  await guard.check(); assert.equal(reloads, 0, 'one server read after the resume is not two');
  await guard.check(); assert.equal(reloads, 1);
  doc.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(calls, 4, 'the reload ended the watch: a stopped guard never asks again');
  guard.stop();
});

test('build polling: a resume inside the cache window reuses the last read, and never counts it twice', async () => {
  const doc = new EventTarget(); doc.hidden = false;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  let calls = 0, reloads = 0, build = 'aaa', clock = 0;
  const guard = startBuildGuard({ document: doc,
    fetchFn: async () => { calls++; return { ok: true, json: async () => ({ build }) }; },
    setInterval: () => 1, clearInterval: () => {}, reload: () => reloads++,
    now: () => clock,
  });
  await settle();
  assert.equal(calls, 1, 'the page reads its build on load');
  build = 'bbb';
  clock += 1_000;
  doc.dispatchEvent(new Event('visibilitychange')); await settle();
  clock += 1_000;
  doc.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(calls, 1, 'two resumes inside the window are one server read');
  assert.equal(reloads, 0, 'and one read is not the two agreeing checks a reload needs');
  clock += HEALTH_CACHE_MS * 2;                                 // past the window the next read is real, and it agrees
  doc.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(calls, 2, 'a resume after the window reads the server');
  assert.equal(reloads, 0, 'a cached sighting before it was not the second confirmation');
  await guard.check(); assert.equal(reloads, 1);
  guard.stop();
});

test('a build request completing after the tab becomes hidden cannot reload it', async () => {
  const doc = new EventTarget(); doc.hidden = false;
  let respond, reloads = 0;
  const guard = startBuildGuard({ document: doc,
    fetchFn: () => new Promise(resolve => { respond = resolve; }),
    setInterval: () => 1, clearInterval: () => {}, reload: () => reloads++,
  });
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  respond({ok:true,json:async()=>({build:'aaa'})});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(guard.known(), null); assert.equal(reloads, 0); guard.stop();
});

test('fetchBuild: the tag, or null when unreachable / not reported / too slow', async () => {
  assert.equal(await fetchBuild(fetchOf('aaa')), 'aaa');
  assert.equal(await fetchBuild(async () => { throw new Error('offline'); }), null);
  assert.equal(await fetchBuild(async () => ({ ok: false, status: 503, json: async () => ({}) })), null);
  assert.equal(await fetchBuild(fetchOf(null)), null);
  // a request that never answers must not keep the guard waiting forever
  const t0 = Date.now();
  assert.equal(await fetchBuild(() => new Promise(() => {}), { timeoutMs: 20 }), null);
  assert.ok(Date.now() - t0 < BUILD_FETCH_TIMEOUT_MS, 'gives up on its own timeout');
});

test('checkBuildOnce: first sighting, unchanged, changed, and unknown when the server says nothing', async () => {
  assert.deepEqual(await checkBuildOnce({ fetchFn: fetchOf('aaa') }), { status: 'first', build: 'aaa' });
  assert.deepEqual(await checkBuildOnce({ fetchFn: fetchOf('aaa'), known: 'aaa' }), { status: 'current', build: 'aaa' });
  assert.deepEqual(await checkBuildOnce({ fetchFn: fetchOf('bbb'), known: 'aaa' }), { status: 'new', build: 'bbb' });
  assert.deepEqual(await checkBuildOnce({ fetchFn: async () => { throw new Error('offline'); }, known: 'aaa' }), { status: 'unknown', build: null });
});

/** A guard driven by hand: run the interval callback on demand. */
function manual({ inMatch = false } = {}) {
  const ticks = [];
  const calls = { reload: 0, stale: [] };
  let build = 'aaa';
  let reachable = true;
  let busy = inMatch;
  let clock = 0;                                               // the fake interval fires a minute apart
  const guard = startBuildGuard({
    fetchFn: async () => {
      if (!reachable) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ build }) };
    },
    reload: () => { calls.reload++; },
    inMatch: () => busy,
    setInterval: (fn) => { ticks.push(fn); return ticks.length; },
    clearInterval: () => {},
    now: () => clock,
    onStale: (info) => calls.stale.push(info),
  });
  return {
    calls, ticks, guard,
    setBuild: (b) => { build = b; },
    setReachable: (b) => { reachable = b; },
    setInMatch: (b) => { busy = b; },
    /** run the interval callback and let its await settle */
    tick: async () => { clock += BUILD_CHECK_MS; for (const fn of ticks) fn(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

test('startBuildGuard: records this page\'s build in memory, reloads once on a NEW build (after two agreeing checks)', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));                  // the immediate first check
  assert.equal(m.guard.known(), 'aaa');
  assert.equal(m.calls.reload, 0);
  await m.tick();
  assert.equal(m.calls.reload, 0, 'same build → no reload');
  m.setBuild('bbb');
  await m.tick();
  assert.equal(m.calls.reload, 0, 'one sighting is not enough: a half-copied deploy must not ping-pong the page');
  assert.equal(m.guard.stale(), false);
  await m.tick();
  assert.equal(m.calls.reload, 1, 'the same new build twice → the page reloads');
  assert.deepEqual(m.calls.stale, [{ build: 'bbb', known: 'aaa', waiting: false }]);
  await m.tick();
  assert.equal(m.calls.reload, 1, 'the guard stopped after reloading');
  assert.equal(m.guard.stale(), true);
});

test('startBuildGuard: a NEW build that is then not served twice is dropped (rolling deploy / reverts)', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));
  m.setBuild('bbb');
  await m.tick();
  m.setBuild('aaa');                                           // the fleet rolled back to this page's build
  await m.tick();
  m.setBuild('bbb');
  await m.tick();
  assert.equal(m.calls.reload, 0, 'never saw the same new build twice in a row');
});

test('startBuildGuard: an unreadable /healthz never reloads — not even after a new build was seen', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));
  m.setBuild('bbb');
  await m.tick();                                              // one sighting of the new build
  m.setReachable(false);                                       // …and now the server is restarting
  await m.tick();
  await m.tick();
  assert.equal(m.calls.reload, 0, 'a failed check is unknown, never a reason to reload');
  assert.equal(m.guard.stale(), false);
  m.setReachable(true);
  await m.tick();
  assert.equal(m.calls.reload, 0, 'the sightings must be consecutive: the failures in between reset the count');
  await m.tick();
  assert.equal(m.calls.reload, 1, 'two checks in a row agree → reload');
});

test('startBuildGuard: a match on screen is never thrown away — it waits for the match (and its settlement) to end', async () => {
  const m = manual({ inMatch: true });
  await new Promise((r) => setTimeout(r, 0));
  m.setBuild('bbb');
  await m.tick();
  await m.tick();
  assert.equal(m.calls.reload, 0, 'in a match: the reload waits');
  assert.equal(m.guard.stale(), true, 'the staleness is remembered');
  assert.deepEqual(m.calls.stale, [{ build: 'bbb', known: 'aaa', waiting: true }], 'the UI is told to offer a reload');
  await m.tick();
  assert.equal(m.calls.reload, 0);
  m.setInMatch(false);                                         // back in the lobby / room: the match is over
  await m.tick();
  assert.equal(m.calls.reload, 1, 'once nothing is at stake the page reloads');
});

test('startBuildGuard: stop() ends the watch', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));
  m.guard.stop();
  m.setBuild('bbb');
  await m.tick();
  await m.tick();
  assert.equal(m.calls.reload, 0);
  assert.equal(m.guard.stale(), false);
  assert.equal(BUILD_CHECK_MS, 60_000);
});

test('startBuildGuard: the HTML version remains the baseline when deployment precedes the first health check', async () => {
  const previous = globalThis.__spAssetVersion;
  globalThis.__spAssetVersion = 'old-page';
  let reloads = 0;
  const guard = startBuildGuard({ fetchFn: fetchOf('new-server'), reload: () => { reloads++; }, setInterval: () => 1, clearInterval() {} });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guard.known(), 'old-page');
    await guard.check();
    assert.equal(reloads, 1);
  } finally {
    guard.stop();
    if (previous === undefined) delete globalThis.__spAssetVersion;
    else globalThis.__spAssetVersion = previous;
  }
});

test('onHealth: told every /healthz body a check reads — what else the page reads of the server before any hello (DESIGN §32 P1a)', async () => {
  const bodies = [];
  const fetchFn = async () => ({ ok: true, json: async () => ({ build: 'aaa', content: { vanilla: 'c'.repeat(64), sets: 0, plugins: 2 } }) });
  assert.equal(await fetchBuild(fetchFn, { onHealth: (b) => bodies.push(b) }), 'aaa');
  assert.deepEqual(bodies.map((b) => b.content.plugins), [2]);
  assert.equal(await fetchBuild(fetchFn, { onHealth: () => { throw new Error('listener trouble'); } }), 'aaa', 'its listener cannot break the check');
  await checkBuildOnce({ fetchFn, onHealth: (b) => bodies.push(b) });
  assert.equal(bodies.length, 2);
  const g = startBuildGuard({ fetchFn, reload: () => {}, setInterval: () => 1, clearInterval: () => {}, onHealth: (b) => bodies.push(b) });
  for (let i = 0; i < 20 && bodies.length < 3; i++) await new Promise((r) => setTimeout(r, 1));
  g.stop();
  assert.equal(bodies.length, 3, 'the guard\'s first check hands it over');
  const main = (await import('node:fs')).readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /onHealth: \(h\) => \{ const n = pluginCount\(h\.content\); if \(n !== store\.get\(\)\.installedPlugins\) store\.set\(\{ installedPlugins: n \}\); \}/);
});


// ---------------------------------------------------------------------------------------------------------------
// A page the browser gate stopped admitting. nginx answers `return 444` (socket closed, no headers), so a client
// cannot see WHY `/healthz` failed. The status endpoint must explicitly confirm a missing/invalid cookie.
// ---------------------------------------------------------------------------------------------------------------

/** A guard whose /healthz and ungated probe fail independently. */
function gated({ inMatch = false, storage = null, now } = {}) {
  const ticks = [];
  const calls = { reload: 0, gate: [], recovered: [] };
  let build = 'aaa';
  let healthUp = true;
  let probeUp = true;
  let busy = inMatch;
  let clock = Date.now();                               // the fake interval fires a minute apart
  const currentTime = typeof now === 'function' ? now : () => clock;
  const guard = startBuildGuard({
    fetchFn: async (url) => {
      if (url === GATE_PROBE_URL) {
        if (!probeUp) throw new Error('offline');
        return new Response(null, {status: 200, headers: {'X-Gate-Required': '1'}});
      }
      assert.equal(url, '/healthz?build=1');
      if (!healthUp) throw new Error('connection closed without a response (nginx 444)');
      return { ok: true, status: 200, json: async () => ({ build }) };
    },
    reload: () => { calls.reload++; },
    inMatch: () => busy,
    storage,
    now: currentTime,
    setInterval: (fn) => { ticks.push(fn); return ticks.length; },
    clearInterval: () => {},
    onStale: () => {},
    onGateLost: (info) => calls.gate.push(info),
    onGateRecovered: () => calls.recovered.push(1),
  });
  return {
    calls, guard,
    setHealthUp: (v) => { healthUp = v; },
    setProbeUp: (v) => { probeUp = v; },
    setInMatch: (v) => { busy = v; },
    tick: async () => { clock += BUILD_CHECK_MS; for (const fn of ticks) fn(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('probeGateRequired: only the explicit status marker proves lost admission', async () => {
  assert.equal(await probeGateRequired(async (url) => { assert.equal(url, GATE_PROBE_URL); return new Response(null, {status: 200, headers: {'X-Gate-Required': '1'}}); }), true);
  assert.equal(await probeGateRequired(async () => ({ ok: false, status: 444 })), false);
  assert.equal(await probeGateRequired(async () => { throw new Error('offline'); }), false);
  assert.equal(await probeGateRequired(() => new Promise(() => {}), { timeoutMs: 20 }), false, 'a hanging probe is not an answer');
  for (const status of [200, 204, 404, 429, 503]) {
    assert.equal(await probeGateRequired(async () => new Response(null, { status })), false);
  }
  assert.equal(await probeGateRequired(async () => new Response(null,
    { status: 429, headers: { 'X-Gate-Required': '1' } })), false);
});

test('a lapsed gate cookie reloads the page after two agreeing refusals — the probe confirms lost admission', async () => {
  const g = gated();
  await settle();                                     // the immediate first check
  assert.equal(g.guard.known(), 'aaa');
  assert.equal(g.guard.gateLost(), false);
  g.setHealthUp(false);
  await g.tick();
  assert.equal(g.calls.reload, 0, 'one refusal is not enough');
  assert.equal(g.guard.gateLost(), false);
  await g.tick();
  assert.equal(g.calls.reload, 1, 'the gate explicitly requires a challenge: reload');
  assert.deepEqual(g.calls.gate, [{ waiting: false, exhausted: false }]);
  assert.equal(g.guard.gateLost(), true);
});

test('a server that is actually down never reloads — the ungated probe fails too', async () => {
  const g = gated();
  await settle();
  g.setHealthUp(false); g.setProbeUp(false);          // restarting / off the air
  await g.tick(); await g.tick(); await g.tick();
  assert.equal(g.calls.reload, 0, 'a failed check stays silent, exactly as before');
  assert.equal(g.guard.gateLost(), false);
  assert.deepEqual(g.calls.gate, []);
});

test('a lapsed gate cookie during a match waits for the match, and the banner is told to offer the reload', async () => {
  const g = gated({ inMatch: true });
  await settle();
  g.setHealthUp(false);
  await g.tick(); await g.tick();
  assert.equal(g.calls.reload, 0, 'a running game is never thrown away');
  assert.deepEqual(g.calls.gate, [{ waiting: true, exhausted: false }]);
  assert.equal(g.guard.gateLost(), true);
  g.setInMatch(false);                                // the match is over
  await g.tick();
  assert.equal(g.calls.reload, 1, 'once nothing is at stake the page reloads itself');
});

test('the automatic gate reload happens once per backoff window; after that the banner owns it', async () => {
  const store = new Map([[GATE_RELOAD_KEY, String(Date.now())]]);
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const g = gated({ storage });
  await settle();
  g.setHealthUp(false);
  await g.tick(); await g.tick();
  assert.equal(g.calls.reload, 0, 'this page already reloaded itself inside the window');
  assert.deepEqual(g.calls.gate, [{ waiting: false, exhausted: true }], 'so it hands the button to the player');
});

test('a refusal that clears up by itself never reloads, and clears the gate-lost flag', async () => {
  const g = gated({ inMatch: true });
  await settle();
  g.setHealthUp(false);
  await g.tick(); await g.tick();
  assert.equal(g.guard.gateLost(), true);
  g.setHealthUp(true);
  await g.tick();
  assert.equal(g.guard.gateLost(), false);
  assert.deepEqual(g.calls.recovered, [1]);
  assert.equal(g.calls.reload, 0);
});
