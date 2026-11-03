// 动态立绘 — the layered Spine illustration of one outfit (docs/OPERATOR-SKINS.md): the generated catalogue block,
// the manifest record it needs, and the two UI entry points that mount it only on demand.
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPERATOR_SKINS, ILLUSTRATION_SPINES, illustrationFor, dynamicIllustration, manifestSkinKey, skinFor } from '../../shared/skins.js';
import { appearanceEntry, appearanceStaticSrc, appearanceDynamic, dynamicFor } from '../../public/js/ui/skinAssets.js';
import {
  illustrationFolder, illustrationSources, illustrationRows, recordedRows, withIllustrationBlock,
  officialIllustrationId, catalogueOfficialIds,
} from '../../tools/assets/illustrations.mjs';

const CATALOGUE_SRC = readFileSync(new URL('../../shared/skin-catalogue.js', import.meta.url), 'utf8');
const SKIN_TABLE_FILE = new URL('../../.cache/gamedata/excel/skin_table.json', import.meta.url);
const SKIN_TABLE = existsSync(SKIN_TABLE_FILE) ? JSON.parse(readFileSync(SKIN_TABLE_FILE, 'utf8')) : null;

const catalogued = new Map(OPERATOR_SKINS.map((skin) => [skin.officialId, skin]));

test('the illustration catalogue only names catalogue outfits, with the official dynIllustId', () => {
  const entries = Object.entries(ILLUSTRATION_SPINES);
  assert.ok(entries.length > 0, 'the generated block is present');
  for (const [officialId, entry] of entries) {
    assert.ok(catalogued.has(officialId), `${officialId} is a catalogue outfit`);
    assert.match(entry.id, /^dyn_illust_/);
    if (SKIN_TABLE) assert.equal(officialIllustrationId(SKIN_TABLE.charSkins?.[officialId]), entry.id, `${officialId}: official declaration`);
  }
  assert.ok(entries.some(([, entry]) => entry.verified), 'at least one illustration was verified against the public dump');
});

test('both id forms resolve the same declaration; an unknown or cross-operator id resolves nothing', () => {
  const [officialId, entry] = Object.entries(ILLUSTRATION_SPINES)[0];
  const skin = catalogued.get(officialId);
  assert.equal(skinFor(skin.charId, skin.id).id, skin.id);
  assert.deepEqual(illustrationFor(skin.id), entry, 'catalogue stem');
  assert.deepEqual(illustrationFor(officialId), entry, 'official id');
  assert.equal(illustrationFor('char_498_inside@nothing#9'), null);
  assert.equal(illustrationFor(null), null);
});

test('a manifest record contributes its optional background / foreground layers, in either shape', () => {
  const dyn = { skel: '/d/x.skel', atlas: '/d/x.atlas', textures: ['/d/x.png'], anims: { idle: 'Idle' }, animations: { Idle: 1 }, bounds: { x: 0, y: 0, width: 10, height: 10 } };
  const nested = dynamicIllustration({ dynamic: { ...dyn, background: '/d/bg.png', foreground: '/d/fg.png' } });
  assert.equal(nested.background, '/d/bg.png');
  assert.equal(nested.foreground, '/d/fg.png');
  assert.deepEqual(nested.anims, { idle: 'Idle' });
  const beside = dynamicIllustration({ dynamic: dyn, dynamicBackground: '/d/bg2.png', dynamicForeground: '/d/fg2.png' });
  assert.equal(beside.background, '/d/bg2.png');
  assert.equal(beside.foreground, '/d/fg2.png');
  assert.equal(dynamicIllustration({ dynamic: { skel: '' } }), null, 'a record without a skeleton is static');
  assert.equal(dynamicIllustration({}), null);
  assert.equal(dynamicIllustration(null), null);
});

test('the UI resolves an outfit through either id and falls back to its own illustration / portrait', () => {
  const charId = 'char_498_inside';
  const official = 'char_498_inside@kitchen#2';
  const stem = manifestSkinKey(official);
  const record = { name: '厨房', illust: '/i/kitchen.png', portrait: '/p/kitchen.png', dynamic: { skel: '/s/dyn.skel', animations: { Idle: 1 }, anims: { idle: 'Idle' } } };
  const m = { chars: { [charId]: { skins: { [official]: record } } } };
  assert.equal(appearanceEntry(m, charId, official), record);
  assert.equal(appearanceEntry(m, charId, stem), record, 'the catalogue stem resolves the same manifest key');
  assert.equal(appearanceEntry(m, 'char_003_kalts', official), null, 'another operator never borrows it');
  assert.equal(appearanceEntry(m, charId, 'https://example.com/x'), null);
  assert.equal(appearanceStaticSrc(record), '/i/kitchen.png');
  assert.equal(appearanceStaticSrc({ portrait: '/p/x.png' }), '/p/x.png');
  assert.equal(appearanceStaticSrc({}), null);
  assert.equal(appearanceDynamic(record).skel, '/s/dyn.skel');
  assert.equal(dynamicFor(m, charId, stem).skel, '/s/dyn.skel');
  assert.equal(dynamicFor(m, charId, null), null);
});

