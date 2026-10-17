// lane 里的对局：worker 已经算好的字节与增量帧必须原样走到 socket，不能在主线程上再序列化一遍。
// 这条缝曾经是断的 —— startRemoteMatch 的 send/broadcast 钩子丢掉了第三个参数，于是每个 m.public 都被
// JSON.stringify 一次（Proxy 还会为此把 worker 编码好的字符串重新 parse），worker 算好的 delta 帧也因为
// 「编码串不匹配」而被丢弃（stateTransport.attachedWorkerFrame 只认同一个字符串）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { attachWorkerState, attachedWorkerFrame, negotiateStateDelta, prepareStateFrame, stateDeltaStats } from '../server/stateTransport.js';
import { STATE_DELTA_VERSION } from '../shared/stateDelta.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function lobbyWithRoom() {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quiet });
  lobby.broadcastState = () => {};
  const session = registry.create('Alice');
  session.connected = true;
  session.ws = { readyState: 1, bufferedAmount: 0, send() {} };
  lobby.create(session, { mode: 'coop', difficulty: 'NORMAL' });
  const room = lobby.rooms.get(session.roomCode);
  const ctx = { live: true, ended: false, disposed: false, match: {}, lastPublic: null, status: null, sharedResult: null, results: new Map(), workerPoolKey: room.code };
  return { registry, lobby, session, room, ctx };
}

test('广播：给进来的字节就是发出去的字节（不再主线程序列化）', () => {
  const { lobby, room, ctx } = lobbyWithRoom();
  const msg = { t: 'm.public', phase: 'PREP' };
  const encoded = '{"t":"m.public","phase":"PREP"}';
  const data = lobby.broadcastRoom(room, msg, encoded);
  assert.equal(data, encoded, 'the lane\'s bytes survive unchanged');
  assert.equal(ctx.lastPublic ?? null, null, 'matchBroadcast writes the replay slot, not broadcastRoom');
  lobby.matchBroadcast(room, ctx, msg, encoded);
  assert.equal(ctx.lastPublic, encoded, 'and the replay keeps exactly those bytes');
  lobby.shutdown('test');
});

test('增量帧：worker 的帧与本地基线对得上就用它，对不上就本地算（都不会发出不一致的帧）', () => {
  const { lobby } = lobbyWithRoom();
  const ws = {};
  negotiateStateDelta(ws, STATE_DELTA_VERSION);
  const first = '{"t":"m.public","phase":"PREP","round":1}';
  const second = '{"t":"m.public","phase":"PREP","round":2}';
  const msg1 = attachWorkerState({ t: 'm.public' }, first, { seq: 1, base: undefined, delta: null });
  const frame1 = prepareStateFrame(ws, msg1, first);
  frame1.commit();
  assert.equal(attachedWorkerFrame(msg1, first)?.seq, 1, 'the worker frame is attached to that exact encoding');

  const msg2 = attachWorkerState({ t: 'm.public' }, second, { seq: 2, base: 1, delta: '{"t":"m.state","kind":"m.public","seq":2,"base":1,"patch":[]}' });
  const frame2 = prepareStateFrame(ws, msg2, second);
  assert.match(String(frame2.data), /"kind":"m.public"/, 'a state frame carries its kind');
  assert.match(String(frame2.data), /"base":\d+/, 'delta frames name the frame they apply to');
  const parsed = JSON.parse(String(frame2.data));
  assert.equal(parsed.base, JSON.parse(String(frame1.data)).seq, 'the delta bases on the frame this socket last got');
  assert.equal(attachedWorkerFrame(msg2, second)?.delta.startsWith('{"t":"m.state"'), true);
  assert.equal(attachedWorkerFrame(msg2, '{"t":"m.public"}'), null, 'a different encoding never matches');
  lobby.shutdown('test');
  assert.ok(stateDeltaStats.frames >= 2);
});

test('发到席位：编码串也一路带下去', () => {
  const { lobby, room, session, ctx } = lobbyWithRoom();
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data) => sent.push(String(data)) };
  session.ws = ws;
  const encoded = '{"t":"m.private","x":1}';
  assert.equal(lobby.sendToPlayer(room, session.playerId, { t: 'm.private', x: 1 }, encoded), true);
  assert.deepEqual(sent, [encoded]);
  lobby.shutdown('test');
});
