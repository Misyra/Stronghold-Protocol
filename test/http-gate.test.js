// test/http-gate.test.js — the access gate (server/http/gate.js, 2026-11-03): the signed cookie, the password page,
// login throttling, /healthz staying open, HTML navigations redirected and everything else 401, and the WebSocket
// upgrade refused without the same cookie. The handler and the upgrade are exercised directly (no data load): the
// gate is a layer in front of them, not part of a match.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

import { createGate, gateCookie, validGateCookie, safeNext, gateOptionsFrom, gateFrom, GATE_COOKIE } from '../server/http/gate.js';
import { createRequestHandler } from '../server/http/routes.js';
import { attachWebSocket } from '../server/http/websocket.js';

const SECRET = 'test-secret';
const PASSWORD = 'host-and-guest';
const log = { warn() {}, info() {}, error() {}, debug() {} };

/** A server whose static layer answers `static:<path>` (the gate never lets a gated request reach it). */
async function gateServer({ gateLocal = false, password = PASSWORD, trustProxy = false } = {}) {
  const gate = createGate({ password, secret: SECRET, ttlDays: 7, localBypass: gateLocal, log });
  const health = {
    startedAt: Date.now(), traffic: null, assetIndex: null, views: null, persisters: null,
    network: { connectionCount: 0 }, registry: { size: 0, connectedSize: 0 },
    lobby: { stats: () => ({}), plugins: { unofficial: () => 0, hasNotices: () => false } },
  };
  const handler = createRequestHandler({
    serveStatic: (req, res, rawPath) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`static:${rawPath}`); },
    health, log, trustProxy, gate,
  });
  const server = http.createServer(handler);
  const peers = [];
  const wss = attachWebSocket(server, {
    network: { admission: () => null, handleConnection: (ws) => { peers.push(ws); ws.on('close', () => {}); } },
    log, gate,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    gate, base, peers,
    get: (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts }),
    post: (path, body, opts = {}) => fetch(base + path, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
      body: typeof body === 'string' ? body : new URLSearchParams(body).toString(),
      ...opts,
    }),
    close: () => new Promise((resolve) => { wss.close(); server.close(() => resolve()); }),
  };
}

