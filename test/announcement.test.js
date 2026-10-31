// test/announcement.test.js — the hot-loaded maintenance notice (server/announcement.js, 合并自用户分支;
// 单源精简: one schedule file, hot-reloaded — the fork's legacy single-notice shape, central feed reader and
// delivery-revision bookkeeping belong to its ops pipeline and are not ported, so the tests of those halves
// are not either).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAnnouncementReader } from '../server/announcement.js';
import { startServer } from '../server/index.js';
import { announcementOptionsFrom } from '../server/http/config.js';
import { parseAnnouncements } from '../shared/announcements.js';

/** A live row for the REAL clock (the server tests) — started a minute ago, one hour long. */
const row = (overrides = {}) => ({ id: 'maintenance', text: '17:00 开始维护，请提前结束模拟。', startAt: new Date(Date.now() - 60_000).toISOString(), durationSeconds: 3600, level: 'info', enabled: true, ...overrides });
/** A row pinned to the hot-reader test's virtual clock. */
const fixedRow = (overrides = {}) => ({ ...row(), startAt: '2026-10-05T12:00:00+08:00', ...overrides });
const schedule = (...rows) => ({ announcements: rows });
/** The scroll projection the client reads (server/announcement.js scrollNotice). */
const served = (r) => {
  const a = parseAnnouncements(schedule(r))[0];
  return { id: a.id, title: a.title || '维护公告', text: a.text, expiresAt: a.endAt };
};

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sp-announcement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'announcement.json');
}

test('hot reader expires cached notices, reloads edits, handles removal and malformed/oversized files', async (t) => {
  const filePath = await fixture(t);
  const BASE = Date.parse('2026-10-05T12:00:00+08:00'); // the row's startAt: the clock starts when it goes live
  let now = BASE - 8000;
  const warnings = [];
  const read = createAnnouncementReader({ filePath, now: () => now, pollMs: 0, log: { warn: (...args) => warnings.push(args) } });
  assert.equal(await read(), null, 'missing file disables notices');
  assert.equal(warnings.length, 0);
  const short = fixedRow({ durationSeconds: 1 });
  await writeFile(filePath, JSON.stringify(schedule(short)));
  now = BASE;
  const a = await read();
  assert.ok(a);
  now = BASE + 999;
  assert.equal((await read()).id, a.id);
  now = BASE + 1000;
  assert.equal(await read(), null, 'expiry is checked against the wall clock');
  await writeFile(filePath, '\uFEFF' + JSON.stringify(schedule(fixedRow())));
  now = BASE + 2000;
  assert.ok(await read(), 'accept the UTF-8 BOM used by Windows editors');
  await writeFile(filePath, '{');
  now = BASE + 3000;
  assert.deepEqual(await Promise.all([read(), read(), read()]), [null, null, null]);
  assert.equal(warnings.length, 1, 'concurrent players share a read');
  now = BASE + 4000;
  assert.equal(await read(), null);
  assert.equal(warnings.length, 1, 'unchanged errors do not flood logs');
  await writeFile(filePath, 'a'.repeat(16 * 1024 + 1));
  now = BASE + 5000;
  assert.equal(await read(), null);
  assert.equal(warnings.length, 2);
  await writeFile(filePath, JSON.stringify(schedule(fixedRow({ enabled: false }))));
  now = BASE + 6000;
  assert.equal(await read(), null);
  await writeFile(filePath, JSON.stringify(schedule(fixedRow())));
  now = BASE + 7000;
  assert.ok(await read(), 'valid updates recover without restarting');
  await rm(filePath);
  now = BASE + 8000;
  assert.equal(await read(), null);
});

test('the file source is hot-edited while the server runs; the API exposes only the public projection', async (t) => {
  const filePath = await fixture(t);
  await writeFile(filePath, JSON.stringify(schedule(row({ text: 'manual notice' }))));
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementFile: filePath, announcementPollMs: 500 });
  t.after(() => srv.close());
  const first = await (await fetch(srv.url + '/api/announcement')).json();
  assert.equal(first.announcement.text, 'manual notice');
  assert.equal(first.source, 'file');
  assert.equal(first.popupAnnouncement, null, 'a scroll-only schedule has no popup');
  await writeFile(filePath, JSON.stringify(schedule(row({ text: '编辑后的公告' }))));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const second = await (await fetch(srv.url + '/api/announcement')).json();
  assert.equal(second.announcement.text, '编辑后的公告', 'the hot edit reaches every page within the poll interval');
});

test('announcement HTTP API is read-only, not cached, and exposes only the public projection', async (t) => {
  const filePath = await fixture(t);
  const live = row({ text: 'never-public' }); // built once: the expected projection must be the same row's
  await writeFile(filePath, JSON.stringify(schedule(live)));
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementFile: filePath });
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/api/announcement`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body.announcement, served(live));
  assert.ok(Math.abs(Date.now() - body.serverTime) < 5000);
  const head = await fetch(`${srv.url}/api/announcement`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${srv.url}/api/announcement`, { method: 'POST', body: '{}' })).status, 405);
  assert.equal(srv.registry.size, 0);
});

test('default reads the schedule shipped with the repo (every row disabled); SP_ANNOUNCEMENT_FILE renames it', () => {
  const options = announcementOptionsFrom({}, {});
  assert.equal(options.source, 'file');
  assert.ok(options.filePath.endsWith(path.join('config', 'announcements.json')), JSON.stringify(options));
  assert.equal(options.pollMs, 10000);
  const named = announcementOptionsFrom({}, { SP_ANNOUNCEMENT_FILE: 'notices.json', SP_ANNOUNCEMENT_POLL_MS: '30000' });
  assert.ok(named.filePath.endsWith('notices.json'));
  assert.equal(named.pollMs, 30000);
  const explicit = announcementOptionsFrom({ announcementFile: 'other.json', announcementPollMs: 5000 }, {});
  assert.ok(explicit.filePath.endsWith('other.json'));
  assert.equal(explicit.pollMs, 5000);
  assert.equal(announcementOptionsFrom({ announcementFile: null }, {}).filePath, null, 'null names no file (disabled)');
  for (const bad of [{ SP_ANNOUNCEMENT_POLL_MS: 'bad' }]) assert.throws(() => announcementOptionsFrom({}, bad));
});

test('the shipped default schedule parses and serves nothing while every row is disabled', async (t) => {
  const read = createAnnouncementReader({ filePath: path.resolve('config/announcements.json'), log: { warn() {} } });
  assert.equal(await read(), null, 'the example rows are all disabled: no notice');
  assert.equal(read.popup(), null);
});
