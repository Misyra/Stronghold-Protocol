// server/valkeyState.js — 可选的 Valkey / Redis 协议持久化后端（合并自 Stardust fork 的 server/persist/valkey.js +
// store.js；docs/DEPLOY.md「断点续玩」）。零 npm 依赖：RESP2 客户端在 server/valkeyClient.js（fork 原件照搬），
// 文档逻辑不重写——本类继承 server/redisState.js 的 RedisStateStore（键布局 / 值编码 / 写序 / 崩溃一致性全部
// 复用），只把键级原语（GET / MGET / SET / DEL）换到自写客户端上。于是两种后端读回的形状完全相同，
// restoreServer 无需分支；键空间与文件分片布局（server/stateFile.js）一比一对应：
//
//   <prefix>index      会话 / 房间 / 对局元数据，元数据变了才写
//   <prefix>runtime    各对局时钟 + savedAt + indexRevision，每轮刷（很小）
//   <prefix>cp:<code>  一个房间的检查点，内容变了才写
//   <prefix>state      旧版单键整份文档：只在 index 键不存在时读一次（迁移路径），之后按上面的布局写
//
// 语义对齐（与文件 / Redis 后端同一套契约）：
//   * 原子性——检查点整体写：一个 cp:<code> 键就是一个房间的完整检查点信封，SET 单键原子，没有半份可读；
//   * 写序即崩溃一致性——分片 → index → runtime → 删除不再被点名的分片（索引永远晚于它点名的分片落地）；
//     「读回在写之前」由 Persister 的 deferLoad / pendingLoad 契约保证，与后端无关；
//   * 写锁——[ASSUMED] 与既有 Redis 后端同口径：不加跨进程锁。单键写由 Valkey 串行化，写序保证崩溃一致；
//     文件后端的独占锁文件防的是「两个进程写同一目录」，而 Valkey 用**一个前缀只给一个游戏服**的约定代替
//     （docs/DEPLOY.md），多个进程同前缀互相覆盖的问题与 Redis 后端完全相同；
//   * 降级——存储连不上 / 命令失败：命令立即失败（UNAVAILABLE，不排队）、本轮保存记 failures、服务器照常
//     内存运行；启动读不成功则 deferLoad 挡住所有写，绝不覆盖没读回来的存档。**不自动回退文件后端**：
//     回退会把同一份状态悄悄写到两个地方，宁可显式（运维改回 SP_STATE_FILE 并重启）。
//
// 选择（resolvePersistBackend）：SP_PERSIST_BACKEND=valkey|redis|file 显式指定；缺省自动——
// SP_VALKEY_URL → Valkey（本文件），SP_REDIS_URL / REDIS_URL → 既有 Redis 后端（server/redisState.js），
// 都没配 → 文件（默认，行为与从前完全相同）。

import { readFileSync } from 'node:fs';

import { RedisStateStore, parseRedisConfig } from './redisState.js';
import { ValkeyClient } from './valkeyClient.js';

/** Failure log throttle（与 server/redis.js 的 LOG_GAP_MS 同值）。 */
const LOG_GAP_MS = 60_000;
/** 兼容 fork 的旧叫法：被视为「暂时性失败」的客户端错误码——启动读等它们过去，其余立即定论。 */
export const TRANSIENT_FAILURES = new Set(['UNAVAILABLE', 'TIMEOUT', 'LOADING']);

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 读 Valkey 后端的环境变量；没有 SP_VALKEY_URL 就返回 null（= 后端关闭，零行为差异）。
 * URL 的合法性在这里不查（构造 ValkeyClient 时才解析）——配了一个坏 URL 应当在启动时大声失败，而不是被
 * 悄悄当成「没配」落回文件后端。
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, prefix: string, ttlSec: number, passwordFile: string | null,
 *             connectTimeoutMs: number | undefined, commandTimeoutMs: number | undefined } | null}
 */
export function parseValkeyConfig(env = process.env) {
  const url = String(env.SP_VALKEY_URL ?? '').trim();
  if (!url) return null;
  const rawPrefix = String(env.SP_VALKEY_PREFIX ?? 'stronghold:').trim();
  const ttlRaw = Number(env.SP_VALKEY_TTL);
  const passwordFile = String(env.SP_VALKEY_PASSWORD_FILE ?? '').trim() || null;
  const ms = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
  return {
    url,
    prefix: rawPrefix || 'stronghold:',
    ttlSec: Number.isFinite(ttlRaw) && ttlRaw >= 60 ? Math.trunc(ttlRaw) : 90_000, // 25 h ≈ 最长重连窗口
    passwordFile,
    connectTimeoutMs: ms(env.SP_VALKEY_CONNECT_TIMEOUT),
    commandTimeoutMs: ms(env.SP_VALKEY_COMMAND_TIMEOUT),
  };
}

