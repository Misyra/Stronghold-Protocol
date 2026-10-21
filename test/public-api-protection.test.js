import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createIpBanStore } from '../server/http/ipBans.js';
import { createPublicApiLimiter, publicApiLimitsFrom, apiMainlandOnlyFrom } from '../server/http/publicApiLimit.js';
import { createRequestHandler } from '../server/http/routes.js';
import { startServer } from '../server/index.js';

const quiet = { warn() {}, error: assert.fail };
const request = (ip = '203.0.113.9', extra = {}) => ({ socket: { remoteAddress: ip }, ...extra });
function response() {
  return { headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { this.status = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); },
    end(body) { this.body = body; } };
}
function fixture(options = {}, policy = {}) {
  let scans = 0, reads = 0, statics = 0, at = 0;
  const ipBans = createIpBanStore({ log: quiet });
  const handler = createRequestHandler({ ipBans, log: quiet,
    health: { startedAt: Date.now(), network: { connectionCount: 0 }, registry: { size: 0 },
      lobby: { stats: () => { scans++; return { rooms: 0 }; } } },
    serveStatic: async () => { statics++; }, readAnnouncement: async () => { reads++; return null; },
    publicApiLimits: { burst: 2, ratePerSec: 1, now: () => at, ...options }, ...policy });
  return { ipBans, counts: () => ({ scans, reads, statics }), time: (n) => { at = n; },
    async call(url, method = 'GET', req = request()) {
      const res = response(); handler({ ...req, url, method }, res); await Promise.resolve(); return res;
    } };
}

test('API paths, query strings, absolute URLs and methods share one budget; no work after 429', async () => {
  const f = fixture();
  assert.equal((await f.call('/healthz?build=1')).status, 200);
  assert.equal((await f.call('/api/ping', 'OPTIONS')).status, 204);
  for (const [url, method] of [['http://host/healthz?traffic=1', 'GET'], ['/api/announcement', 'HEAD'],
    ['/api/nickname/validate', 'POST'], ['/api/portal-room', 'POST'], ['/api/rooms/bad/status', 'GET'],
    ['/api/unknown', 'DELETE'], ['/metrics', 'GET'], ['/%68ealthz?x=1', 'GET'],
    ['//api/ping', 'GET'], ['/healthz?' + 'a'.repeat(5000), 'GET']]) {
    const res = await f.call(url, method);
    assert.equal(res.status, 429, url);
    assert.equal(res.headers['retry-after'], '1'); assert.equal(res.headers.connection, 'close');
    assert.equal(res.headers['cache-control'], 'no-store');
    if (method === 'HEAD') assert.equal(res.body, undefined);
    else assert.equal(JSON.parse(res.body).error, 'RATE_LIMITED');
  }
  assert.deepEqual(f.counts(), { scans: 0, reads: 0, statics: 0 });
  await f.call('/assets/model.png'); assert.equal(f.counts().statics, 1);
  f.time(1000); assert.equal((await f.call('/healthz')).status, 200);
});

test('the 601st request in a sliding minute permanently bans; rejected requests count; time never lifts bans', async () => {
  const f = fixture();
  for (let i = 0; i < 600; i++) {
    const res = await f.call(i % 2 ? `/api/ping?q=${i}` : `/healthz?q=${i}`);
    assert.equal(res.status, i < 2 ? 200 : 429);
  }
  const banned = await f.call('/healthz?different=1');
  assert.equal(banned.status, 403); assert.equal(JSON.parse(banned.body).error, 'IP_BANNED');
  assert.equal(banned.headers['retry-after'], undefined);
  f.time(1e9);
  assert.equal((await f.call('/assets/model.png')).status, 403);
  assert.equal((await f.call('/healthz', 'HEAD')).body, undefined);
  assert.equal((await f.call('/healthz', 'GET', request('198.51.100.1'))).status, 200);
  assert.equal(f.counts().statics, 0);
});

test('rolling window expires only old requests, including around minute boundaries', () => {
  let at = 59999;
  const bans = createIpBanStore({ log: quiet });
  const allow = createPublicApiLimiter({ now: () => at, banThreshold: 3, banStore: bans });
  allow(request()); allow(request()); at = 60001; allow(request());
  assert.equal(allow(request()), false); assert.equal(bans.size, 1);
  const other = request('203.0.113.10');
  allow(other); allow(other); at += 60000; allow(other); allow(other);
  assert.equal(bans.size, 1);
});

