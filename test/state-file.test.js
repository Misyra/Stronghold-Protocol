import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { FileStateStore } from '../server/stateFile.js';
import { Persister, snapshotServer, restoreServer } from '../server/persist.js';
import { startServer } from '../server/index.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };
async function fixture(t) {
  const root = path.join(os.tmpdir(), 'sp-file-test-');
  const dir = await fs.mkdtemp(root);
  assert.ok(path.resolve(dir).startsWith(path.resolve(root)));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { dir, file: path.join(dir, 'game.state.json') };
}
test('atomic file writes survive a new store, serialize concurrent saves, and refuse another live writer', async (t) => {
  const { file } = await fixture(t);
  const a = new FileStateStore({ file, log });
  const b = new FileStateStore({ file, log });
  t.after(() => a.close()); t.after(() => b.close());
  assert.equal(await a.load(), null);
  await assert.rejects(b.load(), /其他游戏进程/);
  await b.close();
  assert.ok(await fs.stat(`${file}.lock`), 'a failed second writer must not remove the first lock');
  const writes = await Promise.all([a.save({ v: 1, value: 'first' }), a.save({ v: 1, value: 'latest' })]);
  assert.deepEqual(writes, [true, true]);
  await a.close();
  const c = new FileStateStore({ file, log }); t.after(() => c.close());
  assert.deepEqual(await c.load(), { v: 1, value: 'latest' });
});
test('corrupt and incompatible documents are kept intact and never silently overwritten by server boot', async (t) => {
  const { file } = await fixture(t);
  for (const raw of ['{"truncated":', JSON.stringify({ v: 999, savedAt: Date.now(), sessions: [], rooms: [] }),
    JSON.stringify({ v: 1, snapshot: 999, sessions: [], rooms: [] })]) {
    await fs.writeFile(file, raw);
    await assert.rejects(startServer({ port: 0, workers: 0, log, stateFile: file }), /损坏|不兼容/);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    await assert.rejects(fs.stat(`${file}.lock`), { code: 'ENOENT' });
  }
});
test('shutdown waits for an interval write and then persists the final state, rather than skipping it', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log });
  const s = registry.create('before');
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const docs = [];
  const store = { async save(doc) { if (!docs.length) { docs.push(doc); await gate; } else docs.push(doc); return true; } };
  const persister = new Persister({ store, registry, lobby, log });
  const pending = persister.flush();
  s.name = 'final';
  const shutdown = persister.shutdown();
  unblock();
  await pending;
  assert.equal(await shutdown, true);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].sessions[0].name, 'before');
  assert.equal(docs[1].sessions[0].name, 'final');
  lobby.shutdown();
});
test('server downtime counts toward reconnect expiry, with the longer solo recovery window', () => {
  const registry = new SessionRegistry(); const lobby = new Lobby({ registry, log });
  const coop = registry.create('coop'); const solo = registry.create('solo');
  lobby.create(coop, { mode: 'coop', difficulty: 'NORMAL' });
  lobby.create(solo, { mode: 'solo', difficulty: 'NORMAL' });
  coop.connected = solo.connected = true;
  lobby.getRoom(solo.roomCode).match = { dispose() {} };
  const at = Date.now();
  const doc = snapshotServer({ registry, lobby, now: at });
  const fresh = new SessionRegistry(); const restored = new Lobby({ registry: fresh, log });
  try {
    const result = restoreServer({ doc, registry: fresh, lobby: restored, now: at + 15 * 60_000, log });
    assert.equal(result.expired, 1);
    assert.equal(fresh.byId(coop.playerId), null);
    assert.ok(fresh.byId(solo.playerId));
  } finally { lobby.shutdown(); restored.shutdown(); }
});
test('a state file containing session secrets is refused under a publicly served directory', async () => {
  await assert.rejects(startServer({ port: 0, workers: 0, log, stateFile: 'data/leaked.state.json' }), /公开静态目录/);
});
test('room spectators and pending settlement replay survive a document round trip', () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log, MatchClass: StubMatch });
  const p = registry.create('player'); const spectator = registry.create('watcher');
  lobby.create(p, { mode: 'coop', difficulty: 'NORMAL' });
  const room = lobby.getRoom(p.roomCode);
  spectator.roomCode = room.code;
  room.spectators.push({ playerId: spectator.playerId, name: spectator.name, connected: true });
  room.replay = { publicFrame: '{"t":"m.public","phase":"RESULT"}',
    frames: new Map([[p.playerId, '{"t":"m.result","victory":true}']]), pending: new Set([p.playerId]) };
  p.notice = 'timeout'; p.pendingResult = ['{"t":"m.result"}'];
  const doc = JSON.parse(JSON.stringify(snapshotServer({ registry, lobby })));
  const fresh = new SessionRegistry(); const restored = new Lobby({ registry: fresh, log, MatchClass: StubMatch });
  try {
    assert.equal(restoreServer({ doc, registry: fresh, lobby: restored, log }).ok, true);
    assert.equal(restored.getRoom(room.code).spectators[0].playerId, spectator.playerId);
    assert.equal(restored.getRoom(room.code).replay.frames.get(p.playerId), room.replay.frames.get(p.playerId));
    assert.equal(fresh.byId(p.playerId).notice, 'timeout');
    assert.deepEqual(fresh.byId(p.playerId).pendingResult, p.pendingResult);
  } finally { lobby.shutdown(); restored.shutdown(); }
});
for (const layout of ['file', 'directory']) test(`a hard-killed server restores its real room, identity and match from ${layout} storage in a new process`, { timeout: 20000 }, async (t) => {
  const children = [];
  const clients = [];
  // Cleanup hooks run in registration order: stop writers before removing their temporary directory.
  t.after(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { const exited = once(c, 'exit'); c.kill('SIGKILL'); await exited; }
    for (const c of clients) await c.terminate();
  });
  const { dir, file } = await fixture(t);
  const stateFile = layout === 'file' ? file : path.join(dir, 'state');
  const childFile = path.join(dir, 'child.mjs');
  await fs.writeFile(childFile, `import { startServer } from ${JSON.stringify(new URL('../server/index.js', import.meta.url).href)};
const quiet = {info(){},warn(){},error(){},debug(){}};
const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, log: quiet, stateFile: process.env.TEST_STATE_FILE });
process.on('message', async (msg) => { if(msg === 'flush') { await srv.persister.flush('test'); process.send({ flushed: true }); } });
process.send({ port: srv.port });
`);
  const boot = async () => {
    const child = fork(childFile, [], { env: { ...process.env, TEST_STATE_FILE: stateFile }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    const [hello] = await once(child, 'message');
    return { child, port: hello.port };
  };
  const first = await boot();
  const client = await TestClient.connect(`ws://127.0.0.1:${first.port}/ws`); clients.push(client);
  const welcome = await client.hello('disk-player');
  await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const state = await client.waitFor('room.state');
  await client.request({ t: 'room.start' });
  await client.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
  const flushed = once(first.child, 'message'); first.child.send('flush'); await flushed;
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const second = await boot();
  const resumed = await TestClient.connect(`ws://127.0.0.1:${second.port}/ws`); clients.push(resumed);
  const back = await resumed.hello('disk-player', welcome.token);
  assert.equal(back.playerId, welcome.playerId);
  const room = await resumed.waitFor('room.state');
  assert.equal(room.code, state.code);
  assert.equal(room.inMatch, true);
  assert.equal((await resumed.waitFor('m.public')).phase, 'INFO_CHECK');
});
