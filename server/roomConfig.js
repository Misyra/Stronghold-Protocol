// 房间运行配置的落盘与版本（docs/design/portal-agent-wss.md §10.2）。
//
// 文件从 v1（`{schemaVersion:1, maxRooms, …}`，只有「当前值」）变成 v2：
//
//   { schemaVersion: 2, revision: 18, values: { …五个白名单字段… },
//     lastMutation: { opId, payloadHash, revision } }
//
// 为什么要 revision 与 lastMutation，而不是继续直接覆盖那五个字段：中央改配置是**跨机**的写，回执可能在
// 回来的路上丢。没有版本号时，一次超时重发就会把别人的改动覆盖掉；没有 lastMutation 时，回执丢了以后
// 谁也说不清「我那次写到底执行了没有」。这两个字段就是「比较并交换」与「同一次操作只执行一次」的全部依据。
//
// 这一层不认识 HTTP，也不认识 lobby：它只管「文件长什么样」与「这次写该不该落盘、落成什么」。真正的串行
// 队列在 server/roomAdmin.js（那是唯一被允许写这个文件的地方），应用生效在 lobby.applyRoomConfig。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** @type {Readonly<Record<string, readonly [string, number, number, number]>>} */
export const ROOM_LIMIT_OPTIONS = Object.freeze({
  roomCreateBurst: ['SP_ROOM_CREATE_BURST', 4, 1, 100],
  roomCreateRefillMs: ['SP_ROOM_CREATE_REFILL_MS', 15000, 100, 3600000],
  matchStartBurst: ['SP_MATCH_START_BURST', 4, 1, 100],
  matchStartRefillMs: ['SP_MATCH_START_REFILL_MS', 30000, 100, 3600000],
  maxBots: ['SP_BOT_MAX_TOTAL', 300, 1, 10000],
  maxForeignBots: ['SP_BOT_MAX_FOREIGN', 50, 1, 10000],
  maxForeignSessionsPerIp: ['SP_FOREIGN_MAX_SESSIONS_PER_IP', 1, 1, 100],
});
export const ROOM_PROTECTION_DEFAULTS = Object.freeze({
  limitForeignSessions: true,
  allowForeignConnections: true,
  maxForeignSessionsPerIp: ROOM_LIMIT_OPTIONS.maxForeignSessionsPerIp[1],
  roomCreateBurst: ROOM_LIMIT_OPTIONS.roomCreateBurst[1],
  roomCreateRefillMs: ROOM_LIMIT_OPTIONS.roomCreateRefillMs[1],
  matchStartBurst: ROOM_LIMIT_OPTIONS.matchStartBurst[1],
  matchStartRefillMs: ROOM_LIMIT_OPTIONS.matchStartRefillMs[1],
  maxBots: ROOM_LIMIT_OPTIONS.maxBots[1],
  maxForeignBots: ROOM_LIMIT_OPTIONS.maxForeignBots[1],
});

// 首版开放的五个运行配置字段（§10.1）。中央的 config.patch 白名单、v2 文档的 values、这里的校验共用同一
// 份数组：分成两份维护，迟早会变成「能写进去但读不出来」这种只有线上才会发现的错位。
export const ROOM_CONFIG_FIELDS = Object.freeze(['maxRooms', 'allowBots', 'limitForeignSessions',
  'allowForeignConnections', 'maxForeignSessionsPerIp']);

export const ROOM_CONFIG_SCHEMA_VERSION = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

