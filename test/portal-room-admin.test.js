// 联机站（Agent）私有入口与房间实例号（docs/design/portal-agent-wss.md §13.1 / §13.3）。
//
// 这一组端点只有本机 Agent 用得上，但它们的每条判断都直接决定中央那边会发生什么：实例号回答「这个房间码现在
// 是不是那间房」（房间码被复用 = 旧登记必须被丢掉），状态回答「这间房现在能不能加入」，而 closed / 查不到 的
// 区别决定中央是删掉一条登记还是只把它标成未知。所以这里钉的是：形状、上限、鉴权、以及「一个玩家名字都不
// 许出现在跨机投影里」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { snapshotServer, restoreServer } from '../server/persist.js';
import { TestClient } from './helpers/wsClient.js';

const TOKEN = 'test-room-admin-token-0123456789';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const listingId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function lab(t) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch,
    roomAdminPort: 0, roomAdminToken: TOKEN });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.close())); await srv.close(); });
  assert.ok(srv.roomAdminUrl, '测试里要真的把房间管理端口起起来（roomAdminToken + roomAdminPort）');
  /** 打房间管理端口的请求（探针走的就是这一条）。 */
  const caller = async (path, { method = 'GET', body = null, token = TOKEN } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(`${srv.roomAdminUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const host = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(host);
  await host.hello('房主甲');
  await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const state = await host.waitFor('room.state');
  return { srv, caller, code: state.code, host };
}

test('房间实例号：新房间就有、公开与私有状态给的是同一枚、跨重启不变、旧档补一枚', async (t) => {
  const { srv, caller, code } = await lab(t);
  const live = srv.lobby.getRoom(code);
  assert.match(live.roomId, UUID_RE);

  // 大厅自己的公开房间视图也带实例号：前端靠它区分「我的房还在」与「这个码被别人的新房间占了」。
  const publicStatus = await (await fetch(`${srv.url}/api/rooms/${code}/status`)).json();
  assert.equal(publicStatus.roomId, live.roomId);
  assert.equal((await caller(`/api/portal/rooms/${code}/status`)).body.roomId, live.roomId);

  // 存档往返：实例号跟着房间走（重启不该读成「换了一间房」，那会丢掉它的登记）。
  const now = Date.now();
  const doc = snapshotServer({ registry: srv.registry, lobby: srv.lobby, now });
  assert.equal(doc.rooms.find((r) => r.code === code).roomId, live.roomId);
  const registry2 = new SessionRegistry();
  const lobby2 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  restoreServer({ doc, registry: registry2, lobby: lobby2, now: now + 1000, log: quietLog });
  assert.equal(lobby2.getRoom(code)?.roomId, live.roomId);

  // 旧档（这个字段还没写进去的那些）补一枚新的，而不是留 undefined —— 一个 undefined 实例号会让「房间码是否
  // 被复用」永远判不出来，而那条判断是分享链路唯一的防线。
  const legacy = { ...doc, rooms: doc.rooms.map(({ roomId, ...rest }) => rest) };
  const lobby3 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  restoreServer({ doc: legacy, registry: registry2, lobby: lobby3, now: now + 1000, log: quietLog });
  assert.match(lobby3.getRoom(code)?.roomId, UUID_RE);
  assert.notEqual(lobby3.getRoom(code).roomId, live.roomId, '补的是新实例号，不是把旧值猜回来');
});

test('私有状态端点：ok 带实例号与精简投影，closed 是「问过了没有」而不是 404', async (t) => {
  const { srv, caller, code } = await lab(t);
  const ok = await caller(`/api/portal/rooms/${code}/status`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, 'ok');
  assert.equal(ok.body.roomId, srv.lobby.getRoom(code).roomId);
  assert.match(String(ok.body.gameBootId), UUID_RE);
  assert.equal(ok.body.room.code, code);
  assert.equal(ok.body.room.mode, 'coop');
  assert.equal(ok.body.room.capacity, 4);
  assert.equal(ok.body.room.humans, 1);
  assert.equal(ok.body.room.joinable, true);
  assert.equal(ok.body.room.inMatch, false);
  // 这个投影要跨机送到中央、再进面板与公开房间列表：座位名、玩家 id、IP、配装一个都不能有。
  const text = JSON.stringify(ok.body);
  assert.equal(text.includes('房主甲'), false, '玩家名字不能被投影');
  assert.equal('seats' in ok.body.room, false);
  assert.equal(/playerId|token|addr|loadout/.test(text), false);

  // 不存在的房间：200 + closed。用 404 表达「没有」会让调用方把「查询失败」与「确认不存在」混在一起，
  // 而后者会让中央删掉一条其实还在的登记。
  const missing = await caller('/api/portal/rooms/ZZZZ/status');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { state: 'closed', roomId: null });

  // 房间码只在形状上收紧（四位大写字母），大小写与尾巴上的空格不该变成两种结果。
  assert.equal((await caller(`/api/portal/rooms/${code.toLowerCase()}/status`)).body.state, 'ok');
});

test('私有状态端点：鉴权与路由白名单都收得住', async (t) => {
  const { caller, code } = await lab(t);
  assert.equal((await caller(`/api/portal/rooms/${code}/status`, { token: 'x'.repeat(32) })).status, 401);
  assert.equal((await caller(`/api/portal/rooms/${code}/status`, { token: null })).status, 401);
  // 白名单只多放了一行 /api/portal/rooms*：别的路径照旧 404，公开状态端点的路径也不在这个端口上。
  assert.equal((await caller('/api/portal/other')).status, 404);
  assert.equal((await caller('/api/portal/rooms/ABCD/whatever')).status, 405);
  // 方法不对给 405 并带 Allow（`POST` 打单房间状态是常见的手滑）。
  const wrong = await caller(`/api/portal/rooms/${code}/status`, { method: 'POST' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.body.error, 'METHOD_NOT_ALLOWED');
});

test('批量状态：只回答问到的那些码，20 条上限，畸形条目整批拒', async (t) => {
  const { srv, caller, code } = await lab(t);
  const batch = (items) => caller('/api/portal/rooms/status-batch', { method: 'POST', body: { items } });

  const answer = await batch([{ listingId: listingId(1), code }, { listingId: listingId(2), code: 'ZZZZ' }]);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.rooms.length, 2);
  assert.equal(answer.body.rooms[0].state, 'ok');
  assert.equal(answer.body.rooms[0].listingId, listingId(1));
  assert.equal(answer.body.rooms[0].roomId, srv.lobby.getRoom(code).roomId);
  assert.equal(answer.body.rooms[0].room.code, code);
  assert.equal(answer.body.rooms[0].room.joinable, true);
  // 不存在的房间在批里也是明确的 closed（不是缺项、不是 unknown）：缺项只能由 Agent 翻译成未知。
  assert.deepEqual(answer.body.rooms[1], { listingId: listingId(2), state: 'closed', roomId: null });
  assert.match(String(answer.body.gameBootId), UUID_RE);
  assert.equal((await caller(`/api/portal/rooms/${code}/status`)).body.gameBootId, answer.body.gameBootId);

  // 上限 20（§12.4）：超了整批拒，而不是悄悄截断前二十条。
  const many = Array.from({ length: 21 }, (_, i) => ({ listingId: listingId(10 + i), code }));
  assert.equal((await batch(many)).status, 400);
  assert.equal((await batch(many.slice(0, 20))).status, 200);

  // 形状不对、重复 listingId、空数组：一律 400。悄悄跳过一条会让对面把「本机确认不存在」和「你没问我」混起来。
  for (const bad of [[], [{ listingId: 'nope', code }], [{ listingId: listingId(1), code: 'abc' }],
    [{ listingId: listingId(1), code }, { listingId: listingId(1), code: 'ZZZZ' }], [{ code }]]) {
    const rejected = await batch(bad);
    assert.equal(rejected.status, 400, JSON.stringify(bad));
    assert.equal(rejected.body.error, 'INVALID_ITEMS');
  }
  const wrongMethod = await caller('/api/portal/rooms/status-batch');
  assert.equal(wrongMethod.status, 405);
});

test('gameBootId 与房间列表：探针读的字段在同一份响应里就有', async (t) => {
  const { srv, caller, code } = await lab(t);
  const config = await caller('/api/room-config');
  assert.equal(config.status, 200);
  assert.match(String(config.body.gameBootId), UUID_RE);
  // 探针在 /api/room-config 上读 gameBootId 与配置版本，在 /api/rooms 上读房间列表：三者必须是同一个进程的同一份事实。
  assert.equal((await caller(`/api/portal/rooms/${code}/status`)).body.gameBootId, config.body.gameBootId);
  const list = await caller('/api/rooms');
  assert.equal(list.status, 200);
  assert.equal(list.body.rooms[0].roomId, srv.lobby.getRoom(code).roomId);
  assert.equal(list.body.rooms[0].code, code);
});
