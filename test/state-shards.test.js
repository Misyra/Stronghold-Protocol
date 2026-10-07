// test/state-shards.test.js — the sharded directory layout (server/stateFile.js dir mode): shards change only when
// their body changes, the clock envelope keeps restoring fresh, a legacy single-file state migrates, and a corrupt
// shard costs one room instead of the whole server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { PHASE } from '../shared/constants.js';
import { FileStateStore } from '../server/stateFile.js';
import { startServer } from '../server/index.js';
import { Match as RealMatch } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { FakeBattle } from './match/fakeBattle.js';
import { TestClient } from './helpers/wsClient.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

async function fixture(t) {
  const root = path.join(os.tmpdir(), 'sp-shard-test-');
  const dir = await fs.mkdtemp(root);
  assert.ok(path.resolve(dir).startsWith(path.resolve(root)));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { dir, stateDir: path.join(dir, 'state') };
}

const shardV1 = JSON.stringify({ v: 1, phase: 'PREP', round: 1, players: [] });
const shardRound2 = JSON.stringify({ v: 1, phase: 'PREP', round: 2, players: [] });
const index = (savedAt, clocks, rooms = ['ABCD']) => ({
  v: 1, snapshot: 1, savedAt, sessions: [], rooms: rooms.map((code) => ({ code })), clocks,
});

test('directory mode: shards are rewritten only when their body changes, the index only when its content changes', async (t) => {
  const { stateDir } = await fixture(t);
  const store = new FileStateStore({ file: stateDir, log });
  t.after(() => store.close());
  assert.equal(await store.load(), null, 'nothing on disk yet');
  assert.equal(store.mode, 'dir', 'an extensionless missing path becomes a directory');

  const clocks = (deadlineRemainingMs) => ({ ABCD: { deadlineRemainingMs, startedAtAgoMs: 10 } });
  assert.equal(await store.saveSharded({ index: index(1, clocks(5000)), shards: new Map([['ABCD', shardV1]]) }), true);
  assert.equal(store.shardWrites, 1);
  assert.equal(store.indexWrites, 1);
  assert.equal(await store.saveSharded({ index: index(2, clocks(4000)), shards: new Map([['ABCD', shardV1]]) }), true);
  assert.equal(store.shardWrites, 1, 'an unchanged shard is not rewritten');
  assert.equal(store.indexWrites, 1, 'changed clocks do not rewrite metadata');
  assert.equal(store.runtimeWrites, 2, 'changed clocks are committed separately');
  assert.equal(await store.saveSharded({ index: index(3, clocks(3000)), shards: new Map([['ABCD', shardRound2]]) }), true);
  assert.equal(store.shardWrites, 2, 'a changed shard is rewritten');
  assert.equal(await store.saveSharded({ index: index(4, clocks(3000)), shards: new Map([['ABCD', shardRound2]]) }), true);
  assert.equal(store.indexWrites, 1, 'checkpoints and heartbeat updates do not rewrite metadata');
  assert.equal(store.runtimeWrites, 4, 'even an unchanged battle refreshes the heartbeat');

  const doc = await store.load();
  assert.equal(doc.matches.ABCD.round, 2, 'the newest body');
  assert.equal(doc.matches.ABCD.deadlineRemainingMs, 3000, 'runtime carries the freshest matching clocks');
  assert.equal(doc.savedAt, 4, 'recovery sees the latest heartbeat, not the old index stamp');
  const diskIndex = JSON.parse(await fs.readFile(path.join(stateDir, 'index.json'), 'utf8'));
  assert.equal(diskIndex.savedAt, 1);
  assert.equal('clocks' in diskIndex, false);
  assert.equal(doc.rooms[0].code, 'ABCD');
});

