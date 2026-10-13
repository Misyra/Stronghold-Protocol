import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BotPopulation } from '../server/botPopulation.js';
import { startServer } from '../server/index.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { snapshotServer, restoreServer } from '../server/persist.js';
import { lobbyOptionsFrom } from '../server/http/config.js';
import { ERR, ERR_TEXT } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const countryLookup = (ip) => ({ '203.0.113.1': 'US', '203.0.113.2': 'HK', '203.0.113.3': 'CN' })[ip] ?? null;
const bot = (botCountry = null) => ({ playerId: 'ai_same', isBot: true, left: false, botCountry });

function fixture(t, options = {}, lookup = countryLookup) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quiet, MatchClass: StubMatch, getData: () => ({}), countryLookup: lookup, options });
  t.after(() => lobby.shutdown());
  const host = (ip = '203.0.113.1') => {
    const s = registry.create('Host');
    s.addr = ip;
    s.connected = true;
    assert.deepEqual(lobby.create(s, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
    return s;
  };
  return { registry, lobby, host };
}

test('default caps are 300 total and 50 foreign and reject invalid startup values', () => {
  const p = new BotPopulation();
  assert.equal(p.stats().maxTotal, 300);
  assert.equal(p.stats().maxForeign, 50);
  const opts = lobbyOptionsFrom({}, {});
  assert.equal(opts.maxBots, 300);
  assert.equal(opts.maxForeignBots, 50);
  assert.equal(lobbyOptionsFrom({}, { SP_BOT_MAX_TOTAL: '99', SP_BOT_MAX_FOREIGN: '12' }).maxForeignBots, 12);
  for (const n of [0, -1, 0.5, 10001, NaN, '50']) {
    assert.throws(() => new BotPopulation({ maxTotal: n }), RangeError);
    assert.throws(() => new BotPopulation({ maxForeign: n }), RangeError);
  }
  assert.throws(() => lobbyOptionsFrom({}, { SP_BOT_MAX_TOTAL: '0' }), RangeError);
  assert.throws(() => new BotPopulation({ countryLookup: {} }), TypeError);
});

test('exact default boundaries, foreign regions share one cap, total refusal has priority', () => {
  let country = 'US';
  const p = new BotPopulation({ countryLookup: () => country });
  for (let i = 0; i < 50; i++) {
    country = ['US', 'HK', 'MO', 'TW'][i % 4];
    const admission = p.canAdd(`203.0.113.${i + 1}`);
    assert.equal(admission.ok, true);
    p.track(bot(admission.country));
  }
  assert.equal(p.stats().foreign, 50);
  assert.equal(p.canAdd('203.0.113.99').code, ERR.FOREIGN_AI_POPULATION_LIMIT);
  country = 'CN';
  for (let i = 50; i < 300; i++) {
    assert.equal(p.canAdd('203.0.113.100').ok, true);
    p.track(bot(country));
  }
  country = 'HK';
  assert.equal(p.canAdd('203.0.113.101').code, ERR.AI_POPULATION_LIMIT);
  assert.equal(p.stats().total, 300);
  assert.equal(p.stats().foreignDenied, 1);
  assert.equal(p.stats().totalDenied, 1);
});

test('tracking is idempotent and uses seat identity, not random bot IDs', () => {
  const p = new BotPopulation(), a = bot('HK'), b = bot('CN');
  p.track(null);
  p.track({ isBot: false });
  p.track({ ...a, left: true });
  p.track(a);
  p.track(a);
  p.track(b);
  assert.equal(p.stats().total, 2);
  assert.equal(p.stats().foreign, 1);
  a.botCountry = 'CN';
  p.release(a);
  p.release(a);
  assert.equal(p.stats().total, 1);
  assert.equal(p.stats().foreign, 0, 'release uses the original tracked country');
  p.release(b);
  assert.equal(p.stats().total, 0);
});

test('unknown, private, absent and broken lookups cannot bypass the global cap', () => {
  const p = new BotPopulation({ maxTotal: 2, maxForeign: 1, countryLookup: () => { throw new Error('lookup'); } });
  assert.deepEqual(p.canAdd('127.0.0.1'), { ok: true, country: null });
  assert.equal(p.stats().lookupErrors, 0);
  assert.deepEqual(p.canAdd('203.0.113.1'), { ok: true, country: null });
  assert.equal(p.stats().lookupErrors, 1);
  assert.equal(p.stats().lookupMisses, 1);
  p.track(bot());
  p.track(bot('invalid'));
  assert.equal(p.canAdd('203.0.113.1').code, ERR.AI_POPULATION_LIMIT);
  const noDb = new BotPopulation({ maxTotal: 1 });
  noDb.track(bot());
  assert.equal(noDb.stats().foreignEnabled, false);
  assert.equal(noDb.canAdd('203.0.113.1').code, ERR.AI_POPULATION_LIMIT);
  const miss = new BotPopulation({ countryLookup: () => 'bad' });
  assert.equal(miss.canAdd('203.0.113.1').country, null);
  assert.equal(miss.stats().lookupMisses, 1);
});

test('room removal and destruction free shared caps; existing rooms can start at capacity', (t) => {
  const { lobby, host } = fixture(t, { maxBots: 3, maxForeignBots: 1 });
  const overseas = host(), domestic = host('203.0.113.3'), other = host('203.0.113.2');
  assert.equal(lobby.addBot(overseas).ok, true);
  assert.equal(lobby.addBot(other).error, ERR.FOREIGN_AI_POPULATION_LIMIT);
  assert.equal(lobby.addBot(domestic).ok, true);
  assert.equal(lobby.addBot(domestic).ok, true);
  assert.equal(lobby.addBot(other).error, ERR.AI_POPULATION_LIMIT);
  assert.equal(lobby.start(overseas).ok, true, 'population admission must not block an existing room start');
  assert.equal(lobby.botPopulation.stats().total, 3);
  const room = lobby.roomOf(overseas);
  lobby.disposeRoom(room, 'admin');
  lobby.disposeRoom(room, 'admin');
  assert.equal(lobby.botPopulation.stats().foreign, 0);
  assert.equal(lobby.addBot(other).ok, true);
  assert.equal(lobby.removeBot(domestic, { seat: 1 }).ok, true);
  assert.equal(lobby.botPopulation.stats().total, 2);
  lobby.removeMember(lobby.roomOf(other), other.playerId);
  assert.equal(lobby.botPopulation.stats().total, 1);
  assert.equal(lobby.botPopulation.stats().foreign, 0);
});

test('disconnect, host migration, failed starts and match end preserve original bot accounting', (t) => {
  const { registry, lobby, host } = fixture(t, { maxForeignBots: 1 });
  const a = host(), b = registry.create('Other');
  b.connected = true;
  b.addr = '203.0.113.3';
  const room = lobby.roomOf(a);
  assert.equal(lobby.addBot(a).ok, true);
  assert.equal(lobby.join(b, { code: room.code }).ok, true);
  assert.equal(lobby.start(a).error, ERR.NOT_READY);
  assert.equal(lobby.botPopulation.stats().total, 1);
  lobby.removeMember(room, a.playerId);
  assert.equal(room.hostId, b.playerId);
  assert.equal(lobby.addBot(b).ok, true);
  assert.equal(lobby.botPopulation.stats().foreign, 1);
  assert.equal(lobby.start(b).ok, true);
  const ctx = room.matchCtx;
  lobby.onDisconnect(b);
  assert.equal(lobby.botPopulation.stats().total, 2, 'offline paused rooms retain capacity');
  lobby.onMatchEnd(room, ctx, {});
  assert.equal(lobby.botPopulation.stats().total, 2, 'ending a match retains its AI seats');
  assert.equal(lobby.addBot(b).ok, true, 'new domestic host is classified on each new addition');
});

test('snapshots preserve country but no IP, restore rebuilds even an over-cap population', (t) => {
  const f = fixture(t), a = f.host();
  f.lobby.addBot(a);
  f.lobby.addBot(a);
  const now = Date.now();
  const doc = snapshotServer({ registry: f.registry, lobby: f.lobby, now });
  const saved = doc.rooms[0].seats.filter((s) => s.isBot);
  assert.equal(saved[0].botCountry, 'US');
  assert.equal(JSON.stringify(doc.rooms).includes(a.addr), false);
  delete saved[1].botCountry; // A legacy snapshot has no country provenance.
  const restored = fixture(t, { maxBots: 1, maxForeignBots: 1 });
  restoreServer({ doc, registry: restored.registry, lobby: restored.lobby, now: now + 100, log: quiet });
  assert.equal(restored.lobby.botPopulation.stats().total, 2);
  assert.equal(restored.lobby.botPopulation.stats().foreign, 1);
  const host = restored.registry.byToken(a.token);
  host.addr = '203.0.113.1';
  assert.equal(restored.lobby.addBot(host).error, ERR.AI_POPULATION_LIMIT);
  const room = restored.lobby.roomOf(host);
  assert.equal(room.seats.filter((s) => s?.isBot).length, 2, 'restoration must not remove existing AI');
  restored.lobby.disposeRoom(room, 'admin');
  assert.equal(restored.lobby.botPopulation.stats().total, 0);
  assert.equal(restored.lobby.botPopulation.stats().foreign, 0);
});

test('WebSocket checks cannot be spoofed by message country; health exposes counts but room state does not', async (t) => {
  const clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off',
    countryLookup, maxBots: 2, maxForeignBots: 1, roomCreateBurst: 100, MatchClass: StubMatch, log: quiet });
  t.after(async () => { for (const c of clients) await c.close(); await srv.close(); });
  const connect = async (ip) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { headers: { 'X-Real-IP': ip } } });
    clients.push(c);
    await c.hello('Host');
    assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    return c;
  };
  const a = await connect('203.0.113.1'), b = await connect('203.0.113.2'), c = await connect('203.0.113.3');
  a.clearInbox();
  assert.equal((await a.request({ t: 'room.addBot', country: 'CN', botCountry: 'CN' })).t, 'ok');
  const state = await a.waitFor('room.state', (s) => s.seats.some((x) => x?.isBot));
  assert.equal('botCountry' in state.seats.find((s) => s?.isBot), false);
  assert.equal((await b.request({ t: 'room.addBot', country: 'CN' })).code, ERR.FOREIGN_AI_POPULATION_LIMIT);
  assert.equal((await c.request({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await b.request({ t: 'room.addBot' })).code, ERR.AI_POPULATION_LIMIT);
  const health = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
  assert.equal(health.botPopulation.total, 2);
  assert.equal(health.botPopulation.foreign, 1);
  assert.equal((await a.request({ t: 'room.removeBot', seat: 1 })).t, 'ok');
  assert.equal((await b.request({ t: 'room.addBot' })).t, 'ok');
});

test('configured missing or publicly served GeoLite files fail startup', async () => {
  await assert.rejects(startServer({ geoLiteCountryFile: 'public/GeoLite2-Country.mmdb', log: quiet }), /public static/);
  await assert.rejects(startServer({ geoLiteCountryFile: '.state/definitely-missing-country.mmdb', log: quiet }), /ENOENT/);
});

test('requested messages are exact and all supported translations exist', async () => {
  assert.equal(ERR_TEXT[ERR.AI_POPULATION_LIMIT], '当前服务器AI队友数量异常，可能正在被攻击，暂停AI 队友创建。');
  assert.equal(ERR_TEXT[ERR.FOREIGN_AI_POPULATION_LIMIT], '由于你的ip属于海外，当前AI队友达到上限，如果你开了代理请关闭代理，或者前往联机大厅匹配队友');
  for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
    const messages = JSON.parse(await readFile(new URL(`../public/i18n/${lang}.json`, import.meta.url), 'utf8'));
    assert.ok(messages[ERR_TEXT[ERR.AI_POPULATION_LIMIT]], lang);
    assert.ok(messages[ERR_TEXT[ERR.FOREIGN_AI_POPULATION_LIMIT]], lang);
  }
});
