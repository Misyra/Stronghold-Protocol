// test/persist-worker.test.js — the persistence Worker split (server/workers/persistence.js + persist.js): a capture
// survives the Worker's structured clone losslessly, an idle room's body stays byte-stable while its clocks move, and
// an encode that outlives its match is never committed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE } from '../shared/constants.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Match as RealMatch } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { captureMatch, encodeMatchCapture, canSnapshot } from '../server/match/snapshot.js';
import { Persister } from '../server/persist.js';
import { PersistenceWorker } from '../server/workers/persistenceClient.js';
import { FakeBattle } from './match/fakeBattle.js';
import { makeMatch } from './match/harness.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const OPTIONS = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 42, fake: true, botSliceMs: 4 };

/** The real engine on a virtual clock (same trick as persist.test.js). */
class TestMatch extends RealMatch {
  constructor(opts) {
    super({
      ...opts,
      scheduler: new VirtualScheduler({ instantCombat: true }),
      BattleClass: FakeBattle,
      botRehearsal: 0,
      clientCombat: false,
    });
  }
}

/** One scheduling step with the harness's automatic human decisions (`ready: false` holds the prep). */
function step(h, { ready = true } = {}) {
  const m = h.m;
  if (m.ended || m.disposed) return false;
  for (const ps of m.players.values()) {
    if (ps.isBot || ps.left) continue;
    if (m.phase === PHASE.INFO_CHECK && !ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' });
    else if (m.phase === PHASE.BAND_DRAFT && m.draftTurn() === ps.playerId) m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' });
    else if (m.phase === PHASE.SP_DRAFT && m.spTurn() === ps.playerId) {
      const idx = m.sp.cards.map((c) => c.idx).find((k) => m.sp.taken[k] == null);
      if (idx != null) m.handle(ps.playerId, { t: 'g.choice', idx });
    } else if (ready && m.phase === PHASE.PREP && ps.alive && !ps.ready) {
      if (!ps.tempEmpty) ps.resolveTemp();
      m.handle(ps.playerId, { t: 'g.ready', ready: true });
    }
  }
  return h.sched.runNext();
}

function driveTo(h, pred, { maxSteps = 2e6, ready = true } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (pred(h.m)) return true;
    if (!step(h, { ready })) break;
  }
  return pred(h.m);
}

/** The smallest match surface canSnapshot/captureMatch accept — enough for clock/stability unit tests. */
function stubMatch({ now, deadline = 0, startedAt = now() }) {
  return {
    disposed: false, ended: false, phase: PHASE.INFO_CHECK,
    sched: { now },
    pool: { entries: new Map() },
    deadline, startedAt,
    order: [], alivePlayers: () => [],
  };
}

test('the persistence Worker encodes a capture identically to the synchronous path', async (t) => {
  const h = makeMatch({ ...OPTIONS, seed: 7 });
  h.m.start();
  assert.ok(driveTo(h, () => h.m.phase === PHASE.PREP && canSnapshot(h.m), { ready: false }), 'reached a quiet prep');
  const capture = captureMatch(h.m);
  assert.ok(capture, 'captured');
  const sync = encodeMatchCapture(capture);

  const worker = new PersistenceWorker();
  t.after(() => worker.close());
  // Worker.postMessage structured-clones the payload: this request is exactly what the Persister sends.
  const { clocks, body } = await worker.request('encode', { capture: structuredClone(capture) });
  const { deadlineRemainingMs, startedAtAgoMs, ...rest } = sync;
  assert.deepEqual(clocks, { deadlineRemainingMs, startedAtAgoMs });
  assert.deepEqual(JSON.parse(body), rest, 'the clone lost nothing the codec needed');
});

test('clocks travel outside the body: an idle room stays byte-stable while its clocks move', async (t) => {
  const worker = new PersistenceWorker();
  t.after(() => worker.close());
  let now = 10_000;
  const m = stubMatch({ now: () => now, deadline: 65_000, startedAt: 4_000 });
  const one = await worker.request('encode', { capture: structuredClone(captureMatch(m)) });
  now = 21_000;
  const two = await worker.request('encode', { capture: structuredClone(captureMatch(m)) });
  assert.notEqual(one.clocks.deadlineRemainingMs, two.clocks.deadlineRemainingMs, 'the phase clock moved');
  assert.notEqual(one.clocks.startedAtAgoMs, two.clocks.startedAtAgoMs, 'the age moved');
  assert.equal(one.body, two.body, 'the body is byte-stable');
  assert.equal('deadlineRemainingMs' in JSON.parse(one.body), false, 'the body carries no clock');
});

test('an encode that outlives its match is never committed', () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const a = registry.create('Alice');
  lobby.create(a, { mode: 'solo', difficulty: 'NORMAL' });
  const code = a.roomCode;
  const room = lobby.getRoom(code);
  const matchA = stubMatch({ now: () => 1_000 });
  room.match = matchA;
  const persister = new Persister({ store: null, registry, lobby, log: quietLog });

  assert.equal(persister.commit(code, matchA, { deadlineRemainingMs: 1, startedAtAgoMs: 2 }, '{"v":1}'), true);
  assert.equal(persister.matchDocs.get(code), '{"v":1}');
  room.match = stubMatch({ now: () => 2_000 });      // the room started a different match
  assert.equal(persister.commit(code, matchA, { deadlineRemainingMs: 3, startedAtAgoMs: 4 }, '{"v":2}'), false);
  assert.equal(persister.matchDocs.get(code), '{"v":1}', 'the stale encode was dropped');
  room.match = null;                                  // the match ended
  assert.equal(persister.commit(code, matchA, { deadlineRemainingMs: 5, startedAtAgoMs: 6 }, '{"v":3}'), false);
  assert.equal(persister.matchDocs.get(code), '{"v":1}');
  lobby.shutdown();
});

test('a match end drops the room checkpoint; the Worker path commits a live one', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const a = registry.create('Alice');
  lobby.create(a, { mode: 'solo', difficulty: 'NORMAL' });
  const code = a.roomCode;
  const room = lobby.getRoom(code);
  const persister = new Persister({ store: null, registry, lobby, log: quietLog });

  const match = stubMatch({ now: () => 1_000, deadline: 9_000, startedAt: 500 });
  room.match = match;
  assert.equal(await persister.encodeRoom(code, match), true, 'the live match was committed');
  assert.ok(persister.matchDocs.get(code));
  assert.ok(persister.matchClocks.get(code));

  lobby.onCheckpoint(code, null);
  assert.equal(persister.matchDocs.has(code), false, 'the checkpoint is gone');
  assert.equal(persister.matchClocks.has(code), false);
  lobby.shutdown();
});

test('a broken persistence Worker degrades to a synchronous encode', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const a = registry.create('Alice');
  lobby.create(a, { mode: 'solo', difficulty: 'NORMAL' });
  const code = a.roomCode;
  const room = lobby.getRoom(code);
  const persister = new Persister({ store: null, registry, lobby, log: quietLog });
  const match = stubMatch({ now: () => 1_000, deadline: 9_000, startedAt: 500 });
  room.match = match;
  await persister.encoder.close();                    // every request now rejects
  assert.equal(await persister.encodeRoom(code, match), true, 'the inline encode took over');
  const doc = JSON.parse(persister.matchDocs.get(code));
  assert.equal(doc.phase, PHASE.INFO_CHECK);
  assert.equal(persister.matchClocks.get(code).deadlineRemainingMs, 8_000);
  lobby.shutdown();
});
