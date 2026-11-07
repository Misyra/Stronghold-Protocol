// test/match/kick-vote.test.js — 投票移出 (server/match/match/kickVote.js, 移植自用户分支): the connected humans vote
// out a teammate whose offline seat the AI plays (掉线由 AI 接管). A passed vote removes it exactly like a g.leave
// (m.removed reason 'kicked', then onLeave quits the seat); rejected / timed out / cancelled votes change nothing.
// (本仓无对局快照层, fork 原稿的 checkpoint 断言随之省去.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, ERR } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { KICK_VOTE_MS, kickNeed } from '../../server/match/match/kickVote.js';
import { makeMatch } from './harness.js';

/** n humans (p_0 … p_{n-1}), the last one dropped at the start: by PREP R3 the AI plays its seat. */
function takenOver(n = 4, o = {}) {
  // 超过 4 人的用例挂上容量实验（Match 构造器的座位上限；本测试考的是投票，不是容量）
  const cap = { ...(n > 4 ? { experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 } } : {}) };
  const h = makeMatch({ mode: 'coop', humans: n, seed: 65, fake: true, script: () => ({ duration: 4 }), ...cap, ...o }).start();
  const target = h.ps(`p_${n - 1}`);
  h.m.onDisconnect(target.playerId);
  h.runToPhase(PHASE.PREP, 3);
  assert.ok(target.offlineAutoplay && target.autoplay && !target.connected);
  return { h, m: h.m, target };
}
const ballot = (m, id, agree, voteId = m.kickVote.id) => m.handle(id, { t: 'g.kickBallot', voteId, agree });

test('protocol and thresholds: g.kickVote { targetId }, g.kickBallot { voteId, agree }; a strict majority', () => {
  assert.equal(validateC2S({ t: 'g.kickVote', targetId: 'ABCD-p1' }), null);
  assert.equal(validateC2S({ t: 'g.kickBallot', voteId: 1, agree: false }), null);
  for (const msg of [{ t: 'g.kickVote' }, { t: 'g.kickVote', targetId: '' }, { t: 'g.kickBallot', voteId: 0, agree: true },
    { t: 'g.kickBallot', voteId: 1 }, { t: 'g.kickBallot', voteId: 1, agree: 1 }]) {
    assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));
  }
  assert.deepEqual([1, 2, 3, 4, 5, 7].map(kickNeed), [1, 2, 2, 3, 3, 4]);
  assert.equal(KICK_VOTE_MS, 30_000);
});

test('only an offline seat under the AI takeover, only in SP_DRAFT / PREP, never by spectators or for bots', (t) => {
  const h = makeMatch({ mode: 'coop', humans: 3, bots: 1, seed: 65, fake: true, spectators: ['viewer'], script: () => ({ duration: 4 }) }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.WRONG_PHASE, 'INFO_CHECK');
  m.onDisconnect('p_2');
  h.runToPhase(PHASE.PREP, 1);
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.BAD_TARGET, 'offline, not yet taken over');
  const flag = (id) => m.publicView().players.find((p) => p.playerId === id).offlineTakeover;
  assert.equal(flag('p_2'), undefined, 'm.public flags the seat only once the AI plays it');
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'ai_0' }).error, ERR.BAD_TARGET, 'a bot seat');
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_1' }).error, ERR.BAD_TARGET, 'a connected human');
  // its own AI 托管 while connected is not the offline takeover
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: true }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_1' }).error, ERR.BAD_TARGET);
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: false }), { ok: true });
  h.runToPhase(PHASE.COMBAT, 2);
  assert.ok(h.ps('p_2').offlineAutoplay);
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.WRONG_PHASE, 'COMBAT');
  h.runToPhase(PHASE.PREP, 3);
  assert.equal(flag('p_2'), true);
  assert.equal(flag('p_1'), undefined);
  assert.equal(m.handle('viewer', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.SPECTATOR);
  assert.equal(m.handle('p_2', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.NOT_IN_ROOM, 'the offline target itself');
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'stranger' }).error, ERR.BAD_TARGET);
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }), { ok: true });
  assert.equal(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.WRONG_PHASE, 'one vote at a time');
  assert.equal(m.handle('viewer', { t: 'g.kickBallot', voteId: m.kickVote.id, agree: true }).error, ERR.SPECTATOR);
});

