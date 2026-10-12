import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { Network, SessionRegistry, send, resetSocketState, NET_DEFAULTS, STATE_COALESCE } from '../server/net.js';
import { negotiateStateDelta } from '../server/stateTransport.js';
import { StateReceiver } from '../shared/stateDelta.js';
import { makeMatch } from './match/harness.js';

function fixture(t, options = {}) {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} }, options });
  t.after(() => network.close());
  const socket = (modern = true) => {
    const ws = new EventEmitter();
    Object.assign(ws, { readyState: 1, bufferedAmount: 0, frames: [] });
    ws.send = (data, callback) => { ws.frames.push(JSON.parse(data)); callback?.(); };
    ws.ping = () => {};
    ws.close = ws.terminate = () => { ws.readyState = 3; ws.emit('close'); };
    network.handleConnection(ws);
    if (modern) negotiateStateDelta(ws, 1);
    return ws;
  };
  return { network, socket };
}

const state = (scope, n, kind = 'm.public', owner = 'p1') => ({ t: kind, n,
  ...(kind === 'm.private' ? { playerId: owner } : { phase: scope.phase || 'PREP', round: scope.round || 1 }),
  stable: 'x'.repeat(600), [STATE_COALESCE]: scope });

async function recover(network, ws) {
  ws.bufferedAmount = 0;
  for (let i = 0; i < 100 && (network._blockedOutbound.size || network._outbound.size); i++) await delay(5);
  assert.equal(network._blockedOutbound.size, 0);
  assert.equal(network._outbound.size, 0);
}

function decode(ws) {
  const receiver = new StateReceiver();
  return ws.frames.map(frame => {
    if (frame.t !== 'm.state') return frame;
    const decoded = receiver.receive(frame);
    assert.equal(decoded.resync, false, 'coalescing must not create a delta gap');
    assert.ok(decoded.message);
    return decoded.message;
  });
}

for (const modern of [true, false]) test(`slow ${modern ? 'delta' : 'legacy'} peer retains only latest unsent snapshots and resumes without gaps`, async t => {
  const { network, socket } = fixture(t), ws = socket(modern), scope = {};
  send(ws, state(scope, -1));
  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  for (let n = 0; n < 1000; n++) {
    assert.equal(send(ws, state(scope, n)), true);
    assert.equal(send(ws, state(scope, n, 'm.private')), true);
  }
  assert.equal(ws.frames.length, 1, 'no further gameplay writes while TCP/compression is congested');
  const queued = network._blockedOutbound.get(ws);
  assert.equal(queued.size, 2);
  assert.equal(network.bufferedBytes().total, ws.bufferedAmount + queued.bytes);
  assert.equal(network.diagnostics.stats().coalescedStates, 1998);
  await nextTurn(); await nextTurn();
  assert.equal(network._outboundImmediate, null, 'blocked peers use a timer, not a busy immediate loop');
  await recover(network, ws);
  assert.deepEqual(decode(ws).map(m => [m.t, m.n]), [['m.public', -1], ['m.public', 999], ['m.private', 999]]);
  if (modern) assert.ok(ws.frames[1].patch, 'new delta is based on the last actually written state');
});

test('phase/round/match changes, critical messages and resync resets are coalescing barriers', async t => {
  const { network, socket } = fixture(t), ws = socket();
  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  const first = { phase: 'PREP', round: 1 }, second = { phase: 'COMBAT', round: 1 }, next = { phase: 'PREP', round: 2 };
  send(ws, state(first, 0)); send(ws, state(first, 1));
  for (const critical of [{ t: 'ok', rid: 1 }, { t: 'b.start', battleId: 'one' }, { t: 'm.toast', text: 'keep' }]) {
    send(ws, critical);
    send(ws, state(first, critical.rid || critical.battleId || critical.text));
  }
  send(ws, state(second, 2)); send(ws, state(second, 3));
  send(ws, { t: 'm.result' });
  send(ws, state(next, 4)); send(ws, state(next, 5));
  resetSocketState(ws);
  send(ws, state(next, 6)); send(ws, state(next, 7));
  send(ws, { t: 'room.closed' });
  send(ws, state({ phase: 'PREP', round: 2 }, 8));
  await recover(network, ws);
  assert.deepEqual(decode(ws).map(m => [m.t, m.n ?? null]), [
    ['m.public', 1], ['ok', null], ['m.public', 1], ['b.start', null], ['m.public', 'one'],
    ['m.toast', null], ['m.public', 'keep'], ['m.public', 3], ['m.result', null],
    ['m.public', 5], ['m.public', 7], ['room.closed', null], ['m.public', 8],
  ]);
  const recovery = ws.frames.find(m => m.full?.n === 7);
  assert.ok(recovery, 'reset stays in FIFO order and forces the recovery full frame');
});

