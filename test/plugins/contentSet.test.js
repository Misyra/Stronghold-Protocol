import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildContentSet, contentSetFiles } from '../../server/plugins/contentSet.js';
import { computeVanillaContent, nodeSha256 } from '../../server/plugins/identity.js';
import { DATA_SHIM_JS } from '../../server/http/static.js';
import { contentHashOf } from '../../shared/plugins/identity.js';
import { applyFileOverlay } from '../../shared/i18nData.js';
import { fixture, guard, bondPatch } from '../helpers/contentFixtures.js';
const build = f => buildContentSet({ registry: f.registry, ids: ['data-demo'] });
test('vanilla identity and index are exactly P0; original data bytes are preserved', t => {
  const f = fixture(t), s = buildContentSet({ registry: f.registry });
  const p0 = computeVanillaContent({ simDir: 'server/sim', sharedDir: 'shared', dataDir: 'data', shim: DATA_SHIM_JS });
  assert.equal(s.cs, p0.cs); assert.deepEqual(s.index, p0.index); assert.equal(s.vanilla, true);
  for (const [rel, file] of contentSetFiles(s)) if (rel.startsWith('data/')) assert.ok(file.body.equals(fs.readFileSync(rel)), rel);
});
test('loaded content, deterministic hashes, frozen snapshot, raw-byte hashing and reload', t => {
  const f = fixture(t), root = f.put('data-demo', { data: ['patch.json'] }, { 'patch.json': bondPatch() });
  assert.equal(f.registry.plugin('data-demo').status, 'loaded');
  const s = build(f); assert.deepEqual(s.problems, []); assert.equal(s.data.bonds.deputShip.bb.base_def, 0.3);
  assert.equal(build(f), s); assert.ok(Object.isFrozen(s.data.bonds.deputShip));
  assert.equal(contentHashOf({ ...s.index, data: Object.fromEntries(Object.entries(s.index.data).map(([k,v]) => [k,v.sha256])) }), s.cs);
  for (const [rel, file] of contentSetFiles(s)) { assert.equal(nodeSha256(file.body), file.sha256, rel); assert.equal(file.body.length, file.bytes); }
  fs.appendFileSync(root + '/patch.json', ' '); f.registry.rescan(); const next = build(f);
  assert.notEqual(next.cs, s.cs, 'one whitespace byte changes the plugin identity');
  assert.equal(s.data.bonds.deputShip.bb.base_def, 0.3);
  const files = contentSetFiles(s); files.get('data/bonds.json').body.fill(0);
  assert.notEqual(contentSetFiles(s).get('data/bonds.json').body[0], 0);
});
test('settings normalize into cs, and dependency order is stable', t => {
  const f = fixture(t);
  f.put('base-pack', { data: ['base.json'] }, { 'base.json': bondPatch(0.4) });
  f.put('data-demo', { data: ['patch.json'], requires: { 'base-pack': '*' }, settings: { def: { type: 'number', min: 0, max: 1, default: 0.5 } } }, { 'patch.json': bondPatch({ $setting: 'def' }) });
  const s = build(f); assert.deepEqual(s.problems, []); assert.deepEqual(s.plugins.map(p => p.id), ['base-pack', 'data-demo']);
  assert.equal(s.data.bonds.deputShip.bb.base_def, 0.5); assert.equal(s.warnings[0].code, 'PLUGIN_PATCH_OVERRIDE');
  const changed = buildContentSet({ registry: f.registry, ids: [{ id: 'data-demo', settings: { def: 0.7 } }] });
  assert.notEqual(changed.cs, s.cs); assert.equal(changed.data.bonds.deputShip.bb.base_def, 0.7);
});
test('template, mode inheritance and plugin stage ground paths compose together', t => {
  const f = fixture(t);
  f.put('data-demo', { operators: ['op.json'], data: ['records.json'] }, { 'op.json': guard(), 'records.json': { records: 1, entries: [
    { file: 'stages', id: 'stage_x_data_demo_one', base: 'act1autochess_m01' },
    { file: 'modes', id: 'mode_x_data_demo_one', base: 'mode_single_normal', set: { stages: ['stage_x_data_demo_one'], economy: { refreshPrice: 0 } } },
  ] } });
  const s = build(f); assert.deepEqual(s.problems, []);
  assert.ok(Object.keys(s.data.stages.stage_x_data_demo_one.groundPaths).length > 0);
  assert.ok(s.modes.some(m => m.modeId === 'mode_x_data_demo_one')); assert.ok(s.kitted.includes('char_x_data_demo_guard'));
});
test('translations get current source hashes, retain unrelated language text, stay out of sim data', t => {
  const f = fixture(t);
  f.put('data-demo', { operators: ['op.json'], i18n: { en: 'i18n/en.json' }, sourceLang: 'zh' }, {
    'op.json': guard(), 'i18n/en.json': { version: 1, lang: 'en', files: { chess: { chess_x_data_demo_guard_a: { name: 'Demo guard' } } } },
  });
  const s = build(f); assert.deepEqual(s.problems, []);
  const overlay = JSON.parse(contentSetFiles(s).get('i18n/en.json').body);
  assert.equal(applyFileOverlay(s.data.chess, overlay.files.chess).value.chess_x_data_demo_guard_a.name, 'Demo guard');
  assert.equal(s.data.chess.chess_x_data_demo_guard_a.name, '演示守卫');
  assert.ok(overlay.files.chess.chess_char_1_01_a);
});
test('bad i18n leaf refuses the entire combination', t => {
  const f = fixture(t); f.put('data-demo', { i18n: { en: 'en.json' } }, { 'en.json': { version: 1, lang: 'en', files: { chess: { missing: { name: 'bad' } } } } });
  assert.equal(build(f).problems[0].code, 'PLUGIN_I18N'); assert.equal(build(f).cs, undefined);
});
test('missing permission, map deletion, foreign namespace and undeclared cross-plugin writes are refused', t => {
  const f = fixture(t);
  f.put('data-demo', { permissions: ['data.add'], data: ['p.json'] }, { 'p.json': bondPatch() });
  assert.equal(build(f).problems[0].code, 'PLUGIN_CONTENT_PERMISSION');
  f.put('data-demo', { data: ['p.json'] }, { 'p.json': { patch: 1, ops: [{ op: 'set', file: 'config', path: ['modes'], value: {} }] } });
  assert.equal(build(f).problems[0].code, 'PLUGIN_RECORD_DELETE');
  f.put('data-demo', { data: ['p.json'] }, { 'p.json': { patch: 1, ops: [{ op: 'merge', file: 'config', path: ['modes'], value: { stolen: {} } }] } });
  assert.equal(build(f).problems[0].code, 'PLUGIN_RECORD_ID');
  f.put('base-pack', { data: ['p.json'] }, { 'p.json': { records: 1, entries: [{ file: 'modes', id: 'mode_x_base_pack_one', base: 'mode_single_normal' }] } });
  f.put('data-demo', { data: ['p.json'], loadAfter: ['base-pack'] }, { 'p.json': { patch: 1, ops: [{ op: 'set', file: 'config', path: ['modes', 'mode_x_base_pack_one', 'name'], value: 'Changed' }] } });
  const s = buildContentSet({ registry: f.registry, ids: ['data-demo', 'base-pack'] });
  assert.ok(s.problems.some(p => p.code === 'PLUGIN_DEPENDENCY'));
});
test('invalid documents, JSON and DSL are skipped without loading code', t => {
  const f = fixture(t);
  for (const [manifest, doc, want] of [
    [{ data: ['p.json'] }, {}, 'PLUGIN_CONTENT_FORMAT'],
    [{ data: ['p.json'] }, '{', 'PLUGIN_CONTENT_FILE'],
    [{ dsl: ['p.json'], permissions: ['dsl'] }, {}, 'PLUGIN_DSL_UNAVAILABLE'],
  ]) { f.put('data-demo', manifest, { 'p.json': doc }); assert.equal(f.registry.plugin('data-demo'), null); assert.ok(f.registry.report().skipped.some(p => p.problems.some(s => s.includes(want)))); }
  assert.equal(buildContentSet({ registry: f.registry, ids: {} }).problems[0].code, 'PLUGIN_CONTENT_FORMAT');
});

test('cosmetic-only selection remains the P0 set; mixed content dependencies resolve without changing gameplay order', t => {
  const f = fixture(t);
  f.put('art-pack', { class: 'cosmetic', permissions: ['assets.override'], assets: { chars: { char_102_texas: { avatar: { ref: 'char_112_siege' } } } } });
  const vanilla = buildContentSet({ registry: f.registry });
  const cosmetic = buildContentSet({ registry: f.registry, ids: ['art-pack'] });
  assert.deepEqual(cosmetic.problems, []); assert.equal(cosmetic.cs, vanilla.cs);
  f.put('data-demo', { data: ['p.json'], requires: { 'art-pack': '*' } }, { 'p.json': bondPatch() });
  const s = build(f); assert.deepEqual(s.problems, []); assert.deepEqual(s.plugins.map(p => p.id), ['data-demo']);
});
