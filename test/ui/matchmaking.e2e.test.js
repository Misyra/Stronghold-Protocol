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

test('premade matchmaking UI: checkbox above start, ready gate, cancellation and filling with two solos', {
  skip: process.env.SP_E2E !== '1' || !existsSync(chrome || ''), timeout: 120000,
}, async (t) => {
  const { default: puppeteer } = await import('puppeteer-core');
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => server.close());
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  t.after(() => browser.close());
  const pages = [], errors = [];
  mkdirSync('test/e2e/out', { recursive: true });
  for (let i = 0; i < 4; i++) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument((i) => { localStorage.setItem('sp.name', `组队博士${i}`); sessionStorage.setItem('sp.entered', '1'); }, i);
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && document.querySelector('.lobby-screen'));
    await page.click(`.mode-card:nth-child(${i < 2 ? 2 : 3})`);
    await page.click('.diff-card:nth-child(1)');
    pages.push(page);
  }
  const [host, guest, a, b] = pages;
  await host.click('.create-box .btn');
  await host.waitForSelector('.room-matchmaking input');
  assert.equal(await host.$eval('.room-matchmaking input', (el) => el.checked), false, 'direct start is the default');
  assert.match(await host.$eval('.room-start', (el) => el.textContent), /开始模拟/);
  assert.equal(await host.evaluate(() => document.querySelector('.room-matchmaking').getBoundingClientRect().bottom <= document.querySelector('.room-start').getBoundingClientRect().top), true, 'checkbox is above start');
  const code = await host.evaluate(() => globalThis.__SP__.store.get().room.code);
  await guest.type('.join-row input', code); await guest.click('.join-row .btn--amber');
  await guest.waitForSelector('.room-screen');
  await host.waitForFunction(() => globalThis.__SP__.store.get().room.seats.filter(Boolean).length === 2);
  await host.click('.room-matchmaking input');
  assert.equal(await host.$eval('.room-start', (el) => el.disabled), true);
  await guest.click('.room-bar__right .btn--xl');
  await host.waitForFunction(() => !document.querySelector('.room-start').disabled);
  await host.screenshot({ path: 'test/e2e/out/matchmaking-party-ready.png' });
  for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true }]) {
    await host.setViewport(viewport);
    await host.waitForSelector('.room-matchmaking');
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'premade controls fit viewport');
    const overlap = await host.evaluate(() => {
      const left = document.querySelector('.room-bar__left').getBoundingClientRect();
      const center = document.querySelector('.room-bar__center').getBoundingClientRect();
      const right = document.querySelector('.room-bar__right').getBoundingClientRect();
      return left.right > center.left + 1 || center.right > right.left + 1;
    });
    assert.equal(overlap, false, 'footer controls do not overlap');
  }
  await host.setViewport({ width: 1920, height: 1080 });
  await host.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && document.querySelector('.room-start')?.disabled === false);
  if (!await host.$eval('.room-matchmaking input', (el) => el.checked)) await host.click('.room-matchmaking input');
  await host.click('.room-start');
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => globalThis.__SP__.store.get().matchmaking?.players === 2)));
  assert.equal(await guest.$eval('.room-bar__right .btn--xl', (el) => el.disabled), true);
  assert.equal(await host.$eval('.room-matchmaking input', (el) => el.checked && el.disabled), true);
  assert.equal(await host.$$eval('.dpick__opt:disabled:not(.ailast__opt)', (els) => els.length), 4);
  await host.waitForSelector('.room-recruit-hint', { visible: true, timeout: 20000 });
  await guest.waitForSelector('.room-recruit-hint', { visible: true });
  assert.match(await host.$eval('.room-recruit-hint', (el) => el.textContent), /发布当前同盟的房间号/);
  assert.equal(await host.$eval('.room-recruit-hint a', (el) => el.href), 'https://game.rainya.me/');
  await host.screenshot({ path: 'test/e2e/out/matchmaking-party-recruit.png' });
  await host.click('.room-start');
  await guest.waitForFunction(() => !globalThis.__SP__.store.get().room.matchmaking && !globalThis.__SP__.store.get().matchmaking);
  assert.equal(await guest.evaluate(() => globalThis.__SP__.store.get().room.code), code);
  assert.equal(await host.$('.room-recruit-hint'), null, 'recruit hint clears after cancellation');
  await host.click('.room-matchmaking input');
  assert.equal(await host.$eval('.room-matchmaking input', (el) => el.checked), false, 'unchecking restores direct start');
  assert.match(await host.$eval('.room-start', (el) => el.textContent), /开始模拟/);
  await host.click('.room-matchmaking input');
  await host.click('.room-start'); await a.click('.create-box .btn');
  await host.waitForFunction(() => globalThis.__SP__.store.get().matchmaking?.players === 3);
  await host.screenshot({ path: 'test/e2e/out/matchmaking-party-search.png' });
  await b.click('.create-box .btn');
  await Promise.all(pages.map((p) => p.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK')));
  const states = await Promise.all(pages.map((p) => p.evaluate(() => { const s = globalThis.__SP__.store.get(); return { room: s.room, matching: s.matchmaking }; })));
  assert.ok(states.every((s) => s.room.code === code && !s.matching && !s.room.matchmaking && s.room.seats.every((seat) => seat && !seat.isBot)));
  assert.deepEqual(errors, []);
});
