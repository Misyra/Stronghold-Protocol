import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { branchSpawn } from '../../server/sim/content/bosses.js';
import { MAX_ALIVE_ENEMIES } from '../../server/sim/constants.js';
import { PLUGIN_SPAWN_TOTAL, PLUGIN_TIMES_MAX, PLUGIN_GAIN_COUNT_MAX, boundedCount } from '../../shared/plugins/limits.js';
import { getData } from '../../server/data.js';
import { applyCard } from '../../server/match/choices.js';
import { DATA, makeMatch } from '../match/harness.js';

const walker = (o = {}) => enemyRec({ key: 'enemy_w', hp: 1000, speed: 0, ...o });

test('shared spawn cap equals the engine cap and a fractional count is not floored', () => {
  assert.equal(PLUGIN_SPAWN_TOTAL, MAX_ALIVE_ENEMIES);
  assert.equal(boundedCount(2.5, PLUGIN_TIMES_MAX, 0), 2.5);
  assert.equal(boundedCount(1e9, PLUGIN_TIMES_MAX, 0), PLUGIN_TIMES_MAX);
  assert.equal(boundedCount(Number.POSITIVE_INFINITY, PLUGIN_TIMES_MAX, 3), 3);
});

test('branchSpawn stops at the living cap and does not allocate a refusal per extra count', () => {
  const h = makeBattle({ defs: { enemies: { enemy_w: walker() } }, content: 'none', timeLimit: 5, recordEvents: false });
  h.step();
  for (let i = 0; i < MAX_ALIVE_ENEMIES; i++) h.b.spawnEnemy('enemy_w', { pos: [10, 8] });
  assert.equal(h.b.aliveEnemies().length, MAX_ALIVE_ENEMIES);
  const before = h.b.errorCount;
  const t0 = Date.now();
  const got = branchSpawn(h.b, { branches: { bomb: [[{ key: 'enemy_w', count: 1e9, routeIndex: 0 }]] }, extraRoutes: [] }, 'bomb', 0);
  const ms = Date.now() - t0;
  assert.equal(got.length, 0);
  assert.equal(h.b.aliveEnemies().length, MAX_ALIVE_ENEMIES);
  assert.equal(h.b.errorCount, before);
  assert.ok(ms < 1000, `branchSpawn took ${ms}ms`);
});

test('one branch count on an empty field spawns at most MAX_ALIVE_ENEMIES', () => {
  const h = makeBattle({ defs: { enemies: { enemy_w: walker() } }, content: 'none', timeLimit: 5, recordEvents: false });
  h.step();
  const before = h.b.errorCount;
  const t0 = Date.now();
  const got = branchSpawn(h.b, { branches: { bomb: [[{ key: 'enemy_w', count: 1e6, routeIndex: 0 }]] }, extraRoutes: [] }, 'bomb', 0);
  assert.equal(got.length, MAX_ALIVE_ENEMIES);
  assert.equal(h.b.aliveEnemies().length, MAX_ALIVE_ENEMIES);
  assert.equal(h.b.errorCount, before);
  assert.ok(Date.now() - t0 < 2000, `spawn took ${Date.now() - t0}ms`);
});

