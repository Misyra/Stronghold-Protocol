import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { createWsUpgradeLimiter, wsUpgradeLimitsFrom, WS_UPGRADE_DEFAULTS } from '../server/http/wsUpgradeLimit.js';
import { createIpBanStore } from '../server/http/ipBans.js';
import { startServer } from '../server/index.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const request = (ip = '203.0.113.9', peer = '127.0.0.1') => ({ headers: { 'x-real-ip': ip }, socket: { remoteAddress: peer } });

test('the 101st upgrade in a rolling 60 seconds bans for one hour, without extending on rejected attempts', () => {
  let at = 1000;
  const bans = createIpBanStore({ now: () => at, log: quiet });
  const allow = createWsUpgradeLimiter({ now: () => at, banStore: bans });
  for (let i = 0; i < 50; i++) assert.equal(allow(request()), true);
  at = 60999;
  for (let i = 0; i < 50; i++) assert.equal(allow(request()), true);
  assert.equal(allow(request()), false);
  assert.equal(bans.has('203.0.113.9'), true);
  const expires = at + 3600000;
  at = expires - 1;
  assert.equal(allow(request()), false);
  at = expires;
  assert.equal(bans.has('203.0.113.9'), false);
  assert.equal(allow(request()), true);
  assert.equal(allow(request('203.0.113.10')), true);
});

test('expired window entries drop at the exact boundary; IPv6 /64 rotation shares one count', () => {
  let at = 0;
  const bans = createIpBanStore({ now: () => at, log: quiet });
  const allow = createWsUpgradeLimiter({ threshold: 10, now: () => at, banStore: bans });
  for (let i = 0; i < 10; i++) assert.equal(allow(request()), true);
  at = 60000;
  assert.equal(allow(request()), true, 'attempts exactly 60 seconds old have expired');
  for (let i = 1; i <= 10; i++) assert.equal(allow(request(`2001:db8:1:2::${i}`)), true);
  assert.equal(allow(request('2001:db8:1:2::ffff')), false);
  assert.equal(allow(request('2001:db8:1:3::1')), true);
});

test('trusted proxy addresses count; direct local monitoring stays exempt and public spoofing cannot reset counts', () => {
  const bans = createIpBanStore({ log: quiet });
  const allow = createWsUpgradeLimiter({ threshold: 10, banStore: bans });
  for (let i = 0; i < 20; i++) assert.equal(allow({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), true);
  for (let i = 0; i < 10; i++) assert.equal(allow(request(`203.0.113.${i}`, '198.51.100.2')), true);
  assert.equal(allow(request('127.0.0.1', '198.51.100.2')), false, 'untrusted forwarding headers never replace the peer');
  assert.equal(bans.has('198.51.100.2'), true);
});

test('temporary bans reload, expire, can be renewed after expiry, and never weaken legacy permanent bans', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ws-bans-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bans.jsonl');
  let at = 1000;
  const open = () => createIpBanStore({ file, now: () => at, log: quiet });
  let bans = open();
  bans.ban('203.0.113.9', { durationMs: 86400000, reason: 'WS_UPGRADE_FLOOD' });
  bans.ban('203.0.113.10');
  assert.equal(open().has('203.0.113.9'), true);
  at += 86400000;
  bans = open();
  assert.equal(bans.has('203.0.113.9'), false);
  assert.equal(bans.has('203.0.113.10'), true);
  bans.ban('203.0.113.9', { durationMs: 86400000 });
  bans.ban('203.0.113.9');
  bans.ban('203.0.113.9', { durationMs: 1 });
  at += 2 * 86400000;
  assert.equal(open().has('203.0.113.9'), true, 'promotion to a permanent ban survives later temporary requests');
  fs.appendFileSync(file, JSON.stringify({ key: '203.0.113.9', expiresAt: at + 1000 }) + '\n');
  at += 1001;
  assert.equal(open().has('203.0.113.9'), true, 'legacy permanent entries win over later expiring records');
  fs.appendFileSync(file, JSON.stringify({ key: '203.0.113.11', expiresAt: 'tomorrow' }) + '\n');
  assert.throws(open, /expiry/);
});

