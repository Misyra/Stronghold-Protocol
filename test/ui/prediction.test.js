// test/ui/prediction.test.js — 客户端预测 (Stardust-minus rel26 2d3ec08e, 移植自用户分支): the prep intents the UI
// sends (buy, sell, move = deploy/withdraw, refresh, freeze, level-up) show their expected outcome at once and the
// authoritative m.private reconciles it — the server stays the only authority. This port has NO m.private `ack`
// (the fork's server echoed the latest handled intent's rid; server/ + shared/ stay untouched here), so the
// reconciler settles by *absorption*: each pending op carries a descriptor of the effect it predicts and is dropped
// the moment an authoritative view already reflects it; an error reply drops it at once; SETTLE_MS after the ok
// reply is the backstop. Pinned here:
//   - predictIntent mirrors the server's DIRECT effects only (funds, shop slots, hand / temp / board, deploy count,
//     the temp→hand refill of player/pieces.js _fillHandFromTemp) and declines what it cannot know (merges, the
//     refresh's RNG cards, summons, an equipment return that would not fit the hand);
//   - the reconciliation matrix: consistent → seamless replace; refused / different → rollback with zero ghosts;
//     interleaved / out-of-order → the final view is the authoritative one; a repeated frame applies nothing;
//     disconnect / reset / SETTLE_MS → all unconfirmed predictions cleared; a repeated same-direction tap applies
//     once; no prediction for a spectator / ready / eliminated seat;
//   - parity: a seeded random prep against the REAL PlayerState — every predicted intent ends where the server puts
//     it (the absorption / fill models included).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GEO, ERR, PHASE } from '../../shared/constants.js';
import { parseKey, tileKey } from '../../server/match/board.js';
import { predictIntent, replayIntents, resolveBought, pieceUids, findPiece, PREDICTABLE, isPredictable } from '../../public/js/ui/gameLogic/predict.js';
import { createPrediction, SETTLE_MS } from '../../public/js/ui/prediction.js';
import { DATA, makeMatch, chessOfTier } from '../match/harness.js';

const L = {
  getChess: (id) => DATA.chess[id] || null,
  getItem: (id) => DATA.items[id] || null,
  // the level-up / sell-price data the client resolves from its own config (ui/prediction.js shopConfig); mirrors
  // server/match/gamedata.js upgradeBase / shopSlots / sellPrice for the mode the tests run against
  shopConfig: () => {
    const mode = DATA.config.modes.mode_single_normal;
    return {
      upgradeBase: (lv) => (lv >= mode.maxShopLevel ? null : (Number.isFinite(mode.upgradePrices[lv - 1]) ? mode.upgradePrices[lv - 1] : null)),
      shopSlots: (lv) => {
        const s = mode.shopSlots[String(lv)];
        return s && typeof s === 'object' ? { chess: Math.min(s.chess, 8), item: Math.min(s.item, 4) } : null;
      },
      sellPrice: (id, golden) => {
        const row = DATA.config.economy.chessPrice?.[id];
        if (row && typeof row === 'object') return Number.isFinite(golden ? row.golden : row.normal) ? (golden ? row.golden : row.normal) : 1;
        return 1;
      },
    };
  },
};
const T1 = chessOfTier(1).filter((id) => !(DATA.chess[id].tokens || []).length);
const [A, B, C] = T1;

function base(over = {}) {
  return {
    playerId: 'p', alive: true, ready: false, funds: 10,
    shop: { level: 1, maxLevel: 6, upgradePrice: 4, refreshPrice: 1, freeRefreshes: 0, frozen: false,
      layout: { chess: 3, item: 0 },
      slots: [A, B, C].map((id) => ({ kind: 'chess', id, price: 2, basePrice: 2, sold: false, frozen: false })) },
    hand: Array(GEO.HAND_SIZE).fill(null), temp: Array(GEO.TEMP_SIZE).fill(null),
    board: [], deployCap: 3, deployCount: 0,
    ...over,
  };
}
const piece = (uid, id, extra = {}) => ({ uid, kind: 'chess', id, golden: false, tier: 1, items: [], count: 1, ownerUid: null, ...extra });
const itemPiece = (uid, id, extra = {}) => ({ uid, kind: 'item', id, golden: false, tier: null, items: [], count: 1, ownerUid: null, ...extra });
const tokenPiece = (uid, id, ownerUid, extra = {}) => ({ uid, kind: 'token', id, golden: false, tier: null, items: [], count: 1, ownerUid, ...extra });
const fullHand = (id = C) => Array.from({ length: GEO.HAND_SIZE }, (_, i) => piece(100 + i, id));

