import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, checkInvariants } from './harness.js';
import { ERR } from '../../shared/constants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';

const ITEM = 'chess_item_5_02_e_a';
const GOLD = 'chess_item_5_02_e_b';
const MORPH = 'chess_item_6_09_e_a';
const grant = (h, id) => h.m.handle('p_0', { t: 'g.console', kind: 'item', id });
const items = (ps) => [...ps.hand, ...ps.temp, ...ps.allChess().flatMap((p) => p.items || [])].filter((p) => p?.kind === 'item');
const quiet = { info() {}, warn() {}, error() {} };

function prep(t, options = {}) {
  const h = makeMatch({ mode: 'solo', seed: 11, fake: true, consoleEnabled: true, ...options }).start().toPrep();
  t.after(() => h.m.dispose());
  return h;
}

for (const mode of ['solo', 'coop']) test(`${mode}: console equipment bypasses exhausted stock while its usage limits remain enforced`, (t) => {
  const h = prep(t, { mode, humans: mode === 'coop' ? 2 : 1 });
  const ps = h.ps('p_0'), holder = mode === 'coop' ? h.ps('p_1') : ps, pool = h.m.itemPool;
  for (let i = 0; i < pool.cap(ITEM); i++) assert.ok(holder.acquireItem(ITEM, { silent: true }));
  assert.equal(pool.left(ITEM), 0);
  for (const id of [ITEM, ITEM, ITEM, ITEM, GOLD]) {
    assert.deepEqual(grant(h, id), { ok: true });
    assert.equal(pool.held(ITEM), pool.cap(ITEM));
    assert.equal(pool.left(ITEM), 0);
  }
  assert.ok(items(ps).some((p) => p.id === GOLD && p.itemPoolCopies === 0));
  assert.equal(holder.acquireItem(ITEM), null, 'ordinary acquisition remains stock-limited');
  assert.equal(ps.consoleRoundUses, 5);
  assert.equal(ps.consoleTotalUses, 5);
  assert.equal(grant(h, ITEM).error, ERR.RATE);
  assert.match(h.lastBc('m.ticker').text, /通过控制台获得/);
  checkInvariants(h.m);
});

test('console and ordinary equipment merge with only the ordinary reservation in either acquisition order', (t) => {
  for (const order of ['console-first', 'ordinary-first']) {
    const h = prep(t), ps = h.ps('p_0'), pool = h.m.itemPool;
    if (order === 'console-first') {
      assert.deepEqual(grant(h, ITEM), { ok: true });
      assert.equal(items(ps).find((p) => p.id === ITEM).itemPoolCopies, 0);
      assert.equal(pool.held(ITEM), 0);
      assert.ok(ps.acquireItem(ITEM, { source: 'buy' }));
    } else {
      assert.ok(ps.acquireItem(ITEM, { source: 'buy' }));
      assert.deepEqual(grant(h, ITEM), { ok: true });
    }
    const gold = items(ps).find((p) => p.id === GOLD);
    assert.ok(gold);
    assert.equal(gold.itemPoolCopies, 1);
    assert.equal(pool.held(ITEM), 1);
    assert.deepEqual(h.m.handle('p_0', { t: 'g.destroy', uid: gold.uid }), { ok: true });
    assert.equal(pool.held(ITEM), 0);
    checkInvariants(h.m);
  }
});

test('console provenance survives equip, owner sale, direct upgrade and destruction without releasing teammate stock', (t) => {
  const h = prep(t, { mode: 'coop', humans: 2 }), ps = h.ps('p_0'), mate = h.ps('p_1'), pool = h.m.itemPool;
  for (let i = 0; i < pool.cap(ITEM); i++) assert.ok(mate.acquireItem(ITEM, { silent: true }));
  const ownerId = [...h.m.pool.entries.keys()].find((id) => h.m.gd.tierOf(id) === 1);
  const owner = give(h.m, ps, ownerId);
  assert.deepEqual(grant(h, MORPH), { ok: true });
  const morph = items(ps).find((p) => p.id === MORPH);
  assert.equal(morph.itemPoolCopies, 0);
  assert.ok(ps.equip(morph.uid, owner.uid).ok);
  assert.equal(pool.held(MORPH), 0);
  assert.ok(ps.sell(owner.uid).ok);
  assert.equal(ps.find(morph.uid).piece.itemPoolCopies, 0);
  assert.ok(ps.destroy(morph.uid).ok);
  assert.deepEqual(grant(h, ITEM), { ok: true });
  const item = items(ps).find((p) => p.id === ITEM);
  assert.ok(ps.upgradeItem(item));
  assert.equal(item.id, GOLD);
  assert.equal(item.itemPoolCopies, 0);
  assert.ok(ps.destroy(item.uid).ok);
  assert.equal(pool.left(ITEM), 0, 'console destruction never releases a teammate reservation');
  checkInvariants(h.m);
});

test('console equipment still needs preparation space and a permitted target; failed grants consume no quota', (t) => {
  const h = prep(t), ps = h.ps('p_0');
  for (const area of [ps.hand, ps.temp]) for (let i = 0; i < area.length; i++) {
    area[i] = ps.newPiece('item', GOLD, { itemPoolCopies: 0 });
  }
  assert.equal(grant(h, GOLD).error, ERR.HAND_FULL);
  assert.equal(grant(h, 'unknown').error, ERR.BAD_TARGET);
  assert.equal(ps.consoleRoundUses, 0);
  assert.equal(ps.consoleTotalUses, 0);
  assert.equal(h.m.itemPool.held(ITEM), 0);
  checkInvariants(h.m);
});

test('checkpoint restore preserves console and mixed equipment stock provenance and console quotas', (t) => {
  const first = prep(t), second = prep(t), ps = first.ps('p_0');
  assert.deepEqual(grant(first, MORPH), { ok: true });
  assert.ok(ps.acquireItem(ITEM));
  assert.deepEqual(grant(first, ITEM), { ok: true });
  const doc = snapshotMatch(first.m);
  assert.equal(restoreMatch(second.m, doc, { createRngFromState, log: quiet }), true);
  assert.equal(second.m.itemPool.held(MORPH), 0);
  assert.equal(second.m.itemPool.held(ITEM), 1);
  assert.deepEqual(snapshotMatch(second.m).players[0].hand, doc.players[0].hand);
  assert.equal(second.ps('p_0').consoleTotalUses, 2);
  assert.equal(second.ps('p_0').consoleRoundUses, 2);
  assert.deepEqual(grant(second, GOLD), { ok: true });
  assert.equal(second.m.itemPool.held(ITEM), 1);
  checkInvariants(second.m);
});
