// test/ui/op-picker.test.js — the unified operator picker (public/js/ui/opPicker.js, 移植自用户分支, feedback
// #9 / #24 / #100): the pure look rules of ui/seatArt.js it is built on (lookUrl / lookOptions / cardAvatarUrl /
// officialAvatars), the look pick's local store (cardStore cardLook — B 的 room.card 不含 look, 只在本地), the
// picker module's wiring of both entries (screens/room.js 更换立绘, ui/accounts.js 更换头像) by source assertions
// (the picker is hook-driven: no Node render, as ui/skinPicker.js), and the 官方头像 page's graceful degradation
// while the art manifest has no playerAvatar entries (B 的 data/assets.json 现状, 本机 public/assets 也没有这些文件).
// The browser: test/ui/room-cards.e2e.test.js; the card rules: test/ui/seat-art.test.js.
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_KEY, CARD_LOOK_KEY, CARD_LOOK_PREF, cardStore, setCardLook, parseStoredLook,
  lookUrl, lookOptions, cardAvatarUrl, officialAvatars,
} from '../../public/js/ui/seatArt.js';

const ASSETS = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));
const WITH_E2 = 'char_1012_skadi2'; // 浊心斯卡蒂: 精二画 + 精一画 + two skins with portraits (data/assets.json)
const SKIN = 'char_1012_skadi2@boc#4';
const SKIN2 = 'char_1012_skadi2@iteration#2';
// a manifest entry with a base picture but no 精二 one (1★/2★ have none)
const NO_E2 = Object.keys(ASSETS.chars).find((id) => ASSETS.chars[id].portrait && !ASSETS.chars[id].portraitE2);
const src = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const PICKER_SRC = src('public/js/ui/opPicker.js');
const ROOM_SRC = src('public/js/screens/room.js');
const ACCOUNTS_SRC = src('public/js/ui/accounts.js');

describe('ui/seatArt.js look helpers (the picker 外观行)', () => {
  test('lookOptions: 默认, 精二, 精一, then the skins that have the kind\'s art', () => {
    const opts = lookOptions(ASSETS, WITH_E2, 'portrait');
    assert.deepEqual(opts.map((o) => o.id), ['', 'e2', 'e1', SKIN, SKIN2]);
    assert.equal(opts[0].src, ASSETS.chars[WITH_E2].portraitE2, '默认 shows the 精二 art when the entry has one');
    assert.equal(opts[1].src, ASSETS.chars[WITH_E2].portraitE2);
    assert.equal(opts[2].src, ASSETS.chars[WITH_E2].portrait);
    const skin = opts.find((o) => o.id === SKIN);
    assert.equal(skin.skin, true, 'a skin option is marked');
    assert.equal(skin.name, '升华', 'the skin\'s own name');
    assert.equal(skin.src, ASSETS.chars[WITH_E2].skins[SKIN].portrait);
    // a skin without the kind's art is not offered for that kind
    const av = lookOptions(ASSETS, WITH_E2, 'avatar');
    assert.ok(av.every((o) => o.src), `avatar looks all have art: ${JSON.stringify(av)}`);
  });

  test('lookOptions: an entry without a 精二 picture offers no e2/e1 options; junk in is no crash', () => {
    const opts = lookOptions(ASSETS, NO_E2, 'portrait');
    assert.ok(!opts.some((o) => o.id === 'e2' || o.id === 'e1'), JSON.stringify(opts.map((o) => o.id)));
    assert.equal(opts[0].id, '');
    assert.equal(opts[0].src, ASSETS.chars[NO_E2].portrait, '默认 is the base art then');
    assert.deepEqual(lookOptions(ASSETS, 'char_999_ghost', 'portrait'), [], 'unknown charId');
    assert.deepEqual(lookOptions(null, WITH_E2, 'portrait'), []);
    assert.deepEqual(lookOptions({}, null, 'portrait'), []);
  });

  test('lookUrl: e2 / e1 / a skin of that operator; \'\' is no look (the caller\'s default art), unknown is null', () => {
    const c = ASSETS.chars[WITH_E2];
    assert.equal(lookUrl(ASSETS, WITH_E2, 'e2', 'portrait'), c.portraitE2);
    assert.equal(lookUrl(ASSETS, WITH_E2, 'e1', 'portrait'), c.portrait);
    assert.equal(lookUrl(ASSETS, WITH_E2, SKIN, 'portrait'), c.skins[SKIN].portrait);
    assert.equal(lookUrl(ASSETS, WITH_E2, '', 'portrait'), null, 'no look: the caller keeps its default');
    assert.equal(lookUrl(ASSETS, WITH_E2, 'char_999_ghost@nope#1', 'portrait'), null, 'a skin of another operator');
    assert.equal(lookUrl(ASSETS, 'char_999_ghost', 'e2', 'portrait'), null);
    assert.equal(lookUrl(null, WITH_E2, 'e2', 'portrait'), null);
    // the avatar kind resolves the entry's E2 avatar first
    assert.equal(lookUrl(ASSETS, WITH_E2, 'e2', 'avatar'), c.avatarE2 || c.avatar);
    // a skin id is normalized through manifestSkinKey (shared/skins.js)
    assert.equal(lookUrl(ASSETS, WITH_E2, SKIN, 'avatar'), c.skins[SKIN].avatar || c.skins[SKIN].avatarE2 || null);
  });

  test('cardAvatarUrl: the 精二 avatar when the entry has one, else the base one', () => {
    assert.equal(cardAvatarUrl(WITH_E2, ASSETS), ASSETS.chars[WITH_E2].avatarE2 || ASSETS.chars[WITH_E2].avatar);
    assert.equal(cardAvatarUrl(NO_E2, ASSETS), ASSETS.chars[NO_E2].avatar);
    assert.equal(cardAvatarUrl('char_999_ghost', ASSETS), null);
    assert.equal(cardAvatarUrl('', ASSETS), null);
    assert.equal(cardAvatarUrl(WITH_E2, ASSETS, 'e1'), ASSETS.chars[WITH_E2].avatar, 'a look goes through lookUrl');
  });
});

