// test/lobby-player-capacity.test.js — 扩编房间 (playerCapacity 4/8/12/16/20, shared/playerCapacity.js) 的房间面:
// 自建房可开到二十席且座位序号稳定, 缩编拒绝任何高位座位且零副作用, 旧版客户端 (playerCapacityVersion 不符) 守在
// 普通房间外。维护者决定 2026-11-08：扩编房间不进同盟匹配 —— 扩编整队在引擎的容量闸被拒, 排队面只测 4 人池。
// 移植自用户分支 test/lobby-player-capacity.test.js, 按本仓语义适配:
// room.* 变更处理器在排队时撤票而不是拒绝 (ERR.QUEUED), 匹配房不带 experimental (private rooms only), 合并
// 借用最老同盟的房间而不是新建 (mergePartyMatchmaking)。

import test from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITIES, PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const options = capacity => ({ revivalEnabled: false, disableSharedPool: false, ...(capacity === undefined ? {} : { playerCapacity: capacity }) });
class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() {}
  dispose() {}
  onLeave() {}
  onDisconnect() {}
  onReconnect() {}
}
function fixture(t) {
  const registry = new SessionRegistry(), lobby = new Lobby({ registry, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 17 });
  t.after(() => lobby.shutdown());
  let count = 0;
  const player = (compatible = true) => {
    const s = registry.create(`Capacity${++count}`); s.connected = true; s.messages = [];
    s.matchmakingVersion = MATCHMAKING_VERSION; s.playerCapacityVersion = compatible ? PLAYER_CAPACITY_VERSION : null;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const room = async (capacity, size = 1) => {
    const members = Array.from({ length: size }, () => player());
    assert.deepEqual(await lobby.create(members[0], { mode: 'coop', difficulty: 'NORMAL', experimental: options(capacity) }), { ok: true });
    const room = lobby.roomOf(members[0]);
    for (const member of members.slice(1)) assert.deepEqual(lobby.join(member, { code: room.code }), { ok: true });
    return { room, members, host: members[0] };
  };
  return { lobby, registry, player, room };
}

for (const capacity of PLAYER_CAPACITIES) test(`friend capacity ${capacity} is finite for humans and AI; next admission has no effect`, async t => {
  const f = fixture(t), { room, host, members } = await f.room(capacity, capacity);
  assert.equal(room.seats.length, capacity); assert.equal(room.capacity, capacity);
  assert.equal(f.lobby.join(f.player(), { code: room.code }).error, ERR.ROOM_FULL);
  assert.equal(f.lobby.addBot(host).error, ERR.ROOM_FULL);
  assert.equal(room.activeHumans().length, capacity);
  for (const member of members.slice(1)) f.lobby.ready(member, { ready: true });
  assert.deepEqual(f.lobby.start(host), { ok: true });
  assert.deepEqual(room.match.opts.seats.map(s => s.seat), Array.from({ length: capacity }, (_, i) => i));
  assert.equal(f.lobby.setExperimental(host, { experimental: options(4) }).error, ERR.ROOM_STARTED);
});

test('expansion preserves seat identities; shrink with any high human/AI rejects with zero mutation', async t => {
  const f = fixture(t), { room, host, members } = await f.room(4, 2);
  const seats = room.seats.slice(); f.lobby.ready(members[1], { ready: true });
  assert.equal(f.lobby.setExperimental(members[1], { experimental: options(20) }).error, ERR.NOT_HOST);
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: options(20) }), { ok: true });
  assert.equal(room.seats.length, 20); assert.equal(room.seats[0], seats[0]); assert.equal(room.seats[1], seats[1]);
  assert.equal(room.seats[1].ready, false); assert.ok(room.seats.slice(2).every(s => s === null));
  while (room.freeSeat() >= 0) assert.deepEqual(f.lobby.addBot(host), { ok: true });
  assert.equal(f.lobby.addBot(host).error, ERR.ROOM_FULL);
  room.replay = { publicFrame: null, frames: new Map(), pending: new Set([host.playerId]) };
  const replay = room.replay, previous = room.experimental, array = room.seats, snapshot = structuredClone(room.toState()), messages = host.messages.length;
  assert.equal(f.lobby.setExperimental(host, { experimental: options(4) }).error, ERR.ROOM_FULL);
  assert.equal(room.replay, replay); assert.equal(room.experimental, previous); assert.equal(room.seats, array);
  assert.deepEqual(room.toState(), snapshot); assert.equal(host.messages.length, messages);
  assert.equal(f.lobby.removeBot(host, { seat: 20 }).error, ERR.BAD_TARGET);
  assert.equal(f.lobby.removeBot(host, { seat: 19.5 }).error, ERR.BAD_TARGET);
  for (let seat = 4; seat < 20; seat++) assert.deepEqual(f.lobby.removeBot(host, { seat }), { ok: true });
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: options(4) }), { ok: true });
  assert.equal(room.seats.length, 4); assert.equal(room.seats[0], seats[0]); assert.equal(room.seats[1], seats[1]);
});

