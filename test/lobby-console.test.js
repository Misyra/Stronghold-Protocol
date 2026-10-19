// test/lobby-console.test.js — the room side of the in-match developer console (room.console.enable|disable,
// server/lobby.js enableConsole; the grants themselves leave through g.console, test/match/console-*.test.js).
// A private room opts in before the match: a solo room's own seat may toggle it, every other room needs its host,
// a spectator may not, a room waiting on the queue may not, and the running match keeps the flag it started with.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect() { const c = await TestClient.connect(getUrl()); open.add(c); return c; },
    async player(name, token) {
      const c = await this.connect();
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
async function createRoom(c, mode = 'coop') {
  await ok(c, { t: 'room.create', mode, difficulty: 'NORMAL' });
  return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
}
async function joinRoom(c, code) {
  await ok(c, { t: 'room.join', code });
  return c.waitFor('room.state', (s) => s.code === code && !!seatOf(s, c.id));
}

/** StubMatch that records the options each match was started with. */
const started = [];
class RecordingMatch extends StubMatch {
  constructor(opts) {
    super(opts);
    started.push(opts);
  }
}

test('protocol: room.console.enable|disable exist and take no fields', () => {
  assert.equal(validateC2S({ t: 'room.console.enable' }), null);
  assert.equal(validateC2S({ t: 'room.console.disable' }), null);
  // the feature is reachable only under the two verbs the lobby dispatches (server/lobby.js handleMessage)
  assert.notEqual(validateC2S({ t: 'room.console' }), null);
  assert.notEqual(validateC2S({ t: 'room.console.toggle' }), null);
});

describe('room.console (lobby)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RecordingMatch, lobbyGraceMs: 60_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  test('a solo room\'s own seat toggles it; the match starts with consoleEnabled and keeps it after', async () => {
    const me = await pool.player('Solo');
    const st = await createRoom(me, 'solo');
    assert.equal(st.consoleEnabled, false, 'off by default');
    await ok(me, { t: 'room.console.enable' });
    await me.waitFor('room.state', (s) => s.consoleEnabled === true);
    await err(me, { t: 'room.console.enable' }, ERR.ALREADY);
    await ok(me, { t: 'room.console.disable' });
    await me.waitFor('room.state', (s) => s.consoleEnabled === false);
    await err(me, { t: 'room.console.disable' }, ERR.ALREADY);

    await ok(me, { t: 'room.console.enable' });
    await me.waitFor('room.state', (s) => s.consoleEnabled === true);
    const n = started.length;
    await ok(me, { t: 'room.start' });
    await me.waitFor('room.state', (s) => s.inMatch === true);
    assert.equal(started.length, n + 1);
    assert.equal(started[n].consoleEnabled, true, 'opts.consoleEnabled');
    // a running match holds the authorization it started with
    await err(me, { t: 'room.console.disable' }, ERR.ROOM_STARTED);
  });

  test('a co-op room needs its host; every seat sees the flag; a spectator may not', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    const gs = await joinRoom(guest, st.code);
    assert.equal(gs.consoleEnabled, false);
    await err(guest, { t: 'room.console.enable' }, ERR.NOT_HOST);
    await ok(host, { t: 'room.console.enable' });
    await guest.waitFor('room.state', (s) => s.consoleEnabled === true);
    await err(guest, { t: 'room.console.disable' }, ERR.NOT_HOST);
    await ok(host, { t: 'room.console.disable' });
    await guest.waitFor('room.state', (s) => s.consoleEnabled === false);

    const walk = await pool.player('Watcher');
    await ok(walk, { t: 'room.spectate', code: st.code });
    await err(walk, { t: 'room.console.enable' }, ERR.SPECTATOR);
    // a player outside any room has nothing to opt in
    const stray = await pool.player('Stray');
    await err(stray, { t: 'room.console.enable' }, ERR.NOT_IN_ROOM);
  });

  test('a room waiting on the queue cannot switch it on (and an opted-in room cannot queue)', async () => {
    const host = await pool.player('Queuer');
    const st = await createRoom(host);
    await ok(host, { t: 'room.matchmaking' });
    await host.waitFor('queue.state', (s) => s.state === 'queued');
    await err(host, { t: 'room.console.enable' }, ERR.QUEUED);
    await ok(host, { t: 'queue.cancel' });
    await host.waitFor('queue.state', (s) => s.state === 'idle');
    // the other direction: console first, queue refused
    await ok(host, { t: 'room.console.enable' });
    await host.waitFor('room.state', (s) => s.consoleEnabled === true);
    await err(host, { t: 'room.matchmaking' }, ERR.CONSOLE_ON);
    await ok(host, { t: 'room.console.disable' });
    await host.waitFor('room.state', (s) => s.consoleEnabled === false);
    void st;
  });
});

// The client side of the same rule: the switch itself says what it costs (a 5 s warn toast, because the ⚙ sheet that
// holds it is nowhere near the 开始搜寻 button), and the button stays put, disabled, with the reason in its tooltip —
// a hidden button taught nobody why the queue was gone (feedback on 0.3.1).
describe('room.js: 开发者控制台 in the client', () => {
  const src = readFileSync(new URL('../public/js/screens/room.js', import.meta.url), 'utf8');
  test('turning it on says so for five seconds', () => {
    assert.match(src, /toast\(t\('开发者控制台已开启：本房间不会进入匹配队列'\), 'warn', \{ ttl: 5000 \}\)/);
  });
  test('the ⚙ sheet says it while it is on', () => {
    assert.match(src, /\$\{option\.on \? html`<span class="t-dim">\$\{t\('不能进入匹配队列'\)\}<\/span>` : null\}/);
  });
  test('开始搜寻 stays on screen, disabled, with the reason', () => {
    assert.match(src, /disabled=\$\{!online \|\| busy === 'match' \|\| consoleOn\}/);
    assert.match(src, /title=\$\{consoleOn \? t\('房间已开启开发者控制台，无法进入匹配队列'\) : undefined\}/);
    assert.match(src, /const consoleOn = room\?\.consoleEnabled === true;/);
  });
});
