// Ported from xinhai-ai/Stronghold-Protocol commit 23d0a929 (test/ws-latency.test.js, GPL-3.0-or-later),
// adapted to fake sockets and this repository's entry points: broadcastAll (we have no Network.broadcast)
// and close() (we have no draining / beginShutdown). Real setImmediate — no fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Network, SessionRegistry, send, sendRaw, sendSession, NET_DEFAULTS } from '../server/net.js';
import { Room } from '../server/lobby.js';
import { createSessionStack } from '../server/http/websocket.js';
import { negotiateStateDelta } from '../server/stateTransport.js';
import { StateReceiver } from '../shared/stateDelta.js';

function socket(network) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.frames = [];
  ws.pings = 0;
  ws.send = (data, callback) => { ws.frames.push(JSON.parse(data)); callback?.(); };
  ws.ping = () => { ws.pings++; };
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  ws.terminate = ws.close;
  // No req: clientAddress(undefined) → { ip: '?', key: null } — admission-free local test socket.
  network.handleConnection(ws);
  return ws;
}

/** Yield through real setImmediates until every queued fanout job has drained. */
async function drain(network) {
  for (let n = 0; (network._fanout.length || network._outbound.size) && n < 1000; n++) await nextTurn();
  assert.equal(network._fanout.length, 0);
  assert.equal(network._outbound.size, 0);
}

test('2500-socket broadcastAll yields to requests, preserves per-socket order, and skips closed sockets', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 2500 }, () => socket(network));
  network.broadcastAll({ t: 'first' });
  // The pump visits at most one 128-socket slice synchronously; the rest is deferred to setImmediate.
  assert.ok(sockets.filter((s) => s.frames.length).length <= 128);
  assert.equal(sockets.at(-1).frames.length, 0);
  sockets.at(-1).emit('message', Buffer.from('{"t":"ping","c":123,"rid":1}'), false);
  assert.equal(sockets.at(-1).frames[0].t, 'pong', 'a request runs before the broadcast finishes');
  const removed = sockets[1000];
  removed.close();
  network.broadcastAll({ t: 'second' });
  await drain(network);
  for (const ws of sockets) {
    if (ws === removed) { assert.deepEqual(ws.frames, []); continue; }
    assert.deepEqual(ws.frames.filter((m) => m.t !== 'pong').map((m) => m.t), ['first', 'second']);
  }
  assert.equal(network.diagnostics.stats().handlerMs.ping.count, 1);
});

test('batched heartbeat checks each socket once, retains pong liveness, and stops after close', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 300 }, () => socket(network));
  network.heartbeat();
  network.heartbeat(); // overlapping calls do not ping the first batch twice
  await drain(network);
  assert.ok(sockets.every((s) => s.pings === 1));
  sockets[0].emit('pong');
  network.heartbeat();
  await drain(network);
  assert.equal(sockets[0].pings, 2);
  assert.ok(sockets.slice(1).every((s) => s.readyState === 3));
  network.close();
  network.heartbeat();
  assert.equal(sockets[0].pings, 2);
});

test('closing flushes reliable queued frames and releases deferred recipients', async () => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  const sockets = Array.from({ length: 300 }, () => socket(network));
  network.broadcastAll({ t: 'notice' });
  network.close();
  await nextTurn();
  assert.deepEqual(sockets.at(-1).frames, [{ t: 'notice' }]);
  assert.equal(network._fanout.length, 0);
  assert.equal(network._fanoutImmediate, null);
  assert.equal(network._outbound.size, 0);
  assert.equal(network._outboundImmediate, null);
});

