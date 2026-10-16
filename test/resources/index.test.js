// test/resources/index.test.js — the preload controller (public/js/resources/index.js, docs/ASSETS.md「Preload」):
// settings → manifest → Service Worker → Cache Storage, with the browser APIs (fetch, caches, navigator.serviceWorker,
// localStorage) stubbed. One test walks the whole lifecycle, because the controller is a module-level singleton.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_NAME, MANIFEST_URL, SW_URL, cacheName } from '../../public/js/resources/common.js';
import { DOWNLOAD_LOCK } from '../../public/js/resources/index.js';
import { createHash } from 'node:crypto';
import { ResourceStore } from '../../public/js/resources/store.js';
import { exportResourceZip } from '../../public/js/resources/archive.js';

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async put(request, response) { this.entries.set(typeof request === 'string' ? request : request.url, response.clone()); }
  async match(request) { const hit = this.entries.get(typeof request === 'string' ? request : request.url); return hit ? hit.clone() : undefined; }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(request) { return this.entries.delete(typeof request === 'string' ? request : request.url); }
}
class MemoryCaches {
  constructor() { this.map = new Map(); }
  async open(name) { if (!this.map.has(name)) this.map.set(name, new MemoryCache()); return this.map.get(name); }
  async keys() { return [...this.map.keys()]; }
  async delete(name) { return this.map.delete(name); }
}

const ORIGIN = 'https://game.example';

test('controller carries the independent voice scope and English/Korean language through to downloads', async (t) => {
  const files = ['cn', 'en', 'kr'].map((lang) => ({ url: `/assets/audio/voice/${lang}/x.mp3`, tier: 2, size: 4 }));
  files.push({ url: '/assets/audio/bgm/x.mp3', tier: 2, size: 4 });
  const env = stubEnv({ manifest: { ...MANIFEST, files, count: 4, tier1: 0, sized: 4, totalBytes: 16 } });
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?independent-voice');
  await mod.syncResources(true, false, 'en', false, { voices: true, fx: false });
  assert.deepEqual(env.calls.fetch.slice(1), [ORIGIN + '/assets/audio/voice/en/x.mp3']);
  await mod.syncResources(true, false, 'kr', false, { voices: true, fx: false });
  assert.equal(mod.resourceState().voiceLang, 'kr');
  assert.equal(mod.resourceState().voices, true);
  assert.equal(env.calls.fetch.at(-1), ORIGIN + '/assets/audio/voice/kr/x.mp3');
  await mod.syncResources(true, true, 'kr', false, { voices: false, fx: false });
  assert.equal(env.calls.fetch.at(-1), ORIGIN + '/assets/audio/bgm/x.mp3');
  assert.equal(mod.resourceState().groups.find((g) => g.id === 'voice').wanted, 0);
  await mod.syncResources(false);
});
const FILES = [
  // the real manifest is sorted essential-first (server/resources.js) — the fixture mirrors that
  { url: '/assets/audio/bgm.mp3', tier: 1, size: 6 },
  { url: '/assets/ui/panel.png', tier: 1, size: 4 },
  { url: '/assets/char/portrait.png', tier: 2, size: 5 },
  { url: '/assets/spine/op/x/front/x.skel', tier: 2, size: 7 },
];
const MANIFEST = { format: 1, version: 'testversion', count: FILES.length, tier1: 2, sized: FILES.length, totalBytes: 22, files: FILES };

test('required-only preload stops after visuals; opting in later downloads only missing optional files', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?optional-selection');
  await mod.inspectResources();
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL]);
  assert.equal(env.calls.registered.length, 0, 'opening the manager does not enable preloading');
  await mod.syncResources(true, false);
  assert.deepEqual(env.calls.fetch.slice(1), FILES.filter((f) => f.tier === 1).map((f) => ORIGIN + f.url));
  assert.equal(mod.resourceState().selectionComplete, true);
  // The optional tier is out of scope, so 「这次选择」 is the required tier alone — and the two flags still separate the
  // two states the panel words differently (全部已保存 / 必备已保存).
  assert.equal(mod.resourceState().requiredComplete, true);
  assert.equal(mod.resourceState().tier2Wanted, 0);
  assert.match(mod.resourceState().message, /必备资源已预载完成/);
  const count = env.calls.fetch.length;
  await mod.startResources();
  assert.equal(env.calls.fetch.length, count, 'resuming a completed required tier does not fetch optional files');
  await mod.syncResources(true, true);
  assert.deepEqual(env.calls.fetch.slice(count), FILES.filter((f) => f.tier === 2).map((f) => ORIGIN + f.url));
  assert.equal(mod.resourceState().complete, true);
  await mod.syncResources(false);
});

