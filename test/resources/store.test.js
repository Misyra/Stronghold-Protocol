// test/resources/store.test.js — the Cache Storage downloader (public/js/resources/store.js) and the Service Worker
// handler (public/js/resources/service.js, docs/ASSETS.md「Preload」).
//
// Cache Storage and fetch are injected: a tiny in-memory cache plus a scripted fetcher, so the tests describe exactly
// what the browser would do (order, skipping, pauses, quota) without a browser and without megabytes of fixtures.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_NAME, CACHE_PREFIX, cacheName, indexUrl, rangeResponse, TIER_ESSENTIAL, TIER_REST } from '../../public/js/resources/common.js';
import { collectResourceFiles } from '../../server/resources.js';
import { ResourceStore, normalizeSkinKeys, normalizeSkinScope } from '../../public/js/resources/store.js';
import { handleResourceRequest } from '../../public/js/resources/service.js';

/** Minimal Cache Storage (Cache API surface the store uses: open/keys/delete + cache.put/match/keys). */
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
  async match(url) { for (const c of this.map.values()) { const hit = await c.match(url); if (hit) return hit; } return undefined; }
}

const ORIGIN = 'https://game.example';

test('voice scope is independent of music and supports every global dub, without hiding cached catalogs', async () => {
  const files = ['cn', 'jp', 'en', 'kr'].map((lang) => ({ url: `/assets/audio/voice/${lang}/test.mp3`, tier: 2, size: 4 }));
  files.push({ url: '/assets/audio/bgm/test.mp3', tier: 2, size: 5 });
  const s = new ResourceStore(manifest(files), { caches: new MemoryCaches(), origin: ORIGIN });
  for (const lang of ['cn', 'jp', 'en', 'kr']) {
    s.setScope({ optional: false, voices: true, voiceLang: lang });
    assert.deepEqual(s.selectedFiles.map((f) => f.url), [`/assets/audio/voice/${lang}/test.mp3`]);
    const st = await s.status();
    assert.deepEqual(st.voiceLanguages, ['cn', 'jp', 'en', 'kr']);
    assert.equal(st.groups.find((g) => g.id === 'voice').allTotal, 1);
  }
  s.setScope({ optional: true, voices: false, voiceLang: 'en' });
  assert.deepEqual(s.selectedFiles.map((f) => f.url), ['/assets/audio/bgm/test.mp3']);
  assert.equal((await s.status()).groups.find((g) => g.id === 'voice').allTotal, 1);
  s.setScope({ optional: false, voices: true, allVoices: true });
  assert.equal(s.selectedFiles.length, 4);
});

function manifest(files, over = {}) {
  // Every file carries a hash unless the test says otherwise (`hash: null` is the pre-hash manifest).
  const all = files.map((f, i) => (f.hash !== undefined ? f : { ...f, hash: `h${i}` }));
  const totalBytes = all.reduce((n, f) => n + (Number.isSafeInteger(f.size) ? f.size : 0), 0);
  const sized = all.filter((f) => Number.isSafeInteger(f.size)).length;
  return { format: 1, version: 'v1', count: all.length, tier1: all.filter((f) => f.tier === 1).length, sized, totalBytes: sized ? totalBytes : null, files: all, ...over };
}

/**
 * Put a file into the preload cache the way a finished run leaves it: the body plus its hash in the index. A file
 * without a hash (an older manifest) needs no index record.
 */
async function seed(caches, url, body, hash) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(url, new Response(body));
  if (hash) {
    const res = await cache.match(indexUrl(ORIGIN));
    const doc = res ? await res.json() : { version: 1, manifest: '', files: {} };
    doc.files[url] = hash;
    await cache.put(indexUrl(ORIGIN), new Response(JSON.stringify(doc)));
  }
  return cache;
}

/** The hash the server writes for these bytes (12 hex of a SHA-1): the store verifies cached entries against it. */
async function digest(body) {
  const bits = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/** A fetcher that answers every URL with `body.length` bytes and records the call order. */
function fetcherFor({ bodies = {}, fail = [], opaque = [], gzip = [], onCall } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    onCall?.(url, opts);
    if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (fail.includes(url)) throw new Error('HTTP 404');
    const body = bodies[url] ?? 'x'.repeat(8);
    if (opaque.includes(url)) return { type: 'opaque', ok: true, status: 200, body: null, headers: new Headers() };
    // a gzipped transfer: fetch hands over the DECODED body while Content-Length describes the compressed bytes
    if (gzip.includes(url)) return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': '42' } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) } });
  };
  return { fetch, calls };
}

const store = (m, extra = {}) => new ResourceStore(m, { caches: extra.caches ?? new MemoryCaches(), fetcher: extra.fetch, origin: ORIGIN, smallLanes: extra.smallLanes ?? 4, bigLanes: extra.bigLanes ?? 1, now: extra.now });

