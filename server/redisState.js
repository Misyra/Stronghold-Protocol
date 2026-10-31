// server/redisState.js — `Persister` 的 Redis 存储：server/redis.js（取自 xinhai-ai/Stronghold-Protocol）在这
// 个仓库里的接缝。
//
// 本仓库的存储契约只有三件（server/persist.js 的 Persister）：
//   load()            启动时读回一份文档（restoreServer 的输入）
//   save(doc)         整份文档落盘（离线的旧布局）
//   saveSharded({ index, shards, metadataVersion })
//                     目录布局的增量写法：index 是会话/房间元数据，shards 是每个对局 code → JSON 文本
//
// 键布局一比一照搬 server/stateFile.js 的目录布局（一个文件一个键），所以两种后端读回的形状完全相同，
// restoreServer 无需分支：
//   <prefix>index      会话 / 房间 / 对局元数据，元数据变了才写
//   <prefix>runtime    各对局时钟 + savedAt + indexRevision，每轮刷（很小）
//   <prefix>cp:<code>  一个房间的检查点，内容变了才写
//   <prefix>state      旧版单键整份文档：只在 index 键不存在时读一次，之后按上面的布局写；旧键保留做回滚副本
//
// 写序（几份文件之间的崩溃一致性，照 Stardust-minus/Stronghold-Protocol 的 server/persist/persister.js：
// "the records first, the head last: a head always comes after the records it describes"）：
//   分片 → index → runtime → 删除不再被点名的分片。
// 索引永远晚于它点名的分片落地，所以崩在任何一步都不会出现「索引点名一个不存在的分片」；反过来「分片比
// 索引新」由 indexRevision 与分片信封里自带的 clocks 兜住（与文件后端同一套信封）。
//
// 值编码：小值直接存 JSON 文本（'J:' + text），≥ 1 KiB 用 zlib deflateRaw 后 base64（'Z:' + b64）。压缩走
// libuv 线程池（promisify 的异步版本），不占 Worker，也不占游戏线程。读回有 64 MiB 上限：一个坏键或外来键
// 不能让进程把它 inflate 到爆内存。

import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { StateStore, parseRedisConfig, LOAD_ATTEMPTS, LOAD_RETRY_MS } from './redis.js';
import { mergeClocks } from './stateClocks.js';
import { indexMetadata, canonicalIndex } from './stateFile.js';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

/** Values at least this large are deflated (Stardust 的阈值，检查点是 JSON，压缩比通常 4–8 倍)。 */
export const DEFLATE_MIN = 1024;
/** Largest value read back: a corrupt or foreign key cannot make the server inflate gigabytes. */
export const MAX_VALUE_BYTES = 64 * 1024 * 1024;
/** Layout marker of the multi-key document (server/stateFile.js 的目录布局用的是 2)。 */
export const REDIS_LAYOUT = 3;

const MARK_PLAIN = 'J:';
const MARK_DEFLATED = 'Z:';

/**
 * Encode one value: plain JSON text below the threshold, deflated + base64 above it.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function encodeValue(text) {
  if (Buffer.byteLength(text, 'utf8') < DEFLATE_MIN) return MARK_PLAIN + text;
  const packed = await deflateRaw(Buffer.from(text, 'utf8'));
  return MARK_DEFLATED + packed.toString('base64');
}

/**
 * Decode one value. A value without a known marker is returned as it is: that is either a document written by an older
 * build (plain JSON) or a key this game does not own — both are handed to JSON.parse by the caller, which decides.
 * @param {string} raw
 * @returns {Promise<string>}
 */
export async function decodeValue(raw) {
  if (typeof raw !== 'string') throw new Error('value is not text');
  if (raw.startsWith(MARK_PLAIN)) return raw.slice(MARK_PLAIN.length);
  if (!raw.startsWith(MARK_DEFLATED)) return raw;
  const b64 = raw.slice(MARK_DEFLATED.length);
  // base64 carries 3 bytes per 4 characters; refuse before inflating anything absurd
  if (b64.length > MAX_VALUE_BYTES * 1.4) throw new Error('value is larger than ' + MAX_VALUE_BYTES + ' bytes');
  const text = (await inflateRaw(Buffer.from(b64, 'base64'))).toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_VALUE_BYTES) throw new Error('value is larger than ' + MAX_VALUE_BYTES + ' bytes');
  return text;
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

export class RedisStateStore extends StateStore {
  /** @param {Parameters<typeof StateStore>[0]} opts */
  constructor(opts) {
    super({ name: 'state', ...opts });
    this.kind = 'redis';
    this.mode = 'keys';
    this.layout = REDIS_LAYOUT;
    this.prefix = String(opts.prefix ?? 'stronghold:');
    /** code → 检查点 body 文本，上次成功提交的那一份（分片的脏比较基线）。 */
    this.shards = new Map();
    /** code → { revision, matchCount }：分片信封里写进去的那一份。 */
    this.shardRevs = new Map();
    this.indexCommit = null;
    this.runtimeCommit = null;
    this.indexRevision = null;
    this.shardWrites = 0;
    this.indexWrites = 0;
    this.runtimeWrites = 0;
  }

