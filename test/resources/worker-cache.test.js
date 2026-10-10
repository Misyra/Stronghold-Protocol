import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createResourceResponder } from '../../public/js/resources/readThrough.js';
import { createWorkerCache } from '../../public/js/resources/workerCache.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { CACHE_NAME } from '../../public/js/resources/common.js';

const origin = 'https://game.example';
const file = { url: '/assets/e2e/a.png', tier: 1, size: 5, hash: createHash('sha1').update('valid').digest('hex').slice(0, 12) };
const manifest = { version: 'worker-tests', files: [file] };
function fixture({ body = 'valid', networkError, writeError } = {}) {
  const entries = new Map();
  const counts = { fetch: 0, put: 0, hello: 0 };
  const cache = {
    async match(key) { return entries.get(key)?.clone(); },
    async keys() { return [...entries.keys()].map((url) => new Request(url)); },
    async delete(key) { return entries.delete(key); },
    async put(key, res) {
      if (key.includes('/assets/')) { counts.put++; if (writeError) throw writeError; }
      entries.set(key, res.clone());
    },
  };
  const caches = { open: async () => cache, keys: async () => [CACHE_NAME], delete: async () => { entries.clear(); } };
  let release;
  const gate = { promise: Promise.resolve() };
  const responder = createResourceResponder({ caches, origin, getManifest: async () => manifest, network: { retries: 0 },
    fetcher: async () => {
      counts.fetch++; await gate.promise;
      if (networkError && counts.fetch === 1) throw networkError;
      // A forged CDN header must not authorize the optimized path.
      return new Response(body, { headers: { 'X-SP-Resource-Hash': file.hash } });
    } });
  const worker = { postMessage(data, [port]) {
    if (data.hello) { counts.hello++; port.postMessage({ protocol: 1 }); port.close(); return; }
    void responder.ensureCached(data).then((result) => port.postMessage({ result }), (err) => port.postMessage({ error: {
      name: err.name, message: err.message, transient: err.transient,
    } })).finally(() => port.close());
  } };
  const ensureCached = createWorkerCache(() => worker, { origin, retryDelayMs: 0 });
  const store = (optimized = true) => new ResourceStore(manifest, { caches, origin, ensureCached: optimized ? ensureCached : null,
    fetcher: (url, options) => responder.respond(new Request(url, options)) });
  return { counts, caches, cache, entries, responder, worker, ensureCached, store,
    hold() { gate.promise = new Promise((resolve) => { release = resolve; }); }, release() { release(); } };
}

test('worker handoff halves resource SHA-1 checks and cache writes; missing indexes reuse local verification', async () => {
  const original = crypto.subtle.digest;
  let hashes = 0;
  crypto.subtle.digest = function (...args) { if (args[0] === 'SHA-1') hashes++; return original.apply(this, args); };
  try {
    const old = fixture();
    assert.equal((await old.store(false).download()).complete, true);
    assert.deepEqual([hashes, old.counts.put, old.counts.fetch], [2, 2, 1]);
    hashes = 0;
    const current = fixture();
    assert.equal((await current.store().download()).complete, true);
    assert.deepEqual([hashes, current.counts.put, current.counts.fetch], [1, 1, 1]);
    for (const key of current.entries.keys()) if (!key.includes('/assets/')) current.entries.delete(key);
    assert.equal((await current.store().download()).adopted, 1);
    assert.deepEqual([hashes, current.counts.put, current.counts.fetch], [1, 1, 1], 'index recovery neither rehashes nor rewrites verified bytes');
  } finally { crypto.subtle.digest = original; }
});

