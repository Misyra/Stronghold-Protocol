// test/match/rehearsal-window.test.js — the delegated rehearsal's adaptive answer window (DESIGN §14,
// MatchRehearsal.delegateWindowMs): a host that has not answered one task yet — its browser Worker is still loading the
// /sim/ module graph, the eb679687 cold-start loop — gets the cold window (botRehearsalColdMs, default 7 s,
// SP_BOT_REHEARSAL_COLD_ANSWER_MS; 0 pins the fixed window) for its first task, and once it has answered one the warm
// window (botRehearsalDelegateMs, default 3 s, SP_BOT_REHEARSAL_ANSWER_MS) applies again. The window never extends a
// prep: the phase deadline keeps cancelling whatever is still in flight. The engine-level contract of the delegation
// itself lives in test/match/rehearsal-delegate.test.js; this file pins only the window state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { REHEARSAL_COLD_ANSWER_MS, REHEARSAL_ANSWER_MS } from '../../server/match/match/rehearsal.js';
import { makeMatch } from './harness.js';
import { attachRehearsalHost, simulateRehearsal } from './simClient.js';

/** Answers never arrive within these tests' runs (a task is still in flight when the test acts). */
const NEVER = 1e9;

/** A co-op match whose two human seats autoplay (the host plays like a bot) so every seat's prep can delegate. */
function coopMatch(o = {}) {
  const seats = [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true },
    { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, connected: true },
    { seat: 2, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true },
    { seat: 3, playerId: 'ai_1', name: 'AI1', isBot: true, connected: true },
  ];
  const { host, ...opts } = o;
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats, seed: 5, botRehearsal: 3, ...opts }).start();
  h.autoHumans();
  return h;
}

test('the window state machine: cold for a host that has not answered one, warm from its first answer on', () => {
  const h = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true, botRehearsalColdMs: 7000, botRehearsalDelegateMs: 3000 });
  const m = h.m;
  assert.equal(m.botRehearsalColdMs, 7000);
  assert.equal(m.delegateWindowMs(), 7000, 'no answered record: the cold window');
  const host = attachRehearsalHost(h, { manual: true });
  h.run(() => host.tasks.length > 0, { maxSteps: 3e6 });
  const task = host.tasks[0];
  assert.equal(m.delegateWindowMs(), 7000, 'still cold while the first task is in flight');
  host.answer(task, { choice: simulateRehearsal(task.frame, m.ds) });
  assert.equal(m.rehearsalStats.answered, 1);
  assert.equal(m.delegateWindowMs(), 3000, 'the first accepted answer warms the host');
  // a second host is cold again (a migration replaces the Worker, the module graph loads from scratch there)
  m.setHost('p_1');
  assert.equal(m.delegateWindowMs(), 7000, 'a new host starts cold');
  h.m.dispose();
});

test('a cold host that never answers times out in the cold window, and a warm one in the warm window', () => {
  const h = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true, botRehearsalColdMs: 7000, botRehearsalDelegateMs: 3000 });
  const m = h.m;
  const host = attachRehearsalHost(h, { mute: true }); // tasks are collected, never answered — until the test answers one
  h.run(() => host.tasks.length > 0, { maxSteps: 8e6 });
  const sentAt = h.sched.now();
  assert.equal(m.rehearsalStats.takeovers, 0);
  h.sched.advance(m.scaled(7000) - 1);
  assert.equal(m.rehearsalStats.takeovers, 0, 'one ms short of the cold window the task is still the host\'s');
  h.sched.advance(1);
  assert.equal(m.rehearsalStats.takeovers, 1, 'the cold window is what expires, not the warm one');
  assert.equal(h.sched.now() - sentAt, m.scaled(7000));
  // the takeover did not answer anything, so the next task waits cold again — until an answer warms the host
  h.run(() => host.tasks.length > 1, { maxSteps: 8e6 });
  host.answer(host.tasks[1], { choice: simulateRehearsal(host.tasks[1].frame, m.ds) });
  assert.equal(m.rehearsalStats.answered, 1);
  h.run(() => host.tasks.length > 2, { maxSteps: 8e6 });
  const warmFrom = h.sched.now();
  h.sched.advance(m.scaled(3000) - 1);
  assert.equal(m.rehearsalStats.takeovers, 1, 'the third task survives one ms short of the warm window');
  h.sched.advance(1);
  assert.equal(m.rehearsalStats.takeovers, 2, 'and expires by it, not by the cold window');
  assert.ok(h.sched.now() - warmFrom >= m.scaled(3000));
  h.m.dispose();
});

