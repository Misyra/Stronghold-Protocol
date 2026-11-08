// ui/gameLogic/predict.js — what an accepted prep intent does to the own m.private, for the client-side prediction
// (移植自 Stardust-minus rel26 2d3ec08e; the owner's request of 2026-11-02: 商店购买、出售、部署、刷新 must not wait
// for the server under a high RTT or packet loss). ui/prediction.js applies these at once and replays them over every
// authoritative m.private until the view itself shows their effect — this port has no m.private `ack` (the fork's
// server echoed the handled intents' rids; server/ stays untouched), so each predicted op carries an `absorb`
// descriptor (what its effect looks like in a state) and ui/prediction.js drops it the moment a state matches.
// The server stays the only authority: a refused or different outcome is replaced by the next m.private.
//
// Only the DIRECT effects are predicted, mirroring server/match/player/economy.js (buy, sell, refresh, freeze,
// levelUp), placement.js (move) and pieces.js (_fillHandFromTemp — the temp overflow refills a freed hand slot
// right-to-left): funds, the shop slots (a level-up's new empty ones too, from the client's own mode data), the
// hand / temp / board pieces, the deploy count. What the server derives from them (bonds, effects, the layer
// forecast, summons granted on a deployment, pieces an effect grants, stats) and what needs its RNG (the cards a
// refresh rolls) stays as it was until the server's state lands — one RTT later.
// An intent whose outcome this cannot tell for sure returns null and is not predicted (it still goes to the server),
// or only its payment is: a buy that completes a merge (the elite, its tile, the 晋升奖励 offer; a golden item), a
// sale whose returned equipment would not fit the hand or would merge, a move of a summon or of an operator with
// summons, a move onto a summon.
//
// A piece bought by prediction has no server uid yet: it gets a negative placeholder uid (ui/prediction.js defers any
// intent naming it until the purchase is acknowledged and the real uid is known). The predicted piece carries no
// `skin`: this repo's m.private resolves skins server-side (player/views.js pieceView `skin`), so the bought card
// shows its default body until the state lands.

import { GEO } from '../../../../shared/constants.js';
import { handFull, completesMerge } from './shop.js';

/** The intents predicted here (ui/prediction.js submits them through one reconciler). */
export const PREDICTABLE = Object.freeze(['g.buy', 'g.sell', 'g.move', 'g.freeze', 'g.levelUp', 'g.refresh']);
const PREDICT_SET = new Set(PREDICTABLE);
export const isPredictable = (t) => PREDICT_SET.has(t);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const DIRS = new Set(['UP', 'RIGHT', 'DOWN', 'LEFT']);

/** A copy of the parts of m.private an intent may change (pieces are replaced, never edited in place). */
function cloneView(priv) {
  const shop = isObj(priv.shop) ? { ...priv.shop, slots: list(priv.shop.slots).slice() } : priv.shop;
  return { ...priv, shop, hand: list(priv.hand).slice(), temp: list(priv.temp).slice(), board: list(priv.board).slice() };
}

/** Where piece `uid` is: { area: 'hand'|'temp'|'board', idx, piece } or null. */
export function findPiece(priv, uid) {
  for (const area of ['hand', 'temp', 'board']) {
    const arr = list(priv?.[area]);
    for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].uid === uid) return { area, idx: i, piece: arr[i] };
  }
  return null;
}

/** Every piece uid of a view (hand, temp, board and the equipment on them). */
export function pieceUids(priv) {
  const out = new Set();
  for (const area of ['hand', 'temp', 'board']) {
    for (const p of list(priv?.[area])) {
      if (!p) continue;
      out.add(p.uid);
      for (const it of list(p.items)) if (it) out.add(it.uid);
    }
  }
  return out;
}

const hasTokens = (priv, uid) => ['hand', 'temp', 'board'].some((a) => list(priv?.[a]).some((p) => p && p.kind === 'token' && p.ownerUid === uid));
/** server/match/board.js freeSlot: the LAST free index (stow fills the hand from the right). */
function lastFree(arr, size = arr.length) {
  for (let i = Math.min(arr.length, size) - 1; i >= 0; i--) if (arr[i] == null) return i;
  return -1;
}
/** A hand / temp copy of a piece (container pieces carry no tile or facing). */
function benchCopy(p) {
  const { row, col, dir, ...rest } = p;
  return rest;
}
/** server boardOrder: bottom row first, left to right. */
const sortBoard = (board) => board.sort((a, b) => b.row - a.row || a.col - b.col);
const boardIdx = (board, row, col) => board.findIndex((p) => p && p.row === row && p.col === col);
const chessCount = (board) => board.filter((p) => p && p.kind === 'chess').length;