const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`)) || null;

/** A CSRF token: GET /entry, read the cookie and the hidden input, return both. */
async function csrfOf(srv) {
  const res = await srv.get('/entry');
  const html = await res.text();
  const cookie = cookieOf(res, 'sp_gate_csrf');
  const input = /name="csrf" value="([^"]*)"/.exec(html);
  assert.ok(cookie && input, 'the entry page sets a CSRF cookie and carries the token');
  return { cookie, token: input[1] };
}

describe('gate options and cookie', () => {
  test('safeNext keeps same-origin paths only', () => {
    assert.equal(safeNext('/'), '/');
    assert.equal(safeNext('/lobby?x=1'), '/lobby?x=1');
    for (const bad of ['//evil.example/', 'https://evil.example/', '/a\\b', '/a\nb', '', null, 42, '/'.repeat(1600)]) {
      assert.equal(safeNext(bad), '/', String(bad));
    }
  });

  test('the cookie is signed, expires, and a tampered value does not pass', () => {
    const now = Date.now();
    const header = gateCookie(SECRET, 60_000);
    const value = header.split(';')[0];
    const req = { headers: { cookie: value } };
    assert.equal(validGateCookie(req, SECRET, now), true);
    const [exp, sig] = value.slice(GATE_COOKIE.length + 1).split('.');
    assert.equal(validGateCookie({ headers: { cookie: `${GATE_COOKIE}=${exp}.${sig.slice(0, -2)}AA` } }, SECRET, now), false, 'signature');
    assert.equal(validGateCookie({ headers: { cookie: `${GATE_COOKIE}=${Number(exp) + 1}.${sig}` } }, SECRET, now), false, 'expiry');
    assert.equal(validGateCookie({ headers: { cookie: `${GATE_COOKIE}=${exp}.${sig}` } }, 'other-secret', now), false, 'secret');
    assert.equal(validGateCookie({ headers: { cookie: '' } }, SECRET, now), false);
  });

  test('options: an explicit option wins over the environment; junk TTL falls back with a warning', () => {
    const warns = [];
    const env = { SP_GATE_PASSWORD: 'env-pw', SP_GATE_TTL_DAYS: 'junk', SP_GATE_LOCAL: '0' };
    const o = gateOptionsFrom({ gatePassword: 'opt-pw', gateTtlDays: 30 }, env, { warn: (m) => warns.push(m) });
    assert.equal(o.password, 'opt-pw');
    assert.equal(o.ttlDays, 30);
    assert.equal(o.localBypass, false, 'SP_GATE_LOCAL=0');
    const d = gateOptionsFrom({}, {}, null);
    assert.equal(d.password, '');
    assert.equal(d.ttlDays, 7);
    assert.equal(d.localBypass, true);
    gateOptionsFrom({}, { SP_GATE_TTL_DAYS: 'x' }, { warn: (m) => warns.push(m) });
    assert.equal(warns.length, 1);
    assert.match(warns[0], /SP_GATE_TTL_DAYS/);
  });

  test('SP_GATE_LOCAL_BYPASS=off turns the loopback/LAN bypass off (the headerless-tunnel opt-out)', () => {
    assert.equal(gateOptionsFrom({}, { SP_GATE_LOCAL_BYPASS: 'off' }, null).localBypass, false);
    assert.equal(gateOptionsFrom({}, { SP_GATE_LOCAL_BYPASS: '0' }, null).localBypass, false);
    assert.equal(gateOptionsFrom({ gateLocalBypass: false }, {}, null).localBypass, false, 'an explicit option wins');
    assert.equal(gateOptionsFrom({}, { SP_GATE_LOCAL_BYPASS: 'on' }, null).localBypass, true);
    // either knob off is enough; SP_GATE_LOCAL_BYPASS cannot re-enable what SP_GATE_LOCAL turned off
    assert.equal(gateOptionsFrom({}, { SP_GATE_LOCAL: '0', SP_GATE_LOCAL_BYPASS: 'on' }, null).localBypass, false);
    // the same knob read through createGate: a loopback peer is gated once the bypass is off
    const on = createGate({ password: PASSWORD, secret: SECRET, localBypass: true, log });
    const off = createGate({ password: PASSWORD, secret: SECRET, localBypass: false, log });
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    assert.equal(on.check(req), true, 'the default bypass covers a headerless local peer');
    assert.equal(off.check(req), false, 'SP_GATE_LOCAL_BYPASS=off gates it like any internet client');
  });

  test('the cookie is bound to the password: changing it invalidates old cookies', () => {
    const now = Date.now();
    const value = gateCookie(SECRET, 60_000, false, 'old-pass').split(';')[0];
    const req = { headers: { cookie: value } };
    assert.equal(validGateCookie(req, SECRET, now, 'old-pass'), true);
    assert.equal(validGateCookie(req, SECRET, now, 'new-pass'), false);
    assert.equal(validGateCookie(req, SECRET, now), false, 'the default binding is the empty password');
  });

  test('SP_GATE_PASSWORD_FILE reads one UTF-8 line, does not trim, caps at 1 KB', () => {
    const file = join(tmpdir(), `sp-gate-pw-${process.pid}.txt`);
    writeFileSync(file, '阿米娅不是驴\r\nsecond line\n', 'utf8');
    try {
      assert.equal(gateOptionsFrom({}, { SP_GATE_PASSWORD_FILE: file }, null).password, '阿米娅不是驴');
      // the environment variable still wins over the file
      assert.equal(gateOptionsFrom({}, { SP_GATE_PASSWORD: 'env-pw', SP_GATE_PASSWORD_FILE: file }, null).password, 'env-pw');
      // spaces are part of the password
      writeFileSync(file, '  pass with spaces  \nsecond line\n', 'utf8');
      assert.equal(gateOptionsFrom({}, { SP_GATE_PASSWORD_FILE: file }, null).password, '  pass with spaces  ');
      // the read is capped at 1 KB
      writeFileSync(file, 'a'.repeat(1100), 'utf8');
      assert.equal(gateOptionsFrom({}, { SP_GATE_PASSWORD_FILE: file }, null).password.length, 1024);
    } finally { rmSync(file, { force: true }); }
  });

  test('an unreadable SP_GATE_PASSWORD_FILE fails the gate instead of silently disabling it', () => {
    const missing = join(tmpdir(), `sp-gate-missing-${process.pid}.txt`);
    assert.throws(() => gateOptionsFrom({}, { SP_GATE_PASSWORD_FILE: missing }, log), /cannot read SP_GATE_PASSWORD_FILE/);
    assert.throws(() => gateFrom({}, { SP_GATE_PASSWORD_FILE: missing }, log), /SP_GATE_PASSWORD_FILE/);
  });
});

describe('the gate in front of HTTP', () => {
  let srv;
  before(async () => { srv = await gateServer(); });
  after(async () => { await srv.close(); });

  test('a remote navigation is sent to /entry, other requests get 401, the public endpoints stay open', async () => {
    const nav = await srv.get('/', { headers: { Accept: 'text/html' } });
    assert.equal(nav.status, 302);
    assert.match(nav.headers.get('location'), /^\/entry\?next=%2F$/);
    const asset = await srv.get('/data/chess.json');
    assert.equal(asset.status, 401);
    assert.equal(asset.headers.get('www-authenticate'), 'Gate');
    const wsData = await srv.get('/assets/char/avatar/x.png');
    assert.equal(wsData.status, 401);
    // the probe and the two public read-only APIs never need the cookie
    assert.equal((await srv.get('/healthz')).status, 200);
    assert.equal((await srv.get('/api/online')).status, 200);
    assert.equal((await srv.get('/api/announcement')).status, 200);
  });

  test('the entry page is served without the cookie and offers the password form', async () => {
    const res = await srv.get('/entry?next=%2Flobby');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const html = await res.text();
    assert.match(html, /name="password"/);
    assert.match(html, /action="\/_gate\/login"/);
    assert.match(html, /value="\/lobby"/, 'next survives, sanitised');
    // a plain text field: a password input does not accept an IME composition in every browser (the owner's report)
    assert.match(html, /name="password" type="text"/);
    assert.doesNotMatch(html, /type="password"/);
    assert.ok(cookieOf(res, 'sp_gate_csrf'), 'CSRF cookie');
  });

  test('a wrong password answers 401 with the page, and repeated failures are throttled', async () => {
    const { cookie } = await csrfOf(srv);
    const token = cookie.split('=')[1];
    const attempt = () => srv.post('/_gate/login', { csrf: token, next: '/', password: 'nope' }, { headers: { Cookie: cookie } });
    const first = await attempt();
    assert.equal(first.status, 401);
    assert.match(await first.text(), /口令不正确/);
    // attempts 2–5 are still answered as wrong; the sixth inside the window is throttled
    for (let i = 0; i < 4; i++) assert.equal((await attempt()).status, 401);
    const throttled = await attempt();
    assert.equal(throttled.status, 429, 'the sixth failure inside the window is throttled');
    assert.ok(Number(throttled.headers.get('retry-after')) > 0);
  });

  test('a wrong password returns a usable CSRF token, so the retry from the error page succeeds', async () => {
    const fresh = await gateServer();
    try {
      const first = await csrfOf(fresh);
      const wrong = await fresh.post('/_gate/login', { csrf: first.token, next: '/lobby', password: 'nope' }, { headers: { Cookie: first.cookie } });
      assert.equal(wrong.status, 401);
      assert.match(await wrong.clone().text(), /口令不正确/);
      const retryCookie = cookieOf(wrong, 'sp_gate_csrf');
      const input = /name="csrf" value="([^"]*)"/.exec(await wrong.text());
      assert.ok(retryCookie && input, 'the error page reissues the CSRF cookie and token');
      assert.notEqual(input[1], first.token, 'a fresh token, not the one the browser just spent');
      const ok = await fresh.post('/_gate/login', { csrf: input[1], next: '/lobby', password: PASSWORD }, { headers: { Cookie: retryCookie } });
      assert.equal(ok.status, 303, 'the token from the error page logs in');
    } finally { await fresh.close(); }
  });

  test('the right password sets the cookie and lets the page through', async () => {
    const fresh = await gateServer();
    try {
      const { cookie, token } = await csrfOf(fresh);
      const ok = await fresh.post('/_gate/login', { csrf: token, next: '/lobby?x=1', password: PASSWORD }, { headers: { Cookie: cookie } });
      assert.equal(ok.status, 303);
      assert.equal(ok.headers.get('location'), '/lobby?x=1');
      const auth = cookieOf(ok, GATE_COOKIE);
      assert.ok(auth, 'the gate cookie');
      const page = await fresh.get('/', { headers: { Accept: 'text/html', Cookie: auth } });
      assert.equal(page.status, 200);
      assert.equal(await page.text(), 'static:/');
      // login needs the double-submit token
      const noCsrf = await fresh.post('/_gate/login', { next: '/', password: PASSWORD });
      assert.equal(noCsrf.status, 400);
      // logout clears it
      const out = await fresh.post('/_gate/logout', '', { headers: { Cookie: auth } });
      assert.equal(out.status, 303);
      assert.equal(out.headers.get('location'), '/entry');
    } finally { await fresh.close(); }
  });

  test('loopback and the private network skip the gate (default)', async () => {
    const local = await gateServer({ gateLocal: true });
    try {
      assert.equal((await local.get('/', { headers: { Accept: 'text/html' } })).status, 200);
      assert.equal((await local.get('/data/chess.json')).status, 200);
    } finally { await local.close(); }
  });
});

describe('the gate trusts only the real socket peer (P0)', () => {
  test('a forwarded loopback address never grants the bypass', () => {
    const gate = createGate({ password: PASSWORD, secret: SECRET, localBypass: true, trustProxy: 'auto', log });
    const forged = {
      socket: { remoteAddress: '203.0.113.9' },
      headers: { 'cf-connecting-ip': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },
    };
    assert.equal(gate.check(forged, '127.0.0.1'), false, 'a public peer cannot claim loopback through a header');
    assert.equal(gate.check(forged), false);
    const tunneled = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '127.0.0.1' } };
    assert.equal(gate.check(tunneled), false, 'a local tunnel forwarding a client is not a direct local client');
    assert.equal(gate.check({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), true, 'the real peer is loopback');
  });

  test("trustProxy 'auto' + a loopback peer forwarding a client is still gated", async () => {
    const srv = await gateServer({ gateLocal: true, trustProxy: 'auto' });
    try {
      for (const ip of ['8.8.8.8', '127.0.0.1']) {
        const res = await srv.get('/data/chess.json', {
          headers: { 'CF-Connecting-IP': ip, 'X-Real-IP': ip },
        });
        assert.equal(res.status, 401, `a forwarded address (${ip}) is not the peer; the gate stays on`);
      }
    } finally { await srv.close(); }
  });
});

describe('the gate in front of the WebSocket upgrade', () => {
  test('no cookie → 401; the login cookie opens /ws', async () => {
    const srv = await gateServer();
    try {
      const wsUrl = srv.base.replace('http', 'ws') + '/ws';
      const refused = await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', () => resolve('open'));
        ws.on('unexpected-response', (req, res) => resolve(`status ${res.statusCode}`));
        ws.on('error', () => resolve('error'));
      });
      assert.equal(refused, 'status 401');
      const auth = gateCookie(SECRET, 60_000, false, PASSWORD).split(';')[0];
      const opened = await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { Cookie: auth } });
        ws.on('open', () => { resolve('open'); ws.close(); });
        ws.on('unexpected-response', (req, res) => resolve(`status ${res.statusCode}`));
        ws.on('error', (e) => resolve('error ' + e.message));
      });
      assert.equal(opened, 'open');
    } finally { await srv.close(); }
  });
});
