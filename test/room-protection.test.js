// test/room-protection.test.js — per-network room-action budgets (server/roomProtection.js, 合并自用户分支; the
// fork's test of the same name was mostly its own extra domains — scheduler, snapshots, worker pools, room admin —
// that are not part of this merge; only the limiter's own halves are taken).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomActionLimiter } from '../server/roomProtection.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

test('denial counters retain suppressed requests and sample independently per network/action', () => {
  let now = 0;
  const limiter = new RoomActionLimiter({ now: () => now, createRefillMs: 3600000 });
  limiter.take('a', 'create');
  limiter.take('b', 'create');
  assert.equal(limiter.denied('a', 'create'), 0);
  assert.equal(limiter.denied('a', 'create'), null);
  assert.equal(limiter.denied('b', 'create'), 0);
  assert.equal(limiter.denied('a', 'start'), 0);
  now = 10000;
  assert.equal(limiter.denied('a', 'create'), 1);
  assert.equal(limiter.stats().createDenied, 4);
  assert.equal(limiter.idleMs, 4 * 3600000);
});

test('network action budgets survive session churn, refill independently and bound memory', () => {
  let now = 0;
  const limiter = new RoomActionLimiter({ now: () => now, maxKeys: 2 });
  for (let i = 0; i < 4; i++) assert.equal(limiter.take('a', 'create'), true);
  assert.equal(limiter.take('a', 'create'), false);
  assert.equal(limiter.take('a', 'start'), true);
  assert.equal(limiter.take('b', 'create'), true);
  assert.equal(limiter.take('c', 'create'), false);
  now = 15000;
  assert.equal(limiter.take('a', 'create'), true);
  assert.equal(limiter.take('a', 'create'), false);
  now = 400000;
  assert.equal(limiter.take('c', 'create'), true);
  assert.ok(limiter.buckets.size <= 2);
});

test('room action limits must be positive integers', () => {
  for (const bad of [{ createBurst: 0 }, { startRefillMs: -1 }, { maxKeys: 1.5 }]) {
    assert.throws(() => new RoomActionLimiter(bad), RangeError);
  }
  assert.equal(new RoomActionLimiter({ createBurst: 2 }).createBurst, 2);
});

test('new identities on the same IP cannot reset the room creation budget', async (t) => {
  const logs = [], clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', roomCreateBurst: 1, roomCreateRefillMs: 3600000,
    log: { info: (line) => logs.push(line), warn() {}, error() {}, debug() {} } });
  t.after(async () => { for (const client of clients) await client.close(); await srv.close(); });
  const create = async (ip, name) => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { headers: { 'X-Real-IP': ip } } });
    clients.push(client);
    await client.hello(name);
    return client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  };
  assert.equal((await create('198.51.100.42', 'first')).t, 'ok');
  assert.equal((await create('198.51.100.42', 'second')).code, 'RATE');
  assert.equal((await create('198.51.100.43', 'third')).t, 'ok');
  const denied = logs.filter((line) => line.startsWith('[audit] ')).map((line) => JSON.parse(line.slice(8)))
    .find((entry) => entry.action === 'room.create.denied');
  assert.equal(denied.ip, '198.51.100.42');
  assert.equal(denied.name, 'second');
  assert.equal(denied.reason, 'action_budget');
  assert.equal(srv.lobby.roomActions.stats().createDenied, 1);
});
