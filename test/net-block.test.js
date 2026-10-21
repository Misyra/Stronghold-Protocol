import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { existsSync } from 'node:fs';
import { BLOCK_ASNS, BLOCK_COUNTRIES, BLOCK_IPS, CONSUMER_ASNS_IN_LIST, NetBlock, createNetBlock, normalizeBlockIp, parseNetBlockMode } from '../server/netBlock.js';
import { TestClient } from './helpers/wsClient.js';

const asnOf = (map) => (ip) => (ip in map ? { asn: map[ip], org: 'stub' } : null);
const countryOf = (map) => (ip) => map[ip] ?? null;
const quietLog = () => { const lines = []; return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }; };

test('the deny list is 133 ASNs, 3 regions and 83 addresses, with no duplicates or junk', () => {
  assert.equal(BLOCK_ASNS.size, 133);
  assert.equal(BLOCK_IPS.size, 83);
  assert.deepEqual([...BLOCK_COUNTRIES].sort(), ['EC', 'TW', 'VE']);
  for (const asn of BLOCK_ASNS) assert.ok(Number.isSafeInteger(asn) && asn > 0, String(asn));
  for (const ip of BLOCK_IPS) assert.ok(BLOCK_IPS.has(normalizeBlockIp(ip)), ip);
});

test('IP beats country beats ASN, and each reason is counted once', () => {
  const block = new NetBlock({ asnLookup: asnOf({ '5.101.96.1': 14061, '202.96.128.86': 4134 }),
    countryLookup: countryOf({ '5.101.96.1': 'TW', '202.96.128.86': 'CN', '60.249.21.30': 'TW' }) });
  assert.equal(block.check('60.249.21.30').reason, 'ip', 'a listed address is refused before any lookup runs');
  assert.equal(block.check('5.101.96.1').reason, 'country');
  assert.equal(block.check('5.101.96.1').country, 'TW');
  const asnOnly = new NetBlock({ asnLookup: asnOf({ '5.101.96.1': 14061 }), countryLookup: countryOf({ '5.101.96.1': 'CN' }) });
  const verdict = asnOnly.check('5.101.96.1');
  assert.equal(verdict.reason, 'asn'); assert.equal(verdict.asn, 14061);
  assert.deepEqual({ ...asnOnly.stats() }.byAsn, 1);
});

test('ordinary mainland broadband stays allowed: the list blocks hosting numbers, not operators', () => {
  const block = new NetBlock({ asnLookup: asnOf({ '202.96.128.86': 4134, '183.232.1.1': 56040, '240e:1::1': 17897 }),
    countryLookup: countryOf({ '202.96.128.86': 'CN', '183.232.1.1': 'CN', '240e:1::1': 'CN' }) });
  for (const ip of ['202.96.128.86', '183.232.1.1', '240e:1::1']) assert.equal(block.check(ip).blocked, false, ip);
  assert.equal(block.check('203.0.113.9').blocked, false, 'an unplaceable address is not a licence to block');
});

test('every region in the list is refused, and a neighbouring region is not', () => {
  const block = new NetBlock({ countryLookup: countryOf({ '1.1.1.1': 'TW', '2.2.2.2': 'VE', '3.3.3.3': 'EC', '4.4.4.4': 'HK', '5.5.5.5': 'CN' }) });
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) assert.equal(block.check(ip).blocked, true, ip);
  for (const ip of ['4.4.4.4', '5.5.5.5']) assert.equal(block.check(ip).blocked, false, ip);
});

test('a missing or broken ASN database disables only the ASN layer and says so', () => {
  const noAsn = new NetBlock({ countryLookup: countryOf({ '60.249.21.30': 'TW' }), asnLookup: null });
  assert.equal(noAsn.asnAvailable, false);
  assert.equal(noAsn.check('5.101.96.1').blocked, false, 'ASN rules cannot fire without a database');
  assert.equal(noAsn.check('60.249.21.30').reason, 'ip', 'the other two layers still apply');
  const log = quietLog();
  createNetBlock({ mode: 'on', asnLookup: null, countryLookup: null, log });
  assert.ok(log.lines.some((l) => l.includes('ASN 库不可用')));
  assert.ok(log.lines.some((l) => l.includes('国家库不可用')));
  const broken = new NetBlock({ asnLookup: () => { throw new Error('bad records'); }, countryLookup: () => { throw new Error('bad records'); } });
  assert.equal(broken.check('5.101.96.1').blocked, false, 'a lookup fault is not a verdict');
  assert.deepEqual({ errors: broken.stats().asnErrors + broken.stats().countryErrors }, { errors: 2 });
});

