// Room votes in a real browser (needs Chrome, opt-in with SP_E2E=1): the AI strategy designation (room.setBotBand,
// 移植自用户分支), the setup reroll vote and the kick vote for a seat the AI has taken over. Three players, driven
// through the client — the unit tests pin the rules, this one pins that the panels exist and that their buttons reach
// the server. (fork 原稿的「首选保留」一段依赖 fork 的 draft 预留细节, 本仓的指定策略由 room.setBotBand 段覆盖.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startServer } from '../../server/index.js';

const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const enabled = process.env.SP_E2E === '1' && existsSync(chrome);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a room of three: the reroll vote and the kick vote', {
  skip: enabled ? false : 'set SP_E2E=1 (and CHROME_PATH when Chrome is elsewhere)', timeout: 300000,
}, async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, quiet: true });
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--no-sandbox'], protocolTimeout: 60000 });
  const errors = [];
  const text = (page, sel) => page.$eval(sel, (e) => (e.innerText || '').trim().replace(/\s+/g, ' ')).catch(() => null);
  const enter = async (page, url, name) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-screen .title-login input', { timeout: 30000 });
    await page.$eval('.title-login input', (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, name);
    await sleep(400);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.title-login button')].find((x) => !x.disabled && (x.innerText || '').trim());
      if (b) b.click();
    });
    await page.waitForSelector('.lobby-screen', { timeout: 30000 });
  };
  const clickText = async (page, needle, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = await page.evaluate((text) => {
        const el = [...document.querySelectorAll('button, a, [role="button"]')]
          .find((x) => (x.innerText || '').trim().includes(text) && !x.disabled);
        if (!el) return false;
        el.click();
        return true;
      }, needle);
      if (hit) return;
      await sleep(150);
    }
    throw new Error(`nothing to click: ${needle}`);
  };
  try {
    const host = await browser.newPage();
    await host.setViewport({ width: 1440, height: 900 });
    host.on('pageerror', (e) => errors.push('host: ' + e.message));
    await enter(host, srv.url, 'HostProbe');
    await clickText(host, '同盟模拟');
    await sleep(500);
    await clickText(host, '创建同盟');
    await host.waitForSelector('.rseat', { timeout: 20000 });
    const code = await host.$eval('.rs-key__code', (e) => e.textContent.trim());
    // AI 指定策略 (room.setBotBand, 移植自用户分支): the host adds an AI seat and names the strategy it takes in the draft
    await host.$eval('.rseat__add', (b) => b.click());
    await host.waitForSelector('.rseat__band.is-edit', { timeout: 20000 });
    await host.$eval('.rseat__band.is-edit', (b) => b.click());
    await host.waitForSelector('.botband__grid', { timeout: 15000 });
    const bandName = await host.$eval('.botband__grid button:nth-child(2) .botband__name', (e) => e.textContent.trim());
    await host.evaluate(() => document.querySelectorAll('.botband__grid button')[1].click());
    await sleep(700);
    const room0 = [...srv.lobby.rooms.values()][0];
    const botSeat = room0.seats.find((s) => s && s.isBot);
    assert.ok(botSeat && typeof botSeat.band === 'string', 'room.setBotBand reaches the seat');
    assert.equal(await text(host, '.rseat__band.is-set'), bandName, 'the seat shows the strategy by name, not by id');
    const guest = await browser.newPage();
    await guest.setViewport({ width: 1280, height: 800 });
    guest.on('pageerror', (e) => errors.push('guest: ' + e.message));
    await enter(guest, `${srv.url}/?room=${encodeURIComponent(code)}`, 'GuestProbe');
    await guest.waitForSelector('.rseat', { timeout: 25000 });
    const third = await browser.newPage();
    await third.setViewport({ width: 1280, height: 800 });
    third.on('pageerror', (e) => errors.push('third: ' + e.message));
    await enter(third, `${srv.url}/?room=${encodeURIComponent(code)}`, 'ThirdProbe');
    await third.waitForSelector('.rseat', { timeout: 25000 });
    await sleep(600);
    const room = [...srv.lobby.rooms.values()][0];
    assert.equal(room.seats.filter((s) => s && !s.isBot).length, 3, 'three humans in the alliance');
    await clickText(guest, '准备就绪');
    await clickText(third, '准备就绪');
    await sleep(600);
    await clickText(host, '开始模拟');
    await host.waitForSelector('.brief', { timeout: 30000 });
    // 重刷本局: three humans, unanimous — the proposer counts as yes
    await clickText(host, '重刷本局');
    await sleep(900);
    assert.match(await text(host, '.brief-reroll__text'), /1\/3/, 'the proposer counts as yes: 1/3');
    assert.match(await text(guest, '.brief-reroll__text'), /1\/3/, 'the other player sees the same vote');
    assert.equal((await guest.$$eval('.brief-reroll__players span', (els) => els.length)), 3, 'every voter is listed');
    await clickText(guest, '同意重刷');
    await sleep(1200);
    assert.match(await text(host, '.brief-reroll__text'), /2\/3/, '2/3 does not reroll yet');
    assert.ok(!room.match.setupRevision, 'nothing is rerolled below the threshold');
    await clickText(third, '同意重刷');
    await sleep(1400);
    assert.equal(room.match.setupRevision, 1, '3/3 rerolls the match');
    // the strategy draft: both humans pick, the AI seat takes its own strategy
    await host.waitForSelector('.screen.draft', { timeout: 30000 });
    await guest.waitForSelector('.screen.draft', { timeout: 30000 });
    // AI 指定策略 (room.setBotBand): the designated strategy is held for the AI seat — marked, not selectable by a human
    const held = await host.$$eval('.screen.draft .dband', (els) => els
      .filter((e) => /AI 指定/.test(e.innerText || ''))
      .map((e) => e.getAttribute('aria-disabled')));
    assert.ok(held.length && held.every((v) => v === 'true'), `the designated strategy is reserved (${held.length} marked)`);
    const pick = async (page, name) => {
      for (let i = 0; i < 140; i++) {
        const done = await page.evaluate((n) => {
          const confirm = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('确认选择'));
          if (confirm && !confirm.disabled) { confirm.click(); return true; }
          const band = [...document.querySelectorAll('.screen.draft .dband')]
            .find((x) => (x.innerText || '').includes(n) && x.getAttribute('aria-disabled') !== 'true');
          if (band && !band.className.includes('is-sel')) band.click();
          return false;
        }, name);
        if (done) return true;
        await sleep(400);
      }
      return false;
    };
    assert.deepEqual(await Promise.all([pick(host, '阿米娅'), pick(guest, '杜遥夜')]), [true, true], 'both humans pick a strategy');
    await host.waitForSelector('.gm__bonds', { timeout: 60000 });
    // 投票移出: the seat an AI took over — the UI path needs connected=false + autoplay + offlineAutoplay, which a real
    // run only reaches after two prep rounds, so the three fields are set here and everything after that is the client.
    const match = room.match;
    const psList = match.humans();
    const hostPs = psList.find((p) => p.connected);
    const guestPs = psList.find((p) => p !== hostPs);
    guestPs.connected = false;
    guestPs.autoplay = true;
    guestPs.offlineAutoplay = true;
    guestPs.offlineRounds = 2;
    srv.lobby.broadcastState(room);
    let bar = null;
    for (let i = 0; i < 30 && !bar; i++) { await sleep(400); bar = await text(host, '.kick-bar'); }
    assert.match(bar || '', /投票移出/, 'the offlined seat shows in the kick bar');
    await clickText(host, '投票移出');
    await sleep(600);
    await clickText(host, '发起投票');
    await sleep(1000);
    const notice = await text(host, '.team-kick');
    assert.match(notice || '', /同意 1\/2/, 'the proposer counts as yes and waits for the other voter');
    assert.match(await text(third, '.team-kick') || '', /投票移出/, 'the other voter sees the vote');
    assert.equal(match.kickVote.need, 2, 'half of the two voters, rounded down, plus one');
    await clickText(third, '同意');
    await sleep(1800);
    assert.equal(match.humans().some((p) => p.playerId === guestPs.playerId), false, 'the vote leaves like a 中途退出');
    assert.deepEqual(errors, [], 'no script errors');
  } finally {
    try { await browser.close(); } finally { await srv.close(); }
  }
});