/**
 * 持久化后端的选择（见文件头）。只看环境，不连接、不抛错——坏 URL / 坏密码文件在 createValkeyStore 里大声失败。
 * @param {Record<string, string | undefined>} [env]
 * @returns {'valkey' | 'redis' | 'file'}
 */
export function resolvePersistBackend(env = process.env) {
  const forced = String(env.SP_PERSIST_BACKEND ?? '').trim().toLowerCase();
  if (forced === 'valkey' || forced === 'redis' || forced === 'file') return forced;
  if (parseValkeyConfig(env)) return 'valkey';
  if (parseRedisConfig(env)) return 'redis';
  return 'file';
}

/**
 * B 的存储契约（server/persist.js 的 Persister：load / save / saveSharded / loadState / close）在 Valkey 上的实现。
 * 文档逻辑（读回 / 增量写 / 写序 / 脏比较基线）继承自 RedisStateStore；这里只提供键级原语和连接生命周期。
 */
export class ValkeyStateStore extends RedisStateStore {
  /**
   * @param {{ url: string, prefix?: string, ttlSec?: number, passwordFile?: string | null, log?: object,
   *           connectTimeoutMs?: number, commandTimeoutMs?: number }} opts
   */
  constructor({ url, prefix = 'stronghold:', ttlSec = 90_000, passwordFile = null, log = noopLog,
    connectTimeoutMs = 3000, commandTimeoutMs = 4000 }) {
    super({ url, prefix, ttlSec, name: 'state', log });
    this.kind = 'valkey';
    let password = null;
    if (passwordFile) password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, ''); // 密码从不进日志
    /** @type {ValkeyClient} 测试可注入（见 openValkeyStore 的 client 透传）。 */
    this.client = new ValkeyClient({ url, password, log, connectTimeoutMs, commandTimeoutMs });
    this.lastErrorAt = -Infinity;
    this.lastErrorMsg = '';
  }

  get label() {
    try {
      const u = new URL(this.url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return 'valkey';
    }
  }

  /** 节流的失败日志（覆盖 StateStore 的私有实现，措辞与错误码随自写客户端）。 */
  warn(msg, err) {
    this.failures++;
    const now = Date.now();
    this.lastErrorMsg = err ? String(err.message || err) : msg;
    if (now - this.lastErrorAt < LOG_GAP_MS) return;
    this.lastErrorAt = now;
    this.log.warn(`[valkey] ${msg} (${this.label}): ${this.lastErrorMsg} — 服务器照常内存运行，之后每轮重试`);
  }

  /** bulk string 回复 → 文本（值都是 JSON 文本 / 标记前缀文本）。 */
  #text(v) { return v == null ? v : v.toString('utf8'); }

  /** One key. @returns {Promise<string | null | undefined>} value / null = 键不在 / undefined = 存储没应答 */
  async getKey(key) {
    try { return this.#text(await this.client.command('GET', key)); }
    catch (e) { this.warn('read failed', e); return undefined; }
  }

  /** Many keys in one round trip. @returns {Promise<(string | null)[] | undefined>} undefined = 没应答 */
  async getKeys(keys) {
    const list = [...keys];
    if (!list.length) return [];
    try {
      const out = await this.client.command('MGET', ...list);
      return Array.isArray(out) ? out.map((v) => this.#text(v)) : undefined;
    } catch (e) { this.warn('read failed', e); return undefined; }
  }

  /** One key, TTL refreshed, never throws. @returns {Promise<boolean>} */
  async setKey(key, value) {
    try {
      await this.client.command('SET', key, value, 'EX', String(this.ttlSec));
      this.saved++;
      return true;
    } catch (e) { this.warn('write failed', e); return false; }
  }

  /** Delete keys, never throws. @returns {Promise<boolean>} true = 存储应答了 */
  async delKeys(keys) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string' && k);
    if (!list.length) return true;
    try { await this.client.command('DEL', ...list); return true; }
    catch (e) { this.warn('delete failed', e); return false; }
  }

  /** 关连接（优雅：在途命令落地或失败后返回）。 */
  async close() {
    this.closed = true;
    await this.client.close();
  }
}

/**
 * 由环境变量决定是否使用 Valkey 后端：SP_VALKEY_URL（前缀 SP_VALKEY_PREFIX、TTL SP_VALKEY_TTL、
 * 密码文件 SP_VALKEY_PASSWORD_FILE）。没有 URL 时返回 null——行为与从前完全相同，存储仍是 SP_STATE_FILE。
 * 坏 URL / 读不到的密码文件在这里抛错（启动大声失败），而不是悄悄退回文件。
 * @param {{ env?: Record<string, string|undefined>, log?: object, client?: any }} [opts]
 *   `client`（测试）：注入现成的 ValkeyClient
 * @returns {ValkeyStateStore | null}
 */
export function createValkeyStore({ env = process.env, log = console, client = null } = {}) {
  const cfg = parseValkeyConfig(env);
  if (!cfg) return null;
  const store = new ValkeyStateStore({ ...cfg, log });
  if (client) store.client = client;
  return store;
}
