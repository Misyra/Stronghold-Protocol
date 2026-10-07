// Clock-only refreshes must stay small without changing recovery or losing failed writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileStateStore } from '../server/stateFile.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { startServer } from '../server/index.js';
import { snapshotServer, restoreServer } from '../server/persist.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };
const checkpoint = (round) => JSON.stringify({ v: 1, phase: 'PREP', round, players: [] });
const payload = (savedAt, round = 1, deadlineRemainingMs = 5000) => ({
  index: {
    v: 1, snapshot: 1, savedAt, sessions: [],
    rooms: [{ code: 'ABCD', matchCount: 1, hasMatch: true }],
    clocks: { ABCD: { deadlineRemainingMs, startedAtAgoMs: savedAt } },
  },
  shards: new Map([['ABCD', checkpoint(round)]]),
});

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'sp-runtime-test-');
  const dir = await fs.mkdtemp(prefix);
  assert.ok(path.resolve(dir).startsWith(path.resolve(prefix)));
  const stateDir = path.join(dir, 'state');
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const create = () => {
    const store = new FileStateStore({ file: stateDir, log });
    stores.push(store);
    return store;
  };
  return { stateDir, create };
}

function failOnce(store, target) {
  const write = store.writeAtomic.bind(store);
  let failed = false;
  store.writeAtomic = async (file, content) => {
    if (file === target && !failed) { failed = true; throw new Error('simulated disk write failure'); }
    return write(file, content);
  };
}

test('an unchanged online room survives a long idle period, while real disconnects and downtime still expire', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log, MatchClass: StubMatch, getData: () => ({}) });
  t.after(() => lobby.shutdown());
  const online = registry.create('online');
  online.connected = true; online.disconnectedAt = null;
  lobby.create(online, { mode: 'coop', difficulty: 'NORMAL' });
  const at = Date.now();
  const dropped = registry.create('dropped');
  dropped.disconnectedAt = at;
  await store.save(snapshotServer({ registry, lobby, now: at }));
  const later = at + 11 * 60_000;
  await store.save(snapshotServer({ registry, lobby, now: later }));
  assert.equal(store.indexWrites, 1, 'the large index remains unchanged');
  const doc = await store.load();
  assert.equal(doc.savedAt, later);

  for (const [now, expectedOnline] of [[later + 1000, true], [later + 11 * 60_000, false]]) {
    const fresh = new SessionRegistry();
    const restored = new Lobby({ registry: fresh, log, MatchClass: StubMatch, getData: () => ({}) });
    try {
      restoreServer({ doc, registry: fresh, lobby: restored, now, log });
      assert.equal(!!fresh.byToken(online.token), expectedOnline);
      assert.equal(!!restored.getRoom(online.roomCode), expectedOnline, 'seat and room survive with the identity');
      assert.equal(fresh.byToken(dropped.token), null, 'heartbeat never extends a genuinely disconnected identity');
    } finally { restored.shutdown(); }
  }
});

test('a failed first index write is retried with identical content, and counters count only successful writes', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.load();
  failOnce(store, store.indexFile);
  assert.equal(await store.saveSharded(payload(1)), false);
  assert.equal(store.indexWrites, 0);
  assert.equal(store.runtimeWrites, 0);
  assert.equal(await store.saveSharded(payload(2)), true);
  assert.equal(store.indexWrites, 1);
  assert.equal(store.shardWrites, 1, 'already written shards need not be retried');
  await store.close();
  const doc = await create().load();
  assert.equal(doc.savedAt, 2);
  assert.equal(doc.matches.ABCD.round, 1);
});

test('a failed shard write never publishes newer clocks and remains retryable', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.saveSharded(payload(1));
  failOnce(store, path.join(store.matchesDir, 'ABCD.json'));
  assert.equal(await store.saveSharded(payload(2, 2, 30_000)), false);
  assert.equal(store.runtimeWrites, 1);
  const before = await store.load();
  assert.equal(before.matches.ABCD.round, 1);
  assert.equal(before.matches.ABCD.deadlineRemainingMs, 5000);
  assert.equal(await store.saveSharded(payload(3, 2, 30_000)), true);
  const after = await store.load();
  assert.equal(after.matches.ABCD.round, 2);
  assert.equal(after.matches.ABCD.deadlineRemainingMs, 30_000);
});

test('a save interrupted after a new shard uses that shard clock, never the older round clock', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.saveSharded(payload(1));
  failOnce(store, store.runtimeFile);
  assert.equal(await store.saveSharded(payload(2, 2, 30_000)), false);
  assert.equal(store.runtimeWrites, 1);
  await store.close();
  const reopened = create();
  const doc = await reopened.load();
  assert.equal(doc.matches.ABCD.round, 2);
  assert.equal(doc.matches.ABCD.deadlineRemainingMs, 30_000);
  assert.equal(doc.matches.ABCD.startedAtAgoMs, 2);
  assert.equal(await reopened.saveSharded(payload(3, 2, 29_000)), true);
  assert.equal(reopened.shardWrites, 0);
  assert.equal(reopened.indexWrites, 0);
  assert.equal((await reopened.load()).matches.ABCD.deadlineRemainingMs, 29_000);
});

test('runtime failure is retried without rewriting the successful metadata or shard', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.load();
  failOnce(store, store.runtimeFile);
  assert.equal(await store.saveSharded(payload(1)), false);
  const fallback = await store.load();
  assert.equal(fallback.savedAt, 1, 'a missing first runtime falls back to the index stamp');
  assert.equal(fallback.matches.ABCD.deadlineRemainingMs, 5000);
  assert.equal(await store.saveSharded(payload(2)), true);
  assert.equal(store.indexWrites, 1);
  assert.equal(store.shardWrites, 1);
  assert.equal(store.runtimeWrites, 1);
});

