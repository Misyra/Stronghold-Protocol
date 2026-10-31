// test/redis-state.test.js — Redis 持久化在本仓库的接缝（server/redis.js 取自 xinhai-ai/Stronghold-Protocol，
// server/redisState.js 把它套进 Persister 的存储契约）。真实 Redis 的端到端用例仍按仓库惯例 opt-in：没有
// SP_TEST_REDIS_URL 时这里只验证配置、选择逻辑、键布局、写入顺序与失效退让，不依赖外部服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRedisConfig, StateStore } from '../server/redis.js';
import { RedisStateStore, createRedisStore, encodeValue, decodeValue, DEFLATE_MIN, REDIS_LAYOUT } from '../server/redisState.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { snapshotServer, restoreServer, PERSIST_VERSION } from '../server/persist.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A store whose four primitives answer from a Map — the shape server/redis.js gives the subclass. */
function fakeRedis(prefix = 'test:') {
  const store = new RedisStateStore({ url: 'redis://127.0.0.1:6379/9', prefix, log: quietLog });
  const data = new Map();
  const writes = [];
  const deletes = [];
  store.getKey = async (key) => (data.has(key) ? data.get(key) : null);
  store.getKeys = async (keys) => [...keys].map((key) => (data.has(key) ? data.get(key) : null));
  store.setKey = async (key, value) => { writes.push(key); if (store.failWrites) return false; data.set(key, value); return true; };
  store.delKeys = async (keys) => { for (const key of [].concat(keys)) { deletes.push(key); data.delete(key); } return true; };
  return { store, data, writes, deletes };
}

const roomIndex = (extra = {}) => ({
  v: PERSIST_VERSION, snapshot: 1, savedAt: 1_700_000_000_000,
  sessions: [], rooms: [{ code: 'AB12', matchCount: 1, hasMatch: true }],
  clocks: { AB12: { phaseEndsAt: 5 } }, ...extra,
});

test('parseRedisConfig: 没有 URL 就是关掉，URL 不合法也关掉', () => {
  assert.equal(parseRedisConfig({}), null);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: '   ' }), null);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: 'http://127.0.0.1:6379' }), null);
  const cfg = parseRedisConfig({ REDIS_URL: 'redis://127.0.0.1:6379/3' });
  assert.equal(cfg.url, 'redis://127.0.0.1:6379/3');
  assert.equal(cfg.prefix, 'stronghold:');
  assert.equal(cfg.ttlSec, 90_000);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: 'rediss://h:6380', SP_REDIS_PREFIX: 'sp:', SP_REDIS_TTL: '120' }).ttlSec, 120);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: 'redis://h', SP_REDIS_TTL: '30' }).ttlSec, 90_000, '低于 60 s 的 TTL 被拒绝');
});

test('createRedisStore: 无 URL 返回 null，有 URL 返回多键存储，键名从前缀派生', () => {
  assert.equal(createRedisStore({ env: {}, log: quietLog }), null);
  const store = createRedisStore({ env: { SP_REDIS_URL: 'redis://127.0.0.1:6379/9', SP_REDIS_PREFIX: 'test:' }, log: quietLog });
  assert.ok(store instanceof RedisStateStore);
  assert.ok(store instanceof StateStore);
  assert.equal(store.kind, 'redis');
  assert.equal(store.mode, 'keys');
  assert.equal(store.layout, REDIS_LAYOUT);
  assert.equal(store.key, 'test:state', '旧版单键的名字仍然是回滚/升级的入口');
  assert.equal(store.indexKey, 'test:index');
  assert.equal(store.runtimeKey, 'test:runtime');
  assert.equal(store.cpKey('AB12'), 'test:cp:AB12');
  assert.equal(store.label, 'redis://127.0.0.1:6379/9');
});

test('saveSharded 写成 index / runtime / cp:<code> 三个键，load 原样读回', async () => {
  const { store, data } = fakeRedis();
  const body = JSON.stringify({ v: 1, round: 2, phase: 'PREP' });
  assert.equal(await store.saveSharded({ index: roomIndex(), shards: new Map([['AB12', body]]), metadataVersion: 1 }), true);
  assert.deepEqual([...data.keys()].sort(), ['test:cp:AB12', 'test:index', 'test:runtime']);

  const second = new RedisStateStore({ url: 'redis://127.0.0.1:6379/9', prefix: 'test:', log: quietLog });
  second.getKey = store.getKey;
  second.getKeys = store.getKeys;
  const doc = await second.load({ attempts: 1 });
  assert.equal(second.loadState, 'loaded');
  assert.equal(doc.v, PERSIST_VERSION);
  assert.deepEqual(doc.matches.AB12, { v: 1, round: 2, phase: 'PREP' }, '信封里的 checkpoint 被拆出来');
  assert.equal(doc.clocks.AB12.phaseEndsAt, 5, '时钟从 runtime 键回来');
  assert.equal(typeof doc.clocks.AB12.revision, 'string', '时钟带着它描述的那份分片版本');
  assert.equal(doc.savedAt, 1_700_000_000_000);
});

