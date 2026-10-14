import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { startServer } from '../server/index.js';
import { SessionRegistry } from '../server/net.js';
import { ForeignSessions } from '../server/foreignSessions.js';
import { snapshotServer } from '../server/persist.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { lobbyOptionsFrom } from '../server/http/config.js';

const foreign = '203.0.113.1', domestic = '203.0.113.10';
const lookup = (ip) => ip === domestic ? 'CN' : ['203.0.113.1', '203.0.113.2', '2001:db8::1', '2001:0db8:0:0:0:0:0:1'].includes(ip) ? 'HK' : null;
const adminToken = 'foreign-policy-test-token-01234567890123456789';
const putPolicy = (srv, body, token = adminToken) => fetch(srv.roomAdminUrl + '/api/room-config', {
  method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function refusedUpgrade(srv, ip = foreign) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${srv.url}/ws`, { headers: { 'X-Real-IP': ip, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'MDEyMzQ1Njc4OWFiY2RlZg==' } });
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('foreign connection must not upgrade')); });
    req.on('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.end();
  });
}

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

test('foreign session policy validates its environment default and explicit option', () => {
  assert.equal(lobbyOptionsFrom({}, {}).limitForeignSessions, true);
  for (const value of ['off', 'false', '0'])
    assert.equal(lobbyOptionsFrom({}, { SP_FOREIGN_SESSION_LIMIT: value }).limitForeignSessions, false);
  assert.equal(lobbyOptionsFrom({ limitForeignSessions: true }, { SP_FOREIGN_SESSION_LIMIT: 'off' }).limitForeignSessions, true);
  assert.throws(() => lobbyOptionsFrom({}, { SP_FOREIGN_SESSION_LIMIT: 'maybe' }), RangeError);
});

test('live toggling preserves online players, tracks disabled-period identities and keeps valid resumes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-session-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture(t, lookup, { roomAdminToken: adminToken, roomAdminPort: 0, roomAdminStateFile: path.join(dir, 'config.json') });
  const a = await f.connect(), wa = await a.hello('A'), b = await f.connect();
  assert.equal((await b.request({ t: 'hello', name: 'B' })).code, 'FOREIGN_SESSION_LIMIT');
  assert.equal((await putPolicy(f.srv, { limitForeignSessions: false })).status, 200);
  const wb = await b.hello('B');
  assert.equal(f.srv.network.foreignSessions.stats().enabled, false);
  assert.equal((await putPolicy(f.srv, { limitForeignSessions: true })).status, 200);
  assert.ok(a.isOpen && b.isOpen, 'enabling must not evict existing online players');
  const c = await f.connect();
  assert.equal((await c.request({ t: 'hello', name: 'C' })).code, 'FOREIGN_SESSION_LIMIT');
  const resume = await f.connect();
  assert.equal((await resume.hello('B', wb.token)).resumed, true);
  await f.disconnect(a, wa.playerId); await f.disconnect(resume, wb.playerId);
  await c.hello('C');
  assert.equal(f.srv.registry.size, 1, 'offline identities made while disabled are still reclaimed');
  assert.equal(f.srv.network.foreignSessions.stats().reclaimed, 2);
  assert.ok(f.logs.some((line) => line.includes('session.foreignLimit.changed')));
});

test('policy persists with other room settings, honors override and reports missing country database', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-session-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json'), options = { roomAdminToken: adminToken, roomAdminPort: 0, roomAdminStateFile: file };
  const f = await fixture(t, lookup, options);
  for (const body of [{ limitForeignSessions: 'false' }, { limitForeignSessions: 0 }, { foreignSessionGeoipAvailable: true }])
    assert.equal((await putPolicy(f.srv, body)).status, 400);
  assert.equal((await putPolicy(f.srv, { limitForeignSessions: false }, 'wrong')).status, 401);
  assert.equal(f.srv.lobby.opts.limitForeignSessions, true);
  const results = await Promise.all([putPolicy(f.srv, { limitForeignSessions: false }), putPolicy(f.srv, { maxRooms: 700, allowBots: false })]);
  assert.ok(results.every((r) => r.status === 200));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schemaVersion: 1, maxRooms: 700, allowBots: false, limitForeignSessions: false, allowForeignConnections: true, maxForeignSessionsPerIp: 1 });
  await f.srv.close();
  const restored = await fixture(t, lookup, options);
  assert.equal(restored.srv.network.foreignSessions.stats().enabled, false);
  const override = await fixture(t, lookup, { ...options, limitForeignSessions: true });
  assert.equal(override.srv.network.foreignSessions.stats().enabled, true);
  const noDatabase = await fixture(t, null, { ...options, limitForeignSessions: true });
  const config = await (await putPolicy(noDatabase.srv, { limitForeignSessions: true })).json();
  assert.equal(config.limitForeignSessions, true); assert.equal(config.foreignSessionGeoipAvailable, false);
  assert.equal(noDatabase.srv.network.foreignSessions.stats().configured, true);
  assert.equal(noDatabase.srv.network.foreignSessions.stats().enabled, false);
});

test('failed policy persistence leaves enforcement unchanged', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-session-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'blocked'); await writeFile(blocker, 'not a directory');
  const f = await fixture(t, lookup, { roomAdminToken: adminToken, roomAdminPort: 0, roomAdminStateFile: path.join(blocker, 'config.json') });
  assert.equal((await putPolicy(f.srv, { limitForeignSessions: false })).status, 503);
  assert.equal(f.srv.network.foreignSessions.stats().enabled, true);
  assert.equal((await putPolicy(f.srv, { allowForeignConnections: false })).status, 503);
  assert.equal(f.srv.network.foreignSessions.stats().allowForeignConnections, true);
  assert.equal((await putPolicy(f.srv, { maxForeignSessionsPerIp: 2 })).status, 503);
  assert.equal(f.srv.network.foreignSessions.stats().maxPerIp, 1);
});

test('foreign session count validates its environment default, range and explicit option', () => {
  assert.equal(lobbyOptionsFrom({}, {}).maxForeignSessionsPerIp, 1);
  assert.equal(lobbyOptionsFrom({}, { SP_FOREIGN_MAX_SESSIONS_PER_IP: '3' }).maxForeignSessionsPerIp, 3);
  assert.equal(lobbyOptionsFrom({ maxForeignSessionsPerIp: 2 }, { SP_FOREIGN_MAX_SESSIONS_PER_IP: '3' }).maxForeignSessionsPerIp, 2);
  for (const value of ['0', '-1', '1.5', '101', 'bad', ''])
    assert.throws(() => lobbyOptionsFrom({}, { SP_FOREIGN_MAX_SESSIONS_PER_IP: value }), RangeError);
});

test('live foreign cap admits spare slots, reclaims only offline identities and does not evict players after lowering', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-session-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture(t, lookup, { roomAdminToken: adminToken, roomAdminPort: 0, roomAdminStateFile: path.join(dir, 'config.json') });
  const a = await f.connect(), wa = await a.hello('A');
  await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  await a.request({ t: 'room.addBot' });
  const b = await f.connect();
  assert.equal((await b.request({ t: 'hello', name: 'B' })).code, 'FOREIGN_SESSION_LIMIT');
  assert.equal((await putPolicy(f.srv, { maxForeignSessionsPerIp: 2 })).status, 200);
  const wb = await b.hello('B');
  const c = await f.connect();
  assert.equal((await c.request({ t: 'hello', name: 'C' })).code, 'FOREIGN_SESSION_LIMIT');
  assert.equal(f.srv.network.foreignSessions.stats().maxPerIp, 2);
  await f.disconnect(a, wa.playerId);
  const wc = await c.hello('C');
  assert.ok(b.isOpen && c.isOpen);
  assert.equal(f.srv.registry.byToken(wa.token), null);
  assert.equal(f.srv.lobby.rooms.size, 0);
  assert.equal(f.srv.lobby.botPopulation.stats().total, 0);
  assert.equal((await putPolicy(f.srv, { maxForeignSessionsPerIp: 1 })).status, 200);
  assert.ok(b.isOpen && c.isOpen, 'lowering does not kick online identities');
  const d = await f.connect();
  assert.equal((await d.request({ t: 'hello', name: 'D' })).code, 'FOREIGN_SESSION_LIMIT');
  const resume = await f.connect();
  assert.equal((await resume.hello('B', wb.token)).playerId, wb.playerId, 'existing same-IP tokens still resume');
  assert.equal((await b.closed).code, 4001);
  await f.disconnect(c, wc.playerId);
  assert.equal((await d.request({ t: 'hello', name: 'D' })).code, 'FOREIGN_SESSION_LIMIT', 'one remaining online identity still fills the lowered cap');
  await f.disconnect(resume, wb.playerId);
  await d.hello('D');
  assert.equal(f.srv.registry.size, 1);
  assert.ok(f.logs.some(line => line.includes('session.foreignMaxPerIp.changed')));
});

test('foreign cap persistence, auth, partial updates and explicit restart overrides preserve unrelated policies', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-session-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const options = { roomAdminToken: adminToken, roomAdminPort: 0, roomAdminStateFile: file };
  const f = await fixture(t, lookup, options);
  for (const value of [0, -1, 1.5, 101, '2', null, true])
    assert.equal((await putPolicy(f.srv, { maxForeignSessionsPerIp: value })).status, 400);
  assert.equal((await putPolicy(f.srv, { maxForeignSessionsPerIp: 2 }, 'wrong')).status, 401);
  assert.equal(f.srv.network.foreignSessions.stats().maxPerIp, 1);
  const results = await Promise.all([putPolicy(f.srv, { maxForeignSessionsPerIp: 3 }), putPolicy(f.srv, { maxRooms: 700, allowBots: false })]);
  assert.ok(results.every(response => response.status === 200));
  const config = await (await fetch(f.srv.roomAdminUrl + '/api/room-config', { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  assert.equal(config.maxForeignSessionsPerIp, 3); assert.equal(config.maxRooms, 700); assert.equal(config.allowBots, false);
  assert.equal(config.limitForeignSessions, true); assert.equal(config.allowForeignConnections, true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schemaVersion: 1, maxRooms: 700, allowBots: false,
    limitForeignSessions: true, allowForeignConnections: true, maxForeignSessionsPerIp: 3 });
  await f.srv.close();
  const restored = await fixture(t, lookup, options);
  assert.equal(restored.srv.network.foreignSessions.stats().maxPerIp, 3);
  const override = await fixture(t, lookup, { ...options, maxForeignSessionsPerIp: 2 });
  assert.equal(override.srv.network.foreignSessions.stats().maxPerIp, 2);
  const missing = await fixture(t, null, options);
  assert.equal(missing.srv.network.foreignSessions.stats().maxPerIp, 3);
  assert.equal(missing.srv.network.foreignSessions.stats().enabled, false);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, maxRooms: 700, allowBots: false, limitForeignSessions: true, allowForeignConnections: true }));
  const legacy = await fixture(t, lookup, options);
  assert.equal(legacy.srv.network.foreignSessions.stats().maxPerIp, 1, 'old saved files retain the default');
});

test('simultaneous foreign hellos cannot overbook the configured cap and domestic identities remain exempt', async t => {
  const f = await fixture(t, lookup, { maxForeignSessionsPerIp: 2 });
  const clients = await Promise.all([f.connect(), f.connect(), f.connect()]);
  const replies = await Promise.all(clients.map((client, i) => client.request({ t: 'hello', name: `Foreign${i}` })));
  assert.equal(replies.filter(reply => reply.t === 'welcome').length, 2);
  assert.equal(replies.filter(reply => reply.code === 'FOREIGN_SESSION_LIMIT').length, 1);
  for (let i = 0; i < 3; i++) assert.equal((await (await f.connect(domestic)).hello(`Domestic${i}`)).t, 'welcome');
  const other = await f.connect('203.0.113.2'), owner = await other.hello('Other');
  const moved = await f.connect();
  assert.equal((await moved.request({ t: 'hello', name: 'Other', token: owner.token })).code, 'FOREIGN_SESSION_LIMIT');
  assert.equal(f.srv.registry.byToken(owner.token).connected, true);
});

test('foreign connection environment defaults to allowed and accepts explicit overrides', () => {
  assert.equal(lobbyOptionsFrom({}, {}).allowForeignConnections, true);
  for (const value of ['off', 'false', '0'])
    assert.equal(lobbyOptionsFrom({}, { SP_ALLOW_FOREIGN_CONNECTIONS: value }).allowForeignConnections, false);
  assert.equal(lobbyOptionsFrom({ allowForeignConnections: true }, { SP_ALLOW_FOREIGN_CONNECTIONS: 'off' }).allowForeignConnections, true);
  assert.throws(() => lobbyOptionsFrom({}, { SP_ALLOW_FOREIGN_CONNECTIONS: 'maybe' }), RangeError);
});

test('known overseas sources receive HTTP 403 and never complete a WebSocket upgrade', async (t) => {
  for (const country of ['HK', 'MO', 'TW', 'US']) {
    const f = await fixture(t, () => country, { allowForeignConnections: false });
    const refusal = await refusedUpgrade(f.srv);
    assert.equal(refusal.status, 403);
    assert.deepEqual(refusal.body, { code: 'FOREIGN_CONNECTIONS_DISABLED', msg: '本服务器暂时仅对中国大陆服务' });
    assert.equal(f.srv.registry.size, 0); assert.equal(f.srv.network.conns.size, 0);
    assert.equal(f.srv.network.foreignSessions.stats().connectionDenied, 1);
    assert.ok(f.logs.some(line => line.includes('connection.foreignPolicy.denied')));
  }
});

test('blocking new connections keeps authenticated players but rejects reconnect and pre-hello sockets', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-access-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const options = { roomAdminToken: adminToken, roomAdminPort: 0, roomAdminStateFile: file };
  const f = await fixture(t, lookup, options);
  const old = await f.connect(), welcome = await old.hello('Old');
  await old.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = f.srv.lobby.roomOf(f.srv.registry.byId(welcome.playerId));
  const pending = await f.connect();
  for (const value of ['false', 0, null])
    assert.equal((await putPolicy(f.srv, { allowForeignConnections: value })).status, 400);
  assert.equal((await putPolicy(f.srv, { allowForeignConnections: false }, 'wrong')).status, 401);
  assert.equal((await putPolicy(f.srv, { allowForeignConnections: false })).status, 200);
  assert.equal(old.isOpen, true);
  assert.equal((await old.hello('Renamed', welcome.token)).playerId, welcome.playerId);
  assert.equal(f.srv.lobby.getRoom(room.code), room);
  assert.equal((await pending.request({ t: 'hello', name: 'Pending' })).code, 'FOREIGN_CONNECTIONS_DISABLED');
  assert.equal((await pending.closed).code, 4003);
  assert.equal((await refusedUpgrade(f.srv)).status, 403);
  assert.equal((await (await f.connect(domestic)).hello('Domestic')).t, 'welcome');
  assert.equal(f.srv.registry.size, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).allowForeignConnections, false);
  const restored = await fixture(t, lookup, options);
  assert.equal(restored.srv.network.foreignSessions.stats().foreignConnectionsBlocked, true);
  const override = await fixture(t, lookup, { ...options, allowForeignConnections: true });
  assert.equal(override.srv.network.foreignSessions.stats().foreignConnectionsBlocked, false);
  assert.equal((await putPolicy(f.srv, { allowForeignConnections: true })).status, 200);
  assert.equal((await (await f.connect()).hello('Old', welcome.token)).playerId, welcome.playerId);
  assert.ok(f.logs.some(line => line.includes('connection.foreignPolicy.changed')));
});

test('connection policy fails open for domestic, unknown, private and unavailable country lookup', async (t) => {
  for (const [countryLookup, ip] of [[lookup, domestic], [lookup, '203.0.113.99'], [() => 'HK', '127.0.0.2'],
    [null, foreign], [() => { throw new Error('lookup failed'); }, foreign]]) {
    const f = await fixture(t, countryLookup, { allowForeignConnections: false });
    assert.equal((await (await f.connect(ip)).hello('Allowed')).t, 'welcome');
    assert.equal(f.srv.network.foreignSessions.stats().connectionDenied, 0);
    assert.equal(f.srv.network.foreignSessions.stats().foreignConnectionsBlocked, !!countryLookup);
  }
});

test('overseas game documents return only the refusal message without blocking assets or monitoring', async (t) => {
  const f = await fixture(t, lookup, { allowForeignConnections: false });
  const headers = { 'X-Real-IP': foreign };
  for (const entry of ['/', '/index.html', '/%69ndex.html', '/build/index.html', '/dev/', '/dev/spine.html']) {
    const response = await fetch(f.srv.url + entry, { headers });
    assert.equal(response.status, 403, entry);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await response.json(), { code: 'FOREIGN_CONNECTIONS_DISABLED', msg: '本服务器暂时仅对中国大陆服务' });
  }
  const head = await fetch(f.srv.url, { method: 'HEAD', headers });
  assert.equal(head.status, 403); assert.equal(await head.text(), '');
  for (const allowed of ['/js/main.js', '/healthz', '/api/ping'])
    assert.equal((await fetch(f.srv.url + allowed, { headers })).status, 200, allowed);
  assert.equal((await fetch(f.srv.url, { headers: { 'X-Real-IP': domestic } })).status, 200);
  const untrusted = await fixture(t, lookup, { allowForeignConnections: false, trustProxy: false });
  assert.equal((await fetch(untrusted.srv.url, { headers })).status, 200, 'untrusted forwarding headers cannot override the private peer');
  assert.equal(f.srv.registry.size, 0); assert.equal(f.srv.network.connectionCount, 0);
});
