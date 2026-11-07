// test/capacity-matchmaking.test.js — 同容量匹配 (playerCapacity 4/8/12/16/20, shared/playerCapacity.js):
// 同一容量/难度/选项轴的整队合并成局, 一次提交全部确认的真人; 不同轴永不同报价; 失败/取消/断线整队退出且
// 不消耗原房间。移植自用户分支 test/capacity-matchmaking.test.js, 按本仓语义适配: 排队泵是微任务
// (schedulePump), 合并借用最老同盟的房间 (mergePartyMatchmaking) 而不是新建, 排队走引擎入口 (本仓 room.state
// 的 matchmaking 旗只在 lobby 入口翻转)。同盟代号别名 (spectatorAliases) 是用户分支独有的特性, 不移植。

import test from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { Matchmaking } from '../server/matchmaking.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITIES, PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const rules = (capacity, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false,
  ...(capacity > 4 ? { playerCapacity: capacity } : {}), ...extra });
class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() {
    this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', roomCode: this.opts.roomCode });
    for (const seat of this.opts.seats) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId, loadout: seat.loadout });
  }
  dispose() {} onDisconnect() {} onReconnect() {} onLeave() {}
}
function fixture(t, MatchClass = RecordingMatch) {
  let clock = 10_000, count = 0;
  const registry = new SessionRegistry({ now: () => clock });
  const lobby = new Lobby({ registry, now: () => clock, MatchClass, getData: () => ({}), seedFn: () => 71 });
  t.after(() => lobby.shutdown());
  const player = () => {
    const s = registry.create(`Mode${++count}`); s.connected = true; s.messages = [];
    s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const party = async (capacity, size, extra = {}, difficulty = 'NORMAL') => {
    const members = Array.from({ length: size }, player), host = members[0];
    assert.deepEqual(await lobby.create(host, { mode: 'coop', difficulty, experimental: rules(capacity, extra) }), { ok: true });
    const room = lobby.roomOf(host);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: room.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    return { members, host, room };
  };
  const join = group => lobby.matchmaking.join(group.host, { difficulty: group.room.difficulty, party: true });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const accept = members => members.map(member => lobby.matchmaking.accept(member, lobby.matchmaking.state(member)));
  return { lobby, registry, player, party, join, accept, flush, advance: ms => { clock += ms; } };
}

for (const capacity of PLAYER_CAPACITIES) test(`${capacity}-mode merges intact rooms and commits all confirmed humans at once`, async t => {
  const f = fixture(t), a = await f.party(capacity, 1), b = await f.party(capacity, capacity - 1);
  const members = [...a.members, ...b.members];
  assert.deepEqual(f.join(a), { ok: true });
  assert.equal(f.lobby.matchmaking.state(a.host).state, 'queued');
  assert.equal(f.lobby.matchmaking.state(a.host).required, capacity);
  assert.deepEqual(f.join(b), { ok: true });
  await f.flush(); // the queue's pump is a microtask (schedulePump)
  const offerId = f.lobby.matchmaking.state(a.host).offerId;
  assert.ok(members.every(p => f.lobby.matchmaking.state(p).offerId === offerId));
  for (const p of members.slice(0, -1)) assert.deepEqual(f.lobby.matchmaking.accept(p, f.lobby.matchmaking.state(p)), { ok: true });
  assert.equal(f.lobby.rooms.size, 2); assert.ok([a.room, b.room].every(r => r.match === null && !r.disposed));
  assert.deepEqual(f.lobby.matchmaking.accept(members.at(-1), f.lobby.matchmaking.state(members.at(-1))), { ok: true });
  // 本仓: the merge borrows the oldest alliance's room (a's) and disposes the other party's
  const room = f.lobby.roomOf(a.host);
  assert.equal(f.lobby.rooms.size, 1); assert.equal(room, a.room); assert.equal(room.source, 'matchmaking');
  assert.equal(room.capacity, capacity);
  assert.equal(room.seats.length, capacity); assert.equal(room.match.opts.seats.length, capacity);
  assert.deepEqual(room.seats.map(s => s.seat), Array.from({ length: capacity }, (_, i) => i));
  assert.equal(b.room.disposed, true); assert.equal(f.lobby.matchmaking.size, 0);
  for (const p of members) {
    const state = f.lobby.matchmaking.state(p);
    assert.equal(state.state, 'matched'); assert.equal(state.required, capacity); assert.equal(state.code, room.code);
    assert.equal(p.roomCode, room.code);
    assert.ok(p.messages.filter(m => m.t === 'm.private').every(m => m.playerId === p.playerId));
    assert.ok(!JSON.stringify(state).includes('loadout'));
  }
  room.match.opts.onEnd({ reason: 'fixture' });
  const before = structuredClone(room.toState());
  const other = capacity === 4 ? 8 : 4;
  // 本仓: a matchmade room carries no experimental options at all (private rooms only), capacity included
  assert.equal(f.lobby.setExperimental(room.hostId === a.host.playerId ? a.host : b.host, { experimental: rules(other) }).error, ERR.BAD_MSG);
  assert.deepEqual(room.toState(), before);
  assert.equal(f.lobby.setExperimental(a.host, { experimental: rules(capacity, { revivalEnabled: true }) }).error, ERR.BAD_MSG);
  assert.equal(room.capacity, capacity);
});

test('different capacities/difficulties/flags never share an offer; lobby solo stays in four-mode', async t => {
  const f = fixture(t), eight = await f.party(8, 4), twelve = await f.party(12, 4), twenty = await f.party(20, 4);
  const otherFlags = await f.party(8, 4, { revivalEnabled: true }), otherDifficulty = await f.party(8, 4, {}, 'HARD');
  for (const group of [eight, twelve, twenty, otherFlags, otherDifficulty]) assert.deepEqual(f.join(group), { ok: true });
  await f.flush();
  assert.equal(f.lobby.matchmaking.offers.size, 0);
  const solos = Array.from({ length: 4 }, f.player);
  for (const p of solos) assert.deepEqual(f.lobby.matchmaking.join(p, { difficulty: 'NORMAL' }), { ok: true });
  await f.flush();
  assert.equal(f.lobby.matchmaking.offers.size, 1); assert.ok(solos.every(p => f.lobby.matchmaking.state(p).required === 4));
  assert.ok([eight, twelve, twenty, otherFlags, otherDifficulty].every(g => f.lobby.matchmaking.state(g.host).state === 'queued'));
  const complement = await f.party(8, 4); assert.deepEqual(f.join(complement), { ok: true });
  await f.flush();
  const offer = f.lobby.matchmaking.offers.get(f.lobby.matchmaking.state(eight.host).offerId);
  assert.equal(offer.required, 8); assert.deepEqual(offer.entries.map(e => e.session), [...eight.members, ...complement.members]);
});

test('twenty-mode uses earliest feasible whole-party fit and skips an unfillable older unit', async t => {
  const f = fixture(t), a = await f.party(20, 7), b = await f.party(20, 8), c = await f.party(20, 6), d = await f.party(20, 6);
  for (const group of [a, b, c, d]) assert.deepEqual(f.join(group), { ok: true });
  await f.flush();
  assert.equal(f.lobby.matchmaking.state(a.host).state, 'queued');
  const offer = f.lobby.matchmaking.offers.get(f.lobby.matchmaking.state(b.host).offerId);
  assert.equal(offer.required, 20); assert.deepEqual(offer.entries.map(e => e.session), [...b.members, ...c.members, ...d.members]);
  assert.ok(a.members.every(p => f.lobby.matchmaking.state(p).state === 'queued'));
});

for (const capacity of PLAYER_CAPACITIES.slice(1)) test(`${capacity}-mode still rejects unready, AI or obsolete client parties before creating tickets`, async t => {
  const f = fixture(t), group = await f.party(capacity, 2), before = structuredClone(group.room.toState());
  f.lobby.ready(group.members[1], { ready: false });
  assert.equal(f.join(group).error, ERR.NOT_READY); assert.equal(f.lobby.matchmaking.size, 0);
  f.lobby.ready(group.members[1], { ready: true });
  group.members[1].playerCapacityVersion = 'capacity-1';
  assert.equal(f.join(group).error, ERR.BAD_MSG); assert.equal(f.lobby.matchmaking.size, 0);
  group.members[1].playerCapacityVersion = PLAYER_CAPACITY_VERSION;
  assert.deepEqual(f.lobby.addBot(group.host), { ok: true });
  assert.equal(f.join(group).error, ERR.BAD_MSG); assert.equal(f.lobby.matchmaking.size, 0);
  assert.deepEqual(f.lobby.removeBot(group.host, { seat: 2 }), { ok: true });
  assert.deepEqual(group.room.toState(), before);
  assert.deepEqual(f.join(group), { ok: true });
  await f.flush();
  assert.equal(f.lobby.matchmaking.offers.size, 0, 'a lone party of two waits for its complement');
  group.members[1].playerCapacityVersion = 'capacity-1';
  f.lobby.matchmaking.sync(group.host); assert.equal(f.lobby.matchmaking.size, 0);
  assert.ok(group.members.every(p => f.lobby.matchmaking.state(p).state === 'idle'));
});

for (const cause of ['cancel', 'disconnect', 'unconfirmed', 'internal rule change', 'host migration']) test(`twenty-mode ${cause} removes the whole affected party without consuming its original room`, async t => {
  const f = fixture(t), a = await f.party(20, 4), b = await f.party(20, 16), beforeA = a.room.seats, beforeB = b.room.seats;
  f.join(a); f.join(b);
  await f.flush();
  for (const p of b.members) f.lobby.matchmaking.accept(p, f.lobby.matchmaking.state(p));
  if (cause === 'cancel') assert.deepEqual(f.lobby.matchmaking.cancel(a.members[2], f.lobby.matchmaking.state(a.members[2])), { ok: true });
  if (cause === 'disconnect') { a.members[2].connected = false; a.members[2].ws.readyState = 3; f.lobby.onDisconnect(a.members[2]); }
  if (cause === 'unconfirmed') { f.lobby.matchmaking.accept(a.host, f.lobby.matchmaking.state(a.host)); f.advance(30_000); f.lobby.matchmaking.sweep(); }
  if (cause === 'internal rule change') { a.room.experimental = rules(16); f.lobby.matchmaking.sync(a.host); }
  if (cause === 'host migration') { a.room.hostId = a.members[1].playerId; f.lobby.matchmaking.sync(a.host); }
  assert.equal(f.lobby.matchmaking.offers.size, 0);
  assert.ok(a.members.every(p => f.lobby.matchmaking.state(p).state === 'idle'));
  assert.ok(b.members.every(p => f.lobby.matchmaking.state(p).state === 'queued' && f.lobby.matchmaking.state(p).required === 20));
  for (const group of [a, b]) {
    assert.equal(group.room.match, null); assert.equal(group.room.disposed, false);
    assert.ok(group.members.every(p => p.roomCode === group.room.code));
  }
  assert.equal(a.room.seats, beforeA); assert.equal(b.room.seats, beforeB);
});

test('failed twenty-player construction keeps both rooms, FIFO tickets and full confirmation policy', async t => {
  class BrokenMatch extends RecordingMatch { start() { throw new Error('local allocation failure'); } }
  const f = fixture(t, BrokenMatch), a = await f.party(20, 5), b = await f.party(20, 15), members = [...a.members, ...b.members];
  f.join(a); f.join(b);
  await f.flush();
  const saved = members.map(p => f.lobby.matchmaking.entries.get(p.playerId));
  for (const p of members.slice(0, -1)) assert.deepEqual(f.lobby.matchmaking.accept(p, f.lobby.matchmaking.state(p)), { ok: true });
  assert.equal(f.lobby.matchmaking.accept(members.at(-1), f.lobby.matchmaking.state(members.at(-1))).error, ERR.INTERNAL);
  assert.equal(f.lobby.rooms.size, 2); assert.equal(f.lobby.matchmaking.offers.size, 0);
  for (const [i, p] of members.entries()) {
    assert.equal(f.lobby.matchmaking.entries.get(p.playerId), saved[i]);
    assert.equal(f.lobby.matchmaking.state(p).state, 'queued'); assert.equal(f.lobby.matchmaking.state(p).required, 20);
    // 本仓: start broadcasts inMatch before it runs — the refusal is the room.state members keep
    const last = p.messages.filter(m => m.t === 'room.state').at(-1);
    assert.ok(!last || last.inMatch === false, `no standing inMatch state for ${p.playerId}`);
  }
  assert.ok([a, b].every(g => !g.room.disposed && g.room.match === null && g.members.every(p => p.roomCode === g.room.code)));
});

test('large unfillable queue has bounded size-fit search and cannot split parties', async t => {
  let next = 0;
  const queue = new Matchmaking({ available: () => true, send() {}, allocate() { throw new Error('not confirmed'); },
    members: s => ({ sessions: s.group, roomCode: s.roomCode, leaderId: s.playerId, experimental: rules(20) }) });
  t.after(() => queue.close());
  for (let i = 0; i < 80; i++) {
    const group = Array.from({ length: 7 }, () => ({ playerId: `q${++next}`, matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION }));
    for (const s of group) { s.group = group; s.roomCode = `room${i}`; }
    assert.deepEqual(queue.join(group[0], { difficulty: 'NORMAL', party: true }), { ok: true });
  }
  assert.equal(queue.size, 560); assert.equal(queue.offers.size, 0);
});

test('actual HTTP/WS twenty-mode queues two rooms, cancels intact, then commits with high-seat private identity', async t => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, stateFile: 'off', workers: 0, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  const connect = async name => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(client);
    client.welcome = await client.hello(name);
    return client;
  };
  const members = [];
  for (let i = 0; i < 20; i++) members.push(await connect(`ModeWire${i}`));
  const makeParty = async (list) => {
    assert.equal((await list[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: rules(20) })).t, 'ok');
    const room = await list[0].waitFor('room.state', m => m.hostId === list[0].welcome.playerId);
    for (const p of list.slice(1)) {
      assert.equal((await p.request({ t: 'room.join', code: room.code })).t, 'ok');
      assert.equal((await p.request({ t: 'room.ready', ready: true })).t, 'ok');
    }
    return room.code;
  };
  const a = members.slice(0, 9), b = members.slice(9), codeA = await makeParty(a), codeB = await makeParty(b);
  const join = p => p.request({ t: 'queue.join', difficulty: 'NORMAL', party: true });
  assert.equal((await join(a[0])).t, 'ok'); assert.equal((await join(b[0])).t, 'ok');
  const offered = await a[0].waitFor('queue.state', m => m.state === 'offered'); assert.equal(offered.required, 20);
  const cancel = await a[8].waitFor('queue.state', m => m.state === 'offered');
  assert.equal((await a[8].request({ t: 'queue.cancel', ticketId: cancel.ticketId })).t, 'ok');
  for (const p of members) await p.waitFor('queue.state', m => m.state === 'idle' && ['cancelled', 'unconfirmed'].includes(m.reason));
  const response = await fetch(`http://127.0.0.1:${srv.port}/`);
  assert.equal(response.status, 200); assert.ok((await response.text()).includes('<html'));
  assert.ok(srv.lobby.rooms.has(codeA)); assert.ok(srv.lobby.rooms.has(codeB));
  assert.equal(srv.lobby.matchmaking.size, 0);
  assert.equal((await join(a[0])).t, 'ok'); assert.equal((await join(b[0])).t, 'ok');
  for (const p of members) {
    const offer = await p.waitFor('queue.state', m => m.state === 'offered' && m.offerId !== offered.offerId);
    assert.equal(offer.required, 20);
    assert.equal((await p.request({ t: 'queue.accept', ticketId: offer.ticketId, offerId: offer.offerId })).t, 'ok');
  }
  for (const p of members) {
    const matched = await p.waitFor('queue.state', m => m.state === 'matched'); assert.equal(matched.required, 20);
    const room = await p.waitFor('room.state', m => m.inMatch && m.code === matched.code);
    assert.equal(room.seats.length, 20); assert.equal(room.experimental.playerCapacity, 20);
    const own = await p.waitFor('m.private'); assert.equal(own.playerId, p.welcome.playerId);
  }
  const room = members[19].log.findLast(m => m.t === 'room.state' && m.inMatch);
  assert.equal(room.seats[19].playerId, members[19].welcome.playerId);
});
