// ui/gameLoading.js (ported from the Stardust fork): which files the match UI is still waiting for, and which of them
// make the screen say 「部分模拟数据未能载入」 — art is optional, the match data tables are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingCoreData, pendingGameFiles } from '../../public/js/ui/gameLoading.js';
import { GAME_FILES } from '../../public/js/ui/gameComponents.js';

/** A stand-in for the data store: `status` answers from a name → status map, anything else is idle. */
const source = (statuses) => ({ status: (name) => statuses[name] || 'idle' });

test('every match file ready: nothing pending and no missing core', () => {
  const all = Object.fromEntries(GAME_FILES.map((n) => [n, 'ready']));
  assert.deepEqual(pendingGameFiles(source(all)), []);
  assert.equal(missingCoreData(source(all)), false);
});

test('a file still loading is listed with its status', () => {
  const s = source({ chess: 'ready', bonds: 'loading' });
  const pending = pendingGameFiles(s);
  assert.ok(pending.some((f) => f.name === 'bonds' && f.status === 'loading'));
  assert.ok(!pending.some((f) => f.name === 'chess'), 'a ready file is not listed');
  assert.equal(missingCoreData(s), false);
});

test('a failed art file is skipped, a failed data table is not', () => {
  assert.deepEqual(pendingGameFiles(source({ assets: 'missing' })).filter((f) => f.name === 'assets'), [], 'art is optional');
  assert.equal(missingCoreData(source({ assets: 'missing' })), false);
  assert.ok(pendingGameFiles(source({ chess: 'missing' })).some((f) => f.name === 'chess' && f.status === 'missing'));
  assert.equal(missingCoreData(source({ chess: 'missing' })), true);
});
