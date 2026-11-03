// test/match/speed-vote.test.js — 战斗 2 倍速的全员投票（g.speedVote，右上角 2X 按钮；match/speedVote.js）：
// 全部在线人类席位都投赞成 → 下一场战斗建立前换速度档（原速 2 ⇄ 两倍 4）——startCombat / startUnite /
// startFinalAssault 各应用一次，正在进行的战斗不会中途变速。投票随时可取消（再点即撤），全员赞成在换档时点
// 重算——有人撤回就不换；生效后清空，再投即开始反向投票（2 倍速中投「恢复原速」）。
// gameSpeed 只改推流节奏与截止期限的实时长度（deadline = now + limit/gameSpeed），战斗模拟确定性不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeMatch } from './harness.js';
import { GAME_SPEED } from '../../server/match/fields.js';
import { SPEED_UP } from '../../server/match/match/speedVote.js';

const humansOf = (h) => [...h.m.players.values()].filter((ps) => !ps.isBot);
const vote = (h, ps, on) => h.m.handle(ps.playerId, { t: 'g.speedVote', on });
const pendingOf = (h) => h.m.publicView().speedVote.pending;

test('a prep vote speeds up the battle that follows — at its start, never mid-battle', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 7, fake: true, instant: false });
  h.start();
  h.toPrep(1);
  assert.equal(h.m.gameSpeed, GAME_SPEED);
  const [a, b] = humansOf(h);
  // 一票不成事；bot 不能投
  assert.equal(vote(h, a, true).ok, true);
  assert.equal(pendingOf(h), false);
  assert.equal(h.m.gameSpeed, GAME_SPEED);
  const bot = [...h.m.players.values()].find((ps) => ps.isBot);
  assert.notEqual(vote(h, bot, true).ok, true);
  // 第二票凑齐：播报、实时 pending；战斗还没开始，速度不变
  assert.equal(vote(h, b, true).ok, true);
  assert.equal(pendingOf(h), true);
  assert.equal(h.m.gameSpeed, GAME_SPEED, 'a vote alone changes nothing');
  assert.ok(h.lastBc('m.ticker'), 'the room hears the unanimous agreement');
  // 下一场战斗（本回合的 COMBAT）开始时生效：换档、清空投票、按钮熄灭
  h.runToPhase('COMBAT', 1);
  assert.equal(h.m.gameSpeed, SPEED_UP);
  assert.equal(h.m.speedVotes.length, 0);
  let pub = h.m.publicView().speedVote;
  assert.deepEqual({ count: pub.count, need: pub.need, pending: pub.pending, on: pub.on, speed: pub.speed },
    { count: 0, need: 2, pending: false, on: true, speed: SPEED_UP });
  const limit = h.m.wave.timeLimit;
  assert.equal(h.m.deadline - h.m.sched.now(), Math.round((limit / SPEED_UP) * 1000), 'the countdown is the sped-up one');
  for (const p of humansOf(h)) assert.equal(h.lastTo(p.playerId, 'm.private').speedVoted, false, `${p.playerId}: the button unlights`);
  // 战斗进行中再投 = 「恢复原速」的反向投票：本场不变速
  assert.equal(vote(h, a, true).ok, true);
  assert.equal(vote(h, b, true).ok, true);
  assert.equal(h.m.gameSpeed, SPEED_UP, 'the running battle keeps its speed');
  assert.equal(h.m.publicView().speedVote.pending, true);
  assert.ok(h.lastBc('m.ticker'), 'the revert announces too');
  // 下一场战斗（第 2 回合）建立前回原速
  h.toPrep(2);
  h.runToPhase('COMBAT', 2);
  assert.equal(h.m.gameSpeed, GAME_SPEED);
  assert.equal(h.m.speedVotes.length, 0);
  h.invariants();
  h.m.dispose();
});

