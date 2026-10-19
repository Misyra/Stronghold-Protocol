// test/skins-portrait.test.js — 商店立绘 (docs/SKINS.md): the shop card's portrait, chosen in 干员调配 next to the battle
// model (whose own tests are test/skins.test.js / test/skins-lifecycle.test.js).
//
// Three things are worth pinning, because each is a place the feature can silently do nothing:
//   * the resolution — a chosen skin must resolve through its OPERATOR (`chars[charId].skins[skinId].portrait`), and
//     must return null (so the card falls back to `chessPortraitUrl`) when nothing is chosen or the skin is unknown;
//   * choosing an outfit on EITHER row applies it to both (this fork: otherwise the same choice has to be made twice),
//     while 原始立绘 / 精英二立绘 restore the default battle model;
//   * the art lives in its own LOCAL preference and never touches the synced `entries` map.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skinPortraitUrl, chessPortraitUrl, chessOwnPortraitUrl, shopPortraitUrl, PORTRAIT_E2 } from '../public/js/ui/assetUrls.js';
import { skinsStore, setPortrait, clearPortrait, portraitFor, setSkin, clearSkin, skinFor, setSkins, setPortraits, equippedSkinKeys, PORTRAITS_PREF, SKINS_PREF } from '../public/js/ui/skins.js';
import { data } from '../public/js/data.js';
import { OPERATOR_SKINS, isSkinId } from '../shared/skins.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const CHESS = 'chess_char_1_01_a';           // 隐现 char_498_inside 的基础 chess
const OTHER = 'chess_char_2_01_a';
const SKIN = 'char_498_inside_kitchen_2';        // 甜品大奖, the CATALOGUE id — what a choice holds now
const SKIN_OFFICIAL = 'char_498_inside@kitchen#2'; // the same outfit as the asset manifest keys it