test('handoff shares in-flight game requests and leaves audio ranges playable after preload is aborted', async () => {
  const f = fixture(); f.hold();
  const game = f.responder.respond(new Request(origin + file.url, { headers: { Range: 'bytes=1-3' } }));
  const controller = new AbortController();
  const preload = f.store().download({ signal: controller.signal });
  const rejected = assert.rejects(preload, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(); await rejected; f.release();
  const response = await game;
  assert.equal(response.status, 206); assert.equal(await response.text(), 'ali');
  assert.equal(f.counts.fetch, 1);
  assert.equal((await f.store().download()).complete, true);
});

test('forged network headers, wrong hashes/sizes and unlisted URLs cannot issue cache receipts', async () => {
  const f = fixture({ body: 'wrong' });
  assert.equal(await f.ensureCached(file), null);
  assert.equal(f.entries.size, 0);
  assert.equal((await f.store().download()).failed, 1);
  assert.equal(f.entries.has(origin + file.url), false);
  const good = fixture();
  for (const changed of [{ hash: 'aaaaaaaaaaaa' }, { size: 10 }, { url: '/assets/unlisted.png' }]) {
    assert.equal(await good.ensureCached({ ...file, ...changed }), null);
  }
  assert.equal(good.counts.fetch, 0);
});

test('worker quota failures stop preload without a second write; game requests still succeed', async () => {
  const f = fixture({ writeError: Object.assign(new Error('full'), { name: 'QuotaExceededError' }) });
  await assert.rejects(f.store().download(), { name: 'QuotaExceededError' });
  assert.equal(f.counts.put, 1);
  assert.equal(await (await f.responder.respond(new Request(origin + file.url))).text(), 'valid');
});

test('old workers time out only once, unavailable workers fall back and network failures retain retries', async () => {
  let messages = 0;
  const oldWorker = { postMessage() { messages++; } };
  const ensure = createWorkerCache(() => oldWorker, { origin, helloTimeoutMs: 5 });
  assert.equal(await ensure(file), null); assert.equal(await ensure(file), null); assert.equal(messages, 1);
  assert.equal(await createWorkerCache(() => null, { origin })(file), null);
  const f = fixture({ networkError: new TypeError('temporary') });
  assert.equal((await f.store().download()).complete, true);
  assert.equal(f.counts.fetch, 2); assert.equal(f.counts.put, 1);
});

test('clear invalidates pending receipts and worker generations without a late cache write', async () => {
  const f = fixture(); f.hold();
  const pending = f.ensureCached(file);
  while (!f.counts.fetch) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.responder.mode(false); f.entries.clear(); await f.responder.mode(true); f.release();
  assert.equal(await pending, null); assert.equal(f.counts.put, 0);
  assert.equal((await f.ensureCached(file)).cached, true); assert.equal(f.counts.put, 1);
});

test('mismatching receipts are rejected and cached-only probes never fetch missing files', async () => {
  const badWorker = { postMessage(data, [port]) {
    port.postMessage(data.hello ? { protocol: 1 } : { result: { cached: true, url: origin + file.url, hash: 'bbbbbbbbbbbb', size: 5 } }); port.close();
  } };
  assert.equal(await createWorkerCache(() => badWorker, { origin })(file), null);
  const f = fixture();
  assert.equal(await f.ensureCached(file, { cachedOnly: true }), null);
  assert.equal(f.counts.fetch, 0);
  await f.cache.put(origin + file.url, new Response('valid'));
  assert.equal(await f.ensureCached(file, { cachedOnly: true }), null, 'unmarked local bytes still need verification');
  assert.equal((await f.store().download()).adopted, 1);
  assert.equal(f.counts.fetch, 0);
});

test('missing worker manifests fall back; an aborted capability probe does not disable later handoffs', async () => {
  const responder = createResourceResponder({ origin, getManifest: async () => { throw new TypeError('manifest unavailable'); } });
  assert.equal(await responder.ensureCached({ ...file, url: origin + file.url }), null);
  const f = fixture();
  let helloPort;
  const worker = { postMessage(data, ports) {
    if (data.hello) helloPort = ports[0];
    else f.worker.postMessage(data, ports);
  } };
  const ensure = createWorkerCache(() => worker, { origin });
  const controller = new AbortController();
  const pending = ensure(file, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  while (!helloPort) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort(); await rejected;
  helloPort.postMessage({ protocol: 1 }); helloPort.close();
  assert.equal((await ensure(file)).cached, true);
});

test('an old worker still uses the independently verified page path, including integrity retry', async () => {
  const f = fixture();
  const ensureCached = createWorkerCache(() => ({ postMessage() {} }), { origin, helloTimeoutMs: 5 });
  let fetches = 0;
  const store = new ResourceStore(manifest, { origin, caches: f.caches, ensureCached, fetcher: async () => {
    fetches++; return new Response(fetches === 1 ? 'wrong' : 'valid', { headers: { 'X-SP-Resource-Hash': file.hash } });
  } });
  assert.equal((await store.download()).complete, true);
  assert.equal(fetches, 2); assert.equal(f.counts.put, 1);
});

test('handoffs use canonical escaped CDN URLs and bind per-file query versions', async () => {
  const f = fixture();
  const cdnFile = { ...file, url: 'https://cdn.example/_v/aaaaaaaaaaaaaaaa/assets/spine/[test].png?v=bbbbbbbbbbbbbbbb' };
  const responder = createResourceResponder({ caches: f.caches, origin, getManifest: async () => ({ files: [cdnFile] }),
    fetcher: async () => new Response('valid') });
  const worker = { postMessage(data, [port]) {
    if (data.hello) { port.postMessage({ protocol: 1 }); port.close(); return; }
    void responder.ensureCached(data).then((result) => { port.postMessage({ result }); port.close(); });
  } };
  const ensure = createWorkerCache(() => worker, { origin });
  const receipt = await ensure(cdnFile);
  assert.equal(receipt.url, cdnFile.url.replace('[test]', '%5Btest%5D'));
  assert.equal(receipt.cached, true);
  assert.equal(await ensure({ ...cdnFile, url: cdnFile.url.replace('bbbbbbbbbbbbbbbb', 'cccccccccccccccc') }), null);
  assert.equal(f.counts.put, 1);
});
