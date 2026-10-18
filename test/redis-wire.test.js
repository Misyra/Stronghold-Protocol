// Redis 持久化的真实线协议集成：起一个最小的 RESP 服务器，让 server/redis.js 里真正的 redis 客户端连上去，
// 走完整的 connect → SET/GET/MGET/DEL → 重连失败路径。store 的单测（test/redis-state.test.js）用的是假 store，
// 这里测的是「线上会连的那条路」。

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createRedisStore } from '../server/redisState.js';

/** One minimalist RESP2 server: PING/CLIENT/COMMAND/GET/SET/DEL/MSET/MGET and nothing else. */
function fakeRedis() {
  const store = new Map();
  const commands = [];
  const ttl = new Map();
  let mode = 'ok';
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseCommand(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.size);
        commands.push(parsed.args);
        if (mode === 'down') { socket.destroy(); return; }
        const [name, ...args] = parsed.args;
        const cmd = String(name || '').toUpperCase();
        if (cmd === 'HELLO') {
          // node-redis 6 先发 HELLO 3：回一张 RESP3 map，之后所有回复都按 RESP3（空值用 _）
          socket.write('%3\r\n$5\r\nproto\r\n:3\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n');
          continue;
        }
        if (cmd === 'PING') { socket.write('+PONG\r\n'); continue; }
        if (cmd === 'CLIENT' || cmd === 'SELECT' || cmd === 'AUTH') { socket.write('+OK\r\n'); continue; }
        if (cmd === 'COMMAND') { socket.write('*0\r\n'); continue; }
        if (cmd === 'GET') {
          const value = store.get(args[0]);
          socket.write(value == null ? '_\r\n' : bulk(value));
          continue;
        }
        if (cmd === 'SET') {
          store.set(args[0], args[1]);
          const ex = String(args[2] || '').toUpperCase() === 'EX' ? Number(args[3]) : null;
          if (ex) ttl.set(args[0], ex); else ttl.delete(args[0]);
          socket.write('+OK\r\n');
          continue;
        }
        if (cmd === 'MGET') {
          let out = '*' + args.length + '\r\n';
          for (const key of args) { const value = store.get(key); out += value == null ? '_\r\n' : bulk(value); }
          socket.write(out);
          continue;
        }
        if (cmd === 'DEL') {
          let n = 0;
          for (const key of args) if (store.delete(key)) n++;
          socket.write(':' + n + '\r\n');
          continue;
        }
        socket.write('-ERR unknown command ' + cmd + '\r\n');
      }
    });
  });
  return {
    store, commands, ttl,
    get mode() { return mode; },
    set mode(v) {
      mode = v;
      if (v === 'down') { for (const s of clients) s.destroy(); clients.clear(); }
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { for (const s of clients) s.destroy(); server.close(() => resolve()); }),
  };
}

const bulk = (text) => '$' + Buffer.byteLength(text) + '\r\n' + text + '\r\n';

/** Parse one RESP array command; null when the buffer does not hold a whole one yet. */
function parseCommand(buffer) {
  if (buffer[0] !== 0x2a) return null;                  // '*'
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd < 0) return null;
  const count = Number(buffer.subarray(1, lineEnd).toString());
  let offset = lineEnd + 2;
  const args = [];
  for (let i = 0; i < count; i++) {
    if (buffer[offset] !== 0x24) return null;           // '$'
    const end = buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    const length = Number(buffer.subarray(offset + 1, end).toString());
    const start = end + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.subarray(start, start + length).toString());
    offset = start + length + 2;
  }
  return { args, size: offset };
}

const env = (port, extra = {}) => ({ SP_REDIS_URL: 'redis://127.0.0.1:' + port, SP_REDIS_PREFIX: 'test:', SP_REDIS_TTL: '60',
  SP_REDIS_CONNECT_TIMEOUT: '2000', SP_REDIS_COMMAND_TIMEOUT: '2000', ...extra });