/** server/match/player/pieces.js _fillHandFromTemp: temp overflow refills the hand right-to-left (visible first, then
    the hidden queue), then the temp window compacts. A slot the deploy freed does not stay empty. */
function fillHandFromTemp(next) {
  const TEMP = GEO.TEMP_SIZE;
  const indices = Array.from({ length: TEMP }, (_, i) => TEMP - 1 - i)
    .concat(Array.from({ length: Math.max(0, next.temp.length - TEMP) }, (_, i) => TEMP + i));
  for (const j of indices) {
    const p = next.temp[j];
    if (!p) continue;
    const i = lastFree(next.hand, GEO.HAND_SIZE);
    if (i < 0) break;
    next.temp[j] = null;
    next.hand[i] = p;
  }
  if (next.temp.length > TEMP) {
    // Overflow refill order: the visible row right-to-left, then the hidden queue in arrival order.
    const pending = next.temp.slice(0, TEMP).reverse().concat(next.temp.slice(TEMP)).filter(Boolean);
    const t = new Array(TEMP).fill(null);
    pending.forEach((p, i) => { t[i < TEMP ? TEMP - 1 - i : i] = p; });
    next.temp = t;
  }
}

/** The sell price the server pays (server/match/gamedata.js sellPrice): the record's own `sellPrice` first, then the
    economy's chessPrice row (golden / normal), else 1. An effect's onSold price change arrives with the state. [ASSUMED] */
function sellPriceOf(L, id, golden) {
  const rec = typeof L.getChess === 'function' ? L.getChess(id) : null;
  if (Number.isFinite(rec?.sellPrice) && rec.sellPrice >= 0) return Math.trunc(rec.sellPrice);
  const v = typeof L.sellPrice === 'function' ? L.sellPrice(id, golden) : undefined;
  return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 1;
}

/**
 * The piece a prediction puts in the hand for a bought chess (the server's pieceView shape; `predicted` marks it).
 * @param {number} uid negative placeholder
 * @param {string} id chess id
 * @param {any} rec chess record or null
 * @param {string} [kind]
 */
function boughtPiece(uid, id, rec, kind = 'chess') {
  return { uid, kind, id, golden: !!rec?.isGolden, tier: Number.isInteger(rec?.tier) ? rec.tier : null, items: [], count: 1, ownerUid: null, predicted: true };
}

function buy(priv, { slot }, L, ph) {
  const s = list(priv.shop?.slots)[slot];
  if (!isObj(s) || s.sold) return null;
  const price = Number(s.price) || 0;
  const funds = Number(priv.funds) || 0;
  if (price > funds || handFull(priv)) return null;
  const next = cloneView(priv);
  next.funds = funds - price;
  next.shop.slots[slot] = { ...s, sold: true };
  const kind = s.kind === 'item' ? 'item' : 'chess';
  const rec = kind === 'item' ? L.getItem(s.id) : L.getChess(s.id);
  // a copy that completes a merge (acquireChess / acquireItem): the elite / golden item and where it goes are the server's
  if (!rec || completesMerge(priv, s, L)) return { priv: next };
  const idx = lastFree(next.hand, GEO.HAND_SIZE);
  if (idx < 0) return null;
  next.hand[idx] = boughtPiece(ph, s.id, rec, kind);
  return { priv: next, made: { uid: ph, area: 'hand', idx, id: s.id, kind }, absorb: { kind: 'buy', slot } };
}

