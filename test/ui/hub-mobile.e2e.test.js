// Source-client regression checks for the hub search clock and phone management controls.
// Run: node --import ./tools/browser-test-setup.mjs --test test/ui/hub-mobile.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { startServer } from '../../server/index.js';

const chrome = process.env.CHROME_PATH;
test('hub search ticks without queue updates; phone controls fit and receive real clicks', {
  skip: process.env.SP_E2E !== '1' || !existsSync(chrome || ''), timeout: 120000,
}, async (t) => {
  const { default: puppeteer } = await import('puppeteer-core');
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, clientBuild: false, workers: 0 });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ['--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('sp.name', '阿米娅');
    sessionStorage.setItem('sp.entered', '1');
  });
  // Exercise the existing share UI without publishing a real room to an external service.
  let submissions = 0;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/portal-room') {
      if (request.method() === 'POST') submissions++;
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(
        request.method() === 'POST' ? { registered: true, remainingMs: 600000 }
          : { enabled: true, mode: 'legacy-http', available: true }) });
    } else void request.continue();
  });
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
  mkdirSync('test/e2e/out', { recursive: true });
  await page.screenshot({ path: 'test/e2e/out/hub-loaded.png' });
  await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && document.querySelector('.lobby-screen'));
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => /暂不全屏/.test(b.textContent))?.click());
  const output = 'test/e2e/out';
  mkdirSync(output, { recursive: true });
  const settle = () => page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState === 'finished'));
  await page.click('.hub-entry--bright');
  await page.waitForSelector('.proto-start:not(:disabled)');
  await page.click('.proto-start');
  await page.waitForSelector('.mf-search__title small');
  const packet = await page.evaluate(() => globalThis.__SP__.store.get().matchmaking.serverNow);
  await page.waitForFunction(() => !/\(0s\)/.test(document.querySelector('.mf-search__title small')?.textContent));
  assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().matchmaking.serverNow), packet, 'clock progresses without another matchmaking packet');
  assert.equal(await page.$eval('.mf-search .recruit-hint a', (el) => el.href), 'https://game.rainya.me/');
  await page.screenshot({ path: `${output}/hub-search-sheet-phone.png` });
  await page.click('.proto-back');
  await page.waitForSelector('.proto', { hidden: true });
  await page.waitForSelector('.hub-searching');
  await page.waitForFunction(() => document.querySelector('.matching-panel__time')?.textContent !== '00:00');
  for (const viewport of [{ width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true },
    { width: 1000, height: 600, isMobile: true, hasTouch: true, isLandscape: true },
    { width: 1920, height: 1080, isMobile: true, hasTouch: true, isLandscape: true }]) {
    await page.setViewport(viewport);
    await page.waitForSelector('.hub-searching');
    await settle();
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.hub-searching').getBoundingClientRect();
      const plates = document.querySelector('.hub-right__plates').getBoundingClientRect();
      const timer = document.querySelector('.matching-panel__time').getBoundingClientRect();
      const title = document.querySelector('.hub-center__title').getBoundingClientRect();
      return { overlap: panel.left < plates.right && panel.right > plates.left && panel.top < plates.bottom && panel.bottom > plates.top,
        titleOverlap: title.width > 0 && panel.left < title.right && panel.right > title.left && panel.top < title.bottom && panel.bottom > title.top,
        timerVisible: timer.left >= 0 && timer.right <= innerWidth && timer.top >= 0 && timer.bottom <= innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.deepEqual(layout, { overlap: false, titleOverlap: false, timerVisible: true, overflow: false }, JSON.stringify(viewport));
    await page.screenshot({ path: `${output}/hub-search-${viewport.width}.png` });
  }
  await page.click('.matching-panel .btn');
  await page.waitForSelector('.hub-searching', { hidden: true });
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true });
  // Open a real alliance through its UI, then physically click the AI button.
  await page.click('.hub-entry-wrap:nth-child(2) .hub-entry');
  await page.waitForSelector('.ally-card--create');
  await page.click('.ally-card--create');
  await page.waitForSelector('.rseat__botadd:not(:disabled)');
  const target = await page.$eval('.rseat__botadd', (el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
  });
  assert.ok(target.width >= 90 && target.height >= 32 && target.hit, JSON.stringify(target));
  await page.click('.rseat__botadd');
  await page.waitForFunction(() => globalThis.__SP__.store.get().room.seats.some((s) => s?.isBot));
  await page.waitForSelector('.room-portal-entry .btn:not(:disabled)');
  assert.ok(await page.$eval('.room-portal-entry .btn', (el) => el.getBoundingClientRect().height >= 32));
  await page.click('.room-portal-entry .btn');
  await page.waitForFunction(() => document.querySelector('.room-portal-entry')?.textContent.includes('已提交到联机站'));
  assert.equal(submissions, 1);
  await settle();
  await page.screenshot({ path: `${output}/hub-room-phone.png` });
  await page.click('.rseat__kick');
  await page.waitForFunction(() => !globalThis.__SP__.store.get().room.seats.some((s) => s?.isBot));
  await page.waitForSelector('.rs-search:not(:disabled)');
  await page.click('.rs-search');
  await page.waitForSelector('.rs-searchpanel .room-portal-entry');
  await page.waitForFunction(() => !/\(0s\)/.test(document.querySelector('.rs-searchpanel .mf-search__title small')?.textContent));
  assert.match(await page.$eval('.rs-searchpanel .room-portal-entry', (el) => el.textContent), /已提交到联机站/);
  await settle();
  await page.screenshot({ path: `${output}/hub-room-search-phone.png` });
  await page.click('.rs-searchpanel .mf-stop');
  await page.waitForSelector('.rs-searchpanel', { hidden: true });
  await page.evaluate(async () => {
    const main = document.querySelector('script[type="module"][src*="main"]');
    const { openResources } = await import(new URL('./ui/resourcePanel.js', main.src).href);
    openResources();
  });
  await page.waitForSelector('.resource-modal');
  const resources = await page.$eval('.resource-modal', (el) => {
    const r = el.getBoundingClientRect(), body = el.querySelector('.modal__body');
    return { width: r.width, height: r.height, x: r.x, y: r.y, overflow: el.scrollWidth > el.clientWidth + 1,
      voiceHeight: el.querySelector('.resource-voice-tabs button').getBoundingClientRect().height,
      scrollable: getComputedStyle(body).overflowY === 'auto' };
  });
  assert.ok(resources.width <= 600 && resources.height <= 390 && resources.x >= 0 && resources.y >= 0, JSON.stringify(resources));
  assert.ok(!resources.overflow && resources.voiceHeight <= 40 && resources.voiceHeight >= 24 && resources.scrollable, JSON.stringify(resources));
  await page.screenshot({ path: `${output}/hub-resources-phone.png` });
  await page.click('.resource-archive__help summary');
  assert.ok(await page.$eval('.resource-modal .modal__actions', (el) => el.getBoundingClientRect().bottom <= innerHeight));
  assert.deepEqual(errors, []);
});
