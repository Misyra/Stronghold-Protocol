// test/persist-version-stress.test.js — the persistence version under load rather than in a scripted slice.
//
// server/match/snapshot.js persistVersion + the skip in server/persist.js encodeRoom only earn their keep if the
// version moves whenever the persisted document moves. test/persist-version.test.js proves the mechanics on a stub and
// on 60 iterations of a driven match; this suite drives a *whole played match* — every round, the bots' rehearsals,
// the battle rounds and the settlement — and checkpoints on every single scheduler step, with the self-verification on
// (Persister verifyVersion): the encode still runs behind every skip and the body is compared against the stored one,
// so a change the version missed is counted as a hole and re-encoded instead of being kept.
//
// Covered here, not in the other suite: the full match (battles, eliminations, boss rounds), the purity of the version
// function itself, the room-code reuse identity guard, and the skip reached through the real flush cadence rather than
// a direct encodeRoom call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE } from '../shared/constants.js';
import { parseKey } from '../server/match/board.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TRANSIENT_MATCH_FIELDS, canSnapshot, captureMatch, persistVersion } from '../server/match/snapshot.js';
import { Persister } from '../server/persist.js';
import { legalTileFor, makeMatch } from './match/harness.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const OPTIONS = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, seed: 42, fake: true, botSliceMs: 4 };
/** Scheduler steps the soak plays. SP_PERSIST_STRESS_STEPS lengthens the hunt locally. */
const STEPS = Number(process.env.SP_PERSIST_STRESS_STEPS || 500);

