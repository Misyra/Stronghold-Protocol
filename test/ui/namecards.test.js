// test/ui/namecards.test.js — 名片底图 (public/js/ui/namecards.js, 移植自 Stardust fork 2026-10-14 / #61 / #89): the card
// catalogue (the four simulation loading pictures, the faction emblems and the organisation emblems), card id parsing,
// the picture lookup — the local client extraction first, the generated art manifest second, nothing when neither has
// it (a missing file is never an error) — and the vertical framing rule (dragNamecardY). The picker/layer are hook-driven
// components, so their wiring is asserted from the source: the sections, the framing plate, and the room seat + sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAMECARDS, namecardOf, namecardSrc, dragNamecardY, namecardY,
  NAMECARD_PREF, NAMECARD_Y_PREF,
} from '../../public/js/ui/namecards.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('the catalogue: four simulation scenes, the faction emblems, the organisation emblems; ids are loading:/camp:', () => {
  const ids = NAMECARDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'one card per id');
  assert.deepEqual(ids.filter((id) => id.startsWith('loading:')),
    ['loading:prototype', 'loading:core', 'loading:hard', 'loading:abyss']);
  assert.deepEqual(ids.filter((id) => id.startsWith('camp:')).slice(0, 4), ['camp:rhodes', 'camp:lungmen', 'camp:yan', 'camp:higashi']);
  // the organisations of handbook_team_table (feedback #89): 23 of them, each with the tint behind its emblem
  for (const key of ['babel', 'rhine', 'penguin', 'blacksteel', 'karlan', 'glasgow', 'abyssal', 'siesta', 'dublinn', 'followers',
    'lgd', 'pinus', 'chiave', 'lee', 'rainbow', 'student', 'sui', 'sweep', 'elite', 'action4', 'reserve1', 'reserve4', 'reserve6']) {
    const c = namecardOf(`camp:${key}`);
    assert.ok(c && c.kind === 'camp' && c.tint && c.assetKey === `campLogo/logo_${key}`, key);
  }
  for (const c of NAMECARDS) {
    assert.ok(typeof c.assetKey === 'string' && c.assetKey, c.id);
    assert.ok(typeof c.name === 'string' && c.name, c.id);
    assert.ok(Object.isFrozen(c), c.id);
  }
  assert.equal(namecardOf('loading:core')?.assetKey, 'loading/loading_ac_core');
  assert.equal(namecardOf('loading:core')?.localName, null, 'the loading pictures have no local-extraction group');
  assert.equal(namecardOf('camp:babel')?.localName, 'logo_babel');
  // unknown / empty / junk is no card (an older or newer client's id shows nothing)
  for (const v of ['', 'loading:', 'camp:not_a_camp', 'skin:x', null, 7, {}, []]) assert.equal(namecardOf(v), null, String(v));
  assert.equal(NAMECARD_PREF, 'room.namecard');
  assert.equal(NAMECARD_Y_PREF, 'room.namecard.y');
});

test('the picture: the local client extraction first, the generated manifest second, null when neither has it', () => {
  const m = {
    ui: {
      'loading/loading_ac_core': '/assets/ui/loading/loading_ac_core.png',
      'campLogo/logo_rhodes': '/assets/ui/campLogo/logo_rhodes.png',
    },
  };
  const local = { groups: { 'ui/campLogo': { logo_rhodes: { path: '/assets/local/campLogo/logo_rhodes.png' }, logo_babel: { path: '/assets/local/campLogo/logo_babel.png' } } } };
  assert.equal(namecardSrc(namecardOf('loading:core'), m, local), '/assets/ui/loading/loading_ac_core.png');
  // a card both sources have: the local file wins (the same rule as data.js artUrls)
  assert.equal(namecardSrc(namecardOf('camp:rhodes'), m, local), '/assets/local/campLogo/logo_rhodes.png');
  // an organisation emblem is not in the generated manifest here: the extraction carries it
  assert.equal(namecardSrc(namecardOf('camp:babel'), m, local), '/assets/local/campLogo/logo_babel.png');
  assert.equal(namecardSrc(namecardOf('camp:babel'), m), null, 'no extraction and no manifest: nothing (graceful)');
  assert.equal(namecardSrc(namecardOf('camp:lungmen'), m, local), null, 'a card neither source lists shows nothing');
  assert.equal(namecardSrc(namecardOf('loading:core'), null, null), null);
  // junk in the manifests is ignored, and a path that could break the CSS url() is refused
  assert.equal(namecardSrc(namecardOf('camp:rhodes'), { ui: { 'campLogo/logo_rhodes': 7 } }, null), null);
  assert.equal(namecardSrc(namecardOf('camp:rhodes'), { ui: { 'campLogo/logo_rhodes': 'a"b.png' } }, null), null);
  assert.equal(namecardSrc(namecardOf('camp:rhodes'), { ui: { 'campLogo/logo_rhodes': 'a\\b.png' } }, null), null);
  assert.equal(namecardSrc(null, m, local), null);
  assert.equal(namecardSrc(namecardOf('loading:core'), {}, {}), null);
});