test('干员皮肤: the saved selection decides which outfits are fetched, on its own switch', async (t) => {
  const files = [
    { url: '/assets/ui/panel.png', tier: 1, size: 4 },
    { url: '/assets/audio/voice/cn/x.mp3', tier: 2, size: 6 },
    { url: '/assets/spine/op/kalts/boc/boc.skel', tier: 2, size: 7, skin: 'char_003_kalts/char_003_kalts@boc#6' },
    { url: '/assets/char/avatar/skin/kalts_boc.png', tier: 2, size: 5, skin: 'char_003_kalts/char_003_kalts@boc#6' },
    { url: '/assets/spine/op/amiya/winter/winter.skel', tier: 2, size: 8, skin: 'char_002_amiya/char_002_amiya_winter_1' },
  ];
  const env = stubEnv({ manifest: { ...MANIFEST, files, count: files.length, tier1: 1, sized: files.length, totalBytes: 30 } });
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?skin-selection');
  // 额外资源 off + one picked outfit: that outfit only — never a voice, never another outfit.
  await mod.syncResources(true, false, 'cn', false, ['char_003_kalts/char_003_kalts@boc#6']);
  assert.deepEqual(env.calls.fetch.slice(1).sort(), [
    ORIGIN + '/assets/ui/panel.png',
    ORIGIN + '/assets/char/avatar/skin/kalts_boc.png',
    ORIGIN + '/assets/spine/op/kalts/boc/boc.skel',
  ].sort());
  assert.ok(!env.calls.fetch.some((url) => url.includes('/voice/')), 'a skin pick never drags the voices in');
  assert.deepEqual(mod.resourceState().skinScope.keys, ['char_003_kalts/char_003_kalts@boc#6']);
  assert.equal(mod.resourceState().selectionComplete, true, 'the picked outfit is what this selection asked for');
  // Equipping a second outfit in 干员调配 is the auto-download path: only that outfit's files are fetched.
  const count = env.calls.fetch.length;
  await mod.syncResources(true, false, 'cn', false, ['char_003_kalts/char_003_kalts@boc#6', 'char_002_amiya/char_002_amiya_winter_1']);
  assert.deepEqual(env.calls.fetch.slice(count), [ORIGIN + '/assets/spine/op/amiya/winter/winter.skel']);
  // Taking it back off: nothing new is fetched, and what is cached stays (cleaning owns that decision).
  await mod.syncResources(true, false, 'cn', false, []);
  assert.equal(env.calls.fetch.length, count + 1);
  assert.deepEqual(mod.resourceState().skinScope.keys, []);
  await mod.syncResources(false);
});

