// test/match/flush-coalesce.test.js — the coalescing view flush (Match.flushSoon, server/match/match/messaging.js).
//
// flushSoon sends the pending views at once while the match has not flushed for DELAYS.PRIVATE_FLUSH (50 ms) and
// otherwise defers them into one send within the window; the battle-report branch of _handleSeatIntent and the guard
// use it so a burst pays one view build per window. On a virtual scheduler it bypasses the coalescing (the suites
// keep the synchronous contract), so these tests run a REAL scheduler and sleep through the window.
// The force events — phase / round / ended changes, results, dispose — call flush() and never wait; the b.progress
// branch keeps them structural (a progress report that ends the fight flushes at once).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { RealScheduler } from '../../server/match/scheduler.js';
import { DATA } from './harness.js';
import { OK } from '../../server/match/match/common.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real-scheduler match with one connected human (no bots, clientCombat so b.progress routes to the reports). */
function makeRealMatch() {
  const sent = [];
  const m = new Match({
    roomCode: 'FLUSH', mode: 'coop', difficulty: 'NORMAL',
    seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }],
    seed: 1, data: DATA,
    send: (id, msg) => { sent.push([id, msg.t]); return true; },
    broadcast: () => {},
    onEnd: () => {},
    scheduler: new RealScheduler(),
    clientCombat: true,
    clients: false,
    botRehearsal: 0,
  });
  return { m, sent };
}

const privatesTo = (sent, id) => sent.filter(([pid, t]) => pid === id && t === 'm.private').length;

test('flushSoon: the first send in a window is immediate, further marks coalesce into one send ≤ 50 ms later', async () => {
  const { m, sent } = makeRealMatch();
  try {
    const ps = m.players.get('p_0');
    m.markPrivate(ps);
    m.flushSoon();
    assert.equal(privatesTo(sent, 'p_0'), 1, 'idle window: sent at once');

    m.markPrivate(ps); // changed state? the view is deduplicated; mark again via a funds change so the JSON differs
    ps.funds += 5;
    ps.dirty();
    m.flushSoon();
    assert.equal(privatesTo(sent, 'p_0'), 1, 'inside the 50 ms window: deferred');
    await sleep(90);
    assert.equal(privatesTo(sent, 'p_0'), 2, 'the pending timer sent the coalesced views');

    // after the window an isolated mark is immediate again (the window counts from the timer's send)
    await sleep(60);
    ps.funds += 5;
    ps.dirty();
    m.flushSoon();
    assert.equal(privatesTo(sent, 'p_0'), 3, 'window elapsed: immediate again');
  } finally { m.dispose(); }
});

test('flushSoon: a pending timer never fires after dispose (no send, no leak)', async () => {
  const { m, sent } = makeRealMatch();
  const ps = m.players.get('p_0');
  m.markPrivate(ps);
  m.flushSoon(); // immediate (idle window)
  ps.funds += 5;
  ps.dirty();
  m.flushSoon(); // deferred
  m.dispose();
  await sleep(90);
  assert.equal(privatesTo(sent, 'p_0'), 2, 'dispose drained the pending marks (flush(true)) and the timer never fired again');
});

test('b.progress coalesces its views; a structural report still force-flushes', async () => {
  const { m, sent } = makeRealMatch();
  try {
    const ps = m.players.get('p_0');
    m.markPrivate(ps);
    assert.deepEqual(m.handle('p_0', { t: 'b.progress', battleId: 'nope', gt: 1, killed: 1, total: 5, resolved: 1 }), OK);
    assert.equal(privatesTo(sent, 'p_0'), 1, 'first report in the window: the pending view goes out at once');

    ps.funds += 5;
    ps.dirty();
    assert.deepEqual(m.handle('p_0', { t: 'b.progress', battleId: 'nope', gt: 2, killed: 2, total: 5, resolved: 2 }), OK);
    assert.equal(privatesTo(sent, 'p_0'), 1, 'the second report did not rebuild/send the private view');
    await sleep(90);
    assert.equal(privatesTo(sent, 'p_0'), 2, 'the coalesced window delivered it');
  } finally { m.dispose(); }
});
