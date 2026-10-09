// test/resources/browser.e2e.test.js — the optional offline-resource preload in headless Chrome: a Service Worker is
// registered, the files land in Cache Storage and a resource request is answered with the network off
// (docs/development/ASSETS.md「Preload」).
//
// Opt-in (starts Chrome): RESOURCE_E2E=1 node --test test/resources/browser.e2e.test.js
// Chrome path: $CHROME_PATH or the macOS default. The fixture install (its own public/ + data/) lives in a temp dir, so
// the test never touches public/assets.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const enabled = process.env.RESOURCE_E2E === '1' && fs.existsSync(CHROME);
const skip = enabled ? false : 'set RESOURCE_E2E=1 (needs Chrome)';

const FILES = [
  { url: '/assets/e2e/panel.png', tier: 1, body: 'panel-bytes' },
  { url: '/assets/e2e/bgm.mp3', tier: 1, body: 'bgm-bytes-1234' },
  { url: '/assets/e2e/deep/portrait.png', tier: 2, body: 'portrait' },
];

/** A minimal install: the client modules, the worker and a fixture asset tree. */
function makeInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-res-'));
  const publicDir = path.join(dir, 'public');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(publicDir, 'js'), { recursive: true });
  // The automatic-preload check also boots the real app shell beside the isolated manager fixture.
  fs.cpSync(path.join(ROOT, 'public', 'vendor'), path.join(publicDir, 'vendor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public', 'css'), path.join(publicDir, 'css'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'public', 'index.html'), path.join(publicDir, 'app.html'));
  fs.copyFileSync(path.join(ROOT, 'public', 'resource-sw.js'), path.join(publicDir, 'resource-sw.js'));
  for (const f of FILES) {
    const abs = path.join(publicDir, f.url);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.body);
  }
  fs.writeFileSync(path.join(dataDir, 'assets.json'), JSON.stringify({
    version: 1,
    hash: 'e2e0000',
    ui: { 'e2e/panel': FILES[0].url },
    audio: { bgm: { e2e: { loop: FILES[1].url } } },
    chars: { char_e2e: { portrait: FILES[2].url } },
  }));
  fs.writeFileSync(path.join(publicDir, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>resource e2e</title><link rel="stylesheet" href="/css/components.css" /></head><body><div id="app"></div>
<script type="module">
  import { render } from '/vendor/preact.module.js';
  import { html } from '/js/ui/components.js';
  import { ResourceLauncher, ResourceHost } from '/js/ui/resourcePanel.js';
  import { resourceState, syncResources, clearResources, startResources, exportResources, importResources } from '/js/resources/index.js';
  // the fixture drives the real launcher, exactly as the title screen does
  let enabled = false;
  let optional = true;
  const paint = () => render(html\`<div><\${ResourceLauncher} enabled=\${enabled} />
    <\${ResourceHost} enabled=\${enabled} optional=\${optional} onChange=\${(v) => set(v)}
      onOptional=\${(v) => { optional = v; void syncResources(enabled, v); paint(); }} /></div>\`, document.getElementById('app'));
  const set = (v, includeOptional = optional) => { enabled = v; optional = includeOptional; void syncResources(v, optional); paint(); };
  window.__res = {
    resourceState, syncResources, clearResources, startResources, exportResources, importResources,
    state: () => ({ ...resourceState(), enabled }),
    click: () => document.querySelector('.res-pill__head').click(),
  };
  window.__preload = (v) => set(v, true);
  paint();
  window.__ready = true;
</script></body></html>`);
  return { dir, publicDir, dataDir };
}

describe('offline resources in headless Chrome', { skip }, () => {
  let srv;
  let browser;
  let install;

  before(async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    const { startServer } = await import('../../server/index.js');
    install = makeInstall();
    srv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true, publicDir: install.publicDir, dataDir: install.dataDir, store: null,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
    if (install) fs.rmSync(install.dir, { recursive: true, force: true });
  });

  /**
   * A page of the fixture with its problems collected. `ready()` waits for the inline module and, when it never runs,
   * reports what the console said (a broken import otherwise shows up only as a 20 s timeout).
   */
  async function open() {
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.goto(`http://127.0.0.1:${srv.port}/index.html`);
    return { page, problems };
  }
  const ready = (page, problems) => page.waitForFunction('window.__ready === true', { timeout: 20000 })
    .catch((err) => { throw new Error(`${err.message} — ${problems.join(' | ') || 'no console error'}`); });

  test('the real app automatically preloads on entry, preserves the optional range, and reuses cache on reload', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const problems = [];
    const resourceRequests = [];
    page.on('request', (r) => { if (/\/assets\/e2e\//.test(r.url())) resourceRequests.push(r.url()); });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.pref.settings', JSON.stringify({ preload: false, preloadOptional: false }));
    });
    await page.goto(`http://127.0.0.1:${srv.port}/app.html`);
    await page.waitForFunction('!!window.__SP__');
    await page.waitForFunction(async () => {
      const st = (await import('/js/resources/index.js')).resourceState();
      return st.enabled && st.selectionComplete && st.phase === 'ready';
    }, { timeout: 30000 });
    const initial = await page.evaluate(async () => ({
      state: (await import('/js/resources/index.js')).resourceState(),
      settings: (await import('/js/ui/settings.js')).settingsStore.get(),
    }));
    assert.equal(initial.settings.preload, true, 'even a saved disabled setting starts automatically');
    assert.equal(initial.settings.preloadOptional, false, 'the chosen download range stays unchanged');
    assert.equal(initial.state.done, 2);
    assert.equal(resourceRequests.length, 2, 'only the two required fixture assets are downloaded');
    resourceRequests.length = 0;
    await page.reload();
    await page.waitForFunction('!!window.__SP__');
    await page.waitForFunction(async () => (await import('/js/resources/index.js')).resourceState().selectionComplete);
    const reloaded = await page.evaluate(async () => (await import('/js/resources/index.js')).resourceState());
    assert.equal(reloaded.done, 2);
    assert.deepEqual(resourceRequests, [], 'verified files are reused without another download');
    await page.evaluate(async () => (await import('/js/ui/settings.js')).updateSettings({ preload: false }));
    await page.waitForFunction(async () => !(await import('/js/resources/index.js')).resourceState().enabled);
    await page.evaluate(async () => (await import('/js/ui/settings.js')).updateSettings({ sfx: 0.25 }));
    assert.equal(await page.evaluate(async () => (await import('/js/resources/index.js')).resourceState().enabled), false,
      'other settings do not restart a manually stopped preload');
    await page.evaluate(async () => (await import('/js/resources/index.js')).clearResources());
    assert.deepEqual(problems, []);
  });

  test('the settings switch downloads the files and the worker serves them with the network off', async () => {
    const { page, problems } = await open();
    await ready(page, problems);

    // the server offers the list, with the sizes of the files this install has
    const manifest = await page.evaluate(() => fetch('/data/resource-manifest.json').then((r) => r.json()));
    assert.equal(manifest.count, 3);
    assert.deepEqual(manifest.files.map((f) => f.tier), [1, 1, 2]);
    assert.deepEqual(manifest.files.map((f) => f.size), [8, 11, 14], 'required visuals first, then optional audio');

    // off by default: nothing is fetched before the player asks for it
    assert.equal(await page.evaluate(() => window.__res.resourceState().phase), 'off');

    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction(() => {
      const state = window.__res.resourceState();
      return state.complete && state.phase === 'ready';
    }, { timeout: 30000 });
    const st = await page.evaluate(() => window.__res.resourceState());
    assert.equal(st.phase, 'ready');
    assert.deepEqual([st.done, st.total, st.bytes], [3, 3, 33]);
    assert.equal(st.worker, '', 'the Service Worker registered');

    // it controls this page (public/resource-sw.js claims its clients) and answers from Cache Storage
    await page.waitForFunction('!!navigator.serviceWorker.controller', { timeout: 20000 });
    const cached = await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys()).find((n) => n.startsWith('stronghold-resources-v1-')));
      const keys = await cache.keys();
      return keys.map((k) => new URL(k.url).pathname).sort();
    });
    assert.deepEqual(cached.filter((p) => p !== '/__sp-resource-index__').map((p) => p.replace(/^\/_v\/[a-f0-9]{16}/, '')).sort(), FILES.map((f) => f.url).sort());
    const paths = manifest.files.map((f) => f.url);
    assert.ok(paths.every((p) => /^\/_v\/[a-f0-9]{16}\//.test(p)));

    // with the network off the cache still answers — and only for the resources (code is never cached)
    await page.setOfflineMode(true);
    const offline = await page.evaluate(async (paths) => ({
      asset: await fetch(paths.find((p) => p.endsWith('bgm.mp3'))).then((r) => r.text()),
      range: await fetch(paths.find((p) => p.endsWith('panel.png')), { headers: { Range: 'bytes=0-4' } }).then(async (r) => ({ status: r.status, text: await r.text() })),
      other: await fetch('/js/resources/common.js').then(() => 'served', (err) => `failed: ${err.name}`),
    }), paths);
    assert.equal(offline.asset, 'bgm-bytes-1234', 'a cached resource is served offline');
    assert.deepEqual(offline.range, { status: 206, text: 'panel' }, 'ranges work from the cache');
    assert.match(offline.other, /failed/, 'anything uncached still needs the network (the worker never caches code)');
    await page.setOfflineMode(false);

    // turning the switch off and clearing removes every trace
    await page.evaluate(() => window.__preload(false));
    await page.evaluate(() => window.__res.clearResources());
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('the home-screen manager downloads required resources first and allows opting into audio', async () => {
    const { page, problems } = await open();
    await ready(page, problems);

    // a fresh device: off, collapsed, nothing cached
    await page.evaluate(() => caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
    assert.equal(await page.$eval('.res-pill__state', (el) => el.textContent), '未开启');
    assert.equal(await page.evaluate(() => window.__res.state().done), 0);

    await page.evaluate(() => window.__res.click());
    await page.waitForSelector('.resource-manager');
    await page.waitForFunction("window.__res.state().phase === 'paused'");
    assert.equal(await page.evaluate(() => window.__res.state().enabled), false, 'opening the manager does not enable downloads');
    assert.equal(await page.$eval('.resource-choice input', (el) => el.checked), true, 'both tiers are selected by default');
    await page.click('.resource-choice input');
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent === '开始预载').click());
    await page.waitForFunction('window.__res.state().selectionComplete === true');
    assert.equal(await page.evaluate(() => window.__res.state().complete), false, 'optional audio is not fetched');
    assert.equal(await page.evaluate(() => window.__res.state().done), 2);
    await page.click('.resource-choice input');
    await page.waitForFunction('window.__res.state().complete === true', { timeout: 30000 });
    await page.waitForFunction("document.querySelector('.res-pill__state').textContent === '全部已保存'");
    const body = await page.$eval('.resource-manager', (el) => el.textContent);
    assert.match(body, /2 \/ 2 个文件/, `progress text: ${body}`);
    assert.match(body, /19 B \/ 19 B/, `bytes: ${body}`);
    assert.equal(body.includes('undefined'), false, 'no undefined counter is ever rendered');
    const cached = await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys()).find((n) => n.startsWith('stronghold-resources-v1-')));
      return (await cache.keys()).length;
    });
    assert.equal(cached, 4, 'the pill really downloaded the files');

    // 关闭预载 turns the setting off again (keeping what is cached)
    await page.evaluate(() => [...document.querySelectorAll('.res-link')].find((b) => b.textContent === '关闭预载').click());
    assert.equal(await page.evaluate(() => window.__res.state().enabled), false);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('a second tab does not download the same files twice (real Web Locks)', async () => {
    const first = await open();
    await ready(first.page, first.problems);
    await first.page.evaluate(() => caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
    const second = await open();
    await ready(second.page, second.problems);
    const requested = [];
    second.page.on('request', (r) => { if (/\/assets\//.test(r.url())) requested.push(r.url()); });

    // the first tab holds the preload lock, exactly as it does while downloading
    await first.page.evaluate(() => {
      window.__release = null;
      const gate = new Promise((resolve) => { window.__release = resolve; });
      window.__holding = navigator.locks.request('stronghold-resources-preload', () => gate);
    });
    await second.page.evaluate(() => window.__preload(true));
    await second.page.waitForFunction("window.__res.state().phase === 'foreign'", { timeout: 15000 });
    await second.page.waitForFunction("document.querySelector('.res-pill__state').textContent === '另一标签页处理中'");
    assert.deepEqual(requested, [], 'the second tab asked for no resource file at all');
    assert.deepEqual(await second.page.evaluate(() => ({ done: window.__res.state().done, total: window.__res.state().total })), { done: 0, total: 3 });

    // the first tab releases the lock (finished or closed): the second one takes over and completes the rest
    await first.page.evaluate(() => window.__release());
    await second.page.evaluate(() => window.__res.startResources());
    await second.page.waitForFunction('window.__res.state().complete === true', { timeout: 30000 });
    assert.deepEqual(requested.map((u) => u.replace(/\/_v\/[a-f0-9]{16}/, '')).sort(), FILES.map((f) => `http://127.0.0.1:${srv.port}${f.url}`).sort());
    assert.deepEqual(second.problems, []);
    await first.page.close();
    await second.page.close();
  });

  test('a second visit finds the files already cached (a new manifest version starts over)', async () => {
    const { page, problems } = await open();
    await ready(page, problems);
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.resourceState().complete === true', { timeout: 30000 });
    const state = await page.evaluate(() => window.__res.resourceState());
    assert.equal(state.complete, true);
    assert.equal(state.done, 3);
    // the cache name carries the asset manifest hash: a new build downloads again instead of serving old art
    assert.match(state.version, /^[0-9a-f]{12}$/);
    await page.close();
  });
  for (const perFile of [false, true]) test(`${perFile ? 'per-file query' : 'versioned'} resources on a separate CDN origin are served from the game cache`, async (t) => {
    const { startServer } = await import('../../server/index.js');
    const health = await (await fetch(srv.url + '/healthz')).json();
    const manifestFile = path.join(install.dir, perFile ? 'assets-manifest.json' : 'no-assets-manifest.json');
    if (perFile) fs.writeFileSync(manifestFile, JSON.stringify({ format: 1, tag: '0123456789abcdef',
      hashes: Object.fromEntries(FILES.map((f) => [f.url, createHash('sha256').update(f.body).digest('hex').slice(0, 16)])) }));
    const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0,
      publicDir: install.publicDir, dataDir: install.dataDir, assetsCdn: srv.url, assetsCdnVersion: health.artVersion,
      assetsManifestFile: manifestFile });
    t.after(() => game.close());
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(game.url + '/index.html');
    await page.waitForFunction('window.__ready === true');
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.state().complete === true');
    await page.waitForFunction('!!navigator.serviceWorker.controller');
    const paths = await page.evaluate(() => fetch('/data/resource-manifest.json').then((r) => r.json()).then((m) => m.files.map((f) => f.url)));
    assert.ok(paths.every((p) => perFile ? p.startsWith(srv.url + '/assets/') && /\?v=[a-f0-9]{16}$/.test(p)
      : p.startsWith(srv.url + '/_v/' + health.artVersion + '/assets/')));
    await page.setOfflineMode(true);
    const result = await page.evaluate(async (urls) => {
      const res = await fetch(urls.find((p) => new URL(p).pathname.endsWith('bgm.mp3')), { headers: { Range: 'bytes=0-2' } });
      return { status: res.status, body: await res.text(), cached: res.headers.get('X-SP-Resource') };
    }, paths);
    assert.deepEqual(result, { status: 206, body: 'bgm', cached: '1' });
    await page.setOfflineMode(false);
    await page.evaluate(async () => { await window.__res.syncResources(false); await window.__res.clearResources(); });
  });

  test('manager ZIP export and file import restore verified resources without resource downloads', async (t) => {
    const { page, problems } = await open();
    t.after(() => page.close());
    await ready(page, problems);
    await page.evaluate(async () => {
      await window.__res.clearResources();
      window.__preload(true);
    });
    await page.waitForFunction('window.__res.state().complete');
    await page.evaluate(() => {
      const original = URL.createObjectURL;
      URL.createObjectURL = (blob) => { window.__exported = blob; return original(blob); };
      window.__res.click();
    });
    await page.waitForSelector('.resource-manager');
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent === '导出 ZIP').click());
    await page.waitForFunction('!!window.__exported && !window.__res.state().archive');
    const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__exported.arrayBuffer())]);
    const file = path.join(install.dir, 'round-trip.zip');
    fs.writeFileSync(file, Buffer.from(bytes));
    await page.evaluate(async () => { window.__preload(false); await window.__res.clearResources(); });
    const requested = [];
    page.on('request', (r) => { if (/\/assets\//.test(r.url())) requested.push(r.url()); });
    await (await page.$('input[type=file]')).uploadFile(file);
    await page.waitForFunction('window.__res.state().complete && window.__res.state().enabled && !window.__res.state().archive');
    assert.deepEqual(requested, [], 'imported current resources need no downloads');
    const restored = await page.evaluate(async () => {
      const { store } = await (await import('/js/resources/index.js')).resourceContext();
      const response = await (await caches.open(store.cacheName)).match(store.files.find((f) => f.url.endsWith('panel.png')).url);
      return { type: response.headers.get('content-type'), body: await response.text() };
    });
    assert.deepEqual(restored, { type: 'image/png', body: 'panel-bytes' });
    assert.deepEqual(problems, []);
    await page.evaluate(async () => { window.__preload(false); await window.__res.clearResources(); });
  });

});
