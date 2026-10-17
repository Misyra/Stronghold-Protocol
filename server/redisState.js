// server/redisState.js — `Persister` 的 Redis 存储：server/redis.js（取自 xinhai-ai/Stronghold-Protocol）在这
// 个仓库里的接缝。
//
// 本仓库的存储契约只有三件（server/persist.js 的 Persister）：
//   load()            启动时读回一份文档（restoreServer 的输入）
//   save(doc)         整份文档落盘（离线的旧布局）
//   saveSharded({ index, shards, metadataVersion })
//                     目录布局的增量写法：index 是会话/房间元数据，shards 是每个对局 code → JSON 文本
// Redis 只有一个键，没有目录与分片，所以 saveSharded 把分片合并回路版文档再写一次；读回的形状与文件布局单文件
// 模式完全一致（v / snapshot / savedAt / sessions / rooms / matches / clocks），restoreServer 无需分支。
import { StateStore, parseRedisConfig } from './redis.js';

const parseOrNull = (text, code) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch (err) {
    // 一个分片坏了不该拖垮其它房间：跳过它，restoreServer 会把该房间当作没有检查点
    console.warn(`[redis] 分片 ${code} 不是合法 JSON，已跳过：${err && err.message ? err.message : err}`);
    return null;
  }
};

export class RedisStateStore extends StateStore {
  /** @param {Parameters<typeof StateStore>[0]} opts */
  constructor(opts) {
    super({ name: 'state', ...opts });
    this.kind = 'redis';
  }

  /** The sharded layout is a file optimisation; in Redis the whole document is one key. */
  async saveSharded({ index, shards }) {
    const doc = { ...(index || {}), matches: {} };
    if (shards) {
      const entries = shards instanceof Map ? shards.entries() : Object.entries(shards);
      for (const [code, body] of entries) {
        if (!code) continue;
        const parsed = typeof body === 'string' ? parseOrNull(body, code) : body;
        if (parsed) doc.matches[code] = parsed;
      }
    }
    return this.save(doc);
  }
}

/**
 * 由环境变量决定是否使用 Redis：SP_REDIS_URL / REDIS_URL（前缀 SP_REDIS_PREFIX、TTL SP_REDIS_TTL）。
 * 没有 URL 时返回 null —— 行为与以前完全相同，存储仍是 SP_STATE_FILE。
 * @param {{ env?: Record<string, string|undefined>, log?: object }} [opts]
 * @returns {RedisStateStore | null}
 */
export function createRedisStore({ env = process.env, log = console } = {}) {
  const cfg = parseRedisConfig(env);
  if (!cfg) return null;
  // 启动期连接的宽限：默认沿用 server/redis.js 的 3 s；本机没有 Redis 时可调小，免得开机等满四轮
  const ms = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
  return new RedisStateStore({ ...cfg, log,
    connectTimeoutMs: ms(env.SP_REDIS_CONNECT_TIMEOUT), commandTimeoutMs: ms(env.SP_REDIS_COMMAND_TIMEOUT) });
}

export { parseRedisConfig };
