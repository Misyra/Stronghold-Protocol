import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as offerUI from '../../public/js/ui/offerOverlay.js';
import { OfferView, offerPickable, offerSeat } from '../../public/js/ui/offerOverlay.js';
import { spTap } from '../../public/js/ui/choiceOverlay.js';
import { Button, Countdown } from '../../public/js/ui/components.js';

const offer = { id: 'pick', pluginId: 'demo', seq: 1, deadline: 10000, windowSec: 10, waiting: 2,
  seats: [{ playerId: 'p', picked: false, slots: [
    { idx: 0, id: 'one', name: '<script>bad</script>', desc: 'First description', icon: 'funds', remaining: 1 },
    { idx: 1, id: 'two', name: 'Second', desc: 'Second description', icon: 'item', remaining: 0 },
  ] }] };
function* walk(v) {
  if (Array.isArray(v)) { for (const c of v) yield* walk(c); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const nodes = props => [...walk(OfferView({ offer, myId: 'p', ...props }))];

test('native offer view renders source names/descriptions, timer, pick and bounded refresh controls', () => {
  const tree = nodes({});
  const cards = tree.filter(n => n.type === 'button');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].props['aria-label'], '<script>bad</script>');
  assert.ok(tree.some(n => n.props?.children === 'First description'));
  assert.ok(tree.some(n => n.type === Countdown && n.props.deadline === 10000));
  const refreshes = tree.filter(n => n.type === Button);
  assert.equal(refreshes.length, 1, 'zero-refresh controls are omitted');
  assert.equal(refreshes[0].props.disabled, false);
  assert.ok(tree.every(n => !n.props?.dangerouslySetInnerHTML));
});

test('selector renders the chosen variant and quotes actual escrow and symmetric losses from private funds', () => {
  const selector = { label: '倍率', default: 'x20', options: [{ id: 'x10', name: '1倍' }, { id: 'x30', name: '3倍' }] };
  const card = { ...offer.seats[0].slots[0], variants: {
    x10: { available: true, quote: { fraction: 1, multiplier: 1, debtCounter: 'debt', creditLimitCounter: 'limit' } },
    x30: { available: true, quote: { fraction: 1, multiplier: 3, debtCounter: 'debt', creditLimitCounter: 'limit' } },
  } };
  const priv = { funds: 20, counters: { debt: 0, limit: 20 } };
  assert.deepEqual(offerUI.offerCard(card, 'x30', priv).estimate, { stake: 10, requested: 20, amount: 30 });
  assert.deepEqual(offerUI.offerCard(card, 'x10', priv).estimate, { stake: 20, requested: 20, amount: 20 });
  assert.equal(offerUI.offerCard(card, 'x30', { funds: 10, counters: { debt: 20, limit: 20 } }).available, false);
  assert.equal(offerUI.offerCard(card, 'x10', { funds: 10, counters: { debt: 20, limit: 20 } }).available, true);
  const changed = [];
  const tree = nodes({ offer: { ...offer, selector, seats: [{ ...offer.seats[0], slots: [card] }] },
    priv, variantId: 'x30', onVariant: id => changed.push(id) });
  const group = tree.find(n => n.props?.role === 'group');
  assert.equal(group.props['aria-label'], '倍率');
  const buttons = [...walk(group)].filter(n => n.type === 'button');
  assert.equal(buttons[1].props['aria-pressed'], true);
  buttons[0].props.onClick();
  assert.deepEqual(changed, ['x10']);
  assert.ok(tree.some(n => n.props?.class === 'offerov__quote'));
  const spectator = nodes({ offer: { ...offer, selector, seats: [{ ...offer.seats[0], slots: [card] }] }, priv, myId: 'other' });
  assert.ok(!spectator.some(n => n.props?.class === 'offerov__quote'), 'never quotes another seat using local private data');
  const completed = nodes({ offer: { ...offer, selector, seats: [{ ...offer.seats[0], picked: true, slots: [card] }] }, priv });
  assert.ok(!completed.some(n => n.props?.class === 'offerov__quote'), 'a completed pick must not be repriced using its post-trade balance');
});

