// test/match/experimental-unite-relay.test.js — 扩编联防接力（移植自用户分支 test/match/experimental-unite-relay.test.js
// 的纯 match 逻辑部分）。与本仓的差异（见移植报告）：
//   * settle.js 的 relay 合并 hunks（combinedUnite / rounds 视图 / 合成第二轮的幸存者计费）不在本代理边界——
//     最终结算只按最后一轮的幸存者计费，第一轮 helper 的击杀/金币并入与 m.public.uniteResult.rounds 留待该文件落地；
//   * 救援（rel35 revival）不在本仓范围，相关断言随之省去；worker 传输（experimental-unite-relay-workers）同前。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { planUniteRelay } from '../../server/match/unite.js';
import { makeMatch, give, legalTileFor } from './harness.js';

const experiment = { playerCapacity: 20, revivalEnabled: false, disableSharedPool: false };
const enemyKey = 'enemy_1007_slime';
const pp = (leaked = [], extra = {}) => ({ leaked, perfect: !leaked.some(l => l.counted !== false), killed: 0,
  total: leaked.length, coins: 0, damageDealt: 0, healingDone: 0, layerGains: {}, unitsEnd: [], unitStats: [], ...extra });
const leak = (sourcePlayerId, extra = {}) => ({ enemyKey, sourcePlayerId, counted: true, mods: { hpMul: 2 }, lpr: 1, ...extra });

function fixture(t, options = {}) {
  const h = makeMatch({ humans: options.humans ?? 8, experimental: options.experimental ?? experiment,
    fake: true, instant: options.instant, clientCombat: options.clientCombat, clients: options.clients,
    spectators: ['observer'], seed: 9017,
    script: b => b.kind === 'normal' ? { leaks: options.normalLeaks ?? { p_0: 4 }, coins: { [b.players[0]]: 1 } }
      : { survivors: { p_0: b.fieldId === 'u' ? options.firstLeft ?? 2 : options.secondLeft ?? 1 },
        coins: Object.fromEntries(b.players.map(id => [id, b.fieldId === 'u' ? 3 : 5])),
        damage: Object.fromEntries(b.players.map(id => [id, b.fieldId === 'u' ? 31 : 53])) },
  }).start();
  const m = h.m;
  t.after(() => m.dispose());
  h.toPrep(1); h.setStage('act2autochess_m04');
  for (const p of m.order) p.lp = p.seat === 0 ? options.targetLp ?? 20 : 20;
  for (const p of m.order.slice(1, 5)) {
    const id = options.kitId ?? 'chess_char_1_19_a';
    give(m, p, id, 'board', legalTileFor(m, p, id));
  }
  h.statsBefore = new Map(m.order.map(p => [p.playerId, structuredClone(p.stats)]));
  let settlements = 0;
  const settle = m.settle.bind(m);
  m.settle = (...args) => { settlements++; return settle(...args); };
  h.settlements = () => settlements;
  return h;
}

function first(h) { h.drive(() => h.m.phase === PHASE.UNITE); return h.m.fields[0]; }
function second(h) {
  assert.ok(h.drive(() => h.m.phase === PHASE.UNITE && h.m.unitePlan.uniteRound === 2));
  return h.m.fields[0];
}
function settleOnce(h) { h.runToPhase(PHASE.SETTLE, 1); assert.equal(h.settlements(), 1); }

