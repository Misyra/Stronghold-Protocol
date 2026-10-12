import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch, give, checkInvariants } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';
import { computeBonds } from '../../server/match/bondsMeta.js';

function emptyPrep() {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 11, fake: true }).start().toPrep(1);
  const p = h.ps('p_0');
  for (const x of p.allChess()) p.returnCopies(x);
  p.board.clear(); p.hand.fill(null); p.temp.fill(null); p.offers.length = 0; p.bandId = null; p.recompute();
  return { h, m: h.m, p };
}

// The fork accounts a fixed gift as a copy that holds zero shared stock (piece.itemPoolCopies, the provenance model
// ported from xinhai 1cf48618) where upstream 0.2.5 lets the same gift overdraft the stock past its cap. Both models
// grant every copy a trait produces and refuse ordinary stock-backed grants once the stock is gone, so these tests
// assert the fork's accounting: `held` never passes the cap and the copies owned are the stock plus the gifts.
const giftPieces = (p, base) => [...p.hand, ...p.temp, ...p.allChess().flatMap((x) => x.items || [])]
  .filter((x) => x?.kind === 'item' && p.gd.baseIdOf(x.id) === base);
const copiesOf = (p, base) => giftPieces(p, base).reduce((n, x) => n + p.m.itemPool.need(x.id), 0);

for (const g of Object.values(DATA.garrisons).filter(g => g.effectKey === 'SERVER_GAIN_EQUIP')) {
  for (const owner of g.owners) test(`fixed gift ${g.garrisonId}/${owner} is produced past stock and holds zero`, () => {
    const { m, p } = emptyPrep(), id = g.bbStr.chess, cap = m.itemPool.cap(id);
    assert.ok(Number.isInteger(cap));
    for (let i = 0; i < cap; i++) assert.ok(p.acquireItem(id));
    assert.equal(m.itemPool.left(id), 0);
    assert.ok(p.acquireChess(owner, { fromPool: false }));
    assert.equal(copiesOf(p, id), cap + g.bb.count, 'the trait must finish all grants, including merges');
    assert.equal(m.itemPool.held(id), cap, 'a gift copy holds zero: the shared stock keeps its cap');
    assert.equal(m.itemPool.left(id), 0, 'the stock stays empty while the stock-backed copies are owned');
    assert.equal(p.acquireItem(id), null, 'an ordinary stock-backed grant is still refused');
    checkInvariants(m); m.dispose();
  });
}

test('unlimited fixed-item gifts do not exempt unrelated strategy equipment from stock', () => {
  const { m, p } = emptyPrep(), id = 'chess_item_5_07_e_a';
  assert.ok(p.acquireItem(id)); assert.ok(p.acquireItem(id));
  assert.equal(p.acquireItem(id, { requirePool: false }), null, 'commercial packaging is not a fixed operator gift');
  assert.equal(m.itemPool.held(id), 2); checkInvariants(m); m.dispose();
});

for (const invest of [false, true]) test(`repeated Muelsyse acquisition and elite gifts remain unlimited (investor=${invest})`, () => {
  const { m, p } = emptyPrep(), id = 'chess_item_6_09_e_a';
  if (invest) {
    const members = Object.values(DATA.chess).filter(c => c.visible && !c.isGolden && c.bonds.includes('investShip')).slice(0, 3);
    for (const c of members) give(m, p, c.chessId);
  }
  assert.equal(m.dispatcher.investRepeat(p), invest ? 2 : 1);
  const expected = invest ? [2, 4, 8, 10, 12] : [1, 2, 4, 5, 6];
  for (const n of expected) {
    assert.ok(p.acquireChess('chess_char_6_11_a'));
    assert.equal(copiesOf(p, id), n, 'every repeated gift copy arrives'); checkInvariants(m);
    assert.equal(m.itemPool.held(id), 0, 'each copy is a gift: none of them occupies shared stock');
    // Stow the non-merging isomorphs on holders so this stock test does not exhaust the player's inventory.
    for (const item of [...p.hand, ...p.temp].filter(x => x?.kind === 'item')) {
      const holder = p.allChess().find(c => c.items.length < m.gd.equipPerChess);
      if (holder) assert.ok(p.equip(item.uid, holder.uid).ok);
    }
  }
  m.dispose();
});

test('Damazti strategy grants its fixed item at rounds 5/10/15; releasing a gift does not free stock early', () => {
  const { m, p } = emptyPrep(), id = 'chess_item_6_09_e_a';
  for (let i = 0; i < 3; i++) assert.ok(p.acquireItem(id));
  p.bandId = 'band_damaztic'; p.recompute();
  for (const [i, round] of [5, 10, 15].entries()) {
    m.round = round; m.dispatch(p, 'onRoundStart', { round });
    assert.equal(copiesOf(p, id), 4 + i, 'the strategy keeps granting past an exhausted stock');
    assert.equal(m.itemPool.held(id), 3);
    checkInvariants(m);
  }
  // The three stock-backed copies hold the shared stock; a gift copy holds zero, so destroying one frees nothing.
  const gift = () => [...p.hand, ...p.temp].find(x => x?.kind === 'item' && p.gd.baseIdOf(x.id) === id && x.itemPoolCopies === 0);
  for (let i = 0; i < 3; i++) { assert.ok(p.destroy(gift().uid).ok); assert.equal(m.itemPool.left(id), 0); }
  assert.equal(m.itemPool.held(id), 3); assert.equal(copiesOf(p, id), 3);
  const real = [...p.hand, ...p.temp].find(x => x?.kind === 'item' && p.gd.baseIdOf(x.id) === id);
  assert.ok(p.destroy(real.uid).ok);
  assert.equal(m.itemPool.held(id), 2); assert.equal(m.itemPool.left(id), 1);
  checkInvariants(m); m.dispose();
});

for (const mu of ['chess_char_6_11_a', 'chess_char_6_11_b']) test(`seven distinct Yan operators plus Yan-converted ${mu} activate nine Yan`, () => {
  const gd = new GameData(DATA, 'mode_multi_hard');
  const seven = Object.values(DATA.chess).filter(c => c.visible && !c.isGolden && c.bonds.includes('yanShip')).slice(0, 7);
  assert.equal(seven.length, 7);
  const pieces = seven.map((c, i) => ({ uid: i + 1, kind: 'chess', id: c.chessId, items: [] }));
  pieces.push({ uid: 8, kind: 'chess', id: mu, items: [{ id: 'chess_item_6_09_e_a' }, { id: 'chess_item_3_04_e_a' }] });
  const state = { board: new Map(pieces.map((p, i) => [`${9 + i % 4},${3 + Math.floor(i / 4)}`, p])), hand: [], layers: {} };
  const b = computeBonds(gd, state);
  assert.equal(b.yanShip.count, 9); assert.equal(b.yanShip.tier, 3); assert.equal(b.yanShip.harmony, 1);
  pieces[7].items.pop();
  const withoutConversion = computeBonds(gd, state);
  assert.equal(withoutConversion.yanShip.count, 8); assert.equal(withoutConversion.yanShip.tier, 2);
});
