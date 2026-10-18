// The merged reader: one configuration file may hold the legacy single notice or the multi-notice schedule, and the
// schedule's popup rides the same read as its scroll notice (server/announcement.js, shared/announcements.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnnouncementReader, parseConfiguration } from '../server/announcement.js';

const quiet = { info() {}, warn() {}, error() {} };
const BASE = Date.parse('2026-10-05T12:00:00+08:00');
const row = (overrides = {}) => ({ id: 'maintenance', text: '维护通知', startAt: new Date(BASE).toISOString(), durationSeconds: 60, level: 'info', enabled: true, ...overrides });

async function fixture(t, doc) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-announcement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'announcement.json');
  if (doc !== undefined) await writeFile(file, JSON.stringify(doc));
  return file;
}

test('a schedule document serves its scroll and popup independently, with severity order and absolute expiry', async (t) => {
  let clock = BASE;
  const file = await fixture(t, { announcements: [
    row(),
    row({ id: 'urgent', level: 'urgent', durationSeconds: 10 }),
    row({ id: 'popup', type: 'popup', text: '# 更新\n内容', format: 'markdown', autoPopup: true, durationSeconds: 30 }),
  ] });
  const read = createAnnouncementReader({ filePath: file, log: quiet, now: () => clock, cacheMs: 0 });
  assert.equal((await read()).id, 'urgent', 'the most severe live notice wins');
  assert.equal(read.popup().id, 'popup');
  assert.equal(read.popup().format, 'markdown');
  clock = BASE + 10_000;
  assert.equal((await read()).id, 'maintenance');
  clock = BASE + 30_000;
  assert.equal(read.popup(), null, 'the popup expired on its own schedule');
  clock = BASE + 60_000;
  assert.equal(await read(), null);
});

test('the legacy single notice keeps working, including its dismissal mode', async (t) => {
  const file = await fixture(t, { enabled: true, title: '维护公告', text: '今晚 23:00 停机',
    expiresAt: new Date(BASE + 600_000).toISOString(), displayMode: 'visit' });
  const read = createAnnouncementReader({ filePath: file, log: quiet, now: () => BASE, cacheMs: 0 });
  const notice = await read();
  assert.equal(notice.text, '今晚 23:00 停机');
  assert.equal(notice.displayMode, 'visit');
  assert.equal(read.popup(), null, 'a legacy document has no popup');
});

test('an invalid schedule never publishes half of it - it clears, as this fork documents', async (t) => {
  let clock = BASE;
  const file = await fixture(t, { announcements: [row()] });
  const read = createAnnouncementReader({ filePath: file, log: quiet, now: () => clock, cacheMs: 0 });
  assert.equal((await read()).id, 'maintenance');
  await writeFile(file, JSON.stringify({ announcements: [row({ id: 'broken', text: '' })] }));
  clock = BASE + 1;
  assert.equal(await read(), null, 'no partial schedule and no stale deadline on screen');
});

test('a missing managed file falls back to the schedule shipped with the repo', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-announcement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const managed = path.join(dir, 'announcement.json');
  const shipped = path.join(dir, 'config.json');
  await writeFile(shipped, JSON.stringify({ announcements: [row({ id: 'shipped', text: '随仓库发布的默认公告' })] }));
  const read = createAnnouncementReader({ filePath: managed, fallbackFilePath: shipped, log: quiet, now: () => BASE, cacheMs: 0 });
  assert.equal((await read()).id, 'shipped');
  // once the managed file exists it wins, with no fallback merging
  await writeFile(managed, JSON.stringify({ announcements: [row({ id: 'managed', text: '面板写的公告' })] }));
  assert.equal((await read()).id, 'managed');
});

test('parseConfiguration accepts both shapes and rejects anything else', () => {
  assert.equal(parseConfiguration({ announcements: [] }).legacy, null);
  assert.equal(parseConfiguration({ announcements: [] }).rows.length, 0);
  assert.throws(() => parseConfiguration({ announcements: {}, enabled: true }));
  assert.throws(() => parseConfiguration(null));
});