test('many six-member rooms share a send budget; states, private views and results remain FIFO and isolated', async (t) => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const { registry, lobby, network } = createSessionStack({}, { data: {}, log });
  t.after(() => { network.close(); lobby.shutdown('shutdown'); });
  const rooms = Array.from({ length: 60 }, (_, i) => {
    const room = new Room(`R${String(i).padStart(3, '0')}`, 'coop', 'NORMAL', Date.now());
    lobby.rooms.set(room.code, room);
    const members = Array.from({ length: 6 }, (_, seat) => {
      const ws = socket(network), session = registry.create(`Player${i}_${seat}`);
      Object.assign(session, { ws, connected: true, roomCode: room.code });
      const member = { seat, playerId: session.playerId, name: session.name, connected: true, isBot: false, left: false, ready: false };
      if (seat < 4) room.seats[seat] = member;
      else room.spectators.push(member);
      const delta = seat !== 1;
      if (delta) negotiateStateDelta(ws, 1);
      return { ws, session, delta, spectator: seat >= 4 };
    });
    return { room, members };
  });
  for (const { room, members } of rooms) {
    lobby.broadcastState(room);
    const first = { t: 'm.public', room: room.code, n: 0, stable: 'x'.repeat(600) };
    assert.equal(lobby.broadcastRoom(room, first), JSON.stringify(first));
    for (const { session, spectator } of members) if (!spectator) {
      assert.equal(lobby.sendToPlayer(room, session.playerId, { t: 'm.private', playerId: session.playerId, n: 0 }), true);
    }
    lobby.broadcastRoom(room, { ...first, n: 1 });
    lobby.broadcastRoom(room, { t: 'm.result', room: room.code });
    room.difficulty = 'HARD';
    lobby.broadcastState(room);
    lobby.broadcastRoom(room, { ...first, n: 2 });
  }
  assert.ok(rooms.flatMap((r) => r.members).reduce((n, m) => n + m.ws.frames.length, 0) <= 128,
    'small broadcasts across different rooms must not reset the per-turn budget');
  assert.ok(network._outbound.size > 0);
  const last = rooms.at(-1).members.at(-1).ws;
  last.emit('message', Buffer.from('{"t":"ping","c":123,"rid":1}'), false);
  assert.equal(last.frames[0].t, 'pong', 'transport probes remain responsive during room broadcasts');
  await drain(network);
  for (const { room, members } of rooms) for (const { ws, session, delta, spectator } of members) {
    const receiver = new StateReceiver();
    const frames = ws.frames.filter((m) => m.t !== 'pong');
    const decoded = frames.map((m) => m.t === 'm.state' ? receiver.receive(m).message : m);
    const expected = ['room.state', 'm.public', ...(!spectator ? ['m.private'] : []), 'm.public', 'm.result', 'room.state', 'm.public'];
    assert.deepEqual(decoded.map((m) => m.t), expected);
    assert.deepEqual(decoded.filter((m) => m.t === 'm.public').map((m) => [m.room, m.n]), [[room.code, 0], [room.code, 1], [room.code, 2]]);
    assert.deepEqual(decoded.filter((m) => m.t === 'room.state').map((m) => m.difficulty), ['NORMAL', 'HARD']);
    for (const m of decoded.filter((m) => m.t === 'm.private')) assert.equal(m.playerId, session.playerId);
    if (delta) {
      const states = frames.filter((m) => m.kind === 'm.public');
      assert.ok(states[0].full && states[1].patch && states[2].full, 'results reset the baseline in wire order');
    }
  }
});

test('a deferred send captures its socket and encoding; close/rebind cannot leak old room frames', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 300 }, () => socket(network));
  network.broadcastAll({ t: 'm.ticker', text: 'old room' });
  const old = sockets.at(-1), session = { connected: true, ws: old };
  sendSession(session, { t: 'm.private', secret: 'old' });
  old.close();
  assert.equal(network._outbound.has(old), false);
  session.ws = socket(network);
  const msg = { t: 'm.public', n: 1 };
  sendSession(session, msg);
  msg.n = 999;
  await drain(network);
  assert.deepEqual(old.frames, []);
  assert.deepEqual(session.ws.frames, [{ t: 'm.public', n: 1 }]);
});

