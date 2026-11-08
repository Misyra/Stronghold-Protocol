// SP_E2E=1 CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome node --test test/ui/match-chrome-feedback.e2e.test.js
// The real Game screen on the mock server: feedback #60 (本局信息 closes on an outside press), fork 913e995a.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

describe('match chrome feedback', { skip: !ENABLED && 'set SP_E2E=1 with Chrome' }, () => {
  let srv, browser;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  const open = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`${srv.url}/dev/game-mock.html?phase=PREP&render=fallback&shot=1`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="check-player"]');
    return page;
  };
  const drawer = (page) => page.$('.edrawer');

  test('#60 本局信息 closes on a press outside it, stays on one inside it, and its 🔍 still toggles it', async () => {
    const page = await open();
    try {
      await page.click('[data-testid="check-player"]');
      await page.waitForSelector('.edrawer');
      await page.click('.edrawer .ihead');
      assert.ok(await drawer(page), 'a press inside keeps it');
      await page.mouse.click(1000, 300); // the field, right of the dialog
      await page.waitForFunction(() => !document.querySelector('.edrawer'));

      await page.click('[data-testid="check-player"]');
      await page.waitForSelector('.edrawer');
      await page.click('[data-testid="check-player"]');
      await page.waitForFunction(() => !document.querySelector('.edrawer'));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await drawer(page), null, 'the 🔍 closes it without reopening it');
    } finally { await page.close(); }
  });
});