describe('predictIntent: the direct effects, and nothing it cannot know', () => {
  test('the predicted set is exactly the six prep intents', () => {
    assert.deepEqual([...PREDICTABLE].sort(), ['g.buy', 'g.freeze', 'g.levelUp', 'g.move', 'g.refresh', 'g.sell']);
    for (const t of PREDICTABLE) assert.equal(isPredictable(t), true);
    assert.equal(isPredictable('g.equip'), false);
    assert.equal(isPredictable('g.reward'), false);
  });

  test('g.buy: funds, the slot sold, the piece in the last free hand slot under a placeholder uid', () => {
    const r = predictIntent(base(), { t: 'g.buy', fields: { slot: 1 } }, L, -7);
    assert.equal(r.priv.funds, 8);
    assert.equal(r.priv.shop.slots[1].sold, true);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].uid, -7);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].id, B);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].kind, 'chess');
    assert.deepEqual(r.made, { uid: -7, area: 'hand', idx: GEO.HAND_SIZE - 1, id: B, kind: 'chess' });
    assert.deepEqual(r.absorb, { kind: 'buy', slot: 1 });
    assert.equal(base().shop.slots[1].sold, false, 'the input view is never edited');
  });

  test('g.buy declines: sold, poor, a full hand, an unknown slot; a merge-completing copy is paid for but not placed', () => {
    assert.equal(predictIntent(base({ funds: 1 }), { t: 'g.buy', fields: { slot: 0 } }, L), null);
    const sold = base(); sold.shop.slots[0] = { ...sold.shop.slots[0], sold: true };
    assert.equal(predictIntent(sold, { t: 'g.buy', fields: { slot: 0 } }, L), null);
    assert.equal(predictIntent(base(), { t: 'g.buy', fields: { slot: 99 } }, L), null);
    const full = base({ hand: fullHand() });
    assert.equal(predictIntent(full, { t: 'g.buy', fields: { slot: 0 } }, L), null);
    const two = base({ hand: [piece(1, A), piece(2, A), ...Array(GEO.HAND_SIZE - 2).fill(null)] });
    const r = predictIntent(two, { t: 'g.buy', fields: { slot: 0 } }, L, -3);
    assert.equal(r.priv.funds, 8);
    assert.equal(r.priv.shop.slots[0].sold, true);
    assert.equal(r.made, undefined, 'the elite and where it goes are the server\'s');
    assert.equal(r.priv.hand.filter(Boolean).length, 2);
  });

  test('g.buy of an item: in the last free hand slot under a placeholder, unless it completes a golden item', () => {
    const plain = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && !i.mergeable);
    const v = base(); v.shop.slots.push({ kind: 'item', id: plain.id, price: 1, basePrice: 1, sold: false, frozen: false });
    const r = predictIntent(v, { t: 'g.buy', fields: { slot: 3 } }, L, -4);
    assert.equal(r.priv.funds, 9);
    assert.deepEqual([r.priv.hand[GEO.HAND_SIZE - 1].kind, r.priv.hand[GEO.HAND_SIZE - 1].id, r.priv.hand[GEO.HAND_SIZE - 1].uid], ['item', plain.id, -4]);
    assert.equal(r.made.kind, 'item');
    const pairable = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && i.mergeable && DATA.items[i.upgradeChessId || i.goldenId]);
    if (pairable) {
      const w = base({ hand: [itemPiece(3, pairable.id), ...Array(GEO.HAND_SIZE - 1).fill(null)] });
      w.shop.slots.push({ kind: 'item', id: pairable.id, price: 1, basePrice: 1, sold: false, frozen: false });
      const m = predictIntent(w, { t: 'g.buy', fields: { slot: 3 } }, L, -5);
      assert.equal(m.made, undefined, 'the golden item is the server\'s');
      assert.equal(m.priv.funds, 9);
    }
  });

  test('g.sell: the piece and its summons go, its equipment comes back to the hand, the sell price is paid', () => {
    const eq = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && !i.mergeable)
      || Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden);
    const v = base({
      board: [
        { ...piece(5, A, { items: [{ uid: 9, id: eq.id }] }), row: 2, col: 3, dir: 'RIGHT' },
        tokenPiece(6, 'tok', 5, { row: 2, col: 4 }),
      ],
      deployCount: 1,
      hand: [tokenPiece(7, 'tok', 5), ...Array(GEO.HAND_SIZE - 1).fill(null)],
    });
    const r = predictIntent(v, { t: 'g.sell', fields: { uid: 5 } }, L);
    assert.equal(r.priv.board.length, 0, 'the board is empty (棋盘)');
    assert.equal(r.priv.deployCount, 0);
    assert.equal(r.priv.hand[0], null, 'its own summon stack goes with it (removeTokensOf — nothing merges on a sale)');
    assert.equal(r.priv.hand.filter(Boolean).length, 1, '库存: only the returned equipment is left');
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].uid, 9, 'the equipment went to the last free hand slot');
    const wantGain = Number.isFinite(DATA.chess[A].sellPrice) && DATA.chess[A].sellPrice >= 0
      ? Math.trunc(DATA.chess[A].sellPrice) : L.shopConfig().sellPrice(A, false);
    assert.equal(r.priv.funds, 10 + wantGain, '资金: the sell price is paid');
    assert.deepEqual(r.absorb, { kind: 'sell', uid: 5 });
    assert.equal(predictIntent(v, { t: 'g.sell', fields: { uid: 6 } }, L), null, 'summons are not sold');
    assert.equal(predictIntent(v, { t: 'g.sell', fields: { uid: 999 } }, L), null, 'unknown pieces are not sold');
  });

  test('g.sell declines when returned equipment would not fit the hand or would merge (the server places it)', () => {
    const eq = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && !i.mergeable)
      || Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden);
    const full = base({ board: [{ ...piece(5, A, { items: [{ uid: 9, id: eq.id }] }), row: 2, col: 3, dir: 'RIGHT' }], deployCount: 1, hand: fullHand() });
    assert.equal(predictIntent(full, { t: 'g.sell', fields: { uid: 5 } }, L), null, 'no hand room for the return');
    const pairable = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && i.mergeable && DATA.items[i.upgradeChessId || i.goldenId]);
    if (pairable) {
      const w = base({ board: [{ ...piece(5, A, { items: [{ uid: 9, id: pairable.id }] }), row: 2, col: 3, dir: 'RIGHT' }], deployCount: 1, hand: [itemPiece(3, pairable.id), ...Array(GEO.HAND_SIZE - 1).fill(null)] });
      assert.equal(predictIntent(w, { t: 'g.sell', fields: { uid: 5 } }, L), null, 'the return would merge');
    }
  });

  test('g.move: deploy, the deploy cap, board swaps, withdraw, bench swaps; summons and their owners are declined', () => {
    const v = base({ hand: [piece(1, A), piece(2, B), ...Array(GEO.HAND_SIZE - 2).fill(null)] });
    const d = predictIntent(v, { t: 'g.move', fields: { uid: 1, to: { area: 'board', row: 2, col: 3 }, dir: 'UP' } }, L).priv;
    assert.equal(d.hand[0], null);
    assert.deepEqual(d.board.map((p) => [p.uid, p.row, p.col, p.dir]), [[1, 2, 3, 'UP']], '棋盘: deployed with its facing');
    assert.equal(d.deployCount, 1);
    assert.equal(predictIntent({ ...d, deployCap: 1 }, { t: 'g.move', fields: { uid: 2, to: { area: 'board', row: 2, col: 4 } } }, L), null, 'BOARD_FULL');
    const sw = predictIntent({ ...d, deployCap: 1 }, { t: 'g.move', fields: { uid: 2, to: { area: 'board', row: 2, col: 3 } } }, L).priv;
    assert.equal(sw.hand[1].uid, 1, 'a hand card onto an operator: the operator takes the card\'s slot (round53)');
    assert.equal(sw.hand[1].row, undefined);
    assert.deepEqual(sw.board.map((p) => p.uid), [2]);
    const bb = predictIntent(d, { t: 'g.move', fields: { uid: 1, to: { area: 'board', row: 1, col: 1 } } }, L).priv;
    assert.deepEqual(bb.board.map((p) => [p.row, p.col, p.dir]), [[1, 1, 'RIGHT']], 'board → board keeps board order');
    const back = predictIntent(d, { t: 'g.move', fields: { uid: 1, to: { area: 'hand', idx: 5 } } }, L).priv;
    assert.equal(back.hand[5].uid, 1);
    assert.equal(back.board.length, 0);
    assert.equal(back.deployCount, 0, '棋盘: the deploy count follows');
    const hh = predictIntent(v, { t: 'g.move', fields: { uid: 1, to: { area: 'hand', idx: 1 } } }, L).priv;
    assert.deepEqual([hh.hand[0].uid, hh.hand[1].uid], [2, 1]);
    const orient = predictIntent(d, { t: 'g.move', fields: { uid: 1, to: { area: 'board', row: 2, col: 3 }, dir: 'LEFT' } }, L).priv;
    assert.deepEqual(orient.board.map((p) => [p.uid, p.dir]), [[1, 'LEFT']], 're-orient in place');
    const owner = { ...d, board: [...d.board, tokenPiece(50, 'tok', 1, { row: 2, col: 4 })] };
    assert.equal(predictIntent(owner, { t: 'g.move', fields: { uid: 1, to: { area: 'hand', idx: 5 } } }, L), null, 'an operator with summons out is the server\'s');
    assert.equal(predictIntent(owner, { t: 'g.move', fields: { uid: 50, to: { area: 'board', row: 1, col: 1 } } }, L), null, 'summons are not moved');
    const ontoToken = { ...d, board: [d.board[0], tokenPiece(51, 'tok', 999, { row: 2, col: 4 })] };
    assert.equal(predictIntent(ontoToken, { t: 'g.move', fields: { uid: 1, to: { area: 'board', row: 2, col: 4 } } }, L), null, 'a move onto a summon is the server\'s');
  });

  test('g.move: the freed hand slot is refilled from temp (server/match/player/pieces.js _fillHandFromTemp)', () => {
    // temp overflow pieces fill the freed hand slot right-to-left, exactly like the server's recompute
    const t = tokenPiece(90, 'tok', 5);
    const v = base({ hand: [piece(1, A), ...Array(GEO.HAND_SIZE - 1).fill(null)], temp: [null, t, null, null, null], board: [] });
    const r = predictIntent(v, { t: 'g.move', fields: { uid: 1, to: { area: 'board', row: 2, col: 3 } } }, L).priv;
    assert.deepEqual(r.board.map((p) => p.uid), [1]);
    assert.equal(r.hand[GEO.HAND_SIZE - 1].uid, 90, 'the rightmost visible temp piece took the freed slot');
    assert.equal(r.temp[1], null);
    assert.deepEqual(r.temp.filter(Boolean).length, 0);
  });

  test('g.refresh: paid or free funds, the freeze cancelled, the slots stand empty under `rolling` (the RNG is the server\'s)', () => {
    const paid = predictIntent(base(), { t: 'g.refresh' }, L).priv;
    assert.equal(paid.funds, 9, '资金: the refresh price is paid');
    assert.equal(paid.shop.frozen, false);
    assert.equal(paid.shop.rolling, true);
    assert.ok(paid.shop.slots.every((s) => s === null));
    const free = base(); free.shop.freeRefreshes = 2; free.shop.refreshPrice = 0;
    const rf = predictIntent(free, { t: 'g.refresh' }, L).priv;
    assert.equal(rf.funds, 10);
    assert.equal(rf.shop.freeRefreshes, 1, '库存: the free refresh is spent');
    assert.equal(predictIntent(base({ funds: 0 }), { t: 'g.refresh' }, L), null);
    const frozen = base(); frozen.shop.frozen = true; frozen.shop.slots = frozen.shop.slots.map((s) => ({ ...s, frozen: true }));
    const fr = predictIntent(frozen, { t: 'g.refresh' }, L);
    assert.equal(fr.priv.shop.frozen, false, 'a manual refresh cancels the freeze');
    assert.deepEqual(fr.absorb, { kind: 'refresh', free: 0, sig: frozen.shop.slots.map((s) => `chess:${s.id}`).join(',') });
  });

  test('g.freeze: the toggle, the unsold slots follow, the sold slots keep their own flag', () => {
    const on = predictIntent(base(), { t: 'g.freeze' }, L);
    assert.equal(on.priv.shop.frozen, true);
    assert.ok(on.priv.shop.slots.every((s) => s.frozen));
    assert.deepEqual(on.absorb, { kind: 'freeze', on: true });
    const v = base(); v.shop.slots[0] = { ...v.shop.slots[0], sold: true };
    const off = predictIntent({ ...v, shop: { ...v.shop, frozen: true, slots: v.shop.slots.map((s) => ({ ...s, frozen: true })) } }, { t: 'g.freeze' }, L);
    assert.equal(off.priv.shop.frozen, false);
    assert.equal(off.priv.shop.slots[0].frozen, true, 'a sold slot keeps its own flag (the server touches unsold slots only)');
    assert.ok(off.priv.shop.slots.slice(1).every((s) => !s.frozen));
  });

  test('g.levelUp: funds, the level, the next price and layout from the client\'s mode data, the new slots open empty', () => {
    const lv = predictIntent(base(), { t: 'g.levelUp' }, L);
    assert.equal(lv.priv.funds, 6, '资金: the upgrade is paid');
    assert.equal(lv.priv.shop.level, 2);
    assert.equal(lv.priv.shop.upgradePrice, 8, 'the next price from the mode data');
    // mode_single_normal: level 2 = { chess: 4, item: 1 } — the chess slot AND the equipment column open, empty
    assert.deepEqual([lv.priv.shop.slots.length, lv.priv.shop.slots[3], lv.priv.shop.layout.chess], [5, null, 4], 'the new slots open empty (库存)');
    assert.deepEqual([lv.priv.shop.layout.item, lv.priv.shop.slots[4]], [1, null]);
    assert.deepEqual(lv.absorb, { kind: 'levelUp', level: 2 });
    const top = base(); top.shop.level = 6;
    assert.equal(predictIntent(top, { t: 'g.levelUp' }, L), null, 'MAX_LEVEL');
    assert.equal(predictIntent(base({ funds: 0 }), { t: 'g.levelUp' }, L), null);
    const withItem = base(); withItem.shop.layout = { chess: 3, item: 1 }; withItem.shop.slots.push({ kind: 'item', id: 'x', price: 1, sold: false });
    const li = predictIntent(withItem, { t: 'g.levelUp' }, L).priv;
    assert.deepEqual(li.shop.slots.map((x) => (x ? x.kind : null)), ['chess', 'chess', 'chess', null, 'item'], 'operators before the equipment column');
  });

  test('g.levelUp without mode data still predicts funds + level (the server corrects the rest)', () => {
    const noL = { getChess: L.getChess, getItem: L.getItem };
    const r = predictIntent(base(), { t: 'g.levelUp' }, noL);
    assert.equal(r.priv.funds, 6);
    assert.equal(r.priv.shop.level, 2);
    assert.equal(r.priv.shop.upgradePrice, 4, 'left for the server\'s state');
    assert.equal(r.priv.shop.slots.length, 3);
  });

  test('replayIntents applies in order and reports what it made and how each op settles', () => {
    const two = replayIntents(base(), [
      { id: 1, t: 'g.buy', fields: { slot: 0 } },
      { id: 2, t: 'g.buy', fields: { slot: 1 } },
    ], L);
    assert.equal(two.priv.funds, 6);
    assert.deepEqual([...two.made.keys()], [1, 2]);
    assert.equal(two.priv.hand[GEO.HAND_SIZE - 1].uid, -1);
    assert.equal(two.priv.hand[GEO.HAND_SIZE - 2].uid, -2);
    const r = replayIntents(base(), [
      { id: 1, t: 'g.buy', fields: { slot: 0 } },
      { id: 3, t: 'g.move', fields: { uid: -1, to: { area: 'board', row: 2, col: 3 }, dir: 'UP' } },
    ], L);
    assert.deepEqual([...r.applied].sort((a, b) => a - b), [1, 3]);
    assert.equal(r.priv.board[0].uid, -1, 'the placeholder was deployed (the real uid is resolved later)');
    assert.deepEqual(r.absorb.get(1), { kind: 'buy', slot: 0 });
    assert.deepEqual(r.absorb.get(3), { kind: 'move', uid: -1, to: { area: 'board', row: 2, col: 3 } });
  });

  test('a replay over a state that already reflects an op skips it (idempotent: the duplicate tap, the repeated frame)', () => {
    const done = base({ funds: 8 });
    done.shop.slots[0] = { ...done.shop.slots[0], sold: true };
    done.hand[GEO.HAND_SIZE - 1] = piece(501, A);
    const r = replayIntents(done, [{ id: 1, t: 'g.buy', fields: { slot: 0 }, absorb: { kind: 'buy', slot: 0 } }], L);
    assert.deepEqual([...r.applied], [], 'absorbed: not applied again');
    assert.equal(r.priv, done, 'the view is the authoritative one, untouched');
    const frozen = base(); frozen.shop.frozen = true; frozen.shop.slots = frozen.shop.slots.map((s) => ({ ...s, frozen: true }));
    const f = replayIntents(frozen, [{ id: 1, t: 'g.freeze', absorb: { kind: 'freeze', on: true } }], L);
    assert.deepEqual([...f.applied], [], 'the freeze is not toggled back by a replay over its own result');
    assert.equal(f.priv.shop.frozen, true);
  });

  test('resolveBought: the hand slot used, else the only new copy; none or two candidates is null', () => {
    const before = new Set([1]);
    const auth = base({ hand: [piece(1, A), ...Array(GEO.HAND_SIZE - 2).fill(null), piece(77, B)] });
    assert.equal(resolveBought(auth, before, { idx: GEO.HAND_SIZE - 1, id: B }), 77);
    assert.equal(resolveBought(auth, before, { idx: 3, id: B }), 77);
    assert.equal(resolveBought(auth, before, { idx: 3, id: C }), null);
    const two = base({ hand: [piece(77, B), piece(78, B), ...Array(GEO.HAND_SIZE - 2).fill(null)] });
    assert.equal(resolveBought(two, before, { idx: 3, id: B }), null, 'two candidates: the server decides');
  });

  test('findPiece and pieceUids walk hand, temp and board', () => {
    const v = base({ hand: [piece(1, A)], board: [{ ...piece(2, B), row: 2, col: 3, dir: 'UP' }], temp: [itemPiece(3, 'it')] });
    assert.deepEqual(findPiece(v, 2), { area: 'board', idx: 0, piece: v.board[0] });
    assert.deepEqual(findPiece(v, 3)?.area, 'temp');
    assert.equal(findPiece(v, 99), null);
    assert.deepEqual([...pieceUids(v)].sort((a, b) => a - b), [1, 2, 3]);
  });
});

