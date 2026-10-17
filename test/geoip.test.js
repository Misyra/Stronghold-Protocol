import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGeoipMode, countryLookupFromReader, openCountryLookup } from '../server/geoip.js';
import { BotPopulation } from '../server/botPopulation.js';
import { ForeignSessions } from '../server/foreignSessions.js';
import { SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const cn = { country: { iso_code: 'CN' } };
const reader = (get, databaseType = 'GeoIP2-Country') => ({ metadata: { databaseType }, get });
const mainland = ip => ['114.114.114.114', '223.5.5.5'].includes(ip) ? cn : null;

test('country mode preserves missing, malformed and actual country results', () => {
  const lookup = countryLookupFromReader(reader(ip => ({ '114.114.114.114': cn, '8.8.8.8': { country: { iso_code: 'US' } },
    '1.1.1.1': {}, '9.9.9.9': { country: { iso_code: 'bad' } } })[ip] ?? null));
  assert.equal(lookup('114.114.114.114'), 'CN'); assert.equal(lookup('8.8.8.8'), 'US');
  for (const ip of ['1.1.1.1', '9.9.9.9', '203.0.113.1', '2001:db8::1', 'invalid']) assert.equal(lookup(ip), null);
});

test('mainland-only mode classifies IPv4 misses as non-mainland without inventing IPv6 country coverage', () => {
  const lookup = countryLookupFromReader(reader(mainland), 'cn-only');
  assert.equal(lookup('114.114.114.114'), 'CN');
  for (const ip of ['8.8.8.8', '1.1.1.1', '154.219.110.142']) assert.equal(lookup(ip), 'ZZ');
  for (const ip of ['240e::1', '2001:4860:4860::8888', 'invalid', '']) assert.equal(lookup(ip), null);
  const malformed = countryLookupFromReader(reader(ip => ip === '9.9.9.9' ? {} : mainland(ip)), 'cn-only');
  assert.equal(malformed('9.9.9.9'), null, 'malformed records are not trustworthy non-membership');
});

test('mode and database validation reject typos, ASN, empty lists and using a worldwide database as a mainland-only list', () => {
  assert.equal(parseGeoipMode(), 'country'); assert.equal(parseGeoipMode(' CN-ONLY '), 'cn-only');
  assert.throws(() => parseGeoipMode('guess'), RangeError);
  assert.throws(() => countryLookupFromReader(reader(mainland, 'GeoLite2-ASN')), /country locations/);
  assert.throws(() => countryLookupFromReader(reader(() => null), 'cn-only'), /mainland-only Country/);
  assert.throws(() => countryLookupFromReader(reader(ip => ip === '8.8.8.8' ? { country: { iso_code: 'US' } } : mainland(ip)), 'cn-only'), /mainland-only Country/);
});

test('lookup exceptions stay exceptions, so they cannot be converted into a non-mainland address', () => {
  const lookup = countryLookupFromReader(reader(ip => { if (ip === '9.9.9.9') throw new Error('broken data'); return mainland(ip); }), 'cn-only');
  assert.throws(() => lookup('9.9.9.9'), /broken data/);
  const policy = new ForeignSessions({ registry: new SessionRegistry(), countryLookup: lookup, allowConnections: () => false });
  assert.equal(policy.connectionAdmission('9.9.9.9').ok, true);
  assert.equal(policy.stats().lookupErrors, 1);
});

test('mainland-only classification drives existing connection, session and AI limits without exempting foreign misses', () => {
  const countryLookup = countryLookupFromReader(reader(mainland), 'cn-only');
  const registry = new SessionRegistry(), policy = new ForeignSessions({ registry, countryLookup, allowConnections: () => false });
  assert.equal(policy.connectionAdmission('114.114.114.114').ok, true);
  assert.equal(policy.connectionAdmission('8.8.8.8').ok, false);
  const first = registry.create('First'); policy.bind(first, policy.prepare('8.8.8.8')); first.connected = true;
  assert.equal(policy.prepare('8.8.8.8').ok, false);
  const bots = new BotPopulation({ countryLookup, maxForeign: 1 });
  const seat = { isBot: true, botCountry: bots.canAdd('8.8.8.8').country };
  bots.track(seat);
  assert.equal(bots.stats().foreign, 1);
  assert.equal(bots.canAdd('1.1.1.1').code, 'FOREIGN_AI_POPULATION_LIMIT');
  assert.equal(bots.canAdd('114.114.114.114').ok, true);
  assert.equal(bots.canAdd('127.0.0.1').country, null);
});

test('invalid configured files and modes fail startup, rather than enabling an empty allowlist', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-geoip-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Country.mmdb'); await writeFile(file, 'not a database');
  await assert.rejects(openCountryLookup(file, { mode: 'cn-only' }));
  await assert.rejects(startServer({ geoipMode: 'typo' }), /SP_GEOIP_MODE/);
  await assert.rejects(startServer({ geoLiteCountryFile: file, geoipMode: 'cn-only' }));
});

