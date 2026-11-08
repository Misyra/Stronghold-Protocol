// 调控台 (移植自用户分支 rel29/rel32): a test match in a room with the console switch (room.console.enable →
// Match.consoleEnabled) widens g.test — every seated player commands their own seat, the match-wide commands only
// as the match's only human, a per-player rate bucket, bounty counts with a per-battle cap and no leaders, bond
// layers to TEST_LAYERS_UNCAPPED_MAX with the experimental disableLayerCap. An ordinary test match keeps the
// host-only gate. Server-matrix and parse tests; no listeners.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPERIMENTAL_DEFAULTS } from '../shared/experimental.js';
import { parseTestArgs, TEST_RATE_COUNT, TEST_BOUNTY_BATTLE_MAX, TEST_LAYERS_UNCAPPED_MAX, testLayersMax } from '../shared/testMode.js';
import { makeMatch, DATA } from './match/harness.js';
import { explainTestDetail } from '../public/js/ui/testAudit.js';
import { testConsoleAccess } from '../public/js/ui/testConsole.js';

const ok = (r) => assert.deepEqual(r, { ok: true });

test('bounty takes an optional count of 1..20', () => {
  assert.deepEqual(parseTestArgs('bounty', { enemyKey: 'e' }), { args: { enemyKey: 'e' } });
  assert.deepEqual(parseTestArgs('bounty', { enemyKey: 'e', count: 20 }), { args: { enemyKey: 'e', count: 20 } });
  for (const count of [0, 21, 1.5, '3']) assert.equal(parseTestArgs('bounty', { enemyKey: 'e', count }).error, 'BAD_TARGET');
  assert.equal(parseTestArgs('bounty', { enemyKey: 'e', extra: 1 }).error, 'BAD_MSG');
  assert.deepEqual(parseTestArgs('chess', { id: 'x' }), { args: { id: 'x' } });
  assert.equal(parseTestArgs('chess', { id: 'x', count: 2 }).error, 'BAD_MSG');
});

test('bond layers parse to the safe bound; the match applies its own cap (testLayersMax)', () => {
  assert.equal(TEST_LAYERS_UNCAPPED_MAX, 99_999);
  assert.equal(testLayersMax(false), 999);
  assert.equal(testLayersMax(true), TEST_LAYERS_UNCAPPED_MAX);
  // the parse alone accepts the uncapped bound — the room-dependent refusal lives in the match
  assert.deepEqual(parseTestArgs('bond', { id: 'b', layers: TEST_LAYERS_UNCAPPED_MAX }), { args: { id: 'b', layers: TEST_LAYERS_UNCAPPED_MAX } });
  assert.equal(parseTestArgs('bond', { id: 'b', layers: 1e9 + 1 }).error, 'BAD_TARGET');
});

/** A console room's test match (room.console.enable on a test room). */
function consoleMatch(t, opts = {}) {
  const h = makeMatch({ test: true, consoleEnabled: true, ...opts });
  t.after(() => h.m.dispose());
  h.start(); h.toPrep();
  h.cmd = (cmd, args = {}, who = 'p_0') => h.m.handle(who, { t: 'g.test', cmd, args });
  return h;
}

test('co-op: every seated player commands their own seat; a spectator and other seats stay out', (t) => {
  const h = consoleMatch(t, { mode: 'coop', humans: 2, spectators: ['watch'] });
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  ok(h.cmd('funds', { amount: 90 }, 'p_1'));
  assert.equal(b.funds, 90);
  ok(h.cmd('funds', { amount: 40 }, 'p_0'));
  assert.equal(a.funds, 40); assert.equal(b.funds, 90, 'a command never touches another seat');
  assert.equal(h.cmd('funds', { amount: 9 }, 'watch').error, 'SPECTATOR');
  // the rate bucket is per player
  for (let i = 0; i < TEST_RATE_COUNT - 1; i++) h.cmd('funds', { amount: -1 }, 'p_0');
  assert.equal(h.cmd('funds', { amount: 1 }, 'p_0').error, 'RATE');
  ok(h.cmd('funds', { amount: 1 }, 'p_1'));
});

test('match-wide commands need the only human: two humans refused, solo or AI teammates allowed', (t) => {
  const h = consoleMatch(t, { mode: 'coop', humans: 2 });
  for (const [cmd, args] of [['round', { round: 3 }], ['phase', { name: 'combat' }], ['timers', { on: false }], ['teamLp', { value: 1 }], ['hp', { value: 1 }]]) {
    const r = h.cmd(cmd, args, 'p_1');
    assert.equal(r.error, 'TEST_FORBIDDEN', cmd);
    assert.equal(r.detail, 'shared', cmd);
  }
  assert.equal(h.m.testLog.at(-1).detail, 'shared');
  assert.equal(h.m.phase, 'PREP', 'a refused shared command changed nothing');
  const solo = consoleMatch(t, { mode: 'solo' });
  ok(solo.cmd('timers', { on: false }));
  ok(solo.cmd('timers', { on: true }));
  const bots = consoleMatch(t, { mode: 'coop', humans: 1, bots: 3 });
  ok(bots.cmd('timers', { on: false }));
  ok(bots.cmd('timers', { on: true }));
  ok(bots.cmd('round', { round: 2 }));
});