/** In-memory store stand-in (the shape server/stateFile.js exposes to the Persister). */
class MemoryStore {
  constructor() { this.doc = null; this.writes = 0; }
  async load() { return this.doc ? JSON.parse(JSON.stringify(this.doc)) : null; }
  async save(doc) { this.doc = JSON.parse(JSON.stringify(doc)); this.writes++; return true; }
  async clear() { this.doc = null; }
  async close() {}
  get label() { return 'memory'; }
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

const boardTo = ([r, c]) => ({ area: 'board', row: r, col: c });
const keyTo = (k) => { const [r, c] = parseKey(k); return { area: 'board', row: r, col: c }; };

/**
 * One player action through the real intent handler, rotating through the kinds so both halves of the version are
 * exercised: the mutated fields it reads directly (funds, shop level/freezes/frozen, hand and board counts) and the
 * ones it does not (board facing, equipped items, effects, layers). Refused intents are fine — the audit is about what
 * a mutation does to the version, not about the action landing.
 */
function act(m, ps, i) {
  const buy = (kind) => {
    const slot = ps.shop.slots.findIndex((s) => s && s.kind === kind && !s.sold && ps.priceOf(s) <= ps.funds);
    return slot >= 0 ? m.handle(ps.playerId, { t: 'g.buy', slot }) : null;
  };
  const deployed = [...ps.board.entries()].filter(([, p]) => p && p.kind === 'chess');
  switch (i % 9) {
    case 0: return m.handle(ps.playerId, { t: 'g.refresh' });
    case 1: return buy('chess');
    case 2: return m.handle(ps.playerId, { t: 'g.freeze' });
    case 3: return buy('item');
    case 4: {                                            // deploy a hand piece onto a legal tile
      const piece = ps.hand.find((p) => p && p.kind === 'chess');
      const tile = piece ? legalTileFor(m, ps, piece.id) : null;
      return tile ? m.handle(ps.playerId, { t: 'g.move', uid: piece.uid, to: boardTo(tile) }) : null;
    }
    case 5: {                                            // equip a hand item onto a deployed operator
      const item = ps.hand.find((p) => p && p.kind === 'item');
      return item && deployed[0] ? m.handle(ps.playerId, { t: 'g.equip', itemUid: item.uid, targetUid: deployed[0][1].uid }) : null;
    }
    case 6: {                                            // reposition: board → board
      const tile = deployed[0] ? legalTileFor(m, ps, deployed[0][1].id) : null;
      return tile ? m.handle(ps.playerId, { t: 'g.move', uid: deployed[0][1].uid, to: boardTo(tile), dir: 'UP' }) : null;
    }
    case 7: {                                            // reorient in place: a persisted facing, nothing else moves
      const [key, piece] = deployed[0] ?? [];
      return key ? m.handle(ps.playerId, { t: 'g.move', uid: piece.uid, to: keyTo(key), dir: 'LEFT' }) : null;
    }
    default: return m.handle(ps.playerId, { t: 'g.levelUp' });     // shop level: funds, upgrade price, free refreshes
  }
}

/**
 * One round of human decisions (the harness's automatic draft turns) plus a player action, so the match keeps moving
 * while the persisted surface is poked from many directions.
 */
function humanTurn(h, roll, i) {
  const m = h.m;
  let acted = 0;
  for (const ps of m.order) {
    if (ps.isBot || ps.left) continue;
    if (m.phase === PHASE.INFO_CHECK) { if (!ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' }); continue; }
    if (m.phase === PHASE.BAND_DRAFT) { if (m.draftTurn() === ps.playerId) m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' }); continue; }
    if (m.phase === PHASE.SP_DRAFT) {
      if (m.spTurn() === ps.playerId) {
        const idx = m.sp.cards.map((c) => c.idx).find((k) => m.sp.taken[k] == null);
        if (idx != null) m.handle(ps.playerId, { t: 'g.choice', idx });
      }
      continue;
    }
    if (m.phase !== PHASE.PREP || !ps.alive) continue;
    if (roll() < 0.7) { act(m, ps, i + ps.seat); acted++; }
    if (ps.personalChoice) m.handle(ps.playerId, { t: 'g.choice', idx: 0, choiceId: ps.personalChoice.id });
    if (!ps.tempEmpty) ps.resolveTemp();
    if (!ps.ready) m.handle(ps.playerId, { t: 'g.ready', ready: true });
  }
  return acted;
}

/** One scheduler step with the harness's automatic human decisions. */
function step(h) {
  const m = h.m;
  if (m.ended || m.disposed) return false;
  for (const ps of m.players.values()) {
    if (ps.isBot || ps.left) continue;
    if (m.phase === PHASE.INFO_CHECK && !ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' });
    else if (m.phase === PHASE.BAND_DRAFT && m.draftTurn() === ps.playerId) m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' });
    else if (m.phase === PHASE.SP_DRAFT && m.spTurn() === ps.playerId) {
      const idx = m.sp.cards.map((c) => c.idx).find((k) => m.sp.taken[k] == null);
      if (idx != null) m.handle(ps.playerId, { t: 'g.choice', idx });
    } else if (m.phase === PHASE.PREP && ps.alive && !ps.ready) {
      if (!ps.tempEmpty) ps.resolveTemp();
      m.handle(ps.playerId, { t: 'g.ready', ready: true });
    }
  }
  return h.sched.runNext();
}

/** Drive to the first instant the match may be checkpointed (canSnapshot: a restorable phase, every bot ready). */
function driveToCheckpointable(h) {
  let guard = 0;
  while (!canSnapshot(h.m) && guard++ < 4e4) step(h);
  assert.ok(canSnapshot(h.m), `expected a checkpointable phase, got ${h.m.phase} R${h.m.round}${h.ended ? ' (ended)' : ''}`);
  return h;
}

test('a whole played match, checkpointed on every step, never lets the version hide a persisted change', async (t) => {
  const h = makeMatch(OPTIONS);
  const { lobby, code } = roomFor(h.m, { mode: 'coop', difficulty: 'NORMAL' });
  const persister = new Persister({ store: new MemoryStore(), registry: lobby.registry, lobby, log: quietLog, verifyVersion: true });
  let s = OPTIONS.seed >>> 0;
  const roll = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const phases = new Set();
  let actions = 0;
  let steps = 0;
  let checkpoints = 0;
  try {
    h.m.start();
    for (; steps < STEPS; steps++) {
      if (h.m.ended || h.m.disposed) break;
      phases.add(h.m.phase);
      actions += humanTurn(h, roll, steps);
      // the harshest schedule the Persister can see: a checkpoint at every instant a save round can land on —
      // after the decisions (the middle of a band / SP draft pick) and after the scheduler step
      if (await persister.encodeRoom(code, h.m)) checkpoints++;
      if (!h.sched.runNext()) break;
      if (await persister.encodeRoom(code, h.m)) checkpoints++;
      if (steps % 25 === 24) await persister.flush('test');
    }
    const stats = { ...persister.versionStats };
    t.diagnostic(`steps ${steps} · actions ${actions} · committed checkpoints ${checkpoints} · rounds ${h.m.round} · phases ${[...phases].join('/')}`);
    t.diagnostic(`encodes ${stats.encodes} · skipped ${stats.skipped} · verified ${stats.verified} · holes ${stats.holes}`);

    assert.ok(actions > 100, `the soak must actually play (${actions} actions)`);
    assert.ok(checkpoints > 20, `the soak must actually checkpoint (${checkpoints} committed)`);
    assert.ok(stats.encodes > 0 && stats.verified > 0, `both the encode and the verify path ran: ${JSON.stringify(stats)}`);
    assert.equal(stats.holes, 0, `the version claimed "unchanged" for a changed match ${stats.holes} time(s): the checkpoint would have kept a stale body`);
    assert.equal(stats.skipped, stats.verified, 'every skip was verified against a fresh encode of the same state');
    assert.equal(h.m.errorCount, 0, `match errors: ${JSON.stringify(h.m.errors)}`);
    assert.ok(phases.has(PHASE.PREP) && (phases.has(PHASE.COMBAT) || phases.has(PHASE.SETTLE) || phases.has(PHASE.BATTLE_CHECK)),
      `the soak must cross real battle phases, saw ${[...phases].join('/')}`);
    h.invariants();                                       // engine invariants still hold after the whole driven match
  } finally {
    await persister.dispose();
    h.m.dispose();
    lobby.shutdown();
  }
});

test('persistVersion is a pure read: the same state gives the same string and nothing it reads moves', () => {
  const h = makeMatch({ ...OPTIONS, humans: 2, bots: 1, seed: 5 });
  try {
    h.m.start();
    let guard = 0;
    while (h.m.phase !== PHASE.PREP && guard++ < 4e4) step(h);
    assert.equal(h.m.phase, PHASE.PREP, `expected PREP, got ${h.m.phase}`);
    // the streams it reads, discovered the way it discovers them (the match's own rng* fields)
    const rngs = TRANSIENT_MATCH_FIELDS.filter((n) => n.startsWith('rng') && h.m[n]);
    assert.ok(rngs.length >= 4, `expected the match RNG streams, got ${rngs.join(',')}`);
    const read = () => JSON.stringify({
      rev: h.m._persistRev, pool: h.m.pool.revision, uidSeq: h.m.uidSeq, round: h.m.round,
      setupRevision: h.m.setupRevision, voteSeq: h.m._setupVoteSeq, rng: rngs.map((n) => h.m[n].state()),
    });
    const before = read();
    const a = persistVersion(h.m);
    const b = persistVersion(h.m);
    assert.equal(a, b, 'the version is deterministic for a fixed state');
    assert.ok(a.length > 0);
    assert.equal(read(), before, 'building the version moved something it reads: the skip could never settle');
    // and it is not a constant: a real player action moves it
    const human = h.m.order.find((ps) => !ps.isBot);
    assert.deepEqual(h.m.handle(human.playerId, { t: 'g.freeze' }), { ok: true }, 'freeze is a legal free PREP action');
    assert.notEqual(persistVersion(h.m), a, 'a player action through the real handler moves the version');
  } finally { h.m.dispose(); }
});

test('a different match in the same room code is encoded, never mistaken for the one already checkpointed', async () => {
  const first = makeMatch({ ...OPTIONS, seed: 3 });
  const { lobby, code } = roomFor(first.m);
  const persister = new Persister({ store: new MemoryStore(), registry: lobby.registry, lobby, log: quietLog });
  const second = makeMatch({ ...OPTIONS, seed: 3 });              // same settings, so an identical version string
  try {
    first.m.start();
    driveToCheckpointable(first);
    second.m.start();
    driveToCheckpointable(second);                                // driven identically, so the versions match
    assert.equal(await persister.encodeRoom(code, first.m), true, 'the first checkpoint is committed');
    const body = persister.matchDocs.get(code);
    const encodes = persister.versionStats.encodes;

    lobby.getRoom(code).match = second.m;                         // the room now runs a different match object
    assert.equal(persistVersion(second.m), persistVersion(first.m), 'the two versions are identical strings');
    assert.equal(await persister.encodeRoom(code, second.m), true,
      'the version comparison is on the match itself: an identical string from another match is not "unchanged"');
    assert.equal(persister.versionStats.encodes, encodes + 1);
    assert.equal(persister.versionStats.skipped, 0, 'nothing was skipped for a match that was never checkpointed');

    second.m.uidSeq = (second.m.uidSeq | 0) + 1;                  // a real change to the room's current match
    assert.equal(await persister.encodeRoom(code, second.m), true, 'the follow-up change is committed too');
    assert.notEqual(persister.matchDocs.get(code), body, 'the stored body follows the room, not the old match');
    assert.equal(persister.versionStats.encodes, encodes + 2);

    assert.equal(await persister.encodeRoom(code, second.m), false, 'and from then on the new match skips as usual');
    assert.equal(persister.versionStats.skipped, 1);
  } finally {
    await persister.dispose();
    first.m.dispose();
    second.m.dispose();
    lobby.shutdown();
  }
});

test('an idle room is skipped on the save round: the flush cadence reaches the store, not the encoder', async () => {
  const h = makeMatch({ ...OPTIONS, humans: 2, bots: 1, seed: 9 });
  const { lobby, code } = roomFor(h.m);
  const store = new MemoryStore();
  const persister = new Persister({ store, registry: lobby.registry, lobby, log: quietLog });
  try {
    h.m.start();
    driveToCheckpointable(h);
    await persister.flush('test');                                 // first round: encode and write
    const mid = { ...persister.versionStats };
    const writes = store.writes;
    // nothing steps the match and nothing touches it: the room is exactly as it was checkpointed
    assert.equal(await persister.flush('test'), true, 'the save round still runs');
    const after = { ...persister.versionStats };
    assert.equal(after.encodes - mid.encodes, 0, 'no capture, no encode: the version says nothing moved');
    assert.equal(after.skipped - mid.skipped, 1, 'the room was skipped');
    assert.ok(store.writes > writes, 'the store was still written (the metadata and clock envelope travel alone)');
    assert.ok(store.doc?.matches?.[code], 'the checkpoint body of the room is in the saved document');
  } finally {
    await persister.dispose();
    h.m.dispose();
    lobby.shutdown();
  }
});

test('the self-verification switch is off unless the environment asks for it', async () => {
  const h = makeMatch({ ...OPTIONS, humans: 2, bots: 0, seed: 2 });
  const { lobby } = roomFor(h.m);
  const saved = process.env.SP_PERSIST_VERIFY;                     // the suite stays runnable under the canary itself
  delete process.env.SP_PERSIST_VERIFY;
  try {
    assert.equal(new Persister({ store: null, registry: lobby.registry, lobby, log: quietLog }).verifyVersion, false);
    const explicit = new Persister({ store: null, registry: lobby.registry, lobby, log: quietLog, verifyVersion: true });
    assert.equal(explicit.verifyVersion, true);
    await explicit.dispose();
    process.env.SP_PERSIST_VERIFY = '1';
    const canary = new Persister({ store: null, registry: lobby.registry, lobby, log: quietLog });
    assert.equal(canary.verifyVersion, true, 'SP_PERSIST_VERIFY=1 enables the canary');
    await canary.dispose();
  } finally {
    if (saved === undefined) delete process.env.SP_PERSIST_VERIFY; else process.env.SP_PERSIST_VERIFY = saved;
    h.m.dispose();
    lobby.shutdown();
  }
});

// The skip compares persistVersion, and the version samples some persisted fields only by *count* (hand, temp, board
// size) or not at all (deviceOverrides, tileOverrides, stats, ops, loadout, diy*): those rely on `_persistRev`, which
// every engine mutation site bumps through dirty()/markPublic/markPrivate. This test writes such a field straight into
// the state — the mistake a future mutator could make — and pins what happens on both sides of the switch: the
// self-check re-encodes and counts the hole, and without the switch the skip would have kept the older body.
test('a persisted field the version does not sample is caught by the check, never quietly kept', async () => {
  const h = makeMatch({ ...OPTIONS, humans: 2, bots: 1, seed: 21 });
  const { lobby, code } = roomFor(h.m);
  const store = new MemoryStore();
  const watched = new Persister({ store, registry: lobby.registry, lobby, log: quietLog, verifyVersion: true });
  const blind = new Persister({ store, registry: lobby.registry, lobby, log: quietLog });
  try {
    h.m.start();
    driveToCheckpointable(h);
    const ps = h.m.order.find((p) => !p.isBot);
    assert.ok(ps && ps.deviceOverrides && ps.stats, 'the probe needs a human player with the persisted maps');
    assert.equal(await watched.encodeRoom(code, h.m), true, 'the first checkpoint is committed');
    const body = watched.matchDocs.get(code);
    const version = persistVersion(h.m);
    blind.commit(code, h.m, watched.matchClocks.get(code), body, version);   // the same baseline, without the check

    ps.deviceOverrides.audit_probe = !ps.deviceOverrides.audit_probe;         // persisted, outside the version, no dirty()
    assert.equal(persistVersion(h.m), version, 'the version really does not sample this field');
    assert.ok(captureMatch(h.m), 'the match is still snapshotable');

    assert.equal(await watched.encodeRoom(code, h.m), true, 'the check re-encodes instead of skipping');
    assert.equal(watched.versionStats.holes, 1, 'and counts the missed change');
    assert.notEqual(watched.matchDocs.get(code), body, 'the stored body carries the new value');
    assert.equal(await watched.encodeRoom(code, h.m), false, 'the state is current again: it skips from here on');

    assert.equal(await blind.encodeRoom(code, h.m), false,
      'without the check the same untouched-version state is skipped — which is exactly what the canary exists for');
  } finally {
    await watched.dispose();
    await blind.dispose();
    h.m.dispose();
    lobby.shutdown();
  }
});
