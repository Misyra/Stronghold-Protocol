// Family Crest timing through the real Battle damage/status pipeline. Synthetic fixtures below isolate boundaries;
// the Provence case uses real operator kits and natural attacks on a stationary synthetic enemy, not a UI match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';

const CREST = 'chess_item_6_11_e_a';
const SUIT = 'chess_item_3_01_e_a';
const KEY = `item:${CREST}:stealth`;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);
const crestHits = (h) => h.hooksOf('damaged').filter((c) => c.dmg?.tags?.includes('item:crest'));
const hit = (h, amount = 100, extra = {}) => h.b.dealDamage(h.unit(1), h.enemy('enemy_dummy'), { amount, type: 'true', canDodge: false, ...extra });

function fixture(items = [CREST, SUIT], bonds = ['siracusaShip']) {
  const h = makeBattle({
    units: [{ uid: 1, chessId: 'test_crest', row: 10, col: 4, items }],
    defs: {
      chess: { test_crest: chessRec({ id: 'test_crest', bonds, rangeGrid: [[0, 0]], skill: null }) },
      enemies: { dummy: enemyRec({ key: 'dummy', hp: 1e7, atk: 0, speed: 0 }) },
    },
    enemies: [{ key: 'dummy', pos: [10, 9] }], autoFinish: false, captureNoisy: true,
  });
  h.step();
  h.b.applyStatus(h.unit(1), 'stealth', { duration: 20 });
  h.run(1);
  return h;
}

test('Family Crest consumes the first damage immediately after stealth is removed, with either item quality', () => {
  for (const crest of [CREST, CREST.replace('_a', '_b')]) for (const suit of [null, SUIT, SUIT.replace('_a', '_b')]) {
    const h = fixture(suit ? [crest, suit] : [crest]);
    const u = h.unit(1), atk = u.s.atk;
    assert.ok(atk > u.base.atk);
    h.b.removeBuff(u, 'stealth');
    const hp = h.enemy('enemy_dummy').hp;
    hit(h);
    close(hp - h.enemy('enemy_dummy').hp, 100 + (suit ? atk * 8 : 0));
    close(u.s.atk, u.base.atk);
    assert.equal(crestHits(h).length, suit ? 1 : 0);
    hit(h);
    assert.equal(crestHits(h).length, suit ? 1 : 0, 'the second damage cannot reuse the charge');
    checkInvariants(h.b);
    assert.deepEqual(h.b.errors, []);
  }
});

test('Family Crest ignores damage while stealth is active, including after a polled exit and re-entry', () => {
  const h = fixture(), u = h.unit(1);
  const atk = u.s.atk;
  hit(h);
  close(u.s.atk, atk);
  h.b.removeBuff(u, 'stealth');
  h.run(0.3); // The old poll has armed the charge, but a new stealth period still protects it.
  h.b.applyStatus(u, 'stealth', { duration: 20 });
  hit(h);
  assert.equal(crestHits(h).length, 0);
  close(u.s.atk, atk);
  h.b.removeBuff(u, 'stealth');
  hit(h);
  assert.equal(crestHits(h).length, 1);
  close(u.s.atk, u.base.atk);
});

test('Family Crest does not re-arm the spent charge at the next poll, and can charge again under new stealth', () => {
  const h = fixture(), u = h.unit(1);
  h.b.removeBuff(u, 'stealth');
  hit(h);
  h.run(0.3);
  hit(h);
  assert.equal(crestHits(h).length, 1);
  h.b.applyStatus(u, 'stealth', { duration: 20 });
  h.run(0.3);
  const atk = u.s.atk;
  assert.ok(atk > u.base.atk);
  h.b.removeBuff(u, 'stealth');
  hit(h);
  assert.equal(crestHits(h).length, 2);
  close(crestHits(h)[1].amount, atk * 8);
});

test('Family Crest preserves the charge for zero damage, item proc damage and damage from another source', () => {
  const h = fixture(), u = h.unit(1), e = h.enemy('enemy_dummy'), atk = u.s.atk;
  h.b.removeBuff(u, 'stealth');
  hit(h, 0);
  hit(h, 100, { tags: ['item', 'item:probe'] });
  h.b.dealDamage(null, e, { amount: 100, type: 'true' });
  close(u.s.atk, atk);
  assert.equal(crestHits(h).length, 0);
  hit(h);
  assert.equal(crestHits(h).length, 1);
  close(crestHits(h)[0].amount, atk * 8);
});