test('the cold window never extends a prep: the deadline cancels the task and keeps the default layout', () => {
  const h = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true, botRehearsalColdMs: NEVER, botRehearsalDelegateMs: NEVER });
  const m = h.m;
  const host = attachRehearsalHost(h, { manual: true });
  h.run(() => host.tasks.length > 0, { maxSteps: 3e6 });
  const task = host.tasks[0];
  assert.ok(m._rehearsalTasks.has(task.frame.taskId), 'the cold task is in flight (its window outlives the prep)');
  m.prepDeadline();
  assert.equal(m.phase, PHASE.COMBAT);
  assert.equal(m._rehearsalTasks.size, 0, 'the prep deadline dropped it');
  assert.deepEqual(host.cancels, [task.frame.taskId], 'and told the host to stop');
  assert.equal(m.rehearsalStats.takeovers, 0, 'nothing of it ran after the phase ended');
  h.m.dispose();
});

test('botRehearsalColdMs 0 pins the fixed window (the pre-adaptive behaviour), in the engine option and the env', () => {
  const h = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true, botRehearsalColdMs: 0, botRehearsalDelegateMs: 3000 });
  assert.equal(h.m.botRehearsalColdMs, 0);
  assert.equal(h.m.delegateWindowMs(), 3000, 'no cold window: the first task waits the fixed one');
  h.m.dispose();

  const saved = process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS;
  try {
    process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS = '0';
    const m = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true }).m;
    assert.equal(m.botRehearsalColdMs, 0);
    assert.equal(m.delegateWindowMs(), REHEARSAL_ANSWER_MS);
    m.dispose();
  } finally {
    if (saved === undefined) delete process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS;
    else process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS = saved;
  }
});

test('SP_BOT_REHEARSAL_COLD_ANSWER_MS sets the cold window; garbage keeps the default; an explicit opts wins', () => {
  const saved = process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS;
  try {
    delete process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS;
    const plain = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true }).m;
    assert.equal(plain.botRehearsalColdMs, REHEARSAL_COLD_ANSWER_MS, 'unset: the engine default');
    plain.dispose();
    for (const [value, want] of [['3500', 3500], [' 9000 ', 9000], ['abc', REHEARSAL_COLD_ANSWER_MS], ['-1', REHEARSAL_COLD_ANSWER_MS], ['2.5', REHEARSAL_COLD_ANSWER_MS]]) {
      process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS = value;
      const m = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true }).m;
      assert.equal(m.botRehearsalColdMs, want, `SP_BOT_REHEARSAL_COLD_ANSWER_MS=${JSON.stringify(value)}`);
      m.dispose();
    }
    process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS = '9000';
    const pinned = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true, botRehearsalColdMs: 1234 }).m;
    assert.equal(pinned.botRehearsalColdMs, 1234, 'the engine option beats the env');
    pinned.dispose();
  } finally {
    if (saved === undefined) delete process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS;
    else process.env.SP_BOT_REHEARSAL_COLD_ANSWER_MS = saved;
  }
});

test('SP_BOT_REHEARSAL_ANSWER_MS sets the warm window; garbage keeps 3000; an explicit opts wins', () => {
  const saved = process.env.SP_BOT_REHEARSAL_ANSWER_MS;
  try {
    delete process.env.SP_BOT_REHEARSAL_ANSWER_MS;
    const plain = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true }).m;
    assert.equal(plain.botRehearsalDelegateMs, REHEARSAL_ANSWER_MS, 'unset: the engine default');
    plain.dispose();
    for (const [value, want] of [['5000', 5000], [' 12000 ', 12000], ['soon', REHEARSAL_ANSWER_MS], ['0', REHEARSAL_ANSWER_MS], ['-3', REHEARSAL_ANSWER_MS]]) {
      process.env.SP_BOT_REHEARSAL_ANSWER_MS = value;
      const m = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true }).m;
      assert.equal(m.botRehearsalDelegateMs, want, `SP_BOT_REHEARSAL_ANSWER_MS=${JSON.stringify(value)}`);
      m.dispose();
    }
    process.env.SP_BOT_REHEARSAL_ANSWER_MS = '9000';
    const pinned = coopMatch({ hostId: 'p_0', botRehearsalDelegate: true, botRehearsalDelegateMs: 4321 }).m;
    assert.equal(pinned.botRehearsalDelegateMs, 4321, 'the engine option beats the env');
    pinned.dispose();
  } finally {
    if (saved === undefined) delete process.env.SP_BOT_REHEARSAL_ANSWER_MS;
    else process.env.SP_BOT_REHEARSAL_ANSWER_MS = saved;
  }
});