describe('官方玩家头像 (feedback #100) and its graceful degradation', () => {
  test('the real manifest has no playerAvatar entries: officialAvatars is [] (the second page stays hidden)', () => {
    assert.deepEqual(officialAvatars(ASSETS), []);
    assert.equal(Object.keys(ASSETS.ui).some((k) => k.startsWith('playerAvatar/')), false,
      'data/assets.json keeps no playerAvatar/* entries');
  });

  test('a manifest with playerAvatar entries groups them (activity / special / def / dyn), numeric id order', () => {
    const m = { ui: {
      'playerAvatar/avatar_activity_10': 'a10', 'playerAvatar/avatar_activity_2': 'a2',
      'playerAvatar/avatar_def_1': 'd1', 'playerAvatar/avatar_dyn_3': 'y3', 'other/key': 'x',
    } };
    const groups = officialAvatars(m);
    assert.deepEqual(groups.map((g) => g.key), ['activity', 'def', 'dyn'], 'empty groups are dropped');
    const act = groups[0];
    assert.deepEqual(act.items.map((a) => a.id), ['avatar_activity_2', 'avatar_activity_10'], 'numeric order');
    assert.deepEqual(act.items.map((a) => a.src), ['a2', 'a10']);
    assert.deepEqual(officialAvatars(null), []);
  });

  test('opPicker hides the 官方头像 tab while the groups are empty (resource missing: degrade, not break)', () => {
    assert.match(PICKER_SRC, /groups\.length \? html`<div class="cardpick__tabs"/, 'the tab row is guarded');
    assert.match(PICKER_SRC, /const body = official \? html`/, 'the official grid only renders on the tab');
  });

  test('the client extraction joins the manifest entries (data/local-assets.json group ui/playerAvatar, local wins)', () => {
    // tools/local-extract writes spritepack/ui_player_avatar_list_h2_0.ab into public/assets/local/ui/playerAvatar;
    // callers pass data/local-assets.json `groups` (the map, as accounts.js does)
    const local = { 'ui/playerAvatar': {
      avatar_activity_AC: { path: '/assets/local/ui/playerAvatar/avatar_activity_AC.png' },
      avatar_def_02: { path: '/assets/local/ui/playerAvatar/avatar_def_02.png' },
    } };
    const groups = officialAvatars({ ui: { 'playerAvatar/avatar_activity_AC': '/web/a.png' } }, local);
    assert.deepEqual(groups.map((g) => g.key), ['activity', 'def'], 'both sources merge, local first');
    assert.deepEqual(groups[0].items, [{
      id: 'avatar_activity_AC', src: '/assets/local/ui/playerAvatar/avatar_activity_AC.png',
    }], 'the local file replaced the mirror copy of the same avatar');
    assert.deepEqual(groups[1].items.map((a) => a.id), ['avatar_def_02'], 'an avatar only the extraction has still shows');
    // a group the extraction left out, a garbage entry: ignored, no throw
    assert.deepEqual(officialAvatars(null, { 'ui/playerAvatar': { bogus: { path: 42 } } }), []);
    assert.deepEqual(officialAvatars(null, undefined), []);
  });
});

describe('the look pick\'s local store (cardStore cardLook)', () => {
  test('setCardLook persists a look and leaves the card pick alone; 默认 clears it', () => {
    const before = cardStore.get()[CARD_KEY];
    setCardLook('e1');
    assert.equal(cardStore.get()[CARD_LOOK_KEY], 'e1');
    assert.equal(cardStore.get()[CARD_KEY], before, 'the room.card pick is untouched');
    assert.equal(parseStoredLook('e2'), 'e2');
    assert.equal(parseStoredLook(7), '');
    setCardLook(SKIN);
    assert.equal(cardStore.get()[CARD_LOOK_KEY], SKIN);
    setCardLook('');
    assert.equal(cardStore.get()[CARD_LOOK_KEY], '', '默认 clears the look');
    assert.equal(CARD_LOOK_PREF, 'room.card.look', 'a new local pref key; room.card itself is unchanged');
  });
});

