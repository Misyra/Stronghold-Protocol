import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLegacyBackup, LEGACY_IMPORT_BYTES } from '../../public/js/history/legacyBackup.js';
import { exportRecords } from '../helpers/legacyHistory.js';
const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/legacy-history.json', import.meta.url), 'utf8'));

test('an independently captured old backup preserves IDs, dates and settlement details', () => {
  const doc = fixture();
  assert.deepEqual(parseLegacyBackup(JSON.stringify(doc)), doc.records);
  assert.deepEqual(parseLegacyBackup('\uFEFF' + JSON.stringify(doc)), doc.records);
  assert.deepEqual(parseLegacyBackup(exportRecords([])), []);
});

test('legacy parsing strips credentials and unknown fields and does not retain mutable input', () => {
  const doc = fixture(), expected = structuredClone(doc.records);
  const raw = doc.records[0];
  raw.token = 'secret'; raw.result.token = 'secret';
  raw.result.players[0].token = 'secret'; raw.result.players[0].stats.token = 'secret';
  raw.result.players[0].lineup[0].token = 'secret';
  const parsed = parseLegacyBackup(JSON.stringify(doc));
  assert.deepEqual(parsed, expected);
  raw.result.players[0].lineup[0].items.push('changed');
  assert.deepEqual(parsed[0].result.players[0].lineup[0].items, ['item_test']);
  assert.ok(!JSON.stringify(parsed).includes('secret'));
});

test('spectators, bots and incomplete settlements cannot be imported as personal records', () => {
  for (const playerId of ['spectator', 'ai_1']) {
    const doc = fixture(); doc.records[0].playerId = playerId;
    assert.throws(() => parseLegacyBackup(JSON.stringify(doc)), /无效/);
  }
  const doc = fixture(); delete doc.records[0].result.victory;
  assert.throws(() => parseLegacyBackup(JSON.stringify(doc)), /无效/);
});

test('old server fallback IDs are accepted; altered match facts and provenance invalidate them', () => {
  const doc = fixture(), row = doc.records[0]; delete row.result.matchId;
  const matchId = '[7,"mode_multi_hard",null,12345,["ai_1","p1"]]';
  row.id = JSON.stringify(['https://old.example', matchId, 'p1']);
  assert.equal(parseLegacyBackup(JSON.stringify(doc))[0].id, row.id);
  for (const patch of [{ origin: 'https://other.example' }, { id: 'forged' }]) {
    assert.throws(() => parseLegacyBackup(exportRecords([{ ...row, ...patch }])), /无效/);
  }
  row.result.seed = 99;
  assert.throws(() => parseLegacyBackup(JSON.stringify(doc)), /无效/);
});

test('legacy imports validate the complete envelope and every row before returning any data', () => {
  const doc = fixture(), row = doc.records[0];
  assert.throws(() => parseLegacyBackup('not JSON'), /JSON/);
  assert.throws(() => parseLegacyBackup('null'), /格式/);
  assert.throws(() => parseLegacyBackup(JSON.stringify({ ...doc, format: 'other' })), /格式/);
  assert.throws(() => parseLegacyBackup(JSON.stringify({ ...doc, schema: 2 })), /版本/);
  for (const bad of [{ ...row, schema: 2 }, { ...row, endedAt: 'yesterday' }, { ...row, origin: null }, { ...row, deleted: true },
    { ...row, result: { ...row.result, players: [row.result.players[0], row.result.players[0]] } }]) {
    assert.throws(() => parseLegacyBackup(exportRecords([row, bad])), /无效/);
  }
  assert.throws(() => parseLegacyBackup(' '.repeat(LEGACY_IMPORT_BYTES + 1)), /过大/);
  assert.throws(() => parseLegacyBackup(exportRecords(Array(1001).fill(row))), /格式/);
});

test('legacy row limits count UTF-8 bytes and retain supported DIY/stand-in identities', () => {
  const doc = fixture(), unit = doc.records[0].result.players[0].lineup[0];
  unit.diy = { charId: 'char_1', skillIndex: 1, uniEquipId: 'module_1', token: 'secret' };
  unit.standInFor = 'char_2';
  const parsed = parseLegacyBackup(JSON.stringify(doc))[0].result.players[0].lineup[0];
  assert.deepEqual(parsed.diy, { charId: 'char_1', skillIndex: 1, uniEquipId: 'module_1' });
  assert.equal(parsed.standInFor, 'char_2');
  doc.records[0].result.players[0].name = '博'.repeat(45000);
  assert.throws(() => parseLegacyBackup(JSON.stringify(doc)), /无效/);
});
