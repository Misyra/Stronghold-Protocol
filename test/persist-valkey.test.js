// Valkey 持久化后端（server/valkeyState.js + server/valkeyClient.js，合并自 Stardust fork 的
// server/persist/valkey.js + store.js）的单测。不依赖真 Redis / Valkey：起一个进程内的最小 RESP2 假服务器
// （真 loopback socket，走真实的客户端连接路径），覆盖——
//   * RESP 编码 / 增量解析（跨 chunk、嵌套数组、-LOADING 错误码）；
//   * 配置与后端选择矩阵（未配置 = file，零行为差异；显式 / 自动选择）；
//   * 读写 / 检查点 / 恢复往返（含 ≥1 KiB 的 deflate 值、缺分片的房间）；
//   * 写序（分片 → index → runtime → 删除）与单键整体写（原子性）；
//   * 连不上 / 坏回复 / -LOADING / 拒密 / 停机后的降级与恢复。
// store 级单测（test/redis-state.test.js 的同路数）；Persister 的 deferLoad 契约与后端无关，由
// test/persist-deferred-load.test.js 覆盖，这里只验证本 store 给出同样的 loadState 面。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { ValkeyError, encodeCommand, ReplyParser, parseValkeyUrl } from '../server/valkeyClient.js';
import { createValkeyStore, resolvePersistBackend, parseValkeyConfig } from '../server/valkeyState.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 轮询直到 fn 为真（失败 / false 都重试）；超时抛错。 */
async function until(fn, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    let ok;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('until: 超时');
    await new Promise((r) => { const t = setTimeout(r, 15); t.unref?.(); });
  }
}

// ---------------------------------------------------------------------------------------------------
// 最小 RESP2 假服务器：PING/AUTH/SELECT/GET/SET/MGET/DEL，其余不认识
// ---------------------------------------------------------------------------------------------------

/** 服务器侧的命令解析：每次 data 喂进来，返回完整的命令数组。 */
function serverParser() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const cmds = [];
    for (;;) {
      if (buf.length < 4 || buf[0] !== 0x2a) break;
      const lineEnd = buf.indexOf('\r\n');
      if (lineEnd < 0) break;
      const n = Number(buf.toString('utf8', 1, lineEnd));
      if (!Number.isInteger(n) || n < 0) { buf = buf.subarray(lineEnd + 2); continue; }
      let pos = lineEnd + 2;
      const args = [];
      let complete = true;
      for (let i = 0; i < n; i++) {
        const lenEnd = buf.indexOf('\r\n', pos);
        if (lenEnd < 0 || buf[pos] !== 0x24) { complete = false; break; }
        const size = Number(buf.toString('utf8', pos + 1, lenEnd));
        if (!Number.isInteger(size) || size < 0 || buf.length < lenEnd + 2 + size + 2) { complete = false; break; }
        args.push(buf.toString('utf8', lenEnd + 2, lenEnd + 2 + size));
        pos = lenEnd + 2 + size + 2;
      }
      if (!complete) break;
      buf = buf.subarray(pos);
      cmds.push(args);
    }
    return cmds;
  };
}

const bulk = (v) => `$${Buffer.byteLength(v)}\r\n${v}\r\n`;

/**
 * 假 Valkey。mode：'ok'（正常应答）| 'garbage'（回一行坏字节）| 'down'（直接断）| 'loading'（先回 N 次
 * -LOADING 再恢复正常，loadingHandshakes 控制次数）。record 收每条命令 {cmd, args} 供写序断言。
 */