test('high human disconnect/reconnect/kick preserves index; shrink rejects disconnected high humans', async t => {
  const f = fixture(t), { room, host, members } = await f.room(20, 20), high = members[19], seat = room.seats[19];
  high.connected = false; high.ws.readyState = 3; f.lobby.onDisconnect(high);
  const grace = f.lobby.graceTimers.get(high.playerId);
  assert.ok(grace); assert.equal(seat.connected, false);
  assert.equal(f.lobby.setExperimental(host, { experimental: options(16) }).error, ERR.ROOM_FULL);
  assert.equal(f.lobby.graceTimers.get(high.playerId), grace); assert.equal(room.seats[19], seat);
  assert.equal(f.lobby.helloAdmission(high, {}).error, ERR.BAD_MSG);
  assert.deepEqual(f.lobby.helloAdmission(high, { playerCapacityVersion: PLAYER_CAPACITY_VERSION }), { ok: true });
  high.connected = true; high.ws.readyState = 1; f.lobby.onHello(high, { resumed: true, repeat: false });
  assert.equal(room.seats[19], seat); assert.equal(seat.connected, true); assert.equal(f.lobby.graceTimers.has(high.playerId), false);
  assert.equal(f.lobby.kick(host, { seat: 20, playerId: high.playerId }).error, ERR.BAD_TARGET);
  assert.deepEqual(f.lobby.kick(host, { seat: 19, playerId: high.playerId }), { ok: true });
  assert.equal(high.roomCode, null); assert.equal(room.seats[19], null); assert.equal(room.seats[18].seat, 18);
  assert.equal(high.messages.at(-1).reason, 'kicked');
  const replacement = f.player(); assert.deepEqual(f.lobby.join(replacement, { code: room.code }), { ok: true });
  assert.equal(room.seatOf(replacement.playerId).seat, 19);
});

