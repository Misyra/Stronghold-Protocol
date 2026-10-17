// 对局线程池的等价性：同一个 seed、同一份数据、同一批席位，lane 里建出来的对局必须和主线程建出来的
// 是同一个对局 —— 存档（server/match/snapshot.js 的 capture）逐字段相同。只有「房间叫什么」这种字段除外。
// 这条是「整局搬进线程」的正确性底线：worker 不是另一个引擎，只是另一个线程。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { encodeMatchCapture, snapshotMatch } from '../server/match/snapshot.js';
import { DATA } from './match/harness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const pool = new MatchWorkerPool({ data: DATA, lanes: 1, log: quiet });
after(() => pool.close());

const SEED = 0x5ea1234;

/** A lobby with one adopted identity (the same playerId on both sides) and a fixed seed. */
function lobbyWith(extra) {
  const registry = new SessionRegistry();
  const session = registry.adopt({ playerId: 'p_parity', token: 'parity-token', name: 'Alice' });
  const lobby = new Lobby({ registry, log: quiet, getData: () => DATA, seedFn: () => SEED, ...extra });
  lobby.broadcastState = () => {};
  assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  return { registry, lobby, session, room: lobby.rooms.get(session.roomCode) };
}

/**
 * A checkpoint body without the two kinds of field that are not match state: what the room is called, and the two
 * clocks (they tick in real time — server/match/snapshot.js keeps them out of the version for the same reason).
 * @param {object | null} doc an encoded checkpoint (snapshotMatch / encodeMatchCapture)
 */
function body(doc) {
  assert.ok(doc, 'the running match must be checkpointable right now');
  const { roomCode: _room, battlePrefix: _prefix, deadlineRemainingMs: _deadline, startedAtAgoMs: _started, ...rest } = doc;
  return rest;
}

test('同一个 seed：lane 里的对局与主线程的对局状态逐字段相同', async () => {
  const local = lobbyWith({});
  const lane = lobbyWith({ matchWorkerPool: pool });
  try {
    assert.deepEqual(await local.lobby.start(local.session), { ok: true });
    assert.deepEqual(await lane.lobby.start(lane.session), { ok: true });
    assert.equal(local.room.match.remote, undefined, 'the first lobby runs the match on this thread');
    assert.equal(lane.room.match.remote, true, 'the second runs it in a lane');

    const a = body(snapshotMatch(local.room.match));
    const b = body(encodeMatchCapture(await lane.room.match.captureSnapshot()));

    assert.equal(b.phase, a.phase, 'same phase');
    assert.equal(b.round, a.round, 'same round');
    assert.equal(b.seed, a.seed, 'same seed');
    assert.equal(b.modeId, a.modeId, 'same mode');
    assert.deepEqual(b.players, a.players, 'seats, funds, shops, boards, skins — everything a player owns');
    assert.deepEqual(b.poolLeft, a.poolLeft, 'the shared pool');
    assert.deepEqual(b.rng, a.rng, 'every RNG position, so a restored or continued run matches');
    assert.deepEqual(b.factions, a.factions, 'the wave schedule (its non-enumerable side channel included)');
    assert.deepEqual(b.bannedChess, a.bannedChess);
    assert.deepEqual(b.bossWaves, a.bossWaves);
    assert.deepEqual(b, a, 'and therefore the whole checkpoint body');
  } finally {
    local.lobby.shutdown('test');
    lane.lobby.shutdown('test');
  }
});

test('检查点也能从 lane 对局拍出来，并覆盖同一个对局的两侧状态', async () => {
  const lane = lobbyWith({ matchWorkerPool: pool });
  try {
    assert.deepEqual(await lane.lobby.start(lane.session), { ok: true });
    const first = await lane.room.match.captureSnapshot();
    assert.equal(first?.doc?.players?.length, 1);
    // the clocks travel beside the body, and they are the only thing that moves between two idle captures
    assert.equal(typeof first.clocks.deadlineRemainingMs, 'number');
    assert.equal(typeof first.clocks.startedAtAgoMs, 'number');
    const second = await lane.room.match.captureSnapshot();
    assert.deepEqual(body(encodeMatchCapture(second)), body(encodeMatchCapture(first)), 'an idle match captures the same body twice');
  } finally {
    lane.lobby.shutdown('test');
  }
});