/** A prediction over a fake socket: requests are held until the test answers them. No `ack` — this port reconciles
    by absorption, so the rig's frames carry no rid at all. */
function rig(start = base()) {
  const sent = [], shown = [];
  let tid = 0;
  const pending = new Map();
  const timers = { setTimeout: (fn, ms) => { const id = ++tid; pending.set(id, { fn, ms }); return id; }, clearTimeout: (id) => pending.delete(id), fire: () => { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } }, count: () => pending.size };
  const request = (t, fields) => {
    let ok, no;
    const p = new Promise((a, b) => { ok = a; no = b; });
    sent.push({ t, fields: { ...fields }, ok: () => ok({ t: 'ok' }), fail: (code) => no(Object.assign(new Error(code), { code })) });
    return p;
  };
  const P = createPrediction({ request, lookups: L, publish: (v) => shown.push(v), timers });
  P.authoritative(start);
  return { P, sent, shown, timers, last: () => shown.at(-1) };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('the reconciliation matrix', () => {
  test('一致: shown at once; the state that reflects it absorbs it — the view is the server\'s own object', async () => {
    const { P, sent, last } = rig();
    const { promise, predicted } = P.submit('g.buy', { slot: 0 });
    assert.equal(predicted, true);
    assert.equal(sent.length, 1, 'sent at once, in order');
    assert.equal(last().funds, 8);
    assert.ok(last().hand[GEO.HAND_SIZE - 1].uid < 0, 'the bought card shows under a placeholder uid');
    sent[0].ok(); await promise;
    assert.equal(P.pending().length, 1, 'the reply alone keeps it: the state may still be up to one flush behind');
    const after = base({ funds: 8, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(501, A)] });
    after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
    const v = P.authoritative(after);
    assert.equal(v, after, 'nothing pending: the server\'s own object — no replay wrapper, no flicker');
    assert.equal(v.hand.filter(Boolean).length, 1, 'never applied twice');
    assert.equal(P.pending().length, 0);
    const again = P.authoritative(after);
    assert.equal(again, after, 'a repeated identical frame (the wire dedups it; the client must survive one) is a no-op');
  });

  test('一致: the state before the reply (a synchronous flush) is absorbed too — the toggle is not undone', () => {
    const { P, sent, last } = rig();
    const { promise } = P.submit('g.freeze');
    assert.equal(last().shop.frozen, true);
    const after = base(); after.shop.frozen = true; after.shop.slots = after.shop.slots.map((s) => ({ ...s, frozen: true }));
    const v = P.authoritative(after);
    assert.equal(v.shop.frozen, true, 'the freeze is absorbed by the state, never replayed as a second toggle');
    sent[0].ok();
    return promise.then(() => assert.equal(P.pending().length, 0));
  });

  test('一致: a predicted refresh is absorbed by the state with the real cards, `rolling` gone', () => {
    const { P, sent, last } = rig();
    const { predicted } = P.submit('g.refresh');
    assert.equal(predicted, true);
    assert.equal(last().shop.rolling, true);
    assert.ok(last().shop.slots.every((s) => s === null));
    const after = base({ funds: 9 });
    after.shop.slots = [null, null, null];
    after.shop.slots[0] = { kind: 'chess', id: C, price: 2, basePrice: 2, sold: false, frozen: false };
    const v = P.authoritative(after);
    assert.equal(v, after, 'the real cards replace the rolling view');
    assert.equal(v.shop.rolling, undefined);
    sent[0].ok();
  });

  test('不一致: refused — rolled back to the server\'s state, zero ghosts, the caller sees the error', async () => {
    const { P, sent, last } = rig();
    const first = P.submit('g.sell', { uid: 999 });
    const b = P.submit('g.buy', { slot: 2 });
    assert.equal(b.predicted, true);
    assert.equal(last().funds, 8);
    sent[1].fail(ERR.NO_FUNDS);
    await assert.rejects(b.promise, { code: ERR.NO_FUNDS });
    assert.equal(last().funds, 10, 'rolled back: no predicted funds, no predicted card');
    assert.equal(last().shop.slots[2].sold, false);
    assert.equal(P.pending().length, 1);
    sent[0].fail(ERR.BAD_TARGET);
    await assert.rejects(first.promise, { code: ERR.BAD_TARGET });
    assert.equal(P.pending().length, 0);
  });

  test('不一致: the state says something else — a merge consumed the copy; the elite is shown, no phantom card', () => {
    const { P, last } = rig();
    const { predicted } = P.submit('g.buy', { slot: 0 });
    assert.equal(predicted, true);
    // the server merged the copy instead: the slot is sold, the elite stands on the board, the hand gained nothing
    const after = base({ funds: 8, board: [{ ...piece(601, A, { golden: true, tier: 3 }), row: 2, col: 3, dir: 'RIGHT' }], deployCount: 1 });
    after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
    const v = P.authoritative(after);
    assert.equal(v, after, 'absorbed via the sold slot: the server\'s placement wins');
    assert.equal(v.hand.filter(Boolean).length, 0, 'no phantom predicted card next to the elite');
    assert.equal(P.pending().length, 0);
  });

  test('不一致: the state\'s funds moved without the buy — the prediction re-fits or fades, the error reply ends it', async () => {
    const { P, sent, last } = rig();
    const sub = P.submit('g.buy', { slot: 0 });
    assert.equal(sub.predicted, true);
    const other = base({ funds: 5 }); // e.g. an effect spent funds server-side before the intent was processed
    let v = P.authoritative(other);
    assert.equal(v.funds, 3, 'still replayed over the newer state (other changes show too)');
    sent[0].fail(ERR.NO_FUNDS);
    await assert.rejects(sub.promise, { code: ERR.NO_FUNDS });
    v = P.authoritative(other);
    assert.equal(v.funds, 5, 'the refusal rolled everything back to the authoritative view');
    assert.equal(v.shop.slots[0].sold, false);
  });

  test('乱序/交错: buy + a move of its placeholder — the placeholder resolves, the dependent goes out, the final view is the server\'s', async () => {
    const { P, sent, last } = rig();
    const buy = P.submit('g.buy', { slot: 0 });
    const ph = last().hand[GEO.HAND_SIZE - 1].uid;
    assert.ok(ph < 0);
    const mv = P.submit('g.move', { uid: ph, to: { area: 'board', row: 2, col: 3 }, dir: 'UP' });
    assert.equal(mv.predicted, true);
    assert.equal(sent.length, 1, 'the dependent waits for the real uid');
    assert.deepEqual(last().board.map((p) => [p.uid, p.row, p.col]), [[ph, 2, 3]]);
    const ready = P.submit('g.ready', { ready: true });
    assert.equal(ready.predicted, false);
    assert.equal(sent.length, 1, 'a later intent keeps the order');
    // the state with the purchase (the move is not in it yet): the placeholder resolves, the move goes out rewritten
    const after = base({ funds: 8, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(501, A)] });
    after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
    let v = P.authoritative(after);
    assert.deepEqual(sent.slice(1).map((s) => [s.t, s.fields.uid ?? null]), [['g.move', 501], ['g.ready', null]]);
    assert.deepEqual(v.board.map((p) => [p.uid, p.row, p.col, p.dir]), [[501, 2, 3, 'UP']], 'shown on the real piece');
    assert.equal(v.hand.filter(Boolean).length, 0);
    // the state with the move (the piece only on the board now): absorbed, the view is the server's
    const after2 = base({ funds: 8, board: [{ ...piece(501, A), row: 2, col: 3, dir: 'UP' }], deployCount: 1 });
    after2.shop.slots[0] = { ...after2.shop.slots[0], sold: true };
    v = P.authoritative(after2);
    assert.equal(v, after2);
    sent[0].ok(); sent[1].ok(); sent[2].ok();
    await buy.promise; await mv.promise; await ready.promise;
    assert.equal(P.pending().length, 0);
  });

  test('乱序/交错: two states in flight — a state that reflects neither keeps both replayed, the next absorbs them', () => {
    const { P, last } = rig();
    P.submit('g.buy', { slot: 0 });
    P.submit('g.buy', { slot: 1 });
    const other = base({ funds: 15 }); // an unrelated server-side change beat both intents
    let v = P.authoritative(other);
    assert.equal(v.funds, 11, 'both still replayed over the newer state');
    assert.equal(v.shop.slots[0].sold, true);
    assert.equal(v.shop.slots[1].sold, true);
    const after = base({ funds: 13 });
    after.shop.slots = after.shop.slots.map((s) => ({ ...s, sold: true }));
    after.hand[GEO.HAND_SIZE - 1] = piece(701, A);
    after.hand[GEO.HAND_SIZE - 2] = piece(702, B);
    v = P.authoritative(after);
    assert.equal(v, after, 'both absorbed at once');
    assert.equal(P.pending().length, 0);
  });

  test('幂等: the same frame twice, the same op twice — applied once, the second tap is not predicted', async () => {
    const { P, sent, last } = rig();
    const first = P.submit('g.buy', { slot: 0 });
    assert.equal(first.predicted, true);
    const second = P.submit('g.buy', { slot: 0 });
    assert.equal(second.predicted, false, 'the slot is already sold in the shown view');
    assert.equal(sent.length, 2, 'the second is still sent (the server answers SOLD_OUT, as before the prediction)');
    assert.equal(last().hand.filter(Boolean).length, 1, 'the card shows once');
    assert.equal(last().funds, 8, 'the funds are deducted once');
    sent[1].fail(ERR.SOLD_OUT);
    await assert.rejects(second.promise, { code: ERR.SOLD_OUT });
    assert.equal(last().funds, 8);
    assert.equal(last().hand.filter(Boolean).length, 1);
    sent[0].ok();
    await first.promise;
    const after = base({ funds: 8, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(801, A)] });
    after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
    const v = P.authoritative(after);
    assert.equal(v.hand.filter(Boolean).length, 1, 'and the state brings exactly one');
  });

  test('断线/重连: a dropped socket fails the sent intent and never replays it; a new match forgets everything', async () => {
    const { P, sent, last } = rig();
    const { promise } = P.submit('g.buy', { slot: 0 });
    sent[0].fail('DISCONNECTED');
    await assert.rejects(promise);
    assert.equal(last().funds, 10, 'the prediction is gone with the socket');
    assert.equal(P.authoritative(base({ funds: 10 })).funds, 10, 'a reconnect\'s state shows through untouched');
    assert.equal(P.pending().length, 0);
    P.submit('g.buy', { slot: 0 });
    const v = P.authoritative(base({ playerId: 'q' }));
    assert.equal(P.pending().length, 0, 'another seat\'s state (a new match) forgets everything');
    assert.equal(v.playerId, 'q');
  });

  test('断线/重连: reset() on the match being cleared rejects the unsent and clears the timers', async () => {
    const { P, sent, timers } = rig();
    P.submit('g.buy', { slot: 0 });
    // a placeholder no pending purchase made: refused at once, before any request
    await assert.rejects(P.submit('g.move', { uid: -42, to: { area: 'board', row: 2, col: 3 } }).promise, { code: 'BAD_TARGET' });
    P.submit('g.refresh');
    // a dependent of the in-flight buy: queued unsent, reset() must reject it as CLOSED
    const dep = P.submit('g.move', { uid: -1, to: { area: 'board', row: 1, col: 1 } });
    assert.equal(sent.length, 2, 'the dependent waits for the purchase (buy + refresh are on the wire)');
    assert.equal(P.pending().length, 3);
    P.reset();
    await assert.rejects(dep.promise, { code: 'CLOSED' });
    assert.equal(P.pending().length, 0);
    assert.equal(timers.count(), 0, 'no settle timer survives the reset');
    assert.equal(P.enabled, false);
  });

  test('the settle fallback: a reply whose state never comes stops being replayed after SETTLE_MS', async () => {
    const { P, sent, timers, last } = rig();
    const { promise } = P.submit('g.freeze');
    assert.equal(last().shop.frozen, true);
    sent[0].ok(); await promise;
    assert.equal(timers.count(), 1);
    assert.ok(SETTLE_MS >= 1000);
    timers.fire();
    assert.equal(last().shop.frozen, false, 'the authoritative view stands');
    assert.equal(P.pending().length, 0);
  });

  test('观战者/无权席位: no m.private, a ready seat, an eliminated seat, a left PREP — the plain request only', async () => {
    const sent = [], shown = [];
    // a spectator never receives an m.private: auth stays null and nothing is predicted
    const spectator = createPrediction({ request: (t, f) => { sent.push({ t, fields: { ...f } }); return new Promise(() => {}); }, lookups: L, publish: (v) => shown.push(v) });
    const noAuth = spectator.submit('g.buy', { slot: 0 });
    assert.equal(noAuth.predicted, false);
    assert.equal(sent.length, 1);
    assert.equal(shown.length, 0);
    const { P } = rig();
    const gated = createPrediction({ request: () => new Promise(() => {}), lookups: L, publish: () => {}, canPredict: () => false });
    gated.authoritative(base());
    assert.equal(gated.submit('g.buy', { slot: 0 }).predicted, false, 'the phase gate (canPredict) off: no prediction');
    const ready = createPrediction({ request: () => new Promise(() => {}), lookups: L, publish: () => {} });
    ready.authoritative(base({ ready: true }));
    assert.equal(ready.submit('g.buy', { slot: 0 }).predicted, false, 'a ready seat is the server\'s');
    const dead = createPrediction({ request: () => new Promise(() => {}), lookups: L, publish: () => {} });
    dead.authoritative(base({ alive: false }));
    assert.equal(dead.submit('g.buy', { slot: 0 }).predicted, false, 'an eliminated seat is the server\'s');
  });
});

