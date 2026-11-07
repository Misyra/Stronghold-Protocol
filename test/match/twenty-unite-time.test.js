// test/match/twenty-unite-time.test.js — 扩编联防的时序（移植自用户分支 test/match/twenty-unite-time.test.js）：
// 容量房间的联防按本轮自己的时限打（联防接力两轮各得一轮时限），普通四人房保持原形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';

const rules = capacity => ({ playerCapacity: capacity, revivalEnabled: false, disableSharedPool: false });
const BUDGET_KEYS = ['timeLimit', 'totalBudget', 'remainingBudget', 'gameSpeed'];
function fixture(t, { count = 20, capacity = 20, mode = 'coop', clientCombat = false, base = 60, speed = 2, relay = false } = {}) {
  const h = makeMatch({ humans: count, mode, experimental: rules(capacity), fake: true, instant: false, clientCombat, clients: false, seed: 9017 }).start();
  t.after(() => h.m.dispose()); h.toPrep(1); const m = h.m;
  for (const ps of m.order) ps.lp = 28;
  m.gameSpeed = speed; m.wave = base == null ? null : { ...m.wave, timeLimit: base };
  const plan = { helpers: [m.order[0]], leakers: [m.order.at(-1)], leaked: [{ enemyKey: 'enemy_1007_slime', sourcePlayerId: m.order.at(-1).playerId, mods: null, lpr: 1 }], notReentered: new Map() };
  if (m.capacityExperiment && count >= 8) {
    plan.uniteRound = 1; plan.relayCandidates = relay ? m.order.slice(1, 3) : [];
    m.lastResults = new Map(m.order.map(p => [p.playerId, { perfect: true, leaked: [], unitsEnd: [] }]));
  }
  return { h, m, plan };
}

for (const capacity of [8, 12, 16, 20]) for (const count of [capacity, 4, 1]) for (const base of [60, 17.5, 120, null]) for (const clientCombat of [false, true]) {
  for (const relay of count >= 8 ? [false, true] : [false]) test(`capacity${capacity} ${count} alive, base ${base ?? 'default'}, ${clientCombat ? 'client' : 'inline'}, ${relay ? 'viable relay' : 'single round'}: the round's limit, spec, deadline, public shape`, t => {
    const speed = count === 1 ? 3 : count === 12 ? 4 : 2;
    const { h, m, plan } = fixture(t, { capacity, count, base, speed, clientCombat, relay });
    const limit = base ?? 60;
    const original = m.wave && structuredClone(m.wave);
    m.startUnite(plan); const spec = m.fields[0].spec || m.fields[0].battle.opts;
    assert.equal(spec.timeLimit, limit);
    for (const key of BUDGET_KEYS) {
      assert.equal(Object.hasOwn(m.publicView().unite, key), false, key); assert.equal(Object.hasOwn(plan, key), false, key);
    }
    if (count >= 8) {
      assert.equal(m.publicView().uniteRounds, relay ? 2 : 1);
      assert.equal(m.publicView().uniteRound, 1); assert.equal(m.publicView().unite.battleId, spec.battleId);
      assert.ok(spec.battleId, 'honest single-round metadata must retain field admission identity');
    } else assert.equal(m.publicView().uniteRound, undefined, 'sparse rooms retain the original single-field identity shape');
    assert.equal(m.deadline - h.sched.now(), Math.round(limit / speed * 1000));
    if (count > 1) {
      m.onLeave(m.order.at(-1).playerId);
      assert.equal(spec.timeLimit, limit);
      assert.equal(m.deadline - h.sched.now(), Math.round(limit / speed * 1000));
    }
    assert.deepEqual(m.wave, original);
  });
}

for (const clientCombat of [false, true]) test(`ordinary four ${clientCombat ? 'client' : 'inline'} preserves original time, deadline, public shape`, t => {
  const { h, m, plan } = fixture(t, { count: 4, capacity: 4, base: 17.5, speed: 3, clientCombat });
  m.startUnite(plan); const spec = m.fields[0].spec || m.fields[0].battle.opts;
  assert.equal(spec.timeLimit, 17.5); assert.equal(m.deadline - h.sched.now(), Math.round(17.5 / 3 * 1000));
  for (const key of BUDGET_KEYS) {
    assert.equal(Object.hasOwn(m.publicView().unite, key), false); assert.equal(Object.hasOwn(plan, key), false);
  }
  assert.equal(m.publicView().uniteRound, undefined);
});

test('solo keeps the round\'s limit under an irrelevant experimental capacity', t => {
  const { m } = fixture(t, { mode: 'solo', count: 1, capacity: 20, base: 17.5 });
  assert.equal(m.capacityExperiment, false); assert.equal(m.uniteTimeLimit(), 17.5);
});

for (const capacity of [8, 12, 16, 20]) test(`zero living participants cannot start capacity${capacity} unite`, t => {
  const { m, plan } = fixture(t, { capacity, count: capacity }); for (const p of m.order) { p.alive = false; p.left = true; }
  let settled = 0; m.settle = (p, result) => { settled++; assert.equal(p, null); assert.equal(result, null); };
  const before = m.fields; m.startUnite(plan);
  assert.equal(settled, 1); assert.equal(m.fields, before);
});

for (const capacity of [8, 12, 16, 20]) for (const reason of ['none', 'left', 'dead', 'synthetic', 'leaked', 'imperfect', 'used', 'replaced']) test(`capacity${capacity} no viable unused helper (${reason}): one round, honest metadata`, t => {
  const { m, plan } = fixture(t, { capacity, count: 8, relay: true });
  plan.relayCandidates = reason === 'none' ? [] : [m.order[1]];
  const p = m.order[1], r = m.lastResults.get(p.playerId);
  if (reason === 'left') p.left = true;
  if (reason === 'dead') p.alive = false;
  if (reason === 'synthetic') r.synthetic = true;
  if (reason === 'leaked') r.leaked.push({ counted: true });
  if (reason === 'imperfect') r.perfect = false;
  if (reason === 'used') plan.helpers.push(p);
  if (reason === 'replaced') plan.relayCandidates = [{ ...p }];
  m.startUnite(plan);
  assert.equal(m.publicView().uniteRounds, 1); assert.ok(m.publicView().unite.battleId);
});