/** A manifest shaped like data/assets.json, with one installed skin that ships a 立绘 and one that does not. */
const MANIFEST = {
  chars: {
    char_498_inside: {
      portrait: '/assets/char/portrait/char_498_inside_1.png',
      portraitE2: '/assets/char/portrait/char_498_inside_2.png',
      skins: {
        [SKIN_OFFICIAL]: { name: '甜品大奖', group: '罗德厨房/II', avatar: '/assets/char/avatar/skin/a.png', portrait: '/assets/char/portrait/skin/a.png' },
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
  test('an installed skin resolves to its 180×360 立绘, whichever id form names it', () => {
    assert.equal(skinPortraitUrl(MANIFEST, chess, SKIN), '/assets/char/portrait/skin/a.png');
    assert.equal(skinPortraitUrl(MANIFEST, chess, SKIN_OFFICIAL), '/assets/char/portrait/skin/a.png');
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

  test('the 精英二 sentinel cannot collide with a real skin id (every id in the catalogue starts with char_)', () => {
    assert.equal(PORTRAIT_E2, 'e2');
    assert.ok(!PORTRAIT_E2.startsWith('char_'));
    for (const s of OPERATOR_SKINS) {
      assert.ok(s.id.startsWith('char_'), s.id);
      assert.ok(isSkinId(s.id) && isSkinId(s.officialId), s.id);
    }
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
    setPortrait(CHESS, 'char_498_inside_summer_22');
    clearSkin(CHESS);
    assert.deepEqual(equippedSkinKeys(), ['char_498_inside/char_498_inside@summer#22'], 'an art-only outfit is wanted (official-id key)');

    setPortrait(CHESS, PORTRAIT_E2);
    assert.deepEqual(equippedSkinKeys(), [], '精英二 is not an outfit — nothing to download');

    setSkin(CHESS, SKIN);
    setSkin(OTHER, SKIN);
    assert.deepEqual(equippedSkinKeys(), ['char_1012_skadi2/char_498_inside@kitchen#2', 'char_498_inside/char_498_inside@kitchen#2'],
      'one key per operator, both rows merged, and the key names the official id the manifest carries');

    clearSkin(CHESS); clearSkin(OTHER); clearPortrait(CHESS); clearPortrait(OTHER);
    assert.deepEqual(equippedSkinKeys(), []);
  });
});

describe('商店立绘: the catalogue it is chosen from', () => {
  test('shared/skin-catalogue.js holds every outfit per operator, with both id forms the pipeline needs', () => {
    assert.ok(OPERATOR_SKINS.length > 200, `${OPERATOR_SKINS.length} outfits`);
    const list = OPERATOR_SKINS.filter((x) => x.charId === 'char_498_inside');
    assert.ok(list.length >= 2, '隐现 has outfits in the catalogue');
    const one = list.find((x) => x.id === SKIN);
    assert.ok(one, 'the installed outfit is in the catalogue');
    assert.equal(one.name, '甜品大奖');
    assert.equal(one.officialId, SKIN_OFFICIAL, 'and it names the official id data/assets.json is keyed by');
  });
});

// 干员调配 must draw the choice it just made. Two ways this can silently do nothing: the card keeps calling
// `chessPortraitUrl` (the operator's own art, whatever is chosen), or nothing re-renders it — a pick writes the store,
// and only a subscriber of that store sees it. So both halves are pinned: the call site resolves through
// `shopPortraitUrl(m, chess, chose)`, and it is fed by `usePortraitPick` (a re-render on the choice, not a `.get()`).
describe('干员调配: the art follows the 皮肤 choice', () => {
  const loadoutSrc = read('public/js/screens/loadout.js');
  const diySrc = read('public/js/screens/diy.js');
  const pickerSrc = read('public/js/ui/skinPicker.js');
  const count = (hay, needle) => hay.split(needle).length - 1;

  test('the deck card and the detail header both resolve through the choice', () => {
    assert.equal(count(loadoutSrc, 'shopPortraitUrl(m, '), 2,
      'the deck card and the detail header — one call site each');
    assert.equal(count(loadoutSrc, 'shopPortraitUrl(m, chess, portraitPick)'), 1, 'the deck card passes the choice');
    assert.equal(count(loadoutSrc, 'shopPortraitUrl(m, golden || chess, portraitPick)'), 1, 'so does the detail header');
    assert.equal(count(loadoutSrc, 'usePortraitPick(chess'), 2, 'both subscribe, so a pick repaints them');
    assert.equal(count(loadoutSrc, 'chessPortraitUrl(m, chess'), 0, 'no call site keeps the unskinned art');
  });

  test('the composition is the whole story: chosen outfit → its 立绘, cleared → the operator\'s own', () => {
    setPortrait(CHESS, SKIN);
    assert.equal(shopPortraitUrl(MANIFEST, chess, portraitFor(CHESS)), '/assets/char/portrait/skin/a.png');
    clearPortrait(CHESS);
    assert.equal(shopPortraitUrl(MANIFEST, chess, portraitFor(CHESS)), '/assets/char/portrait/char_498_inside_1.png');
    setSkin(CHESS, SKIN); clearSkin(CHESS); // the model row is the synced one, untouched by the art
  });

  test('自选 draws the same art, and a pick there redraws the tab', () => {
    assert.ok(diySrc.includes('portraitFor(rec?.chessId)'), 'the slot card reads the choice');
    assert.equal(count(diySrc, 'shopPortraitUrl(m, elite || rec, portraitPick)'), 1, 'and draws it');
    assert.ok(diySrc.includes('onChange=${onSkinChange}'), 'the 皮肤 panel reports a pick to the tab');
    assert.ok(pickerSrc.includes('onChange?.(chessId)'), 'which is a callback the panel may or may not be given');
    // no hook can live down there: the tests draw DiyPanelView's helpers directly, outside a dispatcher
    assert.ok(!diySrc.includes('usePortraitPick'), 'the slot card must not reach for a hook');
  });
});
