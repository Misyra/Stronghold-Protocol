// The schedule reader: one configuration document serves its scroll and popup notices independently
// (server/announcement.js, shared/announcements.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnnouncementReader } from '../server/announcement.js';

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
  const read = createAnnouncementReader({ filePath: file, log: quiet, now: () => clock, pollMs: 0 });
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

test('an invalid schedule never publishes half of it - it clears, as this fork documents', async (t) => {
  let clock = BASE;
  const file = await fixture(t, { announcements: [row()] });
  const read = createAnnouncementReader({ filePath: file, log: quiet, now: () => clock, pollMs: 0 });
  assert.equal((await read()).id, 'maintenance');
  await writeFile(file, JSON.stringify({ announcements: [row({ id: 'broken', text: '' })] }));
  clock = BASE + 1;
  assert.equal(await read(), null, 'no partial schedule and no stale deadline on screen');
});
