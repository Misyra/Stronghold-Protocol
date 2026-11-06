// test/health-rehearsal.test.js — the bot rehearsal counters leave the matches (observability only, no behavior):
// lobby.rehearsalStats() sums Match.rehearsalStats / Match.rehearsalPoolStats over every live room, the [loop] wiring
// carries the same aggregate (server/index.js counts → server/health/eventLoop.js), and /healthz reports it as the
// `rehearsal` key next to the traffic family — behind the same loopback / private gate (`?traffic=1`), never public.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { healthReport } from '../server/http/routes.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Drop the injected stub rooms first: shutdown disposes real rooms, and these are plain objects. */
function dispose(lobby) {
  for (const code of ['ROOM1', 'ROOM2', 'ROOM3']) lobby.rooms.delete(code);
  lobby.shutdown();
}

function lobbyWithRooms() {
  const lobby = new Lobby({ registry: new SessionRegistry(), log: quiet, getData: () => ({}) });
  // a live match mid-rehearsal: three delegated tasks answered, one taken over, two handed to the pool (one accepted,
  // one the pool could not pick — the server ran it); a room whose match runs elsewhere (a stub without the counters);
  // and a room without a match at all. Each contributes only what it holds.
  lobby.rooms.set('ROOM1', {
    seats: [], spectators: [],
    match: { phase: 'PREP', rehearsalStats: { delegated: 4, answered: 3, takeovers: 1 }, rehearsalPoolStats: { pooled: 2, accepted: 1, fallbacks: 1 } },
  });
  lobby.rooms.set('ROOM2', { seats: [], spectators: [], match: { phase: 'COMBAT', _rehearsalTasks: new Map() } });
  lobby.rooms.set('ROOM3', { seats: [], spectators: [], match: null });
  return lobby;
}

test('lobby.rehearsalStats sums the rehearsal counters of every live match', () => {
  const lobby = lobbyWithRooms();
  assert.deepEqual(lobby.rehearsalStats(), { delegated: 4, answered: 3, takeovers: 1, pooled: 2, accepted: 1, fallbacks: 1 });
  assert.deepEqual(lobby.stats().matchmaking, lobby.stats().matchmaking, 'stats() is untouched');
  dispose(lobby);
});

test('an empty hall aggregates zeros', () => {
  const lobby = new Lobby({ registry: new SessionRegistry(), log: quiet, getData: () => ({}) });
  assert.deepEqual(lobby.rehearsalStats(), { delegated: 0, answered: 0, takeovers: 0, pooled: 0, accepted: 0, fallbacks: 0 });
  dispose(lobby);
});

test('/healthz carries `rehearsal` only for a loopback traffic request, the public body stays without it', () => {
  const lobby = lobbyWithRooms();
  const health = { startedAt: Date.now(), network: { connectionCount: 0 }, registry: { size: 0 }, lobby };
  const report = healthReport(health, false);
  assert.equal(report.rehearsal, undefined, 'the public /healthz a tunnel probe sees has no rehearsal key');
  const withTraffic = healthReport(health, true);
  assert.deepEqual(withTraffic.rehearsal, { delegated: 4, answered: 3, takeovers: 1, pooled: 2, accepted: 1, fallbacks: 1 },
    'and the ?traffic=1 body reports the aggregate next to the traffic family');
  dispose(lobby);
});
