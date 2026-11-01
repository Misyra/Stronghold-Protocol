// test/match/speed-vote.test.js — 战斗 2 倍速的全员投票（g.speedVote，右上角 2X 按钮；match/speedVote.js）：
// 全部在线人类席位都投赞成 → 下一回合 startRound 换速度档（原速 2 ⇄ 两倍 4）。投票随时可取消（再点即撤），
// 全员赞成在换档时点重算——有人撤回就不换；生效后清空，再投即开始反向投票（2 倍速中投「恢复原速」）。
// gameSpeed 只改推流节奏与截止期限的实时长度（deadline = now + limit/gameSpeed），战斗模拟确定性不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { GAME_SPEED } from '../../server/match/fields.js';
import { SPEED_UP } from '../../server/match/match/speedVote.js';

const humansOf = (h) => [...h.m.players.values()].filter((ps) => !ps.isBot);
const vote = (h, ps, on) => h.m.handle(ps.playerId, { t: 'g.speedVote', on });
const pendingOf = (h) => h.m.publicView().speedVote.pending;

test('unanimous 2× vote takes effect from the next round, and a unanimous revert undoes it', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 7, fake: true });
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
  // 第二票凑齐：播报、实时 pending，本回合仍是原速
  assert.equal(vote(h, b, true).ok, true);
  assert.equal(pendingOf(h), true);
  assert.equal(h.m.gameSpeed, GAME_SPEED, 'this round is untouched');
  assert.ok(h.lastBc('m.ticker'), 'the room hears the unanimous agreement');
  // 下一回合起 2 倍速，投票清空
  h.toPrep(2);
  assert.equal(h.m.gameSpeed, SPEED_UP);
  assert.equal(h.m.speedVotes.length, 0);
  assert.equal(pendingOf(h), false);
  // 2 倍速中再投 = 「恢复原速」的反向投票：凑齐后下一回合回原速
  assert.equal(vote(h, a, true).ok, true);
  assert.equal(h.m.publicView().speedVote.count, 1);
  assert.equal(vote(h, b, true).ok, true);
  assert.ok(h.lastBc('m.ticker'), 'the revert announces too');
  h.toPrep(3);
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
  // 撤回一票：全员赞成实时消失，本回合与之后的回合都不换档
  assert.equal(vote(h, b, false).ok, true);
  assert.equal(pendingOf(h), false);
  assert.equal(vote(h, a, false).ok, true);
  assert.equal(h.m.speedVotes.length, 0);
  h.toPrep(2);
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
  assert.deepEqual({ count: pub.count, need: pub.need, pending: pub.pending, on: pub.on }, { count: 1, need: 2, pending: false, on: false });
  vote(h, b, true);
  pub = h.m.publicView().speedVote;
  assert.equal(pub.pending, true);
  // 撤回立即反映
  vote(h, b, false);
  assert.equal(h.m.publicView().speedVote.pending, false);
  h.m.dispose();
});