test('a passed vote removes the seat exactly like a leave: m.removed kicked, the outcome to the others, eliminated', (t) => {
  const { h, m, target } = takenOver(4);
  t.after(() => m.dispose());
  const now = h.sched.now();
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  const view = h.lastBc('m.public').kickVote;
  assert.deepEqual(view, { id: 1, proposerId: 'p_0', targetId: 'p_3', voters: ['p_0', 'p_1', 'p_2'], agreed: ['p_0'],
    rejected: [], need: 2, deadline: now + m.scaled(KICK_VOTE_MS) });
  assert.equal(ballot(m, 'p_3', true).error, ERR.NOT_IN_ROOM);
  assert.deepEqual(ballot(m, 'p_1', true), { ok: true });
  assert.equal(m.kickVote, null);
  assert.ok(target.left && !target.alive, 'eliminated like a quitter');
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_3').status, 'left');
  assert.equal(m.publicView().kickVote, null);
  const rounds = target.offlineRounds;
  assert.ok(rounds >= 2);
  assert.deepEqual(h.lastTo('p_3', 'm.removed'), { t: 'm.removed', reason: 'kicked', rounds });
  for (const id of ['p_0', 'p_1', 'p_2']) {
    const toast = h.lastTo(id, 'm.toast');
    assert.equal(toast.kind, 'info');
  }
  if (m.bossWaves) assert.ok(m.bossWaves.every((w) => !w.players.includes('p_3')), 'out of the Final Assault pairing');
  h.invariants();
  h.runToPhase(PHASE.COMBAT, 3);
  assert.ok(!m.fields.some((f) => f.players.includes('p_3')));
});

test('rejected, withdrawn, timed out and prep-end votes change nothing; a reconnect cancels', (t) => {
  const { h, m, target } = takenOver(4);
  t.after(() => m.dispose());
  // two of three say no: 3 − 2 < 2, failed at once; no repeat against the target this round
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  assert.deepEqual(ballot(m, 'p_1', false), { ok: true });
  assert.ok(m.kickVote, 'one no: still possible');
  assert.deepEqual(ballot(m, 'p_2', false), { ok: true });
  assert.equal(m.kickVote, null);
  assert.ok(!target.left);
  h.sched.advance(300);
  assert.deepEqual(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_3' }), { error: ERR.ALREADY, detail: 'kick-failed-this-round' });
  // next round: allowed again; the proposer withdraws
  h.runToPhase(PHASE.PREP, 4);
  assert.deepEqual(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  assert.deepEqual(ballot(m, 'p_1', false), { ok: true });
  assert.equal(m.kickVote, null);
  assert.ok(!target.left);
  // a 300 ms burst guard per proposing player
  assert.deepEqual(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_3' }), { error: ERR.RATE });
  // nobody answers: it times out after 30 s
  assert.deepEqual(m.handle('p_2', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  h.sched.advance(m.scaled(KICK_VOTE_MS) - 1);
  assert.ok(m.kickVote);
  h.sched.advance(1);
  assert.equal(m.kickVote, null);
  assert.ok(!target.left);
  // the prep ending (everyone ready) cancels an open vote
  h.runToPhase(PHASE.PREP, 5);
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  for (const id of ['p_0', 'p_1', 'p_2']) m.handle(id, { t: 'g.ready', ready: true });
  h.run(() => m.phase !== PHASE.PREP);
  assert.equal(m.kickVote, null);
  assert.ok(!target.left);
  // the target reconnecting hands the seat back and cancels the vote
  h.runToPhase(PHASE.PREP, 6);
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  m.onReconnect('p_3');
  assert.equal(m.kickVote, null);
  assert.ok(!target.autoplay && !target.left);
});

test('a voter who disconnects is dropped and the vote recounted', (t) => {
  const { h, m, target } = takenOver(4);
  t.after(() => m.dispose());
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  assert.equal(m.kickVote.voters.length, 3);
  m.onDisconnect('p_1');
  assert.equal(m.kickVote.voters.length, 2, 'the disconnected voter is dropped');
  assert.equal(m.kickVote.need, 2);
  assert.ok(m.kickVote);
  assert.ok(!target.left);
});

test('the same ballot cast again settles nothing and broadcasts nothing (no forced m.public)', (t) => {
  const { h, m, target } = takenOver(5);
  t.after(() => m.dispose());
  // 5 humans, the last taken over: voters = 4, need = 3 — two yes votes keep the vote open
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_4' }), { ok: true });
  assert.deepEqual(ballot(m, 'p_1', true), { ok: true });
  const pubs = () => h.bc.filter((x) => x.t === 'm.public').length;
  const before = pubs();
  for (let i = 0; i < 10; i++) assert.deepEqual(ballot(m, 'p_1', true), { ok: true }, 'answered ok');
  assert.equal(pubs(), before, 'ten repeated yes ballots: not one m.public frame');
  assert.equal(m.kickVote.agreed.size, 2, 'the tally did not move');
  assert.ok(m.kickVote);
  // the no side: one real ballot broadcasts, its repeats do not
  assert.deepEqual(ballot(m, 'p_1', false), { ok: true });
  assert.ok(pubs() > before, 'a real ballot still settles and broadcasts');
  const afterFlip = pubs();
  for (let i = 0; i < 10; i++) assert.deepEqual(ballot(m, 'p_1', false), { ok: true }, 'answered ok');
  assert.equal(pubs(), afterFlip, 'ten repeated no ballots: not one m.public frame');
  assert.deepEqual([...m.kickVote.rejected], ['p_1']);
  assert.ok(m.kickVote);
  assert.ok(!target.left);
});
