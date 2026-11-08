// disableLayerCap / disableHitLimit as room options (移植自 Stardust fork test/experimental-limits.test.js):
// optional keys, absent when off; the option set a room, a queue and a match carry. The rules themselves:
// test/match/experimental-limits.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions, experimentalKey, sameExperimental, isExperimental } from '../shared/experimental.js';

const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const LAYERS = rules({ disableLayerCap: true }), HITS = rules({ disableHitLimit: true }), BOTH = rules({ disableLayerCap: true, disableHitLimit: true });

class RecordingMatch {
  constructor(options) { this.opts = options; }
  start() {}
  dispose() {}
  onLeave() {}
  onDisconnect() {}
}
function fixture(t) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 7, log: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(() => lobby.shutdown());
  let number = 0;
  const player = () => {
    const session = registry.create(`LimitOption${++number}`);
    session.connected = true; session.disconnectedAt = null; session.matchmakingVersion = MATCHMAKING_VERSION; session.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    session.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { cb?.(); } };
    return session;
  };
  const room = async (size, experimental = rules(), mode = 'coop') => {
    const members = Array.from({ length: size }, player);
    assert.deepEqual(await lobby.create(members[0], { mode, difficulty: 'NORMAL', experimental }), { ok: true });
    const owner = lobby.roomOf(members[0]);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: owner.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    return { owner, members };
  };
  return { lobby, room };
}

test('shape: off is absent, the key and equality of a room without them are the old ones', () => {
  const off = rules({ disableLayerCap: false, disableHitLimit: false });
  assert.equal(isExperimental(off), true);
  assert.deepEqual(experimentalOptions(off), EXPERIMENTAL_DEFAULTS);
  assert.deepEqual(Object.keys(experimentalOptions(rules())), ['revivalEnabled', 'disableSharedPool']);
  assert.equal(experimentalKey(off), '00'); assert.equal(sameExperimental(off, rules()), true);
  assert.equal(experimentalKey(rules({ revivalEnabled: true, playerCapacity: 8, disableDuckLord: true })), '10:8:duck');
  // this repo's duck-lord gate stands: the flag alone (an ordinary room) never reaches the normalized set
  assert.deepEqual(experimentalOptions(rules({ disableDuckLord: true })), EXPERIMENTAL_DEFAULTS);
});

test('shape: on is kept, keys and equality tell every combination apart, in any capacity', () => {
  assert.deepEqual(experimentalOptions(BOTH), BOTH);
  assert.equal(experimentalKey(LAYERS), '00:layers'); assert.equal(experimentalKey(HITS), '00:hits'); assert.equal(experimentalKey(BOTH), '00:layers:hits');
  const all = rules({ revivalEnabled: true, disableSharedPool: true, playerCapacity: 20, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true, uniteHumansFirst: true });
  assert.equal(isExperimental(all), true); assert.deepEqual(experimentalOptions(all), all);
  assert.equal(experimentalKey(all), '11:20:duck:layers:hits:humans');
  const set = [rules(), LAYERS, HITS, BOTH];
  for (const a of set) for (const b of set) assert.equal(sameExperimental(a, b), a === b);
  assert.equal(new Set(set.map(experimentalKey)).size, 4);
  assert.equal(JSON.stringify(experimentalOptions(JSON.parse(JSON.stringify(BOTH)))), JSON.stringify(experimentalOptions(BOTH)), 'a saved room reads back the same');
});

test('shape: strict booleans, no other keys, and no way in but the nested option set', () => {
  for (const key of ['disableLayerCap', 'disableHitLimit']) for (const bad of ['true', 1, null, undefined]) {
    assert.equal(isExperimental(rules({ [key]: bad })), false, `${key}: ${bad}`);
  }
  assert.equal(isExperimental(rules({ somethingElse: true })), false);
  assert.equal(isExperimental(rules({ disableDuckLord: false, disableLayerCap: false, disableHitLimit: false, playerCapacity: 8, extra: true })), false);
  assert.equal(validateC2S({ t: 'room.setExperimental', experimental: BOTH }), null);
  assert.equal(validateC2S({ t: 'room.create', mode: 'solo', experimental: BOTH }), null);
  assert.ok(validateC2S({ t: 'room.setExperimental', experimental: rules({ disableLayerCap: 'yes' }) }));
  // this repo's queue.join carries no experimental of its own: a party's rules travel with its room (matchmaking.js)
});

test('host sets them in a coop room: teammates un-ready, state shows them, the match gets them', async t => {
  const h = fixture(t), { owner, members } = await h.room(2);
  assert.equal(h.lobby.setExperimental(members[1], { experimental: BOTH }).error, ERR.NOT_HOST);
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: BOTH }), { ok: true });
  assert.equal(owner.seatOf(members[1].playerId).ready, false);
  assert.deepEqual(owner.toState().experimental, BOTH);
  h.lobby.ready(members[1], { ready: true });
  assert.deepEqual(await h.lobby.start(members[0]), { ok: true });
  assert.deepEqual(owner.match.opts.experimental, BOTH);
  assert.equal(h.lobby.setExperimental(members[0], { experimental: rules() }).error, ERR.ROOM_STARTED);
});

test('a solo room takes them too', async t => {
  const h = fixture(t), { owner, members } = await h.room(1, rules(), 'solo');
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: BOTH }), { ok: true });
  assert.deepEqual(owner.toState().experimental, BOTH);
  assert.deepEqual(await h.lobby.start(members[0]), { ok: true });
  assert.deepEqual(owner.match.opts.experimental, BOTH);
});

test('queue: parties with different rules never merge, parties with the same do', async t => {
  const set = [rules(), LAYERS, HITS, BOTH];
  for (const first of set) for (const second of set) {
    const h = fixture(t), a = await h.room(2, first), b = await h.room(2, second);
    assert.deepEqual(h.lobby.handleMessage(a.members[0], { t: 'queue.join', difficulty: 'NORMAL', party: true }), { ok: true });
    assert.deepEqual(h.lobby.handleMessage(b.members[0], { t: 'queue.join', difficulty: 'NORMAL', party: true }), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.lobby.matchmaking.offers.size, first === second ? 1 : 0);
    if (first === second) assert.deepEqual([...h.lobby.matchmaking.offers.values()][0].experimental, first);
  }
});