test('the Ark-Models folder rule drops `char_` after dyn_illust_ and keeps the full file stem', () => {
  assert.equal(illustrationFolder('dyn_illust_char_437_mizuki_sale#7'), 'dyn_illust_437_mizuki_sale#7');
  assert.equal(illustrationFolder('../dyn_illust_x'), null);
  const src = illustrationSources('dyn_illust_char_437_mizuki_sale#7');
  assert.match(src.skel, /models_illust\/dyn_illust_437_mizuki_sale%237\/dyn_illust_char_437_mizuki_sale%237\.skel$/);
  assert.match(src.atlas, /\.atlas$/);
  assert.match(src.page, /\.png$/);
  assert.equal(src.background, null, 'the dump carries no separate layers today');
});

test('the generator derives one row per declared catalogue outfit and rewrites its block idempotently', () => {
  const source = 'export const SKIN_CATALOGUE = Object.freeze([\n  { "id": "a", "charId": "char_1_x", "officialId": "char_1_x@a#1" },\n  { "id": "b", "charId": "char_1_x", "officialId": "char_1_x@b#2" },\n]);\n';
  const table = { charSkins: { 'char_1_x@a#1': { dynIllustId: 'dyn_illust_char_1_x_a#1' }, 'char_1_x@b#2': {} } };
  const rows = illustrationRows({ source, skinTable: table });
  assert.deepEqual(rows.map((r) => [r.officialId, r.id, r.verified]), [['char_1_x@a#1', 'dyn_illust_char_1_x_a#1', false]]);
  const written = withIllustrationBlock(source, rows);
  assert.match(written, /export const ILLUSTRATION_SPINES/);
  assert.deepEqual(recordedRows(written).map((r) => [r.officialId, r.id]), [['char_1_x@a#1', 'dyn_illust_char_1_x_a#1']]);
  assert.equal(withIllustrationBlock(written, recordedRows(written)), written, 'a round trip is byte-stable');
  assert.deepEqual(catalogueOfficialIds(source), ['char_1_x@a#1', 'char_1_x@b#2']);
});

test('the checked-in block is what the generator writes from the official table', () => {
  if (!SKIN_TABLE) return;
  const rows = illustrationRows({ source: CATALOGUE_SRC, skinTable: SKIN_TABLE });
  const recorded = recordedRows(CATALOGUE_SRC);
  assert.deepEqual(recorded.map((r) => [r.officialId, r.id]), rows.map((r) => [r.officialId, r.id]), 'declarations are not stale');
  assert.equal(withIllustrationBlock(CATALOGUE_SRC, recorded), CATALOGUE_SRC, 'formatting round trip');
});

test('the component mounts Pixi / the asset store only in its effect and always releases them', () => {
  const src = readFileSync(new URL('../../public/js/ui/dynamicIllustration.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ ensurePixi \} from '\.\.\/render\/app\/pixi\.js'/);
  assert.match(src, /import\('\.\.\/assets\.js'\)/, 'the asset store is a lazy import');
  assert.match(src, /assets\.spine\.acquire\(entry\)/);
  assert.match(src, /assets\?\.spine\.release\(entry\)/);
  assert.match(src, /releaseGl\?\.\(app\.renderer\)/);
  assert.match(src, /app\?\.destroy\(true/);
  assert.match(src, /prefers-reduced-motion: reduce/, 'reduced motion starts paused');
  assert.match(src, /visibilitychange/, 'a hidden tab stops the ticker');
  assert.match(src, /state === 'fallback'/, 'the static illustration replaces a failed model');
  assert.match(src, /setAnimation\(0, clip, true\)/, 'the clip selector replays the mounted actor');
  assert.match(src, /Object\.keys\(entry\?\.animations \|\| \{\}\)/, 'the selector is the model\'s own clips');
});

test('both detail surfaces mount the preview on demand, not with the card list', () => {
  const picker = readFileSync(new URL('../../public/js/ui/skinPicker.js', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../../public/js/ui/detailPanel.js', import.meta.url), 'utf8');
  for (const [name, src, gate] of [['skinPicker', picker, /artOpen/], ['detailPanel', detail, /const \[open, setOpen\]/]]) {
    assert.match(src, /import \{ DynamicIllustration \} from '\.\/dynamicIllustration\.js'/, `${name}: the component`);
    assert.ok(src.includes('<${DynamicIllustration}'), `${name}: renders it`);
    assert.match(src, gate, `${name}: gated by an opened preview`);
  }
  assert.match(picker, /data-testid="skin-art-preview"/);
  assert.match(picker, /data-testid="dynamic-toggle"/);
  assert.match(detail, /data-testid="chess-illustration"/);
  assert.match(detail, /data-testid="detail-dynamic-toggle"/);
  const css = readFileSync(new URL('../../public/css/screens/loadout.css', import.meta.url), 'utf8');
  for (const cls of ['.lo-dynamic__stage', '.lo-dynamic__canvas', '.lo-dynamic__fallback', '.lo-dynamic__controls']) assert.ok(css.includes(cls), cls);
});