test('干员皮肤 全部皮肤: the scope widens to every outfit in the manifest, and narrows back to the loadout', async (t) => {
  const files = [
    { url: '/assets/ui/panel.png', tier: 1, size: 4 },
    { url: '/assets/audio/voice/cn/x.mp3', tier: 2, size: 6 },
    { url: '/assets/spine/op/kalts/boc/boc.skel', tier: 2, size: 7, skin: 'char_003_kalts/char_003_kalts@boc#6' },
    { url: '/assets/char/avatar/skin/kalts_boc.png', tier: 2, size: 5, skin: 'char_003_kalts/char_003_kalts@boc#6' },
    { url: '/assets/spine/op/amiya/winter/winter.skel', tier: 2, size: 8, skin: 'char_002_amiya/char_002_amiya_winter_1' },
  ];
  const env = stubEnv({ manifest: { ...MANIFEST, files, count: files.length, tier1: 1, sized: files.length, totalBytes: 30 } });
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?skin-all');
  await mod.syncResources(true, false, 'cn', false, { all: true });
  assert.deepEqual(env.calls.fetch.slice(1).sort(), [
    ORIGIN + '/assets/ui/panel.png',
    ORIGIN + '/assets/char/avatar/skin/kalts_boc.png',
    ORIGIN + '/assets/spine/op/kalts/boc/boc.skel',
    ORIGIN + '/assets/spine/op/amiya/winter/winter.skel',
  ].sort(), 'every outfit the manifest lists, still without a single voice');
  assert.ok(!env.calls.fetch.some((url) => url.includes('/voice/')), '全部皮肤 never drags the voices in');
  assert.deepEqual(mod.resourceState().skinScope, { keys: [], all: true });
  assert.equal(mod.resourceState().selectionComplete, true);
  // Back to following 干员调配: the unpicked outfit leaves the selection (what is cached stays).
  await mod.syncResources(true, false, 'cn', false, { keys: ['char_003_kalts/char_003_kalts@boc#6'], all: false });
  assert.deepEqual(mod.resourceState().skinScope, { keys: ['char_003_kalts/char_003_kalts@boc#6'], all: false });
  await mod.syncResources(false);
});

test('官方特效: its own switch, separate from 额外资源 in both directions (docs/design/vfx-format.md)', async (t) => {
  const files = [
    { url: '/assets/ui/panel.png', tier: 1, size: 4 },
    { url: '/assets/audio/voice/cn/x.mp3', tier: 2, size: 6 },
    { url: '/assets/local/fx/index.json', tier: 2, size: 3, fx: true },
    { url: '/assets/local/fx/tex/fire.webp', tier: 2, size: 40, fx: true },
  ];
  const env = stubEnv({ manifest: { ...MANIFEST, files, count: files.length, tier1: 1, sized: files.length, totalBytes: 53 } });
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?fx-selection');
  // 额外资源 off, 特效 on (the panel's default): the effect tree alone, and not one voice with it.
  await mod.syncResources(true, false, 'cn', false, { keys: [], all: false, fx: true });
  assert.deepEqual(env.calls.fetch.slice(1).sort(), [
    ORIGIN + '/assets/ui/panel.png',
    ORIGIN + '/assets/local/fx/index.json',
    ORIGIN + '/assets/local/fx/tex/fire.webp',
  ].sort(), 'the effects download without a single voice');
  assert.equal(mod.resourceState().tier2Wanted, 2, 'the two effect files are what 「可选」 means here');
  assert.equal(mod.resourceState().selectionComplete, true);
  // 特效 off, 额外资源 on now: only the newly wanted voice is fetched. The 特效 row stays in the panel — greyed out and
  // out of the counters — because its figures span the whole manifest (`allTotal`), so nothing moves with the boxes.
  const count = env.calls.fetch.length;
  await mod.syncResources(true, true, 'cn', false, { keys: [], all: false, fx: false });
  assert.deepEqual(env.calls.fetch.slice(count), [ORIGIN + '/assets/audio/voice/cn/x.mp3']);
  const fxRow = mod.resourceState().groups.find((g) => g.id === 'fx');
  assert.ok(fxRow, 'the 特效 row is still listed once its switch is off');
  assert.equal(fxRow.wanted, 0, 'and nothing from the effect tree is wanted');
  assert.deepEqual([fxRow.allTotal, fxRow.allPresent], [2, 2], 'its figures span the manifest: both files, both already cached');
  assert.equal(mod.resourceState().tier2Wanted, 1);
  await mod.syncResources(false);
});

