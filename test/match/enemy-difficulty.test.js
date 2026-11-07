import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from '../helpers/contentFixtures.js';
import { buildContentSet } from '../../server/plugins/contentSet.js';
import { difficultySettings, identityDifficulty, rollEnemyDifficulty, validEnemyDifficulty, enemyDifficultyText } from '../../shared/enemyDifficulty.js';
import { normalizeSettings } from '../../shared/plugins/patch.js';
import { createRng, createRngFromState } from '../../server/sim/rng.js';
import { GameData } from '../../server/match/gamedata.js';
import { bossPoolHp } from '../../server/match/finalAssault.js';
import { buildNormalWave, buildBossWave, setupMatchWaves, withBounties, buildUniteWave } from '../../server/match/waves.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { buildRecord, recordToResult } from '../../public/js/ui/stats.js';
import { buildResult } from '../../server/match/results.js';
import { makeMatch, DATA } from './harness.js';

const config = (mode = 'fixed', fixed = {}, limits = {}, maxTerms = 1) => ({ mode, maxTerms,
  fixed: { ...identityDifficulty(), ...fixed }, limits: { ...identityDifficulty(), ...limits } });
const dataWith = conf => ({ ...DATA, config: { ...DATA.config, modes: Object.fromEntries(Object.entries(DATA.config.modes).map(([k,v]) => [k, { ...v, enemyDifficulty: conf }])) } });

function installed(t) {
  const f = fixture(t);
  const read = rel => JSON.parse(fs.readFileSync(new URL(`../../docs/examples/n18-duel/${rel}`, import.meta.url)));
  f.put('n18-duel', read('plugin.json'), { 'data/patch.json': read('data/patch.json') });
  return f.registry;
}

test('real plugin composes fixed/random settings into distinct immutable content sets; quantity is integer only', async t => {
  const registry = installed(t);
  const fixed = await buildContentSet({ registry, ids: ['n18-duel'] });
  assert.deepEqual(fixed.problems, []);
  assert.equal(fixed.data.config.modes.mode_multi_normal.enemyDifficulty.fixed.hp, 1.5);
  assert.equal(fixed.data.config.modes.mode_multi_normal.enemyDifficulty.fixed.count, 1);
  const random = await buildContentSet({ registry, ids: [{ id: 'n18-duel', settings: { n18Mode: 'random', n18MaxTerms: 2, limit_count: 3 } }] });
  assert.deepEqual(random.problems, []);
  assert.notEqual(fixed.cs, random.cs);
  assert.equal(random.data.config.modes.mode_multi_normal.enemyDifficulty.limits.count, 3);
  assert.equal(DATA.config.modes.mode_multi_normal.enemyDifficulty, undefined);
  assert.equal(normalizeSettings(difficultySettings(), { fixed_count: 1.5 }).fixed_count, 1);
  assert.equal(validEnemyDifficulty(config('fixed', { count: 1.5 })), false);
  const bad = structuredClone(fixed.data);
  bad.config.modes.mode_multi_normal.enemyDifficulty.fixed.count = 1.5;
  // Check through the real composition path too, rather than relying on settings normalization alone.
  const f = fixture(t);
  f.put('bad-difficulty', { data:['p.json'] }, { 'p.json':{patch:1,ops:[{op:'merge',file:'config',path:['modes'],value:{mode_multi_normal:{enemyDifficulty:bad.config.modes.mode_multi_normal.enemyDifficulty}}}]}});
  assert.ok((await buildContentSet({registry:f.registry, ids:['bad-difficulty']})).problems.some(p=>p.code === 'PLUGIN_DATA_BOUND'));
});

test('random draws have unique applicable terms, exact steps, no accumulation, bounded inclusive caps and reproducible seeds', () => {
  const c = config('random', {}, { hp:3, speed:2, count:3, atk:3, bossHp:3 }, 2);
  const seen = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    const a = rollEnemyDifficulty(c, createRng(seed), {round:1});
    assert.deepEqual(a, rollEnemyDifficulty(c, createRng(seed), {round:1}));
    const chosen = Object.entries(a.values).filter(([,v])=>v>1);
    assert.ok(chosen.length >= 1 && chosen.length <= 2);
    assert.equal(a.values.bossHp, 1);
    for (const [key,v] of chosen) {
      assert.ok(v <= c.limits[key]);
      assert.ok(Number.isInteger(key === 'count' ? v : v * 2));
      seen.add(`${key}:${v}`);
    }
  }
  assert.ok(seen.has('count:2') && seen.has('count:3') && seen.has('atk:3'));
  assert.deepEqual(rollEnemyDifficulty(config('random'), createRng(1), {round:1}).values, identityDifficulty());
  const bossOnly = config('random', {}, {bossHp:2}, 5);
  assert.equal(rollEnemyDifficulty(bossOnly, createRng(1), {round:14}).values.bossHp, 1);
  assert.ok(rollEnemyDifficulty(bossOnly, createRng(1), {round:14,boss:true}).values.bossHp > 1);
});

