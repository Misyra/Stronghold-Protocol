// Opt-in browser regression against a raw-object CDN (no CSS/JSON rewrite, like R2).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const manifestFile = path.join(ROOT, '.assets-manifest.json');
const enabled = process.env.SP_E2E === '1' && fs.existsSync(CHROME) && fs.existsSync(manifestFile);
test('real browser requests independently hashed fonts, Spine pages and map tiles', {
  skip: enabled ? false : 'set SP_E2E=1 (needs Chrome, downloaded art and .assets-manifest.json)', timeout: 90000,
}, async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const root = path.join(ROOT, 'public');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const requests = [], failures = [], vendorResponses = [];
  const trace = (stage) => { if (process.env.SP_CDN_TRACE === '1') console.info('[cdn browser]', stage, requests.length); };
  const mime = { '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.otf': 'font/otf', '.ttf': 'font/ttf', '.atlas': 'text/plain' };
  const cdn = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => cdn.listen(0, '127.0.0.1', resolve));
  const cdnBase = `http://127.0.0.1:${cdn.address().port}`;
  let game, browser;
  try {
    game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, clientBuild: false,
      assetsCdn: cdnBase, assetsCdnVersion: '', assetsManifestFile: manifestFile });
    trace('server ready');
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
      args: ['--no-first-run', '--no-sandbox', '--enable-unsafe-swiftshader'], protocolTimeout: 60000 });
    trace('browser launched');
    const page = await browser.newPage();
    trace('browser ready');
    page.on('console', (message) => {
      if (process.env.SP_CDN_TRACE === '1' && message.text().startsWith('[cdn evaluation]')) console.info(message.text());
    });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (url.startsWith(cdnBase + '/')) requests.push(url);
      if (/^https?:/.test(url) && !url.startsWith(cdnBase + '/') && !url.startsWith(game.url + '/')) void req.abort();
      else void req.continue();
    });
    page.on('response', r => {
      if (r.url().startsWith(cdnBase + '/') && r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
      if (r.url().startsWith(game.url + '/') && /\/vendor\/(?:pixi\.min|pixi-spine)\.js$/.test(new URL(r.url()).pathname)) {
        vendorResponses.push({ path: new URL(r.url()).pathname, status: r.status(), cache: r.headers()['cache-control'] });
      }
    });
    await page.goto(game.url + '/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
    trace('page ready');
    const result = await page.evaluate(async (tracing) => {
      const trace = (stage) => { if (tracing) console.info('[cdn evaluation]', stage); };
      const { resourceUrl, resourceReady } = await import('/js/resourceUrl.js');
      const { ensurePixi } = await import('/js/render/app/pixi.js');
      const { loadSpineData, unloadSpineData, createAssets } = await import('/js/assets.js');
      const { loadBoardPack } = await import('/js/render/board3d/load.js');
      const { loadBoardArt } = await import('/js/render/boardArt.js');
      await resourceReady();
      trace('manifest ready');
      const fonts = await Promise.all(['400 16px Bender', '300 16px Bender', '400 16px "Novecento Wide"'].map(f => document.fonts.load(f)));
      trace('fonts ready');
      const PIXI = await ensurePixi();
      trace('pixi ready');
      const entries = await (await fetch(resourceUrl('/data/assets.json'))).json();
      const entry = entries.enemies.enemy_1000_gopro_2.spine;
      const first = await loadSpineData(entry);
      trace('first model ready');
      const spine = new PIXI.spine.Spine(first);
      spine.state.setAnimation(0, 'Idle', true);
      spine.update(0.1);
      const used = spine.skeleton.slots.map(s => s.currentSprite || s.currentMesh).filter(s => s?.texture);
      const alive = used.length > 0 && used.every(s => s.texture.baseTexture.valid && !s.texture.baseTexture.destroyed);
      spine.destroy({ children: true, texture: false, baseTexture: false });
      trace('first actor destroyed');
      await unloadSpineData(entry, first);
      trace('first unloaded');
      const second = await loadSpineData(entry);
      trace('second loaded');
      const renderer = new PIXI.Renderer({ width: 160, height: 160 });
      const reloads = [];
      const entriesToReload = [entry, entries.chars.char_102_texas.spine.front, entries.chars.char_102_texas.spine.back,
        entries.chars.char_010_chen.spine.front, entries.chars.char_010_chen.spine.back];
      for (let i = 0; i < 5; i++) for (const currentEntry of entriesToReload) {
        trace(`cycle ${i} ${currentEntry.skel}`);
        const current = i === 0 && currentEntry === entry ? second : await loadSpineData(currentEntry);
        const model = new PIXI.spine.Spine(current);
        model.autoUpdate = false;
        model.state.setAnimation(0, currentEntry.anims.idle, true);
        model.update(0.1);
        const textures = model.skeleton.slots.map(s => (s.currentSprite || s.currentMesh)?.texture).filter(Boolean);
        const live = textures.length > 0 && textures.every(t => t.baseTexture?.valid && !t.baseTexture.destroyed);
        if (!live) {
          reloads.push({ live, ink: 0, skel: currentEntry.skel });
          model.destroy({ children: true, texture: false, baseTexture: false });
          await unloadSpineData(currentEntry, current);
          continue;
        }
        const pixels = renderer.extract.pixels(model);
        let ink = 0;
        for (let p = 3; p < pixels.length; p += 4) if (pixels[p]) ink++;
        reloads.push({ live, ink });
        model.destroy({ children: true, texture: false, baseTexture: false });
        await unloadSpineData(currentEntry, current);
      }
      renderer.destroy();
      trace('reload cycles done');
      const store = createAssets();
      const pack = await loadBoardPack(store);
      const board2d = await loadBoardArt(store);
      trace('board ready');
      return { fonts: fonts.map(f => f.length), animations: second.animations.length, alive, reloaded: second !== first, reloads, board: !!pack?.images.D, tiles: !!pack?.tiles, board2d: !!board2d?.images.D, css: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(l => l.includes('/fonts/')) };
    }, process.env.SP_CDN_TRACE === '1');
    trace('resources rendered');
    assert.deepEqual(failures, []);
    assert.ok(result.fonts.every(n => n > 0), 'all three font faces load');
    assert.ok(result.alive && result.reloaded && result.animations > 0, 'Spine loads with live page textures and survives unload/reload');
    assert.equal(result.reloads.length, 25, 'front/back models and an enemy each survive five complete unload/reload cycles');
    assert.ok(result.reloads.every(r => r.live && r.ink > 0), `every reloaded skeleton draws real pixels: ${JSON.stringify(result.reloads)}`);
    assert.ok(result.board && result.tiles, 'map images and independently hashed tiles load');
    assert.ok(result.board2d, 'the 2D board also loads its independently hashed crop table');
    assert.ok(result.css.some(u => /^\/_v\/[a-f0-9]{16}\/fonts\/fonts.css$/.test(u)), 'font CSS uses the game transformer');
    assert.ok(vendorResponses.some(r => r.path.endsWith('/pixi.min.js')) && vendorResponses.some(r => r.path.endsWith('/pixi-spine.js')), 'both renderer scripts load');
    for (const response of vendorResponses) {
      assert.match(response.path, /^\/_v\/[a-f0-9]{16}\/vendor\//, 'actual renderer loading shares the versioned prefetch URL');
      assert.equal(response.status, 200);
      assert.match(response.cache, /max-age=31536000.*immutable/, 'renderer scripts keep immutable browser caching');
    }
    for (const url of requests) {
      const u = new URL(url), hash = manifest.hashes[decodeURI(u.pathname)];
      assert.ok(hash, `test requested a published resource: ${u.pathname}`);
      assert.equal(u.searchParams.get('v'), hash, `each actual request has its own hash: ${u.pathname}`);
    }
    assert.ok(requests.some(u => u.includes('.atlas?v=')) && requests.some(u => u.includes('.skel?v=')) && requests.some(u => u.includes('/tiles.json?v=')));
  } finally {
    await browser?.close();
    await game?.close();
    await new Promise(resolve => cdn.close(resolve));
  }
});
