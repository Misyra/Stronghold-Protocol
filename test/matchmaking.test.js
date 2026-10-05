import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { DIFFICULTY_NAMES } from '../shared/constants.js';

async function fixture(t, opts = {}) {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, ...opts });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await server.close(); });
  async function player(name = `P${clients.length}`) {
    const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); clients.push(c);
    const welcome = await c.hello(name); c.id = welcome.playerId; c.token = welcome.token; return c;
  }
  return { server, player };
}
const join = async (c, difficulty = 'FUNNY') => assert.equal((await c.request({ t: 'matchmaking.join', difficulty })).t, 'ok');

test('four opt-in humans of the same difficulty get one room and auto start without bots or room.ready', async (t) => {
  const { server, player } = await fixture(t); const people = [];
  for (let i = 0; i < 4; i++) people.push(await player());
  for (const c of people.slice(0, 3)) await join(c);
  const waiting = await people[0].waitFor('matchmaking.state', (s) => s.players === 3);
  assert.equal(waiting.target, 4); assert.equal(server.lobby.rooms.size, 0);
  await join(people[3]);
  const states = await Promise.all(people.map((c) => c.waitFor('room.state', (s) => s.inMatch)));
  assert.equal(new Set(states.map((s) => s.code)).size, 1);
  assert.equal(states[0].seats.filter(Boolean).length, 4); assert.ok(states[0].seats.every((s) => s && !s.isBot && s.ready));
  assert.equal(server.lobby.matchmaking.entries.size, 0); assert.equal(server.lobby.stats().matches, 1);
  assert.equal((await people[0].request({ t: 'matchmaking.cancel' })).code, 'ROOM_STARTED', 'late cancellation cannot eject an allocated player');
  const response = await fetch(`http://127.0.0.1:${server.port}/api/rooms/${states[0].code}/status`);
  const room = await response.json(); assert.equal(room.difficulty, 'FUNNY'); assert.equal(room.difficultyName, DIFFICULTY_NAMES.FUNNY);
});
test('difficulty isolation, duplicate join, cancel and disconnected users never fill a seat', async (t) => {
  const { server, player } = await fixture(t); const a = await player(), b = await player(), c = await player(), d = await player();
  await join(a); await join(a); await join(b, 'HARD'); await join(c);
  assert.equal(server.lobby.matchmaking.entries.size, 3);
  await b.request({ t: 'matchmaking.cancel' }); assert.equal(server.lobby.matchmaking.has(server.registry.byId(b.id)), false);
  await c.terminate(); await a.waitFor('matchmaking.state', (s) => s.players === 1);
  await join(d); assert.equal(server.lobby.rooms.size, 0);
  const resumed = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); t.after(() => resumed.terminate());
  await resumed.hello('P2', c.token); assert.equal((await resumed.waitFor('matchmaking.state')).status, 'idle');
});
test('manual room entry leaves the queue; in-room clients and invalid difficulty cannot queue', async (t) => {
  const { server, player } = await fixture(t); const a = await player(); await join(a);
  assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  assert.equal(server.lobby.matchmaking.entries.size, 0);
  assert.equal((await a.request({ t: 'matchmaking.join', difficulty: 'NORMAL' })).code, 'ALREADY');
  const b = await player(); assert.equal((await b.request({ t: 'matchmaking.join', difficulty: 'MADE_UP' })).code, 'BAD_MSG');
});
test('matchmaking is scoped to each game process and preserves room limits without leaking partial rooms', async (t) => {
  const first = await fixture(t, { maxRooms: 0 }), second = await fixture(t);
  const a = await first.player(); const b = await second.player(); await join(a); await join(b);
  assert.equal(first.server.lobby.matchmaking.entries.size, 1); assert.equal(second.server.lobby.matchmaking.entries.size, 1);
  for (let i = 0; i < 3; i++) await join(await first.player());
  const failed = await a.waitFor('matchmaking.state', (s) => s.status === 'failed'); assert.equal(failed.error, 'INTERNAL');
  assert.equal(first.server.lobby.rooms.size, 0); assert.equal(first.server.lobby.matchmaking.entries.size, 0);
});
test('match startup failure disposes every seat and allows retry', async (t) => {
  class Broken extends StubMatch { start() { throw new Error('fixture start failure'); } }
  const { server, player } = await fixture(t, { MatchClass: Broken }); const people = [];
  for (let i = 0; i < 4; i++) { const c = await player(); people.push(c); await join(c); }
  await people[0].waitFor('matchmaking.state', (s) => s.status === 'failed');
  assert.equal(server.lobby.rooms.size, 0); assert.ok(people.every((c) => server.registry.byId(c.id).roomCode === null));
  await join(people[0]); assert.equal(server.lobby.matchmaking.entries.size, 1);
});
test('public ping is CORS-readable and creates no sessions', async (t) => {
  const { server } = await fixture(t); const base = `http://127.0.0.1:${server.port}`;
  const response = await fetch(base + '/api/ping', { method: 'HEAD', headers: { Origin: 'https://portal.example' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(await response.text(), ''); assert.equal(server.registry.size, 0);
});

test('taking an upstream spectator seat removes the player from matchmaking', async (t) => {
  const { server, player } = await fixture(t);
  const watcher = await player(), host = await player();
  await join(watcher);
  await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = server.lobby.roomOf(server.registry.byId(host.id));
  assert.equal((await watcher.request({ t: 'room.spectate', code: room.code })).t, 'ok');
  assert.equal(server.lobby.matchmaking.entries.size, 0);
  assert.equal(room.spectators[0].playerId, watcher.id);
  assert.equal(room.seats.some((s) => s?.playerId === watcher.id), false);
  assert.equal((await watcher.request({ t: 'matchmaking.join', difficulty: 'NORMAL' })).code, 'ALREADY');
  assert.equal((await watcher.request({ t: 'room.leave' })).t, 'ok');
  assert.equal(room.spectators.length, 0);
});

test('a guest network at its match limit cannot bypass the cap through another host', async (t) => {
  const { server, player } = await fixture(t, { maxMatchesPerAddr: 1 });
  const active = await player(); server.registry.byId(active.id).limitKey = 'guest-network';
  await active.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
  await active.request({ t: 'room.start' });
  const people = [];
  for (let i = 0; i < 4; i++) {
    const c = await player(); people.push(c);
    server.registry.byId(c.id).limitKey = i === 2 ? 'guest-network' : `other-network-${i}`;
    await join(c);
  }
  const failed = await people[0].waitFor('matchmaking.state', (s) => s.status === 'failed');
  assert.equal(failed.error, 'RATE'); assert.equal(server.lobby.rooms.size, 1);
  assert.ok(people.every((c) => server.registry.byId(c.id).roomCode === null));
});
