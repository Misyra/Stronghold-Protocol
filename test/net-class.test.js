import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNetwork, isHostingNetwork, CLOUD_ASNS, ISP_ASNS, CLOUD_NAME_RES, HOSTING_HINT_RE, CONSUMER_HINT_RE } from '../server/netClass.js';
import { asnLookupFromReader, openAsnLookup } from '../server/geoipAsn.js';

const record = (asn, org) => ({ asn, org });
const asnReader = (map, databaseType = 'GeoLite2-ASN') => ({
  metadata: { databaseType },
  get: (ip) => (ip in map ? { autonomous_system_number: map[ip][0], autonomous_system_organization: map[ip][1] } : null),
});

test('curated ASNs win over every name rule, including a brand that also sells broadband', () => {
  const aws = classifyNetwork(record(16509, 'Amazon.com, Inc.'));
  assert.equal(aws.kind, 'cloud'); assert.equal(aws.confidence, 'asn'); assert.equal(aws.label, 'AWS');
  const fiber = classifyNetwork(record(16591, 'Google Fiber Inc.'));
  assert.equal(fiber.kind, 'isp'); assert.equal(fiber.confidence, 'asn');
  for (const asn of CLOUD_ASNS.keys()) assert.ok(Number.isSafeInteger(asn) && asn > 0);
  for (const asn of ISP_ASNS.keys()) assert.equal(CLOUD_ASNS.has(asn), false, 'a network cannot be in both tables');
});

test('brand matching is anchored: consumer ISPs whose brand contains a cloud word stay isp', () => {
  // All names below were observed in the real database: they look like hosts and are not.
  for (const org of ['Cloud Telecom LTDA', 'Cloudlink Communications', 'Cloudlasers Broadband',
    'Cloud 9 Wireless LLC', 'cloudsky superfast broadband and services Pvt Ltd', 'Cloud Net Cable and Telecom Inc.',
    'AMAZONET TELECOMUNICACOES LTDA', 'AMAZONIA TELECOMUNICACOES LTDA', 'AMAZONFIBER SERVICOS DE COMUNICACAO LTDA',
    'AMAZONTEL TELECOMUNICACOES LTDA', 'GIGA MAIS FIBRA TELECOMUNICACOES S.A.', 'Huawei do Brasil Telecomunicacoes Ltda.']) {
    const c = classifyNetwork(record(65000, org));
    assert.equal(c.kind, 'isp', org + ' must not be classified as hosting (' + JSON.stringify(c) + ')');
  }
});

test('anchored brands classify as cloud even without a curated number', () => {
  for (const [org, label] of [['Amazon Technologies Inc.', 'AWS'], ['Google Cloud', 'Google'],
    ['Hetzner Online GmbH', 'Hetzner'], ['Tencent Building, Kejizhongyi Avenue', '腾讯云'],
    ['UCLOUD INFORMATION TECHNOLOGY (HK) LIMITED', 'UCloud'], ['HUAWEI CLOUDS', '华为云']]) {
    const c = classifyNetwork(record(65001, org));
    assert.equal(c.kind, 'cloud', org); assert.equal(c.confidence, 'name'); assert.equal(c.label, label);
  }
});

test('generic hosting words are only a lead: weak never blocks unless the caller opts in', () => {
  const c = classifyNetwork(record(65002, 'Some Cloud Hosting Ltd'));
  assert.equal(c.kind, 'cloud'); assert.equal(c.confidence, 'weak');
  assert.equal(isHostingNetwork(c), false);
  assert.equal(isHostingNetwork(c, { weak: true }), true);
  assert.equal(isHostingNetwork(classifyNetwork(record(14061, 'DigitalOcean, LLC'))), true);
  assert.equal(isHostingNetwork(classifyNetwork(record(4134, 'Chinanet'))), false);
});

