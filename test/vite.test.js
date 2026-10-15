// Production artifacts, immutable lazy chunks and deterministic simulation parity.
// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createStaticHandler } from '../server/index.js';
import { getData } from '../server/data.js';
import * as nativeSpec from '../server/sim/spec.js';
import { DataSource } from '../server/sim/simdata.js';
import { SIM_DATA_FILES } from '../public/js/battle/simLoader.js';
import { scenariosOf } from '../tools/golden.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let temp, publicDir, outDir, manifest, server, origin;

before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-vite-'));
  await fs.writeFile(path.join(temp, 'package.json'), '{"type":"module"}');
  publicDir = path.join(temp, 'public');
  outDir = path.join(publicDir, 'build');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'index.html'), '<html>source client</html>');
  await fs.mkdir(path.join(outDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'assets', 'retained-abcdefgh.js'), 'export const previous = true;');
  await build({ configFile: path.join(root, 'vite.config.js'), logLevel: 'silent', build: { outDir } });
  manifest = JSON.parse(await fs.readFile(path.join(outDir, '.vite/manifest.json'), 'utf8'));
  const handler = createStaticHandler({ publicDir, dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'),
    assetsCdn: 'https://art.example/game', assetsCdnVersion: '0123456789abcdef' });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handler(req, res, url.pathname, url.search.slice(1)).catch((err) => { res.statusCode = 500; res.end(String(err)); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

test('the production bundle carries the management density layer after the touch/game styles', async () => {
  const cssFiles = [...new Set((manifest['index.html']?.css || []).concat(
    Object.values(manifest).filter((e) => e.isEntry && e.css).flatMap((e) => e.css)))];
  assert.ok(cssFiles.length, 'the entry exposes a stylesheet');
  const css = (await Promise.all(cssFiles.map((file) => fs.readFile(path.join(outDir, file), 'utf8')))).join('\n');
  assert.match(css, /\.modal--utility/);
  assert.match(css, /--utility-text:\s*max\(var\(--t\),\s*64px\)/);
  assert.match(css, /\.room-screen--coop/);
  assert.match(css, /\.room-topbar__tools/);
  assert.match(css, /\.rotate-hint__fullscreen/);
  assert.match(css, /grid-template-areas:[^;}]*controls title invite/);
  // The compact overrides must land after the rules they override, and the landscape gate must survive
  // the concatenation: theme.css (base + gate) → … → devices.css → utility-mobile.css.
  assert.ok(css.indexOf('.modal--utility') > css.indexOf('.modal__box'), 'the density layer follows components.css');
  assert.ok(css.lastIndexOf('.room-screen .room-bar') > css.indexOf('.room-bar::before'), 'and room.css');
  assert.match(css, /\.sp-rotatable \.rotate-hint\s*\{\s*display:\s*grid/);
  // theme.css stays the only place that defines the text root: the new layer declares --utility-text and nothing else
  const themeSource = await fs.readFile(path.join(root, 'public/css/theme.css'), 'utf8');
  const count = (text, re) => (text.match(re) || []).length;
  assert.equal(count(css, /--t\s*:/g), count(themeSource, /--t\s*:/g), 'no stylesheet may add a --t definition');
});

test('built pages preserve runtime CDN/version injection and serve immutable compressed artifacts', async () => {
  for (const route of ['/', '/index.html', '/build/index.html']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const html = await response.text();
    assert.match(html, /src="\/build\/assets\/index-[\w-]+\.js"/);
    assert.match(html, /onerror="window\.__spBootFail/);
    assert.match(html, /globalThis\.__spAssetCdn=/);
    assert.match(html, /globalThis\.__spRuntimeVersion=/);
    assert.match(html, /https:\/\/art\.example\/game/);
    assert.doesNotMatch(html, /type="importmap"|href="\/css\//);
    for (const [, url] of html.matchAll(/(?:src|href)="(\/build\/assets\/[^" ]+)"/g)) {
      const asset = await fetch(origin + url);
      assert.equal(asset.status, 200, url);
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable', url);
      if (/\.(?:js|css)$/.test(url)) assert.equal(asset.headers.get('content-encoding'), 'gzip', url);
      assert.equal((await fetch(origin + url, { headers: { 'If-None-Match': asset.headers.get('etag') } })).status, 304);
      await asset.arrayBuffer();
    }
  }
  const js = await Promise.all(Object.values(manifest).filter((m) => m.file.endsWith('.js'))
    .map((m) => fs.readFile(path.join(outDir, m.file), 'utf8')));
  assert.ok(js.every((s) => !/node:fs|node:path|nodeData\.js|__vite-browser-external/.test(s)), 'no Node data loader leaks');
  assert.equal((await fetch(origin + '/build/.vite/manifest.json')).status, 404);
});

test('source mode remains available and old built chunks survive a subsequent build', async () => {
  const old = await fetch(origin + '/build/assets/retained-abcdefgh.js');
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await old.text(), /previous = true/);
  const handler = createStaticHandler({ publicDir, dataDir: path.join(root, 'data'),
    sharedDir: path.join(root, 'shared'), clientBuild: false });
  const source = http.createServer((req, res) => { void handler(req, res, '/', ''); });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  try {
    const html = await (await fetch(`http://127.0.0.1:${source.address().port}/`)).text();
    assert.match(html, /source client/);
    assert.doesNotMatch(html, /src="\/build\//);
  } finally { await new Promise((resolve) => source.close(resolve)); }
});

test('simulation, renderer, Three.js and ZIP remain outside the initial module graph', () => {
  const seen = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dependency of manifest[key].imports || []) visit(dependency);
  }
  visit('index.html');
  const initial = [...seen].map((key) => manifest[key].name);
  for (const name of ['simulation', 'app', 'three', 'archive']) assert.ok(!initial.includes(name), `${name} remains lazy`);
  assert.ok(Object.values(manifest).some((entry) => entry.name === 'archive' && entry.isDynamicEntry));
});

test('the simulation the browser runs is served unbundled: /sim modules as written, data over HTTP', async () => {
  // v0.3.0 moved the loader into public/js/battle/simLoader.js, which imports the /sim modules at run time: nothing
  // reaches server/sim statically any more, so there is no bundle copy of the engine left to drift. The page (and its
  // workers) run the modules the server itself runs, which is also why the /sim/ mount may serve them raw.
  assert.ok(!Object.values(manifest).some((m) => m.name === 'simulation'), 'the simulation stays out of the bundle');

  const simDir = path.join(root, 'server', 'sim');
  for (const rel of ['spec.js', 'simdata.js', 'content/support/index.js']) {
    const res = await fetch(origin + '/sim/' + rel);
    assert.equal(res.status, 200, '/sim/' + rel);
    assert.match(res.headers.get('content-type') || '', /javascript/i, '/sim/' + rel + ' is served as JavaScript');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), await fs.readFile(path.join(simDir, rel)), rel + ': served as written');
  }
  // The Node-only data loader is private (server/http/static.js SIM_PRIVATE) and the only server/sim module that
  // imports a builtin: that is what makes serving the folder raw safe for a browser.
  assert.equal((await fetch(origin + '/sim/nodeData.js')).status, 404, 'the Node data loader stays private');
  const stack = [simDir];
  const builtinImporters = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if ((await fs.readFile(abs, 'utf8')).includes("from 'node:")) builtinImporters.push(path.relative(simDir, abs));
    }
  }
  assert.deepEqual(builtinImporters.sort(), ['nodeData.js'], 'only the private Node loader needs a builtin');

  // The data the loader fetches (simLoader reads /data/<name>.json for the frozen page copy) drives the same engine
  // to the identical result as the server's own data object on the parity scenarios.
  const served = {};
  for (const name of SIM_DATA_FILES) {
    const res = await fetch(origin + '/data/' + name + '.json');
    assert.equal(res.status, 200, '/data/' + name + '.json');
    served[name] = await res.json();
  }
  const native = getData({ log: { warn() {} } });
  for (const name of SIM_DATA_FILES) assert.deepEqual(served[name], native[name], name + '.json: served as loaded');
  const fromServer = new DataSource(native);
  const fromHttp = new DataSource(served);
  const selected = [
    ...scenariosOf('roster').filter((sc) => ['roster-039', 'roster-042'].includes(sc.id)),
    ...scenariosOf('bonds').filter((sc) => ['bond-egirShip-high', 'bond-raidShip-high', 'bond-steadShip-high'].includes(sc.id)),
    ...scenariosOf('standins').filter((sc) => ['standin-01', 'standin-09'].includes(sc.id)),
    ...scenariosOf('diy').filter((sc) => ['diy-001', 'diy-019', 'diy-048', 'diy-100', 'diy-135', 'diy-136'].includes(sc.id)),
  ];
  assert.equal(selected.length, 13);
  for (const sc of selected) {
    const input = nativeSpec.buildBattleSpec({ ...sc, battleId: sc.id, fieldId: sc.fieldId ?? 'g', content: 'full' });
    const options = { quiet: true, recordEvents: true };
    const server = nativeSpec.createBattleFromSpec(input, fromServer, options);
    const page = nativeSpec.createBattleFromSpec(input, fromHttp, options);
    server.runToEnd(sc.cap ?? 300);
    page.runToEnd(sc.cap ?? 300);
    assert.ok(server.finished && page.finished, sc.id);
    assert.equal(server.errors.length, 0, sc.id);
    assert.equal(page.errors.length, 0, sc.id);
    assert.deepEqual(nativeSpec.compactResult(page.result()), nativeSpec.compactResult(server.result()), sc.id);
    assert.deepEqual(page.snapshot(), server.snapshot(), sc.id + ': snapshot');
    assert.deepEqual(page.drainEvents(), server.drainEvents(), sc.id + ': events');
    assert.deepEqual(page.allyUnits.map((u) => Object.keys(u.kit || {})), server.allyUnits.map((u) => Object.keys(u.kit || {})), sc.id);
  }
});