/** A real database is opt-in: SP_GEOIP_TEST_DB=<file>; SP_GEOIP_TEST_MODE=country for a worldwide one. */
const realDb = process.env.SP_GEOIP_TEST_DB;
const realMode = process.env.SP_GEOIP_TEST_MODE === 'country' ? 'country' : 'cn-only';

test(`a real ${realMode} database blocks an overseas entry but allows a mainland WebSocket client`, {
  skip: realDb ? false : 'Set SP_GEOIP_TEST_DB to a downloaded Country.mmdb (SP_GEOIP_TEST_MODE=country for a worldwide one)',
}, async t => {
  const file = realDb, lookup = await openCountryLookup(file, { mode: realMode });
  assert.equal(lookup('114.114.114.114'), 'CN'); assert.equal(lookup('<节点地址>'), 'CN');
  if (realMode === 'cn-only') {
    // The mainland-only source says nothing about a foreign country: an IPv4 miss is the marker 'ZZ'.
    assert.equal(lookup('8.8.8.8'), 'ZZ'); assert.equal(lookup('154.219.110.142'), 'ZZ');
    assert.equal(lookup('240e::1'), null, 'a mainland-only file carries no mainland IPv6 coverage to trust');
  } else {
    // A worldwide file answers with real codes (HK/MO/TW included) and covers part of IPv6; the rest stays unknown.
    assert.match(lookup('8.8.8.8'), /^[A-Z]{2}$/); assert.notEqual(lookup('8.8.8.8'), 'CN');
    assert.match(lookup('154.219.110.142'), /^[A-Z]{2}$/); assert.notEqual(lookup('154.219.110.142'), 'CN');
    assert.ok(['2001:4860:4860::8888', '2400:3200::1'].some(ip => lookup(ip)), 'the worldwide file resolves IPv6 samples');
  }
  assert.equal(lookup('invalid'), null);
  const srv = await startServer({ host: '127.0.0.1', port: 0, workers: 0, stateFile: 'off', quiet: true,
    geoLiteCountryFile: file, geoipMode: realMode, allowForeignConnections: false });
  let client;
  t.after(async () => { await client?.close(); await srv.close(); });
  const blocked = await fetch(srv.url, { headers: { 'X-Real-IP': '8.8.8.8' } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).msg, '本服务器暂时仅对中国大陆服务');
  // 114.114.114.114 是 Zenlayer（AS21859），已在 server/netBlock.js 的明确名单里；用普通家宽样本验"大陆放行"。
  assert.equal((await fetch(srv.url, { headers: { 'X-Real-IP': '202.96.128.86' } })).status, 200);
  client = await TestClient.connect(srv.url.replace('http:', 'ws:') + '/ws', { wsOptions: { headers: { 'X-Real-IP': '202.96.128.86' } } });
  assert.equal((await client.hello('Mainland')).t, 'welcome');
});
