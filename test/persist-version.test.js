// test/persist-version.test.js — the persistence version (server/match/snapshot.js persistVersion + server/persist.js):
// an unchanged match is not captured, cloned and encoded again, and the version is *proved* not to miss a change
// instead of trusted. The invariant under test is the one docs/development/STATE_SYNC_BENCHMARK.md names: a skipped
// checkpoint must still be the checkpoint the live match would have produced.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE } from '../shared/constants.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { canSnapshot, persistVersion, restoreMatch, matchState } from '../server/match/snapshot.js';
import { Persister } from '../server/persist.js';
import { createRngFromState } from '../server/sim/rng.js';
import { makeMatch } from './match/harness.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const DEPS = { createRngFromState, log: quietLog };
const OPTIONS = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 42, fake: true, botSliceMs: 4 };

/** In-memory store stand-in (the shape server/stateFile.js exposes to the Persister). */
class MemoryStore {
  constructor() { this.doc = null; this.writes = 0; }
  async load() { return this.doc ? JSON.parse(JSON.stringify(this.doc)) : null; }
  async save(doc) { this.doc = JSON.parse(JSON.stringify(doc)); this.writes++; return true; }
  async clear() { this.doc = null; }
  async close() {}
  get label() { return 'memory'; }
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One scheduling step with the harness's automatic human decisions. */
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

/** A lobby room whose live match is a real harness match (the Persister only reads room.match). */
function roomFor(match, { mode = 'coop', difficulty = 'NORMAL' } = {}) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const session = registry.create('Alice');
  lobby.create(session, { mode, difficulty });
  const code = session.roomCode;
  lobby.getRoom(code).match = match;
  return { registry, lobby, code };
}

/** What a restore deliberately changes (see test/match/snapshot.test.js norm). */
function norm(state) {
  const out = JSON.parse(JSON.stringify(state));
  out.match._battleSeq = 0;
  for (const p of Object.values(out.players)) { p.connected = true; p.ready = true; delete p.lastEmoteAt; }
  return out;
}

test('an unchanged match is not encoded again: only the clock envelope moves', async () => {
  let now = 10_000;
  const match = {
    disposed: false, ended: false, phase: PHASE.INFO_CHECK, sched: { now: () => now }, deadline: 65_000, startedAt: 4_000,
    pool: { entries: new Map([['chess_a', { cap: 20, left: 20, tier: 1 }]]), revision: 0, take(id, n) { this.entries.get(id).left -= n; this.revision++; } },
    order: [], alivePlayers: () => [], errorCount: 0, errors: [], round: 1, _persistRev: 0, uidSeq: 0, _battleSeq: 0, pausedMs: 0,
  };
  const { lobby, code } = roomFor(match, { mode: 'solo' });
  const persister = new Persister({ store: null, registry: lobby.registry, lobby, log: quietLog });
  try {
    assert.equal(await persister.encodeRoom(code, match), true, 'the first checkpoint is encoded');
    const body = persister.matchDocs.get(code);
    const clocks = { ...persister.matchClocks.get(code) };
    assert.equal(persister.versionStats.encodes, 1);

    now = 21_000;                                        // real time passes, the match does not change
    assert.equal(await persister.encodeRoom(code, match), false, 'nothing changed: no checkpoint is committed');
    assert.equal(persister.matchDocs.get(code), body, 'the stored body is the one already on disk');
    assert.equal(persister.versionStats.skipped, 1);
    const after = persister.matchClocks.get(code);
    assert.notEqual(after.deadlineRemainingMs, clocks.deadlineRemainingMs, 'the phase clock was refreshed');
    assert.notEqual(after.startedAtAgoMs, clocks.startedAtAgoMs, 'the age was refreshed');

    match.pool.take('chess_a', 3);                        // a pool copy moved (persisted, no markPublic)
    assert.equal(await persister.encodeRoom(code, match), true, 'a pool change re-encodes');
    match.errorCount++;                                   // a direct write that bypasses the marks
    assert.equal(await persister.encodeRoom(code, match), true, 'a direct write re-encodes');
    match._persistRev = persistVersion(match).includes('x') ? match._persistRev : match._persistRev + 1; // markPublic / markPrivate
    assert.equal(await persister.encodeRoom(code, match), true, 'the mutation counter re-encodes');
    assert.equal(persister.versionStats.skipped, 1, 'exactly the unchanged round was skipped');
    assert.equal(persister.versionStats.encodes, 4);
  } finally { await persister.dispose(); lobby.shutdown(); }
});

