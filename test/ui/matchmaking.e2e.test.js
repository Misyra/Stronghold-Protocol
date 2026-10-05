// SP_E2E=1 CHROME_PATH=... node --test test/ui/matchmaking.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { startServer } from '../../server/index.js';

const chrome = process.env.CHROME_PATH;
test('same-site matchmaking UI: three cards, cancellation, live count and four humans entering the real match', {
  skip: process.env.SP_E2E !== '1' || !existsSync(chrome || ''), timeout: 120000,
}, async (t) => {
  const { default: puppeteer } = await import('puppeteer-core');
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => server.close());
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  t.after(() => browser.close());
  const players = [], errors = [];
  mkdirSync('test/e2e/out', { recursive: true });
  for (let i = 0; i < 4; i++) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport(i === 2 ? { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true } : { width: 1920, height: 1080 });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(`http://127.0.0.1:${server.port}`)) errors.push(`${r.status()} ${r.url()}`); });
    await page.evaluateOnNewDocument((i) => { localStorage.setItem('sp.name', `匹配博士${i}`); sessionStorage.setItem('sp.entered', '1'); }, i);
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && document.querySelector('.lobby-screen'));
    assert.equal(await page.$$eval('.mode-card', (els) => els.length), 3);
    await page.click('.mode-card:nth-child(3)');
    assert.match(await page.$eval('.create-box .btn', (e) => e.textContent), /开始匹配/);
    await page.click('.diff-card:nth-child(3)');
    players.push(page);
  }
  const [a, b, c, d] = players;
  await a.screenshot({ path: 'test/e2e/out/matchmaking-select.png' });
  await a.click('.create-box .btn');
  await a.waitForFunction(() => globalThis.__SP__.store.get().matchmaking?.players === 1);
  assert.equal(await a.$$eval('.diff-card:disabled', (els) => els.length), 4);
  await b.click('.create-box .btn');
  await a.waitForFunction(() => globalThis.__SP__.store.get().matchmaking?.players === 2);
  await a.click('.matching-panel .btn');
  await a.waitForFunction(() => !globalThis.__SP__.store.get().matchmaking && document.querySelectorAll('.mode-card').length === 3);
  await b.waitForFunction(() => globalThis.__SP__.store.get().matchmaking?.players === 1);
  await a.click('.create-box .btn');
  await c.click('.create-box .btn');
  await a.waitForFunction(() => globalThis.__SP__.store.get().matchmaking?.players === 3);
  await a.waitForFunction(() => document.querySelector('.matching-panel__time').textContent !== '00:00');
  assert.match(await a.$eval('.matching-panel', (el) => el.textContent), /绝境模拟/);
  await a.screenshot({ path: 'test/e2e/out/matchmaking-search.png' });
  await c.waitForFunction(() => globalThis.__SP__.store.get().matchmaking?.players === 3);
  await c.screenshot({ path: 'test/e2e/out/matchmaking-phone.png' });
  assert.equal(await c.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal viewport overflow');
  await d.click('.create-box .btn');
  await Promise.all(players.map((p) => p.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK')));
  const states = await Promise.all(players.map((p) => p.evaluate(() => { const s = globalThis.__SP__.store.get(); return { room: s.room, matching: s.matchmaking }; })));
  assert.equal(new Set(states.map((s) => s.room.code)).size, 1);
  assert.ok(states.every((s) => s.matching === null && s.room.difficulty === 'HARD' && s.room.seats.filter(Boolean).length === 4 && s.room.seats.every((seat) => !seat.isBot)));
  await Promise.all(players.map((p) => p.waitForSelector('.screen.brief', { visible: true })));
  await d.waitForFunction(() => document.getAnimations().every((animation) => animation.effect?.getTiming().iterations === Infinity || animation.playState === 'finished'));
  await d.screenshot({ path: 'test/e2e/out/matchmaking-start.png' });
  assert.deepEqual(errors, []);
});
