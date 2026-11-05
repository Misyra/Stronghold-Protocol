// test/plugins/offer-guards.test.js — the engine-side guards of plugin interaction windows (PLUGIN API v2,
// docs/PLUGINS.md §10b): a prep window ends with the prep (no COMBAT picks), a declared variant must exist on the
// card, a display quote must agree with the item's own contract spec before the window loads, and the sandbox
// context cannot reach a writable GameData/RNG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from '../match/harness.js';
import { PHASE, ERR } from '../../shared/constants.js';
import { readOfferFile, readOfferCards } from '../../shared/plugins/offers.js';
import { makeCtx } from '../../server/match/effectsMeta.js';
import { getData } from '../../server/data.js';

/** One normalized window read through the real reader, so the test's shape is the shipped shape. */
function window_(extra = {}) {
  const raw = {
    offer: 1, id: 'guard', when: { at: ['prep'], rounds: [1] }, windowSec: 300, quorum: 'none',
    onTimeout: 'skip', slots: 1, options: { source: 'lib/cards.json' }, ...extra,
  };
  const r = readOfferFile(raw, { pluginId: 'guard', rel: 'offers/guard.json' });
  assert.deepEqual(r.problems, []);
  return r.offer;
}

function prepWithWindow(cards, extra = {}) {
  const offer = window_(extra);
  const pool = readOfferCards(cards, offer);
  assert.deepEqual(pool.problems, [], JSON.stringify(pool.problems));
  const w = { pluginId: 'guard', ...offer, cards: pool.cards };
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true, offers: [w], ...extra.match });
  return { h, w };
}

test('a prep window closes with the prep: COMBAT refuses a stale g.offer and grants nothing', () => {
  const { h } = prepWithWindow(['a', 'b'].map(id => ({ id, name: id, desc: 'Grant', icon: 'funds', apply: { funds: 1 } })));
  h.start();
  try {
    assert.ok(h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 1 && h.m.offerWin.length === 1, { ready: false }),
      'the prep window opened');
    const view = h.m.offerViews()[0], p = h.ps('p_0'), before = p.funds;
    const msg = { t: 'g.offer', offerId: view.id, pluginId: view.pluginId, seq: view.seq, idx: 0 };
    // The window is alive but the flow left the prep: the phase gate alone refuses the pick.
    h.m.phase = PHASE.COMBAT;
    assert.equal(h.m.handle(p.playerId, msg).error, ERR.WRONG_PHASE);
    assert.equal(p.funds, before);
    h.m.phase = PHASE.PREP;
    // endPrep settles and drops every window before the battle exists.
    h.m.endPrep();
    assert.equal(h.m.offerWin.length, 0, 'endPrep closed the window');
    assert.notEqual(h.m.phase, PHASE.PREP);
    assert.ok(h.m.handle(p.playerId, msg).error, 'a pick after endPrep is refused');
  } finally { h.m.dispose(); }
});

test('a card that declares variants must answer the requested key; a missing variant is BAD_TARGET, never a fallback', () => {
  const selector = { label: 'Amount', default: 'a', options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  const { h, w } = prepWithWindow([{ id: 'trade', name: 'Trade', desc: 'Grant', icon: 'funds', apply: { funds: 1 } }],
    { selector, windowSec: 300 });
  // Drop the reader's complete-variant requirement for one card: a stale/partial pool must fail closed.
  w.cards = [{ ...w.cards[0], variants: { a: { effect: { funds: 2 } } } }];
  h.start();
  try {
    assert.ok(h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 1 && h.m.offerWin.length === 1, { ready: false }));
    const view = h.m.offerViews()[0], p = h.ps('p_0'), before = p.funds;
    const msg = { t: 'g.offer', offerId: view.id, pluginId: view.pluginId, seq: view.seq, idx: 0 };
    assert.equal(h.m.handle(p.playerId, { ...msg, variantId: 'b' }).error, ERR.BAD_TARGET);
    assert.equal(p.funds, before);
    assert.deepEqual(h.m.handle(p.playerId, { ...msg, variantId: 'a' }), { ok: true });
    assert.equal(p.funds, before + 2);
  } finally { h.m.dispose(); }
});

test('a quote that disagrees with its item contract spec refuses the window at load', () => {
  const data = structuredClone(getData({ log: { warn() {}, error() {}, info() {} } }));
  const itemId = 'chess_item_1_03_e_a';
  assert.ok(data.items[itemId]);
  data.items[itemId] = { ...data.items[itemId], contract: { fraction: 0.5, multiplier: 2 } };
  const quote = (fraction, multiplier) => ({
    fraction, multiplier, debtCounter: 'test:debt', creditLimitCounter: 'test:credit',
  });
  const card = (fraction, multiplier) => ({
    id: 'bad', name: 'Bad', desc: 'Grant', icon: 'item', apply: { item: itemId }, quote: quote(fraction, multiplier),
  });
  const build = (fraction, multiplier) => {
    const offer = window_();
    const pool = readOfferCards([card(fraction, multiplier)], offer);
    assert.deepEqual(pool.problems, []);
    return { pluginId: 'guard', ...offer, cards: pool.cards };
  };
  const bad = makeMatch({ mode: 'coop', humans: 2, fake: true, data, offers: [build(0.1, 2)] }).start();
  try {
    bad.toPrep(1);
    assert.equal(bad.m.offerWin.length, 0, 'the mismatched window never opened');
    assert.equal(bad.m.offerViews().length, 0);
    assert.ok(bad.logs.error.some((line) => /refused: bad quote/.test(line)), JSON.stringify(bad.logs.error));
  } finally { bad.m.dispose(); }
  const good = makeMatch({ mode: 'coop', humans: 2, fake: true, data, offers: [build(0.5, 2)] }).start();
  try {
    good.toPrep(1);
    assert.equal(good.m.offerViews().length, 1, 'the matching window loads (non-blocking, still open in prep)');
    assert.deepEqual(good.logs.error, []);
  } finally { good.m.dispose(); }
});