test('a retract cancels the unanimity and the speed never changes without it', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 7, fake: true });
  h.start();
  h.toPrep(1);
  const [a, b] = humansOf(h);
  vote(h, a, true);
  vote(h, b, true);
  assert.equal(pendingOf(h), true);
  // 撤回一票：全员赞成实时消失；本场以及之后的战斗都不换档
  assert.equal(vote(h, b, false).ok, true);
  assert.equal(pendingOf(h), false);
  assert.equal(vote(h, a, false).ok, true);
  assert.equal(h.m.speedVotes.length, 0);
  h.runToPhase('COMBAT', 1);
  assert.equal(h.m.gameSpeed, GAME_SPEED, 'never doubled without unanimity');
  h.m.dispose();
});

test('the public view carries the live vote state the 2X button renders', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 7, fake: true });
  h.start();
  h.toPrep(1);
  const [a, b] = humansOf(h);
  vote(h, a, true);
  let pub = h.m.publicView().speedVote;
  assert.deepEqual({ count: pub.count, need: pub.need, pending: pub.pending, on: pub.on, speed: pub.speed },
    { count: 1, need: 2, pending: false, on: false, speed: GAME_SPEED });
  vote(h, b, true);
  pub = h.m.publicView().speedVote;
  assert.equal(pub.pending, true);
  // 撤回立即反映
  vote(h, b, false);
  assert.equal(h.m.publicView().speedVote.pending, false);
  h.m.dispose();
});

test('an offline voter neither counts nor blocks; the displayed count is the connected voters only', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 3, bots: 0, seed: 7, fake: true });
  h.start();
  h.toPrep(1);
  h.m.handle('p_0', { t: 'g.speedVote', on: true });
  h.m.handle('p_1', { t: 'g.speedVote', on: true });
  let pub = h.m.publicView().speedVote;
  assert.deepEqual({ count: pub.count, need: pub.need }, { count: 2, need: 3 });
  // p_1 掉线：它的票不显示也不计；剩下的 p_0 / p_2 里只有 p_0 赞成
  h.m.onDisconnect('p_1');
  pub = h.m.publicView().speedVote;
  assert.deepEqual({ count: pub.count, need: pub.need, pending: pub.pending }, { count: 1, need: 2, pending: false });
  // p_2 也掉线：只剩 p_0，一票即全员赞成
  h.m.onDisconnect('p_2');
  pub = h.m.publicView().speedVote;
  assert.deepEqual({ count: pub.count, need: pub.need, pending: pub.pending }, { count: 1, need: 1, pending: true });
  h.m.dispose();
});

test('an eliminated voter\'s button unlights when the vote takes effect (no stale private view)', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 7, fake: true });
  h.start();
  h.toPrep(1);
  const [a, b] = humansOf(h);
  b.eliminate(1); // 阵亡后观战的人类仍可投票
  vote(h, a, true);
  vote(h, b, true);
  assert.equal(pendingOf(h), true);
  h.runToPhase('COMBAT', 1);
  assert.equal(h.m.gameSpeed, SPEED_UP);
  assert.equal(h.lastTo(b.playerId, 'm.private').speedVoted, false, 'the eliminated voter is told the vote was consumed');
  h.m.dispose();
});

test('the switch is applied when each battle is built — never at a round start', () => {
  const src = (f) => readFileSync(new URL(`../../server/match/match/${f}`, import.meta.url), 'utf8');
  assert.match(src('combat.js'), /startCombat\(\) \{\n    this\._applySpeedVote\(\);/);
  assert.match(src('unitePhase.js'), /startUnite\(plan\) \{\n    this\._applySpeedVote\(\);/);
  assert.match(src('bossRounds.js'), /startFinalAssault\(hidden\) \{\n    this\._applySpeedVote\(\);/);
  const phases = src('phases.js');
  const from = phases.indexOf('_startRoundAfterOffers(r) {');
  const to = phases.indexOf('afterRoundStart()', from);
  assert.ok(from > 0 && to > from, 'the round-start method');
  assert.doesNotMatch(phases.slice(from, to), /_applySpeedVote/, 'a vote cast in prep must not wait for the next round start');
});
