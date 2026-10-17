// 对局 Worker 池（server/workers/matchPool.js — 取自 xinhai-ai/Stronghold-Protocol）接进 lobby 的端到端验证：
// 一条 lane 线程里跑完整的一局（计时器、AI、状态都在那边），主线程只转发帧、拍存档、回收 lane。
// 默认关闭（SP_MATCH_WORKERS=0）：这里把池子直接交给 Lobby，等价于环境变量打开后的行为。

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { Persister } from '../server/persist.js';
import { canSnapshot } from '../server/match/snapshot.js';
import { DATA } from './match/harness.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/** One lane for the whole file: a worker thread is an expensive thing to spawn per test. */
const pool = new MatchWorkerPool({ data: DATA, lanes: 1, log: quietLog });
after(() => pool.close());

/** A lobby whose plain rooms play in the lane (the shape server/index.js builds for SP_MATCH_WORKERS > 0). */
function lobbyWithLane() {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, getData: () => DATA, matchWorkerPool: pool });
  // the room state broadcast is the transport's job; it would reach no socket here
  lobby.broadcastState = () => {};
  return { registry, lobby };
}

/** Start a solo room's match and hand back the room and the session. */
async function startedSolo(lobby, registry) {
  const session = registry.create('Alice');
  assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  const room = lobby.rooms.get(session.roomCode);
  const res = await lobby.start(session);
  assert.deepEqual(res, { ok: true }, 'room.start must answer once the lane has the match');
  return { session, room };
}

/** Let the lobby's setImmediate disposal steps run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('对局线程池：lobby 侧接线', () => {
  test('无插件的对局整局跑在 lane 线程里，帧照常回到房间', async () => {
    const { registry, lobby } = lobbyWithLane();
    try {
      const { room } = await startedSolo(lobby, registry);
      const match = room.match;
      assert.equal(match?.remote, true, 'the room owns the RemoteMatch of the pool');
      assert.equal(room.matchCtx?.match, match, 'the room context names it');
      assert.equal(room.matchCount, 1, 'the match number advanced once');
      // 状态帧真的从那个线程回来了（m.public 由池子接住并记在 RemoteMatch 上）
      assert.ok(match.public?.phase, 'the lane broadcast the first m.public');
      assert.equal(match.snapshotable, true, 'the lane reports a checkpointable phase');
      assert.equal(typeof match.persistVersion, 'string', 'and its persistence version');
      // 主线程上的那份 Match 根本不存在：canSnapshot 只认真对象
      assert.equal(canSnapshot(match), false, 'the local snapshot predicate does not apply to a remote match');
      const capture = await match.captureSnapshot();
      assert.equal(capture?.doc?.players?.length, 1, 'the capture crosses the thread boundary intact');
      assert.ok(capture.doc.phase, 'with the phase it was taken in');
    } finally {
      lobby.shutdown('test');
    }
  });

  test('存档走池子的 capture：版本跳过不适用，每轮都拍一次', async () => {
    const { registry, lobby } = lobbyWithLane();
    const persister = new Persister({ store: { save: async () => true }, registry, lobby, log: quietLog, saveMs: 60_000 });
    try {
      const { session, room } = await startedSolo(lobby, registry);
      assert.equal(await persister.encodeRoom(session.roomCode, room.match), true, 'a remote match commits a checkpoint');
      const body = persister.matchDocs.get(session.roomCode);
      assert.equal(typeof body, 'string', 'the encoded body lands in the room\'s slot');
      assert.ok(body.includes('"players"'), 'and carries the match, not an empty document');
      // 同一个版本再来一轮：远端对局不做版本跳过，仍然重新拍（capture 是唯一看得见它状态的方式）
      const encodes = persister.versionStats.encodes;
      assert.equal(await persister.encodeRoom(session.roomCode, room.match), true);
      assert.equal(persister.versionStats.encodes, encodes + 1, 'no version skip for a match that lives in a thread');
    } finally {
      await persister.dispose();
      lobby.shutdown('test');
    }
  });

  test('room.skins / 对局消息在 lane 里也照常应答（Promise 转成平台的回复）', async () => {
    const { registry, lobby } = lobbyWithLane();
    try {
      const { session, room } = await startedSolo(lobby, registry);
      // 皮肤：远端 setSkins 是往线程里的调用，应答晚到一拍
      const answer = lobby.skins(session, { skins: {} });
      assert.equal(typeof answer?.then, 'function', 'a remote match answers later');
      assert.deepEqual(await answer, { ok: true });
      assert.deepEqual(room.seatOf(session.playerId).skins, {}, 'the seat still took the choice');
      // 对局消息：routeGameNow 认领远端对局的 Promise，不再当成「违反同步契约」
      const reply = lobby.onMessage(session, { t: 'g.pause', on: true });
      assert.equal(typeof reply?.then, 'function', 'the reply waits for the lane');
      const settled = await reply;
      assert.ok(settled && (settled.ok === true || typeof settled.error === 'string'), 'and settles into an answer');
    } finally {
      lobby.shutdown('test');
    }
  });

  test('房间结束时 lane 被还回去（池子不再记着这个房间）', async () => {
    const { registry, lobby } = lobbyWithLane();
    try {
      const { session, room } = await startedSolo(lobby, registry);
      assert.equal(pool.lanes[0].matches.has(session.roomCode), true, 'the lane owns the room while it plays');
      lobby.disposeRoom(room, 'test');
      await tick();
      await tick();
      assert.equal(pool.lanes[0].matches.has(session.roomCode), false, 'the lane forgot the room');
      assert.equal(pool.assignments.has(session.roomCode), false, 'and its assignment');
      assert.deepEqual(pool.stats().rooms, 0, 'no room is left on the pool');
    } finally {
      lobby.shutdown('test');
    }
  });
});