test('the consumer operators on the list are named in the startup warning', () => {
  const log = quietLog();
  createNetBlock({ mode: 'on', countryLookup: () => 'CN', asnLookup: () => null, log });
  assert.ok(log.lines.some((l) => l.includes('ASN 6871')), log.lines.join(' | '));
  assert.ok(log.lines.some((l) => l.includes('ASN 4773')));
  assert.equal(CONSUMER_ASNS_IN_LIST.size, 2);
});

test('mode and address normalization: default off, on enables the list, junk stays junk', () => {
  assert.equal(parseNetBlockMode(), false);
  assert.equal(parseNetBlockMode(' ON '), true);
  assert.throws(() => parseNetBlockMode('maybe'), RangeError);
  assert.equal(normalizeBlockIp('::ffff:60.249.21.30'), '60.249.21.30');
  assert.equal(normalizeBlockIp('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
  for (const junk of ['', ' ', '1.2.3', 'example.com', null, undefined, 42]) assert.equal(normalizeBlockIp(junk), null);
  const off = new NetBlock({ enabled: false, asnLookup: asnOf({ '5.101.96.1': 14061 }), countryLookup: countryOf({ '5.101.96.1': 'TW' }) });
  assert.equal(off.check('5.101.96.1').blocked, false);
  assert.equal(off.check('60.249.21.30').blocked, false);
});

const stubCountry = { '5.101.96.1': 'US', '202.96.128.86': 'CN', '60.249.21.30': 'TW' };
const stubAsn = { '5.101.96.1': 14061, '202.96.128.86': 4134, '60.249.21.30': 33333 };

async function serve(t, options = {}) {
  const logs = [];
  const log = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug() {} };
  const srv = await startServer({ host: '127.0.0.1', port: 0, workers: 0, stateFile: 'off', log, trustProxy: true,
    allowForeignConnections: true, limitForeignSessions: false, httpApiMainlandOnly: false, netBlockMode: 'on',
    countryLookup: countryOf(stubCountry), asnLookup: asnOf(stubAsn), ...options });
  t.after(() => srv.close());
  return { srv, logs };
}

test('a hosting ASN and a listed region are refused on the document and the upgrade, a mainland operator is not', async (t) => {
  const { srv, logs } = await serve(t);
  assert.ok(logs.some((l) => l.includes('[netblock] on')), logs.join(' | '));
  for (const ip of ['5.101.96.1', '60.249.21.30']) {
    const res = await fetch(srv.url, { headers: { 'X-Real-IP': ip } });
    assert.equal(res.status, 403, ip);
    assert.deepEqual(await res.json(), { code: 'FOREIGN_CONNECTIONS_DISABLED', msg: '本服务器暂时仅对中国大陆服务' });
    assert.equal((await fetch(srv.url + '/healthz', { headers: { 'X-Real-IP': ip } })).status, 200, 'monitoring stays reachable');
  }
  assert.ok(logs.some((l) => l.includes('connection.netBlock.denied')));
  const allowed = await TestClient.connect(srv.url.replace('http:', 'ws:') + '/ws', { wsOptions: { headers: { 'X-Real-IP': '202.96.128.86' } } });
  t.after(() => allowed.close());
  assert.equal((await allowed.hello('Mainland')).t, 'welcome');
  await assert.rejects(TestClient.connect(srv.url.replace('http:', 'ws:') + '/ws', { wsOptions: { headers: { 'X-Real-IP': '5.101.96.1' } } }), /403/);
});

test('SP_NET_BLOCK=off turns the whole list off without touching the foreign gate', async (t) => {
  const { srv } = await serve(t, { netBlockMode: 'off' });
  assert.equal((await fetch(srv.url, { headers: { 'X-Real-IP': '5.101.96.1' } })).status, 200);
  assert.equal((await fetch(srv.url, { headers: { 'X-Real-IP': '114.114.114.114' } })).status, 200);
});

/**
 * Unset SP_NET_BLOCK means the list is off: a bare checkout must neither open the ASN database nor deny anyone.
 * The old default was "on", and reading the raw env value as a condition silently skipped the ASN layer while the
 * log still said "on" — both halves are asserted here, from the other side.
 */
const localAsnDb = 'geoip/GeoLite2-ASN.mmdb';
test('an unset SP_NET_BLOCK keeps the list off and never opens the ASN database', { skip: existsSync(localAsnDb) ? false : 'geoip/GeoLite2-ASN.mmdb not present' }, async (t) => {
  const { srv } = await serve(t, { asnLookup: undefined, netBlockMode: undefined, geoLiteAsnFile: localAsnDb });
  assert.equal(srv.network.netBlock.enabled, false, 'an unset switch must not turn the list on');
  assert.equal(srv.network.netBlock.asnAvailable, false, 'the ASN database is only worth opening when the list is on');
  assert.equal(srv.network.netBlock.check('1.12.16.1').blocked, false);
  assert.equal((await fetch(srv.url, { headers: { 'X-Real-IP': '1.12.16.1' } })).status, 200);
});
