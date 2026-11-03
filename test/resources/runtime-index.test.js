// The runtime-existence document is a leftover of older builds: the cache entry is the only record of what the page
// holds. These tests pin down that `status()` reads the real cards and that a sweep deletes the document without ever
// counting it as an asset (public/js/resources/store.js, runtimeIndex.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_NAME, indexUrl } from '../../public/js/resources/common.js';
import { runtimeIndexUrl } from '../../public/js/resources/runtimeIndex.js';
import { ResourceStore } from '../../public/js/resources/store.js';

const ORIGIN = 'https://game.example';

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

function manifest(files) {
  return { format: 1, version: 'v1', count: files.length, tier1: files.filter((f) => f.tier === 1).length, files };
}

/** Put a body and its hash into the preload cache the way a finished run leaves it. */
async function seed(caches, url, body, hash) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(url, new Response(body));
  const res = await cache.match(indexUrl(ORIGIN));
  const doc = res ? await res.json() : { version: 1, manifest: '', files: {} };
  doc.files[url] = hash;
  await cache.put(indexUrl(ORIGIN), new Response(JSON.stringify(doc)));
  return cache;
}

test('status counts the entries a card really holds, not the leftover metadata document', async () => {
  const caches = new MemoryCaches();
  const cache = await seed(caches, `${ORIGIN}/assets/a.png`, 'aaaa', 'h0');
  // A document written by an older build claims a file that was never stored (or already evicted).
  await cache.put(runtimeIndexUrl(ORIGIN), new Response(JSON.stringify({
    version: 1, files: { [`${ORIGIN}/assets/a.png`]: null, [`${ORIGIN}/assets/ghost.png`]: null },
  })));
  const s = new ResourceStore(manifest([{ url: '/assets/a.png', tier: 1, size: 4, hash: 'h0' }]), { caches, origin: ORIGIN });
  const status = await s.status();
  assert.deepEqual([status.count, status.complete, status.bytes, status.scan], [1, true, 4, 'keys']);
  assert.equal(status.present.has(`${ORIGIN}/assets/ghost.png`), false);
});

test('a sweep deletes the legacy runtime document without counting it as a cached asset', async () => {
  const caches = new MemoryCaches();
  const cache = await seed(caches, `${ORIGIN}/assets/a.png`, 'aaaa', 'h0');
  await seed(caches, `${ORIGIN}/assets/gone.png`, 'zzzz', 'old');
  await cache.put(runtimeIndexUrl(ORIGIN), new Response(JSON.stringify({ version: 1, files: {} })));
  const s = new ResourceStore(manifest([{ url: '/assets/a.png', tier: 1, size: 4, hash: 'h0' }]), { caches, origin: ORIGIN });
  assert.equal(await s.pruneStale(), 1, 'only the dropped asset counts as swept');
  assert.equal(await cache.match(runtimeIndexUrl(ORIGIN)), undefined, 'the dead document is gone');
  assert.ok(await cache.match(`${ORIGIN}/assets/a.png`), 'a manifest entry is never swept');
  assert.equal((await s.status()).count, 1);
});
