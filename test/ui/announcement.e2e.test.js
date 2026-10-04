// Opt-in real-browser coverage: SP_E2E=1 CHROME_PATH=... node --test test/ui/announcement.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { Client, hasChrome, sleep } from '../e2e/client.mjs';

test('in-match announcement: hot edits, dismissal across reload, plain text, expiration and withdrawal', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90_000,
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sp-announcement-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'announcement.json');
  const notice = { enabled: true, title: '维护公告', text: '服务器将于 17:00 维护，请提前结束模拟。',
    expiresAt: new Date(Date.now() + 120_000).toISOString() };
  await writeFile(filePath, JSON.stringify(notice));
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementFile: filePath });
  t.after(() => srv.close());
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, srv.url, 'announcement', { prefix: 'announcement' });
  t.after(() => c.close());
  await c.open();
  assert.equal(await c.page.$('.announcement'), null, 'not shown on the title screen');
  await c.enter('公告测试');
  await c.click('.mode-card', '独立模拟');
  await c.click('.diff-card', '标准模拟');
  await c.click('.create-box button', '开始独立模拟');
  await c.waitFor((s) => !!s.room, 'solo room');
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟');
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'in-match briefing');
  await c.page.waitForSelector('.announcement');
  assert.equal(await c.page.$eval('.announcement__text', (el) => el.textContent), notice.text);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'draft');
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  await c.waitFor((s) => s.phase === 'PREP', 'first prep');
  await c.shot('desktop');
  await c.page.setViewport({ width: 844, height: 390 });
  await c.page.waitForFunction(() => {
    const el = document.querySelector('.announcement');
    const rect = el?.getBoundingClientRect();
    return rect && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  await c.shot('mobile');
  await c.page.$eval('.announcement button', (button) => button.focus());
  await c.page.keyboard.press('Space');
  await c.page.waitForSelector('.announcement', { hidden: true });
  assert.equal((await c.st()).ready, false, 'Space on close must not also ready the player');
  await c.page.reload({ waitUntil: 'networkidle0' });
  await c.page.waitForFunction(() => globalThis.__SP__?.store.get().match.public?.phase === 'PREP');
  await sleep(200);
  assert.equal(await c.page.$('.announcement'), null, 'the dismissed revision stays dismissed after reload');
  const refresh = async (value) => {
    await writeFile(filePath, JSON.stringify(value));
    await sleep(1100); // Let the shared file cache expire; returning to the tab triggers an immediate check.
    await c.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  };
  await refresh({ ...notice, text: '<img src=x onerror="window.noticeInjected=true">维护延后' });
  await c.page.waitForSelector('.announcement');
  assert.equal(await c.page.$eval('.announcement__text', (el) => el.children.length), 0, 'HTML remains literal text');
  assert.equal(await c.page.evaluate(() => !!window.noticeInjected), false);
  await refresh({ ...notice, expiresAt: new Date(Date.now() + 4500).toISOString() });
  await c.page.waitForFunction(() => document.querySelector('.announcement__text')?.textContent === '服务器将于 17:00 维护，请提前结束模拟。');
  await c.page.waitForSelector('.announcement', { hidden: true, timeout: 6500 });
  await refresh({ ...notice, text: '第二条公告' });
  await c.page.waitForSelector('.announcement');
  await refresh({ enabled: false });
  await c.page.waitForSelector('.announcement', { hidden: true });
  assert.equal((await c.st()).phase, 'PREP', 'publishing/expiry does not end the running match');
  assert.deepEqual(c.problems, [], 'no browser errors');
});