describe('ResourceStore', () => {
  test('simultaneous status checks share cache metadata reads; later checks detect actual eviction', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 1 }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'a', 'h0');
    const cache = await caches.open(CACHE_NAME);
    const keys = cache.keys.bind(cache);
    const match = cache.match.bind(cache);
    const keysStarted = Promise.withResolvers();
    const indexStarted = Promise.withResolvers();
    const release = Promise.withResolvers();
    let keyReads = 0;
    let indexReads = 0;
    cache.keys = async () => { keyReads++; keysStarted.resolve(); await release.promise; return keys(); };
    cache.match = async (key) => { indexReads++; indexStarted.resolve(); await release.promise; return match(key); };
    const s = store(m, { caches });
    const pending = [s.status(), s.status(), s.status()];
    await Promise.all([keysStarted.promise, indexStarted.promise]);
    assert.deepEqual([keyReads, indexReads], [1, 1], 'key enumeration and index reading start in parallel, once');
    release.resolve();
    const [a, b, c] = await Promise.all(pending);
    assert.deepEqual([a.count, b.count, c.count], [1, 1, 1]);
    a.present.clear();
    a.groups[0].present = 99;
    assert.equal(b.present.size, 1);
    assert.equal(b.groups[0].present, 1);
    await cache.delete(`${ORIGIN}/assets/a.png`);
    assert.equal((await s.status()).count, 0, 'status results are not permanently cached');
    assert.deepEqual([keyReads, indexReads], [2, 2]);
  });

  test('a failed metadata check does not leave a rejected status promise cached', async () => {
    const caches = new MemoryCaches();
    const cache = await caches.open(CACHE_NAME);
    const keys = cache.keys.bind(cache);
    cache.keys = async () => { throw new Error('cache keys unavailable'); };
    const s = store(manifest([{ url: '/assets/a.png', tier: 1, size: 1 }]), { caches });
    await assert.rejects(s.status(), /cache keys unavailable/);
    cache.keys = keys;
    assert.equal((await s.status()).count, 0);
  });

  test('status reports what is cached, in files and bytes', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 10 }, { url: '/assets/b.png', tier: 2, size: 20 }, { url: '/assets/c.png', tier: 2, size: 30 }]);
    const caches = new MemoryCaches();
    const s = store(m, { caches });
    const empty = await s.status();
    assert.deepEqual([empty.count, empty.total, empty.bytes, empty.complete, empty.tier1, empty.tier1Present], [0, 3, 0, false, 1, 0]);
    await seed(caches, `${ORIGIN}/assets/a.png`, '0123456789', 'h0');
    const one = await s.status();
    assert.deepEqual([one.count, one.bytes, one.tier1Present, one.complete], [1, 10, 1, false]);
    // …and a cached file of another revision does not count as current
    await seed(caches, `${ORIGIN}/assets/b.png`, 'stale-bytes', 'an-old-digest');
    const stale = await s.status();
    assert.deepEqual([stale.count, stale.complete], [1, false], 'the cached bytes belong to an older revision');
  });

  test('downloads the essential tier first, then the rest, skipping what is cached', async () => {
    const m = manifest([
      { url: '/assets/ui/a.png', tier: 1, size: 8 },
      { url: '/assets/avatar/b.png', tier: 1, size: 8 },
      { url: '/assets/spine/c.skel', tier: 2, size: 8 },
      { url: '/assets/spine/d.png', tier: 2, size: 8 },
    ]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/avatar/b.png`, 'cached!!', 'h1');
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const seen = [];
    const res = await s.download({ onProgress: (p) => seen.push(p) });
    assert.deepEqual(calls, [`${ORIGIN}/assets/ui/a.png`, `${ORIGIN}/assets/spine/c.skel`, `${ORIGIN}/assets/spine/d.png`], 'cached file skipped, essential first');
    assert.equal(res.complete, true);
    assert.deepEqual([res.count, res.total, res.bytes, res.totalBytes, res.failed], [4, 4, 32, 32, 0]);
    assert.equal(seen.at(-1).complete, true);
    assert.equal(seen.at(-1).count, 4);
    // every progress payload carries the same counters as status(): the panel must never read an undefined field
    for (const p of seen) {
      for (const k of ['count', 'total', 'wanted', 'bytes', 'skipped', 'sized', 'sizedTotal', 'tier1', 'tier1Present', 'tier2', 'tier2Present']) {
        assert.equal(typeof p[k], 'number', `progress.${k} while ${p.phase} (${JSON.stringify(p[k])})`);
      }
    }
    assert.equal(seen.at(-1).sizedTotal, 4, 'the manifest sized every file');
    assert.equal(seen.at(-1).count, 4);
    const cached = await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/spine/c.skel`);
    assert.equal(await cached.text(), 'x'.repeat(8));
    assert.equal(cached.headers.get('x-sp-resource'), '1', 'entries are marked as ours');
    assert.equal(cached.headers.get('accept-ranges'), 'bytes');
    assert.equal(cached.headers.get('content-length'), '8', 'an uncompressed response keeps its exact length');
  });

  test('a gzip response never keeps the compressed Content-Length (it would truncate the stored body)', async () => {
    const m = manifest([{ url: '/assets/spine/a.skel', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    const { fetch } = fetcherFor({ gzip: [`${ORIGIN}/assets/spine/a.skel`] });
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.equal(res.failed, 0);
    const cached = await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/spine/a.skel`);
    assert.equal(cached.headers.get('content-length'), null, 'fetch reports the compressed size (42) for a longer body');
    assert.equal(cached.headers.get('content-encoding'), null, 'the stored body is already decoded');
    assert.equal(cached.headers.get('content-type'), 'application/octet-stream', 'the type still follows the file');
    assert.equal(await cached.text(), 'x'.repeat(8));
  });

  test('two passes (tiers) can be run one after the other, as the controller does', async () => {
    const m = manifest([{ url: '/assets/ui/a.png', tier: 1, size: 8 }, { url: '/assets/spine/b.skel', tier: 2, size: 8 }]);
    const { fetch, calls } = fetcherFor();
    const s = store(m, { fetch });
    await s.download({ tiers: [1] });
    assert.deepEqual(calls, [`${ORIGIN}/assets/ui/a.png`]);
    const rest = await s.download({ tiers: [2] });
    assert.deepEqual(calls, [`${ORIGIN}/assets/ui/a.png`, `${ORIGIN}/assets/spine/b.skel`]);
    assert.equal(rest.complete, true);
  });

  test('a single failure is collected, not fatal; an opaque response is a failure too', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }, { url: '/assets/b.png', tier: 1, size: 8 }, { url: '/assets/c.png', tier: 1, size: 8 }]);
    const { fetch } = fetcherFor({ fail: [`${ORIGIN}/assets/a.png`], opaque: [`${ORIGIN}/assets/b.png`] });
    const s = store(m, { fetch });
    const res = await s.download();
    assert.equal(res.failed, 2);
    assert.equal(res.count, 1);
    assert.equal(res.complete, false);
    assert.deepEqual(res.failures.map((f) => f.url), ['/assets/a.png', '/assets/b.png'], 'the manifest keeps the original URL');
    assert.match(res.failures[0].message, /404/);
    assert.match(res.failures[1].message, /CORS/);
  });

  test('an abort stops the run and keeps what was already stored', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ url: `/assets/f${i}.png`, tier: 1, size: 8 }));
    const ac = new AbortController();
    let seen = 0;
    const { fetch, calls } = fetcherFor({ onCall: () => { if (++seen > 3) ac.abort(); } });
    const s = store(manifest(files), { fetch, smallLanes: 1 });
    await assert.rejects(() => s.download({ signal: ac.signal }), (err) => err.name === 'AbortError');
    assert.ok(calls.length <= 5, `stopped early (${calls.length} requests)`);
    const st = await s.status();
    assert.ok(st.count >= 3 && st.count < 12, `kept the finished files (${st.count})`);
  });

  test('a quota failure is reported as such (the UI tells the player, it does not retry 4 000 times)', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    const cache = await caches.open(CACHE_NAME);
    cache.put = async () => { const err = new Error('The quota has been exceeded.'); err.name = 'QuotaExceededError'; throw err; };
    const { fetch } = fetcherFor();
    const s = store(m, { caches, fetch });
    await assert.rejects(() => s.download(), (err) => err.name === 'QuotaExceededError');
  });

  test('files bigger than the cap are skipped, never fetched', async () => {
    const m = manifest([{ url: '/assets/small.png', tier: 1, size: 8 }, { url: '/assets/huge.png', tier: 2, size: 25 * 1024 * 1024 }]);
    const { fetch, calls } = fetcherFor();
    const s = store(m, { fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/small.png`]);
    assert.equal(res.skipped, 1);
    assert.equal(res.complete, true, 'the skipped file does not keep the preload incomplete');
  });

  test('progress is throttled but always ends with the final state', async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ url: `/assets/f${i}.png`, tier: 1, size: 8 }));
    let t = 0;
    const { fetch } = fetcherFor();
    const s = store(manifest(files), { fetch, smallLanes: 4, now: () => (t += 10) });
    const seen = [];
    const res = await s.download({ onProgress: (p) => seen.push(p) });
    assert.ok(seen.length < files.length, `throttled (${seen.length} updates for ${files.length} files)`);
    assert.equal(res.count, 30);
    assert.equal(seen[0].count, 0);
    assert.equal(seen.at(-1).phase, 'ready');
    assert.equal(seen.at(-1).count, res.count);
    assert.ok(seen.every((p, i) => i === 0 || p.count >= seen[i - 1].count), 'monotonic');
  });

  test('clear deletes every version, pruneOld only the stale ones', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/a.png`, new Response('old'));
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/legacy.png`, new Response('pre-hash layout'));
    await (await caches.open(cacheName('v0'))).put(`${ORIGIN}/assets/removed.png`, new Response('ancient'));
    await caches.open('unrelated-cache');
    const s = store(m, { caches, fetch: fetcherFor().fetch });
    assert.deepEqual((await s.pruneOld()).sort(), [`${CACHE_PREFIX}v0`, `${CACHE_PREFIX}v1`].sort());
    assert.deepEqual(await caches.keys(), [CACHE_NAME, 'unrelated-cache']);
    const after = await s.clear();
    assert.deepEqual(await caches.keys(), ['unrelated-cache'], 'other caches of the origin are never touched');
    assert.equal(after.count, 0);
  });

  test('an unchanged manifest downloads nothing at all', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }, { url: '/assets/b.png', tier: 2, size: 8 }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'aaa', 'h0');
    await seed(caches, `${ORIGIN}/assets/b.png`, 'bbb', 'h1');
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [], 'the hashes match: nothing is fetched');
    assert.equal(res.complete, true);
    assert.deepEqual([res.count, res.bytes], [2, 16]);
  });

  test('only the file whose hash changed is fetched again, and its bytes are replaced', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }, { url: '/assets/b.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'same-bytes', 'h0');
    await seed(caches, `${ORIGIN}/assets/b.png`, 'old-bytes', 'an-old-digest');
    const { fetch, calls } = fetcherFor({ bodies: { [`${ORIGIN}/assets/b.png`]: 'new-bytes' } });
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/b.png`]);
    assert.equal(res.complete, true, 'the replaced file closes the set');
    const cache = await caches.open(CACHE_NAME);
    assert.equal(await (await cache.match(`${ORIGIN}/assets/b.png`)).text(), 'new-bytes');
    assert.equal(await (await cache.match(`${ORIGIN}/assets/a.png`)).text(), 'same-bytes', 'the current file is left alone');
    const index = await (await cache.match(indexUrl(ORIGIN))).json();
    assert.deepEqual(index.files, { [`${ORIGIN}/assets/a.png`]: 'h0', [`${ORIGIN}/assets/b.png`]: 'h1' });
  });

  test('a file the manifest dropped is pruned, index record included', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'aaa', 'h0');
    await seed(caches, `${ORIGIN}/assets/gone.png`, 'orphan', 'old');
    const s = store(m, { caches, fetch: fetcherFor().fetch });
    assert.deepEqual(await s.prune(), { caches: [], files: 1 });
    const cache = await caches.open(CACHE_NAME);
    assert.equal(await cache.match(`${ORIGIN}/assets/gone.png`), undefined);
    assert.equal(await cache.match(`${ORIGIN}/assets/a.png`) !== undefined, true, 'the listed file stays');
    const index = await (await cache.match(indexUrl(ORIGIN))).json();
    assert.deepEqual(Object.keys(index.files), [`${ORIGIN}/assets/a.png`]);
  });

  test('a manifest without hashes keeps the old rule: whatever is cached counts as current', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8, hash: null }, { url: '/assets/b.png', tier: 1, size: 8, hash: null }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'aaa', null);
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/b.png`]);
    assert.equal(res.complete, true);
  });

  test('bodies saved before an index flush are recovered without downloading them again', async () => {
    const body = 'finished-before-tab-closed';
    const file = { url: '/assets/a.png', tier: 1, size: body.length, hash: await digest(body) };
    const caches = new MemoryCaches();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(`${ORIGIN}${file.url}`, new Response(body));
    const { fetch, calls } = fetcherFor();
    const s = store(manifest([file]), { caches, fetch });
    assert.equal((await s.status()).count, 0, 'the body has no recorded fingerprint yet');
    const res = await s.download();
    assert.deepEqual(calls, [], 'verified local bytes need no network request');
    assert.deepEqual([res.adopted, res.downloaded, res.complete], [1, 0, true]);
    assert.equal((await (await cache.match(indexUrl(ORIGIN))).json()).files[`${ORIGIN}${file.url}`], file.hash);
  });

  test('a stale current-cache body is removed before fetching, avoiding a worker integrity retry', async () => {
    const fresh = 'new-correct-bytes';
    const file = { url: '/assets/a.png', tier: 1, size: fresh.length, hash: await digest(fresh) };
    const caches = new MemoryCaches();
    const cache = await seed(caches, `${ORIGIN}${file.url}`, 'old-bytes', await digest('old-bytes'));
    const calls = [];
    const fetch = async (url) => { calls.push(url); return (await cache.match(url)) || new Response(fresh); };
    const res = await store(manifest([file]), { caches, fetch }).download();
    assert.deepEqual(calls, [`${ORIGIN}${file.url}`], 'the worker cannot return the stale body once it is removed');
    assert.deepEqual([res.failed, res.adopted, res.downloaded], [0, 0, 1]);
    assert.equal(await (await cache.match(`${ORIGIN}${file.url}`)).text(), fresh);
  });

  test('a cache of the previous layout is migrated, not re-downloaded', async () => {
    const bodies = { '/assets/a.png': 'aaa-bytes', '/assets/b.png': 'bbb-bytes-longer' };
    const files = [];
    for (const [url, body] of Object.entries(bodies)) files.push({ url, tier: 1, size: body.length, hash: await digest(body) });
    const m = manifest(files);
    const caches = new MemoryCaches();
    const legacy = await caches.open(cacheName('v1')); // the pre-hash layout: no index, no recorded hashes
    for (const [url, body] of Object.entries(bodies)) await legacy.put(`${ORIGIN}${url}`, new Response(body));
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [], 'every file was verified against its hash and moved: no network at all');
    assert.equal(res.adopted, 2);
    assert.equal(res.downloaded, 0);
    assert.equal(res.complete, true);
    assert.equal(await (await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/a.png`)).text(), 'aaa-bytes');
    assert.deepEqual(await caches.keys(), [CACHE_NAME], 'the emptied old cache is dropped once the set is complete');
    // and the migrated set is simply current next time (the index was written as the files moved)
    const again = await store(manifest(files), { caches, fetch: fetcherFor().fetch }).download();
    assert.equal(again.complete, true);
    assert.equal(again.adopted, 0);
  });

  test('a stale first legacy cache does not hide a verified copy in another legacy cache', async () => {
    const body = 'already-downloaded-correct-bytes';
    const file = { url: '/assets/a.png', tier: 1, size: body.length, hash: await digest(body) };
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}${file.url}`, new Response('stale'));
    await (await caches.open(cacheName('v2'))).put(`${ORIGIN}${file.url}`, new Response(body));
    const { fetch, calls } = fetcherFor();
    const result = await store(manifest([file]), { caches, fetch }).download();
    assert.deepEqual(calls, [], 'a later hash-verified cached copy avoids a network download');
    assert.deepEqual([result.adopted, result.downloaded, result.complete], [1, 0, true]);
    assert.equal(await (await (await caches.open(CACHE_NAME)).match(`${ORIGIN}${file.url}`)).text(), body);
  });

  test('a stale entry in an old cache is dropped and fetched, never left to shadow the new file', async () => {
    const fresh = 'new-bytes';
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: fresh.length, hash: await digest(fresh) }]);
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('old-bytes'));
    const { fetch, calls } = fetcherFor({ bodies: { [`${ORIGIN}/assets/a.png`]: fresh } });
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/a.png`], 'the stored bytes do not match the manifest hash');
    assert.deepEqual([res.adopted, res.downloaded], [0, 1]);
    assert.deepEqual(await caches.keys(), [CACHE_NAME], 'the stale copy went with the old cache');
    assert.equal(await (await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/a.png`)).text(), fresh);
  });

  test('a download is verified: bytes a stale Service Worker would hand back are re-asked for', async () => {
    const fresh = 'fresh-bytes';
    const hash = await digest(fresh);
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: fresh.length, hash }]);
    const caches = new MemoryCaches();
    // the first answer is what an older worker's cache would return; the retry carries a query no entry matches
    const { fetch, calls } = fetcherFor({ bodies: { [`${ORIGIN}/assets/a.png`]: 'stale-bytes', [`${ORIGIN}/assets/a.png?sp=${hash}`]: fresh } });
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.equal(calls.length, 2, `asked twice (${calls.join(' , ')})`);
    assert.match(calls[1], /\?sp=/);
    assert.equal(res.failed, 0);
    assert.equal(res.adopted, 0);
    assert.equal(res.downloaded, 1);
    assert.equal(await (await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/a.png`)).text(), fresh, 'the canonical key holds the verified bytes');
  });

  test('a synthetic hash is never verified against cached bytes (there is nothing to compare)', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8, hash: 'syn-07572a8a157e' }]);
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('whatever'));
    const { fetch, calls } = fetcherFor();
    const res = await store(m, { caches, fetch }).download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/a.png`]);
    assert.equal(res.adopted, 0);
    assert.equal(res.downloaded, 1);
  });

  test('an interrupted run keeps the progress it flushed', async () => {
    const files = Array.from({ length: 70 }, (_, i) => ({ url: `/assets/f${i}.png`, tier: 1, size: 8 }));
    const ac = new AbortController();
    let seen = 0;
    const { fetch } = fetcherFor({ onCall: () => { if (++seen > 66) ac.abort(); } });
    const caches = new MemoryCaches();
    const s = store(manifest(files), { caches, fetch, smallLanes: 1 });
    await assert.rejects(() => s.download({ signal: ac.signal }), (err) => err.name === 'AbortError');
    const st = await s.status();
    assert.ok(st.count >= 64 && st.count <= 66, `the index was flushed mid-run (${st.count} kept)`);
    const calls2 = fetcherFor().calls;
    const s2 = store(manifest(files), { caches, fetch: fetcherFor({ onCall: (u) => calls2.push(u) }).fetch });
    await s2.download();
    assert.ok(calls2.length <= 6, `the next run only fetches the remainder (${calls2.length})`);
  });

  test('a second download while one is running is the same promise (no double run)', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const { fetch, calls } = fetcherFor({ onCall: () => gate });
    const s = store(m, { fetch });
    const a = s.download();
    const b = s.download();
    assert.equal(a, b);
    release();
    const res = await a;
    assert.equal(calls.length, 1);
    assert.equal(res.count, 1);
  });
});

