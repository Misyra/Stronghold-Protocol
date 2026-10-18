// 干员皮肤 (docs/SKINS.md) on the wire: `room.skins { choices }` — one entry per OPERATOR.
//
// 来源: Stardust-minus/Stronghold-Protocol @ fab1b97 shared/protocol.js + their test/operator-skins-ui.test.js. The gate is
// the CATALOGUE (shared/skin-catalogue.js via shared/skins.js isSkinChoices), not a shape check: a skin id belongs to one
// operator and only that operator's entry may name it, so a made-up id or a cross-operator pair is refused whole.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSkinId, isSkinSelection, validateC2S, SKIN_LIMITS } from '../shared/protocol.js';
import { isSkinChoices, skinFor, skinsFor } from '../shared/skins.js';

const ANGEL = 'char_103_angel';
const ANGEL_WILD = 'char_103_angel_wild_1';     // 能天使 · 野地秘行
const INSIDE = 'char_498_inside';
const INSIDE_KITCHEN = 'char_498_inside_kitchen_2'; // 隐现 · 甜品大奖

describe('skins: isSkinId', () => {
  test('accepts the ids the catalogue actually carries', () => {
    for (const id of [ANGEL_WILD, INSIDE_KITCHEN, 'char_002_amiya_winter_1', 'char_1039_thorn2_marthe_9']) {
      assert.ok(isSkinId(id), `should accept ${id}`);
    }
  });

  test('accepts the official (@#) form too — a browser preference saved before the catalogue was a code module holds it', () => {
    for (const id of ['char_002_amiya@winter#1', 'char_498_inside@kitchen#2', 'char_002_amiya#1+']) {
      assert.ok(isSkinId(id), `should accept ${id}`);
    }
  });

  test('rejects what a client should not be able to send', () => {
    for (const bad of ['', ' ', 'a b', 'char/1', 'char\\1', '<script>', 'x'.repeat(SKIN_LIMITS.idLen + 1), 42, null, undefined, {}, []]) {
      assert.ok(!isSkinId(bad), `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('skins: the catalogue binding', () => {
  test('a skin resolves for its own operator only', () => {
    assert.equal(skinFor(ANGEL, ANGEL_WILD)?.id, ANGEL_WILD);
    assert.equal(skinFor(INSIDE, ANGEL_WILD), null, 'another operator\'s outfit is not a choice');
    assert.equal(skinFor(ANGEL, 'char_103_angel@wild#1'), null, 'the official id is not a catalogue id');
  });

  test('an operator lists its outfits', () => {
    assert.ok(skinsFor(ANGEL).length >= 2);
    assert.ok(skinsFor(ANGEL).every((s) => s.charId === ANGEL));
    assert.deepEqual(skinsFor('char_no_such_operator'), []);
  });
});

describe('skins: isSkinChoices (the wire gate)', () => {
  test('accepts one entry per operator, and the empty map', () => {
    assert.ok(isSkinChoices({ [ANGEL]: ANGEL_WILD }));
    assert.ok(isSkinChoices({ [ANGEL]: ANGEL_WILD, [INSIDE]: INSIDE_KITCHEN }));
    assert.ok(isSkinChoices({}), 'an empty map restores the default models');
  });

  test('refuses a key that is not an operator charId', () => {
    for (const bad of [null, [], 'x', { chess_char_1_01_a: ANGEL_WILD }, { 'char_103_angel@wild#1': ANGEL_WILD }]) {
      assert.equal(isSkinChoices(bad), false, JSON.stringify(bad));
    }
  });

  test('refuses a value that is not one of THAT operator\'s outfits', () => {
    assert.equal(isSkinChoices({ [ANGEL]: INSIDE_KITCHEN }), false, 'cross-operator');
    assert.equal(isSkinChoices({ [ANGEL]: 'char_103_angel@wild#1' }), false, 'the official id is not a catalogue id');
    assert.equal(isSkinChoices({ [ANGEL]: 'char_999_made_up#1' }), false);
    assert.equal(isSkinChoices({ [ANGEL]: '' }), false);
    assert.equal(isSkinChoices({ [ANGEL]: 42 }), false);
  });

  test('refuses one entry too many', () => {
    const big = {};
    for (let i = 0; i <= SKIN_LIMITS.choices; i++) big[`char_${i}_x`] = ANGEL_WILD;
    assert.equal(isSkinChoices(big), false, `more than ${SKIN_LIMITS.choices} entries`);
  });
});

describe('skins: isSkinSelection (shape only, no catalogue)', () => {
  test('accepts any charId → skinId map within the bound', () => {
    assert.ok(isSkinSelection({ [ANGEL]: ANGEL_WILD }));
    assert.ok(isSkinSelection({ [ANGEL]: 'char_999_made_up#1' }), 'shape only: the catalogue is isSkinChoices');
    assert.ok(isSkinSelection({}));
  });

  test('rejects the wrong shapes', () => {
    assert.ok(!isSkinSelection(null));
    assert.ok(!isSkinSelection([]));
    assert.ok(!isSkinSelection({ [ANGEL]: '' }));
    assert.ok(!isSkinSelection({ [ANGEL]: 'bad id' }));
    assert.ok(!isSkinSelection({ [ANGEL]: 42 }));
    assert.ok(!isSkinSelection({ chess_char_1_01_a: ANGEL_WILD }), 'the key is an operator charId');
    const big = {};
    for (let i = 0; i <= SKIN_LIMITS.entries; i++) big[`char_${i}_x`] = ANGEL_WILD;
    assert.ok(!isSkinSelection(big), `more than ${SKIN_LIMITS.entries} entries`);
  });
});

describe('skins: validateC2S', () => {
  test('room.skins passes with a catalogue choice', () => {
    assert.equal(validateC2S({ t: 'room.skins', choices: { [ANGEL]: ANGEL_WILD } }), null);
    assert.equal(validateC2S({ t: 'room.skins', choices: {} }), null);
  });

  test('room.skins is refused when the payload is not a catalogue selection', () => {
    assert.ok(validateC2S({ t: 'room.skins' }), 'missing field');
    assert.ok(validateC2S({ t: 'room.skins', choices: ANGEL_WILD }), 'not a map');
    assert.ok(validateC2S({ t: 'room.skins', choices: { [ANGEL]: 'has space' } }), 'bad skin id');
    assert.ok(validateC2S({ t: 'room.skins', choices: { [ANGEL]: INSIDE_KITCHEN } }), 'another operator\'s outfit');
  });

  test('the old chess-keyed field name is gone', () => {
    assert.ok(validateC2S({ t: 'room.skins', skins: { [ANGEL]: ANGEL_WILD } }), '`skins` is no longer a field');
  });

  test('there is no install message any more', () => {
    assert.ok(validateC2S({ t: 'room.skin.install', skinId: ANGEL_WILD }), 'unknown type');
  });
});