test('full or failing ban storage keeps an offender locally refused for the configured 24 hours', () => {
  for (const throws of [false, true]) {
    let at = 0, writes = 0;
    const allow = createWsUpgradeLimiter({ threshold: 1, banMs: 86400000, now: () => at, banStore: { has: () => false,
      ban: () => { writes++; if (throws) throw new Error('full'); return false; } } });
    assert.equal(allow(request()), true);
    assert.equal(allow(request()), false);
    at = 60001;
    for (let i = 0; i < 10; i++) assert.equal(allow(request()), false);
    assert.equal(writes, 1);
    at = 86400000;
    assert.equal(allow(request()), true);
  }
});

test('ban history compacts atomically at its size limit, retaining active and permanent entries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ws-ban-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bans.jsonl');
  const permanent = JSON.stringify({ key: '203.0.113.10', reason: 'PUBLIC_API_FLOOD', bannedAt: 1 }) + '\n';
  fs.writeFileSync(file, permanent + ' '.repeat(32 * 1024 * 1024 - 64 - Buffer.byteLength(permanent)));
  const bans = createIpBanStore({ file, now: () => 1000, log: quiet });
  bans.ban('203.0.113.9', { durationMs: 86400000, reason: 'WS_UPGRADE_FLOOD' });
  assert.ok(fs.statSync(file).size < 1000);
  const restored = createIpBanStore({ file, now: () => 1001, log: quiet });
  assert.equal(restored.has('203.0.113.9'), true);
  assert.equal(restored.has('203.0.113.10'), true);
  assert.deepEqual(fs.readdirSync(dir), ['bans.jsonl'], 'no temporary file remains after an atomic replacement');
});

test('ingress filter counts only /ws 444 upgrade refusals, ignores successes/5xx/spoofing, and uses 100/60s/1h', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const filter = fs.readFileSync(path.join(root, 'scripts/hardening/sp-ws-upgrade.filter.conf'), 'utf8');
  const expression = /^failregex = (.*)$/m.exec(filter)[1].replace('<HOST>', '(?<ip>\\S+)');
  const matches = new RegExp(expression);
  const line = (ip, status, marker = 1, query = '', ua = 'Chrome') =>
    `${ip} - - [17/Oct/2026:00:00:00 +0800] "GET /ws${query} HTTP/1.1" ${status} 0 "-" "${ua}" business=1 ws_upgrade=${marker}`;
  for (const ip of ['203.0.113.9', '2001:db8::1'])
    for (const status of [101, 400, 403, 429, 444, 503]) assert.equal(matches.test(line(ip, status)), status === 444);
  assert.equal(matches.test(line('203.0.113.9', 444, 1, '?retry=1')), true);
  assert.equal(matches.test(line('203.0.113.9', 444).replace('GET /ws ', 'GET /wrong ')), false);
  assert.equal(matches.test(line('203.0.113.9', 444, 0, '?ws_upgrade=1', 'ws_upgrade=1')), false);
  assert.equal(matches.test(line('203.0.113.9', 200, 0, '?ws_upgrade=1', 'ws_upgrade=1')), false);
  const jail = fs.readFileSync(path.join(root, 'scripts/hardening/sp-hardening.jail.conf'), 'utf8').split('[sp-ws-upgrade-direct]')[1];
  for (const [name, value] of [['findtime', 60], ['maxretry', 100], ['bantime', 3600]])
    assert.match(jail, new RegExp(`^${name} = ${value}$`, 'm'));
  assert.match(jail, /^enabled = false$/m, 'deployment remains explicit');
  const nginx = fs.readFileSync(path.join(root, 'scripts/nginx-log-format.conf.example'), 'utf8');
  assert.match(nginx, /map \$http_upgrade \$sp_log_ws_upgrade/);
  assert.match(nginx, /ws_upgrade=\$sp_log_ws_upgrade/);
});