describe('the Service Worker handler', () => {
  const cached = async () => {
    const caches = new MemoryCaches();
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/a.png`, new Response('0123456789', { headers: { 'Content-Type': 'image/png' } }));
    return caches;
  };

  test('serves a cached resource, with ranges', async () => {
    const caches = await cached();
    const full = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(full.status, 200);
    assert.equal(await full.text(), '0123456789');
    const part = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`, { headers: { Range: 'bytes=2-4' } }), { caches });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '234');
    assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  });

  test('a CDN URL is answered from the cache as well (the resource may live elsewhere)', async () => {
    const caches = new MemoryCaches();
    const url = 'https://cdn.example.com/static/assets/spine/x.skel';
    // a cache of the pre-hash layout: the worker serves from every cache this app wrote, so an update never blanks out
    await (await caches.open(cacheName('legacy'))).put(url, new Response('skel-bytes'));
    const res = await handleResourceRequest(new Request(url), { caches });
    assert.equal(await res.text(), 'skel-bytes');
  });

  test('the current cache wins over an older one (a migrated file is never shadowed by a stale copy)', async () => {
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('stale'));
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/a.png`, new Response('fresh'));
    const res = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(await res.text(), 'fresh');
  });

  test('the extension-less audio route is answered from the canonical file the manifest lists', async () => {
    const caches = new MemoryCaches();
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/audio/bgm/act1.mp3`, new Response('mp3-bytes', { headers: { 'Content-Type': 'audio/mpeg' } }));
    // Since 0.1.2 the game asks for audio as /media/bgm/act1 (download managers hijack *.mp3 requests, shared/media.js);
    // what the preload stored is the canonical /assets/audio/bgm/act1.mp3 the manifest lists.
    const res = await handleResourceRequest(new Request(`${ORIGIN}/media/bgm/act1`), { caches });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg', 'the stored type is what Web Audio sniffs');
    assert.equal(await res.text(), 'mp3-bytes');
  });

  test('the audio route tries the extensions in the server order, and gives up like the server does', async () => {
    const caches = new MemoryCaches();
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/audio/bgm/act1.ogg`, new Response('ogg-bytes'));
    assert.equal(await (await handleResourceRequest(new Request(`${ORIGIN}/media/bgm/act1`), { caches })).text(), 'ogg-bytes', 'a later candidate still hits');
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/media/bgm/act2`), { caches }), null, 'nothing stored → the network answers');
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/media/../data/assets.json`), { caches }), null, 'a dot segment is refused, as serveMedia refuses it');
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/media/bgm/act1.png`), { caches }), null, 'not an audio extension: the name keeps its tail, so no entry matches');
  });

  test('anything that is not a cached resource is left to the network (null)', async () => {
    const caches = await cached();
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/missing.png`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/js/main.js`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/data/assets.json`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/api/hello`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/ws`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`, { method: 'POST' }), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches: null }), null);
    const empty = new MemoryCaches();
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches: empty }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`, { headers: { Range: 'bytes=99-100' } }), { caches: await cached() }).then((r) => r.status), 416);
  });

  test('the cached entry survives a re-serve (a range reply never mutates the cache)', async () => {
    const caches = await cached();
    const hit = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(hit.headers.get('accept-ranges'), null, 'the stored response is served as stored');
    await rangeResponse(await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/a.png`), 'bytes=0-1');
    const again = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(await again.text(), '0123456789');
  });
});

 test('a new immutable URL reuses unchanged content and only downloads changed art', async () => {
  const caches = new MemoryCaches();
  const old = '/_v/1111111111111111/assets/';
  const next = '/_v/2222222222222222/assets/';
  const sameHash = await digest('same');
  await seed(caches, ORIGIN + old + 'same.png', 'same', sameHash);
  await seed(caches, ORIGIN + old + 'changed.png', 'old', await digest('old'));
  const m = manifest([{ url: next + 'same.png', tier: 1, hash: sameHash }, { url: next + 'changed.png', tier: 1, hash: await digest('new') }]);
  const { fetch, calls } = fetcherFor({ bodies: { [ORIGIN + next + 'changed.png']: 'new' } });
  const store = new ResourceStore(m, { caches, fetcher: fetch, origin: ORIGIN });
  const result = await store.download();
  assert.equal(result.complete, true);
  assert.equal(result.adopted, 1);
  assert.deepEqual(calls, [ORIGIN + next + 'changed.png']);
  assert.equal(await (await caches.open(CACHE_NAME)).match(ORIGIN + old + 'same.png'), undefined);
});

