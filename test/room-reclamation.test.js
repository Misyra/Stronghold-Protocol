import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { startServer } from '../server/index.js';

function fixture(t) {
  let now = 100000;
  const audits = [], registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: StubMatch, getData: () => ({}), now: () => now,
    countryLookup: () => 'HK', log: { info: (s) => { if (s.startsWith('[audit] ')) audits.push(JSON.parse(s.slice(8))); }, warn() {}, error() {}, debug() {} } });
  t.after(() => lobby.shutdown());
  const create = () => {
    now++;
    const session = registry.create('Host');
    session.connected = true;
    session.addr = '203.0.113.1';
    assert.equal(lobby.create(session, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
    return { session, room: lobby.roomOf(session) };
  };
  const offline = (entry, at = now + 1001) => {
    now = at;
    entry.session.connected = false;
    entry.session.disconnectedAt = now;
    lobby.onDisconnect(entry.session);
  };
  return { registry, lobby, audits, create, offline };
}

test('90% triggers, removes longest-offline first and stops strictly below 80%', (t) => {
  const f = fixture(t), entries = Array.from({ length: 9 }, f.create);
  for (const e of entries.slice(0, 3)) assert.equal(f.lobby.addBot(e.session).ok, true);
  assert.equal(f.lobby.start(entries[1].session).ok, true);
  const matchCtx = entries[1].room.matchCtx;
  f.offline(entries[1], 110000);
  f.offline(entries[2], 120000);
  f.offline(entries[0], 130000); // Oldest room is most recently offline, so keep it.
  f.lobby.opts.maxRooms = 10;
  const checkpoints = [];
  const subscribed = [];
  f.lobby.onCheckpoint = (code, match) => checkpoints.push([code, match]);
  f.lobby.subscribeCheckpoint((code, match) => subscribed.push([code, match]));
  assert.equal(f.lobby.reclaimOfflineRooms(), 2);
  assert.equal(f.lobby.rooms.size, 7);
  assert.equal(entries[0].room.disposed, false);
  assert.equal(entries[1].room.disposed, true);
  assert.equal(entries[2].room.disposed, true);
  assert.equal(matchCtx.disposed, true);
  assert.equal(f.lobby.botPopulation.stats().total, 1);
  assert.equal(f.lobby.botPopulation.stats().foreign, 1);
  assert.equal(f.lobby.graceTimers.has(entries[2].session.playerId), false);
  assert.equal(entries[2].session.roomCode, null);
  assert.equal(entries[2].session.notice, 'capacity');
  assert.deepEqual(checkpoints, [[entries[1].room.code, null], [entries[2].room.code, null]]);
  assert.deepEqual(subscribed, checkpoints, 'persistence subscribers also learn that the rooms are gone');
  assert.deepEqual(f.lobby.stats().roomPressure, { active: false, reclaimed: 2 });
  const audit = f.audits.find((a) => a.action === 'room.pressure.reclaimed');
  assert.equal(audit.before, 9);
  assert.equal(audit.after, 7);
  assert.equal(audit.targetRooms, 7);
  assert.equal(f.audits.filter((a) => a.action === 'room.disposed' && a.reason === 'capacity').length, 2);
});

test('below 90% preserves reconnect grace; exactly 80% must lose one more room', (t) => {
  const f = fixture(t), entries = Array.from({ length: 8 }, f.create);
  f.offline(entries[0]);
  f.offline(entries[1]);
  f.lobby.opts.maxRooms = 10;
  assert.equal(f.lobby.reclaimOfflineRooms(), 0);
  assert.equal(f.lobby.rooms.size, 8);
  assert.equal(f.lobby.roomPressure.active, false);
  f.lobby.roomPressure.active = true;
  assert.equal(f.lobby.reclaimOfflineRooms(), 1);
  assert.equal(f.lobby.rooms.size, 7);
  assert.equal(f.lobby.roomPressure.active, false);
});

test('online players and spectators are protected, including registry/seat disagreement', (t) => {
  const f = fixture(t), entries = Array.from({ length: 9 }, f.create);
  const spectator = f.registry.create('Viewer');
  spectator.connected = true;
  assert.equal(f.lobby.spectate(spectator, { code: entries[0].room.code }).ok, true);
  f.offline(entries[0]);
  f.offline(entries[1]);
  entries[1].session.connected = true; // Be conservative while seat and session are being synchronized.
  f.lobby.opts.maxRooms = 10;
  assert.equal(f.lobby.reclaimOfflineRooms(), 0);
  assert.equal(f.lobby.roomPressure.active, true);
  assert.ok(entries.every((e) => !e.room.disposed));
});

test('pressure stays armed when too few rooms are offline and disarms below 80%', (t) => {
  const f = fixture(t), entries = Array.from({ length: 9 }, f.create);
  f.lobby.opts.maxRooms = 10;
  assert.equal(f.lobby.reclaimOfflineRooms(), 0);
  f.offline(entries[0]);
  assert.equal(f.lobby.reclaimOfflineRooms(), 1);
  assert.equal(f.lobby.rooms.size, 8);
  assert.equal(f.lobby.roomPressure.active, true);
  f.offline(entries[1]);
  assert.equal(f.lobby.reclaimOfflineRooms(), 1);
  assert.equal(f.lobby.roomPressure.active, false);
  f.offline(entries[2]);
  assert.equal(f.lobby.reclaimOfflineRooms(), 0);
  assert.equal(entries[2].room.disposed, false);
});

test('fractional room-pressure thresholds round safely', (t) => {
  const f = fixture(t), entries = Array.from({ length: 10 }, f.create);
  for (const e of entries) f.offline(e);
  f.lobby.opts.maxRooms = 11;
  assert.equal(f.lobby.reclaimOfflineRooms(), 2); // 10 >= 9.9, 8 < 8.8.
  f.lobby.opts.maxRooms = 1;
  assert.equal(f.lobby.reclaimOfflineRooms({ force: true }), 8);
  assert.equal(f.lobby.rooms.size, 0);
  assert.equal(Math.ceil(1000 * 4 / 5) - 1, 799);
});

test('creating the room that reaches 90% triggers automatic reclamation', (t) => {
  const f = fixture(t), entries = Array.from({ length: 8 }, f.create);
  f.offline(entries[0]);
  f.offline(entries[1]);
  f.lobby.opts.maxRooms = 10;
  const added = f.create();
  assert.equal(f.lobby.rooms.size, 7);
  assert.equal(added.room.disposed, false);
  assert.equal(f.lobby.botPopulation.stats().total, 0);
});

test('default 1600-room cap triggers exactly at 1440 and reclaims to 1279', (t) => {
  const f = fixture(t), entries = Array.from({ length: 1439 }, f.create);
  for (const e of entries.slice(0, 161)) f.offline(e);
  assert.equal(f.lobby.reclaimOfflineRooms(), 0);
  assert.equal(f.lobby.rooms.size, 1439);
  const newest = f.create();
  assert.equal(f.lobby.rooms.size, 1279);
  assert.equal(newest.room.disposed, false);
  assert.equal(f.lobby.roomPressure.reclaimed, 161);
  assert.equal(f.lobby.roomPressure.active, false);
});

test('periodic check reclaims offline rooms and shutdown stops its timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t), entries = Array.from({ length: 9 }, f.create);
  f.offline(entries[0]);
  f.offline(entries[1]);
  f.lobby.opts.maxRooms = 10;
  t.mock.timers.tick(14999);
  assert.equal(f.lobby.rooms.size, 9);
  t.mock.timers.tick(1);
  assert.equal(f.lobby.rooms.size, 7);
  f.lobby.shutdown();
  f.lobby.reclaimOfflineRooms = () => assert.fail('timer survived shutdown');
  t.mock.timers.tick(15000);
});