test('legacy clients keep ordinary/solo room shapes but cannot create, enter, observe, expand or resume large rooms', async t => {
  const f = fixture(t), legacy = f.player(false);
  assert.equal((await f.lobby.create(legacy, { mode: 'coop', difficulty: 'NORMAL', experimental: options(8) })).error, ERR.BAD_MSG);
  assert.equal(legacy.roomCode, null);
  const normal = await f.room(4);
  assert.deepEqual(f.lobby.join(legacy, { code: normal.room.code }), { ok: true });
  assert.equal(f.lobby.setExperimental(normal.host, { experimental: options(8) }).error, ERR.BAD_MSG);
  assert.equal(normal.room.seats.length, 4);
  f.lobby.leave(legacy);
  assert.deepEqual(f.lobby.spectate(legacy, { code: normal.room.code }), { ok: true });
  assert.equal(f.lobby.setExperimental(normal.host, { experimental: options(8) }).error, ERR.BAD_MSG);
  assert.equal(normal.room.seats.length, 4);
  f.lobby.leave(legacy);
  const expanded = await f.room(8);
  assert.equal(f.lobby.join(legacy, { code: expanded.room.code }).error, ERR.BAD_MSG);
  assert.equal(f.lobby.spectate(legacy, { code: expanded.room.code }).error, ERR.BAD_MSG);
  expanded.host.playerCapacityVersion = null;
  assert.equal(f.lobby.start(expanded.host).error, ERR.BAD_MSG);
  assert.equal(f.lobby.helloAdmission(expanded.host, {}).error, ERR.BAD_MSG);
  assert.deepEqual(await f.lobby.create(legacy, { mode: 'solo', difficulty: 'NORMAL', experimental: options(20) }), { ok: true });
  const solo = f.lobby.roomOf(legacy); assert.equal(solo.seats.length, 4); assert.equal(solo.capacity, 1);
  assert.equal(f.lobby.join(f.player(), { code: solo.code }).error, ERR.ROOM_FULL);
  assert.equal(f.lobby.addBot(legacy).error, ERR.ROOM_FULL);
});

for (const size of [1, 2, 3, 4]) test(`expanded ${size}-human party is refused at the queue gate without changing the room`, async t => {
  const f = fixture(t), { room, host, members } = await f.room(8, size);
  for (const p of members.slice(1)) f.lobby.ready(p, { ready: true });
  const before = structuredClone(room.toState());
  // 维护者决定 2026-11-08：扩编房间不进同盟匹配 —— 引擎的容量闸在 join() 拒绝 required > MAX_SEATS
  assert.deepEqual(f.lobby.queueJoin(host, { difficulty: 'NORMAL', party: true }), { error: ERR.BAD_MSG, detail: '扩编房间不进同盟匹配' });
  assert.equal(f.lobby.matchmaking.size, 0); assert.equal(f.lobby.matchmaking.offers.size, 0);
  // 本仓: 被拒的房间不亮 matchmaking 旗 (room.state 唯一的变化是没有变化), 座位与就绪位不动
  assert.deepEqual(room.toState(), before);
  assert.ok(!room.matchmaking);
  for (const member of members) assert.equal(f.lobby.matchmaking.state(member).state, 'idle');
});

test('party matchmaking requires ready nonhosts; room mutations withdraw the ticket instead of refusing', async t => {
  const f = fixture(t), { room, host, members } = await f.room(4, 2);
  assert.equal(f.lobby.matchmaking.join(host, { difficulty: 'NORMAL', party: true }).error, ERR.NOT_READY);
  assert.equal(f.lobby.matchmaking.size, 0); assert.equal(f.lobby.matchmaking.offers.size, 0);
  f.lobby.ready(members[1], { ready: true });
  assert.deepEqual(f.lobby.queueJoin(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  assert.equal(room.seats[0].ready, false); assert.equal(f.lobby.matchmaking.size, 2);
  // 本仓语义: 变更处理器撤票再改, 而不是 fork 的 ERR.QUEUED
  assert.deepEqual(f.lobby.ready(members[1], { ready: false }), { ok: true });
  assert.equal(f.lobby.matchmaking.has(members[1]), false);
  f.lobby.ready(members[1], { ready: true });
  assert.deepEqual(f.lobby.queueJoin(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  assert.equal(f.lobby.matchmaking.size, 2);
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: options(8) }), { ok: true });
  assert.equal(f.lobby.matchmaking.size, 0);
  // a rule change un-readies the non-hosts, as every room option does
  f.lobby.ready(members[1], { ready: true });
  // 维护者决定 2026-11-08：扩编房间不进同盟匹配 —— 扩容后的房间在容量闸被拒, 票已在扩容时撤干净
  assert.deepEqual(f.lobby.queueJoin(host, { difficulty: 'NORMAL', party: true }), { error: ERR.BAD_MSG, detail: '扩编房间不进同盟匹配' });
  assert.equal(f.lobby.matchmaking.size, 0);
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: options(4) }), { ok: true });
  f.lobby.ready(members[1], { ready: true });
  // Admission is checked again, including an internal race bypassing public locks.
  assert.deepEqual(f.lobby.queueJoin(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  room.seats[1].ready = false;
  assert.equal(f.lobby.matchmakingAvailable(host, f.lobby.matchmaking.entries.get(host.playerId)), false);
});

