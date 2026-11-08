// The room's experimental battle rules (shared/experimental.js, 移植自 Stardust fork
// test/match/experimental-limits.test.js 的规则子集): disableLayerCap lifts the 999 bond-layer cap
// (BOND_LAYER_SAFE_MAX instead), disableHitLimit lifts 限伤 (BOSS_HIT_LIMIT). Both ride on the spec as flags
// (_ruleFlags), so the Worker, a browser's local replica, a client-run field and the match's own writers fight the
// same battle; a room without them keeps every old shape (the capped guards: playtest6-limits, layercap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOND_LAYER_SAFE_MAX, BOND_LAYER_CAP, BOSS_HIT_LIMIT, PHASE, layerGainRoom, milestonesDue } from '../../shared/constants.js';
import { validateClientResult } from '../../server/match/fields.js';
import { collectViolations } from '../../server/match/invariants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { SharedBossPool } from '../../server/match/finalAssault.js';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { makeMatch } from './harness.js';

const LIMIT = BOSS_HIT_LIMIT;
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const LIFTED = rules({ disableLayerCap: true, disableHitLimit: true });
const DEPS = { createRngFromState, log: { warn() {}, info() {}, error() {}, debug() {} } };

/** A solo match (fake battles) at PREP R1 with an empty layer table. */
function prepMatch(t, experimental, o = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 171, fake: true, experimental, ...o }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.layers = {};
  ps.recompute();
  return { h, m: h.m, ps };
}

test('layerGainRoom uncapped: only the safety bound stops a count; the capped form is unchanged', () => {
  assert.equal(layerGainRoom(995, 10, true), 10);
  assert.equal(layerGainRoom(999, 1, true), 1);
  assert.equal(layerGainRoom(1500, Infinity, true), BOND_LAYER_SAFE_MAX - 1500);
  assert.equal(layerGainRoom(BOND_LAYER_SAFE_MAX - 1, 5, true), 1);
  assert.equal(layerGainRoom(BOND_LAYER_SAFE_MAX, 1, true), 0);
  assert.equal(layerGainRoom(995, 10), 4);
  assert.equal(layerGainRoom(995, 10, false), 4);
  assert.ok(Number.isSafeInteger(BOND_LAYER_SAFE_MAX));
  assert.equal(BOND_LAYER_CAP, 999);
});

test('milestonesDue: floor(layers / step); a lifted room stops where an official match does', () => {
  assert.equal(milestonesDue(2500, 100), 25);
  assert.equal(milestonesDue(2500, 100, false), 25, 'a capped room is unchanged');
  assert.equal(milestonesDue(2500, 100, true), 9, '999 layers would have paid 9');
  assert.equal(milestonesDue(500, 100, true), 5, 'below the cap the count is the same');
  assert.equal(milestonesDue(0, 100, true), 0);
  assert.equal(milestonesDue(2500, 0, true), 0);
});

test('prep: a gain passes 999 in a room that lifted the cap, views and invariants agree; other rooms stop at 999', (t) => {
  const { m, ps } = prepMatch(t, rules({ disableLayerCap: true }));
  assert.equal(ps.addLayers('yanShip', 1500), 1500);
  assert.equal(ps.addLayers('yanShip', 100), 100);
  assert.equal(ps.privateView().bonds.find((b) => b.bondId === 'yanShip').layers, 1600);
  assert.deepEqual(collectViolations(m), []);
  assert.equal(ps.addLayers('kjeragShip', 5e9), BOND_LAYER_SAFE_MAX, 'the safety bound');
  assert.equal(ps.addLayers('kjeragShip', 1), 0);
  assert.deepEqual(collectViolations(m), []);
  ps.layers.kjeragShip = BOND_LAYER_SAFE_MAX + 1;
  assert.ok(collectViolations(m).some((v) => /kjeragShip layers/.test(v)), 'past the safety bound is still a violation');
  const capped = prepMatch(t, rules());
  assert.equal(capped.ps.addLayers('yanShip', 1500), 999);
});

