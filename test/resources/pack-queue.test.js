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
    active--; return { plan, byteLength: 1 }; // one byte per ZIP: a two-byte budget replays the queued-ZIP cap
  }, null, { bufferBytes: 2 });
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

test('a budget measured in bytes lets small ZIPs keep the lanes busy while big ones park earlier', async () => {
  let started = 0, parked;
  const threeStarted = new Promise((resolve) => { parked = resolve; });
  const queue = downloadedPacks(Array.from({ length: 12 }, (_, i) => i), async (plan) => {
    if (++started === 3) parked();
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { plan, byteLength: plan < 6 ? 1 : 1000 }; // the big ZIPs fill the budget, the small ones slip through
  }, null, { bufferBytes: 1500 });
  assert.equal((await queue.next()).done, false);
  await threeStarted;
  // Both lanes keep finishing; the consumer has stopped requesting, so the budget is what slows new starts down.
  await new Promise((resolve) => setTimeout(resolve, 40));
  // Six one-byte ZIPs and one 1000-byte ZIP fit the 1500-byte budget; the two lanes may hold one parked ZIP each.
  assert.ok(started >= 8 && started <= 10, `the byte budget admits small ZIPs and parks the rest: ${started}`);
  await queue.return();
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
