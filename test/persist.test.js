// Adapted from xinhai-ai/Stronghold-Protocol (20524bb), GPL-3.0-or-later.
// test/persist.test.js — Redis-backed state (server/persist.js, server/redis.js): sessions, rooms and a running match
// survive a restart. The store is an in-memory stand-in here; test/persist-redis.test.js talks to a real Redis when one
// is reachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Match as RealMatch } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { snapshotServer, restoreServer, sessionDoc, PERSIST_VERSION, Persister } from '../server/persist.js';
import { PHASE, ERR } from '../shared/constants.js';
import { DEFAULT_VERSION } from '../shared/versions.js';
import { matchmakingAvailable, matchmakingMembers } from '../server/matchmakingRooms.js';
import { TestClient } from './helpers/wsClient.js';
import { FakeBattle } from './match/fakeBattle.js';

/** In-memory StateStore stand-in (same surface: load / save / clear / close). */
class MemoryStore {
  constructor() { this.doc = null; this.writes = 0; }
  async load() { return this.doc ? JSON.parse(JSON.stringify(this.doc)) : null; }
  async save(doc) { this.doc = JSON.parse(JSON.stringify(doc)); this.writes++; return true; }
  async clear() { this.doc = null; }
  async close() {}
  get label() { return 'memory'; }
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * The real engine on a virtual clock, so a live-server test can reach a checkpoint without waiting out real timers.
 * FakeBattle keeps the rounds instant (a real simulation in instant mode would stream thousands of b.snap frames into
 * the test clients, which buffer everything they receive).
 */
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

/**
 * Advance a virtual-clock match until `pred` holds. Strictly bounded and deliberately short: a runaway callback chain
 * must fail the test (not hang it), and the frames the match broadcasts pile up in the test client's inbox.
 */
function until(match, pred, maxSteps = 20_000) {
  const ok = match.sched.runUntil(pred, { maxSteps });
  assert.ok(ok, `scheduler gave up waiting (phase ${match.phase} round ${match.round})`);
}

async function player(port, name, token) {
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`);
  const w = await c.hello(name, token);
  c.id = w.playerId;
  c.token = w.token;
  return c;
}

// ---------------------------------------------------------------------------------------------------
// document round trip (no server)
// ---------------------------------------------------------------------------------------------------

test('a room and its sessions survive a document round trip', () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const a = registry.create('Alice');
  const b = registry.create('Bob');
  assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'HARD' }), { ok: true });
  const code = a.roomCode;
  assert.deepEqual(lobby.join(b, { code }), { ok: true });
  assert.deepEqual(lobby.ready(b, { ready: true }), { ok: true });

  const now = Date.now();
  const doc = snapshotServer({ registry, lobby, now });
  assert.equal(doc.v, PERSIST_VERSION);
  assert.equal(doc.sessions.length, 2);
  assert.equal(doc.rooms.length, 1);
  assert.equal(doc.rooms[0].code, code);
  assert.equal(doc.rooms[0].difficulty, 'HARD');
  assert.equal(doc.rooms[0].seats.length, 2);
  assert.equal(doc.rooms[0].seats.find((s) => s.playerId === b.playerId).ready, true);

  // a second (restarted) server reads it back
  const registry2 = new SessionRegistry();
  const lobby2 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const stats = restoreServer({ doc, registry: registry2, lobby: lobby2, now: now + 1000, log: quietLog });
  assert.deepEqual({ sessions: stats.sessions, rooms: stats.rooms, matches: stats.matches }, { sessions: 2, rooms: 1, matches: 0 });
  const resumed = registry2.byToken(a.token);
  assert.ok(resumed, 'the token resolves after the restart');
  assert.equal(resumed.playerId, a.playerId);
  assert.equal(resumed.roomCode, code);
  const room = lobby2.getRoom(code);
  assert.ok(room, 'the room is back');
  assert.equal(room.difficulty, 'HARD');
  assert.equal(room.hostId, a.playerId);
  assert.equal(room.seatOf(b.playerId).ready, true);
  assert.equal(room.seatOf(b.playerId).connected, false, 'everyone starts disconnected');
  // both humans are on a fresh lobby grace timer
  assert.equal(lobby2.graceTimers.size, 2);
});

test('the seat card (名片干员) survives a document round trip, on the session and the seat', () => {
  const data = { chess: { x: { charId: 'char_498_inside', visible: true } } };
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => data });
  const a = registry.create('Alice');
  const b = registry.create('Bob');
  assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const code = a.roomCode;
  assert.deepEqual(lobby.join(b, { code }), { ok: true });
  const cardA = { charId: 'char_498_inside', avatar: 'char_498_inside', art: 'e2', bg: 'nc_1', bgY: 7 };
  const cardB = { charId: 'char_498_inside', face: 'e1' };
  assert.deepEqual(lobby.card(a, { charId: cardA.charId, avatar: cardA.avatar, art: cardA.art, bg: cardA.bg, bgY: cardA.bgY }), { ok: true });
  assert.deepEqual(lobby.card(b, { charId: cardB.charId, face: cardB.face }), { ok: true });
  assert.deepEqual(a.card, cardA);
  assert.deepEqual(b.card, cardB);

  const now = Date.now();
  const doc = snapshotServer({ registry, lobby, now });
  assert.deepEqual(doc.sessions.find((s) => s.playerId === a.playerId).card, cardA, 'sessionDoc carries the card');
  assert.deepEqual(doc.rooms[0].seats.find((s) => s.playerId === b.playerId).card, cardB, 'seatDoc carries the card');

  // a second (restarted) server reads it back
  const registry2 = new SessionRegistry();
  const lobby2 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => data });
  assert.equal(restoreServer({ doc, registry: registry2, lobby: lobby2, now: now + 1000, log: quietLog }).ok, true);
  const resumedA = registry2.byToken(a.token);
  const resumedB = registry2.byToken(b.token);
  assert.ok(resumedA && resumedB);
  assert.deepEqual(resumedA.card, cardA, 'adopt restores the session card');
  assert.deepEqual(resumedB.card, cardB);
  const room2 = lobby2.getRoom(code);
  assert.deepEqual(room2.seatOf(a.playerId).card, cardA, 'the restored seat keeps the card');
  assert.deepEqual(room2.seatOf(b.playerId).card, cardB);
});

test('sessions older than their reconnect window are dropped, with their seats', () => {
  const now = Date.now();
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const doc = {
    v: PERSIST_VERSION,
    savedAt: now,
    sessions: [
      { playerId: 'p_live', token: 'aa', name: 'Live', connected: true, disconnectedAt: now - 60_000, roomCode: 'AAAA', resumeWindowMs: null },
      { playerId: 'p_dead', token: 'bb', name: 'Gone', connected: false, disconnectedAt: now - 11 * 60_000, roomCode: 'AAAA', resumeWindowMs: null },
      { playerId: 'p_solo', token: 'cc', name: 'Solo', connected: false, disconnectedAt: now - 11 * 60_000, roomCode: 'BBBB', resumeWindowMs: 24 * 3600_000 },
    ],
    rooms: [
      { code: 'AAAA', mode: 'coop', difficulty: 'NORMAL', hostId: 'p_live', matchCount: 0,
        seats: [{ seat: 0, playerId: 'p_live', name: 'Live', isBot: false, ready: false, left: false, connected: true },
          { seat: 1, playerId: 'p_dead', name: 'Gone', isBot: false, ready: false, left: false, connected: true }] },
      { code: 'BBBB', mode: 'solo', difficulty: 'NORMAL', hostId: 'p_solo', matchCount: 0,
        seats: [{ seat: 0, playerId: 'p_solo', name: 'Solo', isBot: false, ready: false, left: false, connected: true }] },
    ],
    matches: {},
  };
  const stats = restoreServer({ doc, registry, lobby, now, log: quietLog });
  assert.equal(stats.expired, 1, 'the 10-minute session is gone');
  assert.equal(stats.sessions, 2);
  assert.ok(registry.byToken('cc'), 'the 24 h solo window survives');
  assert.equal(registry.byToken('bb'), null);
  const coop = lobby.getRoom('AAAA');
  assert.ok(coop);
  assert.equal(coop.seats.filter(Boolean).length, 1, 'the expired seat is dropped');
  assert.equal(coop.hostId, 'p_live');
  assert.ok(lobby.getRoom('BBBB'), 'the solo room survives its longer window');
});

test('a tampered room code (wrong charset) is dropped, never restored as a room', () => {
  const now = Date.now();
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  // '../a' has ROOM_CODE_LEN characters: without the live-alphabet check it would restore a joinable room whose
  // match shards write `path.join(matchesDir, code + SHARD_SUFFIX)` — one directory up (server/stateFile.js).
  const doc = {
    v: PERSIST_VERSION,
    savedAt: now,
    sessions: [
      { playerId: 'p_live', token: 'aa', name: 'Live', connected: true, disconnectedAt: now - 60_000, roomCode: '../a', resumeWindowMs: null },
    ],
    rooms: [
      { code: '../a', mode: 'coop', difficulty: 'NORMAL', hostId: 'p_live', matchCount: 0,
        seats: [{ seat: 0, playerId: 'p_live', name: 'Live', isBot: false, ready: false, left: false, connected: true }] },
      { code: 'ab-c', mode: 'coop', difficulty: 'NORMAL', hostId: 'p_live', matchCount: 0,
        seats: [{ seat: 0, playerId: 'p_live', name: 'Live', isBot: false, ready: false, left: false, connected: true }] },
      { code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', hostId: 'p_live', matchCount: 0,
        seats: [{ seat: 0, playerId: 'p_live', name: 'Live', isBot: false, ready: false, left: false, connected: true }] },
    ],
    matches: {},
  };
  const stats = restoreServer({ doc, registry, lobby, now, log: quietLog });
  assert.ok(!lobby.getRoom('../a'), 'the traversal code never becomes a room');
  assert.ok(!lobby.getRoom('ab-c'), 'the hyphenated code never becomes a room');
  assert.ok(lobby.getRoom('ABCD'), 'a plain [A-Z0-9] code still restores');
  assert.equal(stats.rooms, 1);
  assert.equal(stats.droppedSeats >= 2, true, 'the tampered rooms count as dropped seats');
});

test('a document from another version is refused', () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const stats = restoreServer({ doc: { v: 99, sessions: [], rooms: [] }, registry, lobby, log: quietLog });
  assert.equal(stats.ok, false);
  assert.match(stats.reason, /version/);
  assert.equal(stats.rooms, 0);
});

test('sessionDoc leaves connected sessions without a disconnect time and keeps the real one for dropped sessions', () => {
  const registry = new SessionRegistry();
  const s = registry.create('A');
  s.connected = true;
  s.disconnectedAt = null;
  // a connected session has nothing to measure: stamping the write time here would dirty every online session on
  // every save; restoreServer bounds a crash cut-off with doc.savedAt instead
  assert.equal(sessionDoc(s, 1234).disconnectedAt, null);
  s.connected = false;
  s.disconnectedAt = 999;
  assert.equal(sessionDoc(s, 1234).disconnectedAt, 999);
});

test('flush rounds honor the minimum gap: checkpoint events coalesce instead of a hot write loop', async () => {
  let at = 100_000;
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const store = new MemoryStore();
  const persister = new Persister({ store, registry, lobby, log: quietLog, now: () => at, saveMs: 10_000 });
  persister.running = true;

  assert.equal(await persister.flush('interval'), true, 'the first round runs');
  assert.equal(store.writes, 1);

  // a checkpoint event 1 s later lands in the next slot instead of rewriting immediately
  at += 1_000;
  assert.equal(await persister.scheduleFlush('checkpoint'), undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.writes, 1, 'the deferred round has not run yet');

  // once the gap has elapsed the deferred round runs (the real timer fires on the wall clock, not the fake one)
  persister.stop();
  assert.equal(await persister.flush('test'), true, 'an explicit flush bypasses the gap');
  assert.equal(store.writes, 2);

  // shutdown always writes, whatever the clock says
  at += 100;
  assert.equal(await persister.shutdown('shutdown'), true);
  assert.equal(store.writes, 3);
  lobby.shutdown();
});

// ---------------------------------------------------------------------------------------------------
// live server: sessions and a room come back
// ---------------------------------------------------------------------------------------------------

test('a short configured interval still throttles checkpoint saves, and a normal round consumes the deferred request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let at = 0;
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const store = new MemoryStore();
  const persister = new Persister({ store, registry, lobby, log: quietLog, now: () => at, saveMs: 1 });
  t.after(async () => { persister.stop(); await persister.encoder.close(); lobby.shutdown(); });
  persister.running = true;
  assert.equal(await persister.flush('interval'), true, 'a clock starting at zero must allow the first round');
  at = 100;
  persister.scheduleFlush('checkpoint');
  await Promise.resolve();
  assert.equal(store.writes, 1, 'checkpoint events honor the normalized 1000 ms minimum');
  at = 1000;
  assert.equal(await persister.flush('interval'), true);
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.writes, 2, 'an interval round consumes the deferred request without another write');
});

test('a restart keeps players on their seats (tokens resolve, room state resumes)', async () => {
  const store = new MemoryStore();
  const srvA = await startServer({ port: 0, quiet: true, store, MatchClass: StubMatch, log: quietLog });
  const c1 = await player(srvA.port, 'Alice');
  const c2 = await player(srvA.port, 'Bob');
  const created = await c1.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  assert.equal(created.t, 'ok');
  const state = await c1.waitFor('room.state');
  const code = state.code;
  await c2.request({ t: 'room.join', code });
  await c1.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
  await c2.request({ t: 'room.ready', ready: true });
  const id1 = c1.id;
  const token1 = c1.token;
  const token2 = c2.token;
  await c1.close();
  await c2.close();
  await srvA.close();
  assert.ok(store.writes > 0, 'the shutdown flushed the state');
  assert.equal(store.doc.rooms.length, 1);

  const srvB = await startServer({ port: 0, quiet: true, store, MatchClass: StubMatch, log: quietLog });
  try {
    assert.equal(srvB.persister.matchDocs.size, 0);
    const back = await player(srvB.port, 'Alice', token1);
    assert.equal(back.id, id1, 'same player id after the restart');
    const resumed = await back.waitFor('room.state');
    assert.equal(resumed.code, code);
    assert.equal(resumed.hostId, id1);
    assert.equal(resumed.seats.filter(Boolean).length, 2);
    assert.equal(resumed.seats.find((s) => s.playerId === id1).connected, true);
    const other = await player(srvB.port, 'Bob', token2);
    await other.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
  } finally {
    await srvB.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// live server: a running match comes back
// ---------------------------------------------------------------------------------------------------

test('a running match resumes from its last checkpoint (round, board, phase)', async (t) => {
  const store = new MemoryStore();
  const servers = [];
  const boot = async () => {
    const srv = await startServer({ port: 0, quiet: true, store, MatchClass: TestMatch, log: quietLog });
    servers.push(srv);
    return srv;
  };
  t.after(async () => { for (const srv of servers) await srv.close().catch(() => {}); });

  const srvA = await boot();
  const c = await player(srvA.port, 'Solo');
  const token = c.token;
  assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const code = (await c.waitFor('room.state')).code;
  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  const match = srvA.lobby.getRoom(code).match;
  assert.ok(match && match.phase === PHASE.INFO_CHECK, `match started (${match && match.phase})`);

  // drive the virtual clock to a checkpointable PREP with a purchased operator in hand
  assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
  until(match, () => match.phase === PHASE.BAND_DRAFT);
  assert.equal((await c.request({ t: 'g.band', bandId: match.gd.bandIds()[0] })).t, 'ok');
  until(match, () => match.phase === PHASE.PREP);
  const ps = match.players.get(c.id);
  const slot = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold);
  assert.equal((await c.request({ t: 'g.buy', slot })).t, 'ok');
  const bought = [...ps.hand].filter(Boolean).length;
  const funds = ps.funds;
  assert.ok(bought > 0, 'bought an operator');

  await srvA.persister.flush('test');
  assert.equal(srvA.persister.matchDocs.size, 1, 'checkpoint taken');
  await c.close();
  await srvA.close();

  const srvB = await boot();
  const room2 = srvB.lobby.getRoom(code);
  assert.ok(room2, 'the room is back');
  assert.ok(room2.match, 'the match runs again');
  assert.equal(room2.match.phase, PHASE.PREP);
  assert.equal(room2.match.round, 1);
  assert.equal(room2.match.errorCount, 0);
  const ps2 = room2.match.players.get(c.id);
  assert.equal(ps2.funds, funds, 'economy restored');
  assert.equal([...ps2.hand].filter(Boolean).length, bought, 'hand restored');

  // the player resumes into the running match and gets its views
  const back = await player(srvB.port, 'Solo', token);
  assert.equal(back.id, c.id);
  const state = await back.waitFor('room.state');
  assert.equal(state.inMatch, true);
  const pub = await back.waitFor('m.public');
  assert.equal(pub.phase, PHASE.PREP);
  await back.waitFor('m.private');
  // and the restored match keeps playing: the prep ends into the round's battle
  assert.equal((await back.request({ t: 'g.ready', ready: true })).t, 'ok');
  until(room2.match, () => room2.match.phase !== PHASE.PREP, 2000);
  assert.notEqual(room2.match.phase, PHASE.PREP, 'the restored prep went to battle');
  assert.equal(room2.match.round, 1);
  assert.equal(room2.match.errorCount, 0, JSON.stringify(room2.match.errors.slice(0, 2)));
});

test('a checkpoint whose player lost their session is not resumed (room stays in the lobby)', async (t) => {
  const store = new MemoryStore();
  const servers = [];
  const boot = async () => {
    const srv = await startServer({ port: 0, quiet: true, store, MatchClass: TestMatch, log: quietLog });
    servers.push(srv);
    return srv;
  };
  t.after(async () => { for (const srv of servers) await srv.close().catch(() => {}); });

  const srvA = await boot();
  const c = await player(srvA.port, 'Solo');
  await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const code = (await c.waitFor('room.state')).code;
  await c.request({ t: 'room.start' });
  const match = srvA.lobby.getRoom(code).match;
  await c.request({ t: 'g.infoReady' });
  until(match, () => match.phase === PHASE.BAND_DRAFT);
  await c.request({ t: 'g.band', bandId: match.gd.bandIds()[0] });
  until(match, () => match.phase === PHASE.PREP);
  assert.equal(match.phase, PHASE.PREP);
  await srvA.persister.flush('test');
  await c.close();
  await srvA.close();

  // the player is gone for three days: the solo 24 h window is over
  const doc = JSON.parse(JSON.stringify(store.doc));
  const threeDays = 3 * 24 * 3600_000;
  // both fields matter: a session that was *connected* when the document was written is measured from the load, not
  // from the recorded disconnect time (server/persist.js), so a resurrected "connected" flag would keep it alive
  for (const s of doc.sessions) { s.connected = false; s.disconnectedAt = Date.now() - threeDays; }
  doc.rooms[0].seats.forEach((s) => { s.connected = false; });
  await store.save(doc);

  const srvB = await boot();
  // assert on primitives: an AssertionError carrying a whole Room (its Match, its pool, its timers) would be serialized
  // by the test runner and blow the heap up
  assert.equal(srvB.lobby.rooms.size, 0, 'no room without a session');
  assert.equal(srvB.registry.size, 0, 'no session either');
});


test('operator potential and development survive session and room metadata recovery', () => {
  const now = Date.now();
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const player = registry.create('A');
  player.ops = { char_003_kalts: { potential: 2, cultivate: 0 } };
  lobby.create(player, { mode: 'coop', difficulty: 'NORMAL' });
  lobby.setAiPicksLast(player, { on: true });
  const doc = snapshotServer({ registry, lobby, now });
  const registry2 = new SessionRegistry();
  const lobby2 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  try {
    assert.equal(restoreServer({ doc, registry: registry2, lobby: lobby2, now, log: quietLog }).ok, true);
    assert.equal(lobby2.getRoom(player.roomCode).aiPicksLast, true);
    assert.deepEqual(registry2.byId(player.playerId).ops, player.ops);
    assert.deepEqual(lobby2.getRoom(player.roomCode).seatOf(player.playerId).ops, player.ops);
  } finally { lobby.shutdown(); lobby2.shutdown(); }
});

// ---------------------------------------------------------------------------------------------------
// content identity: a plugin room does not come back as the original game
// ---------------------------------------------------------------------------------------------------

const CS_VANILLA = 'b'.repeat(64);
const CS_MODDED = 'a'.repeat(64);
const CS_VERSION = 'c'.repeat(64);
const VS_MODDED = '0123456789abcdef';

/** The subset of server/plugins/roomSets.js the lobby uses; `gone` resolves to PLUGIN_UNKNOWN. */
function contentPlugins() {
  const held = { cs: [], vs: [] };
  return {
    held,
    resolve(ids, { settings = {} } = {}) {
      if (ids.includes('gone')) return { error: ERR.PLUGIN_UNKNOWN, detail: 'gone is not installed' };
      return { ok: true, set: {
        cs: CS_MODDED, vs: VS_MODDED,
        plugins: ids.map((id) => ({ id, version: '1.0.0', class: 'content', hash: '0123456789abcdef', ...(settings[id] ? { settings: settings[id] } : {}) })),
        warnings: [], bytes: 3, dataBytes: 9, modes: [{ id: 'mode_x_demo' }], kitted: [],
      } };
    },
    holdContent: (cs) => held.cs.push(cs),
    releaseContent: () => {},
    hold: (vs) => held.vs.push(vs),
    release: () => {},
    dataOf: () => ({ chess: {} }),
    kittedOf: () => null,
    defaults: () => [],
  };
}

const contentLobby = (registry, plugins, versions = null) => new Lobby({
  registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}), content: { cs: CS_VANILLA }, plugins, versions,
});

test('a restarted room keeps its content set: modded, vs and cs survive and matchmaking still refuses it', () => {
  const now = Date.now();
  const registry = new SessionRegistry();
  const plugins = contentPlugins();
  const lobby = contentLobby(registry, plugins);
  try {
    const a = registry.create('Alice');
    assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
    assert.deepEqual(lobby.setPlugins(a, { plugins: [{ id: 'demo' }] }), { ok: true });
    const room = lobby.getRoom(a.roomCode);
    assert.equal(room.modded, true);
    assert.equal(room.content.cs, CS_MODDED);
    assert.equal(room.content.vs, VS_MODDED);
    const doc = snapshotServer({ registry, lobby, now });
    assert.equal(doc.rooms[0].content.cs, CS_MODDED);
    assert.equal(doc.rooms[0].content.vs, VS_MODDED);
    assert.deepEqual(doc.rooms[0].content.plugins.map((p) => p.id), ['demo']);

    // restart: a fresh lobby, the same plugin installed
    const registry2 = new SessionRegistry();
    const plugins2 = contentPlugins();
    const lobby2 = contentLobby(registry2, plugins2);
    try {
      assert.equal(restoreServer({ doc, registry: registry2, lobby: lobby2, now: now + 1000, log: quietLog }).rooms, 1);
      const room2 = lobby2.getRoom(room.code);
      assert.ok(room2);
      assert.equal(room2.modded, true, 'a plugin room does not come back as the original game');
      assert.equal(room2.content.cs, CS_MODDED);
      assert.equal(room2.content.vs, VS_MODDED);
      assert.equal(room2.needsContent, true);
      assert.deepEqual(plugins2.held.cs, [CS_MODDED], 'the restored room holds its content set again');
      assert.deepEqual(plugins2.held.vs, [VS_MODDED]);
      // ... and the official queue refuses it for the same reason it did before the restart
      const session = registry2.byToken(a.token);
      assert.equal(matchmakingAvailable(lobby2, session, null), false);
      assert.equal(matchmakingMembers(lobby2, session, 'NORMAL', true).error, ERR.ROOM_MODDED);
    } finally { lobby2.shutdown(); }

    // a set that is no longer installed refuses the room instead of degrading it to the original game
    const doc2 = JSON.parse(JSON.stringify(doc));
    doc2.rooms[0].content.plugins = [{ id: 'gone' }];
    const registry3 = new SessionRegistry();
    const plugins3 = contentPlugins();
    const lobby3 = contentLobby(registry3, plugins3);
    try {
      const stats = restoreServer({ doc: doc2, registry: registry3, lobby: lobby3, now: now + 1000, log: quietLog });
      assert.equal(stats.rooms, 0);
      assert.equal(lobby3.rooms.size, 0);
      assert.deepEqual(plugins3.held.cs, [], 'a refused room holds nothing');
    } finally { lobby3.shutdown(); }
  } finally { lobby.shutdown(); }
});

test('a restarted version room regains its version base content, and is refused when that version is gone', () => {
  const now = Date.now();
  const VERSION = 'act1demo';
  const versions = {
    defaultId: DEFAULT_VERSION,
    isEnabled: (id) => id === DEFAULT_VERSION || id === VERSION,
    available: () => true,
    offered: () => ['NORMAL', 'HARD'],
    content: (id) => (id === VERSION ? { cs: CS_VERSION, vanilla: true, version: VERSION, plugins: [] } : null),
    data: () => ({}),
  };
  const registry = new SessionRegistry();
  const lobby = contentLobby(registry, contentPlugins(), versions);
  try {
    const a = registry.create('Alice');
    assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'NORMAL', version: VERSION }), { ok: true });
    const room = lobby.getRoom(a.roomCode);
    assert.equal(room.version, VERSION);
    assert.equal(room.needsContent, true, 'a version room makes every page load its content (requireCs at start)');
    assert.equal(room.content.cs, CS_VERSION);
    const doc = snapshotServer({ registry, lobby, now });
    assert.equal(doc.rooms[0].version, VERSION);
    assert.equal(doc.rooms[0].content.cs, CS_VERSION);

    const registry2 = new SessionRegistry();
    const lobby2 = contentLobby(registry2, contentPlugins(), versions);
    try {
      assert.equal(restoreServer({ doc, registry: registry2, lobby: lobby2, now: now + 1000, log: quietLog }).rooms, 1);
      const room2 = lobby2.getRoom(room.code);
      assert.ok(room2);
      assert.equal(room2.version, VERSION);
      assert.equal(room2.content.cs, CS_VERSION, 'the version base is rebuilt, not left null');
      assert.equal(room2.needsContent, true);
    } finally { lobby2.shutdown(); }

    // the version's data is gone: no room that could not load its content is restored
    const registry3 = new SessionRegistry();
    const versions3 = { ...versions, content: () => null };
    const lobby3 = contentLobby(registry3, contentPlugins(), versions3);
    try {
      assert.equal(restoreServer({ doc, registry: registry3, lobby: lobby3, now: now + 1000, log: quietLog }).rooms, 0);
      assert.equal(lobby3.rooms.size, 0);
    } finally { lobby3.shutdown(); }
  } finally { lobby.shutdown(); }
});

test('seedMatches drops a version recorded against another checkpoint so it cannot be skipped', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const store = new MemoryStore();
  const persister = new Persister({ store, registry, lobby, log: quietLog });
  try {
    const match = {};
    persister.matchDocs.set('ROOM1', '{"round":9}');
    persister.matchVersions.set('ROOM1', { match, version: 5 });
    persister.seedMatches({ matches: { ROOM1: { round: 3 } } });
    assert.equal(persister.matchDocs.get('ROOM1'), '{"round":3}', 'the recovered body replaces the run\'s');
    assert.equal(persister.matchVersions.has('ROOM1'), false,
      'the recovered body has no trusted version: the next encode must rewrite it');
  } finally { lobby.rooms.clear(); await persister.encoder.close(); lobby.shutdown(); }
});

test('checkpointMatches releases a version entry once the room no longer holds that match', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const store = new MemoryStore();
  const persister = new Persister({ store, registry, lobby, log: quietLog });
  try {
    const ended = {};  // the match a room already ended (the room itself keeps only the summary and the replay)
    const live = {};   // a room's current match (canSnapshot refuses it: no sched — the sweep is what is under test)
    // Minimal room shapes: the sweep reads only `.disposed` and `.match` (server/persist.js checkpointMatches).
    lobby.rooms.set('ENDED', { code: 'ENDED', disposed: false, match: null });
    lobby.rooms.set('REPLACED', { code: 'REPLACED', disposed: false, match: live });
    lobby.rooms.set('LIVE', { code: 'LIVE', disposed: false, match: live });
    persister.matchDocs.set('ENDED', '{"round":9}');
    persister.matchVersions.set('ENDED', { match: ended, version: 5 });
    persister.matchVersions.set('REPLACED', { match: ended, version: 5 });
    persister.matchVersions.set('LIVE', { match: live, version: 5 });
    await persister.checkpointMatches();
    assert.equal(persister.matchVersions.has('ENDED'), false,
      'the ended match must not stay pinned by the persister');
    assert.equal(persister.matchDocs.get('ENDED'), '{"round":9}', 'the stored checkpoint body survives the release');
    assert.equal(persister.matchVersions.has('REPLACED'), false,
      'an entry of a replaced match is released before the new match commits');
    assert.equal(persister.matchVersions.has('LIVE'), true,
      'the current match keeps its skip entry');
  } finally { lobby.rooms.clear(); await persister.encoder.close(); lobby.shutdown(); }
});

test('checkpointMatches encodes at most encodeBudget rooms per round and rotates fairly', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const store = new MemoryStore();
  const persister = new Persister({ store, registry, lobby, log: quietLog, encodeBudget: 2 });
  try {
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) lobby.rooms.set(c, { code: c, disposed: false, match: {} });
    const calls = [];
    persister.encodeRoom = async (code) => { calls.push(code); return true; };
    await persister.checkpointMatches();
    await persister.checkpointMatches();
    await persister.checkpointMatches();
    await persister.checkpointMatches();
    assert.deepEqual(calls.slice(0, 6), ['A', 'B', 'C', 'D', 'E', 'F'],
      'the budget takes the next two rooms each round, in rotation');
    assert.equal(calls[6], 'A', 'after the full rotation the first room is due again');
    assert.equal(persister.versionStats.deferred, 4, 'each truncated round is counted once');
    // A deferred room keeps whatever version entry it had: the next sweep re-checks it (nothing is lost).
    persister.matchVersions.set('F', { match: lobby.rooms.get('F').match, version: 5 });
    await persister.checkpointMatches();
    assert.equal(persister.matchVersions.has('F'), true,
      'a budget-deferred room is not touched by the sweep that skipped it');
  } finally { lobby.rooms.clear(); await persister.encoder.close(); lobby.shutdown(); }
});

test('encodeBudget 0 is the uncapped escape hatch and pure skips cost no budget', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const store = new MemoryStore();
  const persister = new Persister({ store, registry, lobby, log: quietLog, encodeBudget: 0 });
  try {
    for (const c of ['A', 'B', 'C']) lobby.rooms.set(c, { code: c, disposed: false, match: {} });
    lobby.rooms.set('IDLE', { code: 'IDLE', disposed: false, match: null });
    const calls = [];
    persister.encodeRoom = async (code) => { calls.push(code); return false; };
    await persister.checkpointMatches();
    assert.deepEqual(calls, ['A', 'B', 'C'], 'every room with a match is visited; the matchless one is not');
    assert.equal(persister.versionStats.deferred, 0, 'no committed encode, no budget pressure');
    assert.equal(persister._encodeCursor, 0, 'a full rotation wraps the cursor back to the start');
  } finally { lobby.rooms.clear(); await persister.encoder.close(); lobby.shutdown(); }
});