test('directory mode: a shard whose room is gone is removed on save, and an orphan shard on load', async (t) => {
  const { stateDir } = await fixture(t);
  const store = new FileStateStore({ file: stateDir, log });
  t.after(() => store.close());
  await store.saveSharded({ index: index(1, {}, ['ABCD', 'BBBB']), shards: new Map([['ABCD', shardV1], ['BBBB', shardV1]]) });
  assert.ok(await fs.stat(path.join(stateDir, 'matches', 'ABCD.json')));
  await store.saveSharded({ index: index(2, {}, ['BBBB']), shards: new Map([['BBBB', shardV1]]) });
  await assert.rejects(fs.stat(path.join(stateDir, 'matches', 'ABCD.json')), { code: 'ENOENT' }, 'removed on save');

  await fs.writeFile(path.join(stateDir, 'matches', 'ZZZZ.json'), shardV1);   // a room the index never knew
  const doc = await store.load();
  assert.equal(doc.matches.ZZZZ, undefined);
  assert.equal(doc.matches.BBBB.round, 1);
  await assert.rejects(fs.stat(path.join(stateDir, 'matches', 'ZZZZ.json')), { code: 'ENOENT' }, 'orphan removed on load');
});

test('directory mode: a corrupt shard costs one room, a corrupt index refuses the store', async (t) => {
  const { stateDir } = await fixture(t);
  const store = new FileStateStore({ file: stateDir, log });
  t.after(() => store.close());
  await store.saveSharded({ index: index(1, { ABCD: { deadlineRemainingMs: 7000, startedAtAgoMs: 3 } }), shards: new Map([['ABCD', shardV1]]) });
  await fs.writeFile(path.join(stateDir, 'matches', 'ABCD.json'), '{"truncated');
  const doc = await store.load();
  assert.equal(doc.matches.ABCD, undefined, 'the unreadable shard is skipped, the index still loads');
  await store.close();

  const broken = new FileStateStore({ file: stateDir, log });
  t.after(() => broken.close());
  await fs.writeFile(path.join(stateDir, 'index.json'), '{"truncated');
  await assert.rejects(broken.load(), /状态文件损坏/);
  assert.equal(await fs.readFile(path.join(stateDir, 'index.json'), 'utf8'), '{"truncated', 'the corrupt file is kept');
});

test('the legacy single-file state migrates into the directory layout', async (t) => {
  const { stateDir } = await fixture(t);
  const legacy = `${stateDir}.state.json`;
  await fs.writeFile(legacy, JSON.stringify({
    v: 1, snapshot: 1, savedAt: 1, sessions: [],
    rooms: [{ code: 'ABCD', mode: 'solo', difficulty: 'NORMAL', hostId: 'p_0', matchCount: 1, seats: [] }],
    matches: { ABCD: { v: 1, phase: 'PREP', round: 3, deadlineRemainingMs: 9000, startedAtAgoMs: 5, players: [] } },
  }));
  const store = new FileStateStore({ file: stateDir, log });
  t.after(() => store.close());
  const doc = await store.load();
  assert.equal(doc.matches.ABCD.round, 3);
  assert.equal(doc.matches.ABCD.deadlineRemainingMs, 9000, 'legacy inline clocks are read as-is');

  // the first sharded write takes over; the legacy file stays on disk as a rollback copy
  await store.saveSharded({ index: { ...doc, clocks: { ABCD: { deadlineRemainingMs: 8000, startedAtAgoMs: 6 } } }, shards: new Map([['ABCD', shardV1]]) });
  const again = await store.load();
  assert.equal(again.matches.ABCD.round, 1);
  assert.equal(again.matches.ABCD.deadlineRemainingMs, 8000, 'the envelope now carries the clocks');
  assert.ok(await fs.stat(legacy), 'the legacy file is preserved');
});

