// test/match/draft-repeat-drive.test.js — 扩编机变的并发驱动（移植自用户分支 test/match/draft-repeat-drive.test.js）：
// 虚拟人类驱动在扩编房间复用六个选项，不等待任何超时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';

for (const capacity of [8, 12, 16, 20]) test(`virtual human driver reuses six options in ${capacity}-mode without waiting for timeouts`, t => {
  const h = makeMatch({ humans: capacity, experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: capacity } });
  t.after(() => h.m.dispose());
  const m = h.m;
  m.round = 3;
  for (const ps of m.order) ps.lp = 28;
  m.enterSpDraft();
  const draft = m.sp;
  assert.equal(draft.cards.length, 6);
  draft.order = m.order.map(ps => ps.playerId);
  draft.idx = 0;
  m.startSpTurn();
  const start = h.sched.now();
  assert.equal(h.drive(() => m.phase === 'PREP', { ready: false, maxSteps: 3 }), true);
  assert.equal(h.sched.now(), start, 'all human choices complete before a turn deadline');
  assert.equal(Object.keys(draft.picks).length, capacity);
  assert.ok(Object.values(draft.picks).every(idx => idx === 0));
});
