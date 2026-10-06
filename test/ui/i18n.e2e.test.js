// Browser check of the language switch (puppeteer-core + system Chrome; opt-in: SP_E2E=1, ~20 s):
//
//   SP_E2E=1 node --test test/ui/i18n.e2e.test.js
//
// The title screen opens in Chinese; 中文 | English → English in place (no reload): the title, the start button, the
// connection line, <html lang>, the tab title; the choice is kept across a reload (localStorage sp.pref.lang) and the
// game-data overlay (data/i18n/en.json) is applied; `?lang=zh` switches back and leaves the address bar. Language packs
// (docs/I18N.md "Adding a language", docs/PACKS.md): a pack file dropped into public/i18n/ and a pack folder dropped
// into packs/ while the server runs show in the menu and switch, with English filling what they lack; a removed pack
// sends a stored choice back to Chinese. No console / page / request errors. docs/I18N.md.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, hasChrome, sleep } from '../e2e/client.mjs';
import { NAME_MAX_LEN } from '../../shared/constants.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// example packs, only for this test ('qaa' … 'qtz' are the ISO 639 codes reserved for local use); removed afterwards
const PACK_FILE = path.join(ROOT, 'public/i18n/qaa.json');
const PACK_DIR = path.join(ROOT, 'packs/qab');
const removePacks = () => { fs.rmSync(PACK_FILE, { force: true }); fs.rmSync(PACK_DIR, { recursive: true, force: true }); };

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
  after(async () => { removePacks(); await browser?.close(); await srv?.close(); });

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
  test('a pack dropped into the language folder or into packs/ shows in the menu and switches; English fills its gaps', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400 && !/fonts\.(googleapis|gstatic)/.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
    try {
      fs.writeFileSync(PACK_FILE, JSON.stringify({ _meta: { name: 'Testisch', englishName: 'Test language', fallback: ['en'] }, 卫戍协议: 'Testprotokoll', 盟约: 'Bund', 开始: 'Los' }));
      fs.mkdirSync(PACK_DIR, { recursive: true });
      fs.writeFileSync(path.join(PACK_DIR, 'pack.json'), JSON.stringify({ type: 'lang', lang: 'qab', name: 'Qabisch', files: { ui: 'ui.json' } }));
      fs.writeFileSync(path.join(PACK_DIR, 'ui.json'), JSON.stringify({ 开始: 'Qab-Start' }));
      await sleep(1100); // the server's registry looks at the folders again after a second
      await page.goto(`${base}/?lang=zh`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.title-screen [data-testid="lang-toggle"] button[data-lang="qaa"]');
      assert.deepEqual(await page.$$eval('[data-testid="lang-toggle"] button', (bs) => bs.map((b) => [b.dataset.lang, b.textContent.trim()])),
        [['zh', '中文'], ['en', 'English'], ['qaa', 'Testisch'], ['qab', 'Qabisch']]);

      await page.click('[data-testid="lang-toggle"] button[data-lang="qaa"]');
      await page.waitForFunction(() => document.querySelector('.title-login .btn--primary')?.textContent.includes('Los'), { timeout: 8000 });
      assert.equal(await text(page, '.title-cn'), 'Testprotokoll: Bund', 'an alphabetic title: the display face, an ASCII colon');
      assert.match(await text(page, '.title-tag'), /^Allocate Funds and Operators/, 'untranslated: English, the pack\'s fallback');
      assert.deepEqual(await page.evaluate(() => ({ lang: document.documentElement.lang, script: document.documentElement.dataset.script, pref: localStorage.getItem('sp.pref.lang') })),
        { lang: 'qaa', script: 'alphabetic', pref: '"qaa"' });
      // no game texts of its own: English's through the chain
      await page.waitForFunction(() => globalThis.__SP__?.data?.locale() === 'qaa', { timeout: 8000 });
      assert.equal(await page.evaluate(() => globalThis.__SP__.data.get('config').modes.mode_multi_abyss.name), 'Ultimate Simulation');

      await page.click('[data-testid="lang-toggle"] button[data-lang="qab"]');
      await page.waitForFunction(() => document.querySelector('.title-login .btn--primary')?.textContent.includes('Qab-Start'), { timeout: 8000 });
      assert.equal(await text(page, '.title-cn'), '卫戍协议：盟约', 'no fallback declared: the Chinese msgid');

      await page.click('[data-testid="lang-toggle"] button[data-lang="qaa"]');
      await page.waitForFunction(() => document.querySelector('.title-login .btn--primary')?.textContent.includes('Los'), { timeout: 8000 });
      removePacks();
      await sleep(1100);
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('.title-screen .title-cn');
      assert.equal(await text(page, '.title-cn'), '卫戍协议：盟约', 'the stored pack is gone: Chinese');
      assert.deepEqual(await page.$$eval('[data-testid="lang-toggle"] button', (bs) => bs.map((b) => b.dataset.lang)), ['zh', 'en']);
      assert.deepEqual(problems, []);
    } finally {
      removePacks();
      await page.close();
    }
  });
});