test('ordinary operators are isp, never "residential": ASN data cannot tell a home line from a leased line', () => {
  for (const [asn, org] of [[4134, 'Chinanet'], [4837, 'CHINA UNICOM China169 Backbone'], [9808, 'China Mobile Communications Group Co., Ltd.'],
    [3320, 'Deutsche Telekom AG'], [31399, 'Mercedes-Benz Group AG'], [4538, 'China Education and Research Network Center']]) {
    const c = classifyNetwork(record(asn, org));
    assert.equal(c.kind, 'isp'); assert.notEqual(c.confidence, 'none');
  }
});

test('a missing record is unknown, not a guess', () => {
  for (const r of [null, undefined, { asn: 0, org: '' }, { asn: null, org: null }, { asn: -1, org: '' }])
    assert.deepEqual({ ...classifyNetwork(r), reason: undefined }, { kind: 'unknown', confidence: 'none', asn: null, org: null, label: null, reason: undefined });
  assert.equal(classifyNetwork(record(65003, '')).kind, 'unknown');
  assert.equal(classifyNetwork({ asn: 65004, org: 'No Brand ISP' }).kind, 'isp');
  // A bogus number with a real org name still falls back to the name layer instead of inventing an ASN.
  assert.equal(classifyNetwork({ asn: 1.5, org: 'No Brand ISP' }).kind, 'isp');
});

test('the ASN reader validates the database type and returns null for what it cannot place', () => {
  assert.throws(() => asnLookupFromReader(asnReader({}, 'GeoLite2-Country')), /ASN database required/);
  const lookup = asnLookupFromReader(asnReader({ '8.8.8.8': [15169, 'Google LLC'], '1.1.1.1': [0, 'bogus'] }));
  assert.deepEqual(lookup('8.8.8.8'), { asn: 15169, org: 'Google LLC' });
  for (const ip of ['1.1.1.1', '203.0.113.9', '2001:db8::1', 'invalid', '']) assert.equal(lookup(ip), null);
  const classify = (ip) => classifyNetwork(lookup(ip));
  assert.equal(classify('8.8.8.8').kind, 'cloud');
  assert.equal(classify('203.0.113.9').kind, 'unknown');
});

test('regexes stay anchored so a widened token cannot silently swallow consumer brands', () => {
  assert.equal(CLOUD_NAME_RES.some(([re]) => re.test('Cloud Telecom LTDA')), false);
  assert.equal(CLOUD_NAME_RES.some(([re]) => re.test('AMAZONIA TELECOMUNICACOES LTDA')), false);
  // The generic word does match — that is why it can only ever be a lead: the consumer word is checked first.
  assert.equal(HOSTING_HINT_RE.test('Cloud Telecom LTDA'), true);
  assert.equal(classifyNetwork(record(65005, 'Cloud Telecom LTDA')).kind, 'isp');
  assert.equal(CONSUMER_HINT_RE.test('Cloud 9 Wireless LLC'), true);
});

/** Real database is opt-in: SP_ASN_TEST_DB=geoip/GeoLite2-ASN.mmdb */
const realDb = process.env.SP_ASN_TEST_DB;
test('a real ASN database separates known clouds from ordinary operators', { skip: realDb ? false : 'Set SP_ASN_TEST_DB to a GeoLite2-ASN.mmdb' }, async () => {
  const lookup = await openAsnLookup(realDb);
  const c = (ip) => classifyNetwork(lookup(ip));
  assert.equal(c('52.94.76.1').kind, 'cloud');
  assert.equal(c('95.216.1.1').kind, 'cloud');
  assert.equal(c('167.99.1.1').kind, 'cloud');
  assert.equal(c('114.114.114.114').kind, 'cloud', '114DNS is announced by Zenlayer (AS21859), a hosting ASN');
  assert.equal(c('202.96.128.86').kind, 'isp', 'Chinanet broadband stays isp');
  assert.equal(c('223.5.5.5').kind, 'cloud', 'Alibaba (US) Technology announces the DNS range');
  assert.equal(c('165.91.1.1').kind, 'isp', 'Google Fiber must never be read as Google Cloud');
  assert.equal(c('203.0.113.9').kind, 'unknown');
});
