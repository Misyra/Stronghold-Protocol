// The Vite bundle of the UI layer (vite.config.js, ported from Stardust-minus 2026-11-04, after xinhai-ai/
// Stronghold-Protocol f164a5e): /js and /css only — /shared and /sim stay native modules at their site URLs, the
// boot scripts, the Workers, icons, fonts and the Pixi scripts keep their own URLs — and the serving side
// (server/http/static.js): the bundle when public/build/index.html is on disk, `SP_CLIENT=source` forces the source
// page, a build chunk's JS is immutable while its CSS revalidates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStaticHandler, clientModeFromEnv } from '../server/http/static.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function buildInto(outDir) {
  const { build } = await import('vite');
  await build({ configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
}

test('the bundle keeps /shared and /sim native, inlines no shared code, and leaves Workers, boot scripts, icons, fonts and Pixi alone', { timeout: 180_000 }, async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-vite-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  await buildInto(out);
  const files = fs.readdirSync(path.join(out, 'assets'));
  assert.ok(files.length > 0 && files.every((f) => /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(f)), `only hashed JS/CSS: ${files.join(' ')}`);
  const js = files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(out, 'assets', f), 'utf8')).join('\n');
  assert.ok(/from"\/shared\/constants\.js"/.test(js), 'shared modules are imported from /shared/');
  assert.equal(/["'](?:\.\.\/)+shared\//.test(js), false, 'never a relative path to shared/');
  // strings that live only in shared modules: their code is not copied into the bundle
  for (const marker of ['bad patch', 'missing path']) assert.equal(js.includes(marker), false, `shared/stateDelta.js inlined (${marker})`);
  assert.ok(js.includes('/js/battle/simWorker.js'), 'the simulation Worker keeps its URL (its CSP header)');
  assert.ok(js.includes('/js/battle/rehearsalWorker.js'));
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.equal(/type="importmap"|rel="modulepreload" href="\/(?:js|vendor)\//.test(html), false);
  for (const kept of ['href="/manifest.json"', 'href="/icons/favicon.ico"', 'href="/icons/apple-touch-icon.png"', 'href="/fonts/fonts.css"',
    'href="/vendor/pixi.min.js"', 'href="/vendor/pixi-spine.js"', 'src="/js/boot.js"', 'src="/js/bootLegacy.js"', 'src="/js/webFonts.js"']) assert.ok(html.includes(kept), kept);
  assert.equal(html.includes('vite-ignore'), false);
  const boot = html.indexOf('src="/js/boot.js"'), entry = html.search(/<script type="module" crossorigin src="\/build\/assets\/index-[A-Za-z0-9_-]{8}\.js" id="sp-main"><\/script>/);
  assert.ok(boot > 0 && entry > boot, 'the entry script follows boot.js and keeps id sp-main (boot.js reports its load failure)');
  assert.match(html, /<link rel="stylesheet" crossorigin href="\/build\/assets\/index-[A-Za-z0-9_-]{8}\.css">/);
  // the page's own stylesheet links are gone: the styles ship in the bundle (fonts.css keeps its own URL)
  assert.equal(html.includes('href="/css/components.css"'), false);
  const css = fs.readFileSync(path.join(out, 'assets', files.find((f) => f.endsWith('.css'))), 'utf8');
  for (const sel of ['.conn-banner', '.btn--primary']) assert.ok(css.includes(sel), `${sel} is in the bundle`);
});

function serve(publicDir, clientBuild) {
  const handler = createStaticHandler({ publicDir, dataDir: path.join(ROOT, 'data'), sharedDir: path.join(ROOT, 'shared'), clientBuild, log: { warn() {}, error() {}, info() {} } });
  const srv = http.createServer((req, res) => { const [p, q] = req.url.split('?'); handler(req, res, p, q || ''); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}
const get = (srv, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: srv.address().port, path: url }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['cache-control'], body }));
  }).on('error', reject);
});

test('a bundle on disk is served for /, its JS chunks are immutable and its CSS revalidates; SP_CLIENT=source and a missing build serve public/index.html', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>source</title>');
  fs.mkdirSync(path.join(dir, 'build', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build', 'index.html'), '<!doctype html><title>bundle</title>');
  fs.writeFileSync(path.join(dir, 'build', 'assets', 'index-AbCd_1-x.js'), 'export {};');
  fs.writeFileSync(path.join(dir, 'build', 'assets', 'index-AbCd_1-x.css'), '.x{}');
  assert.equal(clientModeFromEnv({ SP_CLIENT: 'source' }), false);
  assert.equal(clientModeFromEnv({ SP_CLIENT: ' Source ' }), false);
  assert.equal(clientModeFromEnv({}), true, 'no SP_CLIENT: the bundle when it exists');
  const built = await serve(dir, true), source = await serve(dir, false);
  try {
    for (const url of ['/', '/index.html']) {
      const r = await get(built, url);
      assert.equal(r.status, 200); assert.match(r.body, /bundle/); assert.equal(r.cache, 'no-cache');
      assert.match((await get(source, url)).body, /source/);
    }
    const chunk = await get(built, '/build/assets/index-AbCd_1-x.js');
    assert.equal(chunk.status, 200); assert.match(chunk.cache, /immutable/);
    const sheet = await get(built, '/build/assets/index-AbCd_1-x.css');
    assert.equal(sheet.status, 200); assert.match(sheet.cache, /immutable/, 'the CSS bundle carries only data: url()s: its hashed name pins the served bytes');
    assert.equal((await get(built, '/build/.vite/manifest.json')).status, 404);
    fs.rmSync(path.join(dir, 'build'), { recursive: true });
    const fresh = await serve(dir, true);
    try { assert.match((await get(fresh, '/')).body, /source/, 'no build: the source page, not a 404'); } finally { fresh.close(); }
  } finally { built.close(); source.close(); }
});