test('a picked seat keeps its selected variant when its counters drop after the pick', () => {
  const selector = { label: '倍率', default: 'x20', options: [{ id: 'x10', name: '1倍' }, { id: 'x30', name: '3倍' }] };
  const card = { ...offer.seats[0].slots[0], variants: {
    x10: { available: true, quote: { fraction: 1, multiplier: 1, debtCounter: 'debt', creditLimitCounter: 'limit' } },
    x30: { available: true, quote: { fraction: 1, multiplier: 3, debtCounter: 'debt', creditLimitCounter: 'limit' } },
  } };
  // the pick moved the counters: x30 no longer quotes against the post-trade balance
  const priv = { funds: 5, counters: { debt: 20, limit: 20 } };
  assert.equal(offerUI.offerCard(card, 'x30', priv).available, false, 'precondition: the picked variant no longer quotes');
  const tree = nodes({ offer: { ...offer, selector, seats: [{ ...offer.seats[0], picked: true, variantId: 'x30', slots: [card] }] },
    priv, variantId: 'x30' });
  const buttons = [...walk(tree.find(n => n.props?.role === 'group'))].filter(n => n.type === 'button');
  assert.equal(buttons[1].props['aria-pressed'], true, 'the confirmed variant stays displayed, not the first affordable one');
  assert.equal(buttons[0].props['aria-pressed'], false);
});

test('stake and multiplier bars update independently and calculate the selected fraction', () => {
  const selectors = [
    { label: '倍率', default: 'x2', options: [{ id: 'x1', name: '1倍' }, { id: 'x2', name: '2倍' }] },
    { label: '下注比例', default: 'half', options: [{ id: 'fifth', name: '1/5' }, { id: 'half', name: '1/2' }] },
  ];
  const card = { ...offer.seats[0].slots[0], variants: {
    'x2:fifth': { quote: { fraction: 0.2, multiplier: 2, debtCounter: 'debt', creditLimitCounter: 'limit' } },
  } };
  const changed = [];
  const tree = nodes({ offer: { ...offer, selectors, seats: [{ ...offer.seats[0], slots: [card] }] },
    variantId: 'x2:fifth', priv: { funds: 19, counters: { debt: 0, limit: 20 } }, onVariant: id => changed.push(id) });
  const groups = tree.filter(n => n.props?.role === 'group');
  assert.equal(groups.length, 2);
  [...walk(groups[0])].find(n => n.type === 'button').props.onClick();
  [...walk(groups[1])].filter(n => n.type === 'button')[1].props.onClick();
  assert.deepEqual(changed, ['x1:fifth', 'x2:half']);
  assert.deepEqual(offerUI.offerCard(card, 'x2:fifth', { funds: 19, counters: { debt: 0, limit: 20 } }).estimate,
    { stake: 3, requested: 3, amount: 6 });
});

test('two-tap/keyboard confirmation, busy state and spectator read-only behavior match choice cards', () => {
  assert.deepEqual(spTap(null, 0, true), { armed: 0, pick: null });
  assert.deepEqual(spTap(0, 0, true), { armed: null, pick: 0 });
  assert.equal(offerPickable(offer, 'p', false, null), true);
  assert.equal(offerPickable(offer, 'p', true, null), false);
  assert.equal(offerPickable(offer, 'p', false, 'busy'), false);
  assert.equal(offerSeat(offer, 'spectator'), null);
  for (const props of [{ readOnly: true }, { myId: 'spectator' }, { busy: 'sending' }]) {
    assert.ok(nodes(props).filter(n => n.type === 'button' || n.type === Button).every(n => n.props.disabled));
  }
});

test('a completed seat waits for its team with disabled picks and refreshes', () => {
  const tree = nodes({ offer: { ...offer, seats: [{ ...offer.seats[0], picked: true }] } });
  assert.ok(tree.filter(n => n.type === 'button' || n.type === Button).every(n => n.props.disabled));
  assert.match(JSON.stringify(tree.filter(n => n.props?.role === 'status').map(n => n.props.children)), /等待队友/);
});

test('offer dialog owns Escape/Tab, suppresses match shortcuts and permits large text scrolling', () => {
  const ui = readFileSync('public/js/ui/offerOverlay.js', 'utf8');
  const css = readFileSync('public/css/screens/game-panels.css', 'utf8');
  const game = readFileSync('public/js/screens/game.js', 'utf8');
  assert.match(ui, /e.key === 'Escape'/);
  assert.match(ui, /e.key !== 'Tab'/);
  assert.match(ui, /aria-modal="true"/);
  assert.match(game, /document.querySelector\('\.offerov\[role="dialog"\]'\)/);
  assert.match(css, /\.offerov \.spov__inner[^}]*overflow: auto/);
  assert.match(css, /\.offerov \.spcard__desc[^}]*overflow: visible/);
});