test('settle: in-battle gains merge past 999 in a room that lifted the cap', (t) => {
  const script = (b) => (b.kind === 'normal' ? { duration: 1, layerGains: { p_0: { yanShip: 50 } } } : {});
  const { h, ps } = prepMatch(t, rules({ disableLayerCap: true }), { script });
  ps.layers.yanShip = 980;
  ps.recompute();
  h.toPrep(2);
  assert.equal(ps.layers.yanShip, 1030);
  const capped = prepMatch(t, rules(), { script });
  capped.ps.layers.yanShip = 980;
  capped.ps.recompute();
  capped.h.toPrep(2);
  assert.equal(capped.ps.layers.yanShip, 999);
});

test('client-result check: layerCapOff lifts only the room left under 999, the per-round bound stays', (t) => {
  const { m } = prepMatch(t, rules({ disableLayerCap: true }));
  const spec = (flags) => ({ kind: 'normal', round: 5, timeLimit: 60, spawns: [], flags: { layerGainsEnabled: true, ...flags },
    players: [{ playerId: 'p_0', units: [], bonds: { yanShip: { count: 3, active: true, tier: 1, layers: 990 } } }] });
  const res = (n) => ({ reason: 'cleared', time: 10, perPlayer: { p_0: { killed: 0, total: 0, leaked: [], perfect: true, layerGains: { yanShip: n }, coins: 0, unitsEnd: [], unitStats: [] } } });
  assert.deepEqual(validateClientResult(spec({}), res(10), { gd: m.gd }), { ok: false, reason: 'layer bound' });
  assert.equal(validateClientResult(spec({ layerCapOff: true }), res(10), { gd: m.gd }).ok, true);
  assert.deepEqual(validateClientResult(spec({ layerCapOff: true }), res(81), { gd: m.gd }), { ok: false, reason: 'layer bound' }, '60 + 4·5');
});

test('spec flags: every battle spec of a room with the rules carries them; other rooms carry neither', (t) => {
  for (const [experimental, flags] of [[LIFTED, { layerCapOff: true, hitLimitOff: true }], [rules({ disableLayerCap: true }), { layerCapOff: true }],
    [rules({ disableHitLimit: true }), { hitLimitOff: true }], [rules(), {}]]) {
    const { h, m, ps } = prepMatch(t, experimental);
    assert.deepEqual(m._ruleFlags(), flags);
    const normal = m._normalOpts(ps).flags;
    assert.deepEqual(normal, { layerGainsEnabled: true, ...m.gd.dp, ...flags });
    // the Final Assault's spec (a real battle construction, server-run): the leaders' field reads hitLimitOff there
    m.clientCombat = false;
    const seen = [];
    const orig = m.newBattle.bind(m);
    m.newBattle = (opts, o) => { seen.push(opts); return orig(opts, o); };
    m.phase = PHASE.PREP; m.round = m.gd.bossRound;
    m.bossId = 'boss_6';
    for (const p of m.order) { p.lp = 200; p.bandId = 'band_bldsk'; p.round = m.round; p.invalidateDeployMap(); }
    m.startFinalAssault(false);
    assert.ok(seen.length > 0, 'a boss battle was constructed');
    for (const opts of seen) {
      assert.equal(opts.flags.layerCapOff, flags.layerCapOff);
      assert.equal(opts.flags.hitLimitOff, flags.hitLimitOff);
    }
    m.dispose();
    assert.equal(h.ended, null);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// the battle side: 限伤 off and the live layer copy past 999

const guardRec = () => chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 10, maxHp: 1e9 }, skill: null });
/** A boss field with a leader (tag 'boss') and an operator, over a shared pool; `flags` rides on the spec. */
function hitField({ flags = {} } = {}) {
  const pool = new SharedBossPool(5e6);
  const h = makeBattle({
    kind: 'boss', sharedBoss: pool, flags,
    defs: {
      chess: { t_guard: guardRec() },
      enemies: { enemy_lead: enemyRec({ key: 'enemy_lead', rank: 'BOSS', hp: 1e9, speed: 0 }) },
    },
    players: [{ playerId: 'P', seat: 0, side: 'L', colOffset: 0, units: [{ uid: 1, chessId: 't_guard', row: 10, col: 2 }], bonds: {}, playerEffects: [] }],
    enemies: [{ key: 'enemy_lead', pos: [3, 9], tag: 'boss' }],
    content: 'none', autoFinish: false,
  });
  h.step();
  const leader = h.enemy('enemy_lead');
  assert.ok(leader && leader.isBoss, 'the leader is a boss unit');
  return { h, b: h.b, leader, op: h.unit(1), pool };
}

