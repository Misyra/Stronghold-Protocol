// 对局线程池在多条 lane 上的分配、回收，以及一条 lane 挂掉之后房间怎么回来。
// 上游（xinhai-ai/Stronghold-Protocol）在 Worker 报错时只留一行日志：它的房间会一直挂着一个不会应答的对局。
// 本仓库在 matchPool 里加了一个 onLaneFailure 钩子，由 lobby 把那几条对局正常结束（房间回大厅、存档留着）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { DATA } from './match/harness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const pools = [];
after(async () => { for (const pool of pools) await pool.close(); });

function makePool(opts) {
  const pool = new MatchWorkerPool({ data: DATA, log: quiet, ...opts });
  pools.push(pool);
  return pool;
}

/** A lobby wired to the lane pool the way server/index.js wires it. */
function lobbyWithLanes(pool) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quiet, getData: () => DATA, matchWorkerPool: pool });
  lobby.broadcastState = () => {};
  /** every checkpoint notification (code, match): a null match means "forget this room's checkpoint" */
  lobby.checkpoints = [];
  lobby.subscribeCheckpoint((code, match) => lobby.checkpoints.push([code, match]));
  pool.onLaneFailure = (error, lost) => lobby.handleLaneFailure(error, lost);
  return { registry, lobby };
}

const tick = (times = 2) => times === 1 ? new Promise((r) => setImmediate(r)) : tick(times - 1).then(() => new Promise((r) => setImmediate(r)));

test('五个房间分到三条 lane 上，全部结束时 lane 与占位都清空', async () => {
  const pool = makePool({ lanes: 3 });
  const { registry, lobby } = lobbyWithLanes(pool);
  try {
    const started = [];
    for (let i = 0; i < 5; i++) {
      const session = registry.create(`P${i}`);
      assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
      assert.deepEqual(await lobby.start(session), { ok: true }, `room ${i} started`);
      started.push({ session, room: lobby.rooms.get(session.roomCode) });
    }
    assert.equal(started.every(({ room }) => room.match?.remote === true), true, 'every room plays in a lane');

    const stats = pool.stats();
    assert.equal(stats.rooms, 5, 'the pool owns all five');
    assert.equal(pool.assignments.size, 5, 'and remembers which lane each one went to');
    assert.equal(stats.lanes.filter((lane) => lane.rooms > 0).length, 3, 'all three lanes get work');
    // 前三个房间一定分别落在三条 lane 上；后两个看负载打分，2/2/1 或 3/1/1 都算合理
    assert.ok(Math.max(...stats.lanes.map((lane) => lane.rooms)) <= 3, 'no lane takes more than three of the five');

    for (const { room } of started) lobby.disposeRoom(room, 'test');
    await tick(3);
    assert.equal(pool.stats().rooms, 0, 'every lane slot came back');
    assert.equal(pool.assignments.size, 0, 'and every assignment');
    assert.equal(pool.lanes.every((lane) => !lane.closed), true, 'no lane was marked broken by a normal disposal');
  } finally {
    lobby.shutdown('test');
  }
});

test('一条 lane 挂掉：它手上的对局结束、房间回大厅，再开局明确报错而不是卡住', async () => {
  const pool = makePool({ lanes: 1 });
  const { registry, lobby } = lobbyWithLanes(pool);
  try {
    const session = registry.create('Alice');
    assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    const room = lobby.rooms.get(session.roomCode);
    assert.deepEqual(await lobby.start(session), { ok: true });
    assert.equal(room.match?.remote, true);

    await pool.lanes[0].worker.terminate();
    for (let i = 0; i < 40 && room.match; i++) await new Promise((r) => setTimeout(r, 25));

    assert.equal(room.match, null, 'the room no longer holds a match that cannot answer');
    assert.equal(lobby.rooms.get(session.roomCode), room, 'the room itself stays');
    assert.equal(room.toState().inMatch, false, 'and is back in its lobby');
    // 这一局不是自己结束的：存档不能跟着删，重启还能接回去
    assert.equal(lobby.checkpoints.at(-1)?.[0], session.roomCode);
    assert.notEqual(lobby.checkpoints.at(-1)?.[1], null, 'the last checkpoint notification kept the match');
    assert.equal(pool.stats().rooms, 0, 'the pool let go of it');
    assert.equal(pool.assignments.size, 0, 'including its assignment');
    assert.equal(pool.stats().failedLanes, 1, 'the lane is marked broken');

    // 一条 lane 都没有了：再开局要明确失败，而不是把对局发进一条死线程
    const again = await lobby.start(session);
    assert.ok(again && typeof again.error === 'string', 'starting again answers an error');
    assert.equal(room.match, null);
  } finally {
    lobby.shutdown('test');
  }
});