test('Family Crest claims the charge before synchronous ordinary damage re-enters from its combo', () => {
  const h = fixture(), u = h.unit(1), atk = u.s.atk;
  h.b.removeBuff(u, 'stealth');
  let nested = 0;
  h.b.on('damaged', (c) => {
    if (c.dmg?.tags?.includes('item:crest')) { nested++; hit(h, 7); }
  }, { priority: 100 });
  const hp = h.enemy('enemy_dummy').hp;
  hit(h);
  assert.equal(nested, 1);
  close(hp - h.enemy('enemy_dummy').hp, 100 + atk * 8 + 7);
  close(u.s.atk, u.base.atk);
  assert.deepEqual(h.b.errors, []);
});

test('Family Crest discards the charge on leaving the field and does not grant it to a non-member', () => {
  const h = fixture(), u = h.unit(1);
  h.b.removeBuff(u, 'stealth');
  h.b.retreat(u);
  hit(h); // An already flying hit from the departed source must not spend an old charge.
  assert.equal(crestHits(h).length, 0);
  assert.equal(u.findBuff(KEY), null);
  assert.ok(h.b.redeploy(u));
  hit(h);
  assert.equal(crestHits(h).length, 0);
  close(u.s.atk, u.base.atk);
  const other = fixture([CREST, SUIT], []);
  close(other.unit(1).s.atk, other.unit(1).base.atk);
  other.b.removeBuff(other.unit(1), 'stealth');
  hit(other);
  assert.equal(crestHits(other).length, 0);
});

test('Family Crest + suit triggers on Provence\'s first natural attack after six-Siracusa stealth (2 layers)', () => {
  const ordinary = [], combo = [], transitions = [];
  let previous = false;
  const h = makeBattle({
    units: [
      { uid: 1, chessId: 'chess_char_1_07_a', row: 10, col: 4, items: [CREST, SUIT] },
      { uid: 2, chessId: 'chess_char_1_08_a', row: 9, col: 2 },
      { uid: 3, chessId: 'chess_char_2_16_a', row: 9, col: 3 },
      { uid: 4, chessId: 'chess_char_3_15_a', row: 10, col: 2 },
      { uid: 5, chessId: 'chess_char_3_18_a', row: 9, col: 4 },
      { uid: 6, chessId: 'chess_char_3_19_a', row: 9, col: 5 },
    ],
    bonds: { siracusaShip: { count: 6, active: true, tier: 2, layers: 2 } },
    defs: { enemies: { dummy: enemyRec({ key: 'dummy', hp: 1e8, atk: 0, speed: 0 }) } },
    enemies: [{ key: 'dummy', pos: [10, 5] }], timeLimit: 45, autoFinish: false,
    flags: { startOpCooldown: 3 },
    setup(b) {
      b.on('damaged', (c) => {
        if (c.source?.uid !== 1 || !(c.amount > 0)) return;
        const tags = c.dmg?.tags ?? [];
        if (tags.includes('item:crest')) combo.push({ t: b.time, amount: c.amount });
        else if (!tags.some((s) => s === 'item' || s === 'addition' || s.startsWith('bond:')) && !c.source.s.flags.stealth) {
          ordinary.push({ t: b.time, atk: c.source.s.atk });
        }
      }, { priority: 1000 });
      b.on('tick', () => {
        const active = !!b.allies().find((u) => u.uid === 1)?.s.flags.stealth;
        if (active !== previous) { transitions.push({ t: b.time, active }); previous = active; }
      });
    },
  });
  h.run(44);
  const exit = transitions.find((c) => !c.active);
  assert.ok(exit, 'six-Siracusa stealth expires');
  const hits = ordinary.filter((c) => c.t >= exit.t);
  assert.ok(hits.length >= 2);
  assert.equal(combo.length, 1);
  close(combo[0].t, hits[0].t);
  close(combo[0].amount, hits[0].atk * 8);
  assert.equal(h.unit(1).findBuff(KEY), null);
  checkInvariants(h.b);
  assert.deepEqual(h.b.errors, []);
});
