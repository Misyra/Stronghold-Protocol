// 干员皮肤 (docs/SKINS.md) on the wire: `room.skins { skins }`.
//
// The shape check is the only gate on the message itself, so it has to be right in both directions: it must
// accept the real skin ids (which carry `@` and `#`, so the generic `isId` would reject them) and it must reject
// the junk a client could send. What it deliberately does NOT do is validate the ids against the game data —
// that happens server-side, and a wrong id is harmless because spineEntry() falls back to the default model.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSkinId, isSkinSelection, validateC2S, SKIN_LIMITS } from '../shared/protocol.js';

describe('skins: isSkinId', () => {
  test('accepts the ids the skin table actually produces', () => {
    for (const id of [
      'char_002_amiya@winter#1',   // a plain skin
      'char_103_angel@kfc#1',
      'char_1039_thorn2@marthe#9',
      'char_498_inside@kitchen#2',
      'char_002_amiya#1+',         // the default outfit's E1 form, which keeps a '+'
    ]) assert.ok(isSkinId(id), `should accept ${id}`);
  });

  test('rejects what a client should not be able to send', () => {
    for (const bad of ['', ' ', 'a b', 'char/1', 'char\\1', '<script>', 'x'.repeat(SKIN_LIMITS.idLen + 1), 42, null, undefined, {}, []]) {
      assert.ok(!isSkinId(bad), `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('skins: isSkinSelection', () => {
  test('accepts a map of chessId → skinId', () => {
    assert.ok(isSkinSelection({ char_103_angel: 'char_103_angel@wild#1' }));
    assert.ok(isSkinSelection({}), 'an empty selection clears the skins');
  });

  test('rejects malformed values and oversized maps', () => {
    assert.ok(!isSkinSelection(null));
    assert.ok(!isSkinSelection([]));
    assert.ok(!isSkinSelection({ char_103_angel: '' }));
    assert.ok(!isSkinSelection({ char_103_angel: 'bad id' }));
    assert.ok(!isSkinSelection({ char_103_angel: 42 }));
    assert.ok(!isSkinSelection({ 'bad chess id': 'char_103_angel@wild#1' }), 'the key is a chess id');
    const big = {};
    for (let i = 0; i <= SKIN_LIMITS.entries; i++) big[`char_${i}_x`] = 'char_1_x@s#1';
    assert.ok(!isSkinSelection(big), `more than ${SKIN_LIMITS.entries} entries`);
  });
});

describe('skins: validateC2S', () => {
  test('room.skins passes with a well-formed payload', () => {
    assert.equal(validateC2S({ t: 'room.skins', skins: { char_103_angel: 'char_103_angel@wild#1' } }), null);
    assert.equal(validateC2S({ t: 'room.skins', skins: {} }), null);
  });

  test('room.skins is refused when the payload is not a selection', () => {
    assert.ok(validateC2S({ t: 'room.skins' }), 'missing field');
    assert.ok(validateC2S({ t: 'room.skins', skins: 'char_103_angel@wild#1' }), 'not a map');
    assert.ok(validateC2S({ t: 'room.skins', skins: { char_103_angel: 'has space' } }), 'bad skin id');
  });
});
