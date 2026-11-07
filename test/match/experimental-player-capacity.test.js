// test/match/experimental-player-capacity.test.js — 容量规则的 match 侧子集（移植自用户分支
// test/match/experimental-player-capacity.test.js 中不依赖边界外文件的部分；分组记账见 twenty-player-rules.test.js
// 的文件头。跨组信标赠礼 / 团队补充的逐组路由要等 effectsMeta / player 侧接线，见移植报告）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolGroups, SharedPool } from '../../server/match/pool.js';
import { makeMatch, DATA, capacityViolations } from './harness.js';

const exp = (playerCapacity = 20, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false, playerCapacity, ...extra });
const seats = count => Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true }));
const own = ps => [...ps.board.values(), ...ps.hand, ...ps.temp].filter(p => p?.kind === 'chess');
const clean = m => {
  for (const ps of m.order) {
    for (const p of own(ps)) ps.returnCopies(p);
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
    ps.bandId = null; ps.layers = {}; ps.funds = 50; ps.pendingFunds = 0; ps.recompute();
  }
};

for (const [count, sizes] of [[5, [4, 1]], [6, [4, 2]], [7, [4, 3]], [9, [4, 4, 1]], [20, [4, 4, 4, 4, 4]]]) {
  test(`${count} actual players: fixed balanced pool groups and copy conservation through grants/death`, t => {
    const h = makeMatch({ humans: count, experimental: exp(), seed: 713, fake: true }).start();
    const m = h.m; t.after(() => m.dispose()); h.toPrep(1); clean(m);
    assert.deepEqual(m.poolGroups.map(g => g.playerIds.length), sizes);
    assert.equal(m.publicView().playerCapacity, 20);
    assert.deepEqual(m.publicView().poolGroups.map(g => g.playerIds.length), sizes);
    const identities = m.order.map(p => p.pool);
    for (const group of m.poolGroups) for (const [base, entry] of group.pool.entries) {
      const expected = m.gd.poolCopies(base);
      assert.equal(entry.cap, expected, `${base}: complete copies in every group, including groups of three`);
    }
    const base = [...m.pool.entries.keys()].find(id => m.gd.chess(id).tier === 1);
    for (const ps of m.order) assert.ok(ps.acquireChess(base));
    const last = m.order.at(-1); last.eliminate(1);
    assert.deepEqual(m.order.map(p => p.pool), identities, 'death must not regroup surviving seats');
    // An accounting defect in ANY group, not just the diagnostic first pool, must be detected（capacityViolations
    // 的逐组核对：最后一组的 left + held != cap 出现在违规列表里；invariants.js 的分组化落地前用它替身，见报告）。
    const pool = m.poolGroups.at(-1).pool; pool.take(base);
    assert.ok(capacityViolations(m).some(v => v.includes('!= cap')));
    pool.give(base);
    assert.deepEqual(capacityViolations(m), []);
  });
}

for (const count of [5, 7, 20]) test(`${count} players: disableSharedPool takes priority over grouping/scaling`, t => {
  const h = makeMatch({ humans: count, experimental: exp(20, { disableSharedPool: true }), fake: true, seed: 4 });
  t.after(() => h.m.dispose());
  assert.equal(new Set(h.m.order.map(p => p.pool)).size, count);
  assert.equal(h.m.poolGroups.length, count);
  for (const ps of h.m.order) for (const [id, e] of ps.pool.entries) assert.equal(e.cap, h.m.gd.poolCopies(id));
  assert.deepEqual(capacityViolations(h.m), []);
});

test('createPoolGroups and SharedPool scale bounds', t => {
  const h = makeMatch({ humans: 4 }); t.after(() => h.m.dispose());
  assert.throws(() => createPoolGroups(h.m.gd, []), /1..20/);
  assert.throws(() => createPoolGroups(h.m.gd, seats(21)), /1..20/);
  assert.throws(() => new SharedPool(h.m.gd, { scale: Infinity }), /scale/);
  assert.throws(() => new SharedPool(h.m.gd, { scale: 0.5 }), /scale/);
  assert.throws(() => new SharedPool(h.m.gd, { scale: 6 }), /scale/);
  const one = createPoolGroups(h.m.gd, seats(4), { banned: [] });
  assert.deepEqual(one.map(g => [g.playerIds.length, g.scale]), [[4, 1]]);
  void DATA;
});
