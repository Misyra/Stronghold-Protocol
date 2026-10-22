import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadedPacks } from '../../public/js/resources/packQueue.js';

test('two network lanes continue while the consumer is paused, then apply bounded backpressure', async () => {
  let started = 0, active = 0, peak = 0, reached;
  const fiveStarted = new Promise((resolve) => { reached = resolve; });
  const queue = downloadedPacks(Array.from({ length: 20 }, (_, i) => i), async (plan) => {
    if (++started === 5) reached();
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--; return plan;
  });
  assert.equal((await queue.next()).done, false);
  // Stand in for a decoder/importer that has stopped requesting its next ZIP.
  await fiveStarted;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(started, 5, 'one processing, two queued and at most two held by network lanes');
  assert.equal(peak, 2);
  await queue.return();
  assert.equal(active, 0);
  assert.equal(started, 5, 'closing a blocked importer starts no additional downloads');
});

test('pause cancels both in-flight downloads and drains their task promises', async () => {
  const controller = new AbortController();
  let active = 0, both;
  const started = new Promise((resolve) => { both = resolve; });
  const queue = downloadedPacks([1, 2, 3], async (plan, index, signal) => {
    if (++active === 2) both();
    try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    finally { active--; }
  }, controller.signal);
  const read = queue.next();
  await started; controller.abort();
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(active, 0);
});

test('a failed ZIP does not discard completed or later downloads', async () => {
  const results = [];
  for await (const result of downloadedPacks([1, 2, 3], async (plan) => {
    if (plan === 2) throw new Error('route unavailable');
    return plan;
  })) results.push(result);
  assert.deepEqual(results.filter((r) => !r.error).map((r) => r.value).sort(), [1, 3]);
  assert.equal(results.find((r) => r.error).plan, 2);
});
