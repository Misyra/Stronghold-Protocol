import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle } from '../helpers/battleHarness.js';

test('timer compaction preserves due order, cancellation, periodic callbacks and newly scheduled tasks', () => {
  const { b } = makeBattle({ content: 'none' });
  const events = [];
  let later;
  b.after(0, () => {
    events.push('first'); later.cancel();
    b.after(0, () => events.push('new'));
  });
  later = b.after(0, () => events.push('cancelled'));
  const repeated = b.every(1, () => events.push('periodic'), { immediate: true });
  b._runScheduled();
  assert.deepEqual(events, ['first', 'periodic']);
  assert.equal(b._sched.length, 2);
  b._runScheduled();
  assert.deepEqual(events, ['first', 'periodic', 'new']);
  repeated.cancel(); b._runScheduled();
  assert.equal(b._sched.length, 0);
});