test('catapult extra hits stop at PLUGIN_TIMES_MAX', () => {
  const src = getData().enemies.enemy_10162_mnctpt;
  const enemy = structuredClone(src);
  assert.equal(typeof enemy.talents.bb['Attack.attack@times'], 'number');
  enemy.talents.bb['Attack.attack@times'] = 1e6;
  enemy.stats = { ...enemy.stats, atk: 750, rangeRadius: 8, moveSpeed: 0, bat: 2.5 };
  const h = makeBattle({
    defs: {
      enemies: { enemy_10162_mnctpt: enemy },
      chess: { t_wall: chessRec({ id: 't_wall', profession: 'WARRIOR', skill: null, stats: { maxHp: 1e12, atk: 0, def: 0, res: 0, blockCnt: 99, bat: 5 } }) },
    },
    units: [{ chessId: 't_wall', row: 9, col: 6 }],
    enemies: [{ key: 'enemy_10162_mnctpt', pos: [9, 7] }],
    timeLimit: 6,
    recordEvents: false,
  });
  const t0 = Date.now();
  h.run(3);
  const ms = Date.now() - t0;
  const wall = h.unit('t_wall');
  const lost = wall.base.maxHp - wall.hp;
  assert.ok(ms < 1500, `attack loop took ${ms}ms`);
  assert.ok(lost > 0, 'the catapult dealt no damage');
  assert.equal(lost % 750, 0);
  const hits = lost / 750;
  assert.ok(hits <= PLUGIN_TIMES_MAX * 4, `hits ${hits}`);
  assert.ok(hits <= PLUGIN_TIMES_MAX || hits % PLUGIN_TIMES_MAX === 0);
});

test('列装 and bond-chess grants loop at most PLUGIN_GAIN_COUNT_MAX', () => {
  const data = structuredClone(DATA);
  const equip = data.effects.allybuff_select_1.buffs.find(b => b.key === 'global_special_choice_gain_equip');
  equip.bb.count = 1e9;
  const bondEff = Object.values(data.effects).find(e => e.buffs?.some(b => b.key === 'single_special_choice_gain_bond_chess'));
  bondEff.buffs.find(b => b.key === 'single_special_choice_gain_bond_chess').bb.count = 1e9;
  const h = makeMatch({ mode: 'solo', humans: 1, fake: true, data, seed: 1 }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  let pools = 0, items = 0;
  m.rollPool = () => { pools++; return null; };
  m.rollItemId = () => { items++; return null; };
  const t0 = Date.now();
  applyCard(m, ps, { kind: 'tactic', id: 'allybuff_select_1', family: 'tactic', team: false });
  assert.equal(items, PLUGIN_GAIN_COUNT_MAX);
  assert.ok(pools === 0 || pools === PLUGIN_GAIN_COUNT_MAX);
  assert.ok(Date.now() - t0 < 1000, `content grant took ${Date.now() - t0}ms`);
  items = 0;
  pools = 0;
  const runKey = m.dispatcher.runKey.bind(m.dispatcher);
  m.dispatcher.runKey = () => false;
  const t1 = Date.now();
  applyCard(m, ps, { kind: 'tactic', id: 'allybuff_select_1', family: 'tactic', team: false });
  assert.equal(items, PLUGIN_GAIN_COUNT_MAX);
  assert.equal(pools, 0);
  assert.ok(Date.now() - t1 < 1000, `fallback grant took ${Date.now() - t1}ms`);
  // Granting the same chess 32 times merges and rolls a reward. Stub the grant so the count is the choice loop.
  let rolls = 0;
  let gained = 0;
  ps.acquireChess = () => { gained++; return null; };
  m.pool.roll = () => { rolls++; return 'chess_char_1_01_a'; };
  m.dispatcher.runKey = runKey;
  const t2 = Date.now();
  applyCard(m, ps, { kind: 'tactic', id: bondEff.effectId, family: 'tactic', team: false });
  assert.equal(rolls, PLUGIN_GAIN_COUNT_MAX);
  assert.equal(gained, PLUGIN_GAIN_COUNT_MAX);
  assert.ok(Date.now() - t2 < 1000, `bond grant took ${Date.now() - t2}ms`);
  rolls = 0;
  gained = 0;
  m.dispatcher.runKey = () => false;
  const t3 = Date.now();
  applyCard(m, ps, { kind: 'tactic', id: bondEff.effectId, family: 'tactic', team: false });
  assert.equal(rolls, PLUGIN_GAIN_COUNT_MAX);
  assert.equal(gained, PLUGIN_GAIN_COUNT_MAX);
  assert.ok(Date.now() - t3 < 1000, `bond fallback took ${Date.now() - t3}ms`);
  m.dispose();
});
