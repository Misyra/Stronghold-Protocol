// An asset host behind a browser challenge (Cloudflare "Under Attack") refuses every credential-less fetch:
// the CDN URL can never be answered from the page, so the game host's own copy has to take over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchResource } from '../../public/js/resources/network.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { CACHE_NAME } from '../../public/js/resources/common.js';
import { assetSiteUrl } from '../../shared/assetCdn.js';

const BASE = 'https://assets.example';
const ORIGIN = 'https://game.example';

class Cache {
  entries = new Map();
  async put(key, response) { this.entries.set(key, response.clone()); }
  async match(key) { return this.entries.get(key)?.clone(); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(key) { return this.entries.delete(key); }
}
class Caches {
  entries = new Map();
  async open(name) { if (!this.entries.has(name)) this.entries.set(name, new Cache()); return this.entries.get(name); }
  async keys() { return [...this.entries.keys()]; }
  async delete(name) { return this.entries.delete(name); }
}

function withCdn(t, base = BASE) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__spAssetCdn');
  globalThis.__spAssetCdn = { base };
  t.after(() => { if (previous) Object.defineProperty(globalThis, '__spAssetCdn', previous); else delete globalThis.__spAssetCdn; });
}

test('the host twin is the same art path without the CDN cache-buster', () => {
  assert.equal(assetSiteUrl(BASE + '/assets/x.png?v=0123456789abcdef', { base: BASE }), '/assets/x.png');
  assert.equal(assetSiteUrl(BASE + '/_v/abcdefabcdefabcd/assets/x.skel', { base: BASE }), '/assets/x.skel');
  assert.equal(assetSiteUrl(BASE + '/assets/x.png?v=0123456789abcdef&sp=abcdefabcdefabcd', { base: BASE }), '/assets/x.png?sp=abcdefabcdefabcd');
  assert.equal(assetSiteUrl(BASE + '/fonts/a.woff2', { base: BASE }), '/fonts/a.woff2');
  for (const url of ['/assets/x.png', BASE + '/data/chess.json', BASE + '/js/main.js', 'https://other.example/assets/x.png']) {
    assert.equal(assetSiteUrl(url, { base: BASE }), '', url);
  }
  // Without a configured base only a foreign copy is rewritten, and it keeps its own origin out of the way.
  assert.equal(assetSiteUrl(BASE + '/assets/x.png', { base: '', siteOrigin: ORIGIN }), ORIGIN + '/assets/x.png');
  assert.equal(assetSiteUrl(ORIGIN + '/assets/x.png', { base: '', siteOrigin: ORIGIN }), '');
});

test('a challenged CDN falls back to the host once, then trips a breaker instead of re-probing every file', async t => {
  withCdn(t);
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return String(url).startsWith(BASE) ? new Response('<html>challenge</html>', { status: 403 })
      : new Response('ok', { status: 200 });
  };
  for (const name of ['a', 'b', 'c']) {
    const response = await fetchResource(BASE + `/assets/${name}.png?v=0123456789abcdef`, { fetcher, retries: 0, retryDelayMs: 0 });
    assert.equal(await response.text(), 'ok');
  }
  assert.deepEqual(calls, [
    BASE + '/assets/a.png?v=0123456789abcdef', '/assets/a.png',
    BASE + '/assets/b.png?v=0123456789abcdef', '/assets/b.png',
    '/assets/c.png', // the breaker already tripped: the third file never asks the CDN
  ]);
});

test('a host copy that is also missing reports its own failure rather than the CDN challenge', async t => {
  withCdn(t);
  const fetcher = async (url) => new Response('no', { status: String(url).startsWith(BASE) ? 403 : 404 });
  await assert.rejects(fetchResource(BASE + '/assets/gone.png', { fetcher, retries: 0, retryDelayMs: 0 }), /HTTP 404/);
});

test('a blocked CDN still fills the verified cache under its own keys', async t => {
  withCdn(t);
  const body = (name) => `bytes of ${name}`;
  const files = ['ok.png', 'two.png'].map((name) => ({ url: `${BASE}/assets/${name}?v=0123456789abcdef`, tier: 1,
    size: Buffer.byteLength(body(name)), hash: createHash('sha1').update(body(name)).digest('hex').slice(0, 12) }));
  const caches = new Caches();
  const store = new ResourceStore({ format: 1, version: 'cdn-fallback', files }, { origin: ORIGIN, caches, network: { retries: 0, retryDelayMs: 0 },
    fetcher: async (url) => String(url).startsWith(BASE) ? new Response('challenge', { status: 403 })
      : new Response(body(String(url).replace('/assets/', '').replace('.png', '.png')), { status: 200,
        headers: { 'Content-Type': 'image/png' } }) });
  const result = await store.download();
  assert.equal(result.failed, 0, JSON.stringify(result.failures));
  assert.equal(result.count, 2);
  const cache = await caches.open(CACHE_NAME);
  assert.equal(await (await cache.match(`${BASE}/assets/ok.png?v=0123456789abcdef`)).text(), 'bytes of ok.png');
  assert.equal(await (await cache.match(`${BASE}/assets/two.png?v=0123456789abcdef`)).text(), 'bytes of two.png');
});