test('controller ZIP import/export uses shared lock, automatically enables preload, then fills only selected missing tiers', async (t) => {
  const files = FILES.map((f) => ({ ...f, hash: createHash('sha1').update('b'.repeat(f.size)).digest('hex').slice(0, 12) }));
  const env = stubEnv({ manifest: { ...MANIFEST, files } });
  t.after(env.restore);
  const locks = [];
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: {
    request: async (name, options, job) => { locks.push(name); return job({ name }); },
  } });
  const mod = await import('../../public/js/resources/index.js?controller-zip');
  await mod.syncResources(true, false);
  const exported = await mod.exportResources();
  assert.equal(exported.count, 2);
  assert.equal(exported.blob.type, 'application/zip');
  await mod.syncResources(false);
  await mod.clearResources();
  const previous = env.calls.fetch.length;
  let persistedPreload = false;
  let enabledCallbacks = 0;
  const result = await mod.importResources(exported.blob, { onImported: () => {
    persistedPreload = true;
    enabledCallbacks++;
    assert.equal(mod.resourceState().archive, '', 'the setting changes only after the archive lock is released');
  } });
  assert.equal(result.imported, 2);
  assert.equal(mod.resourceState().enabled, true);
  assert.equal(persistedPreload, true);
  assert.equal(enabledCallbacks, 1);
  assert.equal(mod.resourceState().archive, '');
  assert.equal(env.calls.fetch.length, previous);
  await mod.syncResources(true, true);
  assert.deepEqual(env.calls.fetch.slice(previous), FILES.filter((f) => f.tier === 2).map((f) => ORIGIN + f.url));
  assert.ok(locks.length >= 4 && locks.every((name) => name === DOWNLOAD_LOCK));
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request: async (_, options, job) => job(null) } });
  const cached = mod.resourceState().done;
  await assert.rejects(mod.exportResources(), /另一个标签页/);
  await assert.rejects(mod.importResources(exported.blob), /另一个标签页/);
  await mod.clearResources();
  assert.equal(mod.resourceState().done, cached, 'busy lock prevents deleting another tab\'s cache');
  await mod.syncResources(false);
});

test('a timed-out worker pause resumes late worker writes without deleting cached resources', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?pause-timeout');
  await mod.syncResources(true, false);
  const before = await (await env.caches.open(CACHE_NAME)).keys();
  const modes = [];
  let writesEnabled = true;
  globalThis.navigator.serviceWorker.controller = {
    postMessage(message, ports) {
      modes.push(message.enabled);
      // Apply pause but lose its acknowledgement, as a delayed worker would.
      writesEnabled = message.enabled;
      if (message.enabled) ports[0].postMessage({ ok: true });
    },
  };
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => nativeTimeout(fn, delay === 5000 ? 5 : delay, ...args));
  assert.equal((await mod.clearResources()).error, true);
  assert.match(mod.resourceState().message, /响应超时/);
  assert.deepEqual(modes, [false, true]);
  assert.equal(writesEnabled, true);
  assert.deepEqual(await (await env.caches.open(CACHE_NAME)).keys(), before, 'unacknowledged pause must prevent destructive work');
  assert.equal(mod.resourceState().clearing, false);
  await mod.syncResources(false);
});

test('changing download scope and disabling preload while checking does not restart an obsolete request', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetcher = globalThis.fetch;
  globalThis.fetch = async (url, options) => { if (url === MANIFEST_URL) await gate; return fetcher(url, options); };
  const mod = await import('../../public/js/resources/index.js?selection-race');
  const original = mod.syncResources(true, false);
  const changed = mod.syncResources(true, true);
  await mod.syncResources(false, false);
  release();
  await Promise.all([original, changed]);
  assert.equal(mod.resourceState().enabled, false);
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL], 'a superseded settings update cannot enable resource downloads');
  await mod.syncResources(true, false);
  assert.deepEqual(env.calls.fetch.slice(1), FILES.filter((f) => f.tier === 1).map((f) => ORIGIN + f.url));
  await mod.syncResources(false);
});

test('opening resource management during startup shares its active check instead of scanning the cache twice', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?opening-during-startup');
  const cache = await env.caches.open(CACHE_NAME);
  const keys = cache.keys.bind(cache);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let scans = 0;
  cache.keys = async () => { scans++; started.resolve(); await gate.promise; return keys(); };
  const startup = mod.syncResources(true, false);
  await started.promise;
  assert.equal(mod.resourceState().phase, 'checking');
  await mod.inspectResources();
  await mod.inspectResources();
  assert.equal(scans, 1);
  gate.resolve();
  await startup;
  assert.equal(mod.resourceState().selectionComplete, true);
  await mod.syncResources(false);
});