describe('the server half: repeated same-direction intents and the gate', () => {
  test('a repeated g.buy on a sold slot is refused and sends no m.private (dedup: zero broadcast)', () => {
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 3 }).start().toPrep(1, { ready: false });
    try {
      const ps = h.ps('p_0');
      ps.funds = 50;
      const privs = () => h.sent.filter(([id, msg]) => id === ps.playerId && msg.t === 'm.private').length;
      const n0 = privs();
      assert.ok(h.m.handle(ps.playerId, { t: 'g.buy', slot: 0 }).ok);
      assert.ok(privs() > n0, 'the accepted intent pushed its state');
      const n1 = privs();
      const res = h.m.handle(ps.playerId, { t: 'g.buy', slot: 0 });
      assert.equal(res.error, ERR.SOLD_OUT);
      assert.equal(privs(), n1, 'a refused repeat changes nothing: zero broadcast');
    } finally { h.m.dispose(); }
  });

  test('the gate the prediction mirrors (player/prep.js _gate): ready and non-PREP refuse', () => {
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 4 }).start().toPrep(1, { ready: false });
    try {
      const ps = h.ps('p_0');
      assert.ok(m0(h, ps, { t: 'g.freeze' }).ok);
      m0(h, ps, { t: 'g.ready', ready: true });
      assert.equal(ps.ready, true);
      assert.equal(m0(h, ps, { t: 'g.freeze' }).error, ERR.WRONG_PHASE, 'ready: the server refuses, the prediction gate too');
      assert.equal(m0(h, ps, { t: 'g.buy', slot: 0 }).error, ERR.WRONG_PHASE);
    } finally { h.m.dispose(); }
  });
});
const m0 = (h, ps, msg) => h.m.handle(ps.playerId, msg);