test('ended public matchmaking rooms cannot become expanded friend rooms; 本仓 keeps a matchmade room free of experimental options', async t => {
  const f = fixture(t), players = Array.from({ length: 4 }, () => f.player());
  for (const p of players) assert.deepEqual(f.lobby.queueJoin(p, { difficulty: 'NORMAL' }), { ok: true });
  await new Promise((resolve) => setImmediate(resolve)); // the queue's pump is a microtask (schedulePump)
  for (const p of players) assert.deepEqual(f.lobby.matchmaking.accept(p, f.lobby.matchmaking.state(p)), { ok: true });
  const room = f.lobby.roomOf(players[0]); assert.equal(room.source, 'matchmaking');
  room.match.opts.onEnd({ reason: 'fixture-ended' }); assert.equal(room.match, null);
  f.lobby.ready(players[1], { ready: true });
  const before = structuredClone(room.toState()), seats = room.seats, experimental = room.experimental, replay = room.replay, messages = players[0].messages.length;
  for (const capacity of [8, 12, 16, 20]) {
    // 本仓: experimental rules are private rooms only — a matchmade room refuses every option set, capacity included
    assert.equal(f.lobby.setExperimental(players[0], { experimental: options(capacity) }).error, ERR.BAD_MSG);
    assert.equal(room.seats, seats); assert.equal(room.experimental, experimental); assert.equal(room.replay, replay);
    assert.deepEqual(room.toState(), before); assert.equal(players[0].messages.length, messages);
  }
  assert.equal(f.lobby.setExperimental(players[0], { experimental: { revivalEnabled: true, disableSharedPool: true, playerCapacity: 4 } }).error, ERR.BAD_MSG);
  assert.equal(room.capacity, 4); assert.equal(room.seats.length, 4);
  assert.deepEqual(room.experimental, experimental);
});

test('actual native WS twenty-seat room rejects overflow/legacy resume without replacing compatible socket', async t => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, stateFile: 'off', workers: 0, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  const connect = async (name, compatible = true) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    c.welcome = await c.hello(name, undefined, compatible ? {} : { playerCapacityVersion: undefined }); return c;
  };
  const members = [];
  for (let i = 0; i < 20; i++) members.push(await connect(`Wire${i}`));
  const host = members[0];
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: options(20) })).t, 'ok');
  const room = await host.waitFor('room.state', m => m.hostId === host.welcome.playerId);
  for (const c of members.slice(1)) assert.equal((await c.request({ t: 'room.join', code: room.code })).t, 'ok');
  const full = await host.waitFor('room.state', m => m.seats.filter(Boolean).length === 20);
  assert.equal(full.seats[19].playerId, members[19].welcome.playerId);
  const overflow = await connect('Overflow'); assert.equal((await overflow.request({ t: 'room.join', code: room.code })).code, ERR.ROOM_FULL);
  assert.equal((await members[19].request({ t: 'room.setExperimental', experimental: options(4) })).code, ERR.NOT_HOST);
  assert.equal((await host.request({ t: 'room.setExperimental', experimental: options(16) })).code, ERR.ROOM_FULL);
  const legacy = await connect('Legacy', false); assert.equal((await legacy.request({ t: 'room.spectate', code: room.code })).code, ERR.BAD_MSG);
  const attemptedResume = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(attemptedResume);
  assert.equal((await attemptedResume.request({ t: 'hello', version: 1, name: 'Wire19', token: members[19].welcome.token })).code, ERR.BAD_MSG);
  assert.equal(members[19].closeInfo, null);
  assert.equal((await members[19].request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await host.request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).code, ERR.NOT_READY);
  assert.equal((await host.request({ t: 'room.kick', seat: 19, playerId: members[19].welcome.playerId })).t, 'ok');
  assert.equal((await members[19].waitFor('room.closed')).reason, 'kicked');
});

