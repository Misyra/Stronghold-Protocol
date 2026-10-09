import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord, newestFirst, exportRecords, parseRecords, HISTORY_IMPORT_BYTES } from '../../public/js/history/record.js';
import { createHistoryStorage } from '../../public/js/history/storage.js';

const result = () => ({ matchId: 'match-1', finishedAt: 1000, seed: 7, victory: true, durationMs: 12345,
  modeId: 'mode_multi_hard', difficulty: 'HARD', roundsPassed: 14, token: 'secret',
  players: [{ playerId: 'p1', name: '博士', victory: true, alive: true, roundsPassed: 14,
    token: 'secret', stats: { dmgDealt: 321, kills: 4, token: 'secret' },
    lineup: [{ id: 'char_test', golden: true, row: 2, col: 3, items: ['item_test'], token: 'secret' }],
    bonds: [{ bondId: 'bond_test', active: true, layers: 3 }], title: { id: 'comment_1', name: '评语', token: 'secret' } },
  { playerId: 'ai_1', name: 'AI', isBot: true, stats: {}, lineup: [] }] });

test('settlement snapshots preserve all report data without session credentials or shared references', () => {
  const source = result();
  const record = makeRecord(source, 'p1', { now: 2000, origin: 'https://game.example', appVersion: '0.1.3' });
  assert.equal(record.endedAt, 1000);
  assert.equal(record.recordedAt, 2000);
  assert.equal(record.result.players.length, 2);
  assert.deepEqual(record.result.players[0].lineup[0].items, ['item_test']);
  assert.equal(record.result.players[0].stats.dmgDealt, 321);
  assert.equal(record.result.players[0].bonds[0].layers, 3);
  assert.ok(!JSON.stringify(record).includes('secret'));
  source.players[0].lineup[0].items.push('changed');
  source.players[0].stats.dmgDealt = 0;
  assert.deepEqual(record.result.players[0].lineup[0].items, ['item_test']);
  assert.equal(record.result.players[0].stats.dmgDealt, 321);
});
test('spectators, bots and incomplete results are not personal match records', () => {
  assert.equal(makeRecord(result(), 'spectator'), null);
  assert.equal(makeRecord(result(), 'ai_1'), null);
  assert.equal(makeRecord({ players: result().players }, 'p1'), null);
  assert.equal(makeRecord(null, 'p1'), null);
});
test('reconnect resends share an ID, while a new match and another participant do not', () => {
  const r = result();
  const first = makeRecord(r, 'p1', { now: 100 });
  assert.equal(makeRecord(r, 'p1', { now: 200 }).id, first.id);
  assert.notEqual(makeRecord({ ...r, matchId: 'match-2' }, 'p1').id, first.id);
  assert.notEqual(makeRecord(r, 'p1', { origin: 'https://other.example' }).id, first.id);
  delete r.matchId;
  assert.equal(makeRecord(r, 'p1', { now: 100 }).id, makeRecord(r, 'p1', { now: 200 }).id);
});
test('bounded snapshots reject oversized data and export a portable versioned document', () => {
  const r = result();
  const record = makeRecord(r, 'p1');
  const exported = JSON.parse(exportRecords([record]));
  assert.equal(exported.format, 'stronghold-match-history');
  assert.equal(exported.schema, 1);
  assert.deepEqual(exported.records, [record]);
  r.players[0].name = 'x'.repeat(128 * 1024);
  assert.throws(() => makeRecord(r, 'p1'), /过大/);
});
test('history ordering uses server settlement time, then local recording time', () => {
  assert.deepEqual(newestFirst([{ id: 'a', endedAt: 2, recordedAt: 1 }, { id: 'b', endedAt: 1, recordedAt: 8 },
    { id: 'c', endedAt: 2, recordedAt: 3 }]).map((r) => r.id), ['c', 'a', 'b']);
});
test('unavailable IndexedDB produces an explicit retryable error', async () => {
  const storage = createHistoryStorage({ indexedDB: null });
  await assert.rejects(storage.list(), /不支持/);
  await assert.rejects(storage.list(), /不支持/);
});

test('exports round trip through import with IDs, origin, dates and reports preserved', () => {
  const record = makeRecord(result(), 'p1', { now: 2000, origin: 'https://old.example', appVersion: '0.2.1' });
  assert.deepEqual(parseRecords(exportRecords([record])), [record]);
  assert.deepEqual(parseRecords('\uFEFF' + exportRecords([record])), [record], 'UTF-8 BOM is accepted');
  assert.deepEqual(parseRecords(exportRecords([])), []);
});

test('record imports validate the whole document, participant identity, schema and bounds', () => {
  const record = makeRecord(result(), 'p1');
  const doc = JSON.parse(exportRecords([record]));
  assert.throws(() => parseRecords('not JSON'), /JSON/);
  assert.throws(() => parseRecords('null'), /格式/);
  assert.throws(() => parseRecords(JSON.stringify({ ...doc, format: 'other' })), /格式/);
  assert.throws(() => parseRecords(JSON.stringify({ ...doc, schema: 2 })), /版本/);
  for (const bad of [{ ...record, id: 'forged' }, { ...record, schema: 2 }, { ...record, endedAt: 'yesterday' },
    { ...record, playerId: 'spectator' }, { ...record, origin: null }, { ...record, deleted: true },
    { ...record, result: { ...record.result, players: [record.result.players[0], record.result.players[0]] } }]) {
    assert.throws(() => parseRecords(exportRecords([record, bad])), /无效/);
  }
  assert.throws(() => parseRecords(' '.repeat(HISTORY_IMPORT_BYTES + 1)), /过大/);
  assert.throws(() => parseRecords(exportRecords(Array(1001).fill(record))), /格式/);
});

test('imported records discard unknown fields and session credentials before storage', () => {
  const record = makeRecord(result(), 'p1');
  const source = { ...record, token: 'import-secret', result: { ...result(), token: 'import-secret' } };
  const parsed = parseRecords(exportRecords([source]));
  assert.deepEqual(parsed, [record]);
  assert.ok(!JSON.stringify(parsed).includes('secret'));
});
