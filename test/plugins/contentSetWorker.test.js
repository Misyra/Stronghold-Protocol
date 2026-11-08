// test/plugins/contentSetWorker.test.js — SP_CONTENT_BUILD_WORKER (the content walk in a dedicated worker thread):
// the built set is byte-for-byte the main-thread build's (cs, index, served bodies, merged data, kitted, warnings,
// bounds — asserted on the real worker, not a double), the memo still pays once, a worker whose view of the plugins
// disagrees (drift) or a client close that lands mid-build falls back to the main-thread sliced build, a probe
// refusal still leaves nothing remembered, and the switch off spawns nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createContentSets } from '../../server/plugins/contentSets.js';
import { contentSetFiles, buildContentSet } from '../../server/plugins/contentSet.js';
import { fixture, bondPatch } from '../helpers/contentFixtures.js';
import { scriptFixture } from '../helpers/scriptFixtures.js';
import { ROOT } from '../../server/data.js';

const ON = () => { process.env.SP_CONTENT_BUILD_WORKER = '1'; };
const OFF = () => { delete process.env.SP_CONTENT_BUILD_WORKER; };
const withWorker = (t) => { ON(); t.after(OFF); };
const manager = (f, opts = {}) => createContentSets({
  registry: f.registry, vanillaData: { config: { modes: {} } },
  dirs: { publicDir: path.join(f.dir, 'public'), dataDir: path.join(ROOT, 'data'), packsDir: path.join(f.dir, 'packs'), pluginsDir: path.join(f.dir, 'plugins') },
  ...opts,
});
const putPatchPlugin = (f, value = 0.3) => f.put('data-demo', { data: ['patch.json'] }, { 'patch.json': bondPatch(value) });
const byRel = (files) => [...files.entries()].sort(([x], [y]) => (x < y ? -1 : 1));

test('a worker-built set is byte-for-byte the main-thread build (real worker)', async (t) => {
  withWorker(t);
  const a = fixture(t), b = fixture(t);
  putPatchPlugin(a); putPatchPlugin(b);
  const here = createContentSets({ registry: a.registry, vanillaData: { config: { modes: {} } } });
  t.after(() => here.close());
  const there = manager(b);
  t.after(() => there.close());
  const one = await here.resolve(['data-demo']);
  const two = await there.resolve(['data-demo']);
  assert.ok(one.ok && two.ok, JSON.stringify(one.error || two.error));
  assert.equal(here.stats().workerBuilds, 0, 'an injected-less manager without the switch builds here');
  assert.equal(there.stats().workerBuilds, 1, 'the switch on built in the worker');
  assert.ok(there._worker()?.alive);
  assert.equal(two.set.cs, one.set.cs);
  assert.deepEqual(JSON.parse(JSON.stringify(two.set.plugins)), JSON.parse(JSON.stringify(one.set.plugins)));
  const filesA = byRel(contentSetFiles(one.set));
  const filesB = byRel(contentSetFiles(two.set));
  assert.deepEqual(filesB.map(([rel]) => rel), filesA.map(([rel]) => rel));
  for (let i = 0; i < filesA.length; i++) {
    assert.equal(filesB[i][1].sha256, filesA[i][1].sha256, filesA[i][0]);
    assert.ok(filesB[i][1].body.equals(filesA[i][1].body), `${filesA[i][0]} bytes`);
  }
  assert.deepEqual(two.set.data, one.set.data);
  assert.deepEqual(two.set.kitted, one.set.kitted);
  assert.deepEqual(two.set.warnings, one.set.warnings);
  assert.deepEqual(two.set.bounds, one.set.bounds);
  assert.deepEqual(two.set.modes, one.set.modes);
  assert.deepEqual(two.set.hashInput, one.set.hashInput);
  assert.ok(Object.isFrozen(two.set.data) && Object.isFrozen(two.set.data.bonds) && Object.isFrozen(two.set.data.bonds.deputShip));
  assert.equal(two.set.data.bonds.deputShip.bb.base_def, 0.3);
  // a same-cs rebuild through the main builder finds the seeded C1 cache and answers the same set
  const again = await buildContentSet({ registry: b.registry, ids: ['data-demo'] });
  assert.equal(again.cs, two.set.cs);
});

test('the memo pays once; the hot path never asks the worker', async (t) => {
  withWorker(t);
  const f = fixture(t);
  putPatchPlugin(f);
  const sets = manager(f, { workerRecheckMs: 3.6e6 });
  t.after(() => sets.close());
  const one = await sets.resolve(['data-demo']);
  const two = await sets.resolve(['data-demo']);
  assert.ok(one.ok && two.ok);
  assert.equal(two.set, one.set, 'remembered');
  assert.equal(sets.stats().workerBuilds, 1);
  assert.equal(sets.stats().builds, 1);
});