test('resync queued behind broadcast states still supplies a full recovery baseline', async (t) => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const { registry, lobby, network } = createSessionStack({}, { data: {}, log });
  t.after(() => { network.close(); lobby.shutdown('shutdown'); });
  Array.from({ length: 300 }, () => socket(network));
  const ws = socket(network), session = registry.create('Recovery');
  Object.assign(session, { ws, connected: true, roomCode: 'ROOM' });
  const room = new Room('ROOM', 'solo', 'NORMAL', Date.now());
  room.seats[0] = { seat: 0, playerId: session.playerId, name: session.name, connected: true, isBot: false, left: false, ready: false };
  lobby.rooms.set(room.code, room);
  negotiateStateDelta(ws, 1);
  const state = { t: 'm.public', n: 0, stable: 'x'.repeat(600) };
  network.broadcastAll({ t: 'm.ticker', text: 'busy' });
  lobby.broadcastRoom(room, state);
  lobby.broadcastRoom(room, { ...state, n: 1 });
  room.match = { onReconnect() { lobby.sendToPlayer(room, session.playerId, { ...state, n: 2 }); } };
  lobby.runResync(session);
  await drain(network);
  const states = ws.frames.filter((m) => m.kind === 'm.public');
  assert.ok(states[0].full && states[1].patch);
  assert.equal(states[2].full.n, 2, 'the reset barrier executes after the earlier queued delta');
  assert.equal(new StateReceiver().receive(states[2]).message.n, 2, 'a receiver missing all earlier frames can recover');
});

test('reusing a mutable broadcast object cannot reorder shared delta sequence numbers across slices', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 300 }, () => socket(network));
  for (const ws of sockets) negotiateStateDelta(ws, 1);
  const state = { t: 'm.public', n: 0, stable: 'x'.repeat(600) };
  network.broadcastAll(state);
  state.n = 1;
  network.broadcastAll(state);
  state.n = 2;
  network.broadcastAll(state);
  state.t = 'mutated';
  await drain(network);
  for (const ws of sockets) {
    const receiver = new StateReceiver();
    assert.deepEqual(ws.frames.map((m) => receiver.receive(m).message?.n), [0, 1, 2]);
  }
});

test('shared state sequences follow enqueue order even when another recipient writes the newer state first', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 300 }, () => socket(network));
  for (const ws of sockets) negotiateStateDelta(ws, 1);
  network.broadcastAll({ t: 'm.ticker', text: 'busy' });
  const last = sockets.at(-1), state = { t: 'm.public', n: 0, stable: 'x'.repeat(600) };
  send(last, state);
  network.broadcastAll({ ...state, n: 1 });
  await drain(network);
  const states = last.frames.filter((m) => m.kind === 'm.public');
  assert.ok(states[0].full && states[1].patch);
  assert.ok(states[1].seq > states[0].seq);
  const receiver = new StateReceiver();
  assert.deepEqual(states.map((m) => receiver.receive(m).message.n), [0, 1]);
});

test('application queued bytes participate in snapshot drops, hard disconnects and health buffers', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 300 }, () => socket(network));
  network.broadcastAll({ t: 'm.ticker', text: 'busy' });
  const ws = sockets.at(-1);
  assert.equal(sendRaw(ws, 'x'.repeat(NET_DEFAULTS.snapDropBytes + 1)), true);
  assert.equal(send(ws, { t: 'b.snap' }), false);
  assert.equal(send(ws, { t: 'm.result' }), true, 'reliable state is retained under soft backpressure');
  assert.ok(network.bufferedBytes().max > NET_DEFAULTS.snapDropBytes);
  assert.equal(sendRaw(ws, 'x'.repeat(NET_DEFAULTS.hardBufferBytes)), false, 'reject the frame before it exceeds the hard queue budget');
  assert.equal(send(ws, { t: 'ok' }), false);
  assert.equal(ws.readyState, 3);
  assert.equal(network._outbound.has(ws), false);
  assert.equal(network.diagnostics.droppedSnapshots, 1);
  assert.equal(network.diagnostics.slowDisconnects, 1);
  await drain(network);
  assert.deepEqual(ws.frames, []);
  assert.deepEqual(network.bufferedBytes(), { total: 0, max: 0 });
});