function sell(priv, { uid }, L) {
  const loc = findPiece(priv, uid);
  if (!loc || loc.piece.kind !== 'chess') return null;
  const piece = loc.piece;
  const next = cloneView(priv);
  next[loc.area][loc.idx] = null;
  // its summons leave with it (removeTokensOf — board, hand and temp alike; nothing merges on a sale)
  for (const area of ['hand', 'temp', 'board']) next[area] = next[area].map((p) => (p && p.kind === 'token' && p.ownerUid === uid ? null : p));
  next.board = next.board.filter(Boolean);
  // its equipment goes back to the hand (stow); an item that would overflow or merge is the server's to place
  for (const it of list(piece.items)) {
    if (!it) continue;
    if (completesMerge(next, { kind: 'item', id: it.id }, L)) return null;
    const j = lastFree(next.hand, GEO.HAND_SIZE);
    if (j < 0) return null;
    const irec = L.getItem(it.id);
    next.hand[j] = { uid: it.uid, kind: 'item', id: it.id, golden: !!irec?.isGolden, tier: Number.isInteger(irec?.tier) ? irec.tier : null, items: [], count: 1, ownerUid: null };
  }
  const golden = !!L.getChess?.(piece.id)?.isGolden;
  next.funds = (Number(priv.funds) || 0) + sellPriceOf(L, piece.id, golden);
  next.deployCount = chessCount(next.board);
  fillHandFromTemp(next);
  return { priv: next, absorb: { kind: 'sell', uid } };
}

function move(priv, { uid, to, dir }) {
  const loc = findPiece(priv, uid);
  if (!loc || !isObj(to)) return null;
  const piece = loc.piece;
  if (piece.kind !== 'chess' || hasTokens(priv, uid)) return null;
  const next = cloneView(priv);
  const d = DIRS.has(dir) ? dir : (DIRS.has(to.dir) ? to.dir : 'RIGHT');
  if (to.area === 'board') {
    const { row, col } = to;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
    const oi = boardIdx(next.board, row, col);
    const occ = oi >= 0 ? next.board[oi] : null;
    if (occ && occ.uid === uid) {
      if (!DIRS.has(dir) && !DIRS.has(to.dir)) return { priv: next };
      if (occ.dir === d) return { priv: next };
      next.board[oi] = { ...occ, dir: d };
      return { priv: next, absorb: { kind: 'move', uid, to } };
    }
    if (occ && (occ.kind !== 'chess' || hasTokens(priv, occ.uid))) return null;
    if (loc.area === 'board') {
      // board → board: move or swap (the occupant keeps its own facing)
      const src = next.board[loc.idx];
      if (occ) next.board[oi] = { ...occ, row: src.row, col: src.col };
      next.board[loc.idx] = { ...src, row, col, dir: d };
      sortBoard(next.board);
      return { priv: next, absorb: { kind: 'move', uid, to } };
    }
    // hand / temp → board: a chess occupant goes back to the source slot (_putBack)
    if (!occ && (Number(priv.deployCount) || 0) >= (Number(priv.deployCap) || 0)) return null;
    const leftContainers = !occ; // a chess occupant refills the source slot (net 0); an empty target frees one
    next[loc.area][loc.idx] = occ ? benchCopy(occ) : null;
    if (oi >= 0) next.board.splice(oi, 1);
    next.board.push({ ...benchCopy(piece), row, col, dir: d });
    sortBoard(next.board);
    next.deployCount = chessCount(next.board);
    // the freed bench slot refills from temp, like the server's recompute
    if (leftContainers) fillHandFromTemp(next);
    return { priv: next, absorb: { kind: 'move', uid, to } };
  }
  if (to.area === 'hand') {
    const idx = to.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) return null;
    const occ = next.hand[idx] || null;
    if (occ && occ.uid === uid) return { priv: next };
    if (loc.area === 'board') {
      const src = next.board[loc.idx];
      if (!occ) {
        next.board.splice(loc.idx, 1);
        next.hand[idx] = benchCopy(src);
      } else if (occ.kind === 'chess') {
        // withdraw onto a bench card: it takes the tile with that tile's facing
        if (hasTokens(priv, occ.uid)) return null;
        next.board[loc.idx] = { ...benchCopy(occ), row: src.row, col: src.col, dir: src.dir || 'RIGHT' };
        next.hand[idx] = benchCopy(src);
        sortBoard(next.board);
      } else {
        const j = lastFree(next.hand, GEO.HAND_SIZE);
        if (j < 0) return null;
        next.board.splice(loc.idx, 1);
        next.hand[j] = benchCopy(src);
      }
      next.deployCount = chessCount(next.board);
      return { priv: next, absorb: { kind: 'move', uid, to } };
    }
    // hand / temp → hand slot: move or swap (_swapContainers)
    next[loc.area][loc.idx] = occ;
    next.hand[idx] = piece;
    return { priv: next, absorb: { kind: 'move', uid, to } };
  }
  return null;
}

