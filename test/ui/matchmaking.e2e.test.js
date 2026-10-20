// SP_E2E=1 SP_IP_SESSION_LIMIT=off CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe' \
//   node --import ./test/helpers/test-setup.js --test test/ui/matchmaking.e2e.test.js
//
// The alliance queue as a player meets it (0.3.1: server/matchmaking.js offers, the clients confirm).
// Four solo humans pick the same difficulty in the hub, see the live count, and after the fourth joins every
// panel turns into 队友已集结 / 确认入场; accepting on all four commits one room without bots, and the briefing's
// 准备就绪 moves the room on to the strategy draft. The panel is also checked at phone size (844×390), where the
// offer card must not push 停止搜寻 out of the viewport.
//
// The premade-party UI used to be a second test here. The hub's alliance screen (public/js/screens/lobby.js
// ProtocolSelect) replaced the old three mode cards and the room's 同盟匹配 checkbox (.room-matchmaking,
// .room-start, .room-recruit-hint) that test drove, so its party flow (party of two + two solos) is covered at the
// protocol level by test/matchmaking-party.test.js instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { startServer } from '../../server/index.js';

const chrome = process.env.CHROME_PATH;
test('hub queue UI: four solos search, see the count, confirm the offer and start one bot-free match', {
  skip: process.env.SP_E2E !== '1' || !existsSync(chrome || ''), timeout: 180000,
}, async (t) => {
  const { default: puppeteer } = await import('puppeteer-core');
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => server.close());
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  t.after(() => browser.close());
  const players = [], errors = [];
  mkdirSync('test/e2e/out', { recursive: true });
  // Hidden tabs stop requestAnimationFrame, so every store read below polls on a timer instead of rAF.
  const poll = (page, fn, arg) => page.waitForFunction(fn, { timeout: 60000, polling: 100 }, arg);
  for (let i = 0; i < 4; i++) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport(i === 2 ? { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true } : { width: 1600, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await page.evaluateOnNewDocument((i) => { localStorage.setItem('sp.name', `匹配博士${i}`); sessionStorage.setItem('sp.entered', '1'); }, i);
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
    await poll(page, () => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen'));
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '暂不全屏'); if (b) b.click(); });
    players.push(page);
  }
  const [a, b, c, d] = players;
  // 同盟匹配 in the hub's entry list opens the alliance screen; the third card is 绝境模拟 (HARD).
  for (const page of players) {
    await page.evaluate(() => {
      const entry = [...document.querySelectorAll('.hub-entries__row button')].find((el) => el.textContent.includes('同盟匹配'));
      if (!entry) throw new Error('the hub has no 同盟匹配 entry');
      entry.click();
    });
    await page.waitForSelector('.proto .proto-list', { timeout: 15000 });
    await page.evaluate(() => document.querySelectorAll('.pcard')[2].click());
  }
  assert.match(await a.$eval('.proto-start', (el) => el.textContent), /开始搜寻/);
  await a.screenshot({ path: 'test/e2e/out/matchmaking-select.png' });

  await a.evaluate(() => document.querySelector('.proto-start').click());
  await poll(a, () => globalThis.__SP__.store.get().matchmaking?.players === 1);
  assert.match(await a.$eval('.proto-side', (el) => el.textContent), /绝境模拟/);
  await b.evaluate(() => document.querySelector('.proto-start').click());
  await poll(a, () => globalThis.__SP__.store.get().matchmaking?.players === 2);
  // 停止搜寻 drops this player's ticket and brings the cards back.
  await a.evaluate(() => document.querySelector('.mf-stop').click());
  await poll(a, () => !globalThis.__SP__.store.get().matchmaking && document.querySelectorAll('.pcard').length > 0);
  await poll(b, () => globalThis.__SP__.store.get().matchmaking?.players === 1);
  await a.evaluate(() => document.querySelector('.proto-start').click());
  await c.evaluate(() => document.querySelector('.proto-start').click());
  await poll(a, () => globalThis.__SP__.store.get().matchmaking?.players === 3);
  // The phone layout keeps 停止搜寻 inside the viewport while three of four seats are filled.
  const phone = await c.evaluate(() => {
    const stop = document.querySelector('.mf-stop').getBoundingClientRect();
    const side = document.querySelector('.proto-side').getBoundingClientRect();
    return { bottom: stop.bottom, innerHeight, side: side.bottom, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.equal(phone.overflow, false, 'no horizontal viewport overflow on the phone');
  assert.ok(phone.bottom <= phone.innerHeight, `停止搜寻 stays inside the ${phone.innerHeight}px viewport (bottom ${phone.bottom})`);
  await c.screenshot({ path: 'test/e2e/out/matchmaking-phone.png' });

  await d.evaluate(() => document.querySelector('.proto-start').click());
  await Promise.all(players.map((p) => poll(p, () => !!globalThis.__SP__.store.get().matchmaking?.offerId && !!document.querySelector('.proto-offer .btn'))));
  assert.match(await a.$eval('.proto-offer', (el) => el.textContent), /队友已集结/);
  assert.deepEqual(await Promise.all(players.map((p) => p.evaluate(() => globalThis.__SP__.store.get().matchmaking.players))), [4, 4, 4, 4]);
  await a.screenshot({ path: 'test/e2e/out/matchmaking-offer.png' });
  await c.screenshot({ path: 'test/e2e/out/matchmaking-offer-phone.png' });
  const phoneOffer = await c.evaluate(() => {
    const stop = document.querySelector('.mf-stop').getBoundingClientRect();
    const progress = document.querySelector('.matchmaking-offer__progress');
    const button = document.querySelector('.proto-offer .btn');
    return { bottom: stop.bottom, innerHeight, progressVisible: getComputedStyle(progress).display !== 'none',
      progressBottom: progress.getBoundingClientRect().bottom, buttonTop: button.getBoundingClientRect().top,
      buttonFont: parseFloat(getComputedStyle(button).fontSize), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.ok(phoneOffer.bottom <= phoneOffer.innerHeight, 'the offer card does not push 停止搜寻 off the phone');
  assert.ok(phoneOffer.progressVisible, 'confirmation count and deadline remain visible on the phone');
  assert.ok(phoneOffer.progressBottom <= phoneOffer.buttonTop, 'progress does not overlap the confirmation button');
  assert.ok(phoneOffer.buttonFont >= 13, 'confirmation button remains readable');
  assert.equal(phoneOffer.overflow, false, 'the offer does not overflow horizontally');

  // Accepting must keep the offer visible while other humans decide, with live progress.
  await a.evaluate(() => document.querySelector('.proto-offer .btn').click());
  await poll(a, () => globalThis.__SP__.store.get().matchmaking?.accepted && document.querySelector('.proto-offer .btn')?.disabled);
  assert.match(await a.$eval('.proto-offer', (el) => el.textContent), /已确认 1\/4.*剩余.*秒/);
  assert.match(await a.$eval('.proto-offer .btn', (el) => el.textContent), /已确认，等待队友/);
  assert.match(await a.$eval('.mf-search__title', (el) => el.textContent), /等待全员确认/);
  await b.evaluate(() => document.querySelector('.proto-offer .btn').click());
  await poll(a, () => globalThis.__SP__.store.get().matchmaking?.acceptedCount === 2);
  assert.match(await a.$eval('.proto-offer', (el) => el.textContent), /已确认 2\/4/);
  assert.equal(await a.evaluate(() => globalThis.__SP__.store.get().room?.inMatch === true), false, 'no entry before everyone accepts');
  await c.screenshot({ path: 'test/e2e/out/matchmaking-confirming-phone.png' });
  await Promise.all([c, d].map((p) => p.evaluate(() => document.querySelector('.proto-offer .btn').click())));
  await Promise.all(players.map((p) => poll(p, () => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK')));
  const states = await Promise.all(players.map((p) => p.evaluate(() => { const s = globalThis.__SP__.store.get(); return { code: s.room?.code, matching: s.matchmaking, seats: s.room?.seats, difficulty: s.room?.difficulty }; })));
  assert.equal(new Set(states.map((s) => s.code)).size, 1, 'one room for the cohort');
  assert.ok(states.every((s) => s.matching === null && s.difficulty === 'HARD' && s.seats.filter(Boolean).length === 4 && s.seats.every((seat) => !seat.isBot)), 'four humans, no bots, no leftover ticket');
  await Promise.all(players.map((p) => p.waitForSelector('.screen.brief', { visible: true })));
  await d.waitForFunction(() => document.getAnimations().every((animation) => animation.effect?.getTiming().iterations === Infinity || animation.playState === 'finished'));
  await d.screenshot({ path: 'test/e2e/out/matchmaking-start.png' });

  // 准备就绪 in the briefing: four ready humans leave INFO_CHECK for the strategy draft.
  await Promise.all(players.map((p) => p.evaluate(() => {
    const ready = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '准备就绪');
    if (!ready) throw new Error('the briefing has no 准备就绪 button');
    ready.click();
  })));
  await Promise.all(players.map((p) => poll(p, () => { const phase = globalThis.__SP__.store.get().match.public?.phase; return phase && phase !== 'INFO_CHECK'; })));
  assert.deepEqual(errors, []);
});
