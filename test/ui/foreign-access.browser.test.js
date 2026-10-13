import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.SP_E2E === '1' && existsSync(chrome);

test('an overseas browser receives only HTTP 403 and a message, without loading or connecting the game', {
  skip: enabled ? false : 'Set SP_E2E=1 and CHROME_PATH', timeout: 60000,
}, async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off',
    clientBuild: false, quiet: true, countryLookup: () => 'HK', allowForeignConnections: false });
  let browser;
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: chrome, headless: true,
      args: ['--no-first-run', '--no-sandbox'] });
    const page = await browser.newPage(), errors = [], scripts = [], sockets = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.resourceType() === 'script') scripts.push(request.url()); });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', event => sockets.push(event.url));
    await page.setExtraHTTPHeaders({ 'X-Real-IP': '203.0.113.1' });
    await page.setViewport({ width: 1366, height: 900 });
    const response = await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 403);
    assert.deepEqual(await response.json(), { code: 'FOREIGN_CONNECTIONS_DISABLED', msg: '本服务器暂时仅对中国大陆服务' });
    assert.equal(await page.$('.title-screen'), null);
    assert.ok((await page.evaluate(() => document.body.textContent)).includes('本服务器暂时仅对中国大陆服务'));
    const count = srv.network.foreignSessions.stats().connectionDenied;
    assert.equal(count, 1); assert.equal(srv.registry.size, 0);
    // No game script runs, so no WebSocket attempt or automatic retry can occur.
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(srv.network.foreignSessions.stats().connectionDenied, count);
    const output = await mkdtemp(path.join(tmpdir(), 'sp-foreign-access-ui-'));
    for (const viewport of [{ width: 1366, height: 900 }, { width: 844, height: 390 }]) {
      await page.setViewport(viewport);
      await page.screenshot({ path: path.join(output, `${viewport.width}.png`) });
    }
    assert.deepEqual(scripts, []); assert.deepEqual(sockets, []);
    assert.deepEqual(errors, []);
    console.log(`Foreign access screenshots: ${output}`);
  } finally { try { await browser?.close(); } finally { await srv.close(); } }
});
