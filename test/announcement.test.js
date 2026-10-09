import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseAnnouncement, createAnnouncementReader } from '../server/announcement.js';
import { startServer } from '../server/index.js';
import { announcementOptionsFrom } from '../server/http/config.js';

const config = { enabled: true, title: '维护公告', text: '17:00 开始维护，请提前结束模拟。', expiresAt: '2099-10-04T17:00:00+08:00' };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sp-announcement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'announcement.json');
}
function upstream(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    t.after(() => new Promise((r) => server.close(r)));
  });
}

test('announcement configuration is bounded, timezone explicit, and revisions follow content edits', () => {
  const a = parseAnnouncement(config);
  assert.equal(a.expiresAt, Date.parse('2099-10-04T09:00:00Z'));
  assert.equal(parseAnnouncement({ ...config, expiresAt: '2099-10-04T09:00:00Z' }).id, a.id, 'same instant is the same revision');
  assert.equal(parseAnnouncement({ ...config, adminToken: 'never-public' }).id, a.id);
  assert.notEqual(parseAnnouncement({ ...config, text: '维护延后' }).id, a.id);
  assert.notEqual(parseAnnouncement({ ...config, expiresAt: '2099-10-04T18:00:00+08:00' }).id, a.id);
  assert.equal(parseAnnouncement({ enabled: false }), null);
  assert.equal(parseAnnouncement({ ...config, title: undefined }).title, '维护公告');
  for (const value of [null, [], {}, { ...config, enabled: 'true' }, { ...config, text: '' },
    { ...config, text: 'a'.repeat(2001) }, { ...config, title: 'a'.repeat(81) },
    { ...config, expiresAt: '2099-10-04T17:00:00' }, { ...config, expiresAt: '2099-99-04T17:00:00Z' },
    { ...config, expiresAt: '2099-02-30T17:00:00Z' }, { ...config, expiresAt: '2099-10-04T24:00:00Z' }]) {
    assert.throws(() => parseAnnouncement(value));
  }
});

test('hot reader expires cached notices, reloads edits, handles removal and malformed/oversized files', async (t) => {
  const filePath = await fixture(t);
  let now = 0;
  const warnings = [];
  const read = createAnnouncementReader({ filePath, now: () => now, log: { warn: (...args) => warnings.push(args) } });
  assert.equal(await read(), null, 'missing file disables notices');
  assert.equal(warnings.length, 0);
  const short = { ...config, expiresAt: '1970-01-01T00:00:01.500Z' };
  await writeFile(filePath, JSON.stringify(short));
  now = 1000;
  const a = await read();
  assert.ok(a);
  now = 1499;
  assert.equal((await read()).id, a.id);
  now = 1500;
  assert.equal(await read(), null, 'expiry is checked before the cache refresh');
  await writeFile(filePath, '\uFEFF' + JSON.stringify(config));
  now = 2000;
  assert.ok(await read(), 'accept the UTF-8 BOM used by Windows editors');
  await writeFile(filePath, '{');
  now = 3000;
  assert.deepEqual(await Promise.all([read(), read(), read()]), [null, null, null]);
  assert.equal(warnings.length, 1, 'concurrent players share a read');
  now = 4000;
  assert.equal(await read(), null);
  assert.equal(warnings.length, 1, 'unchanged errors do not flood logs');
  await writeFile(filePath, 'a'.repeat(16 * 1024 + 1));
  now = 5000;
  assert.equal(await read(), null);
  assert.equal(warnings.length, 2);
  await writeFile(filePath, JSON.stringify({ enabled: false }));
  now = 6000;
  assert.equal(await read(), null);
  await writeFile(filePath, JSON.stringify(config));
  now = 7000;
  assert.ok(await read(), 'valid updates recover without restarting');
  await rm(filePath);
  now = 8000;
  assert.equal(await read(), null);
});

test('remote reader polls the panel on its interval and coalesces concurrent reads', async (t) => {
  let polls = 0;
  const source = await upstream(t, (req, res) => { polls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(config)); });
  let now = 1000;
  const read = createAnnouncementReader({ announcementUrl: source.url, now: () => now, pollMs: 10000 });
  const a = await read();
  assert.equal(a.title, config.title);
  assert.equal(a.id, parseAnnouncement(config).id);
  assert.equal(polls, 1);
  assert.deepEqual(await Promise.all([read(), read(), read()]), [a, a, a]);
  now = 5000;
  assert.equal((await read()).id, a.id, 'reads inside the interval skip polling');
  assert.equal(polls, 1);
  now = 12000;
  await read();
  assert.equal(polls, 2, 'the interval elapsing triggers exactly one new poll');
});