test('a worker whose plugin view disagrees (drift) falls back to this thread, memo unpoisoned', async (t) => {
  withWorker(t);
  const f = fixture(t);
  const root = putPatchPlugin(f);
  const sets = manager(f, { workerRecheckMs: 3.6e6 }); // the worker registry never rescans within the test
  t.after(() => sets.close());
  const one = await sets.resolve(['data-demo']);
  assert.ok(one.ok);
  assert.equal(sets.stats().workerBuilds, 1);
  fs.writeFileSync(path.join(root, 'patch.json'), JSON.stringify(bondPatch(0.7)));
  f.registry.rescan();
  const two = await sets.resolve(['data-demo']);
  assert.ok(two.ok, JSON.stringify(two));
  assert.notEqual(two.set.cs, one.set.cs);
  assert.equal(two.set.data.bonds.deputShip.bb.base_def, 0.7);
  assert.equal(sets.stats().workerBuilds, 2);
  assert.equal(sets.stats().workerFallbacks, 1, 'the stale worker view was refused and the walk ran here');
  const three = await sets.resolve(['data-demo']);
  assert.equal(three.set, two.set, 'the fallback result is remembered like any other');
  assert.equal(sets.stats().workerBuilds, 2);
});

test('a client close landing mid-build falls back; the next build respawns the worker', async (t) => {
  withWorker(t);
  const f = fixture(t);
  f.put('data-demo', { data: ['patch.json'], settings: { def: { type: 'number', min: 0, max: 1, default: 0.5 } } }, { 'patch.json': bondPatch({ $setting: 'def' }) });
  const sets = manager(f);
  t.after(() => sets.close());
  const one = await sets.resolve(['data-demo']);
  assert.ok(one.ok);
  // the second build leaves its waiter registered synchronously (the post happens before the first await), so a
  // close() in the same tick always rejects the in-flight build — the caller falls back, byte for byte
  const second = sets.resolve([{ id: 'data-demo', settings: { def: 0.8 } }]);
  await sets._worker().close();
  const two = await second;
  assert.ok(two.ok, JSON.stringify(two));
  assert.equal(two.set.data.bonds.deputShip.bb.base_def, 0.8);
  assert.equal(sets.stats().workerFallbacks, 1);
  const three = await sets.resolve([{ id: 'data-demo', settings: { def: 0.6 } }]);
  assert.ok(three.ok);
  assert.equal(three.set.data.bonds.deputShip.bb.base_def, 0.6);
  assert.ok(sets._worker()?.alive, 'the next build respawned a worker');
});

test('a probe refusal is answered without keeping anything; a clean probe finalizes in the worker', async (t) => {
  withWorker(t);
  const bad = scriptFixture(t, { mode: 'trusted' });
  bad.put('bad', 'export default sp => { throw new Error("no"); };');
  const sets = manager({ dir: bad.root, registry: bad.registry, put: bad.put }, { workerScriptMode: 'trusted', workerScriptHost: '127.0.0.1' });
  t.after(() => sets.close());
  const refused = await sets.resolve(['bad']);
  assert.ok(!refused.ok, JSON.stringify(refused));
  assert.equal(sets.stats().builds, 1, 'the refused build is not remembered');
  const again = await sets.resolve(['bad']);
  assert.ok(!again.ok, JSON.stringify(again));
  assert.equal(sets.stats().builds, 2);
  assert.ok(sets._worker()?.alive, 'the worker survives a refusal');
  // a clean script set: pending → probe (the real child, on this thread) → finalize → the walked set — through the
  // worker, with no fallback (the counters say which side built it)
  const good = scriptFixture(t, { mode: 'trusted' });
  good.put('good', 'export default sp => { sp.kits.register("char_x_good",()=>({})); };');
  const goodSets = manager({ dir: good.root, registry: good.registry, put: good.put }, { workerScriptMode: 'trusted', workerScriptHost: '127.0.0.1' });
  t.after(() => goodSets.close());
  const ok = await goodSets.resolve(['good']);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(goodSets.stats().workerBuilds, 1);
  assert.equal(goodSets.stats().workerFallbacks, 0, 'the pending walk was finalized, not fallen back');
  assert.ok(ok.set.scripts?.length === 1 && ok.set.scripts[0].id === 'good');
  assert.equal(ok.set.execution, 'trusted');
});

test('settings ride through the worker build (normalized on this thread, applied in the walk)', async (t) => {
  withWorker(t);
  const f = fixture(t);
  f.put('data-demo', { data: ['patch.json'], settings: { def: { type: 'number', min: 0, max: 1, default: 0.5 } } }, { 'patch.json': bondPatch({ $setting: 'def' }) });
  const sets = manager(f);
  t.after(() => sets.close());
  const one = await sets.resolve(['data-demo']);
  const two = await sets.resolve([{ id: 'data-demo', settings: { def: 0.9, junk: 'dropped' } }]);
  assert.ok(one.ok && two.ok);
  assert.notEqual(two.set.cs, one.set.cs);
  assert.equal(two.set.data.bonds.deputShip.bb.base_def, 0.9);
  assert.equal(sets.stats().workerBuilds, 2);
});

test('the switch off (default) spawns no worker and answers as before', async (t) => {
  OFF();
  const f = fixture(t);
  putPatchPlugin(f);
  const sets = manager(f);
  t.after(() => sets.close());
  const one = await sets.resolve(['data-demo']);
  assert.ok(one.ok);
  assert.equal(sets._worker(), null);
  assert.equal(sets.stats().workerBuilds, 0);
  assert.equal(sets.stats().workerFallbacks, 0);
  assert.equal(one.set.data.bonds.deputShip.bb.base_def, 0.3);
  assert.ok(Object.isFrozen(one.set.data.bonds.deputShip));
});