test('a skipped checkpoint still restores the live match (no confirmed change is lost)', async () => {
  const h = makeMatch({ ...OPTIONS, seed: 7 });
  const { lobby, code } = roomFor(h.m);
  const persister = new Persister({ store: new MemoryStore(), registry: lobby.registry, lobby, log: quietLog });
  const fresh = () => makeMatch({ ...OPTIONS, seed: 7 });
  const restore = (b) => {
    const doc = JSON.parse(persister.matchDocs.get(code));
    assert.equal(restoreMatch(b.m, { ...doc, ...persister.matchClocks.get(code) }, DEPS), true);
    return b;
  };
  let b = null;
  try {
    h.m.start();
    assert.ok(driveTo(h, () => h.m.phase === PHASE.PREP && canSnapshot(h.m), { ready: false }), 'reached a quiet prep');
    // a real prep: buy, deploy, refresh, level up — then checkpoint and compare against a restore
    const human = h.m.players.get('p_0');
    const slot = human.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold);
    assert.equal(h.m.handle('p_0', { t: 'g.buy', slot }).ok, true);
    h.m.handle('p_0', { t: 'g.refresh' });
    h.m.handle('p_0', { t: 'g.levelUp' });
    assert.equal(await persister.encodeRoom(code, h.m), true);
    b = fresh();
    assert.deepEqual(norm(matchState(restore(b).m)), norm(matchState(h.m)), 'the encoded checkpoint is the live match');

    // an unchanged round: nothing is committed, and the stored body still restores the same live match
    const body = persister.matchDocs.get(code);
    assert.equal(await persister.encodeRoom(code, h.m), false);
    assert.equal(persister.matchDocs.get(code), body);
    const b2 = fresh();
    assert.deepEqual(norm(matchState(restore(b2).m)), norm(matchState(h.m)), 'the skipped checkpoint is still exact');
    b2.m.dispose();

    // a real change: funds, shop and board must leave the stored body equal to the new live state
    assert.equal(h.m.handle('p_0', { t: 'g.refresh' }).ok, true);
    const extra = h.m.players.get('p_1');
    extra.addFunds(7);
    assert.equal(await persister.encodeRoom(code, h.m), true, 'the change re-encodes');
    const b3 = fresh();
    assert.deepEqual(norm(matchState(restore(b3).m)), norm(matchState(h.m)), 'the re-encoded checkpoint is the new state');
    b3.m.dispose();
    assert.equal(persister.versionStats.holes, 0);
  } finally {
    b?.m.dispose();
    await persister.dispose();
    h.m.dispose();
    lobby.shutdown();
  }
});

test('the version never misses a change: verification over a driven match', async () => {
  const h = makeMatch({ ...OPTIONS, seed: 11 });
  const { lobby, code } = roomFor(h.m);
  const persister = new Persister({ store: new MemoryStore(), registry: lobby.registry, lobby, log: quietLog, verifyVersion: true });
  let flushes = 0;
  try {
    h.m.start();
    for (let i = 0; i < 60; i++) {
      const ps = h.m.order[i % h.m.order.length];
      if (h.m.phase === PHASE.PREP && ps.alive && !ps.isBot) {
        // a mix of actions: some move the persisted surface, some are refused, some are no-ops
        if (i % 3 === 0) h.m.handle(ps.playerId, { t: 'g.refresh' });
        else if (i % 3 === 1) {
          const slot = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold && ps.priceOf(s) <= ps.funds);
          if (slot >= 0) h.m.handle(ps.playerId, { t: 'g.buy', slot });
        } else h.m.handle(ps.playerId, { t: 'g.freeze' });
      }
      step(h);
      await persister.encodeRoom(code, h.m);              // every save round: verify what the version claims
      if (i % 10 === 0) { await persister.flush('test'); flushes++; }
      await sleep();
      if (h.m.ended) break;
    }
    assert.ok(persister.versionStats.encodes > 0 && persister.versionStats.verified > 0, 'both paths ran');
    assert.equal(persister.versionStats.holes, 0, 'the version never claimed "unchanged" for a changed match');
    assert.equal(persister.versionStats.skipped, persister.versionStats.verified, 'every skip was verified against a fresh encode');
    assert.ok(flushes > 0);
    assert.equal(h.m.errorCount, 0);
  } finally { await persister.dispose(); h.m.dispose(); lobby.shutdown(); }
});

test('the version is checked, not trusted: a persisted field that moves alone is caught', async () => {
  const h = makeMatch({ ...OPTIONS, seed: 5 });
  const { lobby, code } = roomFor(h.m);
  const persister = new Persister({ store: null, registry: lobby.registry, lobby, log: quietLog, verifyVersion: true });
  const warnings = [];
  persister.log = { ...quietLog, warn: (msg) => warnings.push(String(msg)) };
  try {
    h.m.start();
    assert.ok(driveTo(h, () => h.m.phase === PHASE.PREP && canSnapshot(h.m), { ready: false }));
    assert.equal(await persister.encodeRoom(code, h.m), true);
    // `gameSpeed` is persisted and is not part of the version (it is fixed for a match): the detector must notice
    // instead of keeping a body that no longer describes the match.
    const stored = persister.matchDocs.get(code);
    h.m.gameSpeed += 1;
    assert.equal(await persister.encodeRoom(code, h.m), true, 'the changed body replaces the stored one');
    assert.equal(persister.versionStats.holes, 1);
    assert.notEqual(persister.matchDocs.get(code), stored);
    assert.ok(warnings.some((w) => w.includes('persistence version missed a change')));
    assert.equal(persister.versionStats.verified, 1, 'the version was re-checked by a fresh encode');
    assert.equal(persister.versionStats.encodes, 2, 'the first encode plus the re-encode; nothing was skipped as unchanged');
    assert.equal(persister.versionStats.skipped, 0);
  } finally { await persister.dispose(); h.m.dispose(); lobby.shutdown(); }
});
