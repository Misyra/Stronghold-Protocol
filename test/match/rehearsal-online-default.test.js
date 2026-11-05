// The online default of the delegated bot layout rehearsal (DESIGN §14; maintainer decision 2026-11-05):
// server/lobby.js passes `botRehearsalDelegate: true` into every room's Match unless SP_BOT_REHEARSAL is
// server|off|0|false (hostRehearsalDefault). Match's own default stays off, so botbench, golden results, replay
// decoding and the studio — all of which construct a Match directly — keep the deterministic server-run rehearsal.
// The engine-level contract and every fallback branch live in test/match/rehearsal-delegate.test.js; this file pins
// only where the option comes from.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';
import { Match } from '../../server/match/Match.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Run `fn` with SP_BOT_REHEARSAL set to `value` (undefined deletes it), restoring the process environment after. */
function withEnv(value, fn) {
  const had = Object.hasOwn(process.env, 'SP_BOT_REHEARSAL');
  const before = process.env.SP_BOT_REHEARSAL;
  if (value === undefined) delete process.env.SP_BOT_REHEARSAL;
  else process.env.SP_BOT_REHEARSAL = value;
  try {
    return fn();
  } finally {
    if (had) process.env.SP_BOT_REHEARSAL = before;
    else delete process.env.SP_BOT_REHEARSAL;
  }
}

/** The Match options the lobby builds for one started room (a recording MatchClass; nothing simulates). */
class RecordingMatch {
  static last = null;
  constructor(opts) { this.opts = opts; RecordingMatch.last = opts; }
  start() {}
  dispose() {}
}

/** A one-human co-op room started through the lobby's own online path (room.create → room.start). */
function startOnlineRoom() {
  RecordingMatch.last = null;
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quiet, MatchClass: RecordingMatch, getData: () => ({}) });
  const host = registry.create('Host');
  host.connected = true;
  host.disconnectedAt = null;
  host.ws = { readyState: 1, bufferedAmount: 0, send() {}, terminate() {} };
  assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  assert.deepEqual(lobby.start(host), { ok: true });
  const opts = RecordingMatch.last;
  lobby.shutdown();
  return opts;
}

test('an online room delegates the bot rehearsal to its host by default (SP_BOT_REHEARSAL unset)', () => {
  withEnv(undefined, () => {
    assert.equal(startOnlineRoom().botRehearsalDelegate, true);
  });
});

test('SP_BOT_REHEARSAL=host keeps the online default on', () => {
  withEnv('host', () => {
    assert.equal(startOnlineRoom().botRehearsalDelegate, true);
  });
});

test('SP_BOT_REHEARSAL=server|off|0|false turns the online default off (case-insensitive)', () => {
  for (const value of ['server', 'off', '0', 'false', 'SERVER', ' Off ', 'FALSE']) {
    withEnv(value, () => {
      assert.equal(startOnlineRoom().botRehearsalDelegate, false, `SP_BOT_REHEARSAL=${JSON.stringify(value)}`);
    });
  }
});

test('a directly constructed Match keeps the engine default: off (the tools and golden are unaffected)', () => {
  withEnv(undefined, () => {
    const m = new Match({
      mode: 'coop', difficulty: 'NORMAL',
      seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }],
      send() { return true; }, broadcast() {}, onEnd() {},
    });
    assert.equal(m.botRehearsalDelegate, false);
    m.dispose();
  });
});