test('a CDN hash mismatch after retry never counts as current', async () => {
  const caches = new MemoryCaches();
  const hash = await digest('expected');
  const m = manifest([{ url: '/assets/a.png', tier: 1, hash }]);
  const { fetch, calls } = fetcherFor({ bodies: { [ORIGIN + '/assets/a.png']: 'stale', [ORIGIN + '/assets/a.png?sp=' + hash]: 'stale' } });
  const store = new ResourceStore(m, { caches, fetcher: fetch, origin: ORIGIN });
  const result = await store.download();
  assert.equal(result.failed, 1);
  assert.equal(result.complete, false);
  assert.equal(result.count, 0);
  assert.equal(calls.length, 2);
});

test('versioned media routes resolve cached audio and preserve range responses', async () => {
  const caches = new MemoryCaches();
  const root = '/_v/1234567890abcdef';
  await seed(caches, ORIGIN + root + '/assets/audio/bgm/act1.mp3', 'abcdef', 'test');
  const res = await handleResourceRequest(new Request(ORIGIN + root + '/media/bgm/act1', { headers: { Range: 'bytes=1-3' } }), { caches });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), 'bcd');
});

/**
 * 干员皮肤 in the preload selection (docs/SKINS.md): a full install is ~328 MiB, so it has a box of its own in the
 * optional tier's header — 默认全预载, and the outfits equipped in 干员调配 decide which of them are cached.
 */