test('the framing: an integer 0–100, else null; dragging down shows more of the top', () => {
  assert.equal(namecardY(0), 0);
  assert.equal(namecardY(100), 100);
  for (const v of [-1, 101, 50.5, '50', null, undefined, NaN]) assert.equal(namecardY(v), null, String(v));
  // a 300×100 plate showing a 2:1 picture has 500 px of spare height; 100 px of drag is 20 % of it
  assert.equal(dragNamecardY(50, 100, { width: 300, height: 100, aspect: 2 }), 30);
  assert.equal(dragNamecardY(50, -100, { width: 300, height: 100, aspect: 2 }), 70);
  assert.equal(dragNamecardY(50, 0, { width: 300, height: 100, aspect: 2 }), 50);
  // clamps at both ends
  assert.equal(dragNamecardY(50, 1e6, { width: 300, height: 100, aspect: 2 }), 0);
  assert.equal(dragNamecardY(50, -1e6, { width: 300, height: 100, aspect: 2 }), 100);
  // the whole picture already shows (or is square): the position stays
  assert.equal(dragNamecardY(50, 100, { width: 300, height: 300, aspect: 1 }), 50);
  assert.equal(dragNamecardY(70, -200, { width: 300, height: 600, aspect: 2 }), 70);
});

test('the picker and the layer: the three sections, the framing plate in the seat plate\'s shape, the store wiring', () => {
  const js = src('public/js/ui/namecards.js');
  assert.match(js, /useData\('assets', 'local'\)/, 'both manifests are on the page');
  for (const key of ['模拟场景', '阵营徽记', '组织徽记', '不使用底图', '上下拖动调整显示范围', '恢复默认', '完成']) {
    assert.ok(js.includes(key), key);
  }
  // a picture is picked first, then framed; an emblem has nothing to crop and closes
  assert.match(js, /adjustable\(namecardOf\(id\)\)\) setAdjusting\(true\)/);
  assert.match(js, /const adjustable = \(nc\) => !!nc && nc\.kind !== 'camp';/);
  assert.match(js, /aspect-ratio|nc-adjust__plate has-nc/);
  // the layer: a CSS background behind a `.has-nc` plate, no <img> to fail
  assert.match(js, /class=\$\{`nc-layer nc-layer--\$\{nc\.kind\}`\}/);
  assert.match(js, /--nc:url\("\$\{src\}"\)/);
  assert.doesNotMatch(js, /<img[^>]*nc-layer/, 'the picture is a background, so a missing file is no broken image');

  // room.css: the layer, the emblem's placement, the picker and the framing plate
  const css = src('public/css/screens/room.css');
  for (const cls of ['.has-nc', '.nc-layer', '.nc-layer--camp', '.nc-pick', '.nc-pick__grid', '.nc-adjust__plate', '.rseat__bg', '.rseat__ava']) {
    assert.ok(css.includes(cls), cls);
  }
  assert.match(css, /\.nc-adjust__plate \{[^}]*aspect-ratio: 9 \/ 2;/, 'the preview is the seat plate\'s shape');

  // the room puts the layer behind its seat plate and opens the picker from one's own plate
  const room = src('public/js/screens/room.js');
  assert.match(room, /class=\$\{`rseat__plate\$\{bg \? ' has-nc' : ''\}`\}/);
  assert.match(room, /<\$\{NameCardLayer\} card=\$\{bg\} y=\$\{bgY\} \/>/);
  assert.match(room, /onPickBg=\$\{\(\) => setPicking\('bg'\)\}/);
  // the sync sends the background and its framing (ui/loadoutSync.js installCardSync)
  const sync = src('public/js/ui/loadoutSync.js');
  assert.match(sync, /CARD_BG_KEY, CARD_BG_Y_KEY/);
  assert.match(sync, /bg,\n\s+bgY,/);
});