function fakeValkey({ password = null } = {}) {
  const data = new Map();
  /** key → the fake clock (ms) at which the key disappears (SET ... EX / EXPIRE). */
  const expiresAt = new Map();
  let clock = 0;
  /** A key is present only while its TTL has not run out; reads expire lazily, as a real store does, */
  const alive = (key) => {
    if (!data.has(key)) return false;
    const at = expiresAt.get(key);
    if (at != null && at <= clock) { data.delete(key); expiresAt.delete(key); return false; }
    return true;
  };
  const record = [];
  const state = { mode: 'ok', loadingHandshakes: 2 };
  const server = net.createServer((socket) => {
    const parse = serverParser();
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      for (const args of parse(chunk)) {
        const [name, ...rest] = args;
        const cmd = String(name).toUpperCase();
        record.push({ cmd, args: [...rest] });
        if (state.mode === 'down') { socket.destroy(); return; }
        if (state.mode === 'garbage') { socket.write('not a reply\r\n'); return; }
        if (state.mode === 'loading') {
          if (cmd === 'AUTH' || cmd === 'PING') {
            if (state.loadingHandshakes > 0) { state.loadingHandshakes--; socket.write('-LOADING Valkey is loading the dataset in memory\r\n'); return; }
            state.mode = 'ok';
          }
        }
        if (cmd === 'PING') { socket.write('+PONG\r\n'); continue; }
        if (cmd === 'AUTH' || cmd === 'SELECT') {
          if (cmd === 'AUTH' && password != null && rest[rest.length - 1] !== password) socket.write('-ERR invalid password\r\n');
          else socket.write('+OK\r\n');
          continue;
        }
        if (cmd === 'GET') {
          const v = alive(rest[0]) ? data.get(rest[0]) : null;
          socket.write(v == null ? '$-1\r\n' : bulk(v));
          continue;
        }
        if (cmd === 'MGET') {
          const parts = [`*${rest.length}\r\n`];
          for (const k of rest) parts.push(alive(k) ? bulk(data.get(k)) : '$-1\r\n');
          socket.write(parts.join(''));
          continue;
        }
        if (cmd === 'SET') {
          data.set(rest[0], rest[1]);
          const ex = rest.findIndex((a) => String(a).toUpperCase() === 'EX');
          if (ex >= 0 && Number.isFinite(Number(rest[ex + 1]))) expiresAt.set(rest[0], clock + Number(rest[ex + 1]) * 1000);
          else expiresAt.delete(rest[0]);
          socket.write('+OK\r\n'); continue;
        }
        if (cmd === 'EXPIRE') {
          const exists = alive(rest[0]);
          if (exists) expiresAt.set(rest[0], clock + Number(rest[1]) * 1000);
          socket.write(`:${exists ? 1 : 0}\r\n`); continue;
        }
        if (cmd === 'DEL') {
          let n = 0;
          for (const k of rest) { expiresAt.delete(k); if (data.delete(k)) n++; }
          socket.write(`:${n}\r\n`); continue;
        }
        socket.write('-ERR unknown command\r\n');
      }
    });
  });
  const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  liveServers.add(server);
  return {
    data, record, state,
    /** Move the fake clock; reads then treat keys past their TTL as absent. */
    advance(ms) { clock += Math.max(0, Number(ms) || 0); },
    async url() { await listening; return `valkey://127.0.0.1:${server.address().port}/0`; },
    close() {
      liveServers.delete(server);
      return new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    },
  };
}

/** 断言失败也不泄漏监听套接字（进程挂住比测试红更糟）。 */
const liveServers = new Set();
after(async () => { for (const s of [...liveServers]) { liveServers.delete(s); await new Promise((resolve) => { s.close(resolve); s.closeAllConnections?.(); }); } });

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

// ---------------------------------------------------------------------------------------------------
// RESP 客户端原语
// ---------------------------------------------------------------------------------------------------

