// 分享的 agent 模式（docs/design/portal-agent-wss.md §43.1 / §44.3）：游戏不直连中央，而是把「提交这间房」
// 交给本机 Agent 的桥接口，再用一个认证的状态查询收尾。
//
// 这一组测试盯的是 agent 模式与老 HMAC 路径**行为不同**的地方：
//   1) 结果可能是未知的（回执丢了）：必须回 202 + opId，而且同一个未定论的申请要复用 opId 而不是变成第二次
//      登记 —— 换一个 opId 重发在中央那边就是另一件事；
//   2) 浏览器不能从回执里推断「收录成功」：只有 registered:true 才算，被拒/未知各有各的处置；
//   3) 晚回执不能写进新房间：房主换房之后回来一个「A 房已收录」，界面不可以显示成「你现在的房间已收录」；
//   4) 公开探测是**本机缓存**，不因为每个浏览器打开页面就打一次中央。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPortalRoomHandler } from '../server/http/portalRoom.js';

const token = 'b'.repeat(32);
const bridgeToken = 'c'.repeat(48);
const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ROOM_ID = '22222222-2222-4222-8222-222222222222';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_URL = 'http://127.0.0.1:3900/';
const BRIDGE_HREF = `${AGENT_URL}internal/game/v1/publications`;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 一间房、一个在线房主，加一个可以逐案指定回应（或抛错）的假桥。 */
async function fixture(t, { mode = 'agent', respond, now: clock } = {}) {
  let at = 1800000000000;
  const room = { code: 'ABCD', hostId: 'host', roomId: ROOM_ID, disposed: false };
  const session = { playerId: 'host', connected: true };
  const calls = [];
  const handler = createPortalRoomHandler({
    registry: { byToken: (value) => value === token ? session : null },
    lobby: { roomOf: () => room, getRoomStatus: () => ({ joinable: true }) },
    mode, agentUrl: AGENT_URL, bridgeToken,
    ...(mode === 'legacy-http' ? { url: 'https://portal.example/', siteId: 'test', key: 'a'.repeat(64) } : {}),
    now: clock ?? (() => at),
    fetchImpl: async (target, options = {}) => {
      const url = target instanceof URL ? target : new URL(String(target));
      const call = { href: url.href, method: options.method ?? 'GET', headers: options.headers ?? {},
        body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      // 可用性探测打到 Agent 的根路径，不是桥：它不该产生任何一次中央往返。
      if (url.pathname === '/') return new Response(null, { status: 403 });
      return respond(call, calls);
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const command = (headers) => Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null));
  return {
    base, room, session, calls,
    advance: (ms) => { at += ms; },
    probe: (headers = {}) => fetch(`${base}/api/portal-room`, { headers: command(headers) }),
    post: (headers = {}) => fetch(`${base}/api/portal-room`, { method: 'POST',
      headers: command({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }),
      body: JSON.stringify({ code: 'ABCD' }) }),
    status: (query = '?code=ABCD', headers = {}) => fetch(`${base}/api/portal-room/status${query}`,
      { headers: command({ Authorization: `Bearer ${token}`, ...headers }) }),
    registered: (call) => json(200, { status: 'registered', registered: true, listingId: '33333333-3333-4333-8333-333333333333',
      roomId: call.body?.roomId ?? ROOM_ID, code: 'ABCD', expiresAt: at + 600_000, source: 'game', owned: false, replayed: false,
      opId: call.body?.opId ?? null }),
  };
}

const bridgeCalls = (calls) => calls.filter((call) => call.href.startsWith(BRIDGE_HREF));

test('agent 模式：提交走本机桥接口，回执必须 registered 才算收录', async (t) => {
  const f = await fixture(t, { respond: (call) => f.registered(call) });
  // 探测先走一遍：它只打到 Agent 的根路径，缓存起来的结论让每个浏览器打开房间页都不用再问一次。
  const probe = await (await f.probe()).json();
  assert.deepEqual(probe, { enabled: true, mode: 'agent', available: true });
  const response = await f.post();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.registered, true);
  assert.equal(body.status, 'registered');
  assert.equal(body.mode, 'agent');
  assert.equal(body.listingId, '33333333-3333-4333-8333-333333333333');
  assert.equal(body.remainingMs, 600_000);
  assert.match(body.opId, UUID_RE);

  const post = bridgeCalls(f.calls).find((call) => call.method === 'POST');
  assert.equal(post.href, BRIDGE_HREF);
  assert.equal(post.headers.Authorization, `Bearer ${bridgeToken}`);
  // 桥接凭据与玩家会话是两回事：玩家的 token 一个字节都不许进这条链路。
  assert.deepEqual(post.body, { code: 'ABCD', roomId: ROOM_ID, opId: body.opId, expiresInMs: 8000 });
  assert.ok(!JSON.stringify(post).includes(token));
});

test('结果未知：回 202 + opId，重发复用同一个 opId 而不是变成第二次申请', async (t) => {
  const f = await fixture(t, { respond: (call) => json(202,
    { status: 'pending', code: 'TIMEOUT', retryable: false, opId: call.body.opId }) });
  const first = await f.post();
  assert.equal(first.status, 202);
  const pending = await first.json();
  assert.equal(pending.ok, false);
  assert.equal(pending.status, 'pending');
  assert.match(pending.opId, UUID_RE);
  // 一分钟冷却与十分钟有效期是两件事（§43.5）：冷却期内重发直接被拒，但 opId 还在。
  assert.equal((await f.post()).status, 429);
  f.advance(61_000);
  const again = await f.post();
  assert.equal(again.status, 202);
  const posts = bridgeCalls(f.calls).filter((call) => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.opId, posts[0].body.opId, '同一个未定论的申请必须复用 opId');
});

test('桥接报错：翻译成业务处置，确定被拒后下一次点击是新申请', async (t) => {
  const cases = [['ROOM_NOT_JOINABLE', 409], ['LISTING_LIMIT', 429], ['SHARE_UNAVAILABLE', 503],
    ['AGENT_OFFLINE', 503], ['SOMETHING_NEW', 502]];
  for (const [code, expected] of cases) {
    const f = await fixture(t, { respond: () => json(409, { status: 'rejected', code, retryable: true }) });
    const response = await f.post();
    assert.equal(response.status, expected, code);
    const body = await response.json();
    assert.equal(body.status, 'rejected');
    assert.equal(body.registered, false);
    assert.equal(body.code, code);
    assert.ok(body.error && !body.error.includes('rejected'), '给玩家的是文案，不是协议码');
    assert.ok(!JSON.stringify(body).includes(bridgeToken));
  }
  // 确定被拒 → 忘掉 opId（同一个 opId 换个内容会被中央判冲突）；冷却过后是新申请。
  const f = await fixture(t, { respond: () => json(409, { status: 'rejected', code: 'ROOM_NOT_JOINABLE', retryable: false }) });
  await f.post();
  f.advance(61_000);
  await f.post();
  const posts = bridgeCalls(f.calls).filter((call) => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].body.opId, posts[1].body.opId);
});