describe('parity with the real PlayerState', () => {
  /** Tiny seeded PRNG so the run repeats. */
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

  /** The parts a prediction claims, comparable between the predicted and the server's view (`map`: placeholder → uid). */
  function claimed(v, map = new Map(), { slots = true } = {}) {
    const u = (x) => (map.has(x) ? map.get(x) : x);
    const pc = (p) => (p ? [u(p.uid), p.kind, p.id, ...(Number.isInteger(p.row) ? [p.row, p.col, p.dir] : [])].join(':') : '-');
    return {
      funds: v.funds, deployCount: v.deployCount,
      frozen: !!v.shop.frozen, level: v.shop.level, freeRefreshes: v.shop.freeRefreshes, upgradePrice: v.shop.upgradePrice,
      ...(slots ? { slots: v.shop.slots.map((s) => (s ? `${s.id}:${s.sold ? 1 : 0}:${s.frozen ? 1 : 0}` : '-')) } : {}),
      hand: v.hand.map(pc), temp: v.temp.map(pc),
      board: v.board.map(pc).sort(),
    };
  }

  test('a seeded random prep: every predicted intent ends where the server puts it', (t) => {
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 4242 }).start().toPrep(1, { ready: false });
    t.after(() => h.m.dispose());
    const m = h.m, ps = h.ps('p_0');
    const R = rng(9);
    const stats = { predicted: 0, declined: 0, refusedButPredicted: 0, steps: 0, granted: 0 };
    const bad = [];
    const pick = (a) => a[Math.floor(R() * a.length)];
    for (let round = 1; round <= 4; round++) {
      if (round > 1) h.toPrep(round, { ready: false });
      ps.funds += 20;
      for (let step = 0; step < 90; step++) {
        const pv = ps.privateView();
        const pieces = [...pv.hand, ...pv.temp, ...pv.board].filter((p) => p && p.kind === 'chess');
        const roll = R();
        let op;
        if (roll < 0.3) op = { t: 'g.buy', fields: { slot: Math.floor(R() * pv.shop.slots.length) } };
        else if (roll < 0.4) op = { t: 'g.sell', fields: { uid: pick(pieces)?.uid ?? 1 } };
        else if (roll < 0.47) op = { t: 'g.refresh' };
        else if (roll < 0.52) op = { t: 'g.freeze' };
        else if (roll < 0.56) op = { t: 'g.levelUp' };
        else {
          const p = pick(pieces);
          if (!p) continue;
          const loc = ps.find(p.uid);
          if (R() < 0.6) {
            // a tile the UI would offer: legal for the piece, and a swapped occupant legal on the source tile
            const tiles = [];
            for (let r = 0; r < GEO.ROWS; r++) for (let c = 0; c < GEO.COLS; c++) {
              if (!ps._legal(loc.piece, r, c)) continue;
              const occ = ps.board.get(tileKey(r, c));
              if (occ && loc.area === 'board' && occ !== loc.piece) { const [sr, sc] = parseKey(loc.key); if (!ps._legal(occ, sr, sc)) continue; }
              tiles.push([r, c]);
            }
            if (!tiles.length) continue;
            const [row, col] = pick(tiles);
            op = { t: 'g.move', fields: { uid: p.uid, to: { area: 'board', row, col }, dir: pick(['UP', 'RIGHT', 'DOWN', 'LEFT']) } };
          } else {
            const idx = Math.floor(R() * GEO.HAND_SIZE);
            const occ = ps.hand[idx];
            if (occ && loc.area === 'board' && occ.kind === 'chess') { const [sr, sc] = parseKey(loc.key); if (!ps._legal(occ, sr, sc)) continue; }
            op = { t: 'g.move', fields: { uid: p.uid, to: { area: 'hand', idx } } };
          }
        }
        stats.steps++;
        const r = predictIntent(pv, op, L, -1);
        const res = m.handle(ps.playerId, { t: op.t, ...(op.fields || {}) });
        const after = ps.privateView();
        if (!r) { stats.declined++; continue; }
        if (res.error) { stats.refusedButPredicted++; bad.push(`${op.t} ${JSON.stringify(op.fields)} predicted but refused: ${res.error} ${res.detail || ''}`); continue; }
        stats.predicted++;
        const map = new Map();
        if (r.made) {
          const real = resolveBought(after, new Set([...pv.hand, ...pv.temp, ...pv.board].filter(Boolean).map((p) => p.uid)), r.made);
          if (real == null) { bad.push(`${op.t} ${JSON.stringify(op.fields)}: the bought piece is not found`); continue; }
          map.set(r.made.uid, real);
        }
        // pieces the server added that no prediction claims: a summon granted on a deployment, a copy an effect grants
        // (those arrive with the server's state); everything else must match
        const known = new Set([...pieceUids(pv), ...map.values()]);
        const granted = [...after.hand, ...after.temp, ...after.board].filter((p) => p && !known.has(p.uid));
        stats.granted += granted.length;
        const strip = (v) => ({ ...v, hand: v.hand.map((p) => (p && !known.has(p.uid) ? null : p)), temp: v.temp.map((p) => (p && !known.has(p.uid) ? null : p)), board: v.board.filter((p) => known.has(p.uid)) });
        const want = claimed(strip(after), new Map(), { slots: op.t !== 'g.refresh' });
        const got = claimed(r.priv, map, { slots: op.t !== 'g.refresh' });
        const diff = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
        if (diff.length) bad.push(`${op.t} ${JSON.stringify(op.fields)} R${round}: ${diff.map((k) => `${k} predicted ${JSON.stringify(got[k])} server ${JSON.stringify(want[k])}`).join(' | ')}`);
      }
      // leave the prep the way the suite drives it: ready, so the next round starts
      if (round < 4 && !ps.ready) m.handle(ps.playerId, { t: 'g.ready', ready: true });
    }
    t.diagnostic(JSON.stringify(stats));
    assert.deepEqual(bad.slice(0, 12), [], `${bad.length} mismatches:\n${bad.slice(0, 12).join('\n')}`);
    assert.ok(stats.predicted > 120, `most intents are predicted (${JSON.stringify(stats)})`);
    assert.equal(h.logs.error.length, 0, `no server errors: ${h.logs.error.slice(0, 3)}`);
  });
});