test('repeated full-server creation attempts scan at most once per second', (t) => {
  const f = fixture(t), entries = Array.from({ length: 10 }, f.create);
  f.lobby.opts.maxRooms = 10;
  let scans = 0;
  const original = entries[0].room.activeHumans.bind(entries[0].room);
  entries[0].room.activeHumans = () => { scans++; return original(); };
  const requester = f.registry.create('Blocked');
  requester.connected = true;
  for (let i = 0; i < 100; i++)
    assert.equal(f.lobby.create(requester, { mode: 'coop', difficulty: 'NORMAL' }).error, 'INTERNAL');
  assert.equal(scans, 1);
  assert.equal(f.lobby.rooms.size, 10);
});

test('lowering the live room cap immediately reclaims and returns the resulting room count', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-room-pressure-'));
  const token = 'room-pressure-test-01234567890123456789';
  const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off',
    roomAdminToken: token, roomAdminPort: 0, roomAdminStateFile: path.join(dir, 'config.json'),
    MatchClass: StubMatch, log: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(async () => { await srv.close(); await rm(dir, { recursive: true, force: true }); });
  const sessions = Array.from({ length: 9 }, () => {
    const s = srv.registry.create('Host');
    s.connected = true;
    assert.equal(srv.lobby.create(s, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
    return s;
  });
  for (const s of sessions.slice(0, 2)) {
    s.connected = false;
    s.disconnectedAt = Date.now();
    srv.lobby.onDisconnect(s);
  }
  const response = await fetch(`${srv.roomAdminUrl}/api/room-config`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxRooms: 10 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).roomCount, 7);
  assert.equal(srv.lobby.rooms.size, 7);
});