describe('valkeyClient: RESP 编码与解析', () => {
  test('命令编码为 bulk string 数组', () => {
    assert.equal(encodeCommand(['SET', 'k', Buffer.from('v1'), 'EX', 90]).toString(),
      '*5\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\nv1\r\n$2\r\nEX\r\n$2\r\n90\r\n');
  });

  test('回复按任意大小的 chunk 解析；-LOADING 有自己的错误码', () => {
    const wire = Buffer.from('+OK\r\n$5\r\nhello\r\n$-1\r\n:42\r\n-ERR nope\r\n-LOADING Valkey is loading\r\n*2\r\n$1\r\na\r\n*-1\r\n');
    const p = new ReplyParser();
    const out = [];
    for (let i = 0; i < wire.length; i += 3) out.push(...p.feed(wire.subarray(i, i + 3)));
    assert.equal(out[0], 'OK');
    assert.equal(out[1].toString(), 'hello');
    assert.equal(out[2], null);
    assert.equal(out[3], 42);
    assert.equal(out[4].code, 'REPLY');
    assert.equal(out[5].code, 'LOADING');
    assert.equal(out[6][0].toString(), 'a');
    assert.equal(out[6][1], null);
  });

  test('嵌套数组逐字节喂入也能解析', () => {
    const wire = Buffer.from('*3\r\n*2\r\n$1\r\nx\r\n-ERR in\r\n*0\r\n$-1\r\n:7\r\n');
    const p = new ReplyParser(), out = [];
    for (let i = 0; i < wire.length; i++) out.push(...p.feed(wire.subarray(i, i + 1)));
    assert.equal(out.length, 2);
    assert.equal(out[0][0][0].toString(), 'x');
    assert.equal(out[0][0][1].code, 'REPLY');
    assert.deepEqual(out[0][1], []);
    assert.equal(out[0][2], null);
    assert.equal(out[1], 7);
  });

  test('URL 解析：协议、凭据、库号；坏的拒绝', () => {
    assert.deepEqual(parseValkeyUrl('redis://u:p%40ss@10.0.0.5:6380/2'),
      { host: '10.0.0.5', port: 6380, tls: false, username: 'u', password: 'p@ss', db: 2 });
    assert.equal(parseValkeyUrl('valkeys://store.internal').tls, true);
    assert.equal(parseValkeyUrl('valkey://127.0.0.1:6379').port, 6379);
    assert.throws(() => parseValkeyUrl('http://x'), TypeError);
    assert.throws(() => parseValkeyUrl('valkey://x?a=1'), TypeError);
    assert.throws(() => parseValkeyUrl('valkey://x/999'), TypeError);
    assert.ok(new ValkeyError('LOADING') instanceof Error);
  });
});

// ---------------------------------------------------------------------------------------------------
// 配置与后端选择：未配置时必须一切照旧
// ---------------------------------------------------------------------------------------------------

describe('配置与后端选择', () => {
  test('什么都没配：file 后端、createValkeyStore 为 null（零行为差异）', () => {
    assert.equal(resolvePersistBackend({}), 'file');
    assert.equal(createValkeyStore({ env: {}, log: quiet }), null);
    assert.equal(parseValkeyConfig({}), null);
  });

  test('自动选择：SP_VALKEY_URL > SP_REDIS_URL > 文件', () => {
    assert.equal(resolvePersistBackend({ SP_VALKEY_URL: 'valkey://x' }), 'valkey');
    assert.equal(resolvePersistBackend({ SP_REDIS_URL: 'redis://x' }), 'redis');
    assert.equal(resolvePersistBackend({ REDIS_URL: 'redis://x' }), 'redis');
    assert.equal(resolvePersistBackend({ SP_VALKEY_URL: 'valkey://x', SP_REDIS_URL: 'redis://x' }), 'valkey');
  });

  test('SP_PERSIST_BACKEND 显式覆盖自动选择', () => {
    assert.equal(resolvePersistBackend({ SP_PERSIST_BACKEND: 'file', SP_VALKEY_URL: 'valkey://x' }), 'file');
    assert.equal(resolvePersistBackend({ SP_PERSIST_BACKEND: 'VALKEY', SP_REDIS_URL: 'redis://x' }), 'valkey');
    assert.equal(resolvePersistBackend({ SP_PERSIST_BACKEND: 'redis', SP_VALKEY_URL: 'valkey://x' }), 'redis');
    assert.equal(resolvePersistBackend({ SP_PERSIST_BACKEND: 'nonsense', SP_VALKEY_URL: 'valkey://x' }), 'valkey');
  });

  test('parseValkeyConfig：前缀 / TTL / 密码文件 / 超时', () => {
    assert.deepEqual(parseValkeyConfig({ SP_VALKEY_URL: 'valkey://x' }), {
      url: 'valkey://x', prefix: 'stronghold:', ttlSec: 90000, passwordFile: null,
      connectTimeoutMs: undefined, commandTimeoutMs: undefined,
    });
    const cfg = parseValkeyConfig({
      SP_VALKEY_URL: 'valkey://x', SP_VALKEY_PREFIX: 'sp1:', SP_VALKEY_TTL: '3600',
      SP_VALKEY_PASSWORD_FILE: 'E:/tmp/no-such-pass-file', SP_VALKEY_CONNECT_TIMEOUT: '1500', SP_VALKEY_COMMAND_TIMEOUT: '2500',
    });
    assert.equal(cfg.prefix, 'sp1:');
    assert.equal(cfg.ttlSec, 3600);
    assert.equal(cfg.passwordFile, 'E:/tmp/no-such-pass-file');
    assert.equal(cfg.connectTimeoutMs, 1500);
    assert.equal(cfg.commandTimeoutMs, 2500);
    // TTL 下限 60 秒（与 Redis 后端同一规则）
    assert.equal(parseValkeyConfig({ SP_VALKEY_URL: 'valkey://x', SP_VALKEY_TTL: '10' }).ttlSec, 90000);
  });

  test('坏 URL / 读不到的密码文件：createValkeyStore 大声抛错，而不是悄悄退回文件', () => {
    assert.throws(() => createValkeyStore({ env: { SP_VALKEY_URL: 'not a url' }, log: quiet }), TypeError);
    assert.throws(() => createValkeyStore({
      env: { SP_VALKEY_URL: 'valkey://x', SP_VALKEY_PASSWORD_FILE: 'E:/tmp/no-such-pass-file' }, log: quiet,
    }), /ENOENT/);
  });
});