test('ZIP quota failures are recognized by name even without an English error message', async (t) => {
  const files = FILES.slice(0, 2).map((f) => ({ ...f, hash: createHash('sha1').update('b'.repeat(f.size)).digest('hex').slice(0, 12) }));
  const manifest = { ...MANIFEST, files };
  const source = new ResourceStore(manifest, { caches: new MemoryCaches(), origin: ORIGIN,
    fetcher: async (url) => new Response('b'.repeat(files.find((f) => url.endsWith(f.url)).size)) });
  await source.download();
  const { blob } = await exportResourceZip(source);
  const env = stubEnv({ manifest });
  t.after(env.restore);
  const cache = await env.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  cache.put = async (url, response) => {
    if (url.endsWith(files[1].url)) throw new DOMException('', 'QuotaExceededError');
    await put(url, response);
  };
  const mod = await import('../../public/js/resources/index.js?zip-quota-name');
  let enabled = false;
  await assert.rejects(mod.importResources(blob, { onImported: () => { enabled = true; } }), (err) => err.name === 'QuotaExceededError');
  assert.equal(mod.resourceState().done, 1);
  assert.equal(mod.resourceState().error, true);
  assert.match(mod.resourceState().message, /浏览器存储空间不足/);
  assert.equal(mod.resourceState().enabled, false);
  assert.equal(enabled, false, 'a failed import does not persist an enabled setting');
});

test('successful ZIP import persists the preload setting and completes only the selected missing resources', async (t) => {
  const files = FILES.map((f) => ({ ...f, hash: createHash('sha1').update('b'.repeat(f.size)).digest('hex').slice(0, 12) }));
  const source = new ResourceStore({ format: 1, version: 'partial', files: files.slice(0, 1) }, {
    caches: new MemoryCaches(), origin: ORIGIN, fetcher: async () => new Response('b'.repeat(files[0].size)),
  });
  await source.download();
  const { blob } = await exportResourceZip(source);
  const env = stubEnv({ manifest: { ...MANIFEST, files } });
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const prefs = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => prefs.get(key) ?? null, setItem: (key, value) => prefs.set(key, value),
  } });
  const { settingsStore, updateSettings } = await import('../../public/js/ui/settings.js?zip-enabled-setting');
  const originalSettings = settingsStore.get();
  t.after(async () => {
    await mod.syncResources(false);
    updateSettings(originalSettings);
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else delete globalThis.localStorage;
    env.restore();
  });
  updateSettings({ preload: false, preloadOptional: false });
  const mod = await import('../../public/js/resources/index.js?zip-enabled-setting');
  // main.js supplies the persisted scope even while preload is disabled; this fork defaults optional to true.
  await mod.syncResources(false, settingsStore.get().preloadOptional);
  await mod.importResources(blob, { onImported: () => updateSettings({ preload: true }) });
  await mod.startResources();
  assert.equal(settingsStore.get().preload, true);
  assert.equal(JSON.parse(prefs.get('sp.pref.settings')).preload, true);
  assert.equal(JSON.parse(prefs.get('sp.pref.settings')).preloadOptional, false);
  assert.equal(mod.resourceState().enabled, true);
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL, ORIGIN + files[1].url], 'only the missing essential file downloads');
});

test('invalid or cancelled ZIP imports do not enable preload or invoke the persisted-setting callback', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?zip-enable-failures');
  let callbacks = 0;
  const options = { onImported: () => { callbacks++; } };
  await assert.rejects(mod.importResources(new Blob(['not a ZIP']), options));
  assert.equal(mod.resourceState().enabled, false);
  const pending = mod.importResources(new Blob(['not a ZIP']), options);
  mod.pauseResources();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.equal(mod.resourceState().enabled, false);
  assert.equal(callbacks, 0);
});

