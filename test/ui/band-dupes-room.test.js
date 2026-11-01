// The room screen's AI strategy picker (BotBandPicker) under 「允许重复策略」 (room.setBandDupes,
// room.state.bandDupes): with the option on the picker no longer greys out / blocks a strategy another AI seat already
// holds (the server's room.setBotBand accepts it then) and its tip says so; with it off one AI seat per strategy stands.
// Style: test/ui/ai-picks-last.test.js — option helper + source + i18n assertions; the real browser path is
// test/ui/coop-votes.browser.test.js (SP_E2E=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/screens/room.js'), 'utf8');
const EN = JSON.parse(readFileSync(path.join(ROOT, 'public/i18n/en.json'), 'utf8'));
const mod = () => import(pathToFileURL(path.join(ROOT, 'public/js/screens/room.js')).href);

const ON_TIP = '开局选择策略时，该 AI 队友会直接选择指定的策略；已开启允许重复策略，多个 AI 队友可共用同一种策略。';
const OFF_TIP = '开局选择策略时，该 AI 队友会直接选择指定的策略，其他博士不能再选它。';

const room = (o = {}) => ({
  code: 'ABCD', hostId: 'h', mode: 'coop', difficulty: 'NORMAL', bandDupes: false,
  seats: [{ seat: 0, playerId: 'h', name: 'Host', isBot: false, ready: false, connected: true }, null, null, null],
  ...o,
});

test('bandDupesOption: the host toggles it, everybody else sees it read-only, off when absent', async () => {
  const { bandDupesOption } = await mod();
  assert.deepEqual(bandDupesOption(room(), 'h'), { on: false, editable: true });
  assert.deepEqual(bandDupesOption(room({ bandDupes: true }), 'h'), { on: true, editable: true });
  assert.deepEqual(bandDupesOption(room({ bandDupes: true }), 'g'), { on: true, editable: false });
  assert.deepEqual(bandDupesOption(room({ bandDupes: undefined }), 'g'), { on: false, editable: false });
  assert.equal(bandDupesOption(null, 'h'), null);
});

test('BotBandPicker receives room.bandDupes and stands its one-AI-per-strategy guard down with it', () => {
  assert.match(SRC, /dupes=\$\{room\.bandDupes === true\}/, 'the screen passes the room option into the picker');
  assert.match(SRC, /function BotBandPicker\(\{ open, seat, seats, bands, busy, dupes = false, onClose, onPick \}\)/,
    'the picker takes the option (off when an older server omits it)');
  assert.match(SRC, /if \(!dupes\) for \(const x of seats/, 'strategies held by another AI only block while duplicates are off');
  assert.match(SRC, /dupes \? t\(/, 'the tip names the option while it is on');
});

test('the picker tips go through t() with entries in every pack', () => {
  for (const pack of ['en', 'ja', 'ko', 'zh-TW']) {
    const table = JSON.parse(readFileSync(path.join(ROOT, `public/i18n/${pack}.json`), 'utf8'));
    assert.equal(typeof table[ON_TIP], 'string', `${pack}.json: ${ON_TIP}`);
    assert.equal(typeof table[OFF_TIP], 'string', `${pack}.json: ${OFF_TIP}`);
  }
  assert.ok(EN[ON_TIP].length > 0 && !/[一-鿿]/.test(EN[ON_TIP]), `English for ${ON_TIP}`);
  assert.ok(!/[一-鿿]/.test(EN[OFF_TIP]), `English for ${OFF_TIP}`);
});
