// test/redis-state.test.js — Redis 持久化在本仓库的接缝（server/redis.js 取自 xinhai-ai/Stronghold-Protocol，
// server/redisState.js 把它套进 Persister 的存储契约）。真实 Redis 的端到端用例仍按仓库惯例 opt-in：没有
// SP_TEST_REDIS_URL 时这里只验证配置、选择逻辑、文档形状与失效退让，不依赖外部服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRedisConfig, StateStore } from '../server/redis.js';
import { RedisStateStore, createRedisStore } from '../server/redisState.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { snapshotServer, restoreServer, PERSIST_VERSION } from '../server/persist.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

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

test('createRedisStore: 无 URL 返回 null（行为与以前完全一致），有 URL 返回 redis 存储', () => {
  assert.equal(createRedisStore({ env: {}, log: quietLog }), null);
  const store = createRedisStore({ env: { SP_REDIS_URL: 'redis://127.0.0.1:6379/9', SP_REDIS_PREFIX: 'test:' }, log: quietLog });
  assert.ok(store instanceof RedisStateStore);
  assert.ok(store instanceof StateStore);
  assert.equal(store.kind, 'redis');
  assert.equal(store.key, 'test:state');
  assert.equal(store.label, 'redis://127.0.0.1:6379/9');
});

test('saveSharded 合并成一份回版文档，restoreServer 能原样读回', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const now = Date.now();
  const s = registry.adopt({ playerId: 'p-redis-1', token: 'tok-redis-1', name: '量子博士' });
  assert.ok(s);

  const store = new RedisStateStore({ url: 'redis://127.0.0.1:6379/9', log: quietLog });
  let captured = null;
  store.save = async (doc) => { captured = JSON.parse(JSON.stringify(doc)); return true; };  // 不连真 Redis

  const meta = snapshotServer({ registry, lobby, now });
  const shards = new Map([['AB12', JSON.stringify({ v: 1, round: 2, phase: 'PREP' })]]);
  assert.equal(await store.saveSharded({ index: { ...meta, clocks: {} }, shards, metadataVersion: 1 }), true);

  assert.ok(captured, '写入了文档');
  assert.equal(captured.v, PERSIST_VERSION, '版本字段跟着 index 走');
  assert.equal(captured.sessions.length, 1);
  assert.deepEqual(captured.matches.AB12, { v: 1, round: 2, phase: 'PREP' }, '分片文本被解析回对象');

  const registry2 = new SessionRegistry();
  const lobby2 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const stats = restoreServer({ doc: captured, registry: registry2, lobby: lobby2, now });
  assert.equal(stats.ok, true, JSON.stringify(stats));
  assert.equal(stats.sessions, 1);
  assert.ok([...registry2.all()].some((x) => x.token === 'tok-redis-1'), '会话回来了');
});

test('一个坏分片只丢那个房间，不拖垮整份文档', async () => {
  const store = new RedisStateStore({ url: 'redis://127.0.0.1:6379/9', log: quietLog });
  let captured = null;
  store.save = async (doc) => { captured = doc; return true; };
  const shards = new Map([['GOOD', JSON.stringify({ v: 1 })], ['BAD', '{not json']]);
  assert.equal(await store.saveSharded({ index: { v: PERSIST_VERSION, sessions: [], rooms: [], savedAt: Date.now() }, shards }), true);
  assert.deepEqual(Object.keys(captured.matches), ['GOOD']);
});

test('连不上 Redis 时退让：load 返回 null、save 返回 false，都不抛', async () => {
  const store = new RedisStateStore({ url: 'redis://127.0.0.1:1', log: quietLog, connectTimeoutMs: 60, commandTimeoutMs: 60 });
  assert.equal(await store.load({ attempts: 1, retryMs: 1 }), null);
  assert.equal(await store.save({ a: 1 }), false);
  await store.close();
});
