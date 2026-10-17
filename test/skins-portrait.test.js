// 干员皮肤 — ported from sganggs/Stronghold-Protocol PR #652 (https://github.com/sganggs/Stronghold-Protocol/pull/652, upstream 0.2.7-dev); this fork's adaptations are listed in custom_docs/SKINS.md.
// test/skins-portrait.test.js — 商店立绘 (custom_docs/SKINS.md): the shop card's portrait, chosen in 干员调配 next to the battle
// model (whose own test is test/skins.test.js / test/skins-lifecycle.test.js).
//
// Three things are worth pinning, because each is a place the feature can silently do nothing:
//   * the resolution — a chosen skin must resolve through its OPERATOR (`chars[charId].skins[skinId].portrait`), and
//     must return null (so the card falls back to `chessPortraitUrl`) when nothing is chosen or the skin is unknown;
//   * choosing an outfit on EITHER row applies it to both (this fork: otherwise the same choice has to be made twice),
//     while 原始立绘 / 精英二立绘 restore the default battle model;
//   * the art lives in its own LOCAL preference and never touches the synced `entries` map.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skinPortraitUrl, chessPortraitUrl, chessOwnPortraitUrl, shopPortraitUrl, PORTRAIT_E2 } from '../public/js/ui/assetUrls.js';
import { skinsStore, setPortrait, clearPortrait, portraitFor, setSkin, clearSkin, skinFor, setSkins, setPortraits, equippedSkinKeys, PORTRAITS_PREF, SKINS_PREF } from '../public/js/ui/skins.js';
import { data } from '../public/js/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHESS = 'chess_char_1_01_a';           // 隐现 char_498_inside 的基础 chess
const OTHER = 'chess_char_2_01_a';
const SKIN = 'char_498_inside@kitchen#2';

/** The real catalogue, keyed by operator (data/skins.json). */
const CATALOGUE = JSON.parse(readFileSync(path.join(ROOT, 'data', 'skins.json'), 'utf8'));

/** A manifest shaped like data/assets.json, with one installed skin that ships a 立绘 and one that does not. */
const MANIFEST = {
  chars: {
    char_498_inside: {
      portrait: '/assets/char/portrait/char_498_inside_1.png',
      portraitE2: '/assets/char/portrait/char_498_inside_2.png',
      skins: {
        [SKIN]: { name: '甜品大奖', group: '罗德厨房/II', avatar: '/assets/char/avatar/skin/a.png', portrait: '/assets/char/portrait/skin/a.png' },
        'char_498_inside@summer#22': { name: '悠然假日', group: '珊瑚海岸/XXII', avatar: '/assets/char/avatar/skin/b.png' },
      },
    },
    // a 1★/2★ operator: no 精英二 art at all — the picker must not offer a second tile that draws the same image
    char_123_lowstar: { portrait: '/assets/char/portrait/char_123_lowstar_1.png' },
  },
};
const chess = { chessId: CHESS, charId: 'char_498_inside' };
const lowstar = { chessId: 'chess_char_3_01_a', charId: 'char_123_lowstar' };

