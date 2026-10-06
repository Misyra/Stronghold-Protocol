// test/sim/feedback5-cb4-pins.test.js — community reports of 2026-10-06 that this tree already answers, pinned (DESIGN
// §25.18; they pass on the parent commit — nothing changed for them):
//   item 6 「每局游戏开始展示的敌人类型（折射、飞行等等），实际出现波次在7到9波，而且每个最多三波，其余波次用特异类型填充」 — the
//     official type schedule (client RandomEnemyGenerater, research 08 §2.1; act2autochess specialEnemyRandomTypeDict count 3,
//     constData maxLevelCnt 15 / specialEnemyNum 3 / enemyTypeIdentifierToFillRandom 1): each briefing type owns 3 of the
//     15 round slots, SPECIAL (特异) the other 6, shuffled — R14 (leader) and R15 (hidden core) take slots too, so the 13
//     normal rounds hold 7–9 type waves, at most 3 per type;
//   item 57 「囚犯敌人的解放状态联防时不应继承」 — a leaked prisoner re-enters 联防 as a new spawn (unite.js planUnite →
//     waves.js buildUniteWave: its key and spawn mods only), confined again (archetypes.js prisoner spawn); the freed look
//     the report saw was 普通 / 老练囚犯's red clip set drawn from the gate, fixed with the prisoners' forms (§25.14.1).
// Run: node --test test/sim/feedback5-cb4-pins.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { GameData } from '../../server/match/gamedata.js';
import { setupMatchWaves, buildUniteWave } from '../../server/match/waves.js';
import { planUnite } from '../../server/match/unite.js';
import { createRng } from '../../server/sim/rng.js';
import { DATA } from '../match/harness.js';

test('item 6: the three briefing types fill 7–9 of the 13 normal waves (险境 / 绝境 / 终极), at most 3 each; the rest are SPECIAL', () => {
  for (const modeId of ['mode_multi_normal', 'mode_single_hard', 'mode_multi_abyss']) {
    const gd = new GameData(DATA, modeId);
    assert.equal(gd.bossRound, 14);
    const totals = new Set();
    for (let seed = 1; seed <= 200; seed++) {
      const s = setupMatchWaves(gd, createRng(seed));
      const normal = s.typeSlots.slice(0, gd.bossRound - 1);
      const per = s.factions.map((f) => normal.filter((t) => t === f).length);
      for (const n of per) assert.ok(n >= 1 && n <= 3, `${modeId} seed ${seed}: ${per}`);
      const total = per.reduce((a, b) => a + b, 0);
      assert.ok(total >= 7 && total <= 9, `${modeId} seed ${seed}: ${total}`);
      assert.equal(normal.filter((t) => t === 'SPECIAL').length, normal.length - total, 'every other wave is SPECIAL');
      totals.add(total);
    }
    assert.deepEqual([...totals].sort(), [7, 8, 9], `${modeId}: all three totals occur`);
  }
});

test('item 57: a prisoner freed in its own combat leaks and re-enters 联防 confined (no freed form, the confinement buff, freed only by its own attacks there)', () => {
  const KEY = 'enemy_1116_liprr'; // 普通囚犯
  const wall = chessRec({ id: 't_wall', profession: 'TANK', stats: { atk: 0, maxHp: 1e9, def: 0, blockCnt: 3 }, rangeGrid: [[0, 0]], skill: null });
  const kits = { t_wall: () => ({ trait: { noAttack: true } }) };
  const h = makeBattle({ autoFinish: false, timeLimit: 120, defs: { chess: { t_wall: wall } }, kits, units: [{ chessId: 't_wall', row: 9, col: 6 }], enemies: [{ key: KEY, route: 0 }] });
  assert.ok(h.runUntil(() => h.enemy(KEY) && h.enemy(KEY).form === 'liberty', 60), 'freed by its own attacks');
  const p = h.enemy(KEY);
  assert.ok(p.findBuff('ab:liberty') && !p.findBuff('ab:confined'));
  h.b.retreat(h.unit('t_wall'));
  assert.ok(h.runUntil(() => !p.alive, 60), 'it walks on and leaks');
  const r = h.result().perPlayer.p1;
  assert.deepEqual(r.leaked.filter((l) => l.counted !== false).map((l) => l.enemyKey), [KEY]);
  checkInvariants(h.b);
  // 联防: the leaker's counted leak re-enters on the escaped template of one helper
  const gd = new GameData(DATA, 'mode_multi_normal');
  const seat = (id, s) => ({ playerId: id, seat: s, deployCount: 1, bonds: {}, layers: {}, board: new Map(), bounties: [] });
  const m = { isSolo: false, alivePlayers: () => [seat('p1', 1), seat('H', 0)], gd: { unite: { maxHelpers: 2 }, enemy: (k) => gd.enemy(k) } };
  const plan = planUnite(m, new Map([['p1', r], ['H', { perfect: true, leaked: [], unitsEnd: [] }]]));
  assert.deepEqual(plan.leaked.map((l) => l.enemyKey), [KEY]);
  assert.deepEqual(Object.keys(plan.leaked[0]).sort(), ['bounty', 'enemyKey', 'lpr', 'mods', 'sourcePlayerId', 'tag'], 'nothing of its state travels');
  const wave = buildUniteWave(gd, plan.leaked, 1, 60);
  const u = makeBattle({
    kind: 'unite', stageId: 'act1autochess_escaped_single', autoFinish: false, timeLimit: 60, routes: wave.routes,
    defs: { chess: { t_wall: wall } }, kits, units: [{ chessId: 't_wall', row: 9, col: 8 }],
    enemies: wave.spawns.map((s) => ({ key: s.enemyKey, time: s.time, route: s.routeIndex, mods: s.mods, sourcePlayerId: s.sourcePlayerId })),
  });
  assert.ok(u.runUntil(() => u.enemy(KEY), 30), 're-entered');
  const q = u.enemy(KEY);
  assert.equal(q.form ?? null, null, 'drawn confined');
  assert.ok(q.findBuff('ab:confined') && !q.findBuff('ab:liberty'), 'confined again');
  assert.ok(u.runUntil(() => q.stats.attacks >= 1, 40), 'blocked, it attacks');
  assert.equal(q.form ?? null, null, 'still confined after its first 联防 attack');
  assert.ok(u.runUntil(() => q.form === 'liberty', 60), 'freed again only by its own attacks there');
  assert.equal(q.stats.attacks, 4, 'at its 4th attack in 联防 (confinement.times), as in a fresh spawn');
  checkInvariants(u.b);
});
