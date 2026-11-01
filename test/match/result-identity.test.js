// The settlement's stable identity (server/match/results.js buildResult): matchId = room code + battle prefix +
// startedAt, plus the startedAt / finishedAt ticks. The client's record store dedupes on it (public/js/ui/stats.js
// recordId) — a replayed m.result (lobby result replay after a reconnect) must hit the same id, and two matches of
// the same room that replay the same seed must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResult } from '../../server/match/results.js';
import { makeMatch } from './harness.js';
import { recordId } from '../../public/js/ui/stats.js';

test('matchId format: roomCode-battlePrefix-startedAt, with the startedAt / finishedAt ticks; deterministic per match', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, seed: 80, matchNo: 3, fake: true }).start();
  const m = h.m;
  h.toPrep(2);
  const a = buildResult(m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'abandoned' });
  const b = buildResult(m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'abandoned' });
  assert.equal(a.matchId, `${m.roomCode}-${m.battlePrefix}-${m.startedAt}`, 'the documented shape');
  assert.match(a.matchId, /^TEST-[0-9a-z]+-3-[0-9]+$/, 'room code, seed(+match no) base36 prefix, start tick');
  assert.equal(a.startedAt, m.startedAt);
  assert.equal(a.finishedAt, m.sched.now());
  assert.ok(Number.isFinite(a.startedAt) && Number.isFinite(a.finishedAt));
  assert.ok(a.finishedAt >= a.startedAt);
  // the same match, asked twice: the same identity (a replayed / re-built result never changes ids)
  assert.equal(a.matchId, b.matchId);
  assert.equal(a.startedAt, b.startedAt);
  assert.equal(a.finishedAt, b.finishedAt);
  m.dispose();
});

test('two matches of the same room that replay the same seed still get different ids', () => {
  const h1 = makeMatch({ mode: 'solo', humans: 1, seed: 7, fake: true }).start();
  h1.toPrep(1);
  // the harness clock starts every match on the same virtual tick; a room's next match starts later, which is
  // exactly a larger startedAt — the third component of the id — so shift it the way that start would
  const h2 = makeMatch({ mode: 'solo', humans: 1, seed: 7, fake: true }).start();
  h2.toPrep(1);
  h2.m.startedAt = h2.m.sched.now() + 5000;
  const r1 = buildResult(h1.m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'defeat' });
  const r2 = buildResult(h2.m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'defeat' });
  assert.notEqual(r1.matchId, r2.matchId, 'the second match starts later on its match clock');
  // a room's nth match names its matchNo in the battle prefix, so the ids differ even on one tick
  const h3 = makeMatch({ mode: 'solo', humans: 1, seed: 7, matchNo: 2, fake: true }).start();
  h3.toPrep(1);
  const r3 = buildResult(h3.m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'defeat' });
  assert.notEqual(r1.matchId, r3.matchId);
  for (const h of [h1, h2, h3]) h.m.dispose();
});

test('every human gets the same identity: the unicast frames are copies of one result, and a re-built one matches', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 4, fake: true }).start();
  h.autoHumans();
  const end = h.runToEnd();
  const frames = h.sent.filter(([, msg]) => msg.t === 'm.result');
  assert.ok(frames.length >= 2, 'each seated human got its own frame');
  const ids = new Set(frames.map(([, msg]) => msg.matchId));
  assert.equal(ids.size, 1, 'every frame names the same matchId');
  const ticks = new Set(frames.map(([, msg]) => `${msg.startedAt}/${msg.finishedAt}`));
  assert.equal(ticks.size, 1, 'every frame names the same startedAt / finishedAt');
  assert.equal(end.matchId, [...ids][0]);
  assert.equal(end.matchId, `${h.m.roomCode}-${h.m.battlePrefix}-${h.m.startedAt}`);
  // a re-built result (the server's m.lastResultMsg path is the one it sent): the same identity bytes
  const again = buildResult(h.m, h.m.outcome);
  const { playerId, ...first } = frames[0][1];
  assert.deepEqual(again.matchId, first.matchId);
  assert.deepEqual(again.startedAt, first.startedAt);
  // two frames to two players differ only in playerId — the replay stores the encoded frame and resends it as-is
  const [, f0] = frames[0];
  const [, f1] = frames[1];
  assert.deepEqual({ ...f0, playerId: null }, { ...f1, playerId: null });
  h.m.dispose();
});

test('recordId: a matchId payload names the match; the legacy content hash stays for payloads without one', () => {
  const base = { t: 'm.result', seed: 123456789, durationMs: 952123, modeId: 'mode_multi_hard', roundsPassed: 15, victory: true };
  // the matchId path: the id is the match itself, myId and the rest of the payload do not matter
  const withId = { ...base, matchId: 'ABCD-1a2b3c-952123' };
  assert.equal(recordId(withId, 'p1'), 'm1.ABCD-1a2b3c-952123');
  assert.equal(recordId(withId, 'p2'), 'm1.ABCD-1a2b3c-952123', 'a replayed result hits the same id');
  // two same-seed matches (the content hash would merge) stay apart once the server stamps matchId
  assert.notEqual(recordId({ ...withId, matchId: 'ABCD-1a2b3c-952124' }, 'p1'), recordId(withId, 'p1'));
  // the fallback path (an older server): the former content hash, deterministic, the test suffix kept
  const legacy = (over) => recordId({ ...base, ...over }, 'p1');
  const a = legacy({});
  assert.match(a, /^r1\.[0-9a-f]{8}$/);
  assert.equal(a, legacy({}));
  assert.equal(legacy({ test: true }), legacy({ test: true }), 'stable per shape');
  assert.notEqual(legacy({ test: true }), a, 'a test result does not collide with a real match of the same facts');
  assert.equal(legacy({ seed: 42 }), recordId({ ...base, seed: 42 }, 'p1'), 'the hash covers the match facts');
});
