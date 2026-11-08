// shared/poolPlan.js — the seat groups of a match's card pools: the automatic rule, and 手动指定卡池编组 (feedback #49, the
// room's experimental `poolPlan`). The server's pools (server/match/pool.js createPoolGroups) and the room's editor
// (public/js/ui/poolEditor.js) both read this file, so what the editor starts from is what a match would have built.
//
// A plan is one integer per room seat, seat order: plan[seat] is that seat's pool. Canonical form: pools numbered by first
// appearance from 0, so [1, 1, 0, 0] and [0, 0, 1, 1] are one layout and pool 0 always holds seat 0. A plan is the whole
// state: a pool exists because a seat is in it, so there is no empty pool to store.

import { MAX_SEATS } from './constants.js';

/**
 * How large a pool of `n` seats is against a complete ordinary pool: up to four seats keep exactly one, more scale with
 * the seats, as the automatic five-seat pool does (×5/4).
 */
export const poolScale = n => (n > MAX_SEATS ? n / MAX_SEATS : 1);

/** Whether `value` is a plan of a `capacity`-seat room, in any numbering. */
export function isPoolPlan(value, capacity) {
  if (!Array.isArray(value) || value.length !== capacity) return false;
  for (let i = 0; i < capacity; i++) if (!Number.isInteger(value[i]) || value[i] < 0 || value[i] >= capacity) return false;
  return true;
}

/** The plan with its pools numbered by first appearance. */
export function canonicalPoolPlan(plan) {
  const names = new Map();
  return plan.map(pool => {
    if (!names.has(pool)) names.set(pool, names.size);
    return names.get(pool);
  });
}

/** How many pools a plan has. */
export const poolCount = plan => new Set(plan).size;

/** The seats of each pool, by canonical pool number. */
export function poolSeats(plan) {
  const out = [];
  for (const [seat, pool] of canonicalPoolPlan(plan).entries()) (out[pool] ||= []).push(seat);
  return out;
}

/** `seats` (in order) split into chunks of `sizes`, as a plan of a `capacity`-seat room; a seat not listed follows the one before it. */
function chunkedPlan(capacity, seats, sizes) {
  const plan = new Array(capacity).fill(null);
  let offset = 0;
  sizes.forEach((size, pool) => { for (const seat of seats.slice(offset, offset += size)) plan[seat] = pool; });
  let last = 0;
  for (let seat = 0; seat < capacity; seat++) {
    if (plan[seat] == null) plan[seat] = last;
    else last = plan[seat];
  }
  return canonicalPoolPlan(plan);
}

/** `count` seats in `pools` balanced chunks, the earlier chunks the larger. */
const evenSizes = (count, pools) => Array.from({ length: pools }, (_, i) => Math.floor(count / pools) + (i < count % pools ? 1 : 0));

/**
 * The automatic rule, the chunk sizes of `count` seats in seat order. A five-seat experimental room shares one enlarged
 * pool; at six seats and above each balanced group keeps a complete ordinary pool, including three-seat groups (six seats:
 * 3 + 3, feedback #49). `legacySix`: a checkpoint from before that rule, whose six seats share one ×6/4 pool.
 * @param {number} count
 * @param {{ experimental?: boolean, independent?: boolean, fixedChunks?: boolean, legacySix?: boolean }} [opts]
 * @returns {{ sizes: number[], enlarged: boolean }}
 */
export function autoPoolSizes(count, { experimental = false, independent = false, fixedChunks = false, legacySix = false } = {}) {
  const chunked = experimental && fixedChunks && !independent;
  const enlarged = experimental && !independent && !chunked && (count === 5 || count === 6 && legacySix);
  const groups = independent ? count : chunked || experimental && !enlarged && count >= 6 ? Math.ceil(count / 4) : 1;
  const sizes = chunked ? Array.from({ length: groups }, (_, i) => Math.min(4, count - i * 4)) : evenSizes(count, groups);
  return { sizes, enlarged };
}

/**
 * What the automatic rule would build for a room, as a plan: where the editor starts. `seats`: the taken seats, once a room
 * is past a standard team and they decide its groups (an eight-seat room of six plays 3 + 3); a room still filling up is
 * laid out for its full capacity. An empty seat follows the seat before it.
 * @param {number} capacity
 * @param {{ seats?: number[], independent?: boolean }} [opts]
 */
export function autoPoolPlan(capacity, { seats = [], independent = false } = {}) {
  const all = Array.from({ length: capacity }, (_, seat) => seat);
  const taken = !independent && seats.length > MAX_SEATS ? seats.filter(seat => seat < capacity).sort((a, b) => a - b) : all;
  const { sizes } = autoPoolSizes(taken.length, { experimental: capacity > MAX_SEATS, independent, fixedChunks: capacity === 20 });
  return chunkedPlan(capacity, taken, sizes);
}

/** `pools` balanced pools over every seat, in seat order (the editor's 均分). */
export const evenPoolPlan = (capacity, pools) => chunkedPlan(capacity, Array.from({ length: capacity }, (_, seat) => seat), evenSizes(capacity, pools));

/** One pool more: the back half of the largest pool (the first of equals) becomes a new pool. A plan of single seats stays. */
export function splitPool(plan) {
  const groups = poolSeats(plan), largest = groups.reduce((best, seats) => (seats.length > best.length ? seats : best));
  if (largest.length < 2) return canonicalPoolPlan(plan);
  const next = canonicalPoolPlan(plan);
  for (const seat of largest.slice(Math.ceil(largest.length / 2))) next[seat] = groups.length;
  return canonicalPoolPlan(next);
}

/** One pool fewer: the last pool joins the one before it. A single pool stays. */
export function mergeLastPool(plan) {
  const next = canonicalPoolPlan(plan), last = poolCount(next) - 1;
  return canonicalPoolPlan(last < 1 ? next : next.map(pool => (pool === last ? last - 1 : pool)));
}

/** `seat` moved into `pool` (a canonical number). A pool left without seats is gone. */
export function moveSeat(plan, seat, pool) {
  const next = canonicalPoolPlan(plan);
  next[seat] = pool;
  return canonicalPoolPlan(next);
}