describe('the page wiring (ui/prediction.js singleton)', () => {
  test('submit publishes the predicted view into the store; the authoritative state settles it; clearing the match resets', async () => {
    const { net } = await import('../../public/js/net.js');
    const { store, emptyMatch } = await import('../../public/js/store.js');
    const { data } = await import('../../public/js/data.js');
    const { prediction } = await import('../../public/js/ui/prediction.js');
    const prevNet = net.request, prevLookup = data.lookup;
    const sent = [];
    net.request = (t, fields) => {
      let ok, no;
      const p = new Promise((a, b) => { ok = a; no = b; });
      sent.push({ t, fields: { ...fields }, ok, fail: (code) => no(Object.assign(new Error(code), { code })) });
      return p;
    };
    data.lookup = (name, id) => (name === 'chess' ? DATA.chess[id] : name === 'items' ? DATA.items[id] : null) || null;
    try {
      store.set({ match: emptyMatch(), room: null, me: { playerId: 'p', name: 'P', token: null } });
      store.patch('match', { public: { phase: PHASE.PREP } });
      prediction.reset();
      // main.js's m.private handler: the authoritative view flows through prediction.authoritative → the store
      store.patch('match', { private: prediction.authoritative(base()) });
      const { predicted } = prediction.submit('g.buy', { slot: 0 });
      assert.equal(predicted, true);
      assert.equal(store.get().match.private.funds, 8, 'the predicted view is in the store at once');
      assert.equal(store.get().match.private.hand[GEO.HAND_SIZE - 1].id, A);
      const after = base({ funds: 8, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(901, A)] });
      after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
      const v = prediction.authoritative(after);
      assert.equal(v, after);
      store.patch('match', { private: v }); // main.js's m.private handler
      assert.equal(store.get().match.private, after, 'the store holds the authoritative view');
      assert.equal(prediction.pending().length, 0);
      // the match is cleared (store.js emptyMatch on backToLobby): nothing of it may replay onto the next one
      prediction.submit('g.refresh');
      assert.ok(prediction.pending().length >= 0);
      store.set({ match: emptyMatch() });
      assert.equal(prediction.pending().length, 0, 'the store subscription reset the prediction');
      assert.equal(prediction.enabled, false);
    } finally {
      net.request = prevNet;
      data.lookup = prevLookup;
      store.set({ match: emptyMatch(), room: null, me: { playerId: null, name: '', token: null } });
    }
  });
});
