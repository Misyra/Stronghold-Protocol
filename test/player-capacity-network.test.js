// test/player-capacity-network.test.js — 扩编房间的网络面 (playerCapacityVersion 门, shared/playerCapacity.js):
// 旧版客户端守住普通房间, 进不了/观不了扩编房; 携带旧 token 的旧版重连不能顶掉兼容中的现代连接
// (net.js helloAdmission → server/lobby.js); party 排队要求非房主先就绪。移植自用户分支同名测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';

async function setup(t) {
  class FixtureMatch {
    constructor(options) { this.options = options; }
    start() { this.options.broadcast({ t: 'm.public', phase: 'INFO_CHECK' }); }
    onLeave() {} onDisconnect() {} onReconnect() {} dispose() {}
  }
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, stateFile: 'off', workers: 0, MatchClass: FixtureMatch });
  const clients = [];
  t.after(async () => { for (const c of clients) c.socket.terminate(); await server.close(); });
  async function client() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`), frames = [], pending = new Map();
    let rid = 0;
    socket.on('error', () => {});
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); frames.push(message);
      const work = pending.get(message.rid); if (!work) return;
      pending.delete(message.rid); clearTimeout(work.timer); work.resolve(message);
    });
    socket.on('close', () => { for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error('fixture socket closed')); } pending.clear(); });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const request = (type, fields = {}) => new Promise((resolve, reject) => {
      const id = ++rid, timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture timeout')); }, 6000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ t: type, ...fields, rid: id }));
    });
    const c = { socket, frames, request }; clients.push(c); return c;
  }
  const hello = (c, name, modern = true, token) => c.request('hello', { name, version: 1, matchmakingVersion: MATCHMAKING_VERSION,
    ...(modern ? { playerCapacityVersion: PLAYER_CAPACITY_VERSION } : {}), ...(token ? { token } : {}) });
  return { client, hello };
}

test('legacy clients keep ordinary rooms, but cannot join or observe expanded rooms', async t => {
  const f = await setup(t), legacy = await f.client(), host = await f.client();
  assert.equal((await f.hello(legacy, 'Legacy', false)).t, 'welcome');
  assert.equal((await legacy.request('room.create', { mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  assert.equal((await legacy.request('room.leave')).t, 'ok');
  assert.equal((await f.hello(host, 'Modern')).t, 'welcome');
  assert.equal((await host.request('room.create', { mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const code = host.frames.findLast(frame => frame.t === 'room.state').code;
  const options = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 };
  assert.equal((await host.request('room.setExperimental', { experimental: options })).t, 'ok');
  for (const type of ['room.join', 'room.spectate']) assert.equal((await legacy.request(type, { code })).code, ERR.BAD_MSG);
  assert.equal((await legacy.request('room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: options })).code, ERR.BAD_MSG);
  assert.equal(host.frames.findLast(frame => frame.t === 'room.state').seats.filter(Boolean).length, 1);
});

test('legacy reconnect into an expanded room cannot replace or mutate the modern owner connection', async t => {
  const f = await setup(t), modern = await f.client();
  const welcome = await f.hello(modern, 'Owner');
  await modern.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
  await modern.request('room.setExperimental', { experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 } });
  const legacy = await f.client(), denied = await f.hello(legacy, 'OldOwner', false, welcome.token);
  assert.equal(denied.code, ERR.BAD_MSG); assert.equal(modern.socket.readyState, WebSocket.OPEN);
  assert.equal((await modern.request('ping', { c: 1 })).t, 'pong');
  const repeat = await f.hello(modern, 'Owner', true, welcome.token);
  assert.equal(repeat.t, 'welcome'); assert.equal(repeat.playerId, welcome.playerId);
  assert.equal(modern.frames.findLast(frame => frame.t === 'room.state').seats[0].name, 'Owner');
});

test('party queue rejects an unready peer without a ticket, then admits the ready party', async t => {
  const f = await setup(t), host = await f.client(), peer = await f.client();
  await f.hello(host, 'PartyHost'); await f.hello(peer, 'PartyPeer');
  await host.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
  const code = host.frames.findLast(frame => frame.t === 'room.state').code;
  await peer.request('room.join', { code });
  assert.equal((await host.request('queue.join', { difficulty: 'NORMAL', party: true })).code, ERR.NOT_READY);
  assert.ok(!host.frames.some(frame => frame.t === 'queue.state' && (frame.state === 'queued' || frame.ticketId)));
  assert.equal((await peer.request('room.ready', { ready: true })).t, 'ok');
  assert.equal((await host.request('queue.join', { difficulty: 'NORMAL', party: true })).t, 'ok');
  assert.ok(host.frames.some(frame => frame.t === 'queue.state' && frame.state === 'queued' && frame.ticketId));
});
