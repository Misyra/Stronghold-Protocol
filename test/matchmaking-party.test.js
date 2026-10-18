// Premade alliances in the four-human queue (server/matchmaking.js): a party is one indivisible ticket, the pool
// fills it with solos or another party, and every pooled human accepts the offer before the lobby commits a room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { dropMatchmakingParty } from '../server/matchmakingRooms.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

test('joining a queued room cancels the whole party after the host session disappears', (t) => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: StubMatch, getData: () => ({}),
    log: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(() => lobby.shutdown());
  const player = (name) => { const s = registry.create(name); s.connected = true; s.matchmakingVersion = MATCHMAKING_VERSION; return s; };
  const host = player('Host'), member = player('Member'), newcomer = player('Newcomer'), outsider = player('Other queue');
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const room = lobby.roomOf(host);
  assert.equal(lobby.join(member, { code: room.code }).ok, true);
  assert.equal(lobby.ready(member, { ready: true }).ok, true);
  assert.equal(lobby.matchmaking.join(outsider, { difficulty: 'HARD' }).ok, true);
  assert.equal(lobby.matchmaking.join(host, { difficulty: 'NORMAL', party: true }).ok, true);
  room.matchmaking = true;
  registry.remove(host);
  assert.equal(lobby.join(newcomer, { code: room.code }).ok, true);
  assert.equal(room.matchmaking, false);
  assert.ok(room.seatOf(newcomer.playerId));
  assert.deepEqual([...lobby.matchmaking.entries.keys()], [outsider.playerId]);
  room.matchmaking = true; // A stale flag without any remaining entry is recoverable too.
  dropMatchmakingParty(lobby, room, 'cancelled');
  assert.equal(room.matchmaking, false);
  assert.deepEqual([...lobby.matchmaking.entries.keys()], [outsider.playerId]);
});

test('host migration retains the creation network quota', (t) => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: StubMatch, getData: () => ({}), options: { maxRoomsPerAddr: 1 },
    log: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(() => lobby.shutdown());
  const host = registry.create('Creator'), guest = registry.create('Successor');
  host.connected = guest.connected = true;
  host.limitKey = 'creation-network'; guest.limitKey = 'successor-network';
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const room = lobby.roomOf(host);
  assert.equal(lobby.join(guest, { code: room.code }).ok, true);
  assert.equal(lobby.leave(host).ok, true);
  assert.equal(room.hostId, guest.playerId);
  assert.equal(room.ownerKey, host.limitKey);
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).error, 'RATE');
});

async function fixture(t, options = {}) {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, ...options });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await server.close(); });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  async function player() {
    const c = await TestClient.connect(url); clients.push(c);
    const welcome = await c.hello(`P${clients.length}`); c.id = welcome.playerId; c.token = welcome.token;
    return c;
  }
  async function party(size, difficulty = 'FUNNY') {
    const people = [];
    for (let i = 0; i < size; i++) people.push(await player());
    await ok(people[0], { t: 'room.create', mode: 'coop', difficulty });
    const room = server.lobby.roomOf(server.registry.byId(people[0].id));
    for (const c of people.slice(1)) { await ok(c, { t: 'room.join', code: room.code }); await ok(c, { t: 'room.ready', ready: true }); }
    return { people, room, host: people[0] };
  }
  return { server, player, party, url };
}
async function ok(c, msg) { assert.equal((await c.request(msg)).t, 'ok', JSON.stringify(msg)); }
const search = (c) => ok(c, { t: 'room.matchmaking' });
const solo = (c, difficulty = 'FUNNY') => ok(c, { t: 'queue.join', difficulty });
// Every pooled human confirms the offer; the last accept allocates (or fails and re-offers the tickets).
async function settle(people) {
  const offers = await Promise.all(people.map((c) => c.waitFor('queue.state', (s) => s.state === 'offered')));
  const replies = [];
  for (let i = 0; i < people.length; i++) replies.push(await people[i].request({ t: 'queue.accept', ticketId: offers[i].ticketId, offerId: offers[i].offerId }));
  return replies;
}

for (const size of [1, 2, 3]) test(`${size}-player premade fills with solos, retains code/host/settings and auto starts`, async (t) => {
  const { server, party, player } = await fixture(t);
  const { people, room, host } = await party(size);
  const original = people.map((c) => server.registry.byId(c.id));
  original[0].loadout = room.seats[0].loadout = { fixture: { skill: 1, module: null } };
  await search(host); await search(host);
  assert.equal(server.lobby.matchmaking.entries.size, size);
  const queued = await host.waitFor('queue.state', (s) => s.state === 'queued');
  assert.equal(queued.waitingCount, size); assert.equal(queued.required, 4);
  const outsider = await player();
  assert.equal((await host.request({ t: 'room.start' })).code, 'ALREADY');
  const status = await (await fetch(`http://127.0.0.1:${server.port}/api/rooms/${room.code}/status`)).json();
  assert.equal(status.joinable, false);
  for (let i = 0; i < 4 - size; i++) { const c = i === 0 ? outsider : await player(); people.push(c); await solo(c); }
  await settle(people);
  const states = await Promise.all(people.map((c) => c.waitFor('room.state', (s) => s.inMatch)));
  assert.ok(states.every((s) => s.code === room.code && s.hostId === host.id && !s.matchmaking && s.seats.every((seat) => seat && !seat.isBot && seat.ready)));
  assert.deepEqual(room.seats[0].loadout, original[0].loadout);
  assert.equal(server.lobby.rooms.size, 1); assert.equal(server.lobby.matchmaking.entries.size, 0);
});

