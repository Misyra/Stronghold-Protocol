// test/resources/browser.e2e.test.js — the optional offline-resource preload in headless Chrome: a Service Worker is
// registered, the files land in Cache Storage and a resource request is answered with the network off
// (docs/ASSETS.md「Preload」).
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

/**
 * The fixture page's module, kept in a file of its own: the site policy (server/http/csp.js) hashes only the import
 * map and the release-tag script, so an inline module would be blocked, while `script-src 'self'` serves this one.
 */
const FIXTURE_MODULE = [
  "import { render } from '/vendor/preact.module.js';",
  "import { html } from '/js/ui/components.js';",
  "import { ResourceLauncher, ResourceHost } from '/js/ui/resourcePanel.js';",
  "import { resourceState, syncResources, clearResources, startResources, exportResources, importResources } from '/js/resources/index.js';",
  "// the fixture drives the real launcher, exactly as the title screen does",
  "let enabled = false;",
  "let optional = true;",
  "let voices = true;",
  "let allVoices = false;",
  "let voiceLang = 'cn';",
  "let skinPreload = false;",
  "let skinPreloadAll = false;",
  "let fxPreload = true;",
  "// The three preload scopes, exactly as main.js passes them: skins follow 干员调配 (nothing is equipped in this",
  "// fixture) unless 全部皮肤 widens it, and 官方特效 rides a switch of its own — on by default (默认全预载).",
  "const scope = () => ({ keys: [], all: skinPreload && skinPreloadAll, fx: fxPreload, voices });",
  "const applyScope = () => { void syncResources(enabled, optional, voiceLang, allVoices, scope()); };",
  "const applySkinScope = (on, all) => { skinPreload = on; skinPreloadAll = all; applyScope(); paint(); };",
  "const paint = () => render(html`<div><${ResourceLauncher} enabled=${enabled} />",
  "  <${ResourceHost} enabled=${enabled} optional=${optional} voices=${voices} allVoices=${allVoices} voiceLang=${voiceLang}",
  "    onVoiceLang=${(v) => { voiceLang = v; applyScope(); paint(); }}",
  "    onAllVoices=${(v) => { allVoices = v; applyScope(); paint(); }} onChange=${(v) => set(v)}",
  "    onOptional=${(v) => { optional = v; applyScope(); paint(); }}",
  "    onVoices=${(v) => { voices = v; applyScope(); paint(); }}",
  "    onPreset=${(p) => { optional = p.preloadOptional; voices = p.preloadVoices; skinPreload = p.preloadSkins; skinPreloadAll = p.preloadSkinsAll; fxPreload = p.preloadFx; allVoices = p.preloadAllVoices; applyScope(); paint(); }}",
  "    skinPreload=${skinPreload} skinPreloadAll=${skinPreloadAll} fxPreload=${fxPreload}",
  "    onSkinPreload=${(v) => applySkinScope(v, skinPreloadAll)}",
  "    onSkinPreloadAll=${(v) => applySkinScope(skinPreload, v)}",
  "    onFxPreload=${(v) => { fxPreload = v; applyScope(); paint(); }} /></div>`, document.getElementById('app'));",
  "const set = (v, includeOptional = optional) => { enabled = v; optional = includeOptional; applyScope(); paint(); };",
  "window.__res = {",
  "  resourceState, syncResources, clearResources, startResources, exportResources, importResources,",
  "  state: () => ({ ...resourceState(), enabled }),",
  "  click: () => document.querySelector('.res-pill__head').click(),",
  "};",
  "window.__preload = (v) => set(v, true);",
  "paint();",
  "window.__ready = true;",
].join('\n');

/** The fixture page: one div, the stylesheets the manager uses, and the module above. */
const FIXTURE_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />'
  + '<title>resource e2e</title><link rel="stylesheet" href="/css/theme.css" /><link rel="stylesheet" href="/css/components.css" /></head>'
  + '<body><div id="app"></div><script type="module" src="/e2e-fixture.js"></script></body></html>';

