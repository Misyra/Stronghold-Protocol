import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { SessionRegistry } from '../server/net.js';
import { ForeignSessions } from '../server/foreignSessions.js';
import { snapshotServer } from '../server/persist.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const foreign = '203.0.113.1', domestic = '203.0.113.10';
const lookup = (ip) => ip === domestic ? 'CN' : ['203.0.113.1', '203.0.113.2', '2001:db8::1', '2001:0db8:0:0:0:0:0:1'].includes(ip) ? 'HK' : null;

async function fixture(t, countryLookup = lookup, options = {}) {
  const logs = [], clients = [];
  const log = { info: (line) => logs.push(line), warn() {}, error() {}, debug() {} };
  const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off', MatchClass: StubMatch,
    countryLookup, log, ...options });
  t.after(async () => { await Promise.all(clients.map((c) => c.close())); await srv.close(); });
  const connect = async (ip = foreign) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { headers: { 'X-Real-IP': ip } } });
    clients.push(c); return c;
  };
  const disconnect = async (c, id) => {
    await c.close();
    for (let i = 0; i < 100 && srv.registry.byId(id)?.connected; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(srv.registry.byId(id)?.connected, false);
  };
  return { srv, connect, disconnect, logs };
}

test('an online foreign identity blocks new identities but permits its valid token reconnect', async (t) => {
  const f = await fixture(t), first = await f.connect(), w = await first.hello('First');
  const second = await f.connect();
  for (let i = 0; i < 3; i++)
    assert.equal((await second.request({ t: 'hello', name: 'Second' })).code, 'FOREIGN_SESSION_LIMIT');
  assert.equal(f.srv.registry.size, 1);
  assert.equal(first.isOpen, true);
  assert.equal(f.logs.filter((l) => l.includes('session.foreignLimit.denied')).length, 1);
  assert.equal(f.srv.network.foreignSessions.stats().denied, 3);
  const resumed = await second.hello('First', w.token);
  assert.equal(resumed.playerId, w.playerId);
  assert.equal(resumed.resumed, true);
  assert.equal((await first.closed).code, 4001);
});

