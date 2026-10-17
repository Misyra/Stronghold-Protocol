// 游戏配置文件的 v2 版本与 CAS（docs/design/portal-agent-wss.md §43.2 / §46.3）。
//
// 这一组测试盯的是「跨机写配置」最容易出错的三件事：
//   1) 版本从哪来、旧档怎么换算 —— v1 只有当前值，换错就会让面板永远说「版本冲突」；
//   2) 比较并交换必须发生在**串行队列内部** —— 入队前比一次，两个同时到达的写都会通过；
//   3) 回执丢了以后能不能自证 —— 同 opId 同内容不重复执行，同 opId 不同内容必须拒绝。
// 另外两条边缘：过期命令不执行（回 200 + closed/expired 而不是假装成功），落盘成功但应用失败要分开报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { loadRoomConfigDocument, payloadFingerprint, roomConfigMutation, saveRoomConfigDocument } from '../server/roomConfig.js';

process.env.SP_FOREIGN_SESSION_LIMIT = 'on';

const TOKEN = 'room-config-v2-test-token-0123456789';
const OP_A = '11111111-1111-4111-8111-111111111111';
const OP_B = '22222222-2222-4222-8222-222222222222';
const VALUES = Object.freeze({ maxRooms: 1600, allowBots: true, limitForeignSessions: true,
  allowForeignConnections: true, maxForeignSessionsPerIp: 1 });

async function lab(t, { stateFile = true, options = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-room-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = stateFile === true ? path.join(dir, 'config.json') : stateFile;
  const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off', MatchClass: StubMatch,
    roomAdminToken: TOKEN, roomAdminPort: 0, roomAdminStateFile: file, quiet: true, ...options });
  t.after(() => srv.close());
  assert.ok(srv.roomAdminUrl, '测试要真的把房间管理端口起起来');
  const call = async (body, { method = 'PUT', token = TOKEN } = {}) => {
    const response = await fetch(`${srv.roomAdminUrl}/api/room-config`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const read = async () => {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  };
  return { srv, dir, file, call, read };
}

// ─── 纯函数：版本判定 ───────────────────────────────────────────────────────────────────────────

test('payloadFingerprint 只认内容，不认键顺序', () => {
  assert.equal(payloadFingerprint({ maxRooms: 700, allowBots: false }), payloadFingerprint({ allowBots: false, maxRooms: 700 }));
  assert.notEqual(payloadFingerprint({ maxRooms: 700 }), payloadFingerprint({ maxRooms: 701 }));
  // `"700"` 与 `700` 进游戏的效果不同，指纹必须也不同：归一化会把「同 opId 不同内容」判成重放。
  assert.notEqual(payloadFingerprint({ maxRooms: 700 }), payloadFingerprint({ maxRooms: '700' }));
});

test('roomConfigMutation：截止时间、重放、opId 冲突与版本比较', () => {
  const current = { values: { ...VALUES }, revision: 4,
    lastMutation: { opId: OP_A, payloadHash: payloadFingerprint({ maxRooms: 900 }), revision: 4 } };
  assert.equal(roomConfigMutation(current, { patch: { maxRooms: 900 }, expectedRevision: 4, opId: OP_A }).replayed, true);
  assert.equal(roomConfigMutation(current, { patch: { maxRooms: 900 }, expectedRevision: 4, opId: OP_A }).originalResultRevision, 4);
  assert.equal(roomConfigMutation(current, { patch: { maxRooms: 901 }, expectedRevision: 4, opId: OP_A }).error, 'OP_ID_CONFLICT');
  assert.equal(roomConfigMutation(current, { patch: { maxRooms: 901 }, expectedRevision: 9, opId: OP_B }).error, 'CONFIG_CONFLICT');
  assert.equal(roomConfigMutation(current, { patch: { maxRooms: 901 }, expectedRevision: 4, opId: OP_B }).revision, 5);
  // 过期命令：连版本都不比。它已经不该执行了，报「版本冲突」会把一次放弃的命令说成一次并发冲突。
  assert.equal(roomConfigMutation(current, { patch: { maxRooms: 901 }, expectedRevision: 4, opId: OP_B,
    expiresAt: 1000, now: 2000 }).error, 'DEADLINE_EXCEEDED');
  // 合并后的值仍然要过校验，否则会把一个非法的运行值写进磁盘。
  assert.equal(roomConfigMutation(current, { patch: { maxRooms: 0 }, expectedRevision: 4 }).error, 'INVALID_MAX_ROOMS');
  // 没有 opId 的旧写照样递增版本，但 lastMutation 记的是本地生成的号（中央的 opId 永远不会等于它）。
  const legacy = roomConfigMutation(current, { patch: { maxRooms: 800 }, expectedRevision: null });
  assert.equal(legacy.revision, 5);
  assert.notEqual(legacy.lastMutation.opId, OP_A);
});

test('文档读写：v1 迁成 v2 第 1 版，坏档与非法值都拒绝', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-room-config-doc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  assert.equal(await loadRoomConfigDocument(file), null, '没有文件就是全新安装');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, maxRooms: 321 }));
  const migrated = await loadRoomConfigDocument(file);
  assert.equal(migrated.revision, 1);
  assert.equal(migrated.migrated, true);
  assert.deepEqual(migrated.values, { maxRooms: 321 });
  assert.equal(migrated.lastMutation, null);
  await saveRoomConfigDocument(file, migrated);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.revision, 1);
  assert.equal(saved.lastMutation, null);
  await writeFile(file, JSON.stringify({ schemaVersion: 2, revision: 0, values: VALUES, lastMutation: 'junk' }));
  const clamped = await loadRoomConfigDocument(file);
  assert.equal(clamped.revision, 1, '版本号永不对外给 0：中央的协议层要求 expectedRevision ≥ 1');
  assert.equal(clamped.lastMutation, null);
  await writeFile(file, JSON.stringify({ schemaVersion: 3, values: VALUES }));
  await assert.rejects(() => loadRoomConfigDocument(file), /invalid room admin state/);
  await writeFile(file, '{ not json');
  await assert.rejects(() => loadRoomConfigDocument(file), /cannot read room admin state/);
});