describe('干员皮肤 selection', () => {
  const KALTS = 'char_003_kalts/char_003_kalts@boc#6';
  const AMIYA = 'char_002_amiya/char_002_amiya_winter_1';
  const FILES = [
    { url: '/assets/spine/op/char_003_kalts/front/char_003_kalts.skel', tier: TIER_ESSENTIAL, size: 10 },
    { url: '/assets/audio/voice/cn/char_003_kalts/1.mp3', tier: TIER_REST, size: 20 },
    { url: '/assets/audio/voice/jp/char_003_kalts/1.mp3', tier: TIER_REST, size: 20 },
    { url: '/assets/spine/op/char_003_kalts/char_003_kalts_boc_6/front/char_003_kalts_boc_6.skel', tier: TIER_REST, size: 100, skin: KALTS },
    { url: '/assets/char/avatar/skin/char_003_kalts_boc_6.png', tier: TIER_REST, size: 5, skin: KALTS },
    { url: '/assets/spine/op/char_002_amiya/char_002_amiya_winter_1/front/char_002_amiya_winter_1.skel', tier: TIER_REST, size: 90, skin: AMIYA },
  ];

  test('normalizeSkinKeys: keys only, junk dropped', () => {
    assert.deepEqual([...normalizeSkinKeys(null)], []);
    assert.deepEqual([...normalizeSkinKeys('off')], []);
    assert.deepEqual([...normalizeSkinKeys([KALTS])], [KALTS]);
    assert.deepEqual([...normalizeSkinKeys(new Set([KALTS, KALTS]))], [KALTS]);
    assert.deepEqual([...normalizeSkinKeys({ keys: [KALTS] })], [KALTS]);
    assert.deepEqual([...normalizeSkinKeys({ keys: ['../etc/passwd', 42, 'char_a/x.png', ''] })], [], 'a hand-edited blob cannot widen the selection');
  });

  test('normalizeSkinScope: 全部皮肤 is its own flag, never a side effect of a key list', () => {
    assert.deepEqual(normalizeSkinScope(null), { keys: new Set(), all: false });
    assert.deepEqual(normalizeSkinScope('off'), { keys: new Set(), all: false });
    assert.deepEqual(normalizeSkinScope('all'), { keys: new Set(), all: true });
    assert.deepEqual(normalizeSkinScope({ keys: [KALTS], all: true }), { keys: new Set([KALTS]), all: true });
    assert.deepEqual(normalizeSkinScope({ keys: [KALTS] }), { keys: new Set([KALTS]), all: false });
    assert.deepEqual(normalizeSkinScope([KALTS]).all, false, 'a plain list is not every outfit');
    assert.deepEqual(normalizeSkinScope({ all: 'yes' }), { keys: new Set(), all: false }, 'only a real boolean widens it');
  });

  test('nothing equipped: skins out of the selection, the rest of the optional set unchanged', async () => {
    const s = store(manifest(FILES));
    assert.deepEqual(s.skinKeys(), []);
    s.setScope({ optional: true, voiceLang: 'cn' });
    const urls = s.selectedFiles.map((f) => f.url);
    assert.ok(urls.includes('/assets/audio/voice/cn/char_003_kalts/1.mp3'));
    assert.ok(!urls.includes('/assets/audio/voice/jp/char_003_kalts/1.mp3'), 'the other language stays out');
    assert.ok(!urls.includes('/assets/spine/op/char_003_kalts/char_003_kalts_boc_6/front/char_003_kalts_boc_6.skel'));
    const st = await s.status();
    assert.equal(st.skins.length, 2, 'both installed outfits are listed with their counters');
    const kalts = st.skins.find((x) => x.id === KALTS);
    assert.deepEqual([kalts.files, kalts.wanted, kalts.present, kalts.totalBytes], [2, 0, 0, 105]);
    assert.equal(st.wanted, 2, 'required tier + the cn voice, nothing else');
  });

  test('the equipped outfit is what gets fetched, and never the voices with it', async () => {
    const { fetch, calls } = fetcherFor();
    const s = store(manifest(FILES), { fetch });
    s.setScope({ optional: false, skins: [KALTS] });
    // 额外资源 off and the voices stay out — an equipped outfit must never drag them along (and vice versa).
    assert.deepEqual(s.selectedFiles.map((f) => f.url).sort(), [
      '/assets/char/avatar/skin/char_003_kalts_boc_6.png',
      '/assets/spine/op/char_003_kalts/char_003_kalts_boc_6/front/char_003_kalts_boc_6.skel',
      '/assets/spine/op/char_003_kalts/front/char_003_kalts.skel',
    ].sort());
    const st = await s.status();
    assert.equal(st.tier2Wanted, 2, 'the equipped outfit is what tier 2 means here');
    assert.equal(st.groups.find((g) => g.id === 'skin').tier, TIER_REST);
    await s.download({ tiers: [TIER_ESSENTIAL] });
    await s.download({ tiers: [TIER_REST] });
    assert.ok(!calls.some((u) => u.includes('amiya_winter_1')), 'an outfit nobody equipped is never fetched');
    assert.ok(!calls.some((u) => u.includes('/audio/voice/')), 'and neither is a voice');
    const after = await s.status();
    assert.equal(after.complete, true);
    assert.equal(after.skins.find((x) => x.id === KALTS).present, 2);
  });

  test('changing the equipped outfit changes the selection (that is the auto-download path)', async () => {
    const s = store(manifest(FILES));
    s.setScope({ optional: false, skins: [KALTS] });
    assert.equal(s.selectedFiles.filter((f) => f.skin).length, 2);
    s.setScope({ optional: false, skins: [AMIYA] });
    assert.deepEqual(s.skinKeys(), [AMIYA]);
    assert.deepEqual(s.selectedFiles.filter((f) => f.skin).map((f) => f.url), ['/assets/spine/op/char_002_amiya/char_002_amiya_winter_1/front/char_002_amiya_winter_1.skel']);
    s.setScope({ optional: false, skins: 'off' });
    assert.equal(s.selectedFiles.filter((f) => f.skin).length, 0);
  });

  test('全部皮肤: every installed outfit is wanted, whatever 干员调配 has equipped', async () => {
    const s = store(manifest(FILES));
    s.setScope({ optional: false, skins: { all: true } });
    assert.deepEqual(s.skinKeys(), [], 'no individual pick is needed');
    assert.deepEqual(s.skinScope(), { keys: [], all: true });
    assert.deepEqual(s.selectedFiles.filter((f) => f.skin).map((f) => f.url).sort(), [
      '/assets/char/avatar/skin/char_003_kalts_boc_6.png',
      '/assets/spine/op/char_002_amiya/char_002_amiya_winter_1/front/char_002_amiya_winter_1.skel',
      '/assets/spine/op/char_003_kalts/char_003_kalts_boc_6/front/char_003_kalts_boc_6.skel',
    ].sort());
    assert.ok(!s.selectedFiles.some((f) => f.url.includes('/audio/voice/')), 'the voices still need 额外资源');
    const st = await s.status();
    assert.deepEqual(st.skins.map((x) => x.id), [AMIYA, KALTS]);
    assert.deepEqual(st.skins.map((x) => x.wanted), [1, 2], 'each listed outfit counts its own files');
    assert.deepEqual(st.skinScope, { keys: [], all: true });
    // Turning it off empties the scope again — nothing accumulated a key list behind the player's back.
    s.setScope({ optional: false, skins: 'off' });
    assert.equal(s.selectedFiles.filter((f) => f.skin).length, 0);
    assert.deepEqual(s.skinScope(), { keys: [], all: false });
  });

  test('the voice language filter still applies inside a selection, and clearing optional removes skins', async () => {
    const caches = new MemoryCaches();
    const s = store(manifest(FILES), { caches });
    s.setScope({ optional: true, voiceLang: 'jp', skins: [KALTS, AMIYA] });
    const urls = s.selectedFiles.map((f) => f.url);
    assert.ok(urls.includes('/assets/audio/voice/jp/char_003_kalts/1.mp3'));
    assert.ok(!urls.includes('/assets/audio/voice/cn/char_003_kalts/1.mp3'));
    await seed(caches, `${ORIGIN}/assets/char/avatar/skin/char_003_kalts_boc_6.png`, 'skin', 'h4');
    assert.equal((await s.status()).skins.find((x) => x.id === KALTS).present, 1);
    await s.clear({ optionalOnly: true });
    assert.equal((await s.status()).skins.find((x) => x.id === KALTS).present, 0, 'skins are optional resources too');
  });

  test('a skin listed twice keeps its key and the lowest tier', () => {
    const shared = '/assets/char/avatar/skin/shared.png';
    const files = collectResourceFiles({ chars: { c: { avatar: shared, skins: { 'c@x#1': { avatar: shared } } } } }, null);
    assert.equal(files[0].skin, 'c/c@x#1');
    assert.equal(files[0].tier, TIER_ESSENTIAL, 'the required listing wins the tier');
  });
});