test('ZIP percentages and category counters update together every 500 ms, with immediate phase completion', async (t) => {
  const files = Array.from({ length: 6 }, (_, i) => ({ url: `/assets/map/${i}.png`, tier: 1, size: 1,
    hash: createHash('sha1').update('b').digest('hex').slice(0, 12) }));
  const manifest = { ...MANIFEST, files, count: 6, tier1: 6, sized: 6, totalBytes: 6 };
  const source = new ResourceStore(manifest, { caches: new MemoryCaches(), origin: ORIGIN, fetcher: async () => new Response('b') });
  await source.download();
  const { blob } = await exportResourceZip(source);
  const env = stubEnv({ manifest });
  t.after(env.restore);
  let time = 0;
  t.mock.method(performance, 'now', () => time);
  const cache = await env.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  const times = [50, 500, 600, 999, 1000, 1050];
  let written = 0;
  cache.put = async (url, response) => {
    await put(url, response);
    if (url.includes('/assets/map/')) time = times[written++];
  };
  const mod = await import('../../public/js/resources/index.js?zip-progress-throttle');
  const progress = [];
  t.after(mod.subscribeResources((s) => {
    if (s.archivePhase === 'import') progress.push({ time, percent: s.archivePercent, done: s.done,
      group: s.archiveGroup, count: s.groups.find((g) => g.id === 'map')?.present, message: s.message });
  }));
  await mod.importResources(blob);
  const updates = progress.filter((p) => p.message.startsWith('正在导入资源包：'));
  assert.deepEqual(updates.map((p) => [p.time, p.percent, p.done, p.count]),
    [[0, 0, 0, 0], [500, 33, 2, 2], [1000, 83, 5, 5], [1050, 100, 6, 6]]);
  assert.deepEqual(updates.slice(1).map((p) => p.group), ['map', 'map', 'map']);
  assert.ok(updates.every((p) => /\d+%$/.test(p.message)));
  assert.equal(mod.resourceState().done, 6);
  assert.equal(mod.resourceState().archiveGroup, '', 'completion clears the active category');

  // Existing valid entries still advance the percentage to 100%, although no files need writing a second time.
  assert.equal((await mod.importResources(blob)).imported, 0);
  assert.equal(mod.resourceState().archivePercent, 100);
});