// ─── HTTP：CAS ────────────────────────────────────────────────────────────────────────────────

test('版本化写：正确的 revision 落盘并递增，落盘失败不改运行值', async (t) => {
  const f = await lab(t);
  const before = await f.call(undefined, { method: 'GET' });
  assert.equal(before.status, 200);
  assert.equal(before.body.revision, 1, '全新安装：内存里的当前值就是第 1 版');
  assert.deepEqual(before.body.values, VALUES);
  assert.equal(before.body.maxRooms, 1600, '过渡期：旧字段仍然平铺在顶层');
  assert.equal(before.body.persisted, undefined, '读响应不说「写落没落地」');

  const written = await f.call({ expectedRevision: 1, opId: OP_A, patch: { maxRooms: 700 } });
  assert.equal(written.status, 200);
  assert.equal(written.body.persisted, true);
  assert.equal(written.body.applied, true);
  assert.equal(written.body.revision, 2);
  assert.equal(written.body.maxRooms, 700);
  assert.equal(written.body.values.maxRooms, 700);
  assert.equal(written.body.lastMutation.opId, OP_A);
  assert.equal(written.body.lastMutation.revision, 2);
  const saved = await f.read();
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.values, { ...VALUES, maxRooms: 700 });
  assert.equal(f.srv.lobby.opts.maxRooms, 700);

  // 落盘失败（路径被文件挡住）：503，且运行值与版本都不动 —— 「没写成」不能被报成写成了一半。
  const blocked = path.join(f.dir, 'blocked');
  await writeFile(blocked, 'not a directory');
  const broken = await lab(t, { stateFile: path.join(blocked, 'config.json') });
  const failed = await broken.call({ expectedRevision: 1, opId: OP_B, patch: { allowBots: false } });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'ROOM_LIMIT_SAVE_FAILED');
  assert.equal(broken.srv.lobby.opts.allowBots, true);
  assert.equal((await broken.call(undefined, { method: 'GET' })).body.revision, 1);
});

test('过时页面的写被拒，并拿到实际值与实际版本', async (t) => {
  const f = await lab(t);
  await f.call({ expectedRevision: 1, opId: OP_A, patch: { maxRooms: 700 } });
  const stale = await f.call({ expectedRevision: 1, opId: OP_B, patch: { allowBots: false } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'CONFIG_CONFLICT');
  assert.equal(stale.body.revision, 2);
  assert.equal(stale.body.values.maxRooms, 700, '冲突回执要带上实际值，页面才能显示「现在是什么」');
  assert.equal(f.srv.lobby.opts.allowBots, true);
  assert.equal((await f.read()).revision, 2, '被拒的写不落盘');
  for (const bad of [{ expectedRevision: 1, patch: {} }, { expectedRevision: 1 }, { expectedRevision: '1', patch: { maxRooms: 5 } },
    { expectedRevision: 1, patch: { maxRooms: 5 }, extra: 1 }, { expectedRevision: 1, patch: { maxRooms: 5 }, opId: 'nope' }])
    assert.equal((await f.call(bad)).status, 400, JSON.stringify(bad));
});

test('比较并交换发生在串行队列内部：同 revision 的两个写只有一个成功', async (t) => {
  const f = await lab(t);
  const [first, second] = await Promise.all([
    f.call({ expectedRevision: 1, opId: OP_A, patch: { maxRooms: 700 } }),
    f.call({ expectedRevision: 1, opId: OP_B, patch: { maxRooms: 800 } }),
  ]);
  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [200, 409], '入队前比版本的话两个都会通过');
  const winner = first.status === 200 ? first : second;
  const saved = await f.read();
  assert.equal(saved.revision, 2);
  assert.equal(saved.values.maxRooms, winner.body.maxRooms);
  assert.equal(f.srv.lobby.opts.maxRooms, winner.body.maxRooms);
});

