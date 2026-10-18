import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArtTransport, installArtParsers, subscribeArtRecovery } from '../../public/js/resourceNetwork.js';
import { createAssets, loadSpineData } from '../../public/js/assets.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function clock() {
  let now = 0, id = 0;
  const tasks = new Map();
  return {
    setTimer(fn, ms) { tasks.set(++id, { fn, at: now + ms }); return id; },
    clearTimer(key) { tasks.delete(key); },
    advance(ms) {
      now += ms;
      for (const [key, task] of [...tasks]) if (task.at <= now) { tasks.delete(key); task.fn(); }
    },
    get size() { return tasks.size; },
  };
}

test('runtime art shares a request including retry/backoff, and releases the transfer slot while sleeping', async () => {
  let calls = 0;
  const waits = [];
  const transport = createArtTransport({ concurrency: 1, random: () => 0.5,
    fetcher: async () => {
      if (++calls < 3) return new Response(null, { status: 503 });
      return new Response('image');
    }, wait: async (ms) => { waits.push(ms); },
  });
  const first = transport.blob('/assets/a.png');
  assert.equal(first, transport.blob('/assets/a.png'));
  assert.equal(await (await first).text(), 'image');
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(calls, 3);
  assert.equal(transport.has('/assets/a.png'), false);
});

test('permanent 404 is not retried; failed URLs are not permanently cached', async () => {
  let calls = 0;
  const transport = createArtTransport({ fetcher: async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 404 }) : new Response('recovered');
  }, wait: () => { throw new Error('must not back off for a permanent 404'); } });
  await assert.rejects(transport.blob('/assets/missing.png'), { status: 404 });
  assert.equal(await (await transport.blob('/assets/missing.png')).text(), 'recovered');
});

test('progress refreshes idle deadline, but absolute deadline still aborts an active response', async () => {
  const c = clock();
  let stream;
  let signal;
  const transport = createArtTransport({ ...c, idleMs: 30, requestMs: 100, retryDelays: [],
    fetcher: async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          stream = controller;
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }));
    },
  });
  const result = transport.blob('/assets/slow.png');
  const rejected = assert.rejects(result, { name: 'TimeoutError' });
  await tick();
  for (let n = 0; n < 4; n++) {
    c.advance(20);
    stream.enqueue(new Uint8Array([n]));
    await tick();
    assert.equal(signal.aborted, false);
  }
  c.advance(20);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(c.size, 0, 'every deadline is cleared');
});

test('idle timeout aborts the body before retry; bounded scheduling limits concurrent runtime requests', async () => {
  const c = clock();
  let aborted = false, calls = 0;
  const transport = createArtTransport({ ...c, idleMs: 30, requestMs: 100, retryDelays: [1], wait: async () => {},
    fetcher: async (_url, { signal }) => {
      if (++calls > 1) return new Response('after timeout');
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); });
      } }));
    },
  });
  const pending = transport.blob('/assets/stalled.png');
  await tick(); c.advance(31);
  assert.equal(await (await pending).text(), 'after timeout');
  assert.equal(aborted, true);
  assert.equal(c.size, 0);

  let active = 0, peak = 0;
  const gates = [];
  const limited = createArtTransport({ concurrency: 2, fetcher: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => gates.push(resolve));
    active--;
    return new Response('ok');
  } });
  const all = Promise.all(Array.from({ length: 5 }, (_, n) => limited.blob(`/assets/${n}.png`)));
  await tick();
  assert.equal(gates.length, 2);
  while (gates.length) { gates.shift()(); await tick(); }
  await all;
  assert.equal(peak, 2);
});

test('Pixi fetch wrappers affect only art, retain the original parsing/unloading and are installed once', async (t) => {
  const fetcher = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetcher; });
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return new Response('binary'); };
  const parser = { load: async (url) => url };
  const pixi = { Assets: { loader: { parsers: [parser] } } };
  installArtParsers(pixi);
  const installed = parser.load;
  installArtParsers(pixi);
  assert.equal(parser.load, installed);
  assert.equal(await parser.load('/data/chess.json'), '/data/chess.json');
  assert.equal(await parser.load('/assets/spine/a.atlas'), 'binary');
  assert.equal(new TextDecoder().decode(await parser.load('/assets/spine/a.skel')), 'binary');
  assert.deepEqual(urls, ['/assets/spine/a.atlas', '/assets/spine/a.skel']);
});

test('a healthy pending Spine is shared even when a resumed view requests a fresh model', async (t) => {
  const original = globalThis.PIXI;
  t.after(() => { globalThis.PIXI = original; });
  let calls = 0, resolve;
  const gate = new Promise((r) => { resolve = r; });
  globalThis.PIXI = { spine: {}, Assets: { load: async () => { calls++; await gate; return { animations: [] }; } } };
  const entry = { skel: '/assets/spine/slow.skel' };
  const one = loadSpineData(entry);
  const two = loadSpineData(entry, { fresh: true });
  assert.equal(calls, 1);
  resolve();
  assert.equal(await one, await two);
});

test('store recovery retries failed art, never duplicates pending images, and unsubscribes browser handlers', async (t) => {
  const saved = new Map(['addEventListener', 'removeEventListener', 'document']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, value] of saved) value
    ? Object.defineProperty(globalThis, key, value) : delete globalThis[key]; });
  const events = new Map();
  const add = (name, fn) => events.set(name, fn);
  const remove = (name, fn) => { if (events.get(name) === fn) events.delete(name); };
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: add });
  Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: remove });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, addEventListener: add, removeEventListener: remove } });
  let failure = true, calls = 0;
  let release;
  const a = createAssets({ manifest: {}, localManifest: { groups: {} }, loadImage: async (url) => {
    calls++;
    if (url === '/pending') return new Promise((resolve) => { release = resolve; });
    if (failure) throw new Error('offline');
    return { width: 1, src: url };
  } });
  await a.image('/failed');
  const pending = a.image('/pending');
  await tick();
  const heard = [];
  const off = a.onChange((event) => heard.push(event));
  const otherOff = subscribeArtRecovery(() => {});
  failure = false;
  events.get('online')();
  await tick();
  assert.equal(calls, 3, 'only the failed URL was retried');
  assert.ok(a.imageNow('/failed'));
  assert.ok(heard.includes('image'));
  release({ width: 1 });
  await pending;
  off(); otherOff();
  assert.equal(events.size, 0);
});