test('the sandbox context exposes frozen read facades and no writable rngMeta', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true, seed: 3 }).start();
  try {
    const ps = h.ps('p_0');
    const ctx = makeCtx(h.m, ps, { kind: 'test', key: 'test' }, 'onRoundStart');
    assert.ok(Object.isFrozen(ctx));
    assert.ok(Object.isFrozen(ctx.data), 'the data table is frozen');
    assert.ok(Object.isFrozen(ctx.gd), 'the GameData facade is frozen');
    assert.equal(ctx.gd._items, undefined, 'private tables are not reachable');
    assert.equal(ctx.gd.matchData, undefined, 'a DIY view cannot hand back the match GameData');
    assert.throws(() => { ctx.gd = null; });
    assert.throws(() => { ctx.gd.raw = {}; });
    assert.ok(Object.isFrozen(ctx.rng));
    assert.equal('state' in ctx.rng, false);
    assert.equal('clone' in ctx.rng, false);
    assert.notEqual(ctx.rng, h.m.rngMeta);
    assert.throws(() => { ctx.rng.next = () => 0; });
    assert.ok(Number.isInteger(ctx.rng.int(10)));
    for (const mate of ctx.teammates()) assert.ok(Object.isFrozen(mate), 'a teammate view is frozen');
    assert.ok(Object.isFrozen(ctx.alivePlayers()[0]));
    assert.ok(Object.isFrozen(ctx.player(ps.playerId)));
  } finally { h.m.dispose(); }
});


test('stake limits must match the contract and over-limit requests are rejected before grant', () => {
  const data = structuredClone(getData());
  const itemId = 'chess_item_1_03_e_a';
  data.items[itemId] = { ...data.items[itemId], contract: { fraction: 1, multiplier: 3,
    stakeLimit: 3, multiplierLimitCounter: 'test:mult' } };
  for (const stakeLimit of [undefined, 10, 3]) {
    const w = window_({ slots: 2 });
    const quote = { fraction: 1, multiplier: 3, debtCounter: 'd', creditLimitCounter: 'c',
      multiplierLimitCounter: 'test:mult', ...(stakeLimit === undefined ? {} : { stakeLimit }) };
    const pool = readOfferCards([{ id: 'bet', name: 'Bet', desc: 'Limit', icon: 'item', apply: { item: itemId }, quote },
      { id: 'skip', name: 'Skip', desc: 'Skip', icon: 'funds', apply: { funds: 0 } }], w);
    assert.deepEqual(pool.problems, []);
    const h = makeMatch({ mode: 'coop', humans: 2, fake: true, data, offers: [{ pluginId: 'guard', ...w, cards: pool.cards }] }).start();
    try {
      h.toPrep(1);
      assert.equal(h.m.offerViews().length, stakeLimit === 3 ? 1 : 0);
      if (stakeLimit !== 3) continue;
      const ps = h.ps('p_0'); ps.counters['test:mult'] = 2;
      const view = h.m.offerViews()[0], slot = view.seats.find(s => s.playerId === ps.playerId).slots.find(c => c.id === 'bet');
      assert.equal(slot.available, false);
      const identity = { pluginId: 'guard', seq: view.seq, cardId: 'bet' };
      assert.ok(h.m.requestOffer(ps, view.id, slot.idx, identity).error);
      ps.counters['test:mult'] = 3;
      assert.equal(h.m.requestOffer(ps, view.id, slot.idx, identity).ok, true);
    } finally { h.m.dispose(); }
  }
});


test('normal-only windows follow the current mode boss and hidden schedule', () => {
  for (const options of [{ mode: 'solo', difficulty: 'TRAINING' }, { mode: 'solo', difficulty: 'FUNNY' }, { mode: 'coop', difficulty: 'NORMAL' }]) {
    const offer = window_({ when: { at: 'prep', rounds: 'any', normal: true } });
    const pool = readOfferCards([{ id: 'skip', name: 'Skip', desc: 'Skip', icon: 'funds', apply: { funds: 0 } }], offer);
    const h = makeMatch({ ...options, humans: 1, fake: true, offers: [{ pluginId: 'guard', ...offer, cards: pool.cards }] }).start();
    try {
      h.toPrep(1);
      assert.equal(h.m.offerViews().length, 1);
      h.m.offersDispose();
      for (const round of [h.m.gd.bossRound, h.m.gd.hiddenRound].filter(Number.isFinite)) {
        h.m.round = round;
        h.m.openOfferWindow('prep', round);
        assert.equal(h.m.offerViews().length, 0, `${options.mode}/${options.difficulty}/${round}`);
      }
    } finally { h.m.dispose(); }
  }
});
