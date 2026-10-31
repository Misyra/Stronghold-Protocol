// test/lobby-bot-band.test.js — AI 指定策略 (room.setBotBand {seat, bandId}): host-only, before the match, co-op rooms
// only; the seat must hold an AI, the strategy must be one the room's mode offers and no other AI seat's. room.state
// seats[].band shows it to everybody and the started match gets it as opts.seats[].band (server/match/Match.js
// botBands — test/match/bot-band.test.js).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
    async closeAll() { await Promise.all([...open].map((c) => c.terminate().catch(() => {}))); open.clear(); },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;

const started = [];
class RecordingMatch extends StubMatch {
  constructor(opts) { super(opts); started.push(opts); }
}

test('protocol: room.setBotBand takes a seat index and a nullable band id', () => {
  assert.equal(validateC2S({ t: 'room.setBotBand', seat: 0, bandId: 'band_bldsk' }), null);
  assert.equal(validateC2S({ t: 'room.setBotBand', seat: 3, bandId: null }), null);
  assert.equal(validateC2S({ t: 'room.setBotBand', seat: 0 }), null);
  for (const msg of [{ t: 'room.setBotBand' }, { t: 'room.setBotBand', seat: -1, bandId: null },
    { t: 'room.setBotBand', seat: 1.5, bandId: null }, { t: 'room.setBotBand', seat: 4, bandId: null },
    { t: 'room.setBotBand', seat: 0, bandId: 7 }, { t: 'room.setBotBand', seat: 0, bandId: 'has space' }]) {
    assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));
  }
});

describe('room.setBotBand (lobby)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RecordingMatch, lobbyGraceMs: 60_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  after(async () => {
    await pool.closeAll();
    await srv.close();
    assert.deepEqual(cap.errors, []);
  });

  test('host-only, AI seats only, one strategy per AI seat; room.state and the match carry it', async () => {
    const host = await pool.player('Host');
    const guest = await pool.player('Guest');
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(guest, { t: 'room.join', code: room.code });
    await ok(host, { t: 'room.addBot' });
    const withBot = await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));
    const bot = withBot.seats.find((x) => x && x.isBot);
    assert.equal(bot.band, null, 'automatic by default');

    // not the host / not an AI seat / not a strategy of the mode
    await err(guest, { t: 'room.setBotBand', seat: bot.seat, bandId: 'band_bldsk' }, ERR.NOT_HOST);
    await err(host, { t: 'room.setBotBand', seat: seatOf(withBot, host.id).seat, bandId: 'band_bldsk' }, ERR.BAD_TARGET);
    await err(host, { t: 'room.setBotBand', seat: bot.seat, bandId: 'band_nope' }, ERR.BAD_TARGET);

    await ok(host, { t: 'room.setBotBand', seat: bot.seat, bandId: 'band_bldsk' });
    const set = await host.waitFor('room.state', (s) => s.seats[bot.seat]?.band === 'band_bldsk');
    assert.equal(seatOf(set, bot.playerId).band, 'band_bldsk');

    // a second AI seat may not take the same strategy; the first one may be cleared to 自动选择
    await ok(host, { t: 'room.addBot' });
    const twoBots = await host.waitFor('room.state', (s) => s.seats.filter((x) => x && x.isBot).length === 2);
    const second = twoBots.seats.find((x) => x && x.isBot && x.seat !== bot.seat);
    await err(host, { t: 'room.setBotBand', seat: second.seat, bandId: 'band_bldsk' }, ERR.BAD_TARGET);
    await ok(host, { t: 'room.setBotBand', seat: second.seat, bandId: null });
    await ok(guest, { t: 'room.ready', ready: true });
    await ok(host, { t: 'room.start' });
    const opts = started.at(-1);
    assert.equal(opts.seats.find((s) => s.playerId === bot.playerId).band, 'band_bldsk');
    assert.equal(opts.seats.find((s) => s.playerId === second.playerId).band, undefined);
  });

  test('a solo room has no AI seat to designate a strategy for', async () => {
    const solo = await pool.player('Solo');
    await ok(solo, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const state = await solo.waitFor('room.state', (s) => s.mode === 'solo');
    await err(solo, { t: 'room.setBotBand', seat: 0, bandId: 'band_bldsk' }, ERR.BAD_TARGET);
    assert.ok(seatOf(state, solo.id));
  });
});
