import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchResource } from '../../public/js/resources/network.js';
import { ResourceSchedule, matchResourceUrls } from '../../public/js/resources/schedule.js';
import { createResourceResponder } from '../../public/js/resources/readThrough.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { CACHE_NAME, MAX_FILE_BYTES } from '../../public/js/resources/common.js';

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
const origin = 'https://game.example';
const file = (url, body, tier = 1) => ({ url, tier, size: Buffer.byteLength(body), hash: createHash('sha1').update(body).digest('hex').slice(0, 12) });
const manifest = (files) => ({ format: 1, version: 'network-tests', files });

test('full-body deadline cancels a hanging response and retries only transient failures', async () => {
  let calls = 0, cancelled = 0;
  const response = await fetchResource(origin + '/assets/a.png', { timeoutMs: 15, retryDelayMs: 0,
    fetcher: async () => {
      calls++;
      if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled++; } }));
      if (calls === 2) return new Response('busy', { status: 503 });
      return new Response('ok');
    } });
  assert.equal(await response.text(), 'ok');
  assert.equal(calls, 3); assert.equal(cancelled, 1);
  calls = 0;
  await assert.rejects(fetchResource(origin, { retryDelayMs: 0, fetcher: async () => { calls++; return new Response('no', { status: 404 }); } }), /404/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchResource(origin, { timeoutMs: 5, retries: 1, retryDelayMs: 0,
    fetcher: () => { calls++; return new Promise(() => {}); } }), /超时/);
  assert.equal(calls, 2, 'even a fetch stub ignoring abort cannot hold the lane indefinitely');
});

test('Retry-After backoff is cancellable and oversized bodies are never retried', async () => {
  const controller = new AbortController();
  let calls = 0;
  const first = Promise.withResolvers();
  const pending = fetchResource(origin, { signal: controller.signal, fetcher: async () => {
    calls++; first.resolve(); return new Response('busy', { status: 429, headers: { 'Retry-After': '30' } });
  } });
  await first.promise; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchResource(origin, { retryDelayMs: 0, fetcher: async () => {
    calls++; return new Response(new Uint8Array(MAX_FILE_BYTES + 1));
  } }), /24 MiB/);
  assert.equal(calls, 1);
});

test('Retry-After delays retrying a busy server', async () => {
  let calls = 0;
  const started = performance.now();
  const response = await fetchResource(origin, { retryDelayMs: 0, fetcher: async () => ++calls === 1
    ? new Response('busy', { status: 429, headers: { 'Retry-After': '0.03' } }) : new Response('ok') });
  assert.equal(await response.text(), 'ok'); assert.equal(calls, 2);
  assert.ok(performance.now() - started >= 20);
});

