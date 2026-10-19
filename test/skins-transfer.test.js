// test/skins-transfer.test.js — the standalone 皮肤配置 file (public/js/ui/skinTransfer.js).
//
// Why it exists: a 调配 export is about skills, modules and 潜能, so reading one to get your skins back costs you the
// loadout of the server you just joined, and a file of skins alone used to be refused outright (`里面没有有效的调配
// 条目`). A 皮肤配置 file names nothing but 皮肤 (battle model) and 商店立绘, keyed by chess / slot id — which is what
// makes it readable on another server, where the roster, the loadout and even the plugin set may differ.
//
// What is pinned here:
//   * the envelope round trip, with both maps and the operator count (a chess in both rows counts once);
//   * the two parsers never accept each other's file (a 调配 upload must not be read as skins, and the reverse);
//   * an id this install has never heard of is CARRIED, not dropped — the whole point of the file;
//   * junk that would corrupt the store never reaches it (non-strings, blanks, prototype keys);
//   * the refusals: a newer envelope, an empty selection, oversized text, garbage;
//   * and that the screens actually offer it (the buttons in the 皮肤 header, the lane in the loadout screen's io modal).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  skinConfig, serializeSkinConfig, parseSkinConfig, SKIN_EXPORT_KIND, SKIN_TRANSFER_VERSION, SKIN_IMPORT_MAX_BYTES,
} from '../public/js/ui/skinTransfer.js';
import { parseImport, exportPayload } from '../public/js/ui/loadoutModel.js';
import { parseDiyImport } from '../public/js/ui/diyModel.js';

const KNOWN = 'chess_char_608_acpion_a';
const SLOT = 'chess_char_6_diy1_a';
const SKIN = 'char_608_acpion@sharp#1';
const ART = 'char_608_acpion@sharp#1.portrait';
const NOW = Date.UTC(2026, 9, 19, 9, 30);

describe('skinConfig / serializeSkinConfig', () => {
  test('the envelope is the payload and nothing else', () => {
    const p = skinConfig({ skins: { [KNOWN]: SKIN }, portraits: { [KNOWN]: ART } }, { now: NOW });
    assert.deepEqual(Object.keys(p).sort(), ['count', 'exportedAt', 'kind', 'portraits', 'skins', 'v']);
    assert.equal(p.kind, SKIN_EXPORT_KIND);
    assert.equal(p.v, SKIN_TRANSFER_VERSION);
    assert.equal(p.exportedAt, '2026-10-19T09:30:00.000Z');
    assert.deepEqual(p.skins, { [KNOWN]: SKIN });
    assert.deepEqual(p.portraits, { [KNOWN]: ART });
  });

  test('count is operators, not rows: one chess with both choices counts once', () => {
    const p = skinConfig({ skins: { [KNOWN]: SKIN, [SLOT]: SKIN }, portraits: { [KNOWN]: ART } });
    assert.equal(p.count, 2);
    assert.deepEqual(skinConfig({}).skins, {}, 'nothing chosen is an empty map, not a crash');
    assert.equal(skinConfig({}).count, 0);
  });

  test('junk is dropped on the way out (a blank is "no choice", a non-string is not an id)', () => {
    const p = skinConfig({ skins: { [KNOWN]: SKIN, a: '', b: 42, c: null }, portraits: { d: SKIN, e: {} } });
    assert.deepEqual(p.skins, { [KNOWN]: SKIN });
    assert.deepEqual(p.portraits, { d: SKIN });
  });

  test('the text is pretty JSON a human can read', () => {
    const text = serializeSkinConfig({ skins: { [KNOWN]: SKIN } }, { now: NOW });
    assert.match(text, /\n {2}"kind": "stronghold\.skins",\n/);
    assert.deepEqual(JSON.parse(text), skinConfig({ skins: { [KNOWN]: SKIN } }, { now: NOW }));
  });
});

