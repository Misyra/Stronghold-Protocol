// Matchmaking: the four-human queue of server/matchmaking.js (0.3.1 — queue.join / queue.accept / queue.cancel).
// A pool of the same difficulty forms one offer; every pooled human confirms it before the lobby commits a room.
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
// queue.join answers `ok` and pushes the ticket; the offer follows once the pool holds a full set.
async function join(c, difficulty = 'FUNNY') {
  const reply = await c.request({ t: 'queue.join', difficulty });
  assert.equal(reply.t, 'ok', JSON.stringify(reply));
  return c.waitFor('queue.state', (s) => !!s.ticketId && (s.state === 'queued' || s.state === 'offered'));
}
const offered = (c) => c.waitFor('queue.state', (s) => s.state === 'offered');
// Everyone joins, waits for the offer and accepts it; resolves with each accept reply (the last one allocates).
async function queueAndAccept(people, difficulty = 'FUNNY') {
  await Promise.all(people.map((c) => join(c, difficulty)));
  const states = await Promise.all(people.map((c) => offered(c)));
  const replies = [];
  for (let i = 0; i < people.length; i++) replies.push(await people[i].request({ t: 'queue.accept', ticketId: states[i].ticketId, offerId: states[i].offerId }));
  return { states, replies };
}

test('four opt-in humans of the same difficulty get one room and auto start without bots or room.ready', async (t) => {
  const { server, player } = await fixture(t); const people = [];
  for (let i = 0; i < 4; i++) people.push(await player());
  for (const c of people.slice(0, 3)) await join(c);
  const waiting = await people[0].waitFor('queue.state', (s) => s.waitingCount === 3);
  assert.equal(waiting.required, 4); assert.equal(waiting.state, 'queued'); assert.equal(server.lobby.rooms.size, 0);
  const { replies } = await queueAndAccept(people);
  assert.ok(replies.every((r) => r.t === 'ok'), JSON.stringify(replies));
  const states = await Promise.all(people.map((c) => c.waitFor('room.state', (s) => s.inMatch)));
  assert.equal(new Set(states.map((s) => s.code)).size, 1);
  assert.equal(states[0].seats.filter(Boolean).length, 4); assert.ok(states[0].seats.every((s) => s && !s.isBot && s.ready));
  const matched = await people[0].waitFor('queue.state', (s) => s.state === 'matched');
  assert.equal(matched.code, states[0].code);
  assert.equal(server.lobby.matchmaking.entries.size, 0); assert.equal(server.lobby.stats().matches, 1);
  // A cancellation after the commit cannot eject a seated player: the room side answers ROOM_STARTED.
  assert.equal((await people[0].request({ t: 'queue.cancel', ticketId: matched.ticketId })).code, 'ROOM_STARTED');
  assert.equal(server.lobby.roomOf(server.registry.byId(people[0].id)).code, states[0].code);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/rooms/${states[0].code}/status`);
  const room = await response.json(); assert.equal(room.difficulty, 'FUNNY'); assert.equal(room.difficultyName, DIFFICULTY_NAMES.FUNNY);
});
test('difficulty isolation, duplicate join, cancel and disconnected users never fill a seat', async (t) => {
  const { server, player } = await fixture(t); const a = await player(), b = await player(), c = await player(), d = await player();
  const tickets = { a: await join(a), b: await join(b, 'HARD'), c: await join(c) };
  await join(a); // a repeated join keeps the original ticket
  assert.equal(server.lobby.matchmaking.entries.size, 3);
  assert.equal((await a.request({ t: 'queue.join', difficulty: 'NORMAL' })).code, 'QUEUED', 'a queued player cannot change difficulty');
  await b.request({ t: 'queue.cancel', ticketId: tickets.b.ticketId });
  assert.equal(server.lobby.matchmaking.has(server.registry.byId(b.id)), false);
  await c.terminate(); await a.waitFor('queue.state', (s) => s.waitingCount === 1);
  await join(d); assert.equal(server.lobby.rooms.size, 0);
  const resumed = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); t.after(() => resumed.terminate());
  await resumed.hello('P2', c.token); assert.equal((await resumed.waitFor('queue.state')).state, 'idle');
});
test('manual room entry leaves the queue; a seated solo may queue again and gets merged, invalid difficulty cannot', async (t) => {
  const { server, player } = await fixture(t); const a = await player(); await join(a);
  assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  assert.equal(server.lobby.matchmaking.entries.size, 0);
  // 盟军合并: a seated solo keeps its room and queues from it (server/matchmakingRooms.js mergePartyMatchmaking)
  const again = await join(a, 'NORMAL');
  assert.equal(server.lobby.matchmaking.entries.size, 1);
  assert.equal((await a.request({ t: 'queue.cancel', ticketId: again.ticketId })).t, 'ok');
  assert.equal(server.lobby.matchmaking.entries.size, 0);
  const b = await player(); assert.equal((await b.request({ t: 'queue.join', difficulty: 'MADE_UP' })).code, 'BAD_MSG');
});
test('matchmaking is scoped to each game process and keeps the tickets when the allocation fails', async (t) => {
  const first = await fixture(t, { maxRooms: 0 }), second = await fixture(t);
  const a = await first.player(); const b = await second.player(); await join(a); await join(b);
  assert.equal(first.server.lobby.matchmaking.entries.size, 1); assert.equal(second.server.lobby.matchmaking.entries.size, 1);
  const players = [a];
  for (let i = 0; i < 3; i++) players.push(await first.player());
  const { replies } = await queueAndAccept(players);
  assert.equal(replies.at(-1).t, 'error', 'the last accept reports the failed allocation');
  const failed = await a.waitFor('queue.state', (s) => s.reason === 'allocation_failed');
  assert.equal(failed.state, 'queued');
  assert.equal(first.server.lobby.rooms.size, 0);
  // A failing allocation keeps accepted, healthy tickets (FIFO age and TTL survive) instead of dissolving the pool.
  assert.equal(first.server.lobby.matchmaking.entries.size, 4);
});
test('match startup failure disposes every seat and allows retry', async (t) => {
  class Broken extends StubMatch { start() { throw new Error('fixture start failure'); } }
  const { server, player } = await fixture(t, { MatchClass: Broken }); const people = [];
  for (let i = 0; i < 4; i++) people.push(await player());
  const { replies } = await queueAndAccept(people);
  assert.equal(replies.at(-1).t, 'error');
  assert.equal((await people[0].waitFor('queue.state', (s) => s.reason === 'allocation_failed')).state, 'queued');
  assert.equal(server.lobby.rooms.size, 0); assert.ok(people.every((c) => server.registry.byId(c.id).roomCode === null));
  // Every seat is disposed; the tickets that were already accepted stay queued for a retry.
  assert.equal(server.lobby.matchmaking.entries.size, 4);
  assert.equal((await people[0].request({ t: 'queue.join', difficulty: 'FUNNY' })).t, 'ok');
  assert.equal(server.lobby.matchmaking.has(server.registry.byId(people[0].id)), true);
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
  assert.equal((await watcher.request({ t: 'queue.join', difficulty: 'NORMAL' })).code, 'WRONG_PHASE');
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
    const c = await player();
    server.registry.byId(c.id).limitKey = i === 2 ? 'guest-network' : `other-network-${i}`;
    people.push(c);
  }
  const { replies } = await queueAndAccept(people);
  assert.equal(replies.at(-1).code, 'RATE', JSON.stringify(replies.at(-1)));
  assert.equal(server.lobby.rooms.size, 1);
  assert.ok(people.every((c) => server.registry.byId(c.id).roomCode === null));
});
