import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { Network, SessionRegistry } from '../server/net.js';
import { RehearsalPressure } from '../server/rehearsalPressure.js';
import { cleanupRuntime } from '../server/runtimeCleanup.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { snapshotServer, restoreServer } from '../server/persist.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('final save blocks new connections and existing socket mutations before capturing rooms', async (t) => {
  const saving = deferred(), finish = deferred();
  let doc;
  const store = { async load() { return null; }, async save(value) { doc = value; saving.resolve(); await finish.promise; return true; }, async close() {} };
  const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, store, MatchClass: StubMatch, log: quiet });
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  await c.hello('Host');
  await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const code = [...srv.lobby.rooms.keys()][0];
  const closing = srv.close();
  t.after(async () => { finish.resolve(); await closing; await c.close(); });
  await saving.promise;
  assert.equal((await c.request({ t: 'room.addBot' })).code, 'INTERNAL');
  await assert.rejects(TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`), /503/);
  assert.equal(srv.lobby.getRoom(code).seats.filter((s) => s?.isBot).length, 0);
  assert.equal(doc.rooms.length, 1);
  assert.equal(doc.rooms[0].code, code);
  assert.equal(srv.network.draining, true);
  assert.equal(srv.lobby.draining, true);
});

test('startup load failure closes diagnostics and store without overwriting broken state', async (t) => {
  let networkClosed = 0, pressureClosed = 0, storeClosed = 0, writes = 0;
  const netClose = Network.prototype.close, pressureClose = RehearsalPressure.prototype.close;
  t.mock.method(Network.prototype, 'close', function (...args) { networkClosed++; return netClose.apply(this, args); });
  t.mock.method(RehearsalPressure.prototype, 'close', function (...args) { pressureClosed++; return pressureClose.apply(this, args); });
  const store = { async load() { throw new Error('bad state'); }, async save() { writes++; }, async close() { storeClosed++; } };
  await assert.rejects(startServer({ port: 0, workers: 0, store, log: quiet }), /bad state/);
  assert.equal(networkClosed, 1);
  assert.equal(pressureClosed, 1);
  assert.equal(storeClosed, 1);
  assert.equal(writes, 0);
});

test('invalid private state location releases the already-created runtime', async (t) => {
  let closed = 0;
  const close = Network.prototype.close;
  t.mock.method(Network.prototype, 'close', function (...args) { closed++; return close.apply(this, args); });
  await assert.rejects(startServer({ port: 0, workers: 0, stateFile: 'public/private-state.json', log: quiet }), /SP_STATE_FILE/);
  assert.equal(closed, 1);
});

test('cleanup attempts every resource even if an earlier disposer fails', async () => {
  const order = [];
  const errors = await cleanupRuntime({
    lobby: { shutdown() { order.push('lobby'); throw new Error('dispose failed'); } },
    network: { close() { order.push('network'); } },
    persister: { stop() { order.push('stop'); }, async dispose() { order.push('encoder'); } },
    chatLog: { async close() { order.push('chat'); } },
    workerPool: { async close() { order.push('workers'); } }, ownsWorkerPool: true,
    store: { async close() { order.push('store'); } }, log: quiet,
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(order, ['stop', 'lobby', 'network', 'encoder', 'chat', 'workers', 'store']);
});

test('chat strikes retain identity but no longer retain an expired room or its bots', (t) => {
  let now = 100000;
  const registry = new SessionRegistry({ now: () => now });
  const lobby = new Lobby({ registry, now: () => now, MatchClass: StubMatch, getData: () => ({}), log: quiet });
  const network = new Network({ registry, handler: lobby, now: () => now, log: quiet });
  t.after(() => { lobby.shutdown(); network.close(); });
  const host = registry.create('Host');
  host.connected = true;
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' });
  lobby.addBot(host);
  lobby.start(host);
  host.connected = false;
  host.disconnectedAt = now;
  host.chatStrikes = 1;
  host.chatLastHitAt = now;
  lobby.onDisconnect(host);
  now += 11 * 60000;
  assert.equal(registry.isExpired(host, now), false);
  network.sweep();
  assert.equal(lobby.rooms.size, 0);
  assert.equal(lobby.botPopulation.stats().total, 0);
  assert.equal(registry.byToken(host.token), host);
  assert.equal(host.chatStrikes, 1);
  assert.equal(host.notice, 'timeout');
});

test('restoration preserves moderation identity but drops expired room membership', (t) => {
  const now = Date.now(), registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: StubMatch, getData: () => ({}), log: quiet });
  t.after(() => lobby.shutdown());
  const host = registry.create('Host');
  host.connected = true;
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' });
  lobby.addBot(host);
  host.connected = false;
  host.disconnectedAt = now;
  host.chatStrikes = 1;
  host.chatLastHitAt = now;
  const doc = snapshotServer({ registry, lobby, now });
  const registry2 = new SessionRegistry(), lobby2 = new Lobby({ registry: registry2, MatchClass: StubMatch, getData: () => ({}), log: quiet });
  t.after(() => lobby2.shutdown());
  restoreServer({ doc, registry: registry2, lobby: lobby2, now: now + 11 * 60000, log: quiet });
  assert.equal(lobby2.rooms.size, 0);
  assert.equal(lobby2.botPopulation.stats().total, 0);
  const retained = registry2.byId(host.playerId);
  assert.ok(retained);
  assert.equal(retained.roomCode, null);
  assert.equal(retained.chatStrikes, 1);
});