test('IPv6 /64 rotation shares rate and permanent bans; other prefixes survive', () => {
  const bans = createIpBanStore({ log: quiet });
  const allow = createPublicApiLimiter({ banStore: bans, banThreshold: 2, now: () => 0 });
  assert.equal(allow(request('2001:db8:1234:5678::1')), true);
  assert.equal(allow(request('2001:db8:1234:5678::2')), true);
  assert.equal(allow(request('2001:db8:1234:5678::3')), false);
  assert.equal(bans.isBanned(request('2001:db8:1234:5678::ffff')), true);
  assert.equal(allow(request('2001:db8:1234:5679::1')), true);
});

test('proxy trust: public spoofed headers cannot rotate identities; local monitoring bypasses public saturation', () => {
  const allow = createPublicApiLimiter({ burst: 1, globalBurst: 2, now: () => 0 });
  assert.equal(allow(request()), true);
  assert.equal(allow(request(undefined, { headers: { 'cf-connecting-ip': '127.0.0.1' } })), false);
  assert.equal(allow(request('127.0.0.1', { headers: { 'x-real-ip': '198.51.100.1' } })), true);
  assert.equal(allow(request('198.51.100.2')), false);
  for (let i = 0; i < 100; i++) assert.equal(allow(request('127.0.0.1')), true);
});

test('a full address table evicts the least recently active key instead of refusing new sources', () => {
  let at = 0;
  const allow = createPublicApiLimiter({ maxKeys: 1, now: () => at });
  assert.equal(allow(request()), true);
  assert.equal(allow(request('198.51.100.1')), true, 'the new key evicts the idle one rather than being refused');
  assert.equal(allow(request('198.51.100.1')), true, 'the evicting key has its own bucket afterwards');
  at = 60000; assert.equal(allow(request('203.0.113.9')), true, 'idle entries are still reclaimed');
});

test('distributed health flood has a separate global budget even across 249 different IPs and query variants', async () => {
  const f = fixture({ healthBurst: 4, globalBurst: 10 });
  let accepted = 0;
  for (let i = 1; i <= 249; i++) {
    const url = i % 2 ? `/healthz?build=1&nonce=${i}` : `http://host/healthz?traffic=1&nonce=${i}`;
    const res = await f.call(url, 'GET', request(`203.0.113.${i}`));
    if (res.status === 200) accepted++; else assert.equal(res.status, 429);
  }
  assert.equal(accepted, 4);
  assert.equal((await f.call('/api/ping', 'GET', request('198.51.100.1'))).status, 200);
  assert.equal((await f.call('/healthz', 'GET', request('127.0.0.1'))).status, 200);
  f.time(50); assert.equal((await f.call('/healthz', 'GET', request('198.51.100.2'))).status, 200);
});

test('ban file reloads indefinitely, deduplicates records, and fails closed on corruption', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ip-bans-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'bans.jsonl');
  const first = createIpBanStore({ file, log: quiet }); first.ban('203.0.113.9'); first.ban('203.0.113.9');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  assert.equal(createIpBanStore({ file, log: quiet }).isBanned(request()), true);
  fs.appendFileSync(file, '{broken'); assert.throws(() => createIpBanStore({ file, log: quiet }));
});

test('HTTP protection ships off and rejects invalid budgets', () => {
  assert.equal(publicApiLimitsFrom({}, {}).banThreshold, 0);
  assert.equal(publicApiLimitsFrom({}, { SP_HTTP_BAN_THRESHOLD: '300' }).banThreshold, 300);
  for (const value of ['-1', 'NaN', '1.5'])
    assert.throws(() => publicApiLimitsFrom({}, { SP_HTTP_API_RATE: value }), /SP_HTTP_API_RATE/);
  assert.equal(publicApiLimitsFrom({}, { SP_HTTP_API_RATE: '0' }).ratePerSec, 0, 'zero is "off", not "429 everything"');
  assert.equal(apiMainlandOnlyFrom(), false); assert.equal(apiMainlandOnlyFrom('on'), true);
  assert.throws(() => apiMainlandOnlyFrom('maybe'), /SP_HTTP_API_CN_ONLY/);
});

test('API mainland-only blocks US/TW/HK/JP before any work, ignores spoofed public headers, retains domestic budget', async () => {
  const countries = { '192.0.2.8': 'US', '192.0.2.30': 'TW', '203.0.113.9': 'HK', '203.0.113.3': 'JP', '192.0.2.14': 'CN' };
  const f = fixture({ globalBurst: 1, healthBurst: 1 }, {
    apiMainlandOnly: true, apiCountryLookup: (ip) => countries[ip] ?? null,
  });
  for (const ip of ['192.0.2.8', '192.0.2.30', '203.0.113.9', '203.0.113.3']) {
    for (const url of ['/healthz?build=1', '/api/ping', '/api/announcement', '/api/rooms/bad/status', '/api/portal-room']) {
      const res = await f.call(url, 'GET', request(ip, { headers: { 'cf-connecting-ip': '192.0.2.14' } }));
      assert.equal(res.status, 403); assert.equal(JSON.parse(res.body).error, 'FOREIGN_IP_BLOCKED');
    }
  }
  assert.deepEqual(f.counts(), { scans: 0, reads: 0, statics: 0 });
  assert.equal((await f.call('/healthz', 'GET', request('192.0.2.14'))).status, 200);
  assert.equal((await f.call('/healthz', 'GET', request('127.0.0.1'))).status, 200);
  // The public address a local proxy forwards remains foreign.
  assert.equal((await f.call('/api/ping', 'GET', request('127.0.0.1', { headers: { 'x-real-ip': '192.0.2.8' } }))).status, 403);
});