test('元数据没变就不重写 index；分片文本没变就不重写分片', async () => {
  const { store, writes } = fakeRedis();
  const index = roomIndex();
  const shards = new Map([['AB12', JSON.stringify({ v: 1, round: 2 })]]);
  assert.equal(await store.saveSharded({ index, shards, metadataVersion: 7 }), true);
  const first = writes.length;
  assert.deepEqual(writes, ['test:cp:AB12', 'test:index', 'test:runtime'], '先分片、再索引、最后时钟');

  // 同一份元数据版本、同一份分片文本：只剩 runtime 需要走一次（时钟每轮都在动）
  writes.length = 0;
  assert.equal(await store.saveSharded({ index, shards, metadataVersion: 7 }), true);
  assert.deepEqual(writes, [], '内容一个字都没变时一个键都不写');

  // 时钟换了，分片和索引照样不动
  writes.length = 0;
  const ticked = { ...index, clocks: { AB12: { phaseEndsAt: 9 } } };
  assert.equal(await store.saveSharded({ index: ticked, shards, metadataVersion: 7 }), true);
  assert.deepEqual(writes, ['test:runtime'], '倒计时只刷 runtime 一个键');

  // 新的一轮：分片变了，索引也跟着提交
  writes.length = 0;
  const next = new Map([['AB12', JSON.stringify({ v: 1, round: 3 })]]);
  assert.equal(await store.saveSharded({ index: { ...ticked, rooms: [{ code: 'AB12', matchCount: 1, hasMatch: true }] }, shards: next, metadataVersion: 8 }), true);
  assert.deepEqual(writes, ['test:cp:AB12', 'test:index', 'test:runtime']);
  assert.ok(first > 0);
});

test('分片写失败就不提交索引：索引永远不点名一个没落地的分片', async () => {
  const { store, data } = fakeRedis();
  store.failWrites = true;
  const index = roomIndex();
  assert.equal(await store.saveSharded({ index, shards: new Map([['AB12', JSON.stringify({ v: 1 })]]), metadataVersion: 1 }), false);
  assert.equal(data.size, 0, '一个键都没写');
  store.failWrites = false;
  assert.equal(await store.saveSharded({ index, shards: new Map([['AB12', JSON.stringify({ v: 1 })]]), metadataVersion: 1 }), true);
  assert.deepEqual([...data.keys()].sort(), ['test:cp:AB12', 'test:index', 'test:runtime']);
});

test('不再被点名的分片在索引提交之后才删除', async () => {
  const { store, data, writes, deletes } = fakeRedis();
  const index = roomIndex({ rooms: [{ code: 'AB12', matchCount: 1, hasMatch: true }, { code: 'CD34', matchCount: 1, hasMatch: true }] });
  const both = new Map([['AB12', JSON.stringify({ v: 1 })], ['CD34', JSON.stringify({ v: 2 })]]);
  assert.equal(await store.saveSharded({ index, shards: both, metadataVersion: 1 }), true);
  assert.ok(data.has('test:cp:CD34'));

  writes.length = 0;
  const closed = { ...index, rooms: [{ code: 'AB12', matchCount: 1, hasMatch: true }] };
  assert.equal(await store.saveSharded({ index: closed, shards: new Map([['AB12', JSON.stringify({ v: 1 })]]), metadataVersion: 2 }), true);
  assert.deepEqual(deletes, ['test:cp:CD34']);
  assert.equal(data.has('test:cp:CD34'), false);
  assert.equal(data.has('test:cp:AB12'), true);
  assert.ok(writes.indexOf('test:index') >= 0, '索引先提交');
});

test('一个坏分片只丢那个房间，restoreServer 照样起来', async () => {
  const { store, data } = fakeRedis();
  const index = roomIndex({ rooms: [{ code: 'GOOD', matchCount: 1, hasMatch: true }, { code: 'BAD', matchCount: 1, hasMatch: true }] });
  const shards = new Map([['GOOD', JSON.stringify({ v: 1 })], ['BAD', '{not json']]);
  assert.equal(await store.saveSharded({ index, shards, metadataVersion: 1 }), true);
  // 手工把一个键写坏（真实场景：半截写入 / 被别的程序覆盖）
  data.set('test:cp:BAD', 'J:{not json');
  const doc = await store.load({ attempts: 1 });
  assert.equal(store.loadState, 'loaded');
  assert.ok(doc.matches.GOOD, '好房间还在');
  assert.equal('BAD' in doc.matches, false, '坏分片被跳过，没有变成垃圾数据');
});