export function validateRoomConfig(config, { partial = false } = {}) {
  if (!config || Array.isArray(config) || typeof config !== 'object' || !Object.keys(config).length ||
    Object.keys(config).some((key) => !ROOM_CONFIG_FIELDS.includes(key))) return 'INVALID_ROOM_CONFIG';
  if ((!partial || Object.hasOwn(config, 'maxRooms')) &&
    (!Number.isSafeInteger(config.maxRooms) || config.maxRooms < 1 || config.maxRooms > 10000)) return 'INVALID_MAX_ROOMS';
  if (Object.hasOwn(config, 'allowBots') && typeof config.allowBots !== 'boolean') return 'INVALID_ALLOW_BOTS';
  if (Object.hasOwn(config, 'limitForeignSessions') && typeof config.limitForeignSessions !== 'boolean') return 'INVALID_FOREIGN_SESSION_LIMIT';
  if (Object.hasOwn(config, 'allowForeignConnections') && typeof config.allowForeignConnections !== 'boolean') return 'INVALID_ALLOW_FOREIGN_CONNECTIONS';
  if (Object.hasOwn(config, 'maxForeignSessionsPerIp') && (!Number.isSafeInteger(config.maxForeignSessionsPerIp) ||
    config.maxForeignSessionsPerIp < ROOM_LIMIT_OPTIONS.maxForeignSessionsPerIp[2] ||
    config.maxForeignSessionsPerIp > ROOM_LIMIT_OPTIONS.maxForeignSessionsPerIp[3])) return 'INVALID_FOREIGN_MAX_SESSIONS_PER_IP';
  return null;
}

/**
 * 同一次操作的指纹。键排序后哈希，所以字段顺序不影响判定；值原样进 JSON —— 把 `700` 和 `"700"` 归一成
 * 同一件事会让「同 opId 不同内容」这个拒绝分支失效，而那个分支正是防止两次含义不同的写被当成一次重放的。
 * @param {Record<string, unknown>} patch
 */
export function payloadFingerprint(patch) {
  const canonical = {};
  for (const key of Object.keys(patch).sort()) canonical[key] = patch[key];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// 版本号：**永不对外给 0**。中央的协议层要求 config.patch 的 expectedRevision ≥ 1（lib/agent-protocol.mjs），
// 报 0 会让面板那边连一次写都发不出来，而症状是「这个站点永远说版本冲突」—— 排查方向完全错。文件里出现
// 0（手工改坏、或者极老的存档）一律向上取成 1：它只是个单调变化的令牌，不是计数器。
function readRevision(value) { return Number.isSafeInteger(value) && value >= 1 ? value : 1; }

function normalizeMutation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const opId = typeof raw.opId === 'string' && UUID_RE.test(raw.opId) ? raw.opId.toLowerCase() : null;
  const payloadHash = typeof raw.payloadHash === 'string' && HASH_RE.test(raw.payloadHash) ? raw.payloadHash.toLowerCase() : null;
  if (!opId || !payloadHash) return null;
  return { opId, payloadHash, revision: readRevision(raw.revision) };
}

/**
 * 读整份文档。`null` 表示「还没有这个文件」（全新安装），坏文件与不可读一律抛 —— 静默当成空配置会让人在
 * 重启后发现房间上限变了，却查不到任何一条日志。
 * @param {string} file
 * @returns {Promise<{ values: Record<string, unknown>, revision: number, lastMutation: object | null,
 *                     migrated: boolean } | null>}
 */
