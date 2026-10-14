// SP_E2E=1 node --test test/ui/asset-import.browser.test.js
// Imports a one-file zip and a folder-shaped file list, then checks the server is not asked for those
// bytes. A second page with isSecureContext forced off must show why import is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { hash16 } from '../../server/http/assetIndex.js';
import { crc32 } from '../../public/js/assetPack.js';
import { CHROME, hasChrome } from '../e2e/client.mjs';

function buildStoredZip(name, raw) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const crc = crc32(raw);
  const local = new Uint8Array(30 + nameBytes.length + raw.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x800, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, raw.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(raw, 30 + nameBytes.length);
  const cd = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x800, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, raw.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cd.set(nameBytes, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + cd.length + eocd.length);
  out.set(local, 0);
  out.set(cd, local.length);
  out.set(eocd, local.length + cd.length);
  return out;
}

test('imported art is not fetched again, and plain HTTP hides import', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90000,
}, async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const folderPng = Buffer.from('folder-png-bytes');
  const zipUrl = `/assets/~${hash16(png)}/import-zip.png`;
  const folderUrl = `/assets/~${hash16(folderPng)}/import-folder.png`;
  const missing = '/assets/import-missing.png';
  const counts = new Map();
  let probes = 0;
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false });
  const serve = srv.server.listeners('request')[0];
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => {
    const url = req.url.split('?')[0];
    if (req.url.startsWith('/healthz')) probes++;
    if (url === '/data/assets.json' || url === '/data/local-assets.json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(url === '/data/assets.json'
        ? { files: [zipUrl, folderUrl, missing] }
        : { groups: {} }));
      return;
    }
    if (url === zipUrl || url === folderUrl || url === missing) {
      counts.set(url, (counts.get(url) || 0) + 1);
      res.writeHead(url === missing ? 404 : 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(url === folderUrl ? folderPng : png);
      return;
    }
    serve.call(srv.server, req, res);
  });
  t.after(() => srv.close());
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(srv.url);
  await page.waitForFunction(() => navigator.serviceWorker.controller != null, { timeout: 20000 });
  const zip = buildStoredZip('Stronghold-Protocol/public/assets/import-zip.png', png);
  const imported = await page.evaluate(async (zipB64, folderB64) => {
    const decode = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const { createAssetImport } = await import('/js/assetPack.js');
    const imp = createAssetImport();
    await imp.start({ type: 'zip', data: decode(zipB64) });
    const zipState = imp.get();
    await imp.start({
      type: 'files',
      files: [{ path: 'public/assets/import-folder.png', read: async () => decode(folderB64) }],
    });
    return { zip: zipState, folder: imp.get() };
  }, Buffer.from(zip).toString('base64'), Buffer.from(folderPng).toString('base64'));
  assert.equal(imported.zip.phase, 'complete');
  assert.equal(imported.zip.accepted, 1);
  assert.equal(imported.folder.phase, 'complete');
  assert.equal(imported.folder.accepted, 1);
  const statuses = await page.evaluate(async (a, b) => {
    const read = async (url) => (await fetch(url)).status;
    return { a: await read(a), b: await read(b) };
  }, zipUrl, folderUrl);
  assert.deepEqual(statuses, { a: 200, b: 200 });
  assert.equal(counts.get(zipUrl) || 0, 0);
  assert.equal(counts.get(folderUrl) || 0, 0);
  const beforeProbe = probes;
  await page.evaluate(() => fetch('/healthz?import-probe=1'));
  assert.ok(probes > beforeProbe, 'a non-asset URL still reaches the server');

  await page.click('[data-testid="asset-download"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('1 个素材下载失败'));
  assert.equal(counts.get(zipUrl) || 0, 0, 'download skips the imported zip file');
  assert.equal(counts.get(folderUrl) || 0, 0, 'download skips the imported folder file');
  assert.equal(counts.get(missing), 1);

  const insecure = await browser.newPage();
  await insecure.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  });
  await insecure.goto(srv.url);
  await insecure.click('[data-testid="asset-download"]');
  await insecure.waitForSelector('[data-testid="asset-import-unavailable"]');
  const reason = await insecure.$eval('[data-testid="asset-import-unavailable"]', (el) => el.textContent);
  assert.match(reason, /HTTPS/);
  assert.equal(await insecure.$('[data-testid="asset-import-folder"]'), null);
  assert.deepEqual(errors, []);
});