/** A minimal install: the client modules, the worker and a fixture asset tree. */
function makeInstall({ voices = false, dynamic = false, skins = false, fx = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-res-'));
  const publicDir = path.join(dir, 'public');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(publicDir, 'js'), { recursive: true });
  // The automatic-preload check also boots the real app shell beside the isolated manager fixture.
  fs.cpSync(path.join(ROOT, 'public', 'vendor'), path.join(publicDir, 'vendor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public', 'css'), path.join(publicDir, 'css'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'public', 'index.html'), path.join(publicDir, 'app.html'));
  // The real shell has an import map; CSP hashes only known entry pages, while index.html below is the map-free fixture.
  fs.mkdirSync(path.join(publicDir, 'dev'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'public', 'index.html'), path.join(publicDir, 'dev', 'game-mock.html'));
  fs.copyFileSync(path.join(ROOT, 'public', 'resource-sw.js'), path.join(publicDir, 'resource-sw.js'));
  const voiceFiles = voices ? ['cn', 'jp'].map((lang) => ({ url: `/assets/audio/voice/${lang}/char_e2e/test.mp3`, body: `${lang}-voice` })) : [];
  const dynamicFiles = dynamic ? [{ url: '/fonts/fonts.css', body: 'body { color: white; }' },
    { url: '/assets/local/map/common/materials.json', body: '{ "material": true }' }] : [];
  // One installed 干员皮肤 (docs/SKINS.md): two files under a `chars.<charId>.skins.<skinId>…` key path, which is what
  // the resource manifest marks `skin: '<charId>/<skinId>'`.
  const skinFiles = skins ? [{ url: '/assets/e2e/skin/boc.skel', body: 'skin-skel-bytes' },
    { url: '/assets/e2e/skin/boc.png', body: 'skin-art-bytes' }] : [];
  // The official battle effects (docs/design/vfx-format.md): data/local-fx.json lists every file under
  // /assets/local/fx/, which server/resources.js turns into tier-2 entries marked `fx: true`.
  const fxFiles = fx ? [{ url: '/assets/local/fx/index.json', body: '{ \"fx\": true }' },
    { url: '/assets/local/fx/tex/fire_1.webp', body: 'fx-texture-bytes' }] : [];
  for (const f of [...FILES, ...voiceFiles, ...dynamicFiles, ...skinFiles, ...fxFiles]) {
    const abs = path.join(publicDir, f.url);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.body);
  }
  fs.writeFileSync(path.join(dataDir, 'assets.json'), JSON.stringify({
    version: 1,
    hash: 'e2e0000',
    ui: { 'e2e/panel': FILES[0].url, ...(dynamic ? { dynamic: dynamicFiles.map((f) => f.url) } : {}) },
    audio: { bgm: { e2e: { loop: FILES[1].url } }, ...(voices ? { voice: voiceFiles.map((f) => f.url) } : {}) },
    chars: { char_e2e: { portrait: FILES[2].url,
      ...(skins ? { skins: { 'char_e2e@boc#1': { front: { skel: skinFiles[0].url, textures: [skinFiles[1].url] } } } } : {}) } },
  }));
  if (fx) {
    fs.writeFileSync(path.join(dataDir, 'local-fx.json'), JSON.stringify({
      version: 1, format: 'fx-manifest', set: 'used',
      groups: { fx: { index: { path: fxFiles[0].url }, textures: { path: fxFiles[1].url } } },
    }));
  }
  fs.writeFileSync(path.join(publicDir, 'e2e-fixture.js'), FIXTURE_MODULE);
  fs.writeFileSync(path.join(publicDir, 'index.html'), FIXTURE_PAGE);
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
    browser = await puppeteer.launch({ browser: process.env.RESOURCE_BROWSER === 'firefox' ? 'firefox' : 'chrome',
      executablePath: CHROME, headless: true, args: process.env.RESOURCE_BROWSER === 'firefox' ? [] : ['--no-first-run', '--no-sandbox'] });
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

  test('the real app respects saved preload preferences, resumes enabled downloads, and reuses cache on reload', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const problems = [];
    const resourceRequests = [];
    const countRequest = (req) => { if (/\/assets\/e2e\//.test(req.url)) resourceRequests.push(req.url); };
    srv.server.on('request', countRequest);
    t.after(() => srv.server.off('request', countRequest));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.port}/index.html`);
    await page.evaluate(() => localStorage.setItem('sp.pref.settings', JSON.stringify({ preload: false, preloadOptional: false })));
    await page.goto(`http://127.0.0.1:${srv.port}/app.html`);
    await page.waitForFunction('!!window.__SP__', { timeout: 20000 })
      .catch((err) => { throw new Error(`${err.message} — ${problems.join(' | ') || 'no console error'}`); });
    await page.waitForFunction(async () => !(await import('/js/resources/index.js')).resourceState().optional);
    assert.equal(await page.evaluate(async () => (await import('/js/ui/settings.js')).settingsStore.get().preload), false);
    assert.deepEqual(resourceRequests, [], 'a saved disabled setting does not download assets');
    await page.evaluate(async () => (await import('/js/ui/settings.js')).updateSettings({ preload: true }));
    await page.waitForFunction(async () => {
      const st = (await import('/js/resources/index.js')).resourceState();
      return st.enabled && st.selectionComplete && st.phase === 'ready';
    }, { timeout: 30000 });
    const initial = await page.evaluate(async () => ({
      state: (await import('/js/resources/index.js')).resourceState(),
      settings: (await import('/js/ui/settings.js')).settingsStore.get(),
    }));
    assert.equal(initial.settings.preload, true, 'the player can enable background downloads');
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
    await page.reload();
    await page.waitForFunction('!!window.__SP__');
    await page.waitForFunction(async () => !(await import('/js/resources/index.js')).resourceState().optional);
    assert.equal(await page.evaluate(async () => (await import('/js/ui/settings.js')).settingsStore.get().preload), false,
      'a saved pause survives reload');
    assert.equal(await page.evaluate(async () => (await import('/js/resources/index.js')).resourceState().enabled), false);
    assert.deepEqual(resourceRequests, [], 'reloading a paused page does not download assets');
    // Hold the cache check open so the real pause button is exercised before the tiny fixture finishes downloading.
    await page.evaluate(async () => {
      const { store } = await (await import('/js/resources/index.js')).resourceContext();
      const status = store.status.bind(store);
      store.status = () => new Promise((resolve) => {
        window.__releaseResourceCheck = () => { store.status = status; resolve(status()); };
      });
      (await import('/js/ui/settings.js')).updateSettings({ preload: true, preloadOptional: true });
      (await import('/js/ui/resourcePanel.js')).openResources();
    });
    await page.waitForSelector('.resource-modal');
    if (await page.$('.fullscreen-prompt')) await page.click('.fullscreen-prompt .btn--secondary');
    await page.click('.resource-modal .modal__actions .btn--secondary');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.settings')).preload), false,
      'the physical pause button saves the disabled preference');
    await page.evaluate(() => window.__releaseResourceCheck());
    await page.reload();
    await page.waitForFunction('!!window.__SP__');
    assert.equal(await page.evaluate(async () => (await import('/js/ui/settings.js')).settingsStore.get().preload), false);
    assert.deepEqual(resourceRequests, [], 'the pause button prevents downloads on reload');
    await page.evaluate(async () => (await import('/js/resources/index.js')).clearResources());
    assert.deepEqual(problems, []);
  });

  test('versioned worker requests versioned manifests and cleanup unregisters its query URL', async (t) => {
    const context = await browser.createBrowserContext();
    t.after(() => context.close());
    const requests = [];
    const record = req => { if (req.url.startsWith('/data/resource-manifest.json')) requests.push(req.url); };
    srv.server.on('request', record);
    t.after(() => srv.server.off('request', record));
    const page = await context.newPage();
    await page.goto(srv.url + '/index.html');
    await ready(page, []);
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction(() => window.__res.resourceState().phase === 'ready' && !!navigator.serviceWorker.controller);
    const result = await page.evaluate(async () => {
      const version = globalThis.__spAssetVersion;
      const workerVersion = new URL(navigator.serviceWorker.controller.scriptURL).searchParams.get('v');
      const ctx = await (await import('/js/resources/index.js')).resourceContext();
      const response = await fetch(ctx.manifest.files[0].url);
      await response.arrayBuffer();
      await window.__res.syncResources(false);
      await window.__res.clearResources();
      return { version, workerVersion, registrations: (await navigator.serviceWorker.getRegistrations()).length };
    });
    assert.match(result.version, /^[a-f0-9]{16}$/);
    assert.equal(result.workerVersion, result.version);
    assert.equal(result.registrations, 0);
    assert.ok(requests.length >= 2, 'page and worker both load their manifests');
    assert.ok(requests.every(url => url === '/data/resource-manifest.json?v=' + result.version));
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
    assert.equal(await page.$eval('[data-testid="optional-preload"]', (el) => el.checked), true, 'both tiers are selected by default');
    await page.$eval('.resource-card__details', (el) => { el.open = true; });
    await page.click('[data-testid="optional-preload"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.btn')].some((b) => b.textContent === '开始预载'));
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent === '开始预载').click());
    await page.waitForFunction('window.__res.state().selectionComplete === true');
    assert.equal(await page.evaluate(() => window.__res.state().complete), true, 'the selected required set is complete');
    assert.equal(await page.evaluate(() => window.__res.state().groups.find((g) => g.id === 'other').allPresent), 0, 'optional audio is not fetched');
    assert.equal(await page.evaluate(() => window.__res.state().done), 2);
    await page.$eval('.resource-card__details', (el) => { el.open = true; });
    await page.click('[data-testid="optional-preload"]');
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

  test('干员皮肤 全部皮肤 caches every installed outfit, and 跟随干员调配 keeps them out', async (t) => {
    const { startServer } = await import('../../server/index.js');
    const own = makeInstall({ skins: true });
    const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null,
      publicDir: own.publicDir, dataDir: own.dataDir,
      log: { info() {}, warn() {}, error() {}, debug() {} } });
    t.after(async () => { await game.close(); fs.rmSync(own.dir, { recursive: true, force: true }); });
    const page = await browser.newPage();
    t.after(() => page.close());
    const problems = [];
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });
    await page.goto(game.url + '/index.html');
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    await page.evaluate(() => caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));

    await page.evaluate(() => window.__res.click());
    await page.waitForSelector('.resource-skins');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.resource-skins .resource-choice input').length), 2, 'the skin switch and all-skins choice live together');
    assert.equal(await page.$eval('[data-testid="skin-preload"]', (el) => el.closest('.resource-skins') !== null), true, 'the skin choice sits beside its progress');
    assert.equal(await page.$eval('[data-testid="skin-preload-all"]', (el) => el.disabled), true, '全部皮肤 waits for the master switch');

    // The master switch alone follows 干员调配 — nothing is equipped here, so no outfit file is wanted.
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.state().selectionComplete === true', { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__res.state().done), 3, 'the three fixture resources, no outfit among them');

    // 全部皮肤 takes the whole manifest: both files of the one installed outfit land in Cache Storage.
    await page.click('[data-testid="skin-preload"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="skin-preload-all"]').disabled === false);
    await page.click('[data-testid="skin-preload-all"]');
    await page.waitForFunction('window.__res.state().selectionComplete === true && window.__res.state().skins[0].present === 2',
      { timeout: 30000 });
    assert.deepEqual(await page.evaluate(() => window.__res.state().skinScope), { keys: [], all: true });
    assert.equal(await page.evaluate(() => window.__res.state().done), 5);
    const body = await page.$eval('.resource-skins', (el) => el.textContent);
    assert.match(body, /本次 1 套/, 'all-skins summary: ' + body);
    assert.match(body, /本机已缓存 1 套/, 'catalog cache summary: ' + body);
    const cached = await page.evaluate(() => caches.open('stronghold-resources-v1-all')
      .then((cache) => cache.keys()).then((keys) => keys.map((r) => new URL(r.url).pathname)));
    assert.ok(cached.some((p) => p.endsWith('/assets/e2e/skin/boc.skel')), 'the outfit model is cached: ' + cached.join(', '));
    assert.ok(cached.some((p) => p.endsWith('/assets/e2e/skin/boc.png')), 'and its art');
    assert.deepEqual(problems, []);
    await page.evaluate(async () => { await window.__res.syncResources(false); await window.__res.clearResources(); });
  });

  test('官方特效 特效 caches the effect tree on its own and never implies 额外资源', async (t) => {
    const { startServer } = await import('../../server/index.js');
    const own = makeInstall({ voices: true, fx: true });
    const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null,
      publicDir: own.publicDir, dataDir: own.dataDir,
      log: { info() {}, warn() {}, error() {}, debug() {} } });
    t.after(async () => { await game.close(); fs.rmSync(own.dir, { recursive: true, force: true }); });
    const page = await browser.newPage();
    t.after(() => page.close());
    const problems = [];
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });
    await page.goto(game.url + '/index.html');
    await page.waitForFunction('window.__ready === true', { timeout: 20000 })
      .catch((err) => { throw new Error(`${err.message} — ${problems.join(' | ') || 'no console error'}`); });
    await page.evaluate(() => caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));

    await page.evaluate(() => window.__res.click());
    await page.waitForSelector('.resource-manager');
    // The panel only knows about 特效 once the opening scan has read the manifest (and this tree is installed).
    await page.waitForSelector('[data-testid="fx-preload"]', { timeout: 15000 });
    // One box per scope, in the optional tier's header, all of them checked (默认全预载). No skins in this install.
    assert.deepEqual(await page.$$eval('.resource-manager__tiers [data-testid]', (els) => els.map((el) => el.dataset.testid)),
      ['optional-preload', 'voice-preload', 'fx-preload'], 'audio and effects have independent controls');
    assert.equal(await page.$eval('[data-testid="fx-preload"]', (el) => el.checked), true, '特效 defaults to on');
    assert.equal(await page.$('[data-testid="skin-preload"]'), null, 'no outfits installed, so no 皮肤 box');

    // Music and voice off: the whole effect tree alone still lands.
    await page.click('[data-testid="voice-preload"]');
    await page.$eval('.resource-card__details', (el) => { el.open = true; });
    await page.click('[data-testid="optional-preload"]');
    // The footer button is re-rendered whenever the scope changes, so poll for it before clicking.
    await page.waitForFunction(() => [...document.querySelectorAll('.btn')].some((b) => b.textContent === '开始预载'), { timeout: 15000 });
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent === '开始预载').click());
    await page.waitForFunction('window.__res.state().selectionComplete === true && window.__res.state().done === 4', { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__res.state().tier2Wanted), 2, 'only the two effect files are optional here');
    const cached = await page.evaluate(() => caches.open('stronghold-resources-v1-all')
      .then((cache) => cache.keys()).then((keys) => keys.map((r) => new URL(r.url).pathname)));
    assert.ok(cached.some((path) => path.endsWith('/assets/local/fx/tex/fire_1.webp')), 'the effect texture is cached: ' + cached.join(', '));
    assert.equal(cached.some((path) => path.includes('/assets/audio/voice/')), false, 'no voice without 额外资源');

    // 特效 off, 额外资源 back on: exactly the other way round.
    await page.click('[data-testid="fx-preload"]');
    await page.click('[data-testid="voice-preload"]');
    await page.$eval('.resource-card__details', (el) => { el.open = true; });
    await page.click('[data-testid="optional-preload"]');
    // 额外资源 on again: the two audio files (background music + the Chinese voice) replace the effects, and
    // `done` counts what the selection holds — the fx files stay cached without being wanted.
    await page.waitForFunction('window.__res.state().selectionComplete === true && window.__res.state().done === 4', { timeout: 30000 });
    const groups = await page.evaluate(() => window.__res.state().groups.map((g) => ({ id: g.id, wanted: g.wanted, allTotal: g.allTotal })));
    assert.deepEqual(groups.map((g) => g.id).sort(), ['fx', 'other', 'ui', 'voice'],
      '额外资源 is back (the fixture bgm.mp3 sits outside /bgm/) and the 特效 row stays listed');
    assert.equal(groups.find((g) => g.id === 'fx').wanted, 0, '特效 is out of the selection while its box is off');
    assert.equal(groups.find((g) => g.id === 'fx').allTotal, 2, 'its row still counts the whole manifest');
    const after = await page.evaluate(() => caches.open('stronghold-resources-v1-all')
      .then((cache) => cache.keys()).then((keys) => keys.map((r) => new URL(r.url).pathname)));
    assert.ok(after.some((path) => path.endsWith('/assets/audio/voice/cn/char_e2e/test.mp3')), 'the Chinese voice is cached now: ' + after.join(', '));
    assert.deepEqual(problems, []);
    await page.evaluate(async () => { await window.__res.syncResources(false); await window.__res.clearResources(); });
  });

  test('presets plan all four cards while paused, and voices download independently of other audio', async (t) => {
    const { startServer } = await import('../../server/index.js');
    const own = makeInstall({ voices: true, skins: true, fx: true });
    const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null,
      publicDir: own.publicDir, dataDir: own.dataDir, log: { info() {}, warn() {}, error() {}, debug() {} } });
    t.after(async () => { await game.close(); fs.rmSync(own.dir, { recursive: true, force: true }); });
    const page = await browser.newPage();
    t.after(() => page.close());
    const requests = [];
    game.server.on('request', req => { if (req.url.includes('/assets/')) requests.push(req.url); });
    await page.goto(game.url + '/index.html');
    await ready(page, []);
    await page.click('.res-pill__head');
    await page.waitForSelector('[data-testid="fx-preload"]');
    await page.click('.resource-presets button:nth-child(2)');
    await page.waitForFunction('window.__res.state().voices && !window.__res.state().skinScope.all && window.__res.state().groups.find(g => g.id === "fx").wanted === 0');
    assert.equal(await page.evaluate(() => window.__res.state().enabled), false);
    await page.click('.resource-presets button:nth-child(3)');
    await page.waitForFunction('window.__res.state().allVoices && window.__res.state().skinScope.all');
    assert.equal(await page.$eval('.resource-presets button:nth-child(3)', el => el.getAttribute('aria-pressed')), 'true');
    await page.click('.resource-presets button:first-child');
    await page.waitForFunction('!window.__res.state().voices && !window.__res.state().optional && window.__res.state().tier2Wanted === 0');
    assert.deepEqual(requests, [], 'choosing presets never starts a paused preload');
    await page.waitForFunction(() => [...document.querySelectorAll('.btn')].some(b => b.textContent === '开始预载'));
    await page.click('.resource-modal .modal__actions .btn--primary');
    await page.waitForFunction('window.__res.state().selectionComplete');
    await page.click('[data-testid="voice-preload"]');
    await page.waitForFunction('window.__res.state().phase === "ready" && window.__res.state().tier2Done === 1');
    assert.equal(await page.evaluate(() => window.__res.state().optional), false);
    assert.equal(requests.filter(url => url.includes('/voice/')).length, 1);
    assert.equal(requests.some(url => /skin\/|local\/fx|e2e\/bgm\.mp3/.test(url)), false);
    await page.click('.resource-manager__voice input');
    await page.waitForFunction('window.__res.state().phase === "ready" && window.__res.state().tier2Done === 2');
    assert.equal(requests.filter(url => url.includes('/voice/')).length, 2, 'all languages adds only the missing Japanese voice');
  });

  test('a second tab does not download the same files twice (real Web Locks)', async (t) => {
    const first = await open();
    await ready(first.page, first.problems);
    await first.page.evaluate(() => caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
    const second = await open();
    await ready(second.page, second.problems);
    const requested = [];
    const countRequest = (req) => { if (/\/assets\//.test(req.url)) requested.push(`http://127.0.0.1:${srv.port}${req.url}`); };
    srv.server.on('request', countRequest);
    t.after(() => srv.server.off('request', countRequest));

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
    await page.waitForFunction('window.__res.state().complete === true', { timeout: 20000 })
      .catch(async (err) => { const st = await page.evaluate(() => window.__res.state()); throw new Error(`${err.message} — phase=${st.phase} done=${st.done}/${st.total} wanted=${st.wanted} msg=${st.message} failures=${JSON.stringify(st.failures).slice(0, 300)}`); });
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
    const countRequest = (req) => { if (/\/assets\//.test(req.url)) requested.push(req.url); };
    srv.server.on('request', countRequest);
    t.after(() => srv.server.off('request', countRequest));
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

  test('Chrome imports legacy compressed packages, reports invalid packages and preserves verified progress on corruption/cancel', async (t) => {
    const { page, problems } = await open(); t.after(() => page.close()); await ready(page, problems);
    const result = await page.evaluate(async (files) => {
      const manager = await import('/js/resources/index.js');
      const { importResourceZip, ARCHIVE_MANIFEST } = await import('/js/resources/archive.js');
      const { BlobReader, BlobWriter, ZipWriter } = await import('/vendor/zip.module.js');
      const digest = async (body, algorithm) => [...new Uint8Array(await crypto.subtle.digest(algorithm, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const make = async (version, corrupt = false) => {
        const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level: version === 1 ? 6 : 0 });
        const rows = [];
        for (const [i, file] of files.entries()) {
          const sha1 = await digest(file.body, 'SHA-1');
          rows.push({ path: `resources/${i}`, url: file.url, hash: sha1.slice(0, 12), size: file.body.length,
            ...(version === 1 ? { sha256: await digest(file.body, 'SHA-256') } : { sha1 }) });
          await writer.add(`resources/${i}`, new BlobReader(new Blob([corrupt && i === 1 ? 'x'.repeat(file.body.length) : file.body])));
        }
        await writer.add(ARCHIVE_MANIFEST, new BlobReader(new Blob([JSON.stringify({ format: 'stronghold-resource-zip', version, files: rows })])));
        return writer.close();
      };
      await manager.clearResources();
      let invalid = '';
      try { await manager.importResources(new Blob(['not a ZIP'])); } catch (err) { invalid = err.message; }
      const invalidState = manager.resourceState();
      const legacy = await manager.importResources(await make(1));
      await manager.syncResources(true);
      await manager.clearResources();
      const { store } = await manager.resourceContext();
      let corruption = '';
      try { await importResourceZip(store, await make(2, true), { concurrency: 1 }); } catch (err) { corruption = err.message; }
      const afterCorruption = (await store.status()).count;
      await manager.clearResources();
      const controller = new AbortController(); let cancelled = '';
      try {
        await importResourceZip(store, await make(2), { concurrency: 1, signal: controller.signal,
          onProgress: ({ done }) => { if (done === 1) controller.abort(); } });
      } catch (err) { cancelled = err.name; }
      const afterCancel = (await store.status()).count;
      await manager.syncResources(false); await manager.clearResources();
      return { invalid: !!invalid, invalidStatus: invalidState.archiveResult?.status, invalidError: invalidState.error,
        legacyImported: legacy.imported, corruption, afterCorruption, cancelled, afterCancel };
    }, FILES);
    assert.equal(result.invalid, true); assert.equal(result.invalidStatus, 'error'); assert.equal(result.invalidError, true);
    assert.equal(result.legacyImported, 3); assert.match(result.corruption, /校验失败/); assert.equal(result.afterCorruption, 1);
    assert.equal(result.cancelled, 'AbortError'); assert.equal(result.afterCancel, 1);
    assert.deepEqual(problems, []);
  });

  test('Chrome import supplements host-rewritten CSS/JSON only, and repeating the import needs no downloads', async (t) => {
    const { startServer } = await import('../../server/index.js');
    const install = makeInstall({ dynamic: true });
    const local = await startServer({ port: 0, host: '127.0.0.1', quiet: true, publicDir: install.publicDir,
      dataDir: install.dataDir, store: null, log: { info() {}, warn() {}, error() {}, debug() {} } });
    const page = await browser.newPage();
    t.after(async () => { await page.close(); await local.close(); fs.rmSync(install.dir, { recursive: true, force: true }); });
    const problems = []; page.on('pageerror', (err) => problems.push(err.message));
    await page.goto(`${local.url}/index.html`); await ready(page, problems);
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.state().complete && window.__res.state().phase === "ready"');
    const exported = await page.evaluate(async () => {
      const result = await window.__res.exportResources(); window.__package = result.blob;
      await window.__res.clearResources(); return result.count;
    });
    assert.equal(exported, 5);
    const requested = [];
    local.server.on('request', (req) => { if (/\/(assets|fonts)\//.test(req.url)) requested.push(req.url); });
    const result = await page.evaluate(async () => {
      const outcome = await window.__res.importResources(window.__package);
      return { imported: outcome.imported, skipped: outcome.skippedPackage, fingerprint: outcome.skipReasons.fingerprint };
    });
    await page.waitForFunction('window.__res.state().complete && window.__res.state().phase === "ready"');
    assert.deepEqual(result, { imported: 3, skipped: 2, fingerprint: 2 });
    assert.equal(requested.length, 2);
    assert.ok(requested.some((url) => url.endsWith('/fonts/fonts.css')));
    assert.ok(requested.some((url) => url.endsWith('/assets/local/map/common/materials.json')));
    requested.length = 0;
    const repeat = await page.evaluate(async () => {
      const outcome = await window.__res.importResources(window.__package);
      return { imported: outcome.imported, already: outcome.already, skipped: outcome.skippedPackage };
    });
    await page.waitForFunction('window.__res.state().complete && window.__res.state().phase === "ready"');
    assert.deepEqual(repeat, { imported: 0, already: 3, skipped: 2 });
    assert.deepEqual(requested, []); assert.deepEqual(problems, []);
  });

  test('manager exposes storage and cleanup controls, preserving required resources and personal settings', async (t) => {
    const { page, problems } = await open(); t.after(() => page.close()); await ready(page, problems);
    await page.evaluate(async () => { await window.__res.clearResources(); window.__preload(true); });
    await page.waitForFunction('window.__res.state().complete');
    await page.evaluate(() => { localStorage.setItem('sp.pref.settings', JSON.stringify({ voiceLang: 'jp', bgm: 0.23 })); window.__res.click(); });
    await page.waitForSelector('.resource-cache');
    assert.match(await page.$eval('.resource-cache', (el) => el.textContent), /预计新增/);
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent === '清理可选资源').click());
    await page.waitForFunction('!window.__res.state().clearing && !window.__res.state().optional && window.__res.state().tier2Done === 0');
    const required = await page.evaluate(() => ({ done: window.__res.state().tier1Done, total: window.__res.state().tier1Total,
      settings: JSON.parse(localStorage.getItem('sp.pref.settings')) }));
    assert.equal(required.done, required.total); assert.ok(required.done > 0);
    assert.deepEqual(required.settings, { voiceLang: 'jp', bgm: 0.23 });
    await page.waitForFunction('window.__res.state().phase === "ready"');
    assert.equal(await page.$eval('.resource-manager__voice input', (el) => el.disabled), true);
    await page.click('[data-testid="voice-preload"]');
    await page.$eval('.resource-card__details', (el) => { el.open = true; });
    await page.click('[data-testid="optional-preload"]');
    await page.waitForFunction('window.__res.state().phase === "ready" && window.__res.state().optional');
    await page.click('.resource-manager__voice input');
    await page.waitForFunction('window.__res.state().allVoices');
    await page.waitForFunction('window.__res.state().phase === "ready"');
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent === '清理全部资源').click());
    await page.waitForFunction('!window.__res.state().clearing && window.__res.state().done === 0');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.settings'))), required.settings);
    assert.deepEqual(await page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith('stronghold-resources-'))), []);
    assert.deepEqual(problems, []);
  });

  test('voice tabs download Chinese by default, add Japanese on switch, retain both; game loads fill the verified cache', { timeout: 60000 }, async (t) => {
    const { startServer } = await import('../../server/index.js');
    const install = makeInstall({ voices: true });
    const local = await startServer({ port: 0, host: '127.0.0.1', quiet: true, publicDir: install.publicDir,
      dataDir: install.dataDir, store: null, log: { info() {}, warn() {}, error() {}, debug() {} } });
    const page = await browser.newPage();
    t.after(async () => { await page.close(); await local.close(); fs.rmSync(install.dir, { recursive: true, force: true }); });
    const counts = { cn: 0, jp: 0 };
    local.server.on('request', (req) => { const lang = /\/voice\/(cn|jp)\//.exec(req.url)?.[1]; if (lang) counts[lang]++; });
    const problems = []; page.on('pageerror', (err) => problems.push(err.message));
    await page.goto(`${local.url}/index.html`); await ready(page, problems);
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.state().selectionComplete && window.__res.state().phase === "ready"');
    assert.deepEqual(counts, { cn: 1, jp: 0 });
    await page.waitForFunction('!!navigator.serviceWorker.controller');
    await page.evaluate(() => window.__res.click()); await page.waitForSelector('.resource-voice-tabs');
    await page.click('.resource-voice-tabs button:nth-child(2)');
    await page.waitForFunction('window.__res.state().voiceLang === "jp" && window.__res.state().phase === "ready"');
    assert.deepEqual(counts, { cn: 1, jp: 1 });
    await page.click('.resource-voice-tabs button:first-child');
    await page.waitForFunction('window.__res.state().voiceLang === "cn" && window.__res.state().phase === "ready"');
    assert.deepEqual(counts, { cn: 1, jp: 1 }, 'switching back reuses the Chinese voice');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const layout = await page.$eval('.resource-modal', (el) => ({ width: el.getBoundingClientRect().width, overflow: el.scrollWidth > el.clientWidth + 1 }));
    assert.ok(layout.width <= 390); assert.equal(layout.overflow, false);
    const out = path.join(ROOT, '.state'); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'resource-manager-mobile.png') });
    await page.setViewport({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(out, 'resource-manager-desktop.png') });
    // Clear pauses bulk downloads but keeps the worker: the next request comes only from the game.
    await page.evaluate(async () => { await window.__res.clearResources(); });
    await page.waitForFunction('!!navigator.serviceWorker.controller');
    const jpUrl = await page.evaluate(async () => (await fetch('/data/resource-manifest.json').then((r) => r.json())).files.find((f) => f.url.includes('/voice/jp/')).url);
    assert.equal(await page.evaluate((url) => fetch(url).then((r) => r.text()), jpUrl), 'jp-voice');
    assert.equal(counts.jp, 2);
    await page.setOfflineMode(true);
    assert.equal(await page.evaluate((url) => fetch(url).then((r) => r.text()), jpUrl), 'jp-voice');
    await page.setOfflineMode(false);
    const gameExport = await page.evaluate(async () => {
      const result = await window.__res.exportResources();
      const { store } = await (await import('/js/resources/index.js')).resourceContext();
      const { importResourceZip } = await import('/js/resources/archive.js');
      await window.__res.clearResources();
      const imported = await importResourceZip(store, result.blob);
      return { count: result.count, imported: imported.imported };
    });
    assert.deepEqual(gameExport, { count: 1, imported: 1 }, 'game-cached Japanese voice exports even before index adoption, with Chinese selected');
    await page.click('.resource-voice-tabs button:nth-child(2)');
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.state().selectionComplete && window.__res.state().phase === "ready"');
    assert.equal(counts.jp, 2, 'bulk preload verifies and adopts game-cached bytes without downloading again');
    assert.deepEqual(problems, []);
  });

  test('a cache inspection completed after cleanup cannot restore stale counters or errors', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(srv.url);
      await page.waitForFunction('window.__ready');
      const result = await page.evaluate(async () => {
        const api = await import('/js/resources/index.js');
        const { store } = await api.resourceContext();
        const status = store.status.bind(store);
        const old = await status();
        let release, entered;
        const ready = new Promise((resolve) => { entered = resolve; });
        store.status = () => new Promise((resolve) => { release = resolve; entered(); });
        const inspection = api.inspectResources();
        await ready;
        store.status = status;
        await api.clearResources();
        const clean = api.resourceState();
        release({ ...old, count: 999, bytes: 999999 });
        await inspection;
        return { clean, after: api.resourceState() };
      });
      assert.deepEqual(result.after, result.clean);
      assert.equal(result.after.done, 0);
    } finally { await page.close(); }
  });

  test('rapid enable, disable, enable drains the cancelled run and reaches ready', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(srv.url);
      await page.waitForFunction('window.__ready');
      await page.evaluate(async () => {
        const api = await import('/js/resources/index.js');
        await api.clearResources();
        const first = api.syncResources(true);
        await api.syncResources(false);
        await api.syncResources(true);
        await first;
      });
      await page.waitForFunction('window.__res.resourceState().phase === "ready"');
      assert.equal(await page.evaluate(() => window.__res.resourceState().selectionComplete), true);
    } finally { await page.close(); }
  });
});
