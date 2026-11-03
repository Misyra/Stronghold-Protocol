// ui/cloudStats.js — the local "account" list (this browser's records). The panel used to re-read, re-sort and publish
// a fresh object every 15 s for each open hook; these tests pin down that an unchanged stored history is neither parsed
// again nor republished, and that a real change is picked up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentRecords, recordsSnapshot } from '../../public/js/ui/cloudStats.js';
import { STATS_VERSION, saveStats } from '../../public/js/ui/stats.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
  clear: () => store.clear(),
};

const record = (id, t) => ({ id, t, end: 'settled', players: [{ id: 'self', side: 0 }] });

function countParses(run) {
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = (...args) => { calls++; return parse(...args); };
  try { return { value: run(), calls: () => calls }; } finally { JSON.parse = parse; }
}

test('an unchanged history is served from the snapshot: no second parse, no new object', () => {
  store.clear();
  saveStats({ v: STATS_VERSION, records: [record('a', 10), record('b', 20)] });
  const first = recordsSnapshot();
  assert.deepEqual(first.records.map((r) => r.id), ['b', 'a'], 'newest first');
  const again = countParses(() => recordsSnapshot());
  assert.equal(again.value, first, 'the same object, so no hook re-renders');
  assert.equal(again.calls(), 0, 'a poll reads the revision string only, never the whole history');
});

test('a saved record is published as a new snapshot', () => {
  const before = recordsSnapshot();
  saveStats({ v: STATS_VERSION, records: [record('a', 10), record('b', 20), record('c', 30)] });
  const next = recordsSnapshot();
  assert.notEqual(next, before);
  assert.deepEqual(next.records.map((r) => r.id), ['c', 'b', 'a']);
  assert.equal(recordsSnapshot(), next);
});

test('currentRecords stays the direct reader (a fresh list, not the snapshot)', () => {
  const direct = currentRecords();
  assert.notEqual(direct, recordsSnapshot());
  assert.equal(direct.source, 'account');
  assert.equal(direct.local, true);
});