test('joining a published alliance key pauses matchmaking, keeps the party and allows requeue after ready', async (t) => {
  const { server, party, player } = await fixture(t);
  const a = await party(2), newcomer = await player();
  await search(a.host); await solo(newcomer, 'HARD');
  await ok(newcomer, { t: 'room.join', code: a.room.code });
  assert.equal(a.room.matchmaking, false); assert.equal(a.room.activeHumans().length, 3);
  assert.equal(server.lobby.matchmaking.entries.size, 0);
  assert.ok([...a.people, newcomer].every((c) => server.registry.byId(c.id).roomCode === a.room.code));
  assert.equal((await a.host.request({ t: 'room.matchmaking' })).code, 'NOT_READY');
  await ok(newcomer, { t: 'room.ready', ready: true });
  const filler = await player();
  await search(a.host); await solo(filler);
  await settle([...a.people, newcomer, filler]);
  assert.ok(a.room.match); assert.equal(a.room.activeHumans().length, 4);
});

test('two double premades merge without splitting, carrying both spectator seats', async (t) => {
  const { server, party, player } = await fixture(t);
  const a = await party(2), b = await party(2), watchers = [await player(), await player()];
  await ok(watchers[0], { t: 'room.spectate', code: a.room.code });
  await ok(watchers[1], { t: 'room.spectate', code: b.room.code });
  await search(a.host); await search(b.host);
  const everyone = [...a.people, ...b.people];
  await settle(everyone);
  for (const c of [...everyone, ...watchers]) {
    const state = await c.waitFor('room.state', (s) => s.inMatch);
    assert.equal(state.code, a.room.code); assert.equal(state.hostId, a.host.id); assert.equal(state.spectators.length, 2);
    assert.equal(server.registry.byId(c.id).roomCode, a.room.code);
  }
  assert.equal(server.lobby.rooms.size, 1); assert.equal(b.room.disposed, true);
});

test('two triple premades wait intact, and a solo fills only one of them', async (t) => {
  const { server, party, player } = await fixture(t);
  const a = await party(3), b = await party(3);
  await search(a.host); await search(b.host);
  const queued = await a.host.waitFor('queue.state', (s) => s.state === 'queued');
  assert.equal(queued.required, 4); assert.equal(server.lobby.stats().matches, 0);
  const third = await player(); await solo(third);
  await settle([...a.people, third]);
  assert.ok(a.room.match); assert.equal(b.room.match, null);
  assert.equal(server.lobby.matchmaking.entries.size, 3);
  assert.ok(b.people.every((c) => server.registry.byId(c.id).roomCode === b.room.code));
});