test('actual native WS party requires nonhost readiness before allocating any queue ticket', async t => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, stateFile: 'off', workers: 0, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  for (const name of ['ReadyHost', 'ReadyPeer']) { const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c); await c.hello(name); }
  const [host, peer] = clients;
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await host.waitFor('room.state');
  assert.equal((await peer.request({ t: 'room.join', code: room.code })).t, 'ok');
  assert.equal((await host.request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).code, ERR.NOT_READY);
  assert.equal(srv.lobby.matchmaking.size, 0);
  assert.equal((await peer.request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await host.request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).t, 'ok');
  assert.equal(srv.lobby.matchmaking.size, 2);
  // 本仓语义: un-readying withdraws the party's tickets (ok), the queue empties
  assert.equal((await peer.request({ t: 'room.ready', ready: false })).t, 'ok');
  assert.equal(srv.lobby.matchmaking.size, 0);
});

test('normal four-player exact-fill and wildcard solo queues retain capacity four', async t => {
  const f = fixture(t), { room: old, host, members } = await f.room(4, 2), solos = [f.player(false), f.player(false)];
  f.lobby.ready(members[1], { ready: true });
  assert.deepEqual(f.lobby.queueJoin(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  for (const solo of solos) assert.deepEqual(f.lobby.queueJoin(solo, { difficulty: 'NORMAL' }), { ok: true });
  await new Promise((resolve) => setImmediate(resolve)); // the queue's pump is a microtask (schedulePump)
  for (const p of [...members, ...solos]) assert.deepEqual(f.lobby.matchmaking.accept(p, f.lobby.matchmaking.state(p)), { ok: true });
  // 本仓: the merge borrows the oldest alliance's room instead of building a new one — the capacity stays four
  const room = f.lobby.roomOf(host); assert.equal(room, old); assert.equal(room.capacity, 4); assert.equal(room.seats.length, 4);
  assert.ok(room.match); assert.equal(room.match.opts.seats.length, 4);
  assert.ok(solos.every(s => room.seatOf(s.playerId)), 'both borrowed solos are seated');
  assert.equal(old.disposed, false);
});

test('an expanded room persists with its options and comes back at its size; an invalid document is refused', async t => {
  const f = fixture(t), { room, host } = await f.room(20, 3);
  const { roomDoc } = await import('../server/persist.js');
  const doc = roomDoc(room);
  assert.deepEqual(doc.experimental, options(20));
  assert.equal(doc.seats.length, 3);
  const again = new Lobby({ registry: f.registry, MatchClass: RecordingMatch, getData: () => ({}) });
  t.after(() => again.shutdown());
  const stats = await again.restoreRooms([doc], { now: Date.now() });
  assert.equal(stats.rooms, 1); assert.equal(stats.seats, 3);
  const back = again.getRoom(room.code);
  assert.equal(back.capacity, 20); assert.equal(back.seats.length, 20);
  assert.deepEqual(back.experimental, options(20));
  assert.equal(back.seatOf(host.playerId).seat, 0);
  // a document whose options do not validate is refused whole, never silently shrunk to four seats
  const stats2 = await again.restoreRooms([{ ...doc, code: 'BBBB', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 9 } }], { now: Date.now() });
  assert.equal(stats2.rooms, 0); assert.equal(stats2.droppedSeats, 3);
  assert.equal(again.getRoom('BBBB'), null);
});