test('relay inline server: first residual only, distinct helpers, original map/carry, final LP once', t => {
  const h = fixture(t, {}), m = h.m;
  const f1 = first(h), plan1 = m.unitePlan;
  assert.deepEqual(plan1.helpers.map(p => p.playerId), ['p_1', 'p_2']);
  assert.equal(m.publicView().uniteRound, 1); assert.equal(m.publicView().uniteRounds, 2);
  assert.equal(h.settlements(), 0); assert.equal(h.ps('p_0').lp, 20);
  const f2 = second(h), plan2 = m.unitePlan;
  assert.equal(f1.fieldId, 'u'); assert.equal(f2.fieldId, 'u:2');
  assert.deepEqual(plan2.helpers.map(p => p.playerId), ['p_3', 'p_4']);
  assert.equal(new Set([...plan1.helpers, ...plan2.helpers]).size, 4);
  assert.equal(plan2.leaked.length, 2); assert.ok(plan2.leaked.every(l => l.sourcePlayerId === 'p_0'));
  assert.equal(h.ps('p_0').lp, 20); assert.equal(h.ps('p_0').alive, true); assert.equal(h.settlements(), 0);
  const opts = f2.spec || f2.battle.opts;
  assert.equal(opts.stageId, m.stageId); assert.equal(opts.flags.layerGainsEnabled, false);
  for (const p of opts.players) {
    assert.equal(p.units[0].carryState.hpPct, 0.5);
    assert.equal(p.units[0].carryState.sp, 3);
    assert.equal(Object.hasOwn(p.units[0].carryState, 'skillActive'), false);
  }
  const result1 = m._uniteRelay.rounds[0].result;
  settleOnce(h);
  assert.equal(h.ps('p_0').lp, 19); assert.equal(h.ps('p_0').stats.lpLost, 1);
  assert.equal(m.uniteResultView.through, 1);
  // （settle.js 的 relay hunks 落地前：helpers 只列最后一轮的；第一轮 helper 的金币/击杀并入与 rounds 视图同批补）
  assert.deepEqual(m.uniteResultView.helpers, ['p_3', 'p_4']);
  for (const id of ['p_3', 'p_4']) {
    const p = h.ps(id), normal = m.lastResults.get(id), u = m._uniteRelay.rounds.find(r => r.plan.helpers.includes(p)).result.perPlayer[id];
    assert.equal(p.pendingFunds, 1 + 5);
    assert.equal(p.stats.kills, normal.killed + u.killed);
    assert.equal(p.stats.dmgDealt, normal.damageDealt + u.damageDealt);
    assert.equal(p.stats.fundsGained - h.statsBefore.get(id).fundsGained, 1 + 5);
  }
  assert.equal(m._uniteRelay.rounds[0].result, result1, 'round one result is never overwritten by round two');
  // （fork 的 settlement fence——settle.js 对 SETTLE 相位的重入直接返回——属于 settle.js 的 relay hunks，见文件头）
});

for (const [label, options] of [
  ['ordinary four', { humans: 4, experimental: { ...experiment, playerCapacity: 4 } }],
  ['expanded seven alive', { humans: 7 }],
  ['expanded four alive', { humans: 4 }],
]) test(`${label}: unchanged single-round plan/identity, the round's limit and own losses`, t => {
  const h = fixture(t, options), m = h.m;
  first(h);
  assert.equal(m.unitePlan.uniteRound, undefined); assert.equal(m._uniteRelay, null);
  assert.equal(Object.hasOwn(m.publicView(), 'uniteRound'), false);
  assert.equal(Object.hasOwn(m.publicView().unite, 'rounds'), false);
  assert.equal((m.fields[0].spec || m.fields[0].battle.opts).timeLimit, m.wave.timeLimit);
  settleOnce(h);
  assert.equal(h.ps('p_0').lp, 18);
  assert.equal(m.publicView().uniteResult.rounds, undefined);
  assert.deepEqual(m.uniteResultView.helpers, ['p_1', 'p_2']);
});

for (const when of ['normal-start', 'qualification']) test(`eight threshold uses actual alive at ${when}; below threshold gets one field without new relay eligibility`, t => {
  const h = fixture(t), m = h.m;
  if (when === 'normal-start') m.onLeave('p_7');
  else {
    const after = m._afterCombat.bind(m);
    m._afterCombat = () => { m.onLeave('p_7'); return after(); };
  }
  first(h); assert.equal(m._uniteRelay, null); assert.equal(m.unitePlan.uniteRound, undefined);
  assert.equal((m.fields[0].spec || m.fields[0].battle.opts).timeLimit, m.wave.timeLimit);
  settleOnce(h); assert.equal(h.ps('p_0').lp, 18);
});

test('no first residual: no second field, result metadata records only actual first field', t => {
  const h = fixture(t, { firstLeft: 0 }), m = h.m;
  first(h); settleOnce(h);
  assert.equal(h.ps('p_0').lp, 20); assert.equal(m._uniteRelay.rounds.length, 1);
  assert.equal(m.uniteResultView.through, 0);
  assert.deepEqual(m.uniteResultView.helpers, ['p_1', 'p_2']);
});