// ---------------------------------------------------------------------------------------------------
// 存储契约：读写 / 检查点 / 恢复往返 / 写序 / 原子性
// ---------------------------------------------------------------------------------------------------

/** 一份最小的状态文档（snapshotServer 的形状），一个 ≥1 KiB 的检查点走 deflate 路径。 */
function sampleDoc() {
  const bigBody = JSON.stringify({ round: 4, log: 'x'.repeat(2048) });
  return {
    index: {
      v: 1, snapshot: 1, savedAt: 1_700_000_000_000,
      sessions: [{ playerId: 'p1', token: 'tok-1', name: '博士', roomCode: 'ROOM1' }],
      rooms: [
        { code: 'ROOM1', matchCount: 2, hasMatch: true },
        { code: 'ROOM2', matchCount: 0, hasMatch: true },
      ],
      clocks: { ROOM1: { deadlineRemainingMs: 25_000, startedAtAgoMs: 5_000 } },
    },
    shards: new Map([
      ['ROOM1', bigBody],
      ['ROOM2', JSON.stringify({ round: 0 })],
    ]),
    metadataVersion: 7,
  };
}

describe('ValkeyStateStore：契约与语义', () => {
  test('saveSharded → load 往返；键空间、写序、单键整体写、TTL、脏跳过', async () => {
    const fake = fakeValkey();
    const store = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url() }, log: quiet });
    const doc = sampleDoc();
    assert.equal(await store.saveSharded(doc), true);

    // 写序：分片先于 index，index 先于 runtime（索引永远晚于它点名的分片）
    const sets = fake.record.filter((r) => r.cmd === 'SET').map((r) => r.args[0]);
    assert.deepEqual(sets, ['stronghold:cp:ROOM1', 'stronghold:cp:ROOM2', 'stronghold:index', 'stronghold:runtime']);

    // 原子性：一个 cp 键就是一个完整可解析的检查点信封（整体写，没有半份可读）——ROOM2 走明文路径
    const envelope = JSON.parse(fake.data.get('stronghold:cp:ROOM2').slice('J:'.length));
    assert.equal(envelope.storage, 1);
    assert.equal(typeof envelope.revision, 'string');
    assert.equal(envelope.matchCount, 0);
    assert.equal(envelope.checkpoint.round, 0);
    // ROOM1 的检查点 ≥1 KiB，走 deflate 标记
    assert.ok(fake.data.get('stronghold:cp:ROOM1').startsWith('Z:'));
    // TTL 随写刷新（SET ... EX 90000）
    const setArgs = fake.record.find((r) => r.cmd === 'SET' && r.args[0] === 'stronghold:index').args;
    assert.deepEqual(setArgs.slice(2), ['EX', '90000']);

    // 脏跳过：同一轮再写，什么键都不碰（放在 load 之前——load 会把 index 脏基线换成盘上的规范化索引，
    // 之后的第一轮写会把 index/runtime 重写一次，这是 redisState.js 继承来的既有行为）
    const writesBefore = store.shardWrites + store.indexWrites + store.runtimeWrites;
    assert.equal(await store.saveSharded(doc), true);
    assert.equal(store.shardWrites + store.indexWrites + store.runtimeWrites, writesBefore);

    // 读回：与写入的形状完全相同（restoreServer 的输入），时钟在 envelope 里
    const back = await store.load();
    assert.equal(store.loadState, 'loaded');
    assert.equal(back.savedAt, 1_700_000_000_000);
    assert.equal(back.sessions[0].playerId, 'p1');
    assert.equal(back.clocks.ROOM1.deadlineRemainingMs, 25_000);
    assert.equal(back.clocks.ROOM1.startedAtAgoMs, 5_000);
    assert.equal(typeof back.clocks.ROOM1.revision, 'string'); // runtime 键随 indexRevision 带来的
    assert.equal(back.matches.ROOM1.log.length, 2048);
    assert.equal(back.matches.ROOM2.round, 0);

    // 重启恢复：另一个实例（新连接）从同一存储读回同一份文档
    const store2 = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url() }, log: quiet });
    const back2 = await store2.load();
    assert.equal(back2.matches.ROOM1.log.length, 2048);
    assert.equal(back2.sessions.length, 1);
    await store2.close();

    // 房间不再被点名：分片在 index 之后才删
    doc.shards.delete('ROOM2');
    doc.index.rooms = doc.index.rooms.filter((r) => r.code !== 'ROOM2');
    doc.metadataVersion = 8;
    const delBefore = fake.record.length;
    assert.equal(await store.saveSharded(doc), true);
    const tail = fake.record.slice(delBefore).map((r) => `${r.cmd} ${r.args.join(' ')}`);
    assert.ok(tail.some((l) => l.startsWith('DEL stronghold:cp:ROOM2')));
    assert.ok(tail.findIndex((l) => l.startsWith('SET stronghold:index')) < tail.findIndex((l) => l.startsWith('DEL ')));
    assert.equal(fake.data.has('stronghold:cp:ROOM2'), false);

    await store.close();
    await fake.close();
  });

  test('unchanged rounds re-arm the TTL of skipped keys: they outlive the original deadline, then expire once flushes stop', async () => {
    const fake = fakeValkey();
    const store = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url(), SP_VALKEY_TTL: '60' }, log: quiet });
    assert.equal(store.ttlSec, 60);
    const doc = sampleDoc();
    assert.equal(await store.saveSharded(doc), true);
    assert.ok(!fake.record.some((r) => r.cmd === 'EXPIRE'), 'a written key already carries its SET EX');

    // 50 s later nothing changed: no value is rewritten, but every skipped key is kept alive
    fake.advance(50_000);
    const writes = store.shardWrites + store.indexWrites + store.runtimeWrites;
    assert.equal(await store.saveSharded(doc), true);
    assert.equal(store.shardWrites + store.indexWrites + store.runtimeWrites, writes, 'unchanged keys are not rewritten');
    const expires = fake.record.filter((r) => r.cmd === 'EXPIRE').map((r) => r.args[0]);
    for (const key of ['stronghold:cp:ROOM1', 'stronghold:cp:ROOM2', 'stronghold:index', 'stronghold:runtime']) {
      assert.ok(expires.includes(key), `${key} keeps its TTL`);
    }

    // 20 s later (past the first write's 60 s) the state is still readable: the process never lost it
    fake.advance(20_000);
    const back = await store.load();
    assert.equal(store.loadState, 'loaded');
    assert.equal(back.matches.ROOM1.log.length, 2048);
    assert.equal(back.sessions.length, 1);

    // the process stops flushing: the last EXPIRE still governs — the keys disappear on their own TTL, not never
    fake.advance(61_000);
    assert.equal(await store.load(), null);
    assert.equal(store.loadState, 'empty');
    await store.close();
    await fake.close();
  });

  test('索引点名的房间缺分片：该房间恢复时没有检查点，其余照常', async () => {
    const fake = fakeValkey();
    const store = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url() }, log: quiet });
    const doc = sampleDoc();
    await store.saveSharded(doc);
    // 模拟分片键丢失（例如被外部删除 / TTL 过期）：index 还点着 ROOM1
    fake.data.delete('stronghold:cp:ROOM1');
    const back = await store.load();
    assert.equal(store.loadState, 'loaded');
    assert.equal(back.matches.ROOM1, undefined);
    assert.equal(back.matches.ROOM2.round, 0);
    await store.close();
    await fake.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// 降级语义：连不上 / 坏回复 / -LOADING / 拒密
