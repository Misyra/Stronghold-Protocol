import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceState } from '../../public/js/resources/state.js';

test('resource state skips identical progress while preserving previous snapshots', () => {
  const store = createResourceState({ phase: 'download', done: 0, groups: [{ id: 'map', count: 0 }] });
  const snapshots = [];
  const unsubscribe = store.subscribe((state) => snapshots.push(state));
  store.set({ done: 0, groups: [{ id: 'map', count: 0 }] });
  assert.equal(snapshots.length, 0);
  store.set({ done: 1, groups: [{ id: 'map', count: 1 }] });
  store.set({ done: 2 });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].done, 1);
  assert.equal(store.snapshot().done, 2);
  unsubscribe();
  store.set({ done: 3 });
  assert.equal(snapshots.length, 2);
});

test('a scalar resource update never serializes untouched category lists', () => {
  let serializations = 0;
  const groups = [{ toJSON() { serializations++; return {}; } }];
  const store = createResourceState({ done: 0, groups });
  store.set({ done: 1 });
  store.set({ done: 1 });
  assert.equal(serializations, 0);
});