for (const candidates of [0, 1]) test(`only ${candidates} unused qualified helper(s): no empty/repeated helper, final settle still once`, t => {
  const normalLeaks = Object.fromEntries(['p_0', ...Array.from({ length: 5 - candidates }, (_, i) => `p_${i + 3}`)].map(id => [id, 2]));
  const h = fixture(t, { normalLeaks }), m = h.m;
  first(h);
  if (candidates) { second(h); assert.equal(m.unitePlan.helpers.length, 1); assert.equal(m.unitePlan.helpers[0].playerId, 'p_7'); }
  settleOnce(h);
  assert.equal(m._uniteRelay.rounds.length, candidates ? 2 : 1);
  // settle.js 的 relay hunks 落地前，SETTLE 视图只列最后一轮的 helpers（fork 为两轮的 flatMap）
  assert.deepEqual(m.uniteResultView.helpers, candidates ? ['p_7'] : ['p_1', 'p_2']);
});

test('second helper qualification excludes departure, synthetic, counted leaks and perfect:false', t => {
  const h = fixture(t), m = h.m; first(h);
  m.onLeave('p_3'); m.lastResults.get('p_4').synthetic = true;
  m.lastResults.get('p_5').leaked.push(leak('p_5')); m.lastResults.get('p_6').perfect = false;
  second(h); assert.deepEqual(m.unitePlan.helpers.map(p => p.playerId), ['p_7']);
  settleOnce(h);
});

test('source ledger: leaks + unspawned residuals, unknown/noncounted enemies, mods and bounty remain source-owned', t => {
  const h = fixture(t), m = h.m; first(h);
  const plan = m.unitePlan;
  plan.leaked = [leak('p_0', { mods: { hpMul: 4, bountyCoins: 9 }, bounty: { coins: 9, ownerPlayerId: 'p_0' } })];
  plan.notReentered.set('p_0', 1);
  const result = { reason: 'timeout', perPlayer: { p_1: pp([leak('p_0'), leak('p_0', { counted: false }), leak('foreign')]) },
    unspawned: [{ enemyKey, sourcePlayerId: 'p_0' }, { enemyKey: 'not_an_enemy', sourcePlayerId: 'p_0' }] };
  const next = planUniteRelay(m, plan, result);
  assert.equal(next.leaked.length, 2); assert.equal(next.notReentered.get('p_0'), 2);
  assert.deepEqual(next.leaked[1].mods, { hpMul: 4, bountyCoins: 9 });
  assert.deepEqual(next.leaked[1].bounty, { coins: 9, ownerPlayerId: 'p_0' });
  assert.equal(next.leaked[1].sourcePlayerId, 'p_0');
  assert.equal(planUniteRelay(m, plan, { ...result, synthetic: true }), null);
});

test('unspawned recovery consumes exact original schedule entries once for repeated enemy keys and distinct mods/bounties/counts', t => {
  const h = fixture(t), m = h.m; first(h);
  const plan = m.unitePlan;
  const spawns = [
    { enemyKey, sourcePlayerId: 'p_0', time: 12, count: 2, interval: 3, mods: { hpMul: 2, bountyCoins: 2 }, bounty: { coins: 2, ownerPlayerId: 'p_0' } },
    { enemyKey, sourcePlayerId: 'p_0', time: 13, count: 1, mods: { hpMul: 7, bountyCoins: 7 }, bounty: { coins: 7, ownerPlayerId: 'p_0' } },
  ];
  const result = { reason: 'timeout', perPlayer: { p_1: pp() },
    unspawned: [13, 15, 12].map(time => ({ enemyKey, sourcePlayerId: 'p_0', time })) };
  const next = planUniteRelay(m, plan, result, spawns);
  assert.deepEqual(next.leaked.map(l => l.mods.hpMul), [7, 2, 2]);
  assert.deepEqual(next.leaked.map(l => l.bounty.coins), [7, 2, 2]);
  assert.ok(next.leaked.every(l => l.sourcePlayerId === 'p_0' && l.bounty.ownerPlayerId === 'p_0'));
  assert.deepEqual(spawns.map(s => s.mods.hpMul), [2, 7], 'input schedule is never mutated');
});

test('synthetic second result archives only; first rewards preserved', t => {
  const h = fixture(t), m = h.m; first(h);
  const normalBattle = m.BattleClass;
  class FailingSecond extends normalBattle { constructor(o) { if (o.fieldId === 'u:2') throw new Error('relay fixture failure'); super(o); } }
  m.BattleClass = FailingSecond;
  second(h); settleOnce(h);
  assert.equal(m._uniteRelay.rounds[1].result.synthetic, true);
  assert.equal(h.ps('p_1').pendingFunds, 1, 'a helper of the first round keeps its own normal coins (settle.js 的 relay 并入前)');
});