// ---------------------------------------------------------------------------------------------------

describe('ValkeyStateStore：降级与恢复', () => {
  test('连接失败：命令立即失败（不排队），load/save 不抛错，loadState 与 deferLoad 契约对齐', async () => {
    // 一个先开再关的端口：连接被拒
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `valkey://127.0.0.1:${server.address().port}`;
    await new Promise((resolve) => server.close(resolve));

    const store = createValkeyStore({ env: { SP_VALKEY_URL: url }, log: quiet });
    store.client.backoffMs = 10; // 测试提速：退避从 10ms 起步
    const back = await store.load({ attempts: 2, retryMs: 10 });
    assert.equal(back, null);
    assert.equal(store.loadState, 'unavailable'); // index.js 据此 persister.deferLoad()
    assert.equal(await store.saveSharded(sampleDoc()), false); // 不抛错，本轮记失败
    assert.ok(store.failures > 0);
    await store.close();
  });

  test('坏回复：那一次读失败，连接被丢弃，之后恢复正常', async () => {
    const fake = fakeValkey();
    const store = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url() }, log: quiet });
    store.client.backoffMs = 10;
    fake.state.mode = 'garbage';
    assert.equal(await store.load({ attempts: 1 }), null);
    assert.equal(store.loadState, 'unavailable');
    // 存储恢复应答：等过客户端退避（≈20 ms），下一轮原样读回（空存储 = 全新开始）
    fake.state.mode = 'ok';
    await sleep(60);
    assert.equal(await store.load({ attempts: 1 }), null);
    assert.equal(store.loadState, 'empty');
    assert.equal(await store.saveSharded(sampleDoc()), true);
    const back = await store.load({ attempts: 1 });
    assert.equal(back.matches.ROOM2.round, 0);
    await store.close();
    await fake.close();
  });

  test('-LOADING：握手被拒后自动重连（TRANSIENT），加载完成后照常读写', async () => {
    const fake = fakeValkey();
    fake.state.mode = 'loading';
    fake.state.loadingHandshakes = 2;
    const store = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url() }, log: quiet });
    store.client.backoffMs = 10;
    // 前两次握手被 -LOADING 拒绝，之后存储恢复正常——saveSharded 轮询直到它成功
    await until(() => store.saveSharded(sampleDoc()));
    // 启动读场景：存储又进入 LOADING，load 的重试循环等它过去
    fake.state.mode = 'loading';
    fake.state.loadingHandshakes = 2;
    const back = await store.load({ attempts: 40, retryMs: 20 });
    assert.equal(store.loadState, 'loaded');
    assert.equal(back.matches.ROOM2.round, 0);
    await store.close();
    await fake.close();
  });

  test('拒密（AUTH 失败）：不抛错，load 为 unavailable', async () => {
    const fake = fakeValkey({ password: 'sekret' });
    const store = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url() }, log: quiet });
    store.client.backoffMs = 10;
    store.client.target.password = 'wrong'; // 密码通常来自 SP_VALKEY_PASSWORD_FILE（server/valkeyState.js 读入）
    const back = await store.load({ attempts: 2, retryMs: 10 });
    assert.equal(back, null);
    assert.equal(store.loadState, 'unavailable');
    await store.close();
    await fake.close();
  });

  test('服务器停机：在途命令失败、客户端退避，重启后新的命令照常', async () => {
    const fake = fakeValkey();
    const store = createValkeyStore({ env: { SP_VALKEY_URL: await fake.url() }, log: quiet });
    store.client.backoffMs = 10;
    assert.equal(await store.saveSharded(sampleDoc()), true);
    fake.state.mode = 'down';
    // 同一份文档会被脏检查整体跳过（一条命令都不发），换一个元数据版本逼一次真实的写尝试
    const changed = { ...sampleDoc(), metadataVersion: 9 };
    assert.equal(await store.saveSharded(changed), false);
    assert.equal(await store.load({ attempts: 1 }), null);
    fake.state.mode = 'ok';
    const back = await store.load({ attempts: 40, retryMs: 20 });
    assert.equal(store.loadState, 'loaded');
    assert.equal(back.matches.ROOM1.log.length, 2048);
    await store.close();
    await fake.close();
  });
});
