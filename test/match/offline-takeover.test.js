// test/match/offline-takeover.test.js — 掉线由 AI 接管 (OFFLINE_TAKEOVER_ROUNDS, MatchPlatform._checkOffline):
// a seat offline for two prep ends is played by the AI from the next phase on (autoplay + offlineAutoplay), and a
// reconnect takes the seat back. setAutoplay by the player himself never sets the mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { OFFLINE_TAKEOVER_ROUNDS } from '../../server/match/match/common.js';

test('a seat offline for OFFLINE_TAKEOVER_ROUNDS prep ends is taken over by the AI; reconnect releases it', (t) => {
  const h = makeMatch({ humans: 2 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  const ps = h.ps('p_1');
  m.onDisconnect('p_1');
  assert.equal(ps.connected, false);
  assert.equal(ps.autoplay, false);
  for (let i = 1; i < OFFLINE_TAKEOVER_ROUNDS; i++) {
    m._checkOffline();
    assert.equal(ps.autoplay, false, `still the player's seat after ${i} offline prep ends`);
    assert.equal(ps.offlineRounds, i);
  }
  m._checkOffline();
  assert.equal(ps.autoplay, true, 'the AI plays the seat');
  assert.equal(ps.offlineAutoplay, true, 'and it is marked as a takeover');
  assert.equal(ps.botControlled, true);
  assert.ok(h.bc.some((f) => f.t === 'm.ticker' || f.t === 'm.toast'), 'the takeover is announced');
  // the player comes back: the seat is his again
  m.onReconnect('p_1');
  assert.equal(ps.autoplay, false);
  assert.equal(ps.offlineAutoplay, false);
  assert.equal(ps.offlineRounds, 0);
  assert.equal(ps.botControlled, false);
});

test('a player who turns on AI 托管 himself is not marked as an offline takeover', (t) => {
  const h = makeMatch({ humans: 2 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  const ps = h.ps('p_1');
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: true }), { ok: true });
  assert.equal(ps.autoplay, true);
  assert.equal(ps.offlineAutoplay, false);
  // reconnecting (a resync on a live seat) does not take his own 托管 away
  m.onReconnect('p_1');
  assert.equal(ps.autoplay, true, 'his own choice stays');
});

test('solo (untimed) never takes a seat over', (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  m.onDisconnect('p_0');
  for (let i = 0; i < OFFLINE_TAKEOVER_ROUNDS + 1; i++) m._checkOffline();
  assert.equal(h.ps('p_0').autoplay, false);
});

test('endPrep runs the check (a live round counts an offline prep)', (t) => {
  const h = makeMatch({ humans: 2 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  h.runToPhase('PREP');
  m.onDisconnect('p_1');
  const round = m.round;
  m.prepDeadline();
  assert.ok(m.round > round || m.phase !== 'PREP', 'the prep ended');
  assert.equal(h.ps('p_1').offlineRounds, 1, 'the offline prep was counted');
});