test('foreign requests count towards permanent bans without using global tokens; unknown counts as overseas', async () => {
  const f = fixture({ banThreshold: 3, globalBurst: 1 }, { apiMainlandOnly: true,
    apiCountryLookup: (ip) => ip === '192.0.2.8' ? 'US' : ip === '192.0.2.14' ? 'CN' : null });
  for (let i = 0; i < 3; i++) assert.equal((await f.call('/healthz', 'GET', request('192.0.2.8'))).status, 403);
  const banned = await f.call('/healthz', 'GET', request('192.0.2.8'));
  assert.equal(JSON.parse(banned.body).error, 'IP_BANNED');
  // An address the database cannot place is refused like any overseas one.
  const unknown = await f.call('/healthz', 'GET', request('203.0.113.9'));
  assert.equal(unknown.status, 403);
  assert.equal(JSON.parse(unknown.body).error, 'FOREIGN_IP_BLOCKED');
  assert.equal((await f.call('/healthz', 'GET', request('192.0.2.14'))).status, 200);
});

test('a database that cannot see the address family abstains instead of calling it overseas', async () => {
  // cn-only mode with a mainland-only IPv4 database answers `undefined` for every IPv6 client: that is "no verdict",
  // not "abroad". Domestic IPv6 players were refused on /healthz, /api/ping and /api/announcement by this.
  const f = fixture({}, { apiMainlandOnly: true,
    apiCountryLookup: (ip) => ip === '2001:db8::14' ? undefined : ip === '192.0.2.14' ? 'CN' : 'US' });
  assert.equal((await f.call('/healthz', 'GET', request('2001:db8::14'))).status, 200);
  assert.equal((await f.call('/api/ping', 'GET', request('2001:db8::14'))).status, 200);
  assert.equal((await f.call('/healthz', 'GET', request('192.0.2.14'))).status, 200);
  // A real overseas address is still refused, and so is one placed nowhere.
  assert.equal((await f.call('/healthz', 'GET', request('192.0.2.8'))).status, 403);
  assert.equal((await f.call('/healthz', 'GET', request('203.0.113.9'))).status, 403);
});

test('missing or failed API GeoIP refuses public APIs with 503 while local monitoring remains available', async () => {
  for (const apiCountryLookup of [null, () => { throw new Error('database error'); }]) {
    const f = fixture({}, { apiMainlandOnly: true, apiCountryLookup });
    const res = await f.call('/healthz'); assert.equal(res.status, 503);
    assert.equal(JSON.parse(res.body).error, 'GEOIP_UNAVAILABLE');
    assert.equal((await f.call('/healthz', 'GET', request('127.0.0.1'))).status, 200);
  }
});

test('nginx opt-in redirects defense rejects only from trusted peers; direct callers cannot forge it', async () => {
  const proxy = request('127.0.0.1', { headers: { 'x-real-ip': '203.0.113.9', 'x-sp-drop-rejections': '1' } });
  const f = fixture({ banThreshold: 3 });
  for (let i = 0; i < 2; i++) assert.equal((await f.call('/healthz', 'GET', proxy)).status, 200);
  const limited = await f.call('/healthz', 'GET', proxy);
  assert.equal(limited.status, 429); assert.equal(limited.headers['x-accel-redirect'], '/_sp/http-drop');
  assert.equal(limited.headers['x-sp-http-reject'], 'RATE_LIMITED');
  const banned = await f.call('/healthz', 'GET', proxy);
  assert.equal(banned.headers['x-sp-http-reject'], 'IP_BANNED');
  const auth = await f.call('/_sp/ip-check', 'GET', proxy);
  assert.equal(auth.status, 403); assert.equal(auth.headers['x-accel-redirect'], undefined);

  const direct = fixture({ burst: 1 });
  const forged = request('203.0.113.9', { headers: { 'x-sp-drop-rejections': '1' } });
  await direct.call('/healthz', 'GET', forged);
  const rejected = await direct.call('/healthz', 'GET', forged);
  assert.equal(rejected.status, 429); assert.equal(rejected.headers['x-accel-redirect'], undefined);
  assert.equal(JSON.parse(rejected.body).error, 'RATE_LIMITED');
});

