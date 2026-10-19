// 单间房的聊天回看（GET /api/rooms/:CODE/chat，运维面板 → 本机探针）。
//
// 这个端点只读，但它把两件本来分开的东西接到了同一条回答里：已经落盘的审计日志，和房间自己的 50 条环形缓冲。
// 于是要钉的是三条边界：
//   1) 房间码会被复用 —— 「哪几条算这间房」只能靠 createdAt 划，不能靠码；
//   2) 日志读不出来不是故障 —— 回 200 + partial:true 与回 404「没有这间房」必须分得清清楚楚；
//   3) 两边会重叠 —— 同一条消息落盘之后仍然待在环形缓冲里，重复会让人以为玩家说了两遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const TOKEN = 'room-chat-test-token-0123456789abcdef';
const DAY = 86400000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const line = (row) => JSON.stringify(row) + '\n';

/**
 * 起一个真的把房间管理端口打开的服务器，并且真的建一间房 —— 探针走的就是这条 HTTP 路。
 * `logs(dir)` 允许用例在服务器起来之前先占住日志目录（比如放一个同名文件把 readdir 顶回去）。
 */
async function lab(t, { mode = 'coop', chatEnabled = false, now = null, logs } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-room-chat-'));
  const logDir = logs ? logs(dir) : path.join(dir, 'logs');
  // ChatLog 只在自己第一次落盘时才建目录，这里先把壳建好，用例才有地方提前铺日志。
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, stateFile: 'off',
    MatchClass: StubMatch, chatEnabled, chatLogDir: logDir, roomAdminToken: TOKEN, roomAdminPort: 0 });
  assert.ok(srv.roomAdminUrl, '测试要真的把房间管理端口起起来（roomAdminToken + roomAdminPort）');
  // 房间的 createdAt 取自大厅的钟：要造「几天前建的房」，必须赶在建房之前把针拨回去。
  if (now != null) srv.lobby.now = () => now;
  const host = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(async () => {
    await host.close().catch(() => {});
    await srv.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('sp-room-chat-'));
    rmSync(dir, { recursive: true, force: true });
  });
  const welcome = await host.hello('房主甲');
  await host.request({ t: 'room.create', mode, difficulty: 'NORMAL' });
  const state = await host.waitFor('room.state');
  const caller = async (p, { method = 'GET', token = TOKEN } = {}) => {
    const response = await fetch(`${srv.roomAdminUrl}${p}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
  };
  return { srv, caller, code: state.code, host, welcome, dir, logDir };
}

test('聊天回看：真实聊天的落盘记录与环形缓冲合成一份，只算这次实例、不重不漏', async (t) => {
  const { srv, caller, code, host, welcome, logDir } = await lab(t, { mode: 'solo', chatEnabled: true });
  const room = srv.lobby.getRoom(code);
  await host.request({ t: 'room.start' });
  assert.equal((await host.request({ t: 'g.chat', text: '你好，博士' })).t, 'ok');
  await srv.chatLog.flush();
  // 上一间同码房间的记录：房间码复用之后它还躺在同一个日期文件里，只能靠 createdAt 挡掉。
  const stale = { at: new Date(room.createdAt - 60000).toISOString(), ip: '203.0.113.9',
    playerId: 'previous', name: '上一间房', roomCode: code, text: '边界之前的旧记录' };
  writeFileSync(path.join(logDir, `${dayKey(room.createdAt)}.jsonl`), line(stale), { flag: 'a' });

  const answer = await caller(`/api/rooms/${code}/chat`);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.code, code);
  assert.equal(answer.body.roomId, room.roomId);
  assert.equal(answer.body.createdAt, room.createdAt);
  assert.equal(answer.body.limit, 100);
  assert.equal(answer.body.truncated, false);
  assert.equal(answer.body.partial, false);
  assert.ok(answer.body.serverNow >= room.createdAt);
  // 环形缓冲里还留着同一条消息，日志里也有一份：合成后只能出现一次，而且带的是落盘那份的 IP。
  assert.equal(answer.body.messages.length, 1, JSON.stringify(answer.body.messages));
  const [message] = answer.body.messages;
  assert.equal(message.text, '你好，博士');
  assert.equal(message.playerId, welcome.playerId);
  assert.equal(message.name, '房主甲');
  assert.match(String(message.ip), /127\.0\.0\.1|::1/);
  assert.ok(message.at >= room.createdAt && message.at <= answer.body.serverNow);

  // 码的大小写不该变成两种结果：面板手里的码来自别处。
  const lower = await caller(`/api/rooms/${code.toLowerCase()}/chat`);
  assert.deepEqual(lower.body.messages, answer.body.messages);
});

test('聊天回看：按 at 升序、只留最新 limit 条、别的房间码与边界之前的都不算', async (t) => {
  const { srv, caller, code, logDir } = await lab(t);
  const room = srv.lobby.getRoom(code);
  const at = room.createdAt;
  const rows = [
    { at: new Date(at - 1000).toISOString(), roomCode: code, playerId: 'old', name: '上一间房', text: '边界之前', ip: '203.0.113.9' },
    { at: new Date(at + 1).toISOString(), roomCode: code, playerId: 'p1', name: '甲', text: '一', ip: '203.0.113.1' },
    { at: new Date(at + 3).toISOString(), roomCode: 'ZZZZ', playerId: 'p9', name: '丙', text: '别的房间', ip: '203.0.113.3' },
    { at: new Date(at + 2).toISOString(), roomCode: code, playerId: 'p2', name: '乙', text: '二', ip: '203.0.113.2' },
    { at: new Date(at + 4).toISOString(), roomCode: code, playerId: 'p1', name: '甲', text: '三', ip: '203.0.113.1' },
  ];
  // 最后一行是写一半崩掉的现场：坏一行不能连累它前面的那些。
  writeFileSync(path.join(logDir, `${dayKey(at)}.jsonl`), rows.map(line).join('') + '{"at":"2026-10-10T00');
  // 还没落盘的那条只在环形缓冲里，IP 只能是 null（那份记录里根本没有）。
  room.chatMessages.push({ t: 'm.chat', id: 99, playerId: 'p2', name: '乙', text: '四', at: at + 5 });

  const all = await caller(`/api/rooms/${code}/chat`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.messages.map((m) => m.text), ['一', '二', '三', '四']);
  assert.deepEqual(all.body.messages.map((m) => m.at), [at + 1, at + 2, at + 4, at + 5]);
  assert.deepEqual(all.body.messages.map((m) => m.ip), ['203.0.113.1', '203.0.113.2', '203.0.113.1', null]);
  assert.equal(all.body.truncated, false);
  assert.equal(all.body.partial, false);

  // 上限截的是最旧的那几条，而不是随便几条。
  const newest = await caller(`/api/rooms/${code}/chat?limit=2`);
  assert.deepEqual(newest.body.messages.map((m) => m.text), ['三', '四']);
  assert.equal(newest.body.limit, 2);
  assert.equal(newest.body.truncated, true);

  const exact = await caller(`/api/rooms/${code}/chat?limit=4`);
  assert.equal(exact.body.messages.length, 4);
  assert.equal(exact.body.truncated, false, '刚好够装下时不算截断');

  // 上面的精确比对已经说明：别的房间码那条（'别的房间'）没混进来，边界之前那条也没。
  const other = await caller('/api/rooms/QQQQ/chat');
  assert.equal(other.status, 404);
});

test('聊天回看：已归档成 .gz 的日期照样读得出来', async (t) => {
  const past = Date.now() - 3 * DAY;
  const { srv, caller, code, logDir } = await lab(t, { now: past });
  const room = srv.lobby.getRoom(code);
  assert.equal(room.createdAt, past, '房间建在三天前，实例边界就该落在三天前');
  const rows = [
    { at: new Date(past - 5000).toISOString(), roomCode: code, playerId: 'old', name: '上一间房', text: '边界之前', ip: '203.0.113.9' },
    { at: new Date(past + 1000).toISOString(), roomCode: code, playerId: 'p1', name: '甲', text: '三天前那句', ip: '203.0.113.1' },
  ];
  // 归档是 .gz、当天是明文；中间的日期即使没人说话也留一个空文件 —— 「没有文件」在端点眼里等同于那一天丢了。
  writeFileSync(path.join(logDir, `${dayKey(past)}.jsonl.gz`), gzipSync(rows.map(line).join('')));
  for (let day = past + DAY; day <= Date.now() + DAY; day += DAY) writeFileSync(path.join(logDir, `${dayKey(day)}.jsonl`), '');

  const answer = await caller(`/api/rooms/${code}/chat`);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.messages.map((m) => m.text), ['三天前那句']);
  assert.equal(answer.body.messages[0].ip, '203.0.113.1');
  assert.equal(answer.body.partial, false, '跨到的每天都有文件可读时不该自称不完整');
  assert.equal(answer.body.truncated, false);
});

test('聊天回看：房间不在与房间已销毁都只回 ROOM_NOT_FOUND，方法不对回 405 带 Allow', async (t) => {
  const { srv, caller, code } = await lab(t);
  const missing = await caller('/api/rooms/ZZZZ/chat');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'ROOM_NOT_FOUND' });

  // 形状不对的码压根不是这个端点的地址：白名单放行之后没有一条路由认领它，落到的是兜底的 405（既有的
  // 行为，别被这里顺手改掉），而且不带 Allow —— 405 说的「方法不对」在这儿其实只是「这儿没这条路由」。
  const malformed = await caller('/api/rooms/abc/chat');
  assert.equal(malformed.status, 405);
  assert.equal(malformed.headers.get('allow'), null);

  // 只读端点用 POST 打是最常见的手滑：405 必须把允许的方法说清楚。
  const wrong = await caller(`/api/rooms/${code}/chat`, { method: 'POST' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, HEAD');

  // 鉴权与其它管理端点一致：没有令牌就是 401，不是 404。
  assert.equal((await caller(`/api/rooms/${code}/chat`, { token: null })).status, 401);

  srv.lobby.disposeRoom(srv.lobby.getRoom(code), 'admin');
  const disposed = await caller(`/api/rooms/${code}/chat`);
  assert.equal(disposed.status, 404);
  assert.equal(disposed.body.error, 'ROOM_NOT_FOUND');
});

test('聊天回看：limit 只认 1..200 的整数，越界与畸形一律 INVALID_LIMIT', async (t) => {
  const { caller, code } = await lab(t);
  for (const value of ['0', '201', '-1', 'abc', '', '1.5', 'NaN']) {
    const response = await caller(`/api/rooms/${code}/chat?limit=${encodeURIComponent(value)}`);
    assert.equal(response.status, 400, `limit=${value}`);
    assert.deepEqual(response.body, { error: 'INVALID_LIMIT', min: 1, max: 200 });
  }
  // 两端都算合法，缺省是 100。
  for (const [query, expected] of [['', 100], ['?limit=1', 1], ['?limit=200', 200]]) {
    const response = await caller(`/api/rooms/${code}/chat${query}`);
    assert.equal(response.status, 200, query);
    assert.equal(response.body.limit, expected);
  }
});

test('聊天回看：日志读不出来时只交内存那一段，并如实标 partial', async (t) => {
  // 用一个同名文件占住日志目录：readdir 直接 ENOTDIR，模拟「日志读不了」。
  const { srv, caller, code } = await lab(t, { logs: (dir) => {
    const blocked = path.join(dir, 'logs');
    writeFileSync(blocked, 'not a directory');
    return blocked;
  } });
  const room = srv.lobby.getRoom(code);
  room.chatMessages.push({ t: 'm.chat', id: 1, playerId: 'p1', name: '甲', text: '还在内存里', at: room.createdAt + 10 });

  const answer = await caller(`/api/rooms/${code}/chat`);
  // 读盘失败不是 5xx、更不是 404：那间房还在，它刚才说的话也还在。
  assert.equal(answer.status, 200);
  assert.equal(answer.body.code, code);
  assert.equal(answer.body.roomId, room.roomId);
  assert.equal(answer.body.partial, true);
  assert.equal(answer.body.truncated, false);
  assert.deepEqual(answer.body.messages, [
    { at: room.createdAt + 10, playerId: 'p1', name: '甲', ip: null, text: '还在内存里' },
  ]);
});
