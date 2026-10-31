// 启动时那份存档没读出来（Redis 没起来，或内容不是状态文档）时，Persister 不能写 —— 写下去就把没读回来的文档
// 覆盖了。语义取自 xinhai-ai/Stronghold-Protocol 的 Persister.deferLoad / retryLoad：每轮写之前重读一次，
// 读到了就恢复（含线程池里的对局）、保留它的检查点，读不到就继续拒绝写。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Persister, snapshotServer } from '../server/persist.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A store whose reads fail the way a Redis that is not up yet fails: `load()` answers null and `loadState` says why.
 * @param {{ doc?: object | null, failReads?: number }} [opts]
 */
function flakyStore({ doc = null, failReads = Infinity } = {}) {
  let reads = 0;
  return {
    writes: 0,
    saved: null,
    loadState: 'unavailable',
    async load() {
      reads++;
      if (reads <= failReads) { this.loadState = 'unavailable'; return null; }
      this.loadState = doc ? 'loaded' : 'empty';
      return doc ? JSON.parse(JSON.stringify(doc)) : null;
    },
    async save(value) { this.writes++; this.saved = value; return true; },
    async clear() {},
    async close() {},
    get label() { return 'flaky'; },
  };
}

const newLobby = () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quiet, MatchClass: StubMatch, getData: () => ({}) });
  lobby.broadcastState = () => {};
  return { registry, lobby };
};

test('启动读失败期间一轮都不写，关服时的最后一份也不写', async () => {
  const { registry, lobby } = newLobby();
  const store = flakyStore();
  const persister = new Persister({ store, registry, lobby, log: quiet });
  persister.deferLoad();
  try {
    assert.equal(await persister.flush('test'), false, 'a save round is refused');
    assert.equal(store.writes, 0, 'nothing reached the store');
    assert.equal(persister.deferredSkips, 1, 'and the refusal is counted');
    assert.equal(await persister.shutdown('shutdown'), false, 'the final save is refused too');
    assert.equal(store.writes, 0, 'the unread document is still untouched');
    assert.equal(persister.pendingLoad, true, 'still waiting for the read to succeed');
  } finally { await persister.dispose(); lobby.shutdown('test'); }
});

test('存档读回来之后：恢复房间，然后照常写', async () => {
  const source = newLobby();
  const alice = source.registry.create('Alice');
  source.lobby.create(alice, { mode: 'coop', difficulty: 'NORMAL' });
  const doc = snapshotServer({ registry: source.registry, lobby: source.lobby });
  source.lobby.shutdown('test');

  const { registry, lobby } = newLobby();
  const store = flakyStore({ doc, failReads: 1 });
  const persister = new Persister({ store, registry, lobby, log: quiet });
  persister.deferLoad();
  try {
    assert.equal(await persister.flush('test'), false, 'the first retry still sees a dead store');
    assert.equal(lobby.rooms.size, 0, 'so nothing was restored yet');
    assert.equal(await persister.flush('test'), true, 'the second retry reads the document and saves');
    assert.equal(persister.pendingLoad, false, 'writes are unblocked');
    assert.equal(lobby.rooms.size, 1, 'the room came back');
    assert.equal([...registry.all()].length, 1, 'and its identity');
    assert.equal(store.saved?.rooms?.length, 1, 'the document that was written holds it');
  } finally { await persister.dispose(); lobby.shutdown('test'); }
});

test('恢复时保留文档里的检查点与时钟，第一轮写不会把它们丢掉', async () => {
  const source = newLobby();
  const alice = source.registry.create('Alice');
  source.lobby.create(alice, { mode: 'coop', difficulty: 'NORMAL' });
  const code = alice.roomCode;
  const doc = snapshotServer({ registry: source.registry, lobby: source.lobby });
  source.lobby.shutdown('test');
  doc.clocks = { [code]: { deadlineRemainingMs: 4321, startedAtAgoMs: 600 } };
  doc.matches = { [code]: { v: 1, phase: 'PREP', round: 2, seed: 7, players: [] } };

  const { registry, lobby } = newLobby();
  const store = flakyStore({ doc, failReads: 0 });
  const persister = new Persister({ store, registry, lobby, log: quiet });
  persister.deferLoad();
  try {
    assert.equal(await persister.flush('test'), true);
    assert.equal(persister.matchDocs.has(code), true, 'the checkpoint body is kept');
    assert.deepEqual(JSON.parse(persister.matchDocs.get(code)).round, 2);
    assert.equal(persister.matchDocs.get(code).includes('deadlineRemainingMs'), false, 'and is clock-free, like a shard body');
    assert.deepEqual(persister.matchClocks.get(code), { deadlineRemainingMs: 4321, startedAtAgoMs: 600 }, 'the clocks came from the envelope');
    assert.equal(store.saved.matches[code].round, 2, 'and the save carries it');
  } finally { await persister.dispose(); lobby.shutdown('test'); }
});
