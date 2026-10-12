// test/ui/plugins-client.test.js — the browser side of the cosmetic plugins (DESIGN §32 P1a): the cosmetic layers of
// public/js/assets.js (the installation's manifest → the room's visual set, which takes its place → the personal
// plugins on top; the same object while nothing changed; the asset store's helpers and onChange follow them), data.js's
// view of `assets`, public/js/content.js (a visual set's document fetched, parsed and checked against the room's vs —
// retried when the network failed, refused when its composition does not hash to it; the room layer follows
// room.state.content.vs and goes with the room, a late answer for a room left is dropped; the personal plugins come from
// the catalogue's vs of each, a plugin the server lacks is skipped, nothing is fetched while none is switched on), the
// 插件 panel's facts (ui/pluginPanel.js) and the room screen's tag.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCosmeticLayers, createAssets } from '../../public/js/assets.js';
import { createDataStore } from '../../public/js/data.js';
import { createStore } from '../../public/js/store.js';
import {
  fetchVisualDoc, installContent, personal, setPersonalPlugin, catalog, loadCatalog, cosmeticPlugins, unofficialPlugins, pluginName, PERSONAL_PREF,
} from '../../public/js/content.js';
import { roomPluginFacts, nextChoice, sizeText, pluginTagText, pluginMicro } from '../../public/js/ui/pluginPanel.js';
import { visualHashOf } from '../../shared/plugins/visual.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = { version: 1, chars: { char_102_texas: { avatar: '/assets/~1111111111111111/texas.png' }, char_112_siege: { avatar: '/assets/siege.png' } } };
const composition = (id) => ({ assets: 'aa'.repeat(32), overlays: [{ id, version: '1.0.0', files: { 'plugin.json': 'bb'.repeat(32) } }] });
const visualOf = (id) => { const c = composition(id); return { v: 1, vs: visualHashOf(c), ...c }; };
/** The room's effective manifest of a set of one plugin that paints Texas red. */
const roomDoc = (id = 'red') => ({ ...BASE, chars: { ...BASE.chars, char_102_texas: { avatar: `/p/${id}/01234567/a.png` } }, visual: visualOf(id) });
const overlayDoc = (id, ops) => ({ visual: visualOf(id), ops });
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (pred, what) => { for (let i = 0; i < 200; i++) { if (pred()) return; await tick(); } assert.fail(`timed out: ${what}`); };

describe('the cosmetic layers (public/js/assets.js)', () => {
  test('base → the room\'s manifest (in its place) → personal writes on top; the same object while nothing changed', () => {
    const layers = createCosmeticLayers();
    assert.equal(layers.apply(BASE), BASE, 'no layer: the base itself');
    let told = 0;
    layers.subscribe(() => told++);
    const room = roomDoc();
    layers.setRoom(room);
    assert.equal(layers.apply(BASE), room);
    layers.setPersonal([{ id: 'mine', ops: [{ at: ['chars', 'char_112_siege', 'avatar'], value: '/p/mine/89abcdef/m.png' }] }]);
    const eff = layers.apply(BASE);
    assert.equal(eff.chars.char_102_texas.avatar, '/p/red/01234567/a.png', 'the room\'s art');
    assert.equal(eff.chars.char_112_siege.avatar, '/p/mine/89abcdef/m.png', 'the personal plugin over it');
    assert.equal(room.chars.char_112_siege.avatar, '/assets/siege.png', 'the room\'s document is never changed');
    assert.equal(layers.apply(BASE), eff, 'memoised');
    layers.setRoom(room);
    assert.equal(told, 2, 'the same room again tells nobody');
    layers.setRoom(null);
    assert.equal(layers.apply(BASE).chars.char_102_texas.avatar, BASE.chars.char_102_texas.avatar, 'the room gone: its art too');
    layers.setPersonal([]);
    assert.equal(layers.apply(BASE), BASE);
    assert.equal(layers.active, false);
  });

  test('the memo is per base object: data.js\'s copy and the store\'s each keep theirs', () => {
    const layers = createCosmeticLayers();
    layers.setPersonal([{ id: 'mine', ops: [{ at: ['chars', 'char_112_siege', 'avatar'], value: '/p/mine/89abcdef/m.png' }] }]);
    const other = JSON.parse(JSON.stringify(BASE));
    const a = layers.apply(BASE);
    const b = layers.apply(other);
    assert.notEqual(a, b);
    assert.equal(layers.apply(BASE), a, 'alternating bases: each still memoised');
    assert.equal(layers.apply(other), b);
    assert.equal(layers.apply(undefined), layers.apply(undefined), 'no manifest yet: one empty base');
  });

  test('the asset store reads through its layers and tells its listeners like a late manifest', () => {
    const layers = createCosmeticLayers();
    const store = createAssets({ manifest: BASE, cosmetics: layers, fetch: async () => res(404, {}) });
    const heard = [];
    store.onChange((w) => heard.push(w));
    assert.equal(store.avatar('char_102_texas'), BASE.chars.char_102_texas.avatar);
    layers.setRoom(roomDoc());
    assert.deepEqual(heard, ['manifest']);
    assert.equal(store.avatar('char_102_texas'), '/p/red/01234567/a.png');
    assert.equal(store.manifest.chars.char_102_texas.avatar, '/p/red/01234567/a.png', 'manifest: what the helpers read');
    assert.equal(createAssets({ manifest: BASE }).avatar('char_102_texas'), BASE.chars.char_102_texas.avatar, 'a store without layers');
  });

  test('data.js shows a file through a view: get() through it, getRaw() as downloaded; setView tells the subscribers', async () => {
    const d = createDataStore({ fetch: async () => res(200, BASE), retryDelays: [], timeoutMs: 0 });
    await d.load('assets');
    const heard = [];
    d.subscribe((n) => heard.push(n));
    const layers = createCosmeticLayers();
    layers.setRoom(roomDoc());
    d.setView('assets', (v) => layers.apply(v));
    assert.deepEqual(heard, ['assets']);
    assert.equal(d.get('assets').chars.char_102_texas.avatar, '/p/red/01234567/a.png');
    assert.equal(d.getRaw('assets').chars.char_102_texas.avatar, BASE.chars.char_102_texas.avatar);
    d.setView('assets', null);
    assert.equal(d.get('assets'), d.getRaw('assets'));
  });
});

