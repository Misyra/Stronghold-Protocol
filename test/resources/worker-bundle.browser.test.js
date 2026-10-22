import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const chrome = process.env.CHROME_PATH;
test('a standalone resource worker caches verified art without fetching source modules', {
  skip: process.env.SP_E2E !== '1' || !chrome || !existsSync(chrome) ? 'needs browser-test-setup' : false,
  timeout: 30000,
}, async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../../public/resource-sw.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, metafile: true });
  assert.deepEqual(Object.values(result.metafile.outputs)[0].imports, []);
  const body = 'verified-CDN-art';
  const hash = createHash('sha1').update(body).digest('hex').slice(0, 12);
  const version = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const paths = [];
  let assetReads = 0, manifestReads = 0, offline = false;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    paths.push(path);
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>worker test</title>'); }
    else if (path === '/resource-sw.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(result.outputFiles[0].contents);
    } else if (path === '/data/resource-manifest.json') {
      manifestReads++;
      if (offline) { res.writeHead(503); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ format: 1, version: 'bundle-test', files: [{ url: '/assets/a.png', tier: 1, size: body.length, hash }] }));
    } else if (path === '/assets/a.png') {
      assetReads++;
      res.writeHead(offline ? 503 : 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(body.length) }); res.end(offline ? 'offline' : body);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/resource-sw.js?v=0123456789abcdef', { type: 'module', scope: '/', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    const read = () => page.evaluate(async () => (await fetch('/assets/a.png')).text());
    assert.equal(await read(), body);
    offline = true;
    assert.equal(await read(), body);
    assert.equal(assetReads, 1, 'the verified second read comes from Cache Storage');
    const manifestBefore = manifestReads;
    const session = await page.createCDPSession();
    await session.send('ServiceWorker.enable');
    await session.send('ServiceWorker.stopAllWorkers');
    await page.setOfflineMode(true);
    const cold = await page.evaluate(async (version) => {
      const response = await fetch('/assets/a.png?v=' + version, { headers: { Range: 'bytes=0-7' } });
      return { status: response.status, text: await response.text() };
    }, version);
    assert.deepEqual(cold, { status: 206, text: body.slice(0, 8) });
    assert.equal(manifestReads, manifestBefore, 'a restarted worker serves the proven CDN revision without loading its manifest');
    assert.equal(assetReads, 1, 'a version query must not cause another asset download');
    assert.equal(paths.some((path) => path.startsWith('/js/') || path.startsWith('/shared/')), false,
      'worker installation/update has no source-module requests to revalidate');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