test('quantity x2/x3 changes resolved wave counts and intervals; bounty rewards stay fixed; shared boss HP uses its own multiplier', () => {
  const plain = new GameData(DATA, 'mode_multi_normal');
  for (const multiplier of [2,3]) {
    const gd = new GameData(dataWith(config('fixed', {count:multiplier, hp:2, speed:1.5, atk:2, bossHp:3})), 'mode_multi_normal');
    gd.roundDifficulty = rollEnemyDifficulty(gd.mode.enemyDifficulty, createRng(9), {round:1});
    const factions = setupMatchWaves(plain, createRng(42));
    const a = buildNormalWave(plain, createRng(4), factions, 1);
    const b = buildNormalWave(gd, createRng(4), factions, 1);
    assert.equal(b.spawns.length, a.spawns.length);
    for (let i=0; i<a.spawns.length; i++) {
      assert.equal(b.spawns[i].count, a.spawns[i].count * multiplier);
      assert.equal(b.spawns[i].interval, a.spawns[i].interval / multiplier);
      assert.equal(b.spawns[i].mods.hpMul, a.spawns[i].mods.hpMul * 2);
      assert.equal(b.spawns[i].mods.atkMul, a.spawns[i].mods.atkMul * 2);
      assert.equal(b.spawns[i].mods.speedMul, a.spawns[i].mods.speedMul * 1.5);
      assert.ok((b.spawns[i].count-1)*b.spawns[i].interval < a.spawns[i].count*a.spawns[i].interval || a.spawns[i].interval === 0);
    }
    const card = DATA.choices.cards.bounty.find(c => c.payout !== 'perfect' && c.coin > 0);
    const bounties = [{id:'b1',card}];
    const count = xs => xs.filter(s=>s.tag === 'bounty').reduce((n,s)=>n+s.count,0);
    assert.equal(count(withBounties(plain,1,a,bounties,'p_0')), count(withBounties(gd,1,b,bounties,'p_0')));
    gd.roundDifficulty = rollEnemyDifficulty(gd.mode.enemyDifficulty, createRng(9), {round:gd.bossRound,boss:true});
    const bossId = Object.keys(DATA.bosses)[0];
    assert.equal(bossPoolHp(gd,bossId,2), bossPoolHp(plain,bossId,2)*3);
    assert.equal(gd.bossPoolHp(bossId,2), plain.bossPoolHp(bossId,2)*3);
    const ba=buildBossWave(plain,createRng(4),factions,gd.bossRound,{bossId});
    const bb=buildBossWave(gd,createRng(4),factions,gd.bossRound,{bossId});
    for (let i=0;i<ba.spawns.length;i++) if (['boss','part'].includes(ba.spawns[i].tag)) assert.equal(bb.spawns[i].count,ba.spawns[i].count);
  }
});

test('prep announces once, public views/recovery preserve the draw, match result saves config and history, vanilla omits them', () => {
  const opts={data:dataWith(config('random',{}, {hp:2, count:3, atk:2},2)), seed:7, humans:2,fake:true};
  const a=makeMatch(opts), b=makeMatch(opts), plain=makeMatch({seed:7,humans:2,fake:true});
  try {
    a.start(); a.runToPhase('PREP');
    plain.start(); plain.runToPhase('PREP');
    assert.deepEqual(a.m.rngWaves.state(),plain.m.rngWaves.state());
    const plan=structuredClone(a.m.gd.roundDifficulty);
    assert.deepEqual(a.m.publicView().enemyDifficulty,plan);
    assert.equal(a.bc.filter(x=>x.type==='ENEMY_DIFFICULTY').length,1);
    assert.ok(enemyDifficultyText(plan).includes('N18'));
    const snap=snapshotMatch(a.m);
    assert.ok(snap);
    assert.equal(restoreMatch(b.m,snap,{createRngFromState}),true);
    assert.deepEqual(b.m.gd.roundDifficulty,plan);
    const ps=a.ps('p_0');
    assert.deepEqual(a.m._normalOpts(ps).spawns,b.m._normalOpts(b.ps('p_0')).spawns);
    const leaked=[{enemyKey:a.m.wave.spawns[0].enemyKey,mods:a.m.wave.spawns[0].mods,sourcePlayerId:'p_0'}];
    const unite=buildUniteWave(a.m.gd,leaked,1,60);
    assert.equal(unite.spawns.reduce((n,s)=>n+s.count,0),1);
    const result=buildResult(a.m,{victory:false,hiddenReached:false,hiddenCleared:false,reason:'test'});
    assert.deepEqual(result.enemyDifficulty.rounds,[plan]);
    const rec=buildRecord(result,{myId:'p_0',now:1});
    assert.deepEqual(rec.enemyDifficulty,result.enemyDifficulty);
    assert.deepEqual(recordToResult(JSON.parse(JSON.stringify(rec))).enemyDifficulty,result.enemyDifficulty);
    assert.equal('enemyDifficulty' in plain.m.publicView(),false);
    assert.equal('enemyDifficulty' in buildResult(plain.m,{victory:false,reason:'test'}),false);
  } finally {a.m.dispose();b.m.dispose();plain.m.dispose();}
});