describe('parseSkinConfig', () => {
  test('round trip, text or object', () => {
    const maps = { skins: { [KNOWN]: SKIN, [SLOT]: SKIN }, portraits: { [KNOWN]: ART } };
    const want = { ok: true, skins: maps.skins, portraits: maps.portraits, count: 2 };
    assert.deepEqual(parseSkinConfig(serializeSkinConfig(maps, { now: NOW })), want);
    assert.deepEqual(parseSkinConfig(skinConfig(maps, { now: NOW })), want);
  });

  test('an operator this install has never heard of is carried, not dropped', () => {
    // the portable case: the file was written on a server whose roster / plugins differ
    const foreign = 'chess_char_999_unknown_a';
    const r = parseSkinConfig(JSON.stringify({
      kind: SKIN_EXPORT_KIND, v: 1, skins: { [foreign]: 'char_999_unknown@skin#7' },
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.skins, { [foreign]: 'char_999_unknown@skin#7' });
    assert.deepEqual(r.portraits, {}, 'a missing row is an empty map, not undefined');
  });

  test('a 调配 / 自选 file is refused by kind, and a skin file is refused by theirs', () => {
    const loadoutFile = JSON.stringify(exportPayload({ [KNOWN]: { skill: 0 } }, { now: NOW }));
    const r = parseSkinConfig(loadoutFile);
    assert.equal(r.ok, false);
    assert.equal(r.error, '这不是皮肤配置的数据');

    const skinFile = serializeSkinConfig({ skins: { [KNOWN]: SKIN } }, { now: NOW });
    const back = parseImport(skinFile);
    assert.equal(back.ok, false, 'the loadout parser must not swallow a skins file');
    assert.equal(back.error, '这不是干员调配的数据');
    assert.equal(parseDiyImport(skinFile).ok, false, 'nor the 自选 parser');
  });

  test('a bare map (no envelope) still imports, like the stored preference it is', () => {
    const r = parseSkinConfig({ skins: { [KNOWN]: SKIN } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.skins, { [KNOWN]: SKIN });
  });

  test('junk never reaches the store', () => {
    const r = parseSkinConfig(JSON.stringify({
      kind: SKIN_EXPORT_KIND, v: 1,
      skins: { [KNOWN]: SKIN, 'not an id!': 'x', n: 42, blank: '' },
      portraits: { p: ART, q: null },
    }));
    assert.deepEqual(r.skins, { [KNOWN]: SKIN });
    assert.deepEqual(r.portraits, { p: ART });
    assert.equal(r.count, 2);
    // a prototype key is skipped like ui/loadoutModel.js parseStored does — a foreign file must not patch Object.prototype
    const proto = parseSkinConfig('{"kind":"stronghold.skins","v":1,"skins":{"__proto__":"x","constructor":"y","ok":"z"}}');
    assert.deepEqual(proto.skins, { ok: 'z' });
  });

  test('the refusals', () => {
    assert.equal(parseSkinConfig('').error, '没有可导入的内容');
    assert.equal(parseSkinConfig('   ').error, '没有可导入的内容');
    assert.equal(parseSkinConfig('{oops').error, '无法识别的内容');
    assert.equal(parseSkinConfig(42).error, '无法识别的格式');
    assert.equal(parseSkinConfig([]).error, '无法识别的格式');
    assert.equal(parseSkinConfig({ kind: SKIN_EXPORT_KIND, v: SKIN_TRANSFER_VERSION + 1, skins: { [KNOWN]: SKIN } }).error,
      '这份皮肤配置来自更新的版本（v2），请先更新游戏');
    // an envelope with nothing in it would wipe the selection on import
    assert.equal(parseSkinConfig({ kind: SKIN_EXPORT_KIND, v: 1, skins: {}, portraits: {} }).error, '里面没有皮肤选择');
    assert.equal(parseSkinConfig({ kind: SKIN_EXPORT_KIND, v: 1 }).error, '里面没有皮肤选择');
    const huge = `{"kind":"stronghold.skins","skins":{"a":"${'x'.repeat(SKIN_IMPORT_MAX_BYTES)}"}}`;
    assert.equal(parseSkinConfig(huge).error, '内容过长，无法导入');
  });
});

describe('the screens offer it', () => {
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  test('the 皮肤 section itself carries no buttons — the picker is about choices, not files', () => {
    const picker = src('public/js/ui/skinPicker.js');
    assert.doesNotMatch(picker, /skin-io-export|skin-io-import/, 'the pair lives in the screen toolbar, one place per screen');
    assert.doesNotMatch(picker, /io\.onExport/, 'so the picker takes no transfer handlers at all');
  });

  test('the loadout screen owns the transfer modal lane', () => {
    const lo = src('public/js/screens/loadout.js');
    assert.match(lo, /import \{ serializeSkinConfig, parseSkinConfig, SKIN_IMPORT_MAX_BYTES \} from '\.\.\/ui\/skinTransfer\.js'/);
    assert.match(lo, /kind: 'skins'/);
    assert.match(lo, /const ioSkins = io\?\.kind === 'skins'/);
    assert.match(lo, /exportFilename\(new Date\(\), ioSkins \? 'skins'/, 'the download is named for what it holds');
    assert.match(lo, /title=\$\{ioSkins \? t\(io\.mode === 'export' \? '导出皮肤配置' : '导入皮肤配置'\)/);
    // the 更多 menu of the card view, the list view bar, and the 自选 bar — the toolbar, never the 皮肤 section
    assert.ok((lo.match(/data-testid="skin-export"/g) || []).length >= 3, 'offered from every toolbar');
    assert.ok((lo.match(/data-testid="skin-import"/g) || []).length >= 3);
    assert.match(lo, /onClick=\$\{openSkinExport\}/);
    assert.match(lo, /onClick=\$\{openSkinImport\}/);
    // disabled till there is something to carry, and subscribed — a `get()` snapshot would leave the item grey while
    // the player picks an outfit in the panel beside it
    assert.match(lo, /disabled=\$\{!nSkinChoices\}/);
    assert.match(lo, /const nSkinChoices = useStore\(/);
  });

  test('the 调配 / 自选 exports still carry their half of the choices — the extra file takes nothing away', () => {
    const lo = src('public/js/screens/loadout.js');
    const entry = { [KNOWN]: { skill: 0 } };
    assert.deepEqual(exportPayload(entry, { now: NOW, skins: { [KNOWN]: SKIN }, portraits: { [KNOWN]: ART } }).skins,
      { [KNOWN]: SKIN }, 'the envelope keeps the field it had');
    assert.deepEqual(parseImport(JSON.stringify(exportPayload(entry, { now: NOW, skins: { [KNOWN]: SKIN } }))).skins,
      { [KNOWN]: SKIN }, 'and the parser still reads it back');
    assert.match(lo, /skins: rosterSkinMap\(skinsStore\.get\(\)\.entries\), portraits: rosterSkinMap\(skinsStore\.get\(\)\.portraits\)/,
      'the 调配 export keeps writing them, roster keys only');
    assert.match(lo, /skins: slotSkinMap\(skinsStore\.get\(\)\.entries\), portraits: slotSkinMap\(skinsStore\.get\(\)\.portraits\)/,
      'so does the 自选 export, slot keys only');
  });
});