describe('商店立绘: resolution', () => {
  test('an installed skin resolves to its 180×360 立绘', () => {
    assert.equal(skinPortraitUrl(MANIFEST, chess, SKIN), '/assets/char/portrait/skin/a.png');
  });

  test('the two own 立绘 resolve to the operator\'s _1 / _2 art', () => {
    assert.equal(chessOwnPortraitUrl(MANIFEST, chess, false), '/assets/char/portrait/char_498_inside_1.png');
    assert.equal(chessOwnPortraitUrl(MANIFEST, chess, true), '/assets/char/portrait/char_498_inside_2.png');
    assert.equal(chessOwnPortraitUrl(MANIFEST, lowstar, true), '/assets/char/portrait/char_123_lowstar_1.png',
      'no 精英二 art → the 原始 one (the picker hides the second tile then)');
    assert.equal(chessOwnPortraitUrl(MANIFEST, { chessId: 'x' }, false), null, 'a record without charId');
  });

  test('shopPortraitUrl: no choice keeps the old behaviour, 精英二 and a skin override it, junk falls back', () => {
    assert.equal(shopPortraitUrl(MANIFEST, chess, null), chessPortraitUrl(MANIFEST, chess), 'absent = what the card always showed');
    assert.equal(shopPortraitUrl(MANIFEST, chess, PORTRAIT_E2), '/assets/char/portrait/char_498_inside_2.png');
    assert.equal(shopPortraitUrl(MANIFEST, chess, SKIN), '/assets/char/portrait/skin/a.png');
    assert.equal(shopPortraitUrl(MANIFEST, chess, 'char_498_inside@summer#22'), chessPortraitUrl(MANIFEST, chess),
      'a skin without a 立绘 → the operator\'s own');
    assert.equal(shopPortraitUrl(MANIFEST, chess, 'char_002_amiya@winter#1'), chessPortraitUrl(MANIFEST, chess),
      'a skin of another operator → the operator\'s own');
    assert.equal(shopPortraitUrl(MANIFEST, chess, 'garbage'), chessPortraitUrl(MANIFEST, chess), 'an unknown value → the operator\'s own');
    assert.ok(chessPortraitUrl(MANIFEST, chess), 'and that fallback is never null when the manifest has the art');
  });

  test('the 精英二 sentinel cannot collide with a real skinId (every id in the catalogue starts with char_)', () => {
    assert.equal(PORTRAIT_E2, 'e2');
    assert.ok(!PORTRAIT_E2.startsWith('char_'));
    for (const list of Object.values(CATALOGUE.chars)) for (const s of list) assert.ok(s.id.startsWith('char_'), s.id);
  });

  test('no choice, an unknown skin, a skin without a 立绘 or a non-chess record → null (the card falls back)', () => {
    assert.equal(skinPortraitUrl(MANIFEST, chess, null), null);
    assert.equal(skinPortraitUrl(MANIFEST, chess, ''), null);
    assert.equal(skinPortraitUrl(MANIFEST, chess, 'char_498_inside@summer#22'), null, 'installed but ships no 立绘');
    assert.equal(skinPortraitUrl(MANIFEST, chess, 'char_002_amiya@winter#1'), null, 'another operator\'s skin');
    assert.equal(skinPortraitUrl(MANIFEST, { chessId: CHESS }, SKIN), null, 'no charId on the record');
    assert.equal(skinPortraitUrl(null, chess, SKIN), null, 'no manifest yet');
  });

  test('the operator\'s own portrait is what the card shows without a choice', () => {
    assert.equal(chessPortraitUrl(MANIFEST, chess), '/assets/char/portrait/char_498_inside_1.png');
  });
});

describe('商店立绘: one pick sets both rows, original art restores the default model', () => {
  test('choosing an outfit on either row applies it to both', () => {
    setSkin(CHESS, SKIN);
    assert.equal(portraitFor(CHESS), SKIN, 'the shop card follows the battle model — no second pick');
    setPortrait(OTHER, SKIN);
    assert.equal(skinFor(OTHER), SKIN, 'picking an outfit as shop art sets the battle model too');
    clearSkin(CHESS);
    assert.equal(portraitFor(CHESS), SKIN, 'clearing the model leaves an explicitly chosen art alone');
    clearPortrait(CHESS);
    clearSkin(OTHER);
    clearPortrait(OTHER);
  });

  test('原始立绘 and 精英二立绘 restore the default battle model', () => {
    setSkin(CHESS, SKIN);
    setPortrait(CHESS, PORTRAIT_E2);
    assert.equal(portraitFor(CHESS), PORTRAIT_E2);
    assert.equal(skinFor(CHESS), null, '精英二 restores the default model');
    setSkin(CHESS, SKIN);
    clearPortrait(CHESS);
    assert.equal(portraitFor(CHESS), null);
    assert.equal(skinFor(CHESS), null, '原始立绘 restores the default model');
    setSkin(CHESS, SKIN);
    setPortrait(CHESS, '');
    assert.equal(skinFor(CHESS), null, 'the empty original-art selection behaves the same way');
  });

  test('the bulk writers own one map each (the roster sync must not rewrite local art)', () => {
    setSkins({ [CHESS]: 'char_498_inside@kitchen#2' });
    assert.equal(skinFor(CHESS), 'char_498_inside@kitchen#2');
    assert.equal(portraitFor(CHESS), null, 'a synced roster entry does not move the shop art');
    setPortraits({ [CHESS]: SKIN });
    assert.equal(skinFor(CHESS), 'char_498_inside@kitchen#2', 'and the art does not move the model');
    assert.equal(portraitFor(CHESS), SKIN);
    setSkins({});
    setPortraits({});
  });

  test('per chess id, and an empty map is not persisted as junk', () => {
    setPortrait(CHESS, SKIN);
    setPortrait(OTHER, SKIN);
    assert.equal(portraitFor(CHESS), SKIN);
    assert.equal(portraitFor(OTHER), SKIN);
    clearPortrait(CHESS);
    clearPortrait(OTHER);
    clearSkin(CHESS);
    clearSkin(OTHER);
    assert.deepEqual(skinsStore.get().portraits, {}, 'both cleared');
    assert.equal(skinsStore.get().entries && typeof skinsStore.get().entries, 'object', 'the synced map is still a map');
    assert.notEqual(PORTRAITS_PREF, SKINS_PREF, 'the shop art has its own preference (never synced as `entries`)');
  });

  test('the 精英二 and 原始 choices survive the store (only an empty value means "the operator\'s own")', () => {
    setPortrait(CHESS, PORTRAIT_E2);
    assert.equal(portraitFor(CHESS), PORTRAIT_E2, 'the sentinel is stored as-is, not dropped as falsy');
    // 原始立绘 is the absence of a choice: the picker clears rather than writes '' (ui/skins.js drops empty values)
    clearPortrait(CHESS);
    assert.equal(portraitFor(CHESS), null);
    assert.equal(shopPortraitUrl(MANIFEST, chess, portraitFor(CHESS)), '/assets/char/portrait/char_498_inside_1.png');
  });
});