test('hitLimitOff: a leader hit at the line lands in full and credits the pool; without the flag it is cancelled', () => {
  const off = hitField({ flags: { hitLimitOff: true } });
  assert.equal(off.b.dealDamage(off.op, off.leader, { amount: LIMIT, type: 'true' }), LIMIT, 'cancelled no more');
  assert.equal(off.pool.hp, 5e6 - LIMIT, 'the pool took the hit');
  assert.equal(off.pool.byPlayer.get('P'), LIMIT);
  const on = hitField({});
  assert.equal(on.b.dealDamage(on.op, on.leader, { amount: LIMIT, type: 'true' }), 0, 'the default still cancels');
  assert.equal(on.pool.hp, 5e6, 'the pool is untouched');
});

test('layerCapOff: Battle.addLayers (the live copy) passes 999; without the flag it stops there', () => {
  const bonds = { yanShip: { count: 3, active: true, tier: 1, layers: 990 } };
  const off = makeBattle({ flags: { layerCapOff: true },
    defs: { chess: { t_guard: guardRec() } },
    players: [{ playerId: 'P', seat: 0, side: 'L', colOffset: 0, units: [{ uid: 1, chessId: 't_guard', row: 10, col: 2 }], bonds, playerEffects: [] }],
    content: 'none', autoFinish: false });
  off.step();
  assert.equal(off.b.addLayers('P', 'yanShip', 20, 'garrison'), 20, 'past 999');
  assert.equal(off.b.getPlayer('P').bonds.yanShip.layers, 1010);
  const on = makeBattle({ defs: { chess: { t_guard: guardRec() } },
    players: [{ playerId: 'P', seat: 0, side: 'L', colOffset: 0, units: [{ uid: 1, chessId: 't_guard', row: 10, col: 2 }], bonds: structuredClone(bonds), playerEffects: [] }],
    content: 'none', autoFinish: false });
  on.step();
  assert.equal(on.b.addLayers('P', 'yanShip', 20, 'garrison'), 9, 'the default stops at 999');
});

test('checkpoint: the rules and the counts past 999 survive a restore', (t) => {
  const opts = { mode: 'coop', humans: 2, seed: 175, fake: true, experimental: LIFTED };
  const a = makeMatch(opts).start();
  t.after(() => a.m.dispose());
  a.toPrep(1);
  a.ps('p_0').addLayers('yanShip', 5000);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(a.m)));
  assert.equal(doc.disableLayerCap, true); assert.equal(doc.disableHitLimit, true);
  const b = makeMatch({ ...opts, difficulty: 'NORMAL' });
  t.after(() => b.m.dispose());
  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  assert.equal(b.m.disableLayerCap, true); assert.equal(b.m.disableHitLimit, true);
  assert.deepEqual(b.m._ruleFlags(), { layerCapOff: true, hitLimitOff: true });
  assert.equal(b.m.players.get('p_0').layers.yanShip, 5000);
  assert.deepEqual(collectViolations(b.m), []);
});
