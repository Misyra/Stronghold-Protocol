import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { lobbyOptionsFrom } from '../server/http/config.js';
import { loadRoomConfig } from '../server/roomAdmin.js';
import { TestClient } from './helpers/wsClient.js';

const token = 'bot-policy-test-secret-01234567890123456789';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-bot-policy-'));
  const state = path.join(dir, 'room-admin.json');
  const clients = [], servers = [];
  const start = async (extra = {}) => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off',
      roomAdminToken: token, roomAdminPort: 0, roomAdminStateFile: state,
      MatchClass: StubMatch, log: quiet, ...options, ...extra });
    servers.push(srv);
    return srv;
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const srv of servers) await srv.close();
    await rm(dir, { recursive: true, force: true });
  });
  const connect = async (srv, name = 'BotHost') => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(client);
    await client.hello(name);
    assert.equal((await client.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    return client;
  };
  const put = (srv, body, secret = token) => fetch(`${srv.roomAdminUrl}/api/room-config`, {
    method: 'PUT', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { state, dir, start, connect, put };
}

test('bot policy defaults to enabled and validates startup configuration', () => {
  assert.equal(lobbyOptionsFrom({}, {}).allowBots, true);
  for (const value of ['off', 'false', '0']) assert.equal(lobbyOptionsFrom({}, { SP_ALLOW_BOTS: value }).allowBots, false);
  assert.equal(lobbyOptionsFrom({ allowBots: true }, { SP_ALLOW_BOTS: 'off' }).allowBots, true);
  assert.throws(() => lobbyOptionsFrom({}, { SP_ALLOW_BOTS: 'maybe' }), RangeError);
});

test('live bot policy is broadcast, enforced on WebSocket, and leaves existing bots intact', async (t) => {
  const f = await fixture(t), srv = await f.start(), client = await f.connect(srv);
  assert.equal((await client.waitFor('room.state')).allowBots, true);
  assert.equal((await client.request({ t: 'room.addBot' })).t, 'ok');
  client.clearInbox();
  assert.equal((await f.put(srv, { allowBots: false })).status, 200);
  const disabled = await client.waitFor('room.state', (s) => s.allowBots === false);
  assert.equal(disabled.seats.filter((s) => s?.isBot).length, 1);
  assert.equal((await client.request({ t: 'room.addBot' })).code, 'BOTS_DISABLED');
  assert.equal((await client.request({ t: 'room.removeBot', seat: 1 })).t, 'ok');
  client.clearInbox();
  assert.equal((await f.put(srv, { allowBots: true })).status, 200);
  await client.waitFor('room.state', (s) => s.allowBots === true);
  assert.equal((await client.request({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await client.request({ t: 'room.start' })).t, 'ok');
  const room = [...srv.lobby.rooms.values()][0], match = room.match;
  assert.ok(match);
  assert.equal((await f.put(srv, { allowBots: false })).status, 200);
  assert.equal(room.match, match, 'policy change must not terminate an ongoing match');
  assert.equal(room.seats.filter((s) => s?.isBot).length, 1);
});

test('partial bot configuration persists across restart and concurrent room-limit updates', async (t) => {
  // test-setup turns the per-IP session quota off for the socket fixtures; this test is about what gets written to
  // the file, so it pins the quota on instead of inheriting whatever the harness left in the environment.
  const f = await fixture(t), srv = await f.start({ limitForeignSessions: true });
  const results = await Promise.all([f.put(srv, { maxRooms: 700 }), f.put(srv, { allowBots: false })]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(srv.lobby.opts.maxRooms, 700);
  assert.equal(srv.lobby.opts.allowBots, false);
  // v2 文档（§43.2）：两个并发写各推进一个版本、值合并，lastMutation 记的是后落盘的那一次。
  const saved = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.revision, 3);
  assert.deepEqual(saved.values, { maxRooms: 700, allowBots: false, limitForeignSessions: true, allowForeignConnections: true, maxForeignSessionsPerIp: 1 });
  assert.equal(saved.lastMutation.revision, 3);
  assert.match(saved.lastMutation.opId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(saved.lastMutation.payloadHash.length, 64);
  await srv.close();
  const restored = await f.start();
  assert.equal(restored.lobby.opts.maxRooms, 700);
  assert.equal(restored.lobby.opts.allowBots, false);
  const client = await f.connect(restored);
  assert.equal((await client.request({ t: 'room.addBot' })).code, 'BOTS_DISABLED');
  const override = await f.start({ allowBots: true });
  assert.equal(override.lobby.opts.allowBots, true);
  assert.equal(override.lobby.opts.maxRooms, 700);
});

test('invalid or unauthorized bot configuration never changes policy', async (t) => {
  const f = await fixture(t), srv = await f.start();
  assert.equal((await f.put(srv, { allowBots: false }, 'wrong')).status, 401);
  for (const body of [{}, [], null, { allowBots: 'false' }, { allowBots: 0 }, { allowBots: false, unexpected: 1 }, { maxRooms: 0, allowBots: false }])
    assert.equal((await f.put(srv, body)).status, 400, JSON.stringify(body));
  assert.equal(srv.lobby.opts.allowBots, true);
  assert.equal(await loadRoomConfig(f.state), null);
  await writeFile(f.state, JSON.stringify({ schemaVersion: 1, maxRooms: 321 }));
  assert.deepEqual(await loadRoomConfig(f.state), { maxRooms: 321 });
  const legacy = await f.start();
  assert.equal(legacy.lobby.opts.allowBots, true);
  assert.equal(legacy.lobby.opts.maxRooms, 321);
  // v1 存档在启动时迁成 v2 第 1 版（§43.2）：旧文件不会一直停在「每次启动都被兼容读取」的状态。
  const migrated = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.revision, 1);
  assert.deepEqual(migrated.values, { maxRooms: 321 });
  assert.equal(migrated.lastMutation, null);
});

test('persistence failure does not apply a bot policy change', async (t) => {
  const f = await fixture(t);
  const blocker = path.join(f.dir, 'not-a-directory');
  await writeFile(blocker, 'block');
  const srv = await f.start({ roomAdminStateFile: path.join(blocker, 'state.json') });
  assert.equal((await f.put(srv, { allowBots: false })).status, 503);
  assert.equal(srv.lobby.opts.allowBots, true);
});