describe('both entries are wired to the picker (source assertions; the module is hook-driven, no Node render)', () => {
  test('opPicker.js: one OperatorPicker for both, the first tile clears, the LookBar only when there is a choice', () => {
    assert.match(PICKER_SRC, /export function OperatorPicker/);
    assert.match(PICKER_SRC, /export function AvatarPicker/);
    assert.match(PICKER_SRC, /import \{ cardAvatarUrl, lookOptions, lookUrl, officialAvatars \} from '\.\/seatArt\.js';/);
    // 清除格: the auto tile carries data-char="" and picks ''
    assert.match(PICKER_SRC, /data-char="" data-autofocus=\$\{known \? undefined : ''\} title=\$\{autoTitle\} onClick=\$\{\(\) => onPick\(''\)\}/);
    assert.match(PICKER_SRC, /opts\.length < 2\) return null/, 'the look row hides when the operator has one option');
    assert.match(PICKER_SRC, /class="cardpick__looks" role="radiogroup"/);
    assert.match(PICKER_SRC, /lookOptions\(m, charId, looks\.kind\)/);
  });

  test('screens/room.js: 更换立绘 renders OperatorPicker, keeps the look row, and the seat prefers the look', () => {
    assert.match(ROOM_SRC, /import \{ OperatorPicker \} from '\.\.\/ui\/opPicker\.js';/);
    assert.doesNotMatch(ROOM_SRC, /function CardPicker\(/, 'the room\'s own picker is gone');
    assert.match(ROOM_SRC, /<\$\{OperatorPicker\} title=\$\{t\('名片干员'\)\}/);
    assert.match(ROOM_SRC, /looks=\$\{\{ kind: 'portrait', current: myLook, onLook: pickLook \}\}/);
    assert.match(ROOM_SRC, /const pickLook = \(look\) => \{ setCardLook\(look\); setPicking\(false\); \};/);
    // an operator with 外观 keeps the picker open; 默认 or a look closes it
    assert.match(ROOM_SRC, /lookOptions\(data\.get\('assets'\), charId, 'portrait'\)\.length < 2\) setPicking\(false\);/);
    // one's own seat card wears the local look before the outfit / default art
    assert.match(ROOM_SRC, /const lookSrc = op && look \? lookUrl\(data\.get\('assets'\), op\.chess\.charId, look, 'portrait'\) : null;/);
    assert.match(ROOM_SRC, /lookSrc \|\| chessPortraitUrl\(data\.get\('assets'\), op\.chess, \{ skin \}\)/);
    // the pick's store and the room.card upload are unchanged (ui/seatArt.js setCard → installCardSync)
    assert.match(ROOM_SRC, /const pickCard = \(charId\) => \{\s*\n\s*setCard\(charId\);/);
  });

  test('screens/bandDraft.js: the draft\'s name cards wear one\'s own local look too', () => {
    const s = src('/public/js/screens/bandDraft.js');
    assert.match(s, /CARD_LOOK_KEY/);
    assert.match(s, /lookUrl\(data\.get\('assets'\), op\.chess\.charId, look, 'portrait'\)/);
  });

  test('ui/accounts.js: 更换头像 opens AvatarPicker; the pref write stays a picture string in sp.pref.localAccount', () => {
    assert.match(ACCOUNTS_SRC, /import \{ AvatarPicker \} from '\.\/opPicker\.js';/);
    assert.match(ACCOUNTS_SRC, /<\$\{AvatarPicker\} current=\$\{me\.avatar\} list=\$\{cardList\} m=\$\{data\.get\('assets'\)\}/);
    assert.match(ACCOUNTS_SRC, /avatar: url \|\| null/, 'the picker\'s pick lands in the same pref (null = 默认)');
    assert.match(ACCOUNTS_SRC, /squareAvatar/, 'the uploaded file keeps working beside the picker');
    assert.match(ACCOUNTS_SRC, /t\('上传图片'\)/);
  });

  test('css and i18n follow the picker (room.css, the four packs)', () => {
    const css = src('/public/css/screens/room.css');
    for (const cls of ['.cardpick__tabs', '.cardpick__group', '.cardpick__looks', '.cardpick__looks-label', '.cardpick__look']) {
      assert.ok(css.includes(cls), `room.css has ${cls}`);
    }
    for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
      const pack = JSON.parse(readFileSync(new URL(`../../public/i18n/${lang}.json`, import.meta.url), 'utf8'));
      for (const key of ['精英二', '精英一', '外观', '官方头像', '上传图片', '活动头像', '特殊头像', '基础头像', '动态头像',
        '不使用头像：显示名字首字', '头像保存在这台设备的浏览器里，不上传服务器；同盟里的博士看不到它。']) {
        assert.ok(key in pack, `${lang}.json has ${key}`);
      }
    }
  });
});