test('nonblocking windows release prep and completed seats while retaining a reopen control', () => {
  const pending = { ...offer, quorum: 'none' };
  const completed = { ...pending, seats: [{ ...pending.seats[0], picked: true }] };
  assert.equal(offerUI.offerBlocksPrep([pending]), false);
  assert.equal(offerUI.offerBlocksPrep([completed]), false);
  assert.equal(offerUI.offerVisible([pending], 'p'), pending);
  assert.equal(offerUI.offerVisible([pending], 'p', [pending.seq]), null, 'minimized until reopened');
  assert.equal(offerUI.offerVisible([pending], 'p', [pending.seq], { seq: pending.seq, picked: false }), pending);
  assert.equal(offerUI.offerVisible([completed], 'p', [], { seq: pending.seq, picked: false }), null, 'pick auto-collapses');
  assert.equal(offerUI.offerVisible([completed], 'p', [], { seq: completed.seq, picked: true }), completed);
  const blocking = { ...completed, seq: 2, quorum: 'all' };
  assert.equal(offerUI.offerBlocksPrep([pending, blocking]), true);
  assert.equal(offerUI.offerVisible([blocking], 'p', [2]), blocking, 'cannot dismiss a blocking window');
  const opened = [];
  const dock = [...walk(offerUI.OfferDock({ offers: [completed], myId: 'p', onOpen: o => opened.push(o.seq) }))];
  dock.find(n => n.type === Button).props.onClick();
  assert.deepEqual(opened, [completed.seq]);
});

test('prep editing and shortcuts depend on blocking state and the visible dialog', () => {
  const game = readFileSync('public/js/screens/game.js', 'utf8');
  assert.doesNotMatch(game, /const editable = !hasOffers/);
  assert.doesNotMatch(game, /hasPersonalChoice \|\| hasOffers\) && 'has-sp'/, 'minimized windows must not hide the prep bond/effect panels');
  assert.match(game, /const editable = !offerBlocksPrep\(pub\?\.offers\)/);
  assert.doesNotMatch(game, /if \(L.pub\?\.offers\?\.length\) return/);
  assert.match(game, /document.querySelector\('\.offerov\[role="dialog"\]'\)/);
});

test('unavailable cards cannot be picked but can still be refreshed', () => {
  const tree = nodes({ offer: { ...offer, seats: [{ ...offer.seats[0], slots: [{ ...offer.seats[0].slots[0], available: false }] }] } });
  assert.equal(tree.find(n => n.type === 'button').props.disabled, true);
  assert.equal(tree.find(n => n.type === Button).props.disabled, false);
  assert.ok(tree.some(n => n.props?.class === 'spcard__unavailable'));
});


test('fixed stakes cap savings and above-room multipliers are unavailable', () => {
  const card = { available: true, quote: { fraction: 1, multiplier: 2,
    debtCounter: 'debt', creditLimitCounter: 'credit', stakeLimit: 3, multiplierLimitCounter: 'mult' } };
  const priv = { funds: 100, counters: { debt: 0, credit: 20, mult: 2 } };
  assert.deepEqual(offerUI.offerCard(card, null, priv).estimate,
    { stake: 3, requested: 3, amount: 6, stakeLimit: 3 });
  assert.equal(offerUI.offerCard({ ...card, quote: { ...card.quote, multiplier: 3 } }, null, priv).available, false);
  assert.equal(offerUI.offerCard(card, null, { ...priv, funds: 2 }).estimate.stake, 2);
  assert.equal(offerUI.offerCard(card, null, { ...priv, counters: { ...priv.counters, credit: 1 } }).estimate.stake, 1);
  for (const mult of [undefined, NaN, Infinity]) {
    assert.equal(offerUI.offerCard(card, null, { ...priv, counters: { ...priv.counters, mult } }).available, false);
  }
  const slots = [{ ...card, variants: {
    'x1:s3': { quote: { ...card.quote, multiplier: 1 } },
    'x2:s3': { quote: { ...card.quote, multiplier: 2 } },
    'x3:s3': { quote: { ...card.quote, multiplier: 3 } },
  } }];
  const w = { selectors: [{ default: 'x2', options: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] },
    { default: 's3', options: [{ id: 's3' }] }] };
  assert.equal(offerUI.offerVariantAllowed(w, { slots }, 'x3:s3', priv), false);
  assert.equal(offerUI.offerAllowedVariant(w, { slots }, 'x2:s3', { ...priv, counters: { ...priv.counters, mult: 1 } }), 'x1:s3');
});


test('cash-only 5-unit quotes work without any credit counters and shrink only to available funds', () => {
  const card = { quote: { fraction: 1, multiplier: 2, stakeLimit: 5, multiplierLimitCounter:'max' } };
  for (const funds of [0,2,5,100]) {
    const result = offerUI.offerCard(card,null,{ funds, counters:{ max:2 } });
    assert.equal(result.estimate.stake, Math.min(5,funds));
    assert.equal(result.estimate.amount, Math.min(5,funds)*2);
    assert.equal(result.available, funds>0);
  }
});