function natural(t, { capacity = 20, count = capacity, clientCombat = false, headless = false, base = 40, firstTime = 0.2, secondTime = 0.2, firstLeft = 1 } = {}) {
  const h = makeMatch({ humans: count, experimental: rules(capacity), fake: true, instant: false, clientCombat,
    clients: !headless, captureFrames: false, seed: 9017,
    script: b => b.kind === 'normal' ? { duration: 0.2, leaks: { p_0: 1 } }
      : { duration: b.fieldId === 'u' ? firstTime : secondTime, survivors: { p_0: b.fieldId === 'u' ? firstLeft : 1 } } }).start();
  const m = h.m; t.after(() => m.dispose()); h.toPrep(1);
  for (const p of m.order) { p.lp = 28; if (headless) p.connected = false; }
  m.wave = { ...m.wave, timeLimit: base };
  const normal = m._normalOpts.bind(m);
  m._normalOpts = ps => { const o = normal(ps); return { ...o, spawns: ps.seat === 0 ? [{ time: 0, enemyKey: 'enemy_1007_slime', count: 1, routeIndex: 0 }] : [] }; };
  let settlements = 0; const settle = m.settle.bind(m); m.settle = (...args) => { settlements++; return settle(...args); };
  assert.ok(h.drive(() => m.phase === 'UNITE'));
  return { h, m, settlements: () => settlements };
}

for (const capacity of [8, 12, 16, 20]) for (const [clientCombat, headless] of [[false, false], [true, false], [true, true]]) test(`capacity${capacity} ${clientCombat ? headless ? 'headless legacy' : 'accepted legacy' : 'inline'}: both relay rounds get the round's limit, one final LP settlement`, t => {
  const { h, m, settlements } = natural(t, { capacity, clientCombat, headless });
  const first = m.unitePlan, field1 = m.fields[0];
  assert.equal((field1.spec || field1.battle.opts).timeLimit, 40);
  assert.equal(m.wave.timeLimit, 40); assert.equal(settlements(), 0);
  m.onLeave(m.order.at(-1).playerId);
  assert.ok(h.drive(() => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2));
  const second = m.unitePlan;
  assert.equal((m.fields[0].spec || m.fields[0].battle.opts).timeLimit, 40);
  assert.equal(m.deadline - h.sched.now(), Math.round(40 / m.gameSpeed * 1000));
  assert.equal(settlements(), 0); assert.equal(m.order[0].lp, 28);
  assert.equal(new Set([...first.helpers, ...second.helpers]).size, first.helpers.length + second.helpers.length);
  m._finishUniteField(first, m._uniteRelay.rounds[0].result, field1); assert.equal(m.unitePlan, second, 'a late first terminal changes nothing');
  h.runToPhase('SETTLE'); assert.equal(settlements(), 1); assert.equal(m.order[0].lp, 27); assert.equal(m.order[0].stats.lpLost, 1);
  assert.equal(m._uniteRelay.rounds.length, 2); assert.equal(m.wave.timeLimit, 40);
});

for (const clientCombat of [false, true]) test(`two full ${clientCombat ? 'legacy' : 'inline'} rounds: no third round or extra LP`, t => {
  const { h, m, settlements } = natural(t, { clientCombat, base: 0.4, firstTime: Infinity, secondTime: Infinity });
  h.runToPhase('SETTLE');
  assert.equal(m._uniteRelay.rounds.length, 2); assert.equal(settlements(), 1); assert.equal(m.order[0].stats.lpLost, 1);
});

for (const cause of ['cleared', 'no-helpers']) test(`${cause}: finishes early, no second round`, t => {
  const { h, m, settlements } = natural(t, { firstLeft: cause === 'cleared' ? 0 : 1 });
  const start = h.sched.now();
  if (cause === 'no-helpers') for (const p of m.unitePlan.relayCandidates) m.lastResults.get(p.playerId).synthetic = true;
  assert.equal(m.publicView().uniteRounds, cause === 'no-helpers' ? 1 : 2);
  h.runToPhase('SETTLE'); assert.equal(m._uniteRelay.rounds.length, 1); assert.equal(settlements(), 1);
  assert.ok(h.sched.now() - start < m.wave.timeLimit / m.gameSpeed * 1000);
  assert.equal(m.order[0].stats.lpLost, cause === 'cleared' ? 0 : 1);
});

test('headless future result cannot enter relay, charge LP or finish through premature callback', t => {
  const { h, m, settlements } = natural(t, { clientCombat: true, headless: true, firstTime: 12, secondTime: 2 });
  const first = m.unitePlan, f = m.fields[0]; h.run(() => !!f.result);
  assert.equal(f.done, false); assert.ok(f.result.time >= 12);
  m._finishUniteField(first, f.result, f);
  assert.equal(f.uniteCompleted, undefined);
  assert.equal(m._uniteRelay.rounds.length, 0); assert.equal(settlements(), 0); assert.equal(m.order[0].lp, 28);
  h.sched.advance(1000); assert.equal(m.unitePlan, first);
  h.run(() => f.uniteCompleted);
  m._finishUniteField(first, f.result, f);
  h.runToPhase('SETTLE'); assert.equal(settlements(), 1); assert.equal(m.order[0].stats.lpLost, 1);
});