function freeze(priv) {
  if (!isObj(priv.shop)) return null;
  const next = cloneView(priv);
  const on = !priv.shop.frozen;
  next.shop.frozen = on;
  next.shop.slots = next.shop.slots.map((s) => (isObj(s) && !s.sold ? { ...s, frozen: on } : s));
  return { priv: next, absorb: { kind: 'freeze', on } };
}

function levelUp(priv, L) {
  const shop = priv.shop;
  if (!isObj(shop)) return null;
  const level = Number(shop.level) || 1, max = Number(shop.maxLevel) || 6;
  if (level >= max) return null;
  const price = Math.max(0, Number(shop.upgradePrice) || 0);
  const funds = Number(priv.funds) || 0;
  if (funds < price) return null;
  const next = cloneView(priv);
  next.funds = funds - price;
  next.shop.level = level + 1;
  // this repo's m.private carries no shop.next (the fork's views.js added one): the next price and layout come from
  // the client's own mode data (ui/prediction.js shopConfig, mirroring server/match/gamedata.js); absent, the funds
  // and the level still predict and the rest is the server's state to correct. privateView sends 0 at the top level.
  const sc = typeof L.shopConfig === 'function' ? L.shopConfig() : null;
  if (level + 1 >= max) next.shop.upgradePrice = 0;
  else if (sc && typeof sc.upgradeBase === 'function') {
    const nup = sc.upgradeBase(level + 1);
    if (Number.isFinite(nup) && nup >= 0) next.shop.upgradePrice = Math.max(0, Math.trunc(nup));
  }
  if (sc && typeof sc.shopSlots === 'function') {
    const nl = sc.shopSlots(level + 1);
    if (isObj(nl) && Number.isInteger(nl.chess) && Number.isInteger(nl.item)) {
      // _openLevelSlots: the new slots open empty, operators before the equipment column
      const lay = isObj(shop.layout) && Number.isInteger(shop.layout.chess) ? shop.layout : { chess: next.shop.slots.length, item: 0 };
      if (nl.chess > lay.chess || nl.item > lay.item) {
        const chess = next.shop.slots.slice(0, lay.chess), items = next.shop.slots.slice(lay.chess);
        while (chess.length < Math.min(nl.chess, 8)) chess.push(null); // loop-cap: shopSlots chess max 8
        while (items.length < Math.min(nl.item, 4)) items.push(null); // loop-cap: shopSlots item max 4
        next.shop.slots = [...chess, ...items];
        next.shop.layout = { chess: chess.length, item: items.length };
      }
    }
  }
  return { priv: next, absorb: { kind: 'levelUp', level: level + 1 } };
}

/** The shop's slot identity (kind:id per slot) — what a refresh's roll changes and nothing else does. */
function slotsSig(slots) {
  return list(slots).map((s) => (isObj(s) ? `${s.kind}:${s.id}` : '-')).join(',');
}

function refresh(priv) {
  const shop = priv.shop;
  if (!isObj(shop)) return null;
  const freeLeft = Number(shop.freeRefreshes) || 0;
  const price = freeLeft > 0 ? 0 : Number(shop.refreshPrice) || 0;
  const funds = Number(priv.funds) || 0;
  if (freeLeft <= 0 && funds < price) return null;
  const next = cloneView(priv);
  if (freeLeft > 0) next.shop.freeRefreshes = freeLeft - 1;
  else next.funds = funds - price;
  // the new cards need the server's RNG: the slots stand empty (`rolling`) until its state lands; a manual refresh
  // cancels the freeze
  next.shop.frozen = false;
  next.shop.slots = next.shop.slots.map(() => null);
  next.shop.rolling = true;
  return { priv: next, absorb: { kind: 'refresh', free: freeLeft, sig: slotsSig(shop.slots) } };
}

/**
 * Whether view `v` already reflects what pending op `a` predicts (ui/prediction.js drops the op then — this port's
 * replacement for the fork's m.private `ack`). The descriptors are what predictIntent returns; a buy's is
 * base-independent ({ kind: 'buy', slot }).
 * @param {any} v
 * @param {{ kind: string, slot?: number, uid?: number, to?: any, on?: boolean, level?: number, free?: number, sig?: string } | null | undefined} a
 * @returns {boolean}
 */