describe('干员皮肤预载: which outfits the preload follows', () => {
  test('both rows count, and the art-only values add nothing', (t) => {
    // The preload is keyed by `<charId>/<skinId>` while a choice is stored per chess, so `equippedSkinKeys()` reads the
    // chess table; the real one is not loaded in a unit test, and the mapping itself is not what this pins.
    const lookup = data.lookup.bind(data);
    data.lookup = (name, id) => (name === 'chess' ? { charId: id === CHESS ? 'char_498_inside' : 'char_1012_skadi2' } : lookup(name, id));
    t.after(() => { data.lookup = lookup; });

    // 「默认模型 + 某套立绘」 — reachable by picking the outfit as art and then clearing the model.
    setPortrait(CHESS, 'char_498_inside@summer#22');
    clearSkin(CHESS);
    assert.deepEqual(equippedSkinKeys(), ['char_498_inside/char_498_inside@summer#22'], 'an art-only outfit is wanted');

    setPortrait(CHESS, PORTRAIT_E2);
    assert.deepEqual(equippedSkinKeys(), [], '精英二 is not an outfit — nothing to download');

    setSkin(CHESS, SKIN);
    setSkin(OTHER, SKIN);
    assert.deepEqual(equippedSkinKeys(), ['char_1012_skadi2/char_498_inside@kitchen#2', 'char_498_inside/char_498_inside@kitchen#2'], 'one key per operator, both rows merged');

    clearSkin(CHESS); clearSkin(OTHER); clearPortrait(CHESS); clearPortrait(OTHER);
    assert.deepEqual(equippedSkinKeys(), []);
  });
});

describe('商店立绘: the catalogue it is chosen from', () => {
  test('data/skins.json lists every skin per operator, with the ids data/assets.json groups installed ones under', () => {
    assert.ok(CATALOGUE.chars && typeof CATALOGUE.chars === 'object');
    assert.equal(CATALOGUE.counts.chars, Object.keys(CATALOGUE.chars).length);
    assert.ok(CATALOGUE.counts.skins > 0);
    const list = CATALOGUE.chars.char_498_inside;
    assert.ok(Array.isArray(list) && list.length >= 2, '隐现 has skins in the catalogue');
    const one = list.find((x) => x.id === SKIN);
    assert.ok(one, 'the installed skin is in the catalogue');
    assert.equal(one.name, '甜品大奖');
    for (const s of list) assert.match(s.id, /^[A-Za-z0-9_@#+.\-]+$/, `${s.id} is a legal skinId (shared/protocol.js isSkinId)`);
  });
});
