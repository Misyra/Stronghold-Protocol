// test/lobby-afk.test.js — the AFK rule (挂机移出, 移植自用户分支) behind the real platform: the startServer option
// afkRemoveRounds reaches the Match (server/http/config.js → server/lobby.js → Match opts), and a human the match removes
// (opts.onRemove → Lobby.matchRemoved) leaves its room exactly like a g.leave — m.removed to it, m.notice afkRemoved to
// the other players and the spectator seats, its seat departed until the match ends, its session free for another room.
// Removed while offline, it gets room.closed { reason: 'afk' } on its next resume. Phase timers are scaled down; battles
// are FakeBattle.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { Match } from '../server/match/Match.js';
import { FakeBattle } from './match/fakeBattle.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

class FastMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 0.02, BattleClass: FakeBattle, clientCombat: false }); FastMatch.last = this; }
}
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;

describe('the AFK rule over the in-process platform', () => {
  let srv;
  const open = new Set(), errors = [];
  const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
  const player = async (name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    open.add(c);
    const w = await c.hello(name, token);
    c.id = w.playerId;
    c.token = w.token;
    return c;
  };
  before(async () => {
    FakeBattle.reset();
    // long enough that the first battle stays open while the assertions run
    FakeBattle.script = () => ({ duration: 30 });
    srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: FastMatch, seedFn: () => 77, afkRemoveRounds: 1 });
  });
  afterEach(async () => { await Promise.all([...open].map((c) => c.terminate().catch(() => {}))); open.clear(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(errors, [], 'no server errors logged');
  });

  /** A co-op room of Host + Guest (+ a spectator seat): started; the host confirms, drafts and plays its first prep. */
  async function startedRoom({ spectator = false } = {}) {
    const host = await player('Host');
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const st = await host.waitFor('room.state', (s) => s.hostId === host.id);
    const guest = await player('Guest');
    await ok(guest, { t: 'room.join', code: st.code });
    await ok(guest, { t: 'room.ready', ready: true });
    let watcher = null;
    if (spectator) {
      watcher = await player('Watcher');
      await ok(watcher, { t: 'room.spectate', code: st.code });
    }
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.ready && (!spectator || s.spectators.length === 1));
    await ok(host, { t: 'room.start' });
    const m = FastMatch.last;
    assert.equal(m.afkRemoveRounds, 1, 'the startServer option reaches the Match');
    await ok(host, { t: 'g.infoReady' });
    // 自由选策略 (match/phases.js freeDraft; ≥2 humans draft freely): no turn — the host picks as soon as the step opens;
    // the idle guest keeps waiting and its strategy is fixed by the step's countdown
    const frame = await host.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT' && p.draft?.concurrent && !p.draft.picks[host.id], 10000);
    const band = m.gd.bandIds().find((b) => m.gd.bandAllowed(b) && !Object.values(frame.draft.picks).includes(b));
    await ok(host, { t: 'g.band', bandId: band });
    await host.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 1, 10000);
    await ok(host, { t: 'g.freeze' });
    await host.request({ t: 'g.ready', ready: true });
    return { host, guest, watcher, code: st.code, m };
  }

  test('an idle human is removed like a leaver: m.removed, m.notice to the rest, seat departed, session free', async () => {
    const { host, guest, watcher, code, m } = await startedRoom({ spectator: true });
    const removed = await guest.waitFor('m.removed', () => true, 10000);
    assert.deepEqual(removed, { t: 'm.removed', reason: 'afk', rounds: 1 });
    const notice = { t: 'm.notice', kind: 'afkRemoved', playerId: guest.id, name: 'Guest', rounds: 1 };
    assert.deepEqual(await host.waitFor('m.notice'), notice);
    assert.deepEqual(await watcher.waitFor('m.notice'), notice);
    const state = await host.waitFor('room.state', (s) => s.inMatch && seatOf(s, guest.id)?.connected === false);
    assert.equal(state.code, code);
    assert.ok(m.players.get(guest.id).left);
    assert.equal(m.round, 1);
    await host.waitFor('m.public', (p) => p.phase === 'COMBAT' && p.players.find((x) => x.playerId === guest.id)?.status === 'left', 5000);
    // the guest is out of the room: no more match frames, its leave is a no-op, it may open a new room at once
    await guest.expectNone('m.notice');
    guest.clearInbox();
    await guest.expectNone('m.public', () => true, 300);
    await err(guest, { t: 'g.leave' }, ERR.NOT_IN_ROOM);
    await err(guest, { t: 'room.leave' }, ERR.NOT_IN_ROOM);
    await ok(guest, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await ok(guest, { t: 'room.leave' });
    // like a quitter's seat, it is freed when the match ends
    host.clearInbox();
    m.finish({ victory: false, reason: 'defeat' });
    const back = await host.waitFor('room.state', (s) => !s.inMatch);
    assert.equal(seatOf(back, guest.id), null);
    assert.equal(seatOf(back, host.id).seat, 0);
  });

  test('removed while offline: room.closed { reason: afk } on the next resume', async () => {
    const { host, guest, m } = await startedRoom();
    const token = guest.token;
    await guest.terminate();
    open.delete(guest);
    await host.waitFor('m.notice', (n) => n.playerId === guest.id, 10000);
    assert.ok(m.players.get(guest.id).left);
    const back = await player('Guest', token);
    assert.equal(back.id, guest.id, 'the same session resumed');
    assert.deepEqual(await back.waitFor('room.closed'), { t: 'room.closed', reason: 'afk' });
    await back.expectNone('m.removed');
    await err(back, { t: 'room.ready', ready: true }, ERR.NOT_IN_ROOM);
    m.finish({ victory: false, reason: 'defeat' });
  });
});
