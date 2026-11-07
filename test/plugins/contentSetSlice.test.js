// test/plugins/contentSetSlice.test.js — the sliced data half of C1 (DESIGN §37.135; server/plugins/contentSet.js
// composeGen/finalizeGen + driveSliced): a build pauses between blocks (per data file, per plugin, per document, per
// stage, per table) so the event loop breathes while a big composition is built. The walk itself is the pre-slice
// synchronous one, so the red lines here are: a sliced build and a fully synchronous one return the same bytes and
// the same problems (SP_CONTENT_SLICE_MS=0 is the rollback and the reference); composes queue and the vanilla
// official-bounds snapshot is re-installed after every pause, so concurrent builds never interleave; failures
// propagate unchanged; and the resolve memo still pays a build once (contentSets.js over the real, now async, builder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContentSet, contentSetFiles, checkContentSetDataOnly } from '../../server/plugins/contentSet.js';
import { createContentSets } from '../../server/plugins/contentSets.js';
import { fixture, guard, bondPatch } from '../helpers/contentFixtures.js';

// The template guard record speaks the data_demo namespace (char_x_data_demo_guard), so the wide plugin is data-demo.
const WIDE_MANIFEST = { data: ['patch.json'], operators: ['op.json'], i18n: { en: 'i18n/en.json' }, sourceLang: 'zh',
  settings: { def: { type: 'number', min: 0, max: 1, default: 0.5 } } };
const WIDE_DOCS = () => ({
  'patch.json': bondPatch({ $setting: 'def' }),
  'op.json': guard(),
  'i18n/en.json': { version: 1, lang: 'en', files: { chess: { chess_x_data_demo_guard_a: { name: 'Wide guard' } } } },
});
/** The same plugin folders in two fixtures: a build's caches (base, cs) are per registry, so an equality check needs
 * two registries over identical content. */
const populate = (f, { withBase = false } = {}) => {
  if (withBase) f.put('base-pack', { data: ['base.json'] }, { 'base.json': bondPatch(0.4) });
  f.put('data-demo', withBase ? { ...WIDE_MANIFEST, requires: { 'base-pack': '*' } } : WIDE_MANIFEST, WIDE_DOCS());
};

test('a sliced build and a fully synchronous one produce the identical set (bytes, cs, index, data)', async t => {
  const a = fixture(t), b = fixture(t);
  populate(a, { withBase: true });
  populate(b, { withBase: true });
  a.put('other', { data: ['p.json'], loadAfter: ['base-pack'] }, { 'p.json': bondPatch(0.9) });
  b.put('other', { data: ['p.json'], loadAfter: ['base-pack'] }, { 'p.json': bondPatch(0.9) });
  const plain = await buildContentSet({ registry: a.registry, ids: ['data-demo', 'other'], slice: { budgetMs: 0 } });
  const sliced = await buildContentSet({ registry: b.registry, ids: ['data-demo', 'other'] });
  assert.deepEqual(sliced.problems, [], JSON.stringify(sliced.problems));
  assert.equal(sliced.cs, plain.cs, 'same composition hash');
  assert.deepEqual(sliced.data, plain.data, 'same merged data');
  assert.deepEqual(sliced.index, plain.index, 'same manifest index');
  assert.deepEqual(sliced.kitted, plain.kitted);
  assert.deepEqual(sliced.warnings, plain.warnings);
  assert.deepEqual(sliced.bounds, plain.bounds, 'same official-bounds snapshot');
  const fa = contentSetFiles(plain), fb = contentSetFiles(sliced);
  assert.equal(fb.size, fa.size);
  for (const [rel, f] of fa) assert.ok(fb.get(rel).body.equals(f.body), rel);
  assert.ok(Object.isFrozen(sliced.data.chess), 'the sliced set is frozen like the synchronous one');
});

