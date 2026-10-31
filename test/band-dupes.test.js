// test/band-dupes.test.js — 「允许重复策略」 (room.setBandDupes { on }, 本仓新设): host-only, before the match, co-op
// rooms only; room.state.bandDupes shows it. In the match (Match opts.bandDupes) the 队友已选 guard stands down —
// bandTaken answers false, so several seats may hold the same strategy, the draft view carries draft.dupes and the AI
// reservation (room.setBotBand) is not shown.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { PHASE, ERR } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { makeMatch } from './match/harness.js';

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
    async closeAll() { await Promise.all([...open].map((c) => c.terminate().catch(() => {}))); open.clear(); },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };

import { TestClient } from './helpers/wsClient.js';

test('protocol: room.setBandDupes takes a boolean', () => {
  assert.equal(validateC2S({ t: 'room.setBandDupes', on: true }), null);
  assert.equal(validateC2S({ t: 'room.setBandDupes', on: false }), null);
  for (const msg of [{ t: 'room.setBandDupes' }, { t: 'room.setBandDupes', on: 1 }, { t: 'room.setBandDupes', on: 'yes' }]) {
    assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));
  }
});

describe('room.setBandDupes (lobby)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, lobbyGraceMs: 60_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  after(async () => {
    await pool.closeAll();
    await srv.close();
    assert.deepEqual(cap.errors, []);
  });

  test('host-only, co-op only; room.state carries it and a change un-readies the others', async () => {
    const host = await pool.player('HostD');
    const guest = await pool.player('GuestD');
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(guest, { t: 'room.join', code: room.code });
    await ok(guest, { t: 'room.ready', ready: true });
    assert.equal(room.bandDupes, false, 'off by default');

    await err(guest, { t: 'room.setBandDupes', on: true }, ERR.NOT_HOST);
    await ok(host, { t: 'room.setBandDupes', on: true });
    const on = await host.waitFor('room.state', (s) => s.bandDupes === true);
    assert.equal(on.bandDupes, true);
    const guestSeat = on.seats.find((s) => s && s.playerId === guest.id);
    assert.equal(guestSeat.ready, false, 'a change un-readies the other humans');

    await ok(host, { t: 'room.setBandDupes', on: false });
    const off = await host.waitFor('room.state', (s) => s.bandDupes === false);
    assert.equal(off.bandDupes, false);
  });

  test('a solo room has no strategy draft to share', async () => {
    const solo = await pool.player('SoloD');
    await ok(solo, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await solo.waitFor('room.state', (s) => s.mode === 'solo');
    await err(solo, { t: 'room.setBandDupes', on: true }, ERR.BAD_TARGET);
  });
});

describe('bandDupes in the match', () => {
  test('bandTaken stands down; two seats may hold the same strategy; the draft view says dupes', () => {
    const h = makeMatch({ mode: 'coop', humans: 3, seed: 5, bandDupes: true }).start();
    const m = h.m;
    for (const id of ['p_0', 'p_1', 'p_2']) m.handle(id, { t: 'g.infoReady' });
    h.sched.advance(1);
    assert.equal(m.phase, PHASE.BAND_DRAFT);
    assert.equal(m.bandDupes, true);
    assert.equal(m.publicView().draft.dupes, true, 'the draft view tells the client');
    assert.equal(m.publicView().draft.reserved, undefined, 'the AI reservation is not shown');
    // the first two humans take the same strategy (the draft's default): both hold it
    const [first, second] = m.draft.order;
    const bandId = 'band_sarkazb';
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId }), { ok: true });
    assert.deepEqual(m.handle(second, { t: 'g.band', bandId }), { ok: true }, 'no 队友已选 refusal');
    assert.equal(m.players.get(first).bandId, bandId);
    assert.equal(m.players.get(second).bandId, bandId);
    assert.equal(m.bandTaken(bandId, 'nobody'), false, 'the guard is off entirely');
    m.dispose();
  });

  test('without the flag the guard holds (the default is unchanged)', () => {
    const h = makeMatch({ mode: 'coop', humans: 3, seed: 5 }).start();
    const m = h.m;
    for (const id of ['p_0', 'p_1', 'p_2']) m.handle(id, { t: 'g.infoReady' });
    h.sched.advance(1);
    assert.equal(m.phase, PHASE.BAND_DRAFT);
    assert.equal(m.bandDupes, false);
    const [first, second] = m.draft.order;
    const bandId = 'band_sarkazb';
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId }), { ok: true });
    assert.equal(m.handle(second, { t: 'g.band', bandId }).error, ERR.BAD_TARGET, '队友已选');
    m.dispose();
  });
});
