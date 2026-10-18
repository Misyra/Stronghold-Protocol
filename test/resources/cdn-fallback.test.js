// An asset host behind a browser challenge (Cloudflare "Under Attack") refuses every credential-less fetch:
// the CDN URL can never be answered from the page, so the game host's own copy has to take over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchResource, __resetOriginFallback } from '../../public/js/resources/network.js';
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
  __resetOriginFallback();
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__spAssetCdn');
  globalThis.__spAssetCdn = { base };
  t.after(() => {
    __resetOriginFallback();
    if (previous) Object.defineProperty(globalThis, '__spAssetCdn', previous); else delete globalThis.__spAssetCdn;
  });
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

test('the CDN is asked first every time; a refusal falls back to the host copy', async (t) => {
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
  // The owner's rule: the CDN comes first in every case, even while the breaker is open — a recovered CDN is used again
  // (the breaker only spares BULK work from re-probing, see the preload test below).
  assert.deepEqual(calls.map((url) => (url.startsWith(BASE) ? 'cdn' : 'host')),
    ['cdn', 'host', 'cdn', 'host', 'cdn', 'host']);
  assert.deepEqual(calls.filter((url) => url.startsWith(BASE)),
    ['a', 'b', 'c'].map((name) => BASE + `/assets/${name}.png?v=0123456789abcdef`));
});

test('a host copy that is also missing reports its own failure rather than the CDN challenge', async t => {
  withCdn(t);
  const fetcher = async (url) => new Response('no', { status: String(url).startsWith(BASE) ? 403 : 404 });
  await assert.rejects(fetchResource(BASE + '/assets/gone.png', { fetcher, retries: 0, retryDelayMs: 0 }), /HTTP 404/);
});

test('a blocked CDN stops the preload with one reason instead of draining the game host', async (t) => {
  withCdn(t);
  const body = (name) => `bytes of ${name}`;
  const files = ['ok.png', 'two.png'].map((name) => ({ url: `${BASE}/assets/${name}?v=0123456789abcdef`, tier: 1,
    size: Buffer.byteLength(body(name)), hash: createHash('sha1').update(body(name)).digest('hex').slice(0, 12) }));
  const caches = new Caches();
  const calls = [];
  const store = new ResourceStore({ format: 1, version: 'cdn-fallback', files }, { origin: ORIGIN, caches, network: { retries: 0, retryDelayMs: 0 },
    fetcher: async (url) => { calls.push(String(url)); return new Response('challenge', { status: 403 }); } });
  await assert.rejects(store.download(), (err) => {
    assert.match(err.message, /素材 CDN 暂时不可用/);
    assert.equal(err.fatal, true);
    return true;
  });
  assert.ok(calls.every((url) => url.startsWith(BASE)), 'not one request went to the game host');
  assert.ok(calls.length <= 8, `the run stopped after ${calls.length} requests, not behind every file`);
});

test('bulk preload never falls back to the game host: one clear retryable stop instead of 27 000 downloads', async (t) => {
  withCdn(t);
  const calls = [];
  const fetcher = async (url) => { calls.push(String(url)); return new Response('challenge', { status: 403 }); };
  const opts = { fetcher, retries: 0, retryDelayMs: 0, allowOrigin: false };
  // A single CDN refusal fails that file — the run itself is still allowed to continue.
  await assert.rejects(fetchResource(BASE + '/assets/a.png', opts), (err) => {
    assert.match(err.message, /素材 CDN 暂时不可用/);
    assert.equal(err.transient, true);
    assert.equal(err.fatal, false, 'one refusal is not a verdict');
    return true;
  });
  // The second consecutive refusal trips the breaker, and bulk work stops with a fatal, retryable reason.
  await assert.rejects(fetchResource(BASE + '/assets/b.png', opts), (err) => {
    assert.equal(err.fatal, true);
    assert.match(err.message, /确认素材域名没有拦住浏览器/);
    return true;
  });
  assert.deepEqual(calls, [BASE + '/assets/a.png', BASE + '/assets/b.png'], 'the game host was never asked');
});

test('runtime art may use the host copy, but only within this page\'s budget', async (t) => {
  withCdn(t);
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith(BASE)) return new Response('challenge', { status: 403 });
    return new Response(new Uint8Array(1024), { status: 200, headers: { 'Content-Length': '1024' } });
  };
  const response = await fetchResource(BASE + '/assets/hero.png', { fetcher, retries: 0, retryDelayMs: 0 });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [BASE + '/assets/hero.png', '/assets/hero.png']);
});