test('party queue validates host, readiness, bots, solo rooms, full rooms and spectators', async (t) => {
  const { server, party, player } = await fixture(t);
  const a = await party(2), guest = a.people[1];
  assert.equal((await guest.request({ t: 'room.matchmaking' })).code, 'NOT_HOST');
  await ok(guest, { t: 'room.ready', ready: false });
  assert.equal((await a.host.request({ t: 'room.matchmaking' })).code, 'NOT_READY');
  await ok(guest, { t: 'room.ready', ready: true });
  await ok(a.host, { t: 'room.addBot' });
  assert.equal((await a.host.request({ t: 'room.matchmaking' })).code, 'BAD_MSG');
  await ok(a.host, { t: 'room.removeBot', seat: 2 });
  const watcher = await player(); await ok(watcher, { t: 'room.spectate', code: a.room.code });
  assert.equal((await watcher.request({ t: 'room.matchmaking' })).code, 'SPECTATOR');
  assert.equal((await watcher.request({ t: 'queue.cancel', ticketId: 'x' })).code, 'SPECTATOR');
  const full = await party(4);
  assert.equal((await full.host.request({ t: 'room.matchmaking' })).code, 'BAD_MSG');
  const single = await player(); await ok(single, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
  assert.equal((await single.request({ t: 'room.matchmaking' })).code, 'BAD_MSG');
  assert.equal(server.lobby.matchmaking.entries.size, 0);
});

test('cancellation preserves alliance, difficulty isolation, and late cancellation cannot leave match', async (t) => {
  const { server, party, player } = await fixture(t);
  const a = await party(2), guest = a.people[1], outsider = await player();
  await solo(outsider, 'HARD'); await search(a.host);
  const ticket = await a.host.waitFor('queue.state', (s) => s.state === 'queued' && !!s.ticketId);
  assert.equal((await guest.request({ t: 'queue.cancel', ticketId: ticket.ticketId })).code, 'NOT_HOST');
  await ok(a.host, { t: 'queue.cancel', ticketId: ticket.ticketId });
  await guest.waitFor('queue.state', (s) => s.state === 'idle');
  assert.equal(a.room.matchmaking, false); assert.equal(a.room.activeHumans().length, 2);
  assert.equal(server.registry.byId(guest.id).roomCode, a.room.code);
  assert.equal(server.lobby.matchmaking.entries.size, 1);
  await search(a.host); const extra = [await player(), await player()];
  for (const c of extra) await solo(c);
  await settle([...a.people, ...extra]);
  assert.ok(a.room.match);
  assert.equal((await a.host.request({ t: 'queue.cancel', ticketId: ticket.ticketId })).code, 'ROOM_STARTED');
  assert.equal(server.registry.byId(guest.id).roomCode, a.room.code);
});

for (const action of ['leave', 'disconnect', 'unready', 'difficulty', 'bot', 'kick']) test(`${action} withdraws the whole premade and keeps remaining members in the alliance`, async (t) => {
  const { server, party, url } = await fixture(t);
  const a = await party(2), guest = a.people[1]; await search(a.host);
  await a.host.waitFor('queue.state', (s) => s.state === 'queued');
  if (action === 'leave') await ok(guest, { t: 'room.leave' });
  if (action === 'disconnect') { await guest.terminate(); await a.host.waitFor('room.state', (s) => !s.matchmaking && s.seats[1]?.connected === false); }
  if (action === 'unready') await ok(guest, { t: 'room.ready', ready: false });
  if (action === 'difficulty') await ok(a.host, { t: 'room.setDifficulty', difficulty: 'HARD' });
  if (action === 'bot') await ok(a.host, { t: 'room.addBot' });
  if (action === 'kick') await ok(a.host, { t: 'room.kick', seat: 1, playerId: guest.id });
  assert.equal(server.lobby.matchmaking.entries.size, 0); assert.equal(a.room.matchmaking, false);
  assert.equal(server.registry.byId(a.host.id).roomCode, a.room.code);
  assert.equal(a.room.activeHumans().length, ['leave', 'kick'].includes(action) ? 1 : 2);
  if (action === 'disconnect') {
    const resumed = await TestClient.connect(url); t.after(() => resumed.terminate());
    await resumed.hello('Guest', guest.token);
    assert.equal((await resumed.waitFor('queue.state')).state, 'idle');
    const state = await resumed.waitFor('room.state'); assert.equal(state.code, a.room.code); assert.equal(state.matchmaking, false);
  }
});

for (const failure of ['start', 'limit']) test(`${failure} failure preserves premades and re-offers the accepted tickets`, async (t) => {
  class Broken extends StubMatch { start() { throw new Error('fixture start failure'); } }
  const { server, party, player } = await fixture(t, failure === 'start' ? { MatchClass: Broken } : { maxMatchesPerAddr: 1 });
  if (failure === 'limit') {
    const busy = await player(); server.registry.byId(busy.id).limitKey = 'blocked';
    await ok(busy, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' }); await ok(busy, { t: 'room.start' });
  }
  const a = await party(2), solos = [await player(), await player()];
  if (failure === 'limit') server.registry.byId(solos[0].id).limitKey = 'blocked';
  const seats = a.room.seats;
  await search(a.host); await solo(solos[0]); await solo(solos[1]);
  const replies = await settle([...a.people, ...solos]);
  assert.equal(replies.at(-1).code, failure === 'start' ? 'INTERNAL' : 'RATE');
  const state = await a.host.waitFor('queue.state', (s) => s.reason === 'allocation_failed');
  assert.equal(state.state, 'queued');
  assert.equal(a.room.match, null); assert.equal(a.room.matchmaking, true); assert.equal(a.room.seats, seats);
  assert.ok(a.people.every((c) => server.registry.byId(c.id).roomCode === a.room.code));
  assert.ok(solos.every((c) => server.registry.byId(c.id).roomCode === null));
  // Healthy accepted tickets stay queued: the pool is not dissolved by a failed start.
  assert.equal(server.lobby.matchmaking.entries.size, 4);
  await search(a.host); assert.equal(server.lobby.matchmaking.entries.size, 4);
});

test('failed merging of two premades restores both rooms and spectators', async (t) => {
  class Broken extends StubMatch { start() { throw new Error('fixture start failure'); } }
  const { server, party, player } = await fixture(t, { MatchClass: Broken });
  const a = await party(2), b = await party(2), watcher = await player();
  await ok(watcher, { t: 'room.spectate', code: b.room.code });
  await search(a.host); await search(b.host);
  await settle([...a.people, ...b.people]);
  await a.host.waitFor('queue.state', (s) => s.reason === 'allocation_failed');
  assert.equal(server.lobby.rooms.size, 2);
  for (const p of [a, b]) {
    assert.equal(p.room.activeHumans().length, 2); assert.equal(p.room.matchmaking, true);
    assert.ok(p.people.every((c) => server.registry.byId(c.id).roomCode === p.room.code));
  }
  assert.equal(server.registry.byId(watcher.id).roomCode, b.room.code); assert.equal(b.room.spectators.length, 1);
});