test('combat restricts essential downloads to one lane, optional waits, and reprioritizes queued resources', async () => {
  const schedule = new ResourceSchedule();
  const a = file('/assets/ui/a.png', 'a'), b = file('/assets/char/b.png', 'b'), voice = file('/assets/audio/voice/cn/a.mp3', 'v', 2);
  schedule.update({ active: true, combat: true, urls: [b.url] });
  const calls = [];
  const first = Promise.withResolvers(), release = Promise.withResolvers();
  const s = new ResourceStore(manifest([a, b, voice]), { caches: new Caches(), origin, schedule, fetcher: async (url) => {
    calls.push(url); if (calls.length === 1) { first.resolve(); await release.promise; }
    return new Response(url.endsWith('b.png') ? 'b' : url.endsWith('a.png') ? 'a' : 'v');
  } });
  const pending = s.download({ tiers: [1] });
  await first.promise;
  assert.deepEqual(calls, [origin + b.url]);
  release.resolve(); await pending;
  assert.deepEqual(calls, [origin + b.url, origin + a.url], 'required tier finishes during combat without stuck waiting lanes');
  const controller = new AbortController();
  const optional = s.download({ tiers: [2], signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls.length, 2);
  schedule.update({ active: true, combat: false });
  await optional; assert.equal(calls.at(-1), origin + voice.url);
  schedule.update({ combat: true });
  const waiting = schedule.wait(controller.signal, 1, 1); controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('match priorities use referenced operators, enemy aliases and map atlas; unrelated operators stay unprioritized', () => {
  const urls = matchResourceUrls({ private: { board: [{ kind: 'chess', id: 'piece' }] }, field: { units: [{ defId: 'enemy', spine: 'enemy' }] } }, {
    chars: { char_a: { avatar: '/assets/char/a.png', spine: { front: { skel: '/assets/spine/a.skel' } } }, char_b: { avatar: '/assets/char/b.png' } },
    enemies: { enemy: { spineAliasOf: 'base' }, base: { spine: { skel: '/assets/spine/e.skel' } } },
  }, (id) => id === 'piece' ? { charId: 'char_a' } : null, { groups: { 'map/autochess': { atlas: { path: '/assets/local/map/board.png' } } } });
  assert.deepEqual(new Set(urls), new Set(['/assets/char/a.png', '/assets/spine/a.skel', '/assets/spine/e.skel', '/assets/local/map/board.png']));
});

test('game and preload share one download, verify it, recover the index and serve audio ranges offline', async () => {
  const f = file('/assets/audio/bgm/test.mp3', 'audio-bytes');
  const m = manifest([f]), caches = new Caches();
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const responder = createResourceResponder({ caches, origin, getManifest: async () => m, fetcher: async () => {
    calls++; started.resolve(); await release.promise; return new Response('audio-bytes');
  } });
  const game = responder.respond(new Request(origin + '/media/bgm/test', { headers: { Range: 'bytes=1-3' } }));
  await started.promise;
  const store = new ResourceStore(m, { caches, origin, fetcher: (url, options) => responder.respond(new Request(url, options)) });
  const preload = store.download();
  release.resolve();
  const range = await game; assert.equal(range.status, 206); assert.equal(await range.text(), 'udi');
  assert.equal((await preload).complete, true); assert.equal(calls, 1);
  assert.equal(await (await responder.respond(new Request(origin + f.url))).text(), 'audio-bytes');
  assert.equal(calls, 1);
  const copy = new ResourceStore(m, { caches, origin, fetcher: () => { throw new Error('must reuse'); } });
  assert.equal((await copy.download()).complete, true);
});

test('read-through never stores corrupt, partial or unlisted resources and ignores other revision queries', async () => {
  const f = file('https://cdn.example/assets/a.png?v=aaaaaaaaaaaaaaaa', 'correct'), m = manifest([f]), caches = new Caches();
  const calls = [];
  const responder = createResourceResponder({ caches, origin, getManifest: async () => m, network: { retries: 0 },
    fetcher: async (input) => { calls.push(typeof input === 'string' ? input : input.url); return new Response('wrong'); } });
  assert.equal(await (await responder.respond(new Request(f.url))).text(), 'wrong');
  assert.equal(await (await caches.open(CACHE_NAME)).match(f.url), undefined);
  const old = f.url.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
  await responder.respond(new Request(old));
  await responder.respond(new Request(origin + '/assets/unlisted.png'));
  assert.deepEqual(calls, [f.url, old, origin + '/assets/unlisted.png']);
  assert.equal((await (await caches.open(CACHE_NAME)).keys()).length, 0);
  const partial = createResourceResponder({ caches, origin, getManifest: async () => m, network: { retries: 0 },
    fetcher: async () => new Response('part', { status: 206 }) });
  await assert.rejects(partial.respond(new Request(f.url)), /非完整响应/);
  assert.equal((await (await caches.open(CACHE_NAME)).keys()).length, 0);
});

test('CDNs without CORS can still display public images, but cannot populate the verified cache', async () => {
  const f = file('https://cdn.example/assets/a.png', 'a'), caches = new Caches();
  const calls = [];
  const responder = createResourceResponder({ caches, origin, getManifest: async () => manifest([f]), network: { retries: 0 },
    fetcher: async (input) => {
      calls.push(input);
      if (typeof input === 'string') throw new TypeError('CORS blocked');
      return new Response('public image');
    } });
  assert.equal(await (await responder.respond(new Request(f.url, { mode: 'no-cors' }))).text(), 'public image');
  assert.equal(calls.length, 2);
  assert.equal((await (await caches.open(CACHE_NAME)).keys()).length, 0);
});

test('suspending writes invalidates in-flight downloads and waits for writes already begun', async () => {
  const f = file('/assets/a.png', 'a'), caches = new Caches();
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const responder = createResourceResponder({ caches, origin, getManifest: async () => manifest([f]), fetcher: async () => {
    started.resolve(); await release.promise; return new Response('a');
  } });
  const pending = responder.respond(new Request(origin + f.url));
  await started.promise; await responder.mode(false); await caches.delete(CACHE_NAME); await responder.mode(true); release.resolve();
  assert.equal(await (await pending).text(), 'a');
  assert.equal((await caches.keys()).length, 0, 'a download begun before clearing cannot recreate the cache');
  await responder.respond(new Request(origin + f.url));
  assert.equal(await (await (await caches.open(CACHE_NAME)).match(origin + f.url)).text(), 'a');
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(origin + f.url);
  const put = cache.put.bind(cache), writing = Promise.withResolvers(), writeDone = Promise.withResolvers();
  cache.put = async (...args) => { writing.resolve(); await writeDone.promise; return put(...args); };
  const active = responder.respond(new Request(origin + f.url));
  await writing.promise;
  let acknowledged = false;
  const pause = responder.mode(false).then(() => { acknowledged = true; });
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(acknowledged, false);
  writeDone.resolve(); await pause; await active; assert.equal(acknowledged, true);
});
