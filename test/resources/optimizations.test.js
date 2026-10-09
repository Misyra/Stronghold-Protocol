import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ResourceStore } from '../../public/js/resources/store.js';
import { exportResourceZip, importResourceZip } from '../../public/js/resources/archive.js';
import { CACHE_NAME, CACHE_PREFIX, MANIFEST_URL, indexUrl } from '../../public/js/resources/common.js';
import { missingStorage, storageEstimate } from '../../public/js/resources/storage.js';
import { skipReasonText, storageText } from '../../public/js/ui/resourcePanel.js';
import { sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';

class Cache {
  entries = new Map();
  async put(key, response) { this.entries.set(typeof key === 'string' ? key : key.url, response.clone()); }
  async match(key) { return this.entries.get(typeof key === 'string' ? key : key.url)?.clone(); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(key) { return this.entries.delete(typeof key === 'string' ? key : key.url); }
}
class Caches {
  entries = new Map();
  async open(name) { if (!this.entries.has(name)) this.entries.set(name, new Cache()); return this.entries.get(name); }
  async keys() { return [...this.entries.keys()]; }
  async delete(name) { return this.entries.delete(name); }
}
const ORIGIN = 'https://resources.example';
const file = (url, body, tier = 1) => ({ url, body, tier, size: Buffer.byteLength(body), hash: createHash('sha1').update(body).digest('hex').slice(0, 12) });
const manifest = (files) => ({ format: 1, version: 'optimizations', files, count: files.length,
  tier1: files.filter((f) => f.tier === 1).length, sized: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0) });
function makeStore(files, caches = new Caches()) {
  const calls = [];
  return { caches, calls, store: new ResourceStore(manifest(files), { caches, origin: ORIGIN, fetcher: async (url) => {
    calls.push(url); const f = files.find((f) => new URL(f.url, ORIGIN).href === url);
    return new Response(f.body);
  } }) };
}
let serial = 0;
async function environment(t, files, { onFetch, storage } = {}) {
  const names = ['fetch', 'navigator', 'caches', 'location', 'isSecureContext'];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const caches = new Caches(), calls = [];
  const globals = { caches, location: { origin: ORIGIN }, isSecureContext: true,
    navigator: { storage, serviceWorker: { register: async () => ({}), getRegistrations: async () => [] } },
    fetch: async (url, options) => {
      calls.push(url);
      if (url === MANIFEST_URL) return new Response(JSON.stringify(manifest(files)));
      if (onFetch) { const result = await onFetch(url, options); if (result) return result; }
      const f = files.find((f) => new URL(f.url, ORIGIN).href === url);
      return f ? new Response(f.body) : new Response('missing', { status: 404 });
    },
  };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  const mod = await import('../../public/js/resources/index.js?optimization-' + serial++);
  return { mod, caches, calls };
}

test('digest failures reject downloads and preserve unverified existing bytes without marking them current', async (t) => {
  const files = [file('/assets/ui/a.png', 'expected')];
  const fresh = makeStore(files);
  t.mock.method(crypto.subtle, 'digest', async () => { throw new Error('digest failed'); });
  let result = await fresh.store.download();
  assert.equal(result.failed, 1); assert.equal(result.complete, false);
  const cache = await fresh.caches.open(CACHE_NAME);
  assert.equal(await cache.match(ORIGIN + files[0].url), undefined);
  assert.match(result.failures[0].message, /无法校验/);
  await cache.put(ORIGIN + files[0].url, new Response('unverified'));
  result = await fresh.store.download();
  assert.equal(result.failed, 1);
  assert.equal(await (await cache.match(ORIGIN + files[0].url)).text(), 'unverified');
  const index = await (await cache.match(indexUrl(ORIGIN))).json();
  assert.equal(index.files[ORIGIN + files[0].url], undefined);
});

test('voice scopes download only selected language, retain other languages, and import/export both', async () => {
  const files = [file('/assets/ui/a.png', 'image'), file('/assets/audio/voice/cn/a/1.mp3', 'chinese', 2), file('/assets/audio/voice/jp/a/1.mp3', 'japanese', 2)];
  const source = makeStore(files); await source.store.download();
  const zip = await exportResourceZip(source.store);
  const target = makeStore(files); target.store.setVoiceScope('cn');
  const imported = await importResourceZip(target.store, zip.blob);
  assert.equal(imported.imported, 3); assert.equal(imported.skippedPackage, 0);
  assert.equal(imported.count, 2, 'progress includes only selected files');
  assert.equal(imported.totalBytes, files[0].size + files[1].size);
  assert.equal(imported.sizedTotal, 2);
  await target.store.download(); assert.deepEqual(target.calls, []);
  assert.equal((await exportResourceZip(target.store)).count, 3, 'other cached voices remain exportable');
  target.store.setVoiceScope('jp'); assert.equal((await target.store.status()).complete, true);
  target.store.setVoiceScope('cn', true); assert.equal((await target.store.status()).total, 3);
  const selected = makeStore(files); selected.store.setVoiceScope('cn'); await selected.store.download();
  assert.deepEqual(selected.calls, files.slice(0, 2).map((f) => ORIGIN + f.url));
  selected.store.setVoiceScope('jp'); await selected.store.download();
  assert.equal(selected.calls.length, 3, 'language switch downloads only missing Japanese voice');
  selected.store.setVoiceScope('cn'); await selected.store.download();
  assert.equal(selected.calls.length, 3);
});

test('voice filtering preserves old caches containing another language', async () => {
  const files = [file('/assets/ui/a.png', 'a'), file('/assets/audio/voice/jp/a/1.mp3', 'jp', 2)];
  const env = makeStore(files); const old = await env.caches.open(CACHE_PREFIX + 'old');
  await old.put(ORIGIN + files[1].url, new Response('jp'));
  env.store.setVoiceScope('cn'); await env.store.download();
  assert.ok((await env.caches.keys()).includes(CACHE_PREFIX + 'old'));
  assert.equal(await (await old.match(ORIGIN + files[1].url)).text(), 'jp');
});

test('optional cleanup removes both languages and legacy audio while retaining required assets and unrelated caches', async () => {
  const files = [file('/assets/ui/a.png', 'a'), file('/assets/audio/voice/cn/a/1.mp3', 'cn', 2), file('/assets/audio/voice/jp/a/1.mp3', 'jp', 2), file('/assets/local/guide/a.png', 'guide', 2)];
  const env = makeStore(files); await env.store.download(); env.store.setVoiceScope('cn');
  const old = await env.caches.open(CACHE_PREFIX + 'old');
  await old.put('https://old.example/_v/aaaaaaaaaaaaaaaa/assets/audio/gone.mp3', new Response('old'));
  const unrelated = await env.caches.open('other-app'); await unrelated.put(ORIGIN + '/assets/audio/other.mp3', new Response('other'));
  const result = await env.store.clear({ optionalOnly: true });
  assert.equal(result.tier1Present, 1); assert.equal(result.tier2Present, 0);
  const current = await env.caches.open(CACHE_NAME);
  for (const f of files.slice(1)) assert.equal(await current.match(ORIGIN + f.url), undefined);
  assert.equal((await old.keys()).filter((r) => /assets/.test(r.url)).length, 0);
  assert.equal(await (await unrelated.match(ORIGIN + '/assets/audio/other.mp3')).text(), 'other');
  const index = await (await current.match(indexUrl(ORIGIN))).json();
  assert.deepEqual(Object.keys(index.files), [ORIGIN + files[0].url]);
  await env.store.clear(); assert.deepEqual(await env.caches.keys(), ['other-app']);
});

test('storage estimates are advisory, include missing selected resources only, and handle absent/failed APIs', async () => {
  const files = [file('/assets/ui/a.png', 'image'), file('/assets/audio/voice/jp/a/1.mp3', 'jp', 2)];
  const env = makeStore(files); env.store.setVoiceScope('cn');
  const missing = missingStorage(env.store, await env.store.status(), true);
  assert.equal(missing.requiredBytes, 5);
  const low = await storageEstimate({ ...missing, storage: { estimate: async () => ({ usage: 99, quota: 100 }) } });
  assert.equal(low.low, true); assert.equal(low.available, 1);
  assert.match(storageText(low), /预计新增/);
  assert.equal((await storageEstimate({ storage: {} })).available, null);
  assert.equal((await storageEstimate({ storage: { estimate: async () => { throw new Error('unsupported'); } } })).available, null);
  assert.equal(sanitizeSettings({}).preloadAllVoices, false);
  assert.equal(sanitizeSettings({ preloadAllVoices: true }).preloadAllVoices, true);
});

test('archive plans explain removed, changed, size-mismatched and unverifiable resources before writes', async () => {
  const files = [file('/assets/ui/a.png', 'a'), file('/assets/ui/b.png', 'b'), file('/assets/ui/c.png', 'c'), file('/assets/ui/d.png', 'd'), file('/assets/ui/e.png', 'e')];
  const source = makeStore(files); await source.store.download(); const zip = await exportResourceZip(source.store);
  const current = [files[0], { ...files[1], hash: 'syn-missing' }, { ...files[2], hash: 'aaaaaaaaaaaa' }, { ...files[3], size: 2 }];
  const target = makeStore(current); let planned;
  const result = await importResourceZip(target.store, zip.blob, { onPlan: (plan) => { planned = plan; assert.equal(target.calls.length, 0); } });
  assert.deepEqual(planned.skipReasons, { removed: 1, fingerprint: 1, changed: 1, size: 1, oversized: 0 });
  assert.equal(planned.requiredBytes, 1); assert.equal(result.imported, 1); assert.equal(result.skippedPackage, 4);
  assert.match(skipReasonText(result.skipReasons), /服务器缺少内容指纹：1 个/);
  const second = await importResourceZip(target.store, zip.blob); assert.equal(second.already, 1); assert.equal(second.imported, 0);
});

test('import results survive automatic downloads and cache inspection, and download failures retain file details', async (t) => {
  const files = [file('/assets/ui/a.png', 'a'), file('/assets/ui/b.png', 'b')];
  const source = makeStore(files.slice(0, 1)); await source.store.download(); const zip = await exportResourceZip(source.store);
  const { mod } = await environment(t, files, { onFetch: async (url) => url.endsWith('/b.png') ? new Response('failed', { status: 503 }) : null });
  await mod.importResources(zip.blob); await mod.startResources();
  const result = mod.resourceState().archiveResult;
  assert.equal(result.imported, 1); assert.equal(result.status, 'success');
  assert.equal(mod.resourceState().failures.length, 1); assert.match(mod.resourceState().failures[0].message, /503/);
  await mod.inspectResources(); assert.deepEqual(mod.resourceState().archiveResult, result);
  await mod.syncResources(false);
});

async function runningExport(t, mode) {
  const files = [file('/assets/ui/a.png', 'a'), file('/assets/ui/b.png', 'b')];
  const started = Promise.withResolvers(), saved = Promise.withResolvers(); let blocked = false;
  const env = await environment(t, files, { onFetch: async (url, options) => {
    if (url.endsWith('/b.png') && !blocked) {
      blocked = true; started.resolve();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    }
  } });
  const cache = await env.caches.open(CACHE_NAME); const put = cache.put.bind(cache);
  cache.put = async (url, response) => { await put(url, response); if (url.endsWith('/a.png')) saved.resolve(); };
  const run = env.mod.syncResources(true, false);
  await Promise.all([started.promise, saved.promise]);
  let clearing;
  const unsub = env.mod.subscribeResources((state) => {
    if (state.archivePhase === 'export' && state.archivePercent === 0) {
      unsub();
      if (mode === 'pause') env.mod.pauseResources();
      if (mode === 'clear') clearing = env.mod.clearResources();
    }
  });
  t.after(unsub);
  const exported = env.mod.exportResources();
  if (mode === 'resume') { assert.equal((await exported).count, 1); await env.mod.startResources(); assert.equal(env.mod.resourceState().complete, true); }
  else { await assert.rejects(exported, (e) => e.name === 'AbortError'); if (clearing) await clearing; assert.equal(env.calls.filter((url) => url.endsWith('/b.png')).length, 1); }
  await run;
  if (mode === 'clear') assert.deepEqual(await env.caches.keys(), []);
  await env.mod.syncResources(false);
}
test('export resumes the background download it interrupted', (t) => runningExport(t, 'resume'));
test('explicit cancellation during export prevents automatic download resumption', (t) => runningExport(t, 'pause'));
test('clearing during export prevents late writes and download resumption', (t) => runningExport(t, 'clear'));

test('controller switches voice selection without redownloading cached voices', async (t) => {
  const files = [file('/assets/ui/a.png', 'a'), file('/assets/audio/voice/cn/a/1.mp3', 'cn', 2), file('/assets/audio/voice/jp/a/1.mp3', 'jp', 2)];
  const { mod, calls } = await environment(t, files);
  await mod.syncResources(true, true, 'cn', false);
  assert.equal(mod.resourceState().total, 2);
  assert.equal(calls.filter((url) => url.includes('/jp/')).length, 0);
  await mod.syncResources(true, true, 'jp', false);
  assert.equal(calls.filter((url) => url.includes('/jp/')).length, 1);
  await mod.syncResources(true, true, 'cn', true);
  assert.equal(mod.resourceState().total, 3); assert.equal(mod.resourceState().done, 3);
  assert.equal(calls.filter((url) => url.startsWith(ORIGIN)).length, 3);
  await mod.syncResources(false);
});

test('low storage estimates are shown before import writes and do not reject a valid package', async (t) => {
  const files = [file('/assets/ui/a.png', 'a')]; const source = makeStore(files);
  await source.store.download(); const zip = await exportResourceZip(source.store);
  const { mod, caches } = await environment(t, files, { storage: { estimate: async () => ({ usage: 10, quota: 10 }) } });
  const cache = await caches.open(CACHE_NAME), put = cache.put.bind(cache); let warned = false;
  cache.put = async (key, response) => { if (key.endsWith('/a.png')) warned = mod.resourceState().storage.low; await put(key, response); };
  assert.equal((await mod.importResources(zip.blob)).imported, 1);
  assert.equal(warned, true);
  await mod.startResources(); await mod.syncResources(false);
});

test('full cleanup works when the manifest is unavailable; optional cleanup reports failure instead of claiming success', async (t) => {
  const { mod, caches } = await environment(t, [file('/assets/ui/a.png', 'a')]);
  globalThis.fetch = async () => new Response('offline', { status: 503 });
  const cache = await caches.open(CACHE_NAME); await cache.put(ORIGIN + '/assets/audio/old.mp3', new Response('old'));
  const optional = await mod.clearResources({ optionalOnly: true });
  assert.equal(optional.error, true); assert.ok(await cache.match(ORIGIN + '/assets/audio/old.mp3'));
  const full = await mod.clearResources(); assert.equal(full.error, undefined);
  assert.deepEqual(await caches.keys(), []);
});
