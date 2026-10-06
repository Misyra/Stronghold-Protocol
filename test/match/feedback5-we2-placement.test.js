// test/match/feedback5-we2-placement.test.js — 0.2.0 WE2: where the 自选 summon pieces may be placed in prep.
// #22 望's 棋子 go on any tile class (PRTS 棋子 部署位置 "全部位", 备注 "游戏内召唤物信息与实际不符（显示为仅部署在近战位）").
// Run: node --test test/match/feedback5-we2-placement.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../../shared/constants.js';
import { FIELD, canPlace, placeClass, tileKey } from '../../server/match/board.js';
import { makeMatch, checkInvariants } from './harness.js';

const T5A = 'chess_char_5_diy1_a';
const WANG = 'char_2027_wang';
const STONE = 'token_10064_wang_stone1';

/** A solo match whose human slots `picks`, in its first prep on 战场#01 (3 高台 tiles) with an empty board and hand. */
function prep(picks, seed = 2101) {
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, diy: picks }];
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats, seed }).start();
  h.toPrep(1);
  h.setStage('act2autochess_m01');
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  ps.recompute();
  ps.funds = 100;
  return { h, m: h.m, ps };
}

/** Free tiles of the player's deploy map of class `cls` ('melee' | 'ranged'), reading order. */
function tilesOf(ps, cls) {
  const map = ps.deployMap();
  const out = [];
  for (let r = FIELD.r1; r >= FIELD.r0; r--) for (let c = FIELD.c0; c <= FIELD.c1; c++) {
    if (!ps.board.has(tileKey(r, c)) && map.get(tileKey(r, c)) === cls) out.push([r, c]);
  }
  return out;
}

/** Gain slot `slotId` (its 自选 operator) and place it on the first free tile of its class; returns the piece. */
function placeDiy(m, ps, slotId, at = null) {
  const piece = ps.acquireChess(slotId, { source: 'buy' });
  assert.ok(piece, `${slotId} gained`);
  const map = ps.deployMap();
  const pos = placeClass(ps, ps.gd.chess(slotId));
  let tile = at;
  for (let r = FIELD.r1; r >= FIELD.r0 && !tile; r--) for (let c = FIELD.c0; c <= FIELD.c1 && !tile; c++) {
    if (!ps.board.has(tileKey(r, c)) && canPlace(map, pos, r, c)) tile = [r, c];
  }
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: tile[0], col: tile[1] } }), { ok: true }, `${slotId} placed`);
  return piece;
}

test('#22 望\'s 棋子: a hand piece goes on a 高台 (ranged tile) as well as on the ground — PRTS 棋子 全部位', () => {
  const { m, ps } = prep({ [T5A]: { charId: WANG, skillIndex: 0 } });
  assert.equal(ps.gd.token(STONE).position, 'ALL');
  const wang = placeDiy(m, ps, T5A);
  const stack = ps.hand.find((p) => p && p.kind === 'token' && p.id === STONE && p.ownerUid === wang.uid);
  assert.ok(stack && stack.count === 6, 'her 6 棋子 joined the hand');
  const high = tilesOf(ps, 'ranged');
  const ground = tilesOf(ps, 'melee');
  assert.ok(high.length && ground.length, 'the stage has both tile classes');
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: stack.uid, to: { area: 'board', row: high[0][0], col: high[0][1] } }), { ok: true }, 'onto a 高台');
  const left = ps.hand.find((p) => p && p.kind === 'token' && p.id === STONE);
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: left.uid, to: { area: 'board', row: ground[0][0], col: ground[0][1] } }), { ok: true }, 'onto the ground');
  // still refused off the deploy map (a forbidden tile of the field)
  const map = ps.deployMap();
  let off = null;
  for (let r = FIELD.r1; r >= FIELD.r0 && !off; r--) for (let c = FIELD.c0; c <= FIELD.c1 && !off; c++) if (!map.get(tileKey(r, c)) && !ps.board.has(tileKey(r, c))) off = [r, c];
  if (off) {
    const again = ps.hand.find((p) => p && p.kind === 'token' && p.id === STONE);
    assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: again.uid, to: { area: 'board', row: off[0], col: off[1] } }), { error: ERR.BAD_TILE }, 'not a deployable tile');
  }
  checkInvariants(m);
  m.dispose();
});
