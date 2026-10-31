// Opt-in real-browser coverage: SP_E2E=1 CHROME_PATH=... node --test test/ui/announcement.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { Client, hasChrome, sleep } from '../e2e/client.mjs';

test('server announcement: shown from the title screen, hot edits, dismissal across reload, plain text, expiration and withdrawal', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90_000,
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sp-announcement-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'announcement.json');
  const notice = { enabled: true, title: '维护公告', text: '服务器将于 17:00 维护，请提前结束模拟。',
    expiresAt: new Date(Date.now() + 120_000).toISOString() };
  await writeFile(filePath, JSON.stringify(notice));
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementSource: 'file', announcementFile: filePath });
  t.after(() => srv.close());
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, srv.url, 'announcement', { prefix: 'announcement' });
  t.after(() => c.close());
  await c.open();
  await c.page.waitForSelector('.announcement', { timeout: 10_000 });
  assert.equal(await c.page.$eval('.announcement__text', (el) => el.textContent), notice.text, 'shown on the title screen');
  assert.equal(await c.page.$('.announcement__title'), null, 'strip shows body text only');
  await c.page.waitForSelector('.fullscreen-prompt');
  await c.click('.fullscreen-prompt button', '暂不全屏');
  await c.enter('Bob');
  await c.click('.hub-entry', '独立模拟');
  await c.click('.pcard', '标准模拟');
  await c.click('.proto-start', '开始模拟');
  await c.waitFor((s) => !!s.room, 'solo room');
  if (!(await c.st()).phase) await c.click('.rs-go', '开始模拟');
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'in-match briefing');
  await c.page.waitForSelector('.announcement');
  assert.equal(await c.page.$eval('.announcement__text', (el) => el.textContent), notice.text);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'draft');
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  await c.waitFor((s) => s.phase === 'PREP', 'first prep');
  // Both entry points read the same current notice, including after dismissing its strip.
  await c.page.click('.announcement__content');
  await c.page.waitForSelector('.announcement-detail');
  assert.equal(await c.page.$eval('.announcement-detail__text', el => el.textContent), notice.text);
  assert.equal(await c.page.$('.announcement-detail__title'), null, 'the detail does not repeat the notice title');
  assert.equal((await c.page.$eval('.announcement-detail', el => el.textContent)).includes(notice.title), false,
    'the notice title stays out of the detail body (the modal header is 服务器公告, not the notice title)');
  assert.equal(await c.page.$$eval('.announcement-detail button', els => els.length), 1, 'one shared close button');
  await c.page.click('.announcement-detail .utility-modal__close');
  await c.page.waitForSelector('.announcement-detail', { hidden: true });
  await c.shot('desktop');
  await c.page.setViewport({ width: 844, height: 390 });
  await c.page.waitForFunction(() => {
    const el = document.querySelector('.announcement');
    const rect = el?.getBoundingClientRect();
    return rect && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  await c.shot('mobile');
  await c.page.$eval('.announcement > .btn', (button) => button.focus());
  await c.page.keyboard.press('Space');
  await c.page.waitForSelector('.announcement', { hidden: true });
  assert.equal((await c.st()).ready, false, 'Space on close must not also ready the player');
  await c.page.click('.gm__announcement');
  await c.page.waitForSelector('.announcement-detail');
  assert.equal(await c.page.$eval('.announcement-detail__text', el => el.textContent), notice.text);
  assert.equal(await c.page.$$eval('.announcement-detail button', els => els.length), 1, 'one close button on mobile too');
  await c.page.click('.announcement-detail .utility-modal__close');
  // Resource preloading continues in the background; the restored match below is the readiness signal.
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await c.page.waitForFunction(() => globalThis.__SP__?.store.get().match.public?.phase === 'PREP');
  await sleep(200);
  assert.equal(await c.page.$('.announcement'), null, 'the dismissed revision stays dismissed after reload');
  const refresh = async (value) => {
    await writeFile(filePath, JSON.stringify(value));
    await sleep(1100); // Let the shared file cache expire; returning to the tab triggers an immediate check.
    await c.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  };
  await refresh({ ...notice, displayMode: 'visit', text: '每次进入显示' });
  await c.page.waitForSelector('.announcement');
  await c.page.$eval('.announcement > .btn', button => button.click());
  await c.page.waitForSelector('.announcement', { hidden: true });
  await c.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(300);
  assert.equal(await c.page.$('.announcement'), null, 'regular checks do not reopen visit notices');
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await c.page.waitForFunction(() => globalThis.__SP__?.store.get().match.public?.phase === 'PREP');
  await c.page.waitForSelector('.announcement');
  assert.equal(await c.page.$eval('.announcement__text', el => el.textContent), '每次进入显示');
  await c.page.$eval('.announcement > .btn', button => button.click());
  await c.page.waitForSelector('.announcement', { hidden: true });
  await refresh({ ...notice, text: '<img src=x onerror="window.noticeInjected=true">维护延后' });
  await c.page.waitForSelector('.announcement');
  assert.equal(await c.page.$eval('.announcement__text', (el) => el.children.length), 0, 'HTML remains literal text');
  assert.equal(await c.page.evaluate(() => !!window.noticeInjected), false);
  await refresh({ ...notice, expiresAt: new Date(Date.now() + 4500).toISOString() });
  await c.page.waitForFunction(() => document.querySelector('.announcement__text')?.textContent === '服务器将于 17:00 维护，请提前结束模拟。');
  await c.page.waitForSelector('.announcement', { hidden: true, timeout: 6500 });
  // Reload can reopen the optional fullscreen prompt; close it before testing pointer interaction.
  await c.page.waitForSelector('.fullscreen-prompt');
  await c.click('.fullscreen-prompt button', '暂不全屏');
  await refresh({ ...notice, text: '很长的公告内容 '.repeat(100) + '\n第二行公告' });
  await c.page.waitForSelector('.announcement__track.is-scrolling');
  const rect = await c.page.$eval('.announcement', el => ({ height: el.getBoundingClientRect().height }));
  assert.ok(rect.height < 70, 'long notices stay in one compact row');

  await c.page.click('.announcement__content');
  await c.page.waitForSelector('.announcement-detail');
  assert.ok((await c.page.$eval('.announcement-detail__text', el => el.textContent)).includes('\n第二行公告'));
  await c.page.click('.announcement-detail .utility-modal__close');
  await refresh({ ...notice, text: '第二条公告' });
  await c.page.waitForSelector('.announcement');
  await refresh({ enabled: false });
  await c.page.waitForSelector('.announcement', { hidden: true });
  await c.page.click('.gm__announcement');
  await c.page.waitForSelector('.announcement-detail');
  assert.ok((await c.page.$eval('.announcement-detail', el => el.textContent)).includes('当前暂无公告'));
  await c.page.click('.announcement-detail .utility-modal__close');
  assert.equal((await c.st()).phase, 'PREP', 'publishing/expiry does not end the running match');
  // External fonts are optional and unavailable in network-restricted test environments.
  const problems = c.problems.filter(p => !(p.includes('https://fonts.googleapis.com/') && p.includes('net::ERR_NETWORK_ACCESS_DENIED')));
  assert.deepEqual(problems, [], 'no application browser errors');
});
