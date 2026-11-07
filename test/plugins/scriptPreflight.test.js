// test/plugins/scriptPreflight.test.js — the probe moved off the main thread (DESIGN §32.10 revision): preflightScripts
// awaits a child (spawn, SIGKILL at the ceiling, the same failure messages), concurrent builds of one cache key share
// one child, and warmupScriptProbes fills the cache in the background so a restart's first plugin room does not pay it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scriptFixture } from '../helpers/scriptFixtures.js';
import { buildContentSet } from '../../server/plugins/contentSet.js';
import { preflightScripts, warmupScriptProbes, scriptProbeInput, SCRIPT_PROBE_TIMEOUT_MS } from '../../server/plugins/scriptPreflight.js';

const counter = (t, name) => {
  const f = scriptFixture(t);
  const file = path.join(f.root, `${name}.txt`);
  return { f, file, source: (register) => `export default sp => {
    global['pro'+'cess'].getBuiltinModule('fs').appendFileSync(${JSON.stringify(file)},'x');
    ${register}
  }` };
};

test('concurrent builds of one probe key share one child', async t => {
  const { f, file, source } = counter(t, 'dedup');
  f.put('dedup', source(`sp.kits.register('char_x_dedup',()=>({}));`));
  // Both builds compose synchronously and then await the same key: the in-flight map hands the second one the first
  // child's promise instead of spawning its own.
  const [a, b] = await Promise.all([
    buildContentSet({ registry: f.registry, ids: ['dedup'] }),
    buildContentSet({ registry: f.registry, ids: ['dedup'] }),
  ]);
  assert.deepEqual(a.problems, []);
  assert.deepEqual(b.problems, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x', 'one probe child for two concurrent builds');
});

test('concurrent preflightScripts calls share one child (scriptProbeInput keys like the builder)', async t => {
  const { f, file, source } = counter(t, 'dedup-direct');
  f.put('dedup2', source(`sp.kits.register('char_x_dedup2',()=>({}));`));
  const p = f.registry.plugin('dedup2');
  const { script, part } = scriptProbeInput(p);
  const hashInput = { plugins: [part], settings: { dedup2: {} } };
  const [a, b] = await Promise.all([
    preflightScripts(f.registry, [script], hashInput),
    preflightScripts(f.registry, [script], hashInput),
  ]);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x', 'one probe child for two concurrent preflights');
});

test('a hung setup is still SIGKILLed at the ceiling, the message is unchanged, the failure is cached', { timeout: 30000 }, async t => {
  const { f, file, source } = counter(t, 'hang');
  f.put('hang', source(`while (true) {}`));
  const probeInput = () => {
    const { script, part } = scriptProbeInput(f.registry.plugin('hang'));
    return [script, { plugins: [part], settings: { hang: {} } }];
  };
  const [script, hashInput] = probeInput();
  const report = await preflightScripts(f.registry, [script], hashInput);
  assert.equal(report.code, 'PLUGIN_SCRIPT_CHECK');
  assert.equal(report.message,
    `script setup exceeded ${SCRIPT_PROBE_TIMEOUT_MS} ms; child terminated (SIGKILL); a slow or busy server can raise SP_SCRIPT_PROBE_MS`);
  // the failed report is cached: a second ask for the same key does not spawn again
  const [script2, hashInput2] = probeInput();
  const again = await preflightScripts(f.registry, [script2], hashInput2);
  assert.equal(again.code, 'PLUGIN_SCRIPT_CHECK');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x', 'the second ask read the cached failure');
});

test('warmupScriptProbes fills the cache in the background; a build then shares that probe', async t => {
  const { f, file, source } = counter(t, 'warm');
  f.put('warm', source(`sp.kits.register('char_x_warm_'+(sp.settings.n??0),()=>({}));`), { settings: { n: { type: 'integer', min: 0, max: 3, default: 0 } } });
  warmupScriptProbes(f.registry, { warn() {} });
  // The warmup probe is in flight; the build normalizes the manifest's default settings to the same cache key and
  // awaits the same child instead of spawning its own.
  const set = await buildContentSet({ registry: f.registry, ids: ['warm'] });
  assert.deepEqual(set.problems, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x', 'the warmup child served the first build');
  // Already cached (id, hash, settings): a repeat warms nothing.
  warmupScriptProbes(f.registry, { warn() {} });
  const again = await buildContentSet({ registry: f.registry, ids: ['warm'] });
  assert.deepEqual(again.problems, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x', 'the repeated warmup found the cached report');
});

test('warmupScriptProbes never throws and never blocks the caller', async t => {
  assert.doesNotThrow(() => warmupScriptProbes(null));
  assert.doesNotThrow(() => warmupScriptProbes({ plugins: () => { throw new Error('scan blew up'); } }));
  assert.doesNotThrow(() => warmupScriptProbes({ plugins: () => [null, { id: 'x' }, { id: 'y', status: 'disabled' }] }));
});
