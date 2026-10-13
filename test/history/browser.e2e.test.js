// HISTORY_E2E=1 CHROME_PATH=...: migration through real IndexedDB and the upstream stats UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startServer } from '../../server/index.js';
import { makeRecord } from '../helpers/legacyHistory.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('retired IndexedDB records migrate once into upstream statistics and survive a reload', {
  skip: process.env.HISTORY_E2E !== '1' || !existsSync(chrome) ? 'set HISTORY_E2E=1 and CHROME_PATH' : false,
}, async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, clientBuild: false });
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(srv.url);
    await page.waitForSelector('.title-screen');
    assert.deepEqual(await page.evaluate(async () => {
      const { readLegacyHistory } = await import('/js/history/legacyStorage.js');
      const rows = await readLegacyHistory();
      return { rows, exists: (await indexedDB.databases()).some((db) => db.name === 'stronghold-match-history') };
    }), { rows: [], exists: false }, 'reading a fresh profile does not create a legacy database');
    const record = makeRecord({ victory: true, seed: 77, durationMs: 1000, roundsPassed: 3,
      players: [{ playerId: 'legacy-human', name: '博士', victory: true, stats: { kills: 4 }, lineup: [], bonds: [] }] }, 'legacy-human', { now: 100 });
    await page.evaluate(async (record) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('stronghold-match-history', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('matches', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('matches', 'readwrite'); tx.objectStore('matches').put(record);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
      [...document.querySelectorAll('.fullscreen-prompt button')].find((b) => /暂不/.test(b.textContent))?.click();
    }, record);
    await page.click('.title-stats');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sp.pref.stats') || '{}').records?.length === 1);
    assert.equal(await page.$eval('.st-card__num', (el) => el.textContent), '1');
    await page.reload();
    await page.waitForSelector('.title-screen');
    await page.evaluate(() => [...document.querySelectorAll('.fullscreen-prompt button')].find((b) => /暂不/.test(b.textContent))?.click());
    await page.click('.title-stats');
    await page.waitForSelector('.st-card__num');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.stats')).records.length), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('sp.pref.historyMigrated')), '1');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await srv.close(); }
});
