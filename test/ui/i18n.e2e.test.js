// Browser check of the language switch (puppeteer-core + system Chrome; opt-in: SP_E2E=1, ~20 s):
//
//   SP_E2E=1 node --test test/ui/i18n.e2e.test.js
//
// The title screen opens in Chinese; 中文 | English → English in place (no reload): the title, the start button, the
// connection line, <html lang>, the tab title; the choice is kept across a reload (localStorage sp.pref.lang) and the
// game-data overlay (data/i18n/en.json) is applied; `?lang=zh` switches back and leaves the address bar. No console /
// page / request errors. docs/I18N.md.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CHROME, hasChrome, sleep } from '../e2e/client.mjs';
import { NAME_MAX_LEN } from '../../shared/constants.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();

describe('language switch on the title screen', { skip: !ENABLED && 'set SP_E2E=1 (Chrome)' }, () => {
  let srv;
  let browser;
  let base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());

  test('中文 by default; English in place, kept across a reload; ?lang=zh back to Chinese', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400 && !/fonts\.(googleapis|gstatic)/.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
    await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.title-screen [data-testid="lang-toggle"]');
    assert.equal(await text(page, '.title-cn'), '卫戍协议：盟约');
    assert.equal(await text(page, '.title-login .btn--primary'), '开始');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');

    await page.click('[data-testid="lang-toggle"] button[data-lang="en"]');
    await page.waitForFunction(() => document.querySelector('.title-cn')?.textContent.includes('Stronghold Protocol'), { timeout: 8000 });
    assert.equal(await text(page, '.title-cn'), 'Stronghold Protocol: Alliance');
    assert.equal(await text(page, '.title-login .btn--primary'), 'Start');
    assert.match(await text(page, '.title-tag'), /^Allocate Funds and Operators/);
    assert.match(await text(page, '.title-conn'), /Connect|Ready to connect/);
    assert.equal(await page.$eval('.title-login input', (el) => el.placeholder), `Callsign (max ${NAME_MAX_LEN} chars)`);
    assert.deepEqual(await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.title, pref: localStorage.getItem('sp.pref.lang') })),
      { lang: 'en', title: 'Stronghold Protocol: Alliance · Web Simulation', pref: '"en"' });
    // the game texts follow (data/i18n/en.json applied by data.js)
    await page.waitForFunction(() => globalThis.__SP__?.data?.locale() === 'en', { timeout: 8000 });
    assert.equal(await page.evaluate(() => globalThis.__SP__.data.get('config').modes.mode_multi_abyss.name), 'Ultimate Simulation');

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.title-screen .title-cn');
    assert.equal(await text(page, '.title-cn'), 'Stronghold Protocol: Alliance', 'the choice survives a reload');
    assert.equal(await text(page, '.title-login .btn--primary'), 'Start');

    await page.goto(`${base}/?lang=zh`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.title-screen .title-cn');
    await sleep(200);
    assert.equal(await text(page, '.title-cn'), '卫戍协议：盟约');
    assert.equal(await page.evaluate(() => location.search), '', '?lang is removed from the address bar');
    assert.equal(await page.evaluate(() => localStorage.getItem('sp.pref.lang')), '"zh"');
    assert.deepEqual(problems, []);
    await page.close();
  });
});