/** Install stubs and return the recorder of what the module did. */
function stubEnv({ manifest = MANIFEST, fail = false, secure = true } = {}) {
  const calls = { fetch: [], registered: [], unregistered: 0, released: [] };
  const globals = ['fetch', 'caches', 'navigator', 'isSecureContext', 'location'];
  const saved = Object.fromEntries(globals.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const restore = () => {
    for (const k of globals) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };
  const caches = new MemoryCaches();
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { origin: ORIGIN }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      serviceWorker: {
        async register(url, opts) { calls.registered.push([url, opts]); return { scope: '/' }; },
        async getRegistrations() { return [{ active: { scriptURL: ORIGIN + SW_URL }, async unregister() { calls.unregistered++; } }]; },
      },
    },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url, opts) => {
      calls.fetch.push(url);
      if (url === MANIFEST_URL) {
        if (fail) return new Response('nope', { status: 503 });
        return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const file = (manifest.files || FILES).find((f) => url.endsWith(f.url));
      if (!file) return new Response('missing', { status: 404 });
      if (opts?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return new Response('b'.repeat(file.size), { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
    configurable: true, writable: true,
  });
  return { calls, caches, restore };
}

test('the preload controller: off by default, downloads in two passes, serves offline state', async (t) => {
  // `import` after the stubs: the module reads globals lazily, but the manifest fetch is kicked off on the first call
  const env = stubEnv();
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js');
  const states = [];
  const unsub = mod.subscribeResources((s) => states.push(s));
  t.after(unsub);

  assert.equal(mod.resourceState().phase, 'off');
  assert.equal(mod.resourceState().enabled, false);
  assert.equal(mod.resourceState().optional, true, 'both tiers are selected by default');

  // nothing happens while the player has not turned it on (the settings store reports `preload: false` on every change)
  await mod.syncResources(false);
  assert.equal(env.calls.fetch.length, 0, 'no manifest request while the preload is off');
  assert.equal(env.calls.registered.length, 0);

  // turning it on without an explicit scope: manifest, worker, essential tier first, then the rest
  await mod.syncResources(true);
  const st = mod.resourceState();
  assert.equal(env.calls.registered.length, 1);
  assert.deepEqual(env.calls.registered[0], [SW_URL, { type: 'module', scope: '/', updateViaCache: 'none' }]);
  assert.equal(env.calls.fetch[0], MANIFEST_URL);
  assert.deepEqual(env.calls.fetch.slice(1), [
    `${ORIGIN}/assets/audio/bgm.mp3`, `${ORIGIN}/assets/ui/panel.png`, // essential tier, alphabetical
    `${ORIGIN}/assets/char/portrait.png`, `${ORIGIN}/assets/spine/op/x/front/x.skel`, // then the rest
  ]);
  assert.equal(st.phase, 'ready');
  assert.equal(st.complete, true);
  assert.deepEqual([st.done, st.total, st.bytes, st.totalBytes], [4, 4, 22, 22]);
  assert.deepEqual([st.tier1Done, st.tier1Total, st.tier2Done, st.tier2Total], [2, 2, 2, 2]);
  assert.match(st.message, /资源已全部预载完成/, 'the copy never promises offline play');
  assert.equal(/离线/.test(JSON.stringify(states)), false, 'no state text says 离线');
  assert.equal(st.error, false);
  assert.ok(states.some((s) => s.phase === 'download'), 'progress states were published');
  // the panel renders numeric counters: an undefined one used to show as "undefined/3966" mid-download
  for (const s of states) {
    for (const k of ['done', 'total', 'wanted', 'bytes', 'skipped', 'sized', 'sizedTotal', 'tier1Done', 'tier1Total', 'tier2Done', 'tier2Total']) {
      assert.equal(typeof s[k], 'number', `state.${k} while ${s.phase} (${JSON.stringify(s[k])})`);
    }
  }
  assert.ok(states.some((s) => s.phase === 'download' && s.done >= 1 && s.done < 4), 'a mid-download update carried the partial count');
  assert.equal(await (await env.caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/ui/panel.png`) !== undefined, true);

  // a second sync with the same value is a no-op (the settings store fires for volume changes too)
  const fetches = env.calls.fetch.length;
  await mod.syncResources(true, true);
  assert.equal(env.calls.fetch.length, fetches, 'no second download');

  // pausing, continuing and clearing
  await mod.syncResources(false);
  assert.equal(mod.resourceState().enabled, false);
  assert.equal(mod.resourceState().phase, 'ready', 'what is cached stays usable');
  await mod.clearResources();
  assert.deepEqual(await env.caches.keys(), [], 'every cache of this app is gone');
  assert.equal(mod.resourceState().phase, 'off');
  assert.equal(mod.resourceState().done, 0);
  assert.equal(env.calls.unregistered, 1, 'nothing left to serve ⇒ the worker is removed');
});

test('a second tab does not download the same files twice (Web Locks)', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  const lockCalls = [];
  // another tab owns the lock: with `ifAvailable` the callback runs with null instead of queueing behind 250 MiB
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: { request: async (name, opts, cb) => { lockCalls.push([name, opts]); return cb(null); } },
    configurable: true, writable: true,
  });
  const mod = await import('../../public/js/resources/index.js?other-tab');
  await mod.syncResources(true, true);
  const st = mod.resourceState();
  assert.deepEqual(lockCalls, [[DOWNLOAD_LOCK, { ifAvailable: true }]]);
  assert.equal(st.phase, 'foreign');
  assert.match(st.message, /另一个标签页正在预载/);
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL], 'nothing is downloaded: only the manifest was asked for');
  assert.deepEqual([st.done, st.total], [0, FILES.length], 'the counters still come from the shared cache');
  assert.equal(st.enabled, true, 'the setting stays on');

  // the other tab is gone (released the lock): 再检查一次 downloads the rest
  Object.defineProperty(globalThis.navigator, 'locks', { value: { request: async (name, opts, cb) => cb({ name }) }, configurable: true, writable: true });
  await mod.startResources();
  assert.equal(mod.resourceState().phase, 'ready');
  assert.equal(mod.resourceState().complete, true);
  assert.equal(env.calls.fetch.length, 1 + FILES.length, 'the tab that owns the lock does the work');
  await mod.syncResources(false);
});

test('the worker entry (public/resource-sw.js) intercepts resources only', async (t) => {
  const saved = ['self', 'caches'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const handlers = {};
  const caches = new MemoryCaches();
  const asset = `${ORIGIN}/assets/e2e/a.png`;
  await (await caches.open(cacheName('sw'))).put(asset, new Response('cached-bytes'));
  Object.defineProperty(globalThis, 'self', { value: { location: { href: ORIGIN + SW_URL }, addEventListener: (name, fn) => { handlers[name] = fn; } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true, writable: true });
  t.after(() => { for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  await import('../../public/resource-sw.js');
  assert.deepEqual(Object.keys(handlers).sort(), ['activate', 'fetch', 'install', 'message'], 'the worker registers its listeners');

  const answered = [];
  const fire = (url, method = 'GET') => {
    let promise = null;
    handlers.fetch({ request: new Request(url, { method }), respondWith: (p) => { promise = p; answered.push(url); } });
    return promise;
  };
  assert.equal(await fire(asset).then((r) => r.text()), 'cached-bytes', 'a cached resource is answered');
  assert.equal(fire(`${ORIGIN}/js/main.js`), null, 'code passes through');
  assert.equal(fire(`${ORIGIN}/data/assets.json`), null, 'game data passes through');
  assert.equal(fire(`${ORIGIN}/assets/e2e/a.png`, 'POST'), null, 'only GET');
  assert.deepEqual(answered, [asset]);
});

test('a browser without Cache Storage is reported instead of downloading', async (t) => {
  const env = stubEnv({ secure: false });
  t.after(env.restore);
  // a separate module instance (the controller keeps a session-wide manifest/worker state, as in the browser)
  const mod = await import('../../public/js/resources/index.js?insecure-context');
  await mod.syncResources(true, true);
  const st = mod.resourceState();
  assert.equal(st.enabled, true, 'the switch stays where the player put it');
  assert.equal(st.supported, false);
  assert.equal(st.phase, 'error');
  assert.match(st.message, /HTTPS|Cache Storage|Service Worker/);
  assert.deepEqual(env.calls.fetch, [], 'nothing is downloaded');
  await mod.syncResources(false);
});

test('pause and clear during a delayed manifest cannot start downloads later', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  let release;
  let entered;
  const requested = new Promise((resolve) => { entered = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = (url, opts) => url === MANIFEST_URL
    ? new Promise((resolve) => { env.calls.fetch.push(url); release = () => resolve(new Response(JSON.stringify(MANIFEST))); entered(); })
    : original(url, opts);
  const mod = await import('../../public/js/resources/index.js?clear-checking');
  const started = mod.syncResources(true);
  await requested;
  mod.pauseResources();
  assert.equal(mod.resourceState().phase, 'paused');
  const cleared = mod.clearResources();
  release();
  await Promise.all([started, cleared]);
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL]);
  assert.deepEqual(env.calls.registered, []);
  assert.deepEqual(await env.caches.keys(), []);
  assert.equal(mod.resourceState().phase, 'paused');
  await mod.syncResources(false);
});

test('rapid off/on during a delayed manifest starts one complete download', async (t) => {
  const env = stubEnv();
  t.after(env.restore);
  let release;
  let entered;
  const requested = new Promise((resolve) => { entered = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = (url, opts) => url === MANIFEST_URL
    ? new Promise((resolve) => { env.calls.fetch.push(url); release = () => resolve(new Response(JSON.stringify(MANIFEST))); entered(); })
    : original(url, opts);
  const mod = await import('../../public/js/resources/index.js?toggle-checking');
  const first = mod.syncResources(true, true);
  await requested;
  await mod.syncResources(false);
  const second = mod.syncResources(true, true);
  release();
  await Promise.all([first, second]);
  assert.equal(mod.resourceState().complete, true);
  assert.equal(env.calls.registered.length, 1);
  assert.equal(env.calls.fetch.length, 1 + FILES.length);
  await mod.syncResources(false);
  await mod.clearResources();
});