describe('content.js', () => {
  test('fetchVisualDoc: as text, parsed, checked against the vs; a network failure or 5xx retried, a 404 or a bad composition refused', async () => {
    const doc = roomDoc();
    const vs = doc.visual.vs;
    const urls = [];
    const ok = await fetchVisualDoc('assets', vs, { fetch: async (u, init) => { urls.push([u, init.cache]); return res(200, doc); } });
    assert.deepEqual(ok, { doc });
    assert.deepEqual(urls, [[`/vs/${vs.slice(0, 16)}/assets.json`, 'no-cache']]);
    let n = 0;
    const flaky = await fetchVisualDoc('overlay', vs, { retryDelays: [0, 0], wait: async () => {}, fetch: async () => { n++; if (n === 1) throw new Error('offline'); if (n === 2) return res(503, ''); return res(200, doc); } });
    assert.deepEqual([flaky.doc === undefined, n], [false, 3]);
    assert.match((await fetchVisualDoc('assets', vs, { fetch: async () => res(404, '') })).error, /HTTP 404/);
    assert.match((await fetchVisualDoc('assets', 'cd'.repeat(32), { fetch: async () => res(200, doc) })).error, /names another set/);
    assert.match((await fetchVisualDoc('assets', vs, { fetch: async () => res(200, '{"nope') })).error, /not JSON/);
    assert.match((await fetchVisualDoc('assets', 'short')).error, /no visual hash/);
    // an attempt that never answers is given up after the timeout (and tried again like a network error)
    let tries = 0;
    const stalled = await fetchVisualDoc('assets', vs, { timeoutMs: 20, retryDelays: [0], wait: async () => {}, fetch: () => { tries++; return new Promise(() => {}); } });
    assert.deepEqual([stalled.error, tries], [`/vs/${vs.slice(0, 16)}/assets.json: unreachable`, 2]);
  });

  test('installContent: the room layer follows room.state.content.vs, goes with the room, ignores a late answer, says a failure once', async () => {
    const app = createStore({ room: null });
    const data = createDataStore({ fetch: async () => res(200, BASE), retryDelays: [], timeoutMs: 0 });
    await data.load('assets');
    const layers = createCosmeticLayers();
    const red = roomDoc('red');
    const blue = roomDoc('blue');
    const pending = new Map();
    const fetch = (u) => new Promise((resolve) => pending.set(u, resolve));
    const toasts = [];
    const off = installContent({ store: app, data, layers, fetch, toast: (text, kind) => toasts.push([text, kind]), retryDelays: [] });
    assert.equal(pending.size, 0, 'no room, no personal plugin: nothing is fetched');
    app.set({ room: { code: 'ABCD', content: { cs: 'ee'.repeat(32), vanilla: true, vs: red.visual.vs, plugins: [{ id: 'red' }] } } });
    const redUrl = `/vs/${red.visual.vs.slice(0, 16)}/assets.json`;
    assert.ok(pending.has(redUrl));
    // the room changes to blue before red's document arrives: red's late answer is dropped
    app.set({ room: { code: 'ABCD', content: { cs: 'ee'.repeat(32), vanilla: true, vs: blue.visual.vs, plugins: [{ id: 'blue' }] } } });
    pending.get(redUrl)(res(200, red));
    pending.get(`/vs/${blue.visual.vs.slice(0, 16)}/assets.json`)(res(200, blue));
    await until(() => layers.room === null ? false : layers.room.visual.vs === blue.visual.vs, 'blue applied');
    await tick();
    assert.equal(layers.room.visual.vs, blue.visual.vs, 'never the late red');
    assert.equal(data.get('assets').chars.char_102_texas.avatar, '/p/blue/01234567/a.png', 'every data.get(\'assets\') of the interface draws it');
    // leaving the room: its art goes too
    app.set({ room: null });
    assert.equal(layers.room, null);
    assert.equal(data.get('assets').chars.char_102_texas.avatar, BASE.chars.char_102_texas.avatar);
    // a document that fails its check: the original art, one toast
    const bad = roomDoc('bad');
    app.set({ room: { content: { vs: 'ab'.repeat(32) } } });
    pending.get(`/vs/${'ab'.repeat(8)}/assets.json`)(res(200, bad));
    await until(() => toasts.length === 1, 'the toast');
    assert.equal(layers.room, null);
    assert.equal(toasts[0][1], 'warn');
    off();
    assert.equal(data.get('assets'), data.getRaw('assets'), 'uninstalled: the file as downloaded');
  });

  test('installContent: the personal plugins come from the catalogue\'s vs of each, in its order; a missing one is skipped', async () => {
    const mine = overlayDoc('mine', [{ at: ['chars', 'char_112_siege', 'avatar'], value: '/p/mine/89abcdef/m.png' }]);
    const zed = overlayDoc('zed', [{ at: ['chars', 'char_112_siege', 'avatar'], value: '/p/zed/11111111/z.png' }]);
    const entries = [
      { id: 'mine', class: 'cosmetic', status: 'loaded', scope: ['personal'], vs: mine.visual.vs, unofficial: true },
      { id: 'room-only', class: 'cosmetic', status: 'loaded', scope: ['room'], vs: 'cc'.repeat(32), unofficial: true },
      { id: 'zed', class: 'cosmetic', status: 'loaded', scope: ['room', 'personal'], vs: zed.visual.vs, unofficial: true },
    ];
    const asked = [];
    const fetch = async (u, init) => {
      asked.push(u);
      if (u === '/plugins/index.json') { assert.equal(init.cache, 'no-store'); return res(200, { version: 1, app: '0.3.0-dev', plugins: entries }); }
      if (u === `/vs/${mine.visual.vs.slice(0, 16)}/overlay.json`) return res(200, mine);
      if (u === `/vs/${zed.visual.vs.slice(0, 16)}/overlay.json`) return res(200, zed);
      return res(404, '');
    };
    catalog.set({ status: 'idle', plugins: [], app: null, at: 0 });
    personal.set({ ids: [] });
    const layers = createCosmeticLayers();
    const data = createDataStore({ fetch: async () => res(200, BASE), retryDelays: [], timeoutMs: 0 });
    await data.load('assets');
    const off = installContent({ store: createStore({ room: null }), data, layers, fetch, retryDelays: [] });
    await tick();
    assert.deepEqual(asked, [], 'no personal plugin switched on: not even the catalogue');
    setPersonalPlugin('zed', true);
    setPersonalPlugin('mine', true);
    setPersonalPlugin('gone', true);
    assert.deepEqual(personal.get().ids, ['gone', 'mine', 'zed']);
    await until(() => layers.personal.length === 2, 'two personal plugins');
    assert.deepEqual(layers.personal.map((p) => p.id), ['mine', 'zed'], 'the catalogue\'s order; a plugin the server lacks is skipped');
    assert.equal(data.get('assets').chars.char_112_siege.avatar, '/p/zed/11111111/z.png', 'the later one applies');
    assert.ok(!asked.some((u) => u.includes('cc'.repeat(8))), 'a room-only plugin is never a personal one');
    setPersonalPlugin('zed', false);
    await until(() => layers.personal.length === 1, 'one left');
    assert.equal(data.get('assets').chars.char_112_siege.avatar, '/p/mine/89abcdef/m.png');
    setPersonalPlugin('mine', false);
    setPersonalPlugin('gone', false);
    await until(() => layers.personal.length === 0, 'none');
    off();
    assert.equal(PERSONAL_PREF, 'cosmetics');
  });

  test('loadCatalog: shared while on its way, a failure keeps what was there; the helpers pick the right entries', async () => {
    catalog.set({ status: 'idle', plugins: [], app: null, at: 0 });
    let n = 0;
    const body = { plugins: [{ id: 'a', class: 'cosmetic', status: 'loaded', scope: ['room'], unofficial: true, names: { zh: '甲', en: 'A' }, name: '甲' },
      { id: 'b', class: 'content', status: 'planned', unofficial: true, name: 'B' }, { id: 'en', class: 'lang', status: 'loaded', name: 'English' }] };
    const fetch = async () => { n++; return res(200, body); };
    const [x, y] = await Promise.all([loadCatalog({ fetch }), loadCatalog({ fetch })]);
    assert.equal(n, 1);
    assert.equal(x, y);
    assert.equal(catalog.get().status, 'ready');
    await loadCatalog({ fetch });
    assert.equal(n, 1, 'ready: not again unless forced');
    await loadCatalog({ fetch: async () => { throw new Error('offline'); }, force: true });
    assert.deepEqual([catalog.get().status, catalog.get().plugins.length], ['ready', 3], 'a failure keeps the list');
    assert.deepEqual(cosmeticPlugins(body.plugins, 'room').map((p) => p.id), ['a']);
    assert.deepEqual(cosmeticPlugins(body.plugins, 'personal'), []);
    assert.deepEqual(unofficialPlugins(body.plugins).map((p) => p.id), ['a', 'b'], 'the title screen counts every plugin but a language');
    assert.equal(pluginName(body.plugins[0]), '甲', 'the interface language (Chinese here)');
    assert.equal(pluginName({ id: 'x' }), 'x');
  });
});