export async function loadRoomConfigDocument(file) {
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read room admin state at ${file}: ${error.message}`, { cause: error });
  }
  try {
    if (state?.schemaVersion === ROOM_CONFIG_SCHEMA_VERSION) {
      const error = validateRoomConfig(state.values);
      if (error) throw new Error(error);
      return { values: state.values, revision: readRevision(state.revision),
        lastMutation: normalizeMutation(state.lastMutation), migrated: false };
    }
    if (state?.schemaVersion === 1) {
      const { schemaVersion: _version, ...values } = state;
      const error = validateRoomConfig(values);
      if (error) throw new Error(error);
      // v1 记成第 1 版：它确实是「这份配置的第一个版本」。迁移落盘也按第 1 版写（§10.2「首次迁移写入 v2 时
      // 从 revision=1 开始」），于是第一次真正的改动会是第 2 版，而中央手里的 revision 从头到尾都 ≥ 1。
      return { values, revision: 1, lastMutation: null, migrated: true };
    }
    throw new Error('invalid room admin state');
  } catch (error) {
    throw new Error(`cannot read room admin state at ${file}: ${error.message}`, { cause: error });
  }
}

/** 兼容旧调用方：只要那五个字段。 */
export async function loadRoomConfig(file) {
  const document = await loadRoomConfigDocument(file);
  return document ? document.values : null;
}

/**
 * 原子写整份 v2 文档。至少覆盖临时文件 fsync、rename（§10.2）：只做 rename 的话内容可能还停在页缓存里，
 * 断电后拿到的是一个空文件或半截 JSON —— 那正是「重启之后房间上限悄悄变回默认值」的成因。
 * @param {string} file
 * @param {{ values: Record<string, unknown>, revision: number, lastMutation?: object | null }} document
 */
export async function saveRoomConfigDocument(file, { values, revision, lastMutation = null }) {
  const error = validateRoomConfig(values);
  if (error) throw new Error(error);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const body = { schemaVersion: ROOM_CONFIG_SCHEMA_VERSION, revision: readRevision(revision), values,
    lastMutation: normalizeMutation(lastMutation) };
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(body)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  // 目录项也要落：Linux 上 rename 的持久性取决于父目录的 fsync。Windows 不允许对目录 fsync（EPERM/EACCES），
  // 那边只保有「替换可见」这一层；所以这里的失败一律忽略，不让它把一次成功的写入报成失败。
  if (process.platform !== 'win32') {
    try {
      const dir = await open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* 目录不是常规文件或平台不支持：上文那句注释解释过了 */ }
  }
  return body;
}

/**
 * 串行队列里的那一次判定（§10.2）：进队列后先看截止时间，再看最近一次同 opId 的指纹，然后比较
 * expectedRevision，最后校验补丁并合并。**纯函数** —— 不碰磁盘、不改内存，只回答「这次写该不该落盘、
 * 落成什么」，于是每条分支都能被单独断言，而不用去构造一个坏磁盘。
 *
 * @returns {{ error: string } | { replayed: true, originalResultRevision: number, mutation: object }
 *   | { values: Record<string, unknown>, revision: number, lastMutation: object }}
 */
export function roomConfigMutation(current, { patch, expectedRevision = null, opId = null, expiresAt = null, now = Date.now } = {}) {
  if (Number.isSafeInteger(expiresAt) && expiresAt > 0 && now > expiresAt) return { error: 'DEADLINE_EXCEEDED' };
  const fingerprint = payloadFingerprint(patch);
  const last = current.lastMutation;
  if (opId && last?.opId === opId) {
    // 同一个 opId 又来了：内容一样就是重放（回执丢了、中央重发），不递增 revision，把原来那个版本号一并
    // 带回去；内容不一样说明两次请求的含义不同，拒绝 —— 放行等于用同一个 opId 记两件不同的事。
    if (last.payloadHash !== fingerprint) return { error: 'OP_ID_CONFLICT' };
    return { replayed: true, originalResultRevision: last.revision, mutation: last };
  }
  // 旧 HTTP PUT 走的是「没有 expectedRevision」的那条路（迁移期兼容），它**不能**被允许跳过版本控制：默认
  // 认为它读的是当前版本。中央那条路必须显式给 revision，对不上就是 CONFIG_CONFLICT。
  if (expectedRevision != null && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision))
    return { error: 'CONFIG_CONFLICT' };
  const values = { ...current.values, ...patch };
  const error = validateRoomConfig(values);
  if (error) return { error };
  const revision = current.revision + 1;
  // 没有 opId 的写（旧的 HTTP PUT）也要留一条 lastMutation，但用本地生成的 uuid：中央拿它的 opId 来比对时
  // 必然对不上，于是这次写之后的「回执丢失」会被判成未知 —— 那正是事实（中央的那次写确实无法自证了）。
  return { values, revision, lastMutation: { opId: opId || randomUUID(), payloadHash: fingerprint, revision } };
}

/**
 * 对外的配置文档（§10.2）。白名单字段**平铺**在顶层是为了过渡期兼容旧面板/旧脚本；元数据跟在后面。
 * @param {{ values: Record<string, unknown>, revision: number, lastMutation: object | null }} document
 */
export function roomConfigDocument(document, { persisted = false, applied = false, extra = {} } = {}) {
  return { ...document.values, values: { ...document.values }, revision: document.revision,
    lastMutation: document.lastMutation ? { ...document.lastMutation } : null, persisted, applied, ...extra };
}