test('晚回执不写进新房间：房主换房之后拿到的是「房间已变化」', async (t) => {
  let resolveBridge, entered;
  const blocked = new Promise((resolve) => { resolveBridge = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { respond: async (call) => { entered(); await blocked; return f.registered(call); } });
  const pending = f.post();
  await started;
  // 提交已经发出（实例号也就已经绑定好了），房间这时才被换成了另一个实例（同码复用）。
  f.room.roomId = OTHER_ROOM_ID;
  resolveBridge();
  const response = await pending;
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.registered, false);
  assert.equal(body.code, 'ROOM_CHANGED');
  assert.equal(body.listingId, '33333333-3333-4333-8333-333333333333', 'opId/listingId 要还给页面，它还得能去查');
  assert.match(body.opId, UUID_RE);
});

test('状态查询：三态、opId 复用、以及只认当前房主', async (t) => {
  const LISTING = '33333333-3333-4333-8333-333333333333';
  let answer = 'absent';
  const f = await fixture(t, { respond: (call) => {
    if (call.method === 'POST') return json(202, { status: 'pending', code: 'TIMEOUT', retryable: false, opId: call.body.opId });
    if (answer === 'absent') return json(200, { status: 'absent', found: false, registered: false, ended: false });
    if (answer === 'ended') return json(200, { status: 'ended', found: true, registered: false, ended: true });
    return json(200, { status: 'registered', found: true, registered: true, listingId: LISTING,
      roomId: ROOM_ID, code: 'ABCD', expiresAt: 1800000300000, source: 'game', owned: false });
  } });
  assert.deepEqual(await (await f.status()).json(), { enabled: true, state: 'absent', registered: false, code: 'ABCD' });
  const query = bridgeCalls(f.calls).find((call) => call.method === 'GET');
  assert.equal(query.href, `${BRIDGE_HREF}?code=ABCD`, '手里还没有 opId 时按房间码查');

  f.advance(61_000);
  const posted = await (await f.post()).json();
  answer = 'registered';
  const registered = await (await f.status()).json();
  assert.equal(registered.state, 'registered');
  assert.equal(registered.registered, true);
  assert.equal(registered.listingId, LISTING);
  assert.equal(registered.remainingMs, 239_000, '剩余时间按游戏自己的时钟算');
  const withOpId = bridgeCalls(f.calls).filter((call) => call.method === 'GET').at(-1);
  assert.equal(withOpId.href, `${BRIDGE_HREF}/${posted.opId}?code=ABCD`, '待确认的那次申请要按 opId 查');

  // 查成 ended：确定已结束，页面据此显示「已撤回或过期」。
  answer = 'ended';
  assert.deepEqual(await (await f.status()).json(), { enabled: true, state: 'ended', registered: false, code: 'ABCD' });

  // 认证：没有会话、不是房主、码不对、跨站，全部拒绝。
  assert.equal((await f.status('?code=ABCD', { Authorization: null })).status, 401);
  f.session.playerId = 'guest';
  assert.equal((await f.status()).status, 403);
  f.session.playerId = 'host';
  assert.equal((await f.status('?code=EFGH')).status, 409);
  assert.equal((await f.status('?code=ABCD', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.status('?code=ABCD', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('状态查询：桥不可用时是「未知」，不是「没登记」', async (t) => {
  const f = await fixture(t, { respond: () => { throw Object.assign(new Error('boom'), { code: 'AGENT_OFFLINE' }); } });
  const response = await f.status();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.state, 'unknown');
  assert.equal(body.code, 'AGENT_OFFLINE');
  // 提交也一样：连桥都没走通时不能报「被拒」，只能报结果待确认 —— agent 可能已经转给中央了。
  f.advance(61_000);
  const posted = await f.post();
  assert.equal(posted.status, 202);
  assert.equal((await posted.json()).status, 'pending');
  assert.match((await (await f.status()).json()).state, /pending|unknown/);
});

test('可用性探测有缓存、有单飞，失败后立刻转成「暂不可用」', async (t) => {
  const f = await fixture(t, { respond: () => json(200, { status: 'absent', found: false, registered: false }) });
  const probes = () => f.calls.filter((call) => call.href === AGENT_URL).length;
  f.calls.length = 0;
  await Promise.all([f.probe(), f.probe(), f.probe()]);
  assert.equal(probes(), 1, '缓存过期也不让并发的浏览器探测各打一次');
  assert.deepEqual(await (await f.probe()).json(), { enabled: true, mode: 'agent', available: true });

  // 真实提交遇到 AGENT_OFFLINE：可用性立刻翻成 false，不等下一次缓存过期，而且记住原因。
  const offline = await fixture(t, { respond: () => { throw Object.assign(new Error('down'), { code: 'AGENT_OFFLINE' }); } });
  await offline.post();
  const probe = await (await offline.probe()).json();
  assert.equal(probe.available, false);
  assert.equal(probe.reason, 'AGENT_OFFLINE');

  // 缓存窗口内不再探测；窗口过后探测，Agent 回来就恢复。
  const before = offline.calls.filter((call) => call.href === AGENT_URL).length;
  await offline.probe();
  assert.equal(offline.calls.filter((call) => call.href === AGENT_URL).length, before);
  offline.advance(16_000);
  await offline.probe();
  assert.equal(offline.calls.filter((call) => call.href === AGENT_URL).length, before + 1);
});

test('legacy-http 与 off 模式下状态查询如实说明不支持，不编造登记结果', async (t) => {
  const legacy = await fixture(t, { mode: 'legacy-http', respond: () => json(200, {}) });
  const response = await legacy.status();
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.mode, 'legacy-http');
  assert.equal(body.state, undefined, '不猜一个「没登记」：老路径的界面用的是旧的成功/失败语义');
  const off = await fixture(t, { mode: 'off', respond: () => json(200, {}) });
  assert.equal((await off.status()).status, 503);
  assert.equal((await (await off.probe()).json()).enabled, false);
});
