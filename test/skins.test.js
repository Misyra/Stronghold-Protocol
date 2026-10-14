// 干员皮肤 (docs/SKINS.md): the render-side lookup.
//
// spineEntry / hasBackSpine take an optional skinId and fall back to the operator's own model when it is absent or
// not installed. That fallback is what lets a client meet a manifest without the skin, or a teammate who never
// installed one, without breaking — and when a skin IS chosen, the Front/Back decision must be made within that
// skin: falling back to the *operator's* Back model would put the default outfit's back on a skinned unit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spineEntry, hasBackSpine } from '../public/js/assets.js';

/** One direction of a model, exactly the shape docs/ASSETS.md documents for a Spine entry. */
const side = (stem) => ({
  skel: `/assets/spine/op/${stem}/${stem}.skel`,
  atlas: `/assets/spine/op/${stem}/${stem}.atlas`,
  textures: [`/assets/spine/op/${stem}/${stem}.png`],
  pma: false,
  anims: { idle: 'Idle' },
});

/** `chars[id].spine` and `chars[id].skins[k].spine` are both `{ front, back? }`. */
const pair = (stem, { back = true } = {}) => ({ front: side(stem), ...(back ? { back: side(`${stem}_back`) } : {}) });

const MANIFEST = {
  chars: {
    char_103_angel: {
      spine: pair('char_103_angel'),
      skins: {
        // a skin with both directions
        'char_103_angel@wild#1': { name: '野地秘行', group: '生命之地/I', spine: pair('char_103_angel_wild_1') },
        // a skin that ships only a Front
        'char_103_angel@kfc#1': { name: '城市骑手', group: '肯德基', spine: pair('char_103_angel_kfc_1', { back: false }) },
      },
    },
  },
};

const stem = (sp) => (sp && sp.skel ? sp.skel.split('/').pop() : null);

describe('skins: spineEntry', () => {
  test('no skin asked for → the operator\'s own model, as before', () => {
    assert.equal(stem(spineEntry(MANIFEST, 'char_103_angel')), 'char_103_angel.skel');
    assert.equal(stem(spineEntry(MANIFEST, 'char_103_angel', {})), 'char_103_angel.skel');
    assert.equal(stem(spineEntry(MANIFEST, 'char_103_angel', { back: true })), 'char_103_angel_back.skel');
  });

  test('an installed skin replaces the operator\'s model', () => {
    const front = spineEntry(MANIFEST, 'char_103_angel', { skin: 'char_103_angel@wild#1' });
    assert.match(stem(front), /^char_103_angel_wild_1\.skel$/);
    const back = spineEntry(MANIFEST, 'char_103_angel', { skin: 'char_103_angel@wild#1', back: true });
    assert.equal(stem(back), 'char_103_angel_wild_1_back.skel', 'the skin\'s own Back, not the operator\'s');
  });

  test('a skin without a Back falls back to ITS Front, never to the operator\'s Back', () => {
    const sp = spineEntry(MANIFEST, 'char_103_angel', { skin: 'char_103_angel@kfc#1', back: true });
    assert.match(stem(sp), /^char_103_angel_kfc_1\.skel$/, 'must not become char_103_angel.skel');
    assert.ok(!/\/back\//.test(sp.skel));
  });

  test('an unknown skin id degrades to the default model instead of failing', () => {
    // a teammate may run a build whose manifest predates the skin, or never installed it
    assert.equal(stem(spineEntry(MANIFEST, 'char_103_angel', { skin: 'char_103_angel@nope#9' })), 'char_103_angel.skel');
    assert.equal(stem(spineEntry(MANIFEST, 'char_103_angel', { skin: '' })), 'char_103_angel.skel');
    assert.equal(stem(spineEntry(MANIFEST, 'char_103_angel', { skin: 42 })), 'char_103_angel.skel');
  });

  test('an operator with no skins at all is unaffected', () => {
    const m = { chars: { char_1_x: { spine: pair('char_1_x') } } };
    assert.equal(stem(spineEntry(m, 'char_1_x', { skin: 'char_1_x@any#1' })), 'char_1_x.skel');
  });
});

describe('skins: hasBackSpine', () => {
  test('asks the skin when one is given, the operator otherwise', () => {
    assert.equal(hasBackSpine(MANIFEST, 'char_103_angel'), true);
    assert.equal(hasBackSpine(MANIFEST, 'char_103_angel', 'char_103_angel@wild#1'), true);
    assert.equal(hasBackSpine(MANIFEST, 'char_103_angel', 'char_103_angel@kfc#1'), false, 'that skin ships no Back');
    assert.equal(hasBackSpine(MANIFEST, 'char_103_angel', 'char_103_angel@nope#9'), true, 'unknown skin → default model');
  });

  test('unknown operators answer false rather than throwing', () => {
    assert.equal(hasBackSpine(MANIFEST, 'char_nope'), false);
    assert.equal(hasBackSpine(MANIFEST, ''), false);
  });
});