  get indexKey() { return this.prefix + 'index'; }
  get runtimeKey() { return this.prefix + 'runtime'; }
  /** The single-key document of the previous layout. */
  get legacyKey() { return this.key; }
  cpKey(code) { return this.prefix + 'cp:' + code; }

  /**
   * Read the document back: index → runtime → the checkpoint of every room the index still names.
   * Retries a few times at boot so a Redis that comes up after the game server still counts.
   * @param {{ attempts?: number, retryMs?: number }} [opts]
   * @returns {Promise<object | null>}
   */
  async load({ attempts = LOAD_ATTEMPTS, retryMs = LOAD_RETRY_MS } = {}) {
    this.loadState = 'unavailable';
    for (let i = 0; i < Math.max(1, attempts); i++) {
      const raw = await this.getKey(this.indexKey);
      if (raw === undefined) {
        if (i + 1 < attempts) await sleep(retryMs);
        continue;
      }
      if (raw === null) return this.#loadLegacy();
      return this.#loadDocument(raw);
    }
    return null;
  }

  /** No index key: either an empty store, or the single-key document of the previous layout. */
  async #loadLegacy() {
    const raw = await this.getKey(this.legacyKey);
    if (raw === undefined) { this.loadState = 'unavailable'; return null; }
    if (raw === null) { this.loadState = 'empty'; return null; }
    let doc;
    try {
      doc = JSON.parse(await decodeValue(raw));
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    } catch (e) {
      this.loadState = 'invalid';
      this.warn('the single-key document is not a state document, skipped', e);
      return null;
    }
    // The next save writes the new layout in full: this document never becomes a dirty-check baseline.
    this.indexCommit = null;
    this.runtimeCommit = null;
    this.loadState = 'loaded';
    this.loadedAt = Date.now();
    this.log.info?.('[redis] the single-key document was read; the next save writes index/runtime/cp:<code>');
    return doc;
  }

  /** @param {string} indexRaw */
  async #loadDocument(indexRaw) {
    let index;
    try {
      index = JSON.parse(await decodeValue(indexRaw));
      if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error('not an object');
    } catch (e) {
      this.loadState = 'invalid';
      this.warn('the index key is not a state document, kept as it is', e);
      return null;
    }
    if (index.layout != null && index.layout !== this.layout) {
      this.loadState = 'invalid';
      this.warn(`index layout ${index.layout} is not this build's (${this.layout}), kept as it is`);
      return null;
    }
    if (typeof index.revision !== 'string' || !index.revision) {
      this.loadState = 'invalid';
      this.warn('the index has no revision, kept as it is');
      return null;
    }
    let runtime = null;
    const runtimeRaw = await this.getKey(this.runtimeKey);
    if (runtimeRaw) {
      try {
        const parsed = JSON.parse(await decodeValue(runtimeRaw));
        if (!parsed || parsed.v !== 1 || !Number.isFinite(parsed.savedAt) || typeof parsed.indexRevision !== 'string'
          || !parsed.clocks || typeof parsed.clocks !== 'object' || Array.isArray(parsed.clocks)) throw new Error('invalid runtime');
        runtime = parsed;
      } catch (e) {
        // A crash after the index write but before the first runtime write is recoverable from the shard envelopes.
        this.warn('the runtime key is unreadable, using the clocks inside the checkpoint envelopes', e);
      }
    }
    const runtimeMatches = !!runtime && runtime.indexRevision === index.revision;
    const rooms = new Map((Array.isArray(index.rooms) ? index.rooms : []).filter((r) => r?.code).map((r) => [r.code, r]));
    const codes = [...rooms.values()].filter((r) => r.hasMatch !== false).map((r) => r.code);

    const values = await this.getKeys(codes.map((code) => this.cpKey(code)));
    if (values === undefined) { this.loadState = 'unavailable'; return null; }

    const legacyClocks = index.clocks && typeof index.clocks === 'object' ? index.clocks : {};
    const clocks = {};
    const matches = {};
    this.shards.clear();
    this.shardRevs.clear();
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      const raw = values[i];
      const room = rooms.get(code);
      if (raw == null) continue;                    // 索引点名了但键不在：这个房间恢复时没有检查点
      let parsed;
      try {
        parsed = JSON.parse(await decodeValue(raw));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      } catch (e) {
        this.warn(`${code}: the checkpoint is unreadable, the room restores without its match`, e);
        continue;
      }
      let c = legacyClocks[code];
      if (parsed.storage === 1) {
        const envelope = parsed;
        const body = envelope.checkpoint;
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof envelope.revision !== 'string') {
          this.warn(`${code}: invalid checkpoint envelope, the room restores without its match`);
          continue;
        }
        // An index write may not have committed the start of a new match in the same room yet.
        if ((envelope.matchCount ?? null) !== (room.matchCount ?? null)) continue;
        this.shardRevs.set(code, { revision: envelope.revision, matchCount: room.matchCount });
        this.shards.set(code, JSON.stringify(body));
        const fresh = runtimeMatches && runtime.clocks[code];
        c = fresh && fresh.revision === envelope.revision ? fresh : envelope.clocks;
        parsed = body;
      } else {
        this.shards.set(code, JSON.stringify(parsed));  // 旧布局（没有信封）：下次保存升级
      }
      if (c && typeof c === 'object') clocks[code] = c;
      matches[code] = mergeClocks(parsed, c);
    }
    this.indexCommit = canonicalIndex(index);
    this.indexRevision = index.revision;
    // restoreServer uses this timestamp only for previously connected identities. Real disconnect times stay intact.
    const savedAt = runtimeMatches ? Math.max(Number(index.savedAt) || 0, runtime.savedAt) : index.savedAt;
    this.loadState = 'loaded';
    this.loadedAt = Date.now();
    return { ...index, savedAt, clocks, matches };
  }

  /**
   * Incremental write. `shards` is the full current set of clock-free checkpoint bodies (JSON text) keyed by room
   * code; a body identical to the one last committed is not written, and the index is only rewritten when the
   * metadata changed (`metadataVersion` is the cheap stand-in for that comparison).
   * @param {{ index: object, shards: Map<string, string> | Record<string, string>, metadataVersion?: number }} payload
   * @returns {Promise<boolean>}
   */
  async saveSharded({ index, shards, metadataVersion }) {
    if (this.closed) return false;
    const snapshot = shards instanceof Map ? new Map(shards) : new Map(Object.entries(shards || {}));
    const savedAt = Number.isFinite(index.savedAt) ? index.savedAt : Date.now();
    const rooms = new Map((index.rooms || []).map((room) => [room.code, room]));

    // 1. the checkpoints first: nothing below may name one that did not land
    for (const [code, body] of snapshot) {
      if (!code || typeof body !== 'string') continue;
      const matchCount = rooms.get(code)?.matchCount;
      const previous = this.shardRevs.get(code);
      if (this.shards.get(code) === body && previous && previous.matchCount === matchCount) continue;
      const revision = randomUUID();
      const clocks = index.clocks?.[code] || {};
      // Embed the Worker-encoded JSON verbatim: no parse/encode of the large checkpoint on the game thread.
      const envelope = `{"storage":1,"revision":${JSON.stringify(revision)},"matchCount":${JSON.stringify(matchCount ?? null)},"clocks":${JSON.stringify(clocks)},"checkpoint":${body}}`;
      if (!await this.setKey(this.cpKey(code), await encodeValue(envelope))) return false;
      this.shards.set(code, body);
      this.shardRevs.set(code, { revision, matchCount });
      this.shardWrites++;
    }

    // 2. then the index it describes
    const commit = metadataVersion == null ? canonicalIndex(index) : 'version:' + metadataVersion;
    if (commit !== this.indexCommit) {
      const revision = randomUUID();
      const meta = { ...indexMetadata(index), savedAt, layout: this.layout, revision };
      if (!await this.setKey(this.indexKey, await encodeValue(JSON.stringify(meta)))) return false;
      this.indexCommit = commit;                   // only a successful write becomes the retry/dirty baseline
      this.indexRevision = revision;
      this.indexWrites++;
    }

    // 3. then the clocks, which tick in real time and must never dirty a checkpoint
    const clocks = {};
    for (const code of snapshot.keys()) {
      const revision = this.shardRevs.get(code)?.revision;
      if (revision) clocks[code] = { ...index.clocks?.[code], revision };
    }
    const runtime = JSON.stringify({ v: 1, indexRevision: this.indexRevision, savedAt, clocks });
    if (runtime !== this.runtimeCommit) {
      if (!await this.setKey(this.runtimeKey, await encodeValue(runtime))) return false;
      this.runtimeCommit = runtime;
      this.runtimeWrites++;
    }

    // 4. drop the checkpoints the document stopped naming — only now, after it stopped naming them
    let ok = true;
    for (const code of [...this.shards.keys()]) {
      if (snapshot.has(code)) continue;
      if (!await this.delKeys(this.cpKey(code))) { ok = false; continue; }
      this.shards.delete(code);
      this.shardRevs.delete(code);
    }
    if (ok) this.saved++;
    return ok;
  }

  /** The classic whole-document call, split into the same three keys. */
  async save(doc) {
    if (this.closed) return false;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
    const matches = doc.matches && typeof doc.matches === 'object' ? doc.matches : {};
    const shards = new Map();
    for (const [code, body] of Object.entries(matches)) {
      try { shards.set(code, JSON.stringify(body)); } catch (e) { this.warn(`${code}: the checkpoint does not serialize`, e); return false; }
    }
    const index = { ...doc };
    delete index.matches;
    return this.saveSharded({ index, shards });
  }

  /** Remove every key of this prefix (tests, `--reset-state`). The legacy key goes too. */
  async clear() {
    const keys = [this.indexKey, this.runtimeKey, this.legacyKey, ...[...this.shards.keys()].map((code) => this.cpKey(code))];
    const ok = await this.delKeys(keys);
    if (ok) {
      this.shards.clear();
      this.shardRevs.clear();
      this.indexCommit = null;
      this.runtimeCommit = null;
      this.indexRevision = null;
      this.loadState = 'empty';
    }
    return ok;
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
