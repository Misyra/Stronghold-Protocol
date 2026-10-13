import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLegacyHistory } from '../../public/js/history/legacyStorage.js';

function database({ rows = [], missing = false, blocked = false, abort = false, incompatible = false } = {}) {
  const calls = { close: 0, open: [], modes: [], rollback: 0 };
  const db = {
    close() { calls.close++; },
    transaction(name, mode) {
      assert.equal(name, 'matches'); calls.modes.push(mode);
      if (incompatible) throw new Error('no matches store');
      const tx = { error: new Error('read failed'), objectStore() {
        const query = {};
        queueMicrotask(() => { query.result = structuredClone(rows); if (abort) tx.onabort(); else tx.oncomplete(); });
        return { getAll: () => query };
      } };
      return tx;
    },
  };
  const indexedDB = { open(...args) {
    calls.open.push(args);
    const request = { result: db, error: new Error('aborted creation'), transaction: { abort() {
      calls.rollback++; queueMicrotask(() => request.onerror());
    } } };
    queueMicrotask(() => {
      if (missing) request.onupgradeneeded();
      else if (blocked) { request.onblocked(); queueMicrotask(() => request.onsuccess()); }
      else request.onsuccess();
    });
    return request;
  } };
  return { indexedDB, calls };
}

test('legacy reader only opens a readonly transaction and closes it after sorted reads', async () => {
  const { indexedDB, calls } = database({ rows: [{ id: 'a', endedAt: 2, recordedAt: 1 },
    { id: 'b', endedAt: 1, recordedAt: 8 }, { id: 'c', endedAt: 2, recordedAt: 3 }, { id: 'deleted', deleted: true }, null] });
  assert.deepEqual((await readLegacyHistory({ indexedDB })).map((r) => r.id), ['c', 'a', 'b']);
  assert.deepEqual(calls.open, [['stronghold-match-history']], 'do not request a schema version');
  assert.deepEqual(calls.modes, ['readonly']); assert.equal(calls.close, 1);
});

test('a missing database rolls back creation and returns an empty history', async () => {
  const { indexedDB, calls } = database({ missing: true });
  assert.deepEqual(await readLegacyHistory({ indexedDB }), []);
  assert.equal(calls.rollback, 1); assert.equal(calls.close, 1); assert.deepEqual(calls.modes, []);
});

test('blocked late opens, failed reads and incompatible stores close their connections', async () => {
  for (const options of [{ blocked: true }, { abort: true }, { incompatible: true }]) {
    const { indexedDB, calls } = database(options);
    await assert.rejects(readLegacyHistory({ indexedDB }));
    await Promise.resolve();
    assert.equal(calls.close, 1);
  }
});

test('unavailable or failed IndexedDB remains retryable on the next read', async () => {
  await assert.rejects(readLegacyHistory({ indexedDB: null }), /不支持/);
  await assert.rejects(readLegacyHistory({ indexedDB: { open() { throw new Error('disabled'); } } }), /disabled/);
  assert.deepEqual(await readLegacyHistory({ indexedDB: database().indexedDB }), []);
});
