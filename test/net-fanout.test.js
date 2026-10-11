// Ported from xinhai-ai/Stronghold-Protocol commit 23d0a929 (test/ws-latency.test.js, GPL-3.0-or-later),
// adapted to fake sockets and this repository's entry points: broadcastAll (we have no Network.broadcast)
// and close() (we have no draining / beginShutdown). Real setImmediate — no fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Network, SessionRegistry } from '../server/net.js';

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
  for (let n = 0; network._fanout.length && n < 1000; n++) await nextTurn();
  assert.equal(network._fanout.length, 0);
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

test('closing cancels deferred fanout without retaining its recipients', async () => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  const sockets = Array.from({ length: 300 }, () => socket(network));
  network.broadcastAll({ t: 'notice' });
  network.close();
  await nextTurn();
  assert.equal(sockets.at(-1).frames.length, 0);
  assert.equal(network._fanout.length, 0);
  assert.equal(network._fanoutImmediate, null);
});