describe('the 插件 panel (ui/pluginPanel.js) and the room screen', () => {
  const room = (content, o = {}) => ({ code: 'ABCD', hostId: 'h', mode: 'coop', inMatch: false, content, ...o });
  const set = { cs: 'ee'.repeat(32), vanilla: true, vs: 'ff'.repeat(32), plugins: [{ id: 'a', version: '1.0.0', class: 'cosmetic', hash: '0123456789abcdef' }, { id: 'b', auto: true }],
    warnings: [{ code: 'override', params: { path: 'chars.x.avatar', plugins: ['a', 'b'] } }], bytes: 2048 };

  test('the facts: count, what is on and automatic, who may switch (the host, outside a match), the warnings', () => {
    const f = roomPluginFacts(room(set), 'h');
    assert.deepEqual([f.count, [...f.on], [...f.auto], f.chosen, f.editable, f.warnings.length, f.vs], [2, ['a', 'b'], ['b'], ['a'], true, 1, 'ff'.repeat(32)]);
    assert.equal(roomPluginFacts(room(set), 'g').editable, false, 'another player reads it');
    assert.equal(roomPluginFacts(room(set, { inMatch: true }), 'h').editable, false, 'not during a match');
    assert.deepEqual([roomPluginFacts(room({ cs: 'ee'.repeat(32), vanilla: true, plugins: [] }), 'h').count, roomPluginFacts(null, 'h').count], [0, 0]);
    assert.deepEqual(nextChoice(['a'], 'c', true), ['a', 'c']);
    assert.deepEqual(nextChoice(['a', 'c'], 'a', false), ['c']);
    // a plugin the server no longer offers is never sent again (else every switch is refused); its own switch turns it off
    assert.deepEqual(nextChoice(['gone', 'a'], 'c', true, new Set(['a', 'c'])), ['a', 'c']);
    assert.deepEqual(nextChoice(['gone', 'a'], 'gone', false, new Set(['a'])), ['a']);
    assert.deepEqual(nextChoice(['gone', 'a'], 'c', true, null), ['gone', 'a', 'c'], 'the catalogue not loaded: the choice as it is');
    assert.equal(pluginTagText(room(set)), '插件 ×2');
    assert.equal(pluginTagText(room({ plugins: [] })), '原版');
    assert.deepEqual([sizeText(2048), sizeText(3 * 1048576), sizeText(NaN)], ['2 KB', '3.0 MB', '']);
    assert.equal(pluginMicro({ id: 'a', version: '1.0.0', artBytes: 4096 }), 'a · v1.0.0 · 4 KB');
  });

  test('the room screen shows the tag under its title; the settings show 外观插件; the texts are in every pack', () => {
    const roomSrc = readFileSync(path.join(ROOT, 'public/js/screens/room.js'), 'utf8');
    assert.match(roomSrc, /<\$\{PluginTag\} room=\$\{room\} myId=\$\{me\.playerId\} \/>/);
    const settingsSrc = readFileSync(path.join(ROOT, 'public/js/ui/settings.js'), 'utf8');
    assert.match(settingsSrc, /<\$\{CosmeticSection\} \/>/);
    for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
      const pack = JSON.parse(readFileSync(path.join(ROOT, `public/i18n/${lang}.json`), 'utf8'));
      for (const k of ['原版', '插件 ×{n}', '外观插件', '本服务器安装了 {n} 个插件', '非官方', '本服务器没有安装该插件']) assert.ok(pack[k], `${lang}: ${k}`);
    }
  });
});