test('同 opId 同内容不重复执行，同 opId 不同内容拒绝，过期命令不执行', async (t) => {
  const f = await lab(t);
  const first = await f.call({ expectedRevision: 1, opId: OP_A, patch: { maxRooms: 700 } });
  assert.equal(first.status, 200);
  const replay = await f.call({ expectedRevision: 1, opId: OP_A, patch: { maxRooms: 700 } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.revision, 2, '重放不递增版本');
  assert.equal(replay.body.originalResultRevision, 2);
  assert.equal((await f.read()).revision, 2);
  const clash = await f.call({ expectedRevision: 2, opId: OP_A, patch: { maxRooms: 701 } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'OP_ID_CONFLICT');
  const expired = await f.call({ expectedRevision: 2, opId: OP_B, patch: { allowBots: false }, expiresAt: Date.now() - 1 });
  assert.equal(expired.status, 200);
  assert.equal(expired.body.expired, true);
  assert.equal(expired.body.persisted, false, '过期命令不执行，也不能报成落盘了');
  assert.equal(expired.body.revision, 2);
  assert.equal(f.srv.lobby.opts.allowBots, true);
  assert.equal((await f.read()).revision, 2);
});

test('旧写与版本化写走同一个串行入口，版本一起递增', async (t) => {
  const f = await lab(t);
  assert.equal((await f.call({ maxRooms: 900 })).status, 200, '迁移期保留的旧写法');
  const after = await (await fetch(`${f.srv.roomAdminUrl}/api/room-config`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(after.revision, 2, '旧写也要递增版本，否则它就是绕过版本控制的暗路');
  assert.equal(after.maxRooms, 900);
  assert.equal(after.lastMutation.revision, 2);
  assert.match(after.lastMutation.opId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // 旧写之后，拿着旧版本号来的版本化写必须被拒：现场已经不是它以为的那一份了。
  assert.equal((await f.call({ expectedRevision: 1, opId: OP_B, patch: { maxRooms: 800 } })).status, 409);
  assert.equal((await f.call({ expectedRevision: 2, opId: OP_B, patch: { maxRooms: 800 } })).status, 200);
});

test('落盘成功但应用失败：如实分开报 persisted/applied', async (t) => {
  const f = await lab(t);
  const original = f.srv.lobby.applyRoomConfig;
  f.srv.lobby.applyRoomConfig = () => { throw new Error('apply exploded'); };
  t.after(() => { f.srv.lobby.applyRoomConfig = original; });
  const response = await f.call({ expectedRevision: 1, opId: OP_A, patch: { maxRooms: 600 } });
  assert.equal(response.status, 200);
  assert.equal(response.body.persisted, true);
  assert.equal(response.body.applied, false);
  assert.equal(response.body.revision, 2);
  assert.equal(f.srv.lobby.opts.maxRooms, 1600, '运行值没变，但磁盘上已经是新值');
  assert.equal((await f.read()).values.maxRooms, 600);
});

// ─── HTTP：关房 ───────────────────────────────────────────────────────────────────────────────

test('关房：实例号与创建时间都要对，过期命令不执行', async (t) => {
  const f = await lab(t);
  const session = f.srv.registry.create('房主');
  session.connected = true;
  assert.equal(f.srv.lobby.create(session, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const room = f.srv.lobby.roomOf(session);
  const code = room.code, roomId = room.roomId, createdAt = room.createdAt;
  const close = (body) => fetch(`${f.srv.roomAdminUrl}/api/rooms/${code}/close`, { method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // 什么凭据都不给：不执行（同码复用的时候，这等于「关掉别人的新房间」）。
  assert.equal((await close({})).status, 409);
  assert.equal((await close({ roomId: '00000000-0000-4000-8000-000000000000' })).status, 409, '同码新实例必须拒绝');
  assert.equal((await close({ createdAt: createdAt + 1 })).status, 409);
  const expired = await close({ roomId, createdAt, expiresAt: Date.now() - 1 });
  assert.equal(expired.status, 200);
  assert.deepEqual(await expired.json(), { closed: false, code: 'DEADLINE_EXCEEDED', roomCode: code, roomId, createdAt });
  assert.ok(f.srv.lobby.getRoom(code), '过期命令不许真的关掉房间');
  const response = await close({ roomId, createdAt });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { closed: true, roomCode: code, roomId, createdAt });
  assert.equal(f.srv.lobby.getRoom(code), null);
  assert.equal((await close({ roomId })).status, 404, '房间已经不在：404，而不是「又关了一次成功」');
});

test('saveRoomConfigDocument 拒绝非法值（不会把坏配置写进磁盘）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-room-config-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await assert.rejects(() => saveRoomConfigDocument(file, { values: { maxRooms: 0 }, revision: 1 }), /INVALID_MAX_ROOMS/);
  await assert.rejects(() => saveRoomConfigDocument(file, { values: { ...VALUES, nope: 1 }, revision: 1 }), /INVALID_ROOM_CONFIG/);
});
