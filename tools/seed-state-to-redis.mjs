#!/usr/bin/env node
/**
 * 把文件后端存档一次性灌进 Redis（切库用，只在应用停止时跑一次）。
 *
 * 为什么这样写：server/redisState.js 的键布局一比一照搬 server/stateFile.js 的目录布局，
 * 两个后端 load() 拿到的 doc 形状完全相同，所以直接把 FileStateStore.load() 的返回值
 * 交给 RedisStateStore.save(doc) 就行 —— 不用在这里重新实现一遍编码。
 *
 * 用法（stronghold 已 stop）：
 *   SP_REDIS_URL=redis://127.0.0.1:6379/0 SP_REDIS_PREFIX=stronghold \
 *   SP_STATE_FILE=/var/lib/stronghold/game \
 *     node tools/seed-state-to-redis.mjs
 *
 * 退出码：0 成功（或 Redis 里已有内容、无需覆盖）；2 没有文件存档；3 没有 Redis 配置；1 其他错误。
 */

import { FileStateStore } from '../server/stateFile.js';
import { createRedisStore } from '../server/redisState.js';

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

const file = process.env.SP_STATE_FILE || '/var/lib/stronghold/game';

const redisStore = createRedisStore({ env: process.env, log });
if (!redisStore) {
  console.error('[seed] 没有 SP_REDIS_URL / REDIS_URL：不迁移，保持文件后端');
  process.exit(3);
}

const summary = (doc) => {
  if (!doc || typeof doc !== 'object') return 'empty';
  const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);
  return `sessions=${count(doc.sessions)} rooms=${count(doc.rooms)} matches=${count(doc.matches)}`;
};

const existing = await redisStore.load().catch((err) => {
  log.warn(`[seed] Redis 现有内容读取失败：${err?.message ?? err}`);
  return null;
});
if (existing) {
  console.log(`[seed] Redis 里已经有状态（${summary(existing)}），不做覆盖。要重灌先手动清库。`);
  await redisStore.close?.();
  process.exit(0);
}

const fileStore = new FileStateStore({ file, log });
let doc;
try {
  doc = await fileStore.load();
} catch (err) {
  console.error(`[seed] 读文件存档失败（${file}）：${err?.message ?? err}`);
  process.exit(1);
}
if (!doc) {
  console.error(`[seed] ${file} 里没有可读的存档，退出`);
  process.exit(2);
}

console.log(`[seed] 文件存档 ${file} -> redis ${redisStore.label}：${summary(doc)}`);
await redisStore.save(doc);

const check = await redisStore.load();
if (!check) {
  console.error('[seed] 写入后回读为空，失败');
  process.exit(1);
}
console.log(`[seed] 回读校验通过：${summary(check)}`);
await redisStore.close?.();
await fileStore.close?.();
process.exit(0);
