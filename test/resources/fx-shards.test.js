import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CACHE_NAME, CACHE_PREFIX, FX_CACHE_NAMES, LEGACY_FX_CACHE_NAME, cacheKeysOverBudget,
  cacheNameForFile, fxCacheName, indexUrl } from '../../public/js/resources/common.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { createResourceResponder } from '../../public/js/resources/readThrough.js';
import { handleResourceRequest } from '../../public/js/resources/service.js';
import { exportResourceZip, importResourceZip } from '../../public/js/resources/archive.js';

const origin = 'https://game.example';
const digest = (bytes, algorithm = 'sha1') => createHash(algorithm).update(bytes).digest('hex');
class MemoryCache {
  entries = new Map();
  async put(key, response) {
    const stored = response.clone();
    await response.arrayBuffer(); // Native Cache.put consumes the supplied body.
    this.entries.set(key, stored);
  }
  async match(key) { return this.entries.get(typeof key === 'string' ? key : key.url)?.clone(); }
  async keys() { return [...this.entries.keys()].map((key) => new Request(key)); }
  async delete(key) { return this.entries.delete(key); }
}
class MemoryCaches {
  entries = new Map();
  async open(name) { if (!this.entries.has(name)) this.entries.set(name, new MemoryCache()); return this.entries.get(name); }
  async keys() { return [...this.entries.keys()]; }
  async delete(name) { return this.entries.delete(name); }
}
function fixture(count = 80, caches = new MemoryCaches()) {
  const files = Array.from({ length: count }, (_, i) => {
    const body = `effect-${i}`;
    return { url: `https://assets.example/assets/local/fx/prefabs/effect_${i}.json`,
      fx: true, tier: 2, body, size: body.length, hash: digest(body).slice(0, 12) };
  });
  let requests = 0;
  const store = new ResourceStore({ version: 'fx-shards', files }, { origin, caches, fetcher: async (url) => {
    requests++;
    return new Response(files.find((file) => file.url === url).body);
  } });
  return { store, files, caches, get requests() { return requests; } };
}
async function seedLegacy(f) {
  const cache = await f.caches.open(LEGACY_FX_CACHE_NAME);
  const files = {};
  for (const file of f.files) {
    await cache.put(file.url, f.store.storable(new Response(file.body, {
      headers: { 'Content-Length': String(file.size) },
    }), file.hash));
    files[file.url] = file.hash;
  }
  await cache.put(indexUrl(origin), new Response(JSON.stringify({ version: 1, files })));
  return cache;
}
async function assertMigrated(f) {
  for (const file of f.files) {
    const cache = await f.caches.open(cacheNameForFile(file));
    assert.equal(await (await cache.match(file.url)).text(), file.body);
    assert.equal((await (await cache.match(indexUrl(origin))).json()).files[file.url], file.hash);
    assert.equal(await (await f.caches.open(LEGACY_FX_CACHE_NAME)).match(file.url), undefined);
  }
  const status = await f.store.status();
  assert.equal(status.count, f.files.length);
  assert.equal(status.misplaced, false);
  assert.equal(f.requests, 0);
}

test('effect shards stay stable across CDN changes, version queries, release prefixes and escaped paths', () => {
  const path = '/assets/local/fx/tex/[test]fire.png';
  const expected = fxCacheName(path);
  for (const url of [path, encodeURI(path), `https://cdn.example${path}?v=0123456789abcdef`,
    `https://other.example/_v/0123456789abcdef${encodeURI(path)}`]) {
    assert.equal(cacheNameForFile({ url, fx: true, tier: 2 }), expected);
  }
  assert.equal(cacheNameForFile({ url: path, tier: 2 }), CACHE_NAME, 'an unmarked file keeps its ordinary card');
  assert.equal(cacheNameForFile({ url: path, tier: 2, fx: true, skin: 'char/skin' }), CACHE_PREFIX + 'skin');
});

test('a 23,720-file effects set exceeding the old key budget fits comfortably into eight shards', () => {
  const keys = Array.from({ length: 23720 }, (_, i) => `https://assets.example/assets/local/fx/prefabs/enemy_skill_hit_${i}.json`);
  assert.equal(cacheKeysOverBudget(keys), true);
  const buckets = FX_CACHE_NAMES.map((name) => keys.filter((key) => fxCacheName(key) === name));
  assert.ok(buckets.every((bucket) => bucket.length > 2500 && bucket.length < 3500));
  assert.ok(buckets.every((bucket) => !cacheKeysOverBudget(bucket, 2 * 1024 * 1024)));
});