/**
 * 官方特效 in the preload selection (docs/design/vfx-format.md): the extracted effect tree is one indivisible set of
 * ~185 MiB, so it gets a box of its own in the optional tier's header — beside 额外资源 and 皮肤, and never implied by
 * either of them in either direction.
 */
describe('官方特效 selection', () => {
  const FILES = [
    { url: '/assets/spine/op/char_003_kalts/front/char_003_kalts.skel', tier: TIER_ESSENTIAL, size: 10 },
    { url: '/assets/audio/voice/cn/char_003_kalts/1.mp3', tier: TIER_REST, size: 20 },
    { url: '/assets/local/fx/index.json', tier: TIER_REST, size: 5, fx: true },
    { url: '/assets/local/fx/tex/fire_1.webp', tier: TIER_REST, size: 40, fx: true },
    { url: '/assets/local/fx/tex/half/fire_1.webp', tier: TIER_REST, size: 12, fx: true },
  ];

  test('特效 rides its own switch: 额外资源 off keeps the whole tree, and not one voice comes with it', async () => {
    const { fetch, calls } = fetcherFor();
    const s = store(manifest(FILES), { fetch });
    s.setScope({ optional: false, fx: true });
    assert.deepEqual(s.selectedFiles.filter((f) => f.fx).map((f) => f.url), [
      '/assets/local/fx/index.json',
      '/assets/local/fx/tex/fire_1.webp',
      '/assets/local/fx/tex/half/fire_1.webp',
    ]);
    assert.ok(!s.selectedFiles.some((f) => f.url.includes('/audio/voice/')), '额外资源 stays out');
    const st = await s.status();
    const group = st.groups.find((g) => g.id === 'fx');
    assert.equal(group.tier, TIER_REST);
    assert.deepEqual([group.total, group.wanted], [3, 3], 'a row of its own, not folded into 玩法说明与其他资源');
    assert.equal(st.wanted, 4, 'the required spine plus the three effect files');
    await s.download({ tiers: [TIER_ESSENTIAL] });
    await s.download({ tiers: [TIER_REST] });
    assert.equal(calls.filter((u) => u.includes('/assets/local/fx/')).length, 3);
    const after = await s.status();
    assert.equal(after.complete, true);
    assert.equal(after.groups.find((g) => g.id === 'fx').present, 3);
  });

  test('the two switches are independent: 特效 off keeps 额外资源, and the other way round', async () => {
    const s = store(manifest(FILES));
    s.setScope({ optional: true, fx: false });
    const urls = s.selectedFiles.map((f) => f.url);
    assert.ok(urls.includes('/assets/audio/voice/cn/char_003_kalts/1.mp3'));
    assert.ok(!urls.some((u) => u.startsWith('/assets/local/fx/')), 'not a single effect file');
    const st = await s.status();
    const fxRow = st.groups.find((g) => g.id === 'fx');
    assert.ok(fxRow, 'the 特效 row is still listed once its switch is off');
    assert.deepEqual([fxRow.total, fxRow.wanted, fxRow.allTotal], [0, 0, 3], 'greyed out, not deleted: the figures are manifest-wide');
    s.setScope({ fx: true });
    assert.equal(s.fx, true);
    assert.equal(s.selectedFiles.filter((f) => f.fx).length, 3, 'back on, without touching the voices');
    s.setScope({ optional: false });
    assert.equal(s.selectedFiles.filter((f) => f.fx).length, 3, 'fx ignores the 额外资源 switch in both directions');
    s.setScope({ optional: false, fx: false });
    assert.deepEqual(s.selectedFiles.map((f) => f.url), ['/assets/spine/op/char_003_kalts/front/char_003_kalts.skel']);
  });

  test('clearing the optional resources takes the effects with them', async () => {
    const caches = new MemoryCaches();
    const s = store(manifest(FILES), { caches });
    s.setScope({ optional: true, fx: true });
    await seed(caches, `${ORIGIN}/assets/local/fx/tex/fire_1.webp`, 'fx', 'h3');
    assert.equal((await s.status()).groups.find((g) => g.id === 'fx').present, 1);
    await s.clear({ optionalOnly: true });
    assert.equal((await s.status()).groups.find((g) => g.id === 'fx').present, 0, '特效 is an optional resource too');
  });
});