test('旧的单键 state 文档会被读一次，之后按新布局写', async () => {
  const { store, data, writes } = fakeRedis();
  const legacy = { v: PERSIST_VERSION, snapshot: 1, savedAt: 42, sessions: [], rooms: [], matches: {}, clocks: {} };
  data.set('test:state', 'J:' + JSON.stringify(legacy));
  const doc = await store.load({ attempts: 1 });
  assert.equal(store.loadState, 'loaded');
  assert.equal(doc.savedAt, 42);
  writes.length = 0;
  assert.equal(await store.saveSharded({ index: roomIndex(), shards: new Map([['AB12', JSON.stringify({ v: 1 })]]), metadataVersion: 1 }), true);
  assert.deepEqual(writes, ['test:cp:AB12', 'test:index', 'test:runtime'], '升级后的第一轮按新布局整份写');
  assert.ok(data.has('test:state'), '旧键保留做回滚副本');
});

test('大检查点压缩存，小值明文存，读回来一个字都不差', async () => {
  const big = { v: 1, blob: 'x'.repeat(DEFLATE_MIN * 8) };
  const packed = await encodeValue(JSON.stringify(big));
  assert.equal(packed[0], 'Z', '超过阈值就走 deflate + base64');
  assert.deepEqual(JSON.parse(await decodeValue(packed)), big);
  const small = await encodeValue('{"a":1}');
  assert.equal(small, 'J:{"a":1}', '小值不压，省一次 CPU');
  assert.equal(await decodeValue('{"plain":true}'), '{"plain":true}', '没有标记的值原样返回（旧版文档 / 外来键）');
  assert.notEqual(Buffer.byteLength(packed), Buffer.byteLength(JSON.stringify(big)));
});

test('连不上 Redis 时退让：load 返回 null、save 返回 false，都不抛', async () => {
  const store = new RedisStateStore({ url: 'redis://127.0.0.1:1', log: quietLog, connectTimeoutMs: 60, commandTimeoutMs: 60 });
  assert.equal(await store.load({ attempts: 1, retryMs: 1 }), null);
  assert.equal(store.loadState, 'unavailable');
  assert.equal(await store.save({ v: 1 }), false);
  assert.equal(await store.saveSharded({ index: roomIndex(), shards: new Map([['AB12', JSON.stringify({ v: 1 })]]), metadataVersion: 1 }), false);
  await store.close();
});

test('loadState 四态：empty / invalid 与 loaded / unavailable 分开', async () => {
  const empty = fakeRedis();
  assert.equal(await empty.store.load({ attempts: 1 }), null);
  assert.equal(empty.store.loadState, 'empty');

  const invalid = fakeRedis();
  invalid.data.set('test:index', 'J:{"layout":99,"revision":"r"}');
  assert.equal(await invalid.store.load({ attempts: 1 }), null);
  assert.equal(invalid.store.loadState, 'invalid', '布局不兼容时拒绝，不覆盖');

  const broken = fakeRedis();
  broken.data.set('test:index', 'J:not json');
  assert.equal(await broken.store.load({ attempts: 1 }), null);
  assert.equal(broken.store.loadState, 'invalid');
});

test('整份文档的旧 API（save → load → restoreServer）在这一层也成立', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const now = Date.now();
  assert.ok(registry.adopt({ playerId: 'p-redis-1', token: 'tok-redis-1', name: '量子博士' }));

  const { store, data } = fakeRedis();
  const meta = snapshotServer({ registry, lobby, now });
  assert.equal(await store.save({ ...meta, clocks: {}, matches: {} }), true);

  const second = new RedisStateStore({ url: 'redis://127.0.0.1:6379/9', prefix: 'test:', log: quietLog });
  second.getKey = store.getKey;
  second.getKeys = store.getKeys;
  const doc = await second.load({ attempts: 1 });
  assert.equal(doc.v, PERSIST_VERSION, '版本字段跟着 index 走');
  assert.equal(doc.sessions.length, 1);

  const registry2 = new SessionRegistry();
  const lobby2 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const stats = restoreServer({ doc, registry: registry2, lobby: lobby2, now });
  assert.equal(stats.ok, true, JSON.stringify(stats));
  assert.equal(stats.sessions, 1);
  assert.ok([...registry2.all()].some((x) => x.token === 'tok-redis-1'), '会话回来了');
  assert.ok(data.has('test:index'));
});

test('clear 把这一前缀下的所有键删掉（含旧版单键）', async () => {
  const { store, data } = fakeRedis();
  await store.saveSharded({ index: roomIndex(), shards: new Map([['AB12', JSON.stringify({ v: 1 })]]), metadataVersion: 1 });
  data.set('test:state', 'J:{}');
  assert.equal(await store.clear(), true);
  assert.deepEqual([...data.keys()], []);
  assert.equal(store.loadState, 'empty');
});