// The bundled database is real, so the sample addresses come from the operator: none are written into the tree.
const apiSamples = (name) => (process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean);
const apiForeignIps = apiSamples('SP_GEOIP_TEST_FOREIGN');
const apiMainlandIps = apiSamples('SP_GEOIP_TEST_MAINLAND');
test('real server: permanent ban survives restart and rejects HTTP and WebSocket; monitor stays reachable', {
  skip: apiForeignIps.length && apiMainlandIps.length > 1 ? false : 'Set SP_GEOIP_TEST_FOREIGN and two SP_GEOIP_TEST_MAINLAND sample addresses',
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-http-ban-server-'));
  let server;
  t.after(async () => { await server?.close(); fs.rmSync(dir, { recursive: true }); });
  const opts = { host: '127.0.0.1', port: 0, quiet: true, workers: 0, store: null, announcementFile: null,
    ipBanFile: path.join(dir, 'bans.jsonl'), publicApiLimits: { banThreshold: 3, burst: 2 } };
  server = await startServer(opts);
  // The source checkout's bundled database is loaded for APIs without changing the gameplay foreign gate.
  for (const ip of apiForeignIps) {
    const overseas = await fetch(server.url + '/healthz', { headers: { 'X-Real-IP': ip } });
    assert.equal(overseas.status, 403); assert.equal((await overseas.json()).error, 'FOREIGN_IP_BLOCKED');
  }
  const domestic = await fetch(server.url + '/healthz', { headers: { 'X-Real-IP': apiMainlandIps[0] } });
  assert.equal(domestic.status, 200); await domestic.arrayBuffer();
  // An address the database cannot place is refused like an overseas one, so the rate/ban walk takes its own
  // domestic address and the unplaceable one is asserted on its own.
  const unplaceable = await fetch(server.url + '/healthz', { headers: { 'X-Real-IP': '203.0.113.9' } });
  assert.equal(unplaceable.status, 403); assert.equal((await unplaceable.json()).error, 'FOREIGN_IP_BLOCKED');
  const headers = { 'X-Real-IP': apiMainlandIps[1] };
  for (const status of [200, 200, 429, 403]) {
    const res = await fetch(server.url + '/healthz', { headers });
    assert.equal(res.status, status); await res.arrayBuffer();
  }
  await server.close(); server = await startServer(opts);
  const blocked = await fetch(server.url + '/vendor/pixi.min.js', { headers });
  assert.equal(blocked.status, 403); assert.equal((await blocked.json()).error, 'IP_BANNED');
  assert.equal((await fetch(server.url + '/healthz')).status, 200);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(server.url.replace('http:', 'ws:') + '/ws', { headers });
    ws.on('open', () => { ws.terminate(); reject(new Error('banned WebSocket was accepted')); });
    ws.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); ws.terminate(); resolve(); });
    ws.on('error', () => {});
  });
});

test('the network table evicts the least recently active network instead of refusing every new source', () => {
  let at = 0;
  const limiter = createPublicApiLimiter({ now: () => at, maxKeys: 2, banStore: { has: () => false, ban: () => true } });
  const call = (ip) => limiter(request(ip), '/healthz', true);
  assert.equal(call('203.0.113.10'), true);
  at = 1000; assert.equal(call('203.0.113.11'), true);
  at = 2000;
  assert.equal(call('203.0.113.12'), true, 'a new network is admitted by evicting the least recently active one');
  assert.equal(call('203.0.113.11'), true, 'the network that kept talking kept its bucket');
});

test('a ban store that cannot take the key still keeps the flooding network refused: no throw, no fresh burst', () => {
  let at = 0;
  const attempts = [];
  const banStore = { has: () => false, ban: (key) => { attempts.push(key); return false; } };  // full list
  const limiter = createPublicApiLimiter({ now: () => at, banStore, banThreshold: 3 });
  const ip = '203.0.113.50';
  for (let i = 0; i < 3; i++) assert.equal(limiter(request(ip), '/api/ping', true), true);
  assert.equal(limiter(request(ip), '/api/ping', true), false);
  assert.deepEqual(attempts, [ip], 'the ban is attempted once per window, not on every request');
  for (let i = 0; i < 20; i++) assert.equal(limiter(request(ip), '/api/ping', true), false, 'still refused');
  at = 60001;  // the window passes: counting starts over
  assert.equal(limiter(request(ip), '/api/ping', true), true);
});