test('counter saturation admits new visitors and retains recently active sources and local bans', () => {
  const allow = createWsUpgradeLimiter({ threshold: 2, maxKeys: 2, banStore: { has: () => false, ban: () => false } });
  assert.equal(allow(request('203.0.113.1')), true);
  assert.equal(allow(request('203.0.113.2')), true);
  assert.equal(allow(request('203.0.113.1')), true);
  assert.equal(allow(request('203.0.113.3')), true);
  assert.equal(allow(request('203.0.113.1')), false, 'recent offender retained its count');
  assert.equal(allow(request('203.0.113.4')), true);
  assert.equal(allow(request('203.0.113.1')), false, 'local ban cannot be evicted');
});

test('upgrade configuration allows 100 attempts then bans one hour; invalid values fail before server allocation', () => {
  assert.deepEqual(WS_UPGRADE_DEFAULTS, { threshold: 100, windowMs: 60000, banMs: 3600000 });
  assert.deepEqual(wsUpgradeLimitsFrom({}, {}), WS_UPGRADE_DEFAULTS);
  assert.equal(wsUpgradeLimitsFrom({}, { SP_WS_UPGRADE_THRESHOLD: '20' }).threshold, 20);
  for (const name of ['SP_WS_UPGRADE_THRESHOLD', 'SP_WS_UPGRADE_WINDOW_MS', 'SP_WS_UPGRADE_BAN_MS'])
    for (const value of ['0', '-1', 'NaN', '1.5', '']) assert.throws(() => wsUpgradeLimitsFrom({}, { [name]: value }), new RegExp(name));
});

test('real upgrades: successful reconnects and refused paths/origins count; bans survive restart and expire', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ws-upgrades-'));
  const file = path.join(dir, 'bans.jsonl');
  const opts = { host: '127.0.0.1', port: 0, quiet: true, log: quiet, workers: 0, store: null,
    announcementFile: null, ipBanFile: file, httpApiMainlandOnly: false,
    wsUpgradeLimits: { threshold: 10, banMs: 86400000 } };
  let server;
  t.after(async () => { await server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  server = await startServer(opts);
  const attempt = (ip = '203.0.113.9', pathname = '/ws', origin) => new Promise((resolve, reject) => {
    const ws = new WebSocket(server.url.replace('http:', 'ws:') + pathname, { headers: { 'X-Real-IP': ip, ...(origin ? { Origin: origin } : {}) } });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); resolve(101); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on('error', reject);
  });
  for (let i = 0; i < 10; i++) assert.equal(await attempt(), 101);
  assert.equal(await attempt(), 403);
  assert.equal((await fetch(server.url + '/healthz', { headers: { 'X-Real-IP': '203.0.113.9' } })).status, 403);
  assert.equal(await attempt('203.0.113.10'), 101);
  for (let i = 0; i < 5; i++) assert.equal(await attempt('203.0.113.11', '/wrong'), 404);
  for (let i = 0; i < 5; i++) assert.equal(await attempt('203.0.113.11', '/ws', 'https://other.example'), 403);
  assert.equal(await attempt('203.0.113.11'), 403, 'refused upgrades count toward the same threshold');
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  for (const record of records) { assert.equal(record.reason, 'WS_UPGRADE_FLOOD'); assert.equal(record.expiresAt - record.bannedAt, 86400000); }
  await server.close(); server = await startServer(opts);
  assert.equal(await attempt(), 403);
  await server.close(); server = null;
  // Simulate elapsed wall time on disk, without changing global timers used by server heartbeats.
  fs.writeFileSync(file, records.map((record) => JSON.stringify({ ...record, expiresAt: Date.now() - 1 })).join('\n') + '\n');
  server = await startServer(opts);
  assert.equal(await attempt(), 101);
});