test('a second writer is refused in directory mode, and the lock survives a failed second store', async (t) => {
  const { stateDir } = await fixture(t);
  const a = new FileStateStore({ file: stateDir, log });
  const b = new FileStateStore({ file: stateDir, log });
  t.after(() => a.close()); t.after(() => b.close());
  await a.load();
  await assert.rejects(b.load(), /其他游戏进程/);
  await b.close();
  assert.ok(await fs.stat(path.join(stateDir, 'state.lock')), 'a failed second writer must not remove the first lock');
});

test('an existing plain file without a .json suffix stays in single-file mode', async (t) => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'state');
  await fs.writeFile(file, JSON.stringify({ v: 1, value: 'kept' }));
  const store = new FileStateStore({ file, log });
  t.after(() => store.close());
  assert.deepEqual(await store.load(), { v: 1, value: 'kept' });
  assert.equal(store.mode, 'file', 'resolved from the existing plain file');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { v: 1, value: 'kept' });
});

// ---------------------------------------------------------------------------------------------------
// end to end: a running match survives a restart through the sharded layout
// ---------------------------------------------------------------------------------------------------

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

async function player(port, name, token) {
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`);
  const w = await c.hello(name, token);
  c.id = w.playerId;
  c.token = w.token;
  return c;
}

test('a running match survives a restart through the sharded directory layout', async (t) => {
  const { stateDir } = await fixture(t);
  const servers = [];
  const boot = async () => {
    const srv = await startServer({ port: 0, quiet: true, log, stateFile: stateDir, MatchClass: TestMatch });
    servers.push(srv);
    return srv;
  };
  t.after(async () => { for (const srv of servers) await srv.close().catch(() => {}); });

  const srvA = await boot();
  assert.equal(srvA.store.mode, 'dir');
  const c = await player(srvA.port, 'Solo');
  const token = c.token;
  try {
    await runMatchAndRestart();
  } finally {
    await c.close().catch(() => {});
    for (const srv of servers.reverse()) await srv.close().catch(() => {});
  }

  async function runMatchAndRestart() {
    assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
    const code = (await c.waitFor('room.state')).code;
    assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
    const match = srvA.lobby.getRoom(code).match;
    await c.request({ t: 'g.infoReady' });
    assert.ok(driveTo({ m: match, sched: match.sched }, () => match.phase === PHASE.BAND_DRAFT, { maxSteps: 1e4 }), 'reached the band draft');
    assert.equal((await c.request({ t: 'g.band', bandId: match.gd.bandIds()[0] })).t, 'ok');
    assert.ok(driveTo({ m: match, sched: match.sched }, () => match.phase === PHASE.PREP), 'reached the prep');
    const ps = match.players.get(c.id);
    const slot = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold);
    assert.equal((await c.request({ t: 'g.buy', slot })).t, 'ok');
    const funds = ps.funds;
    assert.ok(await srvA.persister.flush('test'), 'the sharded write landed');
    const shard = await fs.readFile(path.join(stateDir, 'matches', `${code}.json`), 'utf8');
    assert.equal('deadlineRemainingMs' in JSON.parse(shard).checkpoint, false, 'the checkpoint body carries no clock');
    const runtimeDoc = JSON.parse(await fs.readFile(path.join(stateDir, 'runtime.json'), 'utf8'));
    assert.ok(Number.isFinite(runtimeDoc.clocks[code].deadlineRemainingMs), 'the clock envelope is on disk');
    await c.close();
    await srvA.close();                                 // release the state lock before the second boot

    const srvB = await boot();
    const room2 = srvB.lobby.getRoom(code);
    assert.ok(room2, 'the room is back');
    assert.ok(room2.match, 'the match runs again from the shard');
    assert.equal(room2.match.phase, PHASE.PREP);
    assert.equal(room2.match.round, 1);
    assert.equal(room2.match.players.get(c.id).funds, funds, 'economy restored');
    const back = await player(srvB.port, 'Solo', token);
    assert.equal(back.id, c.id);
    const pub = await back.waitFor('m.public');
    assert.equal(pub.phase, PHASE.PREP);
    await back.close();
  }
});