test('the walk really pauses: a zero budget awaits nothing, a tiny budget with a jumping clock awaits at every pause', async t => {
  const f = fixture(t);
  populate(f, { withBase: true });
  let steps = 0;
  const never = await buildContentSet({ registry: f.registry, ids: ['data-demo'], slice: { budgetMs: 0, step: () => { steps++; } } });
  assert.deepEqual(never.problems, []);
  assert.equal(steps, 0, 'budget 0: the pre-slice behavior, no event-loop turn');
  const f2 = fixture(t);
  populate(f2, { withBase: true });
  steps = 0;
  let n = 0;
  // a clock that jumps more than the budget on every look: every pause the walk offers becomes an await
  const always = await buildContentSet({ registry: f2.registry, ids: ['data-demo'], slice: { budgetMs: 1, clock: () => ++n, step: () => { steps++; } } });
  assert.deepEqual(always.problems, []);
  assert.equal(always.cs, never.cs);
  assert.ok(steps >= 10, `a multi-part build pauses between blocks (got ${steps} awaits)`);
});

test('SP_CONTENT_SLICE_MS=0 rolls the default build back to the fully synchronous walk', async t => {
  const saved = process.env.SP_CONTENT_SLICE_MS;
  try {
    const f = fixture(t);
    populate(f);
    const reference = await buildContentSet({ registry: f.registry, ids: ['data-demo'], slice: { budgetMs: 0 } });
    const f2 = fixture(t);
    populate(f2);
    process.env.SP_CONTENT_SLICE_MS = '0';
    let steps = 0;
    const rolled = await buildContentSet({ registry: f2.registry, ids: ['data-demo'], slice: { step: () => { steps++; } } });
    assert.equal(rolled.cs, reference.cs);
    assert.equal(steps, 0, 'no awaits under the env rollback');
    const f3 = fixture(t);
    populate(f3);
    process.env.SP_CONTENT_SLICE_MS = 'garbage';
    const defaulted = await buildContentSet({ registry: f3.registry, ids: ['data-demo'], slice: { step: () => { steps++; } } });
    assert.equal(defaulted.cs, reference.cs);
    assert.ok(steps > 0, 'an unusable env value falls back to the default budget (pauses taken)');
  } finally {
    if (saved === undefined) delete process.env.SP_CONTENT_SLICE_MS;
    else process.env.SP_CONTENT_SLICE_MS = saved;
  }
});

test('failures propagate through the pauses unchanged: refusals, per-op problems, thrown errors, a build after a failure', async t => {
  const forced = { budgetMs: 1, clock: (() => { let n = 0; return () => ++n; })(), step: () => {} };
  const a = fixture(t), b = fixture(t);
  for (const f of [a, b]) {
    populate(f);
    f.put('bad-i18n', { data: ['p.json'], i18n: { en: 'en.json' } }, { 'p.json': bondPatch(), 'en.json': { version: 1, lang: 'en', files: { chess: { missing: { name: 'bad' } } } } });
  }
  const plain = await buildContentSet({ registry: a.registry, ids: ['data-demo', 'bad-i18n'], slice: { budgetMs: 0 } });
  const refused = await buildContentSet({ registry: b.registry, ids: ['data-demo', 'bad-i18n'], slice: forced });
  assert.equal(refused.problems[0].code, 'PLUGIN_I18N');
  assert.deepEqual(refused.problems, plain.problems, 'the same refusal sliced and unsliced');
  assert.equal(refused.cs, undefined);
  // a bad $setting is applyPatches' per-op problem (it never reaches the walk's catch) — the same sliced and unsliced
  for (const f of [a, b]) f.put('setting', { data: ['p.json'], settings: {} }, { 'p.json': bondPatch({ $setting: 'nope' }) });
  const plainSetting = await buildContentSet({ registry: a.registry, ids: ['data-demo', 'setting'], slice: { budgetMs: 0 } });
  const slicedSetting = await buildContentSet({ registry: b.registry, ids: ['data-demo', 'setting'], slice: forced });
  assert.ok(slicedSetting.problems.every(p => p.code === 'PLUGIN_PATCH_SETTING'), JSON.stringify(slicedSetting.problems));
  assert.deepEqual(slicedSetting.problems, plainSetting.problems);
  assert.equal(slicedSetting.cs, undefined);
  // a throw inside the walk itself (a registry whose plugin() throws) is the PLUGIN_CONTENT_FORMAT envelope
  const bomb = { contentDirs: a.registry.contentDirs, plugin: () => { throw new Error('boom'); } };
  const thrown = await buildContentSet({ registry: bomb, ids: ['data-demo'], slice: forced });
  assert.deepEqual(thrown.problems.map(p => p.code), ['PLUGIN_CONTENT_FORMAT']);
  assert.match(thrown.problems[0].message, /boom/);
  // the queue is not poisoned by the failure: the next build answers normally
  const after = await buildContentSet({ registry: b.registry, ids: ['data-demo'] });
  assert.deepEqual(after.problems, []);
  assert.match(after.cs, /^[0-9a-f]{64}$/);
});

