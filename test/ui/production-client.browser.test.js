import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const enabled = process.env.SP_E2E === '1' && existsSync(chrome);

test('the production bundle boots and joins the lobby without importing a second source graph', {
  skip: enabled ? false : 'run npm run test:client (needs Chrome)', timeout: 120000,
}, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'sp-production-client-'));
  const publicDir = path.join(temp, 'public'), outDir = path.join(publicDir, 'build');
  let browser, srv;
  try {
    // Build into an isolated install: never consume, clean or replace public/build.
    await mkdir(publicDir, { recursive: true });
    await writeFile(path.join(publicDir, 'index.html'), '<html>source fallback must not be used</html>');
    const { build } = await import('vite');
    await build({ configFile: path.join(root, 'vite.config.js'), logLevel: 'silent', build: { outDir } });
    const manifest = JSON.parse(await readFile(path.join(outDir, '.vite/manifest.json'), 'utf8'));
    const expectedEntry = '/build/' + manifest['index.html'].file;
    srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off', publicDir,
      clientBuild: true, quiet: true });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: chrome, headless: true,
      args: ['--no-first-run', '--no-sandbox'], protocolTimeout: 30000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    const errors = [], failedModules = [], modules = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('.js')) {
        modules.push(response.url());
        if (response.status() >= 400) failedModules.push(response.url());
      }
    });
    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-screen .title-login input');
    await page.$eval('.title-login input', (input) => {
      input.value = 'BuildProbe';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => !document.querySelector('.title-login button.btn--primary')?.disabled);
    await page.$eval('.title-login button.btn--primary', (button) => button.click());
    try { await page.waitForSelector('.lobby-screen'); }
    catch (cause) {
      const text = await page.evaluate(() => document.body.innerText.slice(-2000));
      throw new Error(`Production login failed: ${JSON.stringify({ errors, failedModules, text, sessions: srv.registry.size })}`, { cause });
    }
    assert.equal(srv.network.connectionCount, 1);
    assert.ok(modules.some((url) => new URL(url).pathname === expectedEntry), 'the fresh build entry was requested');
    assert.deepEqual(modules.filter((url) => !new URL(url).pathname.startsWith('/build/assets/')), [],
      'all client scripts must come from the same build, never /js, /sim or source vendors');
    assert.deepEqual(failedModules, []);
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); }
    finally { try { await srv?.close(); } finally { await rm(temp, { recursive: true, force: true }); } }
  }
});