test('fresh downloads use eight indexed shards and repeated preload performs no downloads', async () => {
  const f = fixture();
  assert.equal((await f.store.download()).complete, true);
  assert.equal(f.requests, 80);
  assert.deepEqual((await f.caches.keys()).sort(), [...FX_CACHE_NAMES].sort());
  assert.equal((await f.store.download()).downloaded, 0);
  assert.equal(f.requests, 80);
});

test('legacy effects remain counted and readable, migrate without downloads, and resume as a no-op', async () => {
  const f = fixture();
  const legacy = await seedLegacy(f);
  const before = await f.store.status();
  assert.equal(before.complete, true);
  assert.equal(before.misplaced, true);
  assert.equal(await (await handleResourceRequest(new Request(f.files[0].url), { caches: f.caches })).text(), f.files[0].body);
  const remove = legacy.delete.bind(legacy);
  legacy.delete = async (key) => {
    const file = f.files.find((file) => file.url === key);
    const target = await f.caches.open(cacheNameForFile(file));
    assert.equal((await (await target.match(indexUrl(origin))).json()).files[key], file.hash,
      'the destination index must be durable before deleting a source');
    return remove(key);
  };
  assert.equal(await f.store.migrateCaches(), 80);
  await assertMigrated(f);
  assert.equal(await f.store.migrateCaches(), 0);
});

test('an oversized legacy index is migrated without attempting its refused keys query', async () => {
  const f = fixture();
  const legacy = await seedLegacy(f);
  const index = await (await legacy.match(indexUrl(origin))).json();
  for (let i = 0; i < 20000; i++) index.files[`${origin}/assets/removed_fx/${i}.json`] = 'h0';
  await legacy.put(indexUrl(origin), new Response(JSON.stringify(index)));
  const keys = legacy.keys.bind(legacy);
  legacy.keys = async () => {
    const current = await (await legacy.match(indexUrl(origin))).json();
    assert.equal(cacheKeysOverBudget(Object.keys(current.files)), false, 'never enumerate an over-budget legacy cache');
    return keys();
  };
  assert.equal((await f.store.status()).scan, 'index');
  await f.store.migrateCaches();
  await f.store.pruneStale();
  await assertMigrated(f);
});

test('migration cancellation keeps all source bytes and a new store resumes without downloads', async () => {
  const f = fixture();
  const legacy = await seedLegacy(f);
  const controller = new AbortController();
  const target = await f.caches.open(cacheNameForFile(f.files[1]));
  const put = target.put.bind(target);
  target.put = async (key, value) => {
    await put(key, value);
    if (key === f.files[1].url) controller.abort();
  };
  await assert.rejects(f.store.migrateCaches({ signal: controller.signal }), { name: 'AbortError' });
  for (const file of f.files) assert.ok(await legacy.match(file.url));
  target.put = put;
  const resumed = fixture(80, f.caches);
  assert.equal((await resumed.store.status()).count, 80, 'duplicates never inflate the count');
  await resumed.store.migrateCaches();
  await assertMigrated(resumed);
});

test('legacy bytes survive an interrupted source deletion because destination indexes were already committed', async () => {
  const f = fixture();
  const legacy = await seedLegacy(f);
  const remove = legacy.delete.bind(legacy);
  let removed = 0;
  legacy.delete = async (key) => {
    const result = await remove(key);
    if (++removed === 3) throw new Error('interrupted deletion');
    return result;
  };
  await assert.rejects(f.store.migrateCaches(), /interrupted deletion/);
  for (const file of f.files) assert.ok(await f.store.cachedResponse(file));
  legacy.delete = remove;
  await f.store.migrateCaches();
  await assertMigrated(f);
});

test('an unindexed legacy cache with refused enumeration recovers through known paths and verifies bytes locally', async () => {
  const f = fixture();
  const legacy = await seedLegacy(f);
  await legacy.delete(indexUrl(origin));
  const keys = legacy.keys.bind(legacy);
  legacy.keys = async () => {
    const rows = await keys();
    if (rows.some((key) => new URL(key.url).pathname.includes('/assets/'))) throw new DOMException('Operation too large', 'AbortError');
    return rows;
  };
  assert.equal((await f.store.status()).misplaced, true);
  await f.store.migrateCaches();
  await assertMigrated(f);
});

