// Regression: RefLru under the production spine config, fast scene-switch churn with instant loads.
// Invariant under test: a value handed out by acquire() must stay the cached value (peek(key) === value) and must
// never be unloaded while refs > 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { RefLru } = await import('../public/js/assets.js');

test('production-config churn: handed-out values stay live and identical while referenced', async () => {
  const now = { t: 0 };
  const timers = new Set();
  const timersApi = {
    set: (fn, ms) => { const t = { fn, at: now.t + ms }; timers.add(t); return t; },
    clear: (t) => timers.delete(t),
  };
  const unloadLog = [];
  const cache = new RefLru({
    load: async (key) => { return { key, animations: [{ name: 'Idle' }], weightBytes: 3 * 1024 * 1024 }; },
    unload: (key, value) => { unloadLog.push({ key, value, at: now.t }); },
    max: 60,
    timeout: 20000,
    concurrency: 6,
    failTtl: 60000,
    weigh: (k, v) => v.weightBytes,
    maxIdleWeight: 48 * 1024 * 1024,
    quietWeight: 0,
    idleGrace: 15000,
    quietDelay: 3000,
    evictDelay: 1000,
    timers: timersApi,
    now: () => now.t,
  });

  const pumpTimers = async (until) => {
    for (;;) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > until) return;
      timers.delete(next);
      now.t = Math.max(now.t, next.at);
      next.fn();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
  };

  // 3 scenes (players' fields) sharing a pool of models, like 联防 boards do
  const pool = Array.from({ length: 40 }, (_, i) => `skel${i}`);
  const scene = (n) => Array.from({ length: 20 }, (_, i) => pool[(n * 7 + i) % pool.length]);
  const scenes = [scene(0), scene(1), scene(2)];

  const refs = new Map();   // key -> outstanding references held by my pseudo-views
  const live = new Map();   // key -> the value my outstanding references hold
  const acquire = (list) => {
    const held = list.map((k) => cache.acquire(k, { skel: `${k}.skel` }));
    return Promise.all(held).then((values) => {
      list.forEach((k, i) => { refs.set(k, (refs.get(k) || 0) + 1); live.set(k, values[i]); });
      return values;
    });
  };
  const release = (list) => {
    for (const k of list) {
      cache.release(k);
      const n = (refs.get(k) || 0) - 1;
      if (n <= 0) { refs.delete(k); live.delete(k); } else refs.set(k, n);
    }
  };
  for (let round = 0; round < 30; round++) {
    release(scenes[(round + 2) % 3]);                 // switch away: old scene's views go
    const list = scenes[round % 3];
    await acquire(list);
    // same-tick re-acquire of the shared models (snapshot builds all views in one frame)
    // let sweeps run while this scene is on screen (frames pass, battle runs)
    await pumpTimers(now.t + 17000);
    for (const [k, v] of live) {
      const e = cache.map.get(k);
      assert.ok(e && e.state === 'ready' && e.refs > 0, `${k} (${round}) live entry must stay ready+referenced`);
      assert.equal(cache.peek(k), v, `${k} (${round}): peek must return the handed-out instance`);
    }
    for (const { key, value } of unloadLog) {
      if (live.has(key)) assert.notEqual(live.get(key), value, `${key} (${round}): unloaded a value a view still holds`);
    }
    unloadLog.length = 0;
  }
});
