// Community report of 2026-10-06 「凯瑟琳装备池没有超出商店等级的装备，原版凯瑟琳1升2都能有6本装备」 (item 43): the 凯瑟琳 strategy
// (定向投放, up_shop_add_special_goods {count 3, choice 1, pool pool_equip_kathe}) offered only items up to the shop level —
// data/choices.json pool_equip_kathe maxTier 'shopLevel', an [ASSUMED] cap (the pool is server-side). The players' first-hand
// account: tier VI items show at the 1 → 2 upgrade. The pool is every shop-eligible item now (uniform [ASSUMED]).
// GitHub #631 (2026-10-14) 「凯瑟琳盟约刷不出突变细胞」: 原版凯瑟琳盟约 refreshes 突变细胞 (针) like any other 装备, at any shop
// level. The needle is never sold (tools/build-data.mjs SHOP_EXCLUDED_ITEMS), so the pool names it in `plus` — its one
// effect-only item (the 4 special 维式重锤 are not in it, no source says so [ASSUMED]); 昆图斯's fixed gift is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA } from './harness.js';

const NEEDLE = 'chess_item_5_08_e_a'; // 突变细胞

test('凯瑟琳 定向投放: the level 1 → 2 offer draws from every tier, 突变细胞 the one item the shop never sells', () => {
  assert.equal(DATA.choices.pools.pool_equip_kathe.maxTier, undefined, 'no shop-level cap in the data');
  const tiers = new Map();
  for (let seed = 1; seed <= 12; seed++) {
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed, fake: true }).start();
    h.toPrep(1, { band: 'band_cathy' });
    const ps = h.ps('p_0');
    ps.funds = 50;
    assert.deepEqual(h.m.handle('p_0', { t: 'g.levelUp' }), { ok: true });
    assert.equal(ps.shop.level, 2);
    const offer = ps.offers[ps.offers.length - 1];
    assert.ok(offer, `seed ${seed}: an offer`);
    const ids = (offer.slots ?? []).filter((s) => s && s.kind === 'item').map((s) => s.id);
    assert.equal(ids.length, 3, `seed ${seed}: 3 items`);
    for (const id of ids) {
      const rec = h.m.gd.item(id);
      assert.ok(rec && (!rec.shopExcluded || id === NEEDLE), `seed ${seed}: ${id} is a shop item or 突变细胞`);
      tiers.set(rec.tier, (tiers.get(rec.tier) || 0) + 1);
    }
    h.m.dispose();
  }
  assert.ok([...tiers.keys()].some((t) => t > 2), `items above the shop level (the parent: tiers I–II only) — ${JSON.stringify([...tiers])}`);
  assert.ok(tiers.has(6), 'tier VI among them');
});

// #631 end to end: the needle is offered by the real band hook (up_shop_add_special_goods → rollItems → ctx.rollPool), not
// just by the pool roller; 40 matches × 5 upgrades, and it stays the one slot outside the shop table
test('凯瑟琳 定向投放: 突变细胞 reaches the offer, nothing else outside the shop (GitHub #631)', () => {
  const offers = new Map();
  let slots = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed, fake: true }).start();
    h.toPrep(1, { band: 'band_cathy' });
    const ps = h.ps('p_0');
    ps.funds = 50;
    for (let lvl = 2; lvl <= 6; lvl++) {
      ps.shop.upgradePrice = 0;
      assert.deepEqual(h.m.handle('p_0', { t: 'g.levelUp' }), { ok: true }, `seed ${seed} L${lvl}`);
      const offer = ps.offers[ps.offers.length - 1];
      for (const s of (offer.slots ?? []).filter((x) => x && x.kind === 'item')) {
        slots++;
        if (s.id === NEEDLE || DATA.items[s.id].shopExcluded) offers.set(s.id, (offers.get(s.id) || 0) + 1);
      }
    }
    h.m.dispose();
  }
  assert.equal(slots, 40 * 5 * 3, 'three items per 定向投放');
  assert.ok((offers.get(NEEDLE) || 0) > 0, `突变细胞 offered (${offers.get(NEEDLE) || 0} of ${slots} slots)`);
  assert.deepEqual([...offers.keys()].filter((id) => id !== NEEDLE), [], 'no other effect-only item is offered');
});