test('a new foreign identity reclaims an offline match, revokes the old token and releases its bots', async (t) => {
  const f = await fixture(t), first = await f.connect(), w = await first.hello('First');
  await first.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  for (let i = 0; i < 3; i++) assert.equal((await first.request({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await first.request({ t: 'room.start' })).t, 'ok');
  await f.disconnect(first, w.playerId);
  assert.equal(f.srv.lobby.rooms.size, 1);
  const second = await f.connect(), next = await second.hello('Second');
  assert.notEqual(next.playerId, w.playerId);
  assert.equal(f.srv.registry.byToken(w.token), null);
  assert.equal(f.srv.registry.size, 1);
  assert.equal(f.srv.lobby.rooms.size, 0);
  assert.equal(f.srv.lobby.botPopulation.stats().total, 0);
  const oldTab = await f.connect();
  assert.equal((await oldTab.request({ t: 'hello', name: 'First', token: w.token })).code, 'FOREIGN_SESSION_LIMIT');
  assert.equal(f.srv.registry.byToken(next.token).connected, true);
  assert.equal(f.srv.network.foreignSessions.stats().reclaimed, 1);
});

test('offline replacement removes only that player and preserves a shared room and its online teammate', async (t) => {
  const f = await fixture(t), first = await f.connect(), w = await first.hello('First');
  await first.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = f.srv.lobby.roomOf(f.srv.registry.byId(w.playerId));
  await first.request({ t: 'room.addBot' });
  const teammate = await f.connect(domestic), mate = await teammate.hello('Teammate');
  assert.equal((await teammate.request({ t: 'room.join', code: room.code })).t, 'ok');
  await f.disconnect(first, w.playerId);
  await (await f.connect()).hello('New');
  assert.equal(f.srv.lobby.getRoom(room.code), room);
  assert.equal(room.hostId, mate.playerId);
  assert.equal(room.seatOf(w.playerId), null);
  assert.equal(f.srv.lobby.botPopulation.stats().total, 1);
});

test('replacement preserves active chat penalties without copying player loadout or room access', async (t) => {
  const f = await fixture(t), first = await f.connect(), w = await first.hello('First');
  const old = f.srv.registry.byId(w.playerId);
  old.chatStrikes = 5; old.chatLastHitAt = Date.now(); old.chatMutedUntil = Date.now() + 900000;
  old.loadout = { private: true };
  const until = old.chatMutedUntil;
  await f.disconnect(first, w.playerId);
  const next = await (await f.connect()).hello('New'), s = f.srv.registry.byId(next.playerId);
  assert.equal(s.chatStrikes, 5); assert.equal(s.chatMutedUntil, until);
  assert.equal(s.loadout, null); assert.equal(s.roomCode, null);
});

test('domestic, unknown, private and disabled GeoLite sources retain existing multi-session behavior', async (t) => {
  for (const [countryLookup, ip] of [[lookup, domestic], [lookup, '203.0.113.99'], [lookup, '127.0.0.2'], [null, foreign]]) {
    const f = await fixture(t, countryLookup);
    const a = await (await f.connect(ip)).hello('A'), b = await (await f.connect(ip)).hello('B');
    assert.notEqual(a.playerId, b.playerId);
    assert.equal(f.srv.registry.size, 2);
  }
});

test('mapped IPv4 and equivalent IPv6 spellings cannot bypass the per-IP cap', async (t) => {
  const f = await fixture(t);
  await (await f.connect(foreign)).hello('IPv4');
  assert.equal((await (await f.connect('::ffff:203.0.113.1')).request({ t: 'hello', name: 'Mapped' })).code, 'FOREIGN_SESSION_LIMIT');
  await (await f.connect('2001:db8::1')).hello('IPv6');
  assert.equal((await (await f.connect('2001:0db8:0:0:0:0:0:1')).request({ t: 'hello', name: 'Expanded' })).code, 'FOREIGN_SESSION_LIMIT');
  // A different address, unlike the existing room-frequency /64 budget, is a separate session quota.
  const g = await fixture(t, () => 'TW');
  await (await g.connect('2001:db8::2')).hello('One');
  assert.equal((await (await g.connect('2001:db8::3')).hello('Two')).t, 'welcome');
});

test('a token moving to an occupied foreign IP is refused without disturbing either original player', async (t) => {
  const f = await fixture(t), a = await f.connect(), wa = await a.hello('A');
  const b = await f.connect('203.0.113.2'), wb = await b.hello('B');
  const move = await f.connect();
  assert.equal((await move.request({ t: 'hello', name: 'B', token: wb.token })).code, 'FOREIGN_SESSION_LIMIT');
  assert.equal(f.srv.registry.byId(wa.playerId).connected, true);
  assert.equal(f.srv.registry.byId(wb.playerId).ws.readyState, 1);
});

test('private quota keys survive restart without persisting raw session IPs or exposing keys to clients', async (t) => {
  const f = await fixture(t), c = await f.connect(), w = await c.hello('Old');
  await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const doc = snapshotServer({ registry: f.srv.registry, lobby: f.srv.lobby });
  const key = doc.sessions[0].foreignSessionKey;
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(doc.sessions[0].addr, undefined);
  assert.equal(JSON.stringify(w).includes(key), false);
  const store = { async load() { return doc; }, async save() { return true; }, async close() {} };
  const fresh = await fixture(t, lookup, { store });
  assert.equal(fresh.srv.registry.byId(w.playerId).foreignSessionKey, key);
  const resumed = await (await fresh.connect()).hello('Old', w.token);
  assert.equal(resumed.playerId, w.playerId);
  const s = fresh.srv.registry.byId(w.playerId);
  const oldSocket = [...fresh.srv.network.conns.values()].find((conn) => conn.session === s);
  oldSocket.ws.terminate();
  for (let i = 0; i < 100 && s.connected; i++) await new Promise((r) => setTimeout(r, 2));
  await (await fresh.connect()).hello('New');
  assert.equal(fresh.srv.registry.byId(w.playerId), null);
  assert.equal(fresh.srv.lobby.rooms.size, 0);
  const health = await (await fetch(fresh.srv.url + '/healthz')).json();
  assert.equal(health.foreignSessions.enabled, true);
  assert.equal(JSON.stringify(health).includes(key), false);
  const untouched = await fixture(t, lookup, { store });
  await (await untouched.connect()).hello('NoResume');
  assert.equal(untouched.srv.registry.byId(w.playerId), null);
  assert.equal(untouched.srv.lobby.rooms.size, 0);
});

test('lookup errors fail open with diagnostics; expired registry entries release index memory', () => {
  const registry = new SessionRegistry();
  const broken = new ForeignSessions({ registry, countryLookup() { throw new Error('lookup'); } });
  assert.equal(broken.prepare(foreign).ok, true);
  assert.equal(broken.stats().lookupErrors, 1);
  const policy = new ForeignSessions({ registry, countryLookup: lookup });
  const session = registry.create('A'); policy.bind(session, policy.prepare(foreign));
  registry.remove(session); policy.prune();
  assert.equal(policy.byIp.size, 0);
});

test('failed room cleanup refuses the newcomer without revoking the old identity', async (t) => {
  const f = await fixture(t), a = await f.connect(), w = await a.hello('A');
  await f.disconnect(a, w.playerId);
  t.mock.method(f.srv.lobby, 'onExpire', () => { throw new Error('cleanup failed'); });
  const b = await f.connect();
  assert.equal((await b.request({ t: 'hello', name: 'B' })).code, 'INTERNAL');
  assert.ok(f.srv.registry.byToken(w.token));
  assert.equal(f.srv.registry.size, 1);
});