test('concurrent builds never interleave: two compositions built at once match their sequential results', async t => {
  const a = fixture(t), b = fixture(t);
  for (const f of [a, b]) {
    populate(f);
    f.put('other', { data: ['p.json'], loadAfter: ['data-demo'] }, { 'p.json': bondPatch(0.77) });
  }
  const seqWide = await buildContentSet({ registry: a.registry, ids: ['data-demo'] });
  const seqBoth = await buildContentSet({ registry: a.registry, ids: ['data-demo', 'other'] });
  const [parWide, parBoth] = await Promise.all([
    buildContentSet({ registry: b.registry, ids: ['data-demo'] }),
    buildContentSet({ registry: b.registry, ids: ['data-demo', 'other'] }),
  ]);
  assert.equal(parWide.cs, seqWide.cs);
  assert.equal(parBoth.cs, seqBoth.cs);
  for (const [rel, f] of contentSetFiles(seqBoth)) assert.ok(contentSetFiles(parBoth).get(rel).body.equals(f.body), rel);
});

test('the resolve memo still pays one build per (ids, settings) over the sliced builder', async t => {
  const f = fixture(t);
  populate(f);
  const sets = createContentSets({ registry: f.registry, vanillaData: { config: { modes: {} } }, build: buildContentSet, filesOf: contentSetFiles });
  const one = await sets.resolve(['data-demo']);
  assert.ok(one.ok, JSON.stringify(one));
  const again = await sets.resolve(['data-demo']);
  assert.equal(again.set, one.set, 'remembered — the same object');
  assert.equal(sets.stats().builds, 1);
  const other = await sets.resolve([{ id: 'data-demo', settings: { def: 0.7 } }]);
  assert.notEqual(other.set, one.set);
  assert.notEqual(other.set.cs, one.set.cs);
  assert.equal(sets.stats().builds, 2);
});

test('checkContentSetDataOnly stays synchronous: the value is not a promise and matches the walk', async t => {
  const f = fixture(t);
  populate(f);
  const checked = checkContentSetDataOnly({ registry: f.registry, ids: ['data-demo'] });
  assert.equal(typeof checked.then, 'undefined', 'a plain object, not a thenable');
  assert.deepEqual(checked.problems, []);
  assert.ok(checked.data && checked.data.bonds, 'the data half result is in hand synchronously');
  const f2 = fixture(t);
  f2.put('bad-i18n', { data: ['p.json'], i18n: { en: 'en.json' } }, { 'p.json': bondPatch(), 'en.json': { version: 1, lang: 'en', files: { chess: { missing: { name: 'bad' } } } } });
  const refused = checkContentSetDataOnly({ registry: f2.registry, ids: ['bad-i18n'] });
  assert.equal(refused.problems[0].code, 'PLUGIN_I18N');
});
