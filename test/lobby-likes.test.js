// test/lobby-likes.test.js — 结算点赞 on the settlement's 同盟 page (the owner's request of 2026-11-05, Stardust fork
// rel33 7c99acc1; server/lobby.js like): back in the room after a match, each human player of it may like each other one
// once (room.like {playerId}); the whole room hears room.likes {match, counts, from, to}; a player's result replay is
// followed by its own room.likes with `mine`. Memory only, for that one match: refused while the next match runs,
// replaced when it ends. A repeated same-direction like answers ok with no side effects and no broadcast (the vote /
// choice iron rule — the fork answered ALREADY; this repo's rule wins). The browser page is test/ui/likes.test.js.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, PHASE } from '../shared/constants.js';
import { validateC2S, S2C } from '../shared/protocol.js';
import { likesOf, likesFrame } from '../server/lobby.js';

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
const like = (to) => ({ t: 'room.like', playerId: to });

describe('room.like: protocol and the room record', () => {
  test('room.like {playerId} is a C2S message, room.likes an S2C one', () => {
    assert.equal(validateC2S({ t: 'room.like', playerId: 'p_0123456789' }), null);
    assert.notEqual(validateC2S({ t: 'room.like' }), null, 'the target is required');
    assert.notEqual(validateC2S({ t: 'room.like', playerId: '' }), null);
    assert.notEqual(validateC2S({ t: 'room.like', playerId: 7 }), null);
    assert.ok(S2C.includes('room.likes'));
  });

  test('likesOf: the human players still in the match; none below two', () => {
    const rows = [
      { playerId: 'a', isBot: false }, { playerId: 'b', isBot: false }, { playerId: 'ai_1', isBot: true },
      { playerId: 'gone', isBot: false, left: true }, null, { isBot: false },
    ];
    const l = likesOf({ players: rows }, 3);
    assert.equal(l.match, 3);
    assert.deepEqual([...l.players].sort(), ['a', 'b']);
    assert.equal(l.given.size, 0);
    assert.equal(l.counts.size, 0);
    assert.equal(likesOf({ players: [{ playerId: 'a', isBot: false }, { playerId: 'ai_1', isBot: true }] }, 1), null, 'a lone human');
    for (const summary of [null, undefined, {}, { players: 'x' }, { synthetic: true }]) assert.equal(likesOf(summary, 1), null);
  });

  test('likesFrame: counts, the like, and a player\'s own list', () => {
    const l = likesOf({ players: [{ playerId: 'a' }, { playerId: 'b' }, { playerId: 'c' }] }, 2);
    l.given.add('a\nb'); l.given.add('a\nc'); l.given.add('b\na');
    l.counts.set('b', 1); l.counts.set('c', 1); l.counts.set('a', 1);
    assert.deepEqual(likesFrame(l, { from: 'a', to: 'b' }), { t: 'room.likes', match: 2, counts: { b: 1, c: 1, a: 1 }, from: 'a', to: 'b' });
    assert.deepEqual(likesFrame(l, { mine: 'a' }), { t: 'room.likes', match: 2, counts: { b: 1, c: 1, a: 1 }, mine: ['b', 'c'] });
    assert.deepEqual(likesFrame(l, { mine: 'c' }).mine, []);
  });
});