test('an ordinary test match keeps the host-only gate', (t) => {
  const h = makeMatch({ mode: 'coop', test: true, humans: 2 });
  t.after(() => h.m.dispose());
  h.start(); h.toPrep();
  const before = h.ps('p_1').funds;
  const r = h.m.handle('p_1', { t: 'g.test', cmd: 'funds', args: { amount: 1 } });
  assert.equal(r.error, 'NOT_HOST');
  assert.equal(h.ps('p_1').funds, before, 'the refusal changed nothing');
});

test('bounty: counts, at most 20 waiting per player, no leader', (t) => {
  const h = consoleMatch(t, { mode: 'coop', humans: 2 });
  const leaders = new Set(Object.values(DATA.bosses).map((b) => b.enemyKey));
  const enemyKey = Object.keys(DATA.enemies).find((id) => !h.m.gd.inactiveEnemies.has(id) && !leaders.has(id));
  const waiting = (ps) => ps.bounties.reduce((n, b) => n + b.card.count, 0);
  ok(h.cmd('bounty', { enemyKey, count: 5 }));
  assert.equal(waiting(h.ps('p_0')), 5);
  const over = h.cmd('bounty', { enemyKey, count: TEST_BOUNTY_BATTLE_MAX - 5 + 1 });
  assert.equal(over.error, 'BAD_TARGET');
  assert.match(over.detail, /^bounty\|/);
  assert.match(explainTestDetail(over.detail), /20/);
  ok(h.cmd('bounty', { enemyKey, count: TEST_BOUNTY_BATTLE_MAX - 5 }));
  assert.equal(waiting(h.ps('p_0')), TEST_BOUNTY_BATTLE_MAX);
  assert.equal(h.cmd('bounty', { enemyKey }).error, 'BAD_TARGET', 'the default count of 1 is past the cap too');
  ok(h.cmd('bounty', { enemyKey, count: 20 }, 'p_1'), 'the cap is per player');
  const leader = [...leaders].find((id) => DATA.enemies[id] && !h.m.gd.inactiveEnemies.has(id));
  const r = h.cmd('bounty', { enemyKey: leader }, 'p_1');
  assert.equal(r.error, 'BAD_TARGET'); assert.equal(r.detail, 'leader');
});

test('bond layers: the room cap holds, the experimental disableLayerCap lifts it to 99 999', (t) => {
  const capped = consoleMatch(t, { mode: 'solo' });
  const bondId = Object.keys(DATA.bonds).find((id) => !capped.m.gd.modeInactiveBonds.has(id));
  const r = capped.cmd('bond', { id: bondId, layers: 1000 });
  assert.equal(r.error, 'BAD_TARGET');
  assert.equal(r.detail, `layersMax|${JSON.stringify({ max: 999 })}`);
  ok(capped.cmd('bond', { id: bondId, layers: 999 }));
  const lifted = consoleMatch(t, { mode: 'solo', experimental: { ...EXPERIMENTAL_DEFAULTS, disableLayerCap: true } });
  const lBondId = Object.keys(DATA.bonds).find((id) => !lifted.m.gd.modeInactiveBonds.has(id));
  assert.equal(lifted.m.disableLayerCap, true);
  ok(lifted.cmd('bond', { id: lBondId, layers: TEST_LAYERS_UNCAPPED_MAX }));
  assert.equal(lifted.ps('p_0').layers[lBondId], TEST_LAYERS_UNCAPPED_MAX);
  const over = lifted.cmd('bond', { id: lBondId, layers: TEST_LAYERS_UNCAPPED_MAX + 1 });
  assert.equal(over.error, 'BAD_TARGET');
  assert.equal(over.detail, `layersMax|${JSON.stringify({ max: TEST_LAYERS_UNCAPPED_MAX })}`);
});

test('the client panel: every seated player of a console match, match-wide controls for the only human', () => {
  const pub = (players) => ({ test: true, players });
  const two = [{ playerId: 'a', isBot: false }, { playerId: 'b', isBot: false }];
  // a console room's match: every seat sees the panel, the shared controls only for the sole human
  assert.deepEqual(testConsoleAccess(pub(two), 'b', 'a', true), { show: true, shared: false });
  assert.deepEqual(testConsoleAccess(pub(two), 'watcher', 'a', true), { show: false, shared: false });
  assert.deepEqual(testConsoleAccess(pub([{ playerId: 'a', isBot: false }, { playerId: 'ai_1', isBot: true }]), 'a', 'a', true), { show: true, shared: true });
  // an ordinary test match: the host only, every control
  assert.deepEqual(testConsoleAccess(pub(two), 'a', 'a', false), { show: true, shared: true });
  assert.equal(testConsoleAccess(pub(two), 'b', 'a', false).show, false);
  assert.equal(testConsoleAccess({ players: two }, 'a', 'a', true).show, false, 'not a test match');
});

test('the refusal details read in words', () => {
  assert.equal(explainTestDetail('shared'), '有其他博士在场时不能使用影响整局的指令');
  assert.equal(explainTestDetail('leader'), '不能添加敌方领袖');
  assert.match(explainTestDetail('bounty|{"max":20,"left":0}'), /20/);
  assert.match(explainTestDetail('layersMax|{"max":999}'), /999/);
});