test('runtime from a different metadata revision cannot refresh identities or clocks', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.saveSharded(payload(1));
  const runtime = JSON.parse(await fs.readFile(store.runtimeFile, 'utf8'));
  runtime.indexRevision = 'another-index'; runtime.savedAt = 999;
  runtime.clocks.ABCD.deadlineRemainingMs = 999_999;
  await fs.writeFile(store.runtimeFile, JSON.stringify(runtime));
  const doc = await store.load();
  assert.equal(doc.savedAt, 1);
  assert.equal(doc.matches.ABCD.deadlineRemainingMs, 5000);
});

test('a new match shard cannot be restored against the previous match generation after an index failure', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.saveSharded(payload(1));
  failOnce(store, store.indexFile);
  const next = payload(2, 2, 30_000);
  next.index.rooms[0].matchCount = 2;
  assert.equal(await store.saveSharded(next), false);
  const oldIndex = await store.load();
  assert.equal(oldIndex.rooms[0].matchCount, 1);
  assert.equal(oldIndex.matches.ABCD, undefined, 'the uncommitted next match is not attached to the old room');
  assert.equal(await store.saveSharded(next), true);
  assert.equal((await store.load()).matches.ABCD.round, 2);
});

test('a failed room removal retains the previous shard until the index commit succeeds', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.saveSharded(payload(1));
  failOnce(store, store.indexFile);
  const removed = { index: { ...payload(2).index, rooms: [], clocks: {} }, shards: new Map() };
  assert.equal(await store.saveSharded(removed), false);
  assert.equal((await store.load()).matches.ABCD.round, 1);
  assert.equal(await store.saveSharded(removed), true);
  await assert.rejects(fs.stat(path.join(store.matchesDir, 'ABCD.json')), { code: 'ENOENT' });
});

test('a corrupt runtime refuses startup and preserves the original file', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  await store.saveSharded(payload(1));
  await fs.writeFile(store.runtimeFile, '{"truncated');
  await assert.rejects(store.load(), /运行时文件损坏/);
  await store.close();
  await assert.rejects(startServer({ port: 0, workers: 0, log, stateFile: store.file }), /运行时文件损坏/);
  assert.equal(await fs.readFile(store.runtimeFile, 'utf8'), '{"truncated');
  await assert.rejects(fs.stat(store.lockFile), { code: 'ENOENT' }, 'a failed boot releases its lock');
});

test('old directory indexes and raw shards migrate with their clocks intact', async (t) => {
  const { stateDir, create } = await fixture(t);
  await fs.mkdir(path.join(stateDir, 'matches'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'index.json'), JSON.stringify(payload(1).index));
  await fs.writeFile(path.join(stateDir, 'matches', 'ABCD.json'), checkpoint(1));
  const store = create();
  const legacy = await store.load();
  assert.equal(legacy.matches.ABCD.deadlineRemainingMs, 5000);
  assert.equal(await store.save(legacy), true);
  const newIndex = JSON.parse(await fs.readFile(store.indexFile, 'utf8'));
  assert.equal('clocks' in newIndex, false);
  assert.equal((await store.load()).matches.ABCD.deadlineRemainingMs, 5000);
  assert.equal(await store.saveSharded(payload(2)), true);
  assert.equal(store.indexWrites, 1);
  assert.equal(store.shardWrites, 1);
});

test('a queued save captures checkpoint entries before later match events mutate the map', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  const round = payload(1);
  const saving = store.saveSharded(round);
  round.shards.set('ABCD', checkpoint(2));
  assert.equal(await saving, true);
  assert.equal((await store.load()).matches.ABCD.round, 1);
});

test('250 unchanged rooms write only the small runtime file during a clock refresh', async (t) => {
  const { create } = await fixture(t);
  const store = create();
  const roomCodes = Array.from({ length: 250 }, (_, i) => `R${String(i).padStart(3, '0')}`);
  const meta = {
    v: 1, snapshot: 1, savedAt: 1,
    sessions: roomCodes.map((code) => ({ playerId: code, token: `${code}-token`, connected: true, loadout: 'x'.repeat(2048) })),
    rooms: roomCodes.map((code) => ({ code, matchCount: 1, hasMatch: true })),
    clocks: Object.fromEntries(roomCodes.map((code) => [code, { deadlineRemainingMs: 5000, startedAtAgoMs: 1 }])),
  };
  const shards = new Map(roomCodes.map((code) => [code, checkpoint(1)]));
  await store.saveSharded({ index: meta, shards });
  const indexBytes = (await fs.stat(store.indexFile)).size;
  const writes = [];
  const write = store.writeAtomic.bind(store);
  store.writeAtomic = async (file, content) => { writes.push({ file, bytes: Buffer.byteLength(content) }); return write(file, content); };
  const next = { ...meta, savedAt: 2, clocks: Object.fromEntries(roomCodes.map((code) => [code, { deadlineRemainingMs: 4000, startedAtAgoMs: 2 }])) };
  assert.equal(await store.saveSharded({ index: next, shards }), true);
  assert.deepEqual(writes.map(({ file }) => file), [store.runtimeFile]);
  assert.ok(writes[0].bytes < indexBytes / 10, 'steady-state disk bytes are less than a tenth of the large index');
  const doc = await store.load();
  assert.equal(Object.keys(doc.matches).length, 250);
  assert.equal(doc.matches.R249.deadlineRemainingMs, 4000);
});
