import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeIndexBatcher, readRuntimeIndex, runtimeIndexUrl } from '../../public/js/resources/runtimeIndex.js';

const ORIGIN = 'https://game.example';
const key = (i) => `${ORIGIN}/assets/runtime/${i}.png`;

class MetadataCache {
  constructor() { this.entries = new Map(); this.reads = 0; this.writes = 0; }
  async match(url) { this.reads++; return this.entries.get(url)?.clone(); }
  async put(url, response) { this.writes++; this.entries.set(url, response.clone()); }
}

function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const token = ++id; timers.set(token, { at: now + ms, fn }); return token; },
    clearTimer: (token) => timers.delete(token),
    advance: (ms) => {
      now += ms;
      for (const [token, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(token);
        timer.fn();
      }
    },
    get pending() { return timers.size; },
  };
}

test('130 successful resource registrations require only three index reads/writes', async () => {
  const cache = new MetadataCache();
  const timer = clock();
  const enqueue = createRuntimeIndexBatcher(timer);
  const jobs = Array.from({ length: 130 }, (_, i) => enqueue(cache, ORIGIN, key(i)));
  assert.equal(timer.pending, 1, 'the last partial batch has a bounded deadline');
  timer.advance(250);
  await Promise.all(jobs);
  assert.deepEqual([cache.reads, cache.writes, timer.pending], [3, 3, 0]);
  assert.equal(Object.keys(await readRuntimeIndex(cache, ORIGIN)).length, 130);
});

test('duplicate URLs and different Cache wrappers coalesce; an already indexed URL does not rewrite', async () => {
  const cache = new MetadataCache();
  const timer = clock();
  const enqueue = createRuntimeIndexBatcher(timer);
  const wrapper = { match: cache.match.bind(cache), put: cache.put.bind(cache) };
  const a = enqueue(cache, ORIGIN, key(1));
  const b = enqueue(wrapper, ORIGIN, key(1));
  assert.equal(a, b, 'wrapper identity does not split batches for the same index URL');
  timer.advance(250);
  await Promise.all([a, b]);
  assert.deepEqual([cache.reads, cache.writes], [1, 1]);
  const again = enqueue(wrapper, ORIGIN, key(1));
  timer.advance(250);
  await again;
  assert.deepEqual([cache.reads, cache.writes], [2, 1]);
});

test('the first registration sets the flush deadline; continued arrivals do not debounce forever', async () => {
  const cache = new MetadataCache();
  const timer = clock();
  const enqueue = createRuntimeIndexBatcher(timer);
  const a = enqueue(cache, ORIGIN, key(1));
  timer.advance(200);
  const b = enqueue(cache, ORIGIN, key(2));
  timer.advance(49);
  assert.equal(cache.reads, 0);
  timer.advance(1);
  await Promise.all([a, b]);
  assert.deepEqual([cache.reads, cache.writes], [1, 1]);
});

test('new arrivals during an index write are retained in the next serialized batch', async () => {
  const cache = new MetadataCache();
  const timer = clock();
  const enqueue = createRuntimeIndexBatcher({ ...timer, maxEntries: 2 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const put = cache.put.bind(cache);
  let calls = 0;
  cache.put = async (...args) => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    await put(...args);
  };
  const a = enqueue(cache, ORIGIN, key(1)), b = enqueue(cache, ORIGIN, key(2));
  await entered.promise;
  const c = enqueue(cache, ORIGIN, key(3));
  timer.advance(250);
  release.resolve();
  await Promise.all([a, b, c]);
  assert.equal(cache.writes, 2);
  assert.deepEqual(Object.keys(await readRuntimeIndex(cache, ORIGIN)).sort(), [key(1), key(2), key(3)]);
});

test('failed batches reject every waiter and later registrations can retry without phantom metadata', async () => {
  const cache = new MetadataCache();
  const timer = clock();
  const enqueue = createRuntimeIndexBatcher(timer);
  const put = cache.put.bind(cache);
  cache.put = async () => { throw new DOMException('', 'QuotaExceededError'); };
  const a = enqueue(cache, ORIGIN, key(1)), b = enqueue(cache, ORIGIN, key(2));
  const rejected = assert.rejects(a, { name: 'QuotaExceededError' });
  assert.equal(a, b);
  timer.advance(250);
  await rejected;
  assert.equal(cache.entries.has(runtimeIndexUrl(ORIGIN)), false);
  cache.put = put;
  const retry = enqueue(cache, ORIGIN, key(1));
  timer.advance(250);
  await retry;
  assert.deepEqual(await readRuntimeIndex(cache, ORIGIN), { [key(1)]: null });
});

test('batches for different origins keep independent metadata and promises', async () => {
  const cache = new MetadataCache();
  const timer = clock();
  const enqueue = createRuntimeIndexBatcher(timer);
  const a = enqueue(cache, ORIGIN, key(1));
  const b = enqueue(cache, 'https://other.example', key(2));
  assert.notEqual(a, b);
  timer.advance(250);
  await Promise.all([a, b]);
  assert.deepEqual(await readRuntimeIndex(cache, ORIGIN), { [key(1)]: null });
  assert.deepEqual(await readRuntimeIndex(cache, 'https://other.example'), { [key(2)]: null });
});