export function absorbedView(v, a) {
  if (!a || !isObj(v)) return false;
  switch (a.kind) {
    case 'buy': return list(v.shop?.slots)[a.slot]?.sold === true;
    case 'sell': return findPiece(v, a.uid) == null;
    case 'move': {
      const loc = findPiece(v, a.uid);
      if (!loc) return true; // gone from the view entirely: nothing left to place
      if (a.to?.area === 'board') return loc.area === 'board' && loc.piece.row === a.to.row && loc.piece.col === a.to.col;
      if (a.to?.area === 'hand') return loc.area === 'hand' && loc.idx === a.to.idx;
      return false;
    }
    case 'freeze': return isObj(v.shop) && v.shop.frozen === a.on;
    case 'levelUp': return Number(v.shop?.level) >= a.level;
    case 'refresh': {
      const shop = v.shop;
      if (!isObj(shop)) return false;
      if ((Number(shop.freeRefreshes) || 0) < a.free) return true;
      return slotsSig(shop.slots) !== a.sig;
    }
    default: return false;
  }
}

/**
 * The view after one intent, or null when its outcome cannot be predicted for sure (see the header).
 * @param {any} priv m.private (authoritative or already predicted)
 * @param {{ t: string, fields?: any }} op
 * @param {{ getChess: (id: string) => any, getItem: (id: string) => any, sellPrice?: (id: string, golden: boolean) => number, shopConfig?: () => { upgradeBase?: (level: number) => number | null, shopSlots?: (level: number) => { chess: number, item: number } | null } | null }} L data lookups
 * @param {number} [ph] the placeholder uid a predicted purchase gives its piece
 * @returns {{ priv: any, made?: { uid: number, area: string, idx: number, id: string }, absorb?: object } | null}
 */
export function predictIntent(priv, op, L, ph = -1) {
  if (!isObj(priv) || !op) return null;
  const f = op.fields || {};
  switch (op.t) {
    case 'g.buy': return buy(priv, f, L, ph);
    case 'g.sell': return sell(priv, f, L);
    case 'g.move': return move(priv, f);
    case 'g.freeze': return freeze(priv);
    case 'g.levelUp': return levelUp(priv, L);
    case 'g.refresh': return refresh(priv);
    default: return null;
  }
}

/**
 * Every pending intent in order over an authoritative view. `ops[i].id` keys the placeholder each purchase made (its
 * uid is -id); an op whose `absorb` the current base already reflects is skipped (never applied twice).
 * @param {any} auth
 * @param {{ id: number, t: string, fields?: any, absorb?: any }[]} ops
 * @param {{ getChess: Function, getItem: Function, sellPrice?: Function, shopConfig?: Function }} L
 * @returns {{ priv: any, made: Map<number, { uid: number, area: string, idx: number, id: string }>, applied: Set<number>, absorb: Map<number, object> }}
 */
export function replayIntents(auth, ops, L) {
  let v = auth;
  const made = new Map(), applied = new Set(), absorb = new Map();
  for (const op of ops) {
    if (absorbedView(v, op.absorb)) continue;
    const r = predictIntent(v, op, L, -op.id);
    if (!r) continue;
    v = r.priv;
    applied.add(op.id);
    absorb.set(op.id, r.absorb || op.absorb || null);
    if (r.made) made.set(op.id, r.made);
  }
  return { priv: v, made, applied, absorb };
}

/**
 * The server uid of a predicted purchase's piece, once a state that contains the purchase arrived: the new piece of the
 * same kind and id in the hand slot the prediction used, else the only new chess of that id anywhere; null when there is none
 * or more than one (a merge consumed it, or two such purchases landed together).
 * @param {any} auth the new authoritative view
 * @param {Set<number>} before the piece uids of the previous authoritative view
 * @param {{ idx: number, id: string, kind?: string }} made
 * @returns {number | null}
 */
export function resolveBought(auth, before, made) {
  const kind = made.kind || 'chess';
  const fresh = (p) => p && p.kind === kind && p.id === made.id && !before.has(p.uid);
  const at = list(auth?.hand)[made.idx];
  if (fresh(at)) return at.uid;
  const found = ['hand', 'temp', 'board'].flatMap((a) => list(auth?.[a]).filter(fresh));
  return found.length === 1 ? found[0].uid : null;
}
