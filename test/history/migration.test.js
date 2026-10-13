import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyHistory } from '../../public/js/history/migration.js';
import { makeRecord, exportRecords } from '../helpers/legacyHistory.js';
import { buildRecord, loadStats, saveStats, importStats, emptyStats } from '../../public/js/ui/stats.js';

const result = { victory: true, seed: 17, durationMs: 1000, roundsPassed: 3,
  players: [{ playerId: 'human', name: '博士', victory: true, lineup: [], bonds: [], stats: { kills: 4 } }] };
function fixture(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map();
  const ls = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  const row = makeRecord(result, 'human', { now: 100 });
  return { ls, row, readRecords: async () => [row] };
}

test('legacy history merges into upstream stats once and deduplicates an already recorded settlement', async (t) => {
  const { ls, readRecords } = fixture(t);
  saveStats({ v: 1, records: [buildRecord(result, { myId: 'human', now: 100 })] });
  assert.equal(await migrateLegacyHistory({ readRecords, localStorage: ls }), 0);
  assert.equal(loadStats().records.length, 1);
  assert.equal(await migrateLegacyHistory({ readRecords() { throw new Error('must not read twice'); }, localStorage: ls }), 0);
});

test('migration rereads current stats after async IndexedDB work, preserving a newly arrived result', async (t) => {
  const { ls, row } = fixture(t);
  let release;
  const pending = migrateLegacyHistory({ localStorage: ls, readRecords: () => new Promise((resolve) => { release = resolve; }) });
  saveStats({ v: 1, records: [buildRecord({ ...result, seed: 99 }, { myId: 'human', now: 200 })] });
  release([row]);
  assert.equal(await pending, 1);
  assert.equal(loadStats().records.length, 2);
});

test('a failed migration keeps the legacy database retryable; older exports import through upstream stats', async (t) => {
  const { ls, row, readRecords } = fixture(t);
  const write = ls.setItem;
  ls.setItem = () => { throw new Error('quota'); };
  await assert.rejects(migrateLegacyHistory({ readRecords, localStorage: ls }), /迁移失败/);
  assert.equal(ls.getItem('sp.pref.historyMigrated'), null);
  ls.setItem = write;
  assert.equal(await migrateLegacyHistory({ readRecords, localStorage: ls }), 1);
  const merged = importStats(JSON.parse(exportRecords([row])), emptyStats());
  assert.equal(merged.added, 1);
  assert.equal(merged.stats.records[0].players[0].stats.kills, 4);
});