test('remote reader keeps the last good notice during outages and honors explicit disable and expiry', async (t) => {
  let body = JSON.stringify(config), status = 200, warnings = 0;
  const source = await upstream(t, (req, res) => {
    if (status >= 500) warnings++;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  let now = 1000;
  const read = createAnnouncementReader({ announcementUrl: source.url, now: () => now, pollMs: 10000, log: { warn: () => warnings++ } });
  const a = await read();
  status = 503; now = 12000;
  assert.equal((await read()).id, a.id, 'an unreachable source keeps the last good notice');
  body = 'not json'; status = 200; now = 22000;
  assert.equal((await read()).id, a.id, 'invalid payloads keep the last good notice too');
  body = JSON.stringify({ ...config, text: 'x'.repeat(70000) }); now = 32000;
  assert.equal((await read()).id, a.id, 'oversized responses keep the last good notice');
  body = JSON.stringify({ enabled: false }); now = 42000;
  assert.equal(await read(), null, 'an explicit disable clears the notice immediately');
  body = JSON.stringify(config); now = 52000;
  assert.ok(await read(), 're-enabling restores the notice');
  body = JSON.stringify({ ...config, expiresAt: '1970-01-01T00:00:01.000Z' }); now = 62000;
  assert.equal(await read(), null, 'expiry is still enforced against the wall clock');
  body = JSON.stringify(config); now = 72000;
  assert.ok(await read(), 'a fresh deadline serves again');
  assert.ok(warnings > 0, 'outages are logged');
});

test('startServer serves the central announcement source through the URL mode', async (t) => {
  let body = JSON.stringify({ ...config, secret: 'internal-only' });
  const source = await upstream(t, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementUrl: source.url });
  t.after(() => srv.close());
  const out = await (await fetch(`${srv.url}/api/announcement`)).json();
  assert.deepEqual(out.announcement, parseAnnouncement(config));
  assert.ok(!JSON.stringify(out).includes('internal-only'), 'only the public projection leaves the game');
});

test('announcement HTTP API is read-only, not cached, and exposes only the public projection', async (t) => {
  const filePath = await fixture(t);
  await writeFile(filePath, JSON.stringify({ ...config, secret: 'never-public' }));
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementSource: 'file', announcementFile: filePath });
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/api/announcement`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body.announcement, parseAnnouncement(config));
  assert.ok(Math.abs(Date.now() - body.serverTime) < 5000);
  assert.equal(JSON.stringify(body).includes('never-public'), false);
  const head = await fetch(`${srv.url}/api/announcement`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${srv.url}/api/announcement`, { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(`${srv.url}/announcement.json`)).status, 404, 'local configuration is outside public/');
  assert.equal(srv.registry.size, 0);
});

test('central panel is the default, including blank URL and a configured local file path', () => {
  for (const env of [{}, { SP_ANNOUNCEMENT_URL: '' }, { SP_ANNOUNCEMENT_FILE: 'old-notice.json' }]) {
    const options = announcementOptionsFrom({}, env);
    assert.equal(options.announcementUrl, 'https://game.rainya.me/api/announce/v1/site-ad797aa8');
    assert.deepEqual(options.source, { mode: 'panel', siteId: 'site-ad797aa8' });
  }
  const env = { SP_SITE_ID: 'aliyun', SP_PORTAL_URL: 'https://panel.example/', SP_ANNOUNCEMENT_POLL_MS: '30000' };
  assert.equal(announcementOptionsFrom({}, env).announcementUrl, 'https://panel.example/api/announce/v1/aliyun');
  assert.equal(announcementOptionsFrom({}, env).pollMs, 30000);
  const explicit = announcementOptionsFrom({ announcementUrl: 'https://old.example/api/announce/v1/shiyan', announcementPollMs: 5000 }, env);
  assert.equal(explicit.source.siteId, 'shiyan', 'existing full feed URLs keep their own identity');
  assert.equal(explicit.pollMs, 5000, 'programmatic interval wins over the environment');
  assert.equal(announcementOptionsFrom({}, { SP_ANNOUNCEMENT_URL: 'https://old.example/api/announce/v1/hongkong',
    SP_SITE_ID: '', SP_PORTAL_URL: 'unused-invalid-base' }).source.siteId, 'hongkong', 'a complete feed URL needs no base or site ID');
  const local = announcementOptionsFrom({}, { ...env, SP_ANNOUNCEMENT_SOURCE: 'file', SP_ANNOUNCEMENT_URL: 'https://unused.example/' });
  assert.equal(local.announcementUrl, null, 'file mode requires an explicit source choice');
  assert.deepEqual(local.source, { mode: 'file', siteId: null });
  for (const bad of [{ SP_ANNOUNCEMENT_SOURCE: 'files' }, { SP_SITE_ID: '../other' }, { SP_ANNOUNCEMENT_POLL_MS: 'bad' },
    { SP_ANNOUNCEMENT_URL: 'file:///tmp/notice' }, { SP_ANNOUNCEMENT_URL: 'https://user:secret@example.com/' }]) {
    assert.throws(() => announcementOptionsFrom({}, bad));
  }
});

test('default server uses the panel feed even with a valid local notice; outages never switch to the file', async (t) => {
  const filePath = await fixture(t);
  await writeFile(filePath, JSON.stringify({ ...config, text: 'LOCAL: must never appear' }));
  const nativeFetch = globalThis.fetch;
  let status = 503, calls = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === 'https://game.rainya.me/api/announce/v1/site-ad797aa8') {
      calls++;
      return Promise.resolve(new Response(JSON.stringify(config), { status }));
    }
    return nativeFetch(url, options);
  });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementFile: filePath, announcementPollMs: 3000 });
  t.after(() => srv.close());
  const first = await (await fetch(`${srv.url}/api/announcement`)).json();
  assert.equal(first.announcement, null, 'unavailable central feed does not load the local file');
  assert.deepEqual(first.source, { mode: 'panel', siteId: 'site-ad797aa8' });
  status = 200;
  await new Promise(resolve => setTimeout(resolve, 3050));
  const second = await (await fetch(`${srv.url}/api/announcement`)).json();
  assert.deepEqual(second.announcement, parseAnnouncement(config));
  assert.equal(calls, 2);
});

test('site ID and portal URL compose the feed for newly deployed sites', async (t) => {
  let requested;
  const source = await upstream(t, (req, res) => { requested = req.url; res.end(JSON.stringify(config)); });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
    announcementPortalUrl: source.url, announcementSiteId: 'new-domestic' });
  t.after(() => srv.close());
  const body = await (await fetch(`${srv.url}/api/announcement`)).json();
  assert.equal(requested, '/api/announce/v1/new-domestic');
  assert.deepEqual(body.source, { mode: 'panel', siteId: 'new-domestic' });
  assert.deepEqual(body.announcement, parseAnnouncement(config));
});