describe('Redis 线协议', () => {
  const servers = [];
  const stores = [];
  const makeStore = (port) => {
    const store = createRedisStore({ env: env(port), log: { info() {}, warn() {}, error() {} } });
    stores.push(store);
    return store;
  };
  after(async () => {
    // 打开的 redis 客户端连接会让测试进程不退出：先关 store，再关假服务器
    for (const s of stores) { try { await s.close?.(); } catch { /* ignore */ } }
    for (const s of servers) await s.close();
  });

  test('save → 新实例 load 读回同一份文档；index 与 runtime 各一个键，TTL 都带上', async () => {
    const redis = fakeRedis(); servers.push(redis);
    const port = await redis.listen();
    const store = makeStore(port);
    const doc = { v: 3, snapshot: 1, savedAt: 1, sessions: [{ playerId: 'p' }], rooms: [], matches: {}, clocks: {} };
    assert.equal(await store.save(doc), true);
    const sets = redis.commands.filter((c) => String(c[0]).toUpperCase() === 'SET');
    const keys = sets.map((c) => c[1]).sort();
    assert.deepEqual(keys, ['test:index', 'test:runtime'], '整份文档被拆成索引与时钟两个键');
    for (const cmd of sets) {
      assert.equal(String(cmd[3]).toUpperCase(), 'EX', '每个键都带 TTL：' + cmd[1]);
      assert.equal(Number(cmd[4]), 60, 'the configured TTL is applied on every write');
    }

    const second = makeStore(port);
    const loaded = await second.load();
    assert.equal(loaded.v, 3);
    assert.deepEqual(loaded.sessions, [{ playerId: 'p' }]);
    assert.deepEqual(loaded.matches, {});
    assert.equal(second.loadState, 'loaded');
    assert.equal(await second.clear(), true, 'clear deletes every key of the prefix');
    assert.deepEqual([...redis.store.keys()], []);
  });

  test('saveSharded 一房一个键：只写变了的那一份，坏的那份读回时被跳过', async () => {
    const redis = fakeRedis(); servers.push(redis);
    const port = await redis.listen();
    const store = makeStore(port);
    const rooms = [{ code: 'R1', matchCount: 1, hasMatch: true }, { code: 'R2', matchCount: 1, hasMatch: true }];
    const index = { v: 3, savedAt: 2, sessions: [], rooms, clocks: { R1: { deadlineRemainingMs: 5 } } };
    const shards = new Map([['R1', JSON.stringify({ v: 1, phase: 'PREP', players: [] })], ['R2', '{broken']]);
    assert.equal(await store.saveSharded({ index, shards, metadataVersion: 1 }), true);
    const setKeys = redis.commands.filter((c) => String(c[0]).toUpperCase() === 'SET').map((c) => c[1]).sort();
    assert.deepEqual(setKeys, ['test:cp:R1', 'test:cp:R2', 'test:index', 'test:runtime']);
    assert.ok(Number(redis.ttl.get('test:cp:R1')) === 60, '检查点的键也带 TTL');

    // 同一份输入再来一轮：一个 SET 都不发（时钟没动、分片正文没变、元数据版本没变）
    redis.commands.length = 0;
    assert.equal(await store.saveSharded({ index, shards, metadataVersion: 1 }), true);
    assert.equal(redis.commands.filter((c) => String(c[0]).toUpperCase() === 'SET').length, 0);

    const loaded = await store.load({ attempts: 1 });
    assert.equal(loaded.matches.R1.phase, 'PREP');
    assert.equal('R2' in loaded.matches, false, 'a broken shard is skipped, never written as garbage');
    assert.equal(loaded.clocks.R1.deadlineRemainingMs, 5);
  });

  test('Redis 挂了：load 返回 null 且 loadState=unavailable，save 返回 false 而不是抛', async () => {
    const redis = fakeRedis(); servers.push(redis);
    const port = await redis.listen();
    const store = makeStore(port);
    assert.equal(await store.save({ v: 3 }), true);
    redis.mode = 'down';
    assert.equal(await store.load({ attempts: 1 }), null);
    assert.equal(store.loadState, 'unavailable');
    assert.equal(await store.save({ v: 3, savedAt: 3 }), false, 'a failed write never throws');
    redis.mode = 'ok';
    const back = await store.load({ attempts: 2 });
    assert.equal(back.v, 3, 'and the original document is still there once Redis answers again');
    assert.equal(store.loadState, 'loaded');
  });
});