describe('room.like (lobby)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: StubMatch, lobbyGraceMs: 60_000, resyncMinGapMs: 50 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  async function createRoom(c, mode = 'coop') {
    await ok(c, { t: 'room.create', mode, difficulty: 'NORMAL' });
    return c.waitFor('room.state', (s) => s.hostId === c.id);
  }
  async function joinRoom(c, code) {
    await ok(c, { t: 'room.join', code });
    return c.waitFor('room.state', (s) => s.code === code && !!seatOf(s, c.id));
  }
  /** One StubMatch played to its end (every human g.infoReady). */
  async function playMatch(humans, host) {
    for (const c of humans) if (c !== host) await ok(c, { t: 'room.ready', ready: true });
    for (const c of humans) c.clearInbox();
    await ok(host, { t: 'room.start' });
    for (const c of humans) await c.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    for (const c of humans) await ok(c, { t: 'g.infoReady' });
    for (const c of humans) await c.waitFor('m.result');
    for (const c of humans) await c.waitFor('room.state', (s) => !s.inMatch);
  }
  /** Host + guest + an AI seat (+ a spectator), one match played. */
  async function settled({ spectator = false } = {}) {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await ok(host, { t: 'room.addBot' });
    const withBot = await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));
    const bot = withBot.seats.find((x) => x && x.isBot).playerId;
    let spec = null;
    if (spectator) {
      spec = await pool.player('Spec');
      await ok(spec, { t: 'room.spectate', code: st.code });
      await spec.waitFor('room.state', (s) => s.code === st.code);
    }
    await playMatch([host, guest], host);
    return { host, guest, spec, bot, code: st.code };
  }

  test('a like reaches the whole room with the counts; once per pair', async () => {
    const { host, guest, spec } = await settled({ spectator: true });
    for (const c of [host, guest, spec]) c.clearInbox();
    await ok(host, like(guest.id));
    for (const c of [host, guest, spec]) {
      const m = await c.waitFor('room.likes');
      assert.deepEqual(m, { t: 'room.likes', match: 1, counts: { [guest.id]: 1 }, from: host.id, to: guest.id }, c.id);
    }
    // a repeated same-direction like: ok, no side effects, no broadcast (the vote/choice iron rule)
    await ok(host, like(guest.id));
    await host.expectNone('room.likes', () => true, 150);
    await ok(guest, like(host.id));
    const m = await spec.waitFor('room.likes', (x) => x.from === guest.id);
    assert.deepEqual(m.counts, { [guest.id]: 1, [host.id]: 1 });
    for (const c of [host, guest, spec]) c.clearInbox(); // drain the new like's frames first
    await ok(guest, like(host.id));
    await guest.expectNone('room.likes', () => true, 150);
  });

  test('refused: yourself, an AI seat, nobody of the match, a spectator, a newcomer, before any match', async () => {
    const lone = await pool.player('Lone');
    const st0 = await createRoom(lone);
    const mate = await pool.player('Mate');
    await joinRoom(mate, st0.code);
    await err(lone, like(mate.id), ERR.WRONG_PHASE); // no match yet
    const outside = await pool.player('Outside');
    await err(outside, like(lone.id), ERR.NOT_IN_ROOM);

    const { host, guest, spec, bot, code } = await settled({ spectator: true });
    await err(host, like(host.id), ERR.BAD_TARGET);
    await err(host, like(bot), ERR.BAD_TARGET);
    await err(host, like('p_nobody_here'), ERR.BAD_TARGET);
    await err(host, like(spec.id), ERR.BAD_TARGET);
    await err(spec, like(host.id), ERR.SPECTATOR);
    const late = await pool.player('Late');
    await joinRoom(late, code);
    await err(late, like(host.id), ERR.BAD_TARGET); // joined after the match
    await err(host, like(late.id), ERR.BAD_TARGET);
    await ok(host, like(guest.id));
  });

  test('a player who departed during the match is out', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const a = await pool.player('A');
    const b = await pool.player('B');
    await joinRoom(a, st.code);
    await joinRoom(b, st.code);
    for (const c of [a, b]) await ok(c, { t: 'room.ready', ready: true });
    await ok(host, { t: 'room.start' });
    for (const c of [host, a, b]) await c.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    await ok(host, { t: 'g.infoReady' });
    await ok(a, { t: 'g.infoReady' });
    await ok(b, { t: 'g.leave' }); // the last human not ready departs: the stub match ends
    await host.waitFor('room.state', (s) => !s.inMatch);
    await err(host, like(b.id), ERR.BAD_TARGET);
    await ok(host, like(a.id));
  });

  test('a solo room has nobody to like', async () => {
    const solo = await pool.player('Solo');
    await createRoom(solo, 'solo');
    await playMatch([solo], solo);
    await err(solo, like('p_anyone'), ERR.WRONG_PHASE);
  });

  test('the next match: refused while it runs, a fresh record when it ends', async () => {
    const { host, guest } = await settled();
    await ok(host, like(guest.id));
    await ok(guest, { t: 'room.ready', ready: true });
    await ok(host, { t: 'room.start' });
    await host.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    await err(host, like(guest.id), ERR.WRONG_PHASE);
    for (const c of [host, guest]) await ok(c, { t: 'g.infoReady' });
    for (const c of [host, guest]) await c.waitFor('room.state', (s) => !s.inMatch);
    guest.clearInbox();
    await ok(host, like(guest.id));
    const m = await guest.waitFor('room.likes');
    assert.deepEqual(m, { t: 'room.likes', match: 2, counts: { [guest.id]: 1 }, from: host.id, to: guest.id });
  });

  test('a reload on the settlement: the result replay, then the likes with the ones I gave', async () => {
    const { host, guest } = await settled();
    await ok(host, like(guest.id));
    await ok(guest, like(host.id));
    await guest.waitFor('room.likes', (x) => x.from === guest.id);
    await guest.terminate();
    const back = await pool.connect();
    const w = await back.hello('Guest', guest.token);
    assert.equal(w.resumed, true);
    const m = await back.waitFor('room.likes');
    assert.deepEqual(m, { t: 'room.likes', match: 1, counts: { [guest.id]: 1, [host.id]: 1 }, mine: [host.id] });
    const settlement = new Set(['m.public', 'm.result', 'room.likes']);
    assert.deepEqual(back.log.filter((x) => settlement.has(x.t)).map((x) => x.t + (x.t === 'm.public' ? `:${x.phase}` : '')),
      [`m.public:${PHASE.RESULT}`, 'm.result', 'room.likes'], 'after the result replay');
    // once the player acted in the room, a reload replays nothing — the likes neither
    await ok(back, { t: 'room.ready', ready: true });
    await back.terminate();
    const again = await pool.connect();
    await again.hello('Guest', guest.token);
    await again.waitFor('room.state');
    await again.expectNone('room.likes', () => true, 250);
    // the settlement's likes still stand for whoever is on it: the repeat is ok and broadcasts nothing
    await ok(again, like(host.id));
    await again.expectNone('room.likes', () => true, 150);
  });
});