test('healthy peers keep every state; slow peers cannot delay probes or other peers', async t => {
  const { network, socket } = fixture(t), slow = socket(), healthy = socket(), scope = {};
  slow.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  for (let n = 0; n < 200; n++) {
    send(slow, state(scope, n));
    send(healthy, state(scope, n));
  }
  slow.emit('message', Buffer.from('{"t":"ping","c":123}'), false);
  for (let i = 0; i < 100 && network._outbound.size; i++) await nextTurn();
  assert.deepEqual(decode(healthy).map(m => m.n), Array.from({ length: 200 }, (_, i) => i));
  assert.deepEqual(slow.frames.map(m => m.t), ['pong']);
  assert.equal(network._blockedOutbound.get(slow).size, 1);
  slow.close();
  assert.equal(network._blockedOutbound.size, 0);
  assert.equal(network._backpressureTimer, null);
});

test('unmarked states and different private owners are never silently replaced', async t => {
  const { network, socket } = fixture(t), ws = socket(), scope = {};
  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  send(ws, state(scope, 0, 'm.private', 'p1'));
  send(ws, state(scope, 1, 'm.private', 'p2'));
  send(ws, { t: 'm.public', n: 2 }); send(ws, { t: 'm.public', n: 3 });
  await recover(network, ws);
  assert.deepEqual(decode(ws).map(m => [m.playerId || null, m.n]), [['p1', 0], ['p2', 1], [null, 2], [null, 3]]);
});

test('pending immutable frames are shared across recipients; mutation cannot change earlier queued data', async t => {
  const { network, socket } = fixture(t), sockets = Array.from({ length: 20 }, () => socket()), msg = state({}, 0);
  for (const ws of sockets) ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  network.broadcastAll(msg);
  const frame = network._blockedOutbound.get(sockets[0]).head.frame;
  assert.ok(sockets.every(ws => network._blockedOutbound.get(ws).head.frame === frame));
  msg.n = 999;
  for (const ws of sockets) ws.bufferedAmount = 0;
  await recover(network, sockets[0]);
  for (const ws of sockets) assert.equal(decode(ws)[0].n, 0);
});

test('reliable barriers are bounded by frame count even when their byte count is tiny', t => {
  const { network, socket } = fixture(t, { maxQueuedFrames: 8 }), ws = socket();
  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  for (let n = 0; n < 8; n++) assert.equal(send(ws, { t: 'ok', rid: n }), true);
  assert.equal(send(ws, { t: 'ok', rid: 9 }), false);
  assert.equal(ws.readyState, 3);
  assert.equal(network._blockedOutbound.size, 0);
  assert.equal(network.diagnostics.slowDisconnects, 1);
});

test('match marks only replaceable updates; forced recovery, phases, rounds and matches get separate boundaries', () => {
  const h = makeMatch({ humans: 1, fake: true }).start();
  try {
    h.toPrep(1);
    const m = h.m, ps = h.ps('p_0');
    ps._lastPriv = null;
    m._sendPrivate(ps, false);
    const first = h.sent.at(-1)[1][STATE_COALESCE];
    assert.ok(first);
    m._lastPubJson = null; m._lastPubAt = -Infinity;
    m._maybeSendPublic(false);
    assert.equal(h.bc.at(-1)[STATE_COALESCE], first, 'public/private updates share a phase scope');
    m._sendPrivate(ps, true);
    assert.equal(h.sent.at(-1)[1][STATE_COALESCE], undefined);
    m._maybeSendPublic(true);
    assert.equal(h.bc.at(-1)[STATE_COALESCE], undefined);
    m.round++;
    ps._lastPriv = null; m._sendPrivate(ps, false);
    assert.notEqual(h.sent.at(-1)[1][STATE_COALESCE], first);
    assert.ok(!JSON.stringify(h.sent.at(-1)[1]).includes('stateCoalesce'));
  } finally { h.m.dispose(); }
});
