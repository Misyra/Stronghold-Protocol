import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAnnouncement, createAnnouncementReader } from '../server/announcement.js';
import { startServer } from '../server/index.js';

const config = { enabled: true, title: '维护公告', text: '17:00 开始维护，请提前结束模拟。', expiresAt: '2099-10-04T17:00:00+08:00' };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sp-announcement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'announcement.json');
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

test('announcement HTTP API is read-only, not cached, and exposes only the public projection', async (t) => {
  const filePath = await fixture(t);
  await writeFile(filePath, JSON.stringify({ ...config, secret: 'never-public' }));
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementFile: filePath });
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
