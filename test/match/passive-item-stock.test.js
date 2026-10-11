import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch, give, checkInvariants } from './harness.js';
import { makeCtx } from '../../server/match/effectsMeta.js';
import { PHASE } from '../../shared/constants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';

const ICE = 'chess_item_5_02_e_a';
const MORPH = 'chess_item_6_09_e_a';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ctxOf = (h, kind = 'garrison') => makeCtx(h.m, h.ps('p_0'), { kind, key: 'test:passive' }, 'onGain');
const itemPieces = (ps, base) => [...ps.hand, ...ps.temp, ...ps.allChess().flatMap(p => p.items || [])]
  .filter(p => p?.kind === 'item' && ps.gd.baseIdOf(p.id) === base);

for (const [name, normal, elite, item] of [
  ['Muelsyse', 'chess_char_6_11_a', 'chess_char_6_11_b', MORPH],
  ['Yera tier 3', 'chess_char_3_20_a', 'chess_char_3_20_b', ICE],
  ['Yera tier 4', 'chess_char_4_03_a', 'chess_char_4_03_b', ICE],
  ['Beeswax', 'chess_char_4_05_a', 'chess_char_4_05_b', 'chess_item_3_05_e_a'],
  ['Carnelian', 'chess_char_4_24_a', 'chess_char_4_24_b', 'chess_item_3_05_e_a'],
  ['Swire', 'chess_char_3_03_a', 'chess_char_3_03_b', 'chess_item_1_03_e_a'],
]) for (const mode of ['solo', 'coop']) test(`${name} ${mode}: normal/elite gifts bypass exhausted shared stock`, () => {
  const h = makeMatch({ mode, humans: mode === 'coop' ? 2 : 1, fake: true, seed: 11 }).start();
  try {
    const ps = h.ps('p_0'), pool = h.m.itemPool;
    const holder = mode === 'coop' ? h.ps('p_1') : ps;
    for (let i = 0; i < pool.cap(item); i++) assert.ok(holder.acquireItem(item, { silent: true }));
    assert.equal(pool.left(item), 0);
    assert.ok(ps.acquireChess(normal, { fromPool: false }));
    assert.ok(ps.acquireChess(elite, { fromPool: false }));
    assert.equal(pool.held(item), pool.cap(item), 'ordinary ownership alone occupies stock');
    const gifts = itemPieces(ps, item).filter(p => p.itemPoolCopies === 0);
    assert.ok(gifts.length);
    const freeCopies = gifts.reduce((n, p) => n + pool.need(p.id), 0);
    const mixedCopies = itemPieces(ps, item).filter(p => p.itemPoolCopies === 1 && h.m.gd.isGolden(p.id));
    assert.equal(freeCopies + mixedCopies.length, 3, 'all three gift equivalents arrive, including mixed merges');
    assert.equal(ps.acquireItem(item), null, 'ordinary grants still respect exhausted stock');
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});

test('mixed gift/shop merge occupies only its real copy, both grant orders and deferred merge', () => {
  for (const order of ['gift-first', 'shop-first', 'deferred']) {
    const h = makeMatch({ mode: 'solo', fake: true, seed: 11 }).start();
    try {
      const ps = h.ps('p_0'), pool = h.m.itemPool, ctx = ctxOf(h);
      if (order === 'gift-first') {
        assert.ok(ctx.grantItem(ICE));
        assert.ok(ps.acquireItem(ICE, { source: 'buy' }));
      } else {
        assert.ok(ps.acquireItem(ICE, { source: 'buy' }));
        if (order === 'deferred') ps._deferItemMerge = 1;
        assert.ok(ctx.grantItem(ICE));
        ps._deferItemMerge = 0;
        ps.checkItemMerges();
      }
      const [gold] = itemPieces(ps, ICE);
      assert.equal(ps.gd.isGolden(gold.id), true);
      assert.equal(gold.itemPoolCopies, 1);
      assert.equal(pool.held(ICE), 1);
      h.m.phase = PHASE.PREP;
      assert.ok(ps.destroy(gold.uid).ok);
      assert.equal(pool.left(ICE), pool.cap(ICE));
      checkInvariants(h.m);
    } finally { h.m.dispose(); }
  }
});

test('gift equipment stays exempt in hand/temp/equipped, through owner merge/sale and item upgrade/destruction', () => {
  const h = makeMatch({ mode: 'solo', fake: true, seed: 11 }).start();
  try {
    const ps = h.ps('p_0'), ctx = ctxOf(h), pool = h.m.itemPool;
    const ownerId = [...h.m.pool.entries.keys()].find(id => h.m.gd.tierOf(id) === 1);
    const owner = give(h.m, ps, ownerId);
    assert.ok(ctx.grantItem(MORPH, { toTemp: true }));
    const [gift] = itemPieces(ps, MORPH);
    assert.equal(pool.held(MORPH), 0);
    h.m.phase = PHASE.PREP;
    assert.ok(ps.equip(gift.uid, owner.uid).ok);
    assert.equal(pool.held(MORPH), 0);
    ps.acquireChess(ownerId);
    ps.acquireChess(ownerId);
    assert.equal(pool.held(MORPH), 0);
    const elite = ps.allChess().find(p => ps.gd.baseIdOf(p.id) === ownerId);
    assert.ok(ps.sell(elite.uid).ok);
    assert.equal(ps.find(gift.uid).piece.itemPoolCopies, 0);
    assert.ok(ps.destroy(gift.uid).ok);
    assert.equal(pool.left(MORPH), pool.cap(MORPH));
    assert.ok(ctx.grantItem(ICE));
    const [ice] = itemPieces(ps, ICE);
    assert.ok(ps.upgradeItem(ice));
    assert.equal(ice.itemPoolCopies, 0);
    assert.equal(pool.held(ICE), 0);
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});

test('random passive item rolls ignore exhaustion; ordinary effect, choice and console-style rolls do not', () => {
  const data = structuredClone(DATA);
  data.choices.pools.testPassiveItems = { kind: 'equip', items: [ICE] };
  data.choices.pools.testWeightedPassive = { kind: 'equip', weighted: [[ICE, 1]] };
  const h = makeMatch({ mode: 'solo', fake: true, data, seed: 11 }).start();
  try {
    const ps = h.ps('p_0'), pool = h.m.itemPool;
    for (let i = 0; i < pool.cap(ICE); i++) assert.ok(ps.acquireItem(ICE));
    const passive = ctxOf(h), ordinary = ctxOf(h, 'effect');
    for (const name of ['testPassiveItems', 'testWeightedPassive']) {
      assert.equal(passive.rollPool(name).id, ICE);
      assert.equal(passive.rollItem({ pool: name }), ICE);
      assert.equal(ordinary.rollPool(name), null);
      assert.equal(ordinary.rollItem({ pool: name }), null);
    }
    assert.ok(passive.grantItem(ICE));
    assert.equal(ordinary.grantItem(ICE), null);
    assert.equal(pool.held(ICE), pool.cap(ICE));
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});

test('legacy equipment without provenance defaults to full occupancy; gifted occupancy survives local restore', () => {
  const options = { mode: 'solo', fake: true, seed: 11 };
  const first = makeMatch(options).start(), second = makeMatch(options);
  try {
    const ps = first.ps('p_0');
    assert.ok(ps.acquireItem(ICE));
    assert.ok(ctxOf(first).grantItem(ICE));
    const doc = snapshotMatch(first.m);
    assert.ok(doc);
    assert.equal(restoreMatch(second.m, doc, { createRngFromState, log: quiet }), true);
    assert.equal(second.m.itemPool.held(ICE), 1);
    const old = second.ps('p_0').newPiece('item', 'chess_item_5_02_e_b');
    assert.equal(second.m.itemPool.occupied(old), 2);
    assert.equal(second.m.itemPool.occupied({ ...old, itemPoolCopies: -1 }), 2);
    assert.equal(second.m.itemPool.occupied({ ...old, itemPoolCopies: 99 }), 2);
    checkInvariants(second.m);
  } finally { first.m.dispose(); second.m.dispose(); }
});

test('exempt and mixed equipment provenance survives two complete checkpoint snapshot restores', () => {
  // The persistence worker and checkpoint recovery transport exactly this snapshotMatch document, so two
  // restore round trips stand in for xinhai's Worker/Redis variants (no match worker subsystem here).
  const options = { mode: 'solo', fake: true, seed: 11 };
  const first = makeMatch(options).start(), second = makeMatch(options), third = makeMatch(options);
  try {
    const ps = first.ps('p_0');
    assert.ok(ctxOf(first).grantItem(MORPH));
    assert.ok(ps.acquireItem(ICE));
    assert.ok(ctxOf(first).grantItem(ICE));
    const before = snapshotMatch(first.m);
    const hand = before.players[0].hand;
    assert.ok(hand.some(p => p?.id === MORPH && p.itemPoolCopies === 0), 'gift copy holds zero');
    assert.ok(hand.some(p => p?.id === 'chess_item_5_02_e_b' && p.itemPoolCopies === 1), 'mixed golden holds one');
    assert.equal(restoreMatch(second.m, before, { createRngFromState, log: quiet }), true);
    assert.equal(second.m.itemPool.held(MORPH), 0);
    assert.equal(second.m.itemPool.held('chess_item_5_02_e_a'), 1);
    const middle = snapshotMatch(second.m);
    assert.deepEqual(middle.players[0].hand, hand);
    assert.deepEqual(middle.players[0].temp, before.players[0].temp);
    assert.equal(restoreMatch(third.m, middle, { createRngFromState, log: quiet }), true);
    assert.deepEqual(snapshotMatch(third.m).players[0].hand, hand);
    checkInvariants(third.m);
  } finally { first.m.dispose(); second.m.dispose(); third.m.dispose(); }
});

test('pure gift upgrades do not open another ordinary slot in exhausted teammate stock', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true, seed: 11 }).start();
  try {
    const a = h.ps('p_0'), b = h.ps('p_1'), pool = h.m.itemPool;
    for (let i = 0; i < pool.cap(ICE); i++) assert.ok(b.acquireItem(ICE));
    assert.ok(ctxOf(h).grantItem(ICE));
    const [gift] = itemPieces(a, ICE);
    assert.ok(a.upgradeItem(gift), 'a gift needs no second shared copy even when stock is exhausted');
    assert.equal(gift.itemPoolCopies, 0);
    assert.equal(pool.left(ICE), 0);
    h.m.phase = PHASE.PREP;
    assert.ok(a.destroy(gift.uid).ok);
    assert.equal(pool.left(ICE), 0, 'destroying a gift cannot release teammates real copies');
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});

test('triggered operator passives grant exempt equipment even after the corresponding shared stock is exhausted', () => {
  const h = makeMatch({ mode: 'solo', fake: true, seed: 11 }).start();
  try {
    const ps = h.ps('p_0');
    for (let i = 0; i < h.m.itemPool.cap(ICE); i++) assert.ok(ps.acquireItem(ICE));
    assert.ok(ps.acquireChess('chess_char_3_20_a', { fromPool: false }));
    const owner = ps.allChess().find(p => p.id === 'chess_char_3_20_a');
    const before = itemPieces(ps, ICE).reduce((n, p) => n + h.m.itemPool.need(p.id), 0);
    assert.ok(h.m.dispatcher.triggerGarrisons(ps, owner, 'SERVER_GAIN') > 0);
    const after = itemPieces(ps, ICE).reduce((n, p) => n + h.m.itemPool.need(p.id), 0);
    assert.equal(after, before + 1);
    assert.equal(h.m.itemPool.held(ICE), h.m.itemPool.cap(ICE));
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});
