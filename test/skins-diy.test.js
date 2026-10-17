// 干员皮肤 — ported from sganggs/Stronghold-Protocol PR #652 (https://github.com/sganggs/Stronghold-Protocol/pull/652, upstream 0.2.7-dev); this fork's adaptations are listed in custom_docs/SKINS.md.
// test/skins-diy.test.js — 自选编队 × 皮肤 (custom_docs/SKINS.md): the picks of the 自选 slots can wear skins too, and
// the choices travel with the exports.
//
// Three halves:
//   * ui/skins.js syncDiySkins — a slot's choice names a skin of the OPERATOR picked for it, so a re-pick to a
//     different operator (or clearing the slot) must drop both the model and the 商店立绘 choice, while a same-operator
//     re-pick and the ROSTER's entries stay untouched (a stale id would silently fall back to the default model and
//     keep looking "chosen");
//   * ui/diyModel.js exportDiy / parseDiyImport — the slots' choices ride along with the picks (a slot's pick and its
//     skin belong together), and only the picked slots';
//   * ui/loadoutModel.js exportPayload / parseImport — the ROSTER's choices ride along, present-empty-means-replace
//     exactly like `ops`, and an older export (no field) leaves the current settings alone.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { skinsStore, setSkins, setPortraits, syncDiySkins, cleanSkinsMap } from '../public/js/ui/skins.js';
import { exportDiy, parseDiyImport, DIY_EXPORT_KIND } from '../public/js/ui/diyModel.js';
import { exportPayload, parseImport } from '../public/js/ui/loadoutModel.js';

const T5A = 'chess_char_5_diy1_a';
const T6A = 'chess_char_6_diy1_a';
const T6B = 'chess_char_6_diy2_a';
const INSIDE = 'chess_char_1_01_a';
const SKIN_A = 'char_608_acpion@sharp#1';
const SKIN_B = 'char_601_cguard@winter#1';

beforeEach(() => {
  setSkins({});
  setPortraits({});
});

describe('syncDiySkins: the slot choices follow the picks', () => {
  test('a re-pick to a different operator drops the slot\'s model and 立绘 choices', () => {
    setSkins({ [T6A]: SKIN_A, [INSIDE]: 'char_498_inside@kitchen#2' });
    setPortraits({ [T6A]: SKIN_A, [INSIDE]: 'char_498_inside@summer#22' });
    syncDiySkins({ [T6A]: { charId: 'char_608_acpion' } }, { [T6A]: { charId: 'char_601_cguard' } });
    assert.equal(skinsStore.get().entries[T6A], undefined, 'the slot\'s model choice is dropped');
    assert.equal(skinsStore.get().portraits[T6A], undefined, 'and its 商店立绘 choice');
    assert.equal(skinsStore.get().entries[INSIDE], 'char_498_inside@kitchen#2', 'the roster\'s entries stay');
    assert.equal(skinsStore.get().portraits[INSIDE], 'char_498_inside@summer#22', '…both of them');
  });

  test('clearing a slot drops its choices; a same-operator re-pick keeps them', () => {
    setSkins({ [T6A]: SKIN_A, [T6B]: SKIN_B });
    syncDiySkins({ [T6A]: { charId: 'a' }, [T6B]: { charId: 'b' } }, { [T6B]: { charId: 'b' } });
    assert.equal(skinsStore.get().entries[T6A], undefined, 'the cleared slot loses its choice');
    assert.equal(skinsStore.get().entries[T6B], SKIN_B, 'the same-operator re-pick keeps it');
    // and a pick appearing where none was does nothing (there is nothing stale to drop)
    syncDiySkins({}, { [T5A]: { charId: 'c' } });
    assert.deepEqual(skinsStore.get().entries, { [T6B]: SKIN_B }, 'still just the surviving choice');
  });

  test('an unchanged roster of picks changes nothing at all', () => {
    setSkins({ [T6A]: SKIN_A });
    syncDiySkins({ [T6A]: { charId: 'a' } }, { [T6A]: { charId: 'a' } });
    assert.deepEqual(skinsStore.get().entries, { [T6A]: SKIN_A });
  });
});

describe('the 自选编队 export carries the slot choices', () => {
  const picks = { [T6A]: { charId: 'char_608_acpion', skillIndex: 2 } };

  test('exportDiy includes the picked slots\' skins / 立绘, and only theirs', () => {
    const env = exportDiy(picks, { now: 0, skins: { [T6A]: SKIN_A, [T5A]: 'x', [INSIDE]: 'y' }, portraits: { [T6A]: SKIN_A } });
    assert.deepEqual(env.skins, { [T6A]: SKIN_A }, 'only the slot the file carries');
    assert.deepEqual(env.portraits, { [T6A]: SKIN_A });
    const back = parseDiyImport(JSON.stringify(env));
    assert.equal(back.ok, true);
    assert.deepEqual(back.skins, { [T6A]: SKIN_A }, 'and it parses back');
    assert.deepEqual(back.portraits, { [T6A]: SKIN_A });
  });

  test('an older export (no fields) parses without them; junk values are dropped', () => {
    assert.deepEqual(parseDiyImport({ v: 1, picks: {} }), { ok: true, picks: {} }, 'absent = an older export');
    const back = parseDiyImport(JSON.stringify({
      kind: DIY_EXPORT_KIND, v: 1, picks,
      skins: { [T6A]: SKIN_A, 'not an id!': 'x', [T5A]: 42 }, portraits: { [T6A]: SKIN_A, [T6B]: null },
    }));
    assert.deepEqual(back.skins, { [T6A]: SKIN_A }, 'shape-clean, nothing more');
    assert.deepEqual(back.portraits, { [T6A]: SKIN_A });
  });
});

describe('the 干员调配 export carries the roster choices', () => {
  test('present (empty included) = the file\'s choice; absent = an older export', () => {
    const p = exportPayload({ [INSIDE]: { skill: 0 } }, { now: 0, skins: { [INSIDE]: 'char_498_inside@kitchen#2' }, portraits: { [INSIDE]: 'e2' } });
    assert.deepEqual(p.skins, { [INSIDE]: 'char_498_inside@kitchen#2' });
    assert.deepEqual(p.portraits, { [INSIDE]: 'e2' });
    const back = parseImport(JSON.stringify(p));
    assert.deepEqual([back.skins, back.portraits], [{ [INSIDE]: 'char_498_inside@kitchen#2' }, { [INSIDE]: 'e2' }]);
    // empty maps survive the round trip too (an import then resets the choices)
    const empty = parseImport(JSON.stringify(exportPayload({ [INSIDE]: { skill: 0 } }, { now: 0 })));
    assert.deepEqual([empty.skins, empty.portraits], [{}, {}]);
    // and an older export leaves the fields out entirely
    const old = parseImport({ kind: 'stronghold.loadout', v: 1, entries: { [INSIDE]: { skill: 0 } } });
    assert.equal('skins' in old, false);
    assert.equal('portraits' in old, false);
  });
});

describe('cleanSkinsMap', () => {
  test('keeps string→string entries, drops everything else', () => {
    assert.deepEqual(cleanSkinsMap({ a: 'x', b: '', c: null, d: 7, e: {} }), { a: 'x' });
    assert.deepEqual(cleanSkinsMap(null), {});
    assert.deepEqual(cleanSkinsMap([['a', 'x']]), {});
  });
});