test('disabling effects retains old and migrated cached effects through housekeeping', async () => {
  const f = fixture();
  await seedLegacy(f);
  f.store.setScope({ optional: false, fx: false });
  await f.store.prune();
  assert.ok(await f.store.cachedResponse(f.files[0]));
  await f.store.migrateCaches();
  await f.store.prune();
  assert.equal((await f.store.status()).fxPresent, 80);
  f.store.setScope({ fx: true });
  await assertMigrated(f);
});

test('destination index quota failure never deletes the only source copy', async () => {
  const f = fixture();
  const legacy = await seedLegacy(f);
  const target = await f.caches.open(cacheNameForFile(f.files[0]));
  const put = target.put.bind(target);
  target.put = async (key, value) => {
    if (key === indexUrl(origin)) throw new DOMException('full', 'QuotaExceededError');
    return put(key, value);
  };
  await assert.rejects(f.store.migrateCaches(), { name: 'QuotaExceededError' });
  for (const file of f.files) assert.ok(await legacy.match(file.url));
  target.put = put;
  await f.store.migrateCaches();
  await assertMigrated(f);
});

test('a newer destination copy wins over an older legacy duplicate in status and migration', async () => {
  const f = fixture(1);
  await seedLegacy(f);
  const current = { ...f.files[0], body: 'newer effect', size: 12, hash: digest('newer effect').slice(0, 12) };
  const store = new ResourceStore({ version: 'new', files: [current] }, { origin, caches: f.caches });
  await store.importFiles([current], { read: () => new TextEncoder().encode(current.body) });
  assert.equal((await store.status()).count, 1);
  await store.migrateCaches();
  assert.equal(await (await store.cachedResponse(current)).text(), current.body);
  assert.equal((await store.status()).count, 1);
});

test('versioned cold-worker and unversioned runtime reads go straight to the right effect shard offline', async () => {
  const f = fixture();
  await f.store.importFiles(f.files, { read: (file) => new TextEncoder().encode(file.body) });
  const responder = createResourceResponder({ origin, caches: f.caches,
    getManifest: () => { throw new Error('cold manifest must not be needed'); },
    fetcher: () => { throw new Error('must not access CDN'); } });
  const names = await f.caches.keys();
  for (const name of names) {
    const cache = await f.caches.open(name);
    const match = cache.match.bind(cache);
    cache.match = (key) => {
      if (String(key).includes('/assets/')) assert.equal(name, fxCacheName(key), 'the runtime should search its own shard first');
      return match(key);
    };
  }
  for (const file of f.files.slice(0, 8)) {
    const response = await responder.respond(new Request(file.url + '?v=' + digest(file.body, 'sha256').slice(0, 16),
      { headers: { Range: 'bytes=0-2' } }));
    assert.equal(response.status, 206);
    assert.equal(await response.text(), file.body.slice(0, 3));
    assert.equal(await (await handleResourceRequest(new Request(file.url), { caches: f.caches })).text(), file.body);
  }
});

test('runtime cache writes and worker cached-only receipts share the preload shard', async () => {
  const f = fixture(1);
  let requests = 0;
  const responder = createResourceResponder({ origin, caches: f.caches, getManifest: async () => ({ files: f.files }),
    fetcher: async () => { requests++; return new Response(f.files[0].body); } });
  assert.equal(await (await responder.respond(new Request(f.files[0].url))).text(), f.files[0].body);
  const cache = await f.caches.open(cacheNameForFile(f.files[0]));
  assert.ok(await cache.match(f.files[0].url));
  assert.equal((await responder.ensureCached({ ...f.files[0], cachedOnly: true })).cached, true);
  assert.equal(requests, 1);
});

test('ZIP export/import spans effect shards, selective cleanup preserves essential art and full clear removes all shards', async () => {
  const f = fixture();
  await seedLegacy(f);
  await f.store.migrateCaches();
  const exported = await exportResourceZip(f.store);
  const target = fixture();
  assert.equal((await importResourceZip(target.store, exported.blob)).imported, 80);
  assert.equal(target.requests, 0);
  const essential = { url: '/assets/ui/a.png', tier: 1, size: 1, hash: digest('a').slice(0, 12) };
  const store = new ResourceStore({ version: 'clear', files: [...target.files, essential] }, { origin, caches: target.caches });
  await store.importFiles([essential], { read: () => new TextEncoder().encode('a') });
  await store.clear({ optionalOnly: true });
  assert.equal((await store.status()).count, 1);
  assert.equal(await (await store.cachedResponse(essential)).text(), 'a');
  await target.caches.open('unrelated-cache');
  await store.clear();
  assert.deepEqual(await target.caches.keys(), ['unrelated-cache']);
});
