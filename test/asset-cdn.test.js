import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { readAssetsCdnVersionFile, readAssetsManifestFile } from '../server/assetVersion.js';
import { assetCdnSettings, assetCdnUrl, cdnLatestUrl, resolveAssetsCdnVersion } from '../shared/assetCdn.js';
import { resourceUrl, resourceCache, resourceReady } from '../public/js/resourceUrl.js';
import { mediaUrl } from '../public/js/media.js';
import { validSpine, loadSpineData, createAssets, unloadSpineData } from '../public/js/assets.js';

test('CDN settings validate public bases and rewrite art without leaking the game version', () => {
  assert.deepEqual(assetCdnSettings(' https://game.misyra.com/ ', ''), { base: 'https://game.misyra.com', version: '' });
  for (const bad of ['javascript:alert(1)', '/cdn', 'https://u:p@cdn.example', 'https://cdn.example?v=1', 'https://cdn.example/#x']) {
    assert.throws(() => assetCdnSettings(bad));
  }
  assert.throws(() => assetCdnSettings('https://cdn.example', 'not-a-version'));
  assert.throws(() => assetCdnSettings('', '1234567890abcdef'));
  const cdn = assetCdnSettings('https://cdn.example/static', '1234567890abcdef');
  assert.equal(assetCdnUrl('/_v/aaaaaaaaaaaaaaaa/assets/x.skel', cdn), 'https://cdn.example/static/_v/1234567890abcdef/assets/x.skel');
  assert.equal(assetCdnUrl('/fonts/a.woff2?x=1#f', cdn), 'https://cdn.example/static/_v/1234567890abcdef/fonts/a.woff2?x=1#f');
  assert.equal(validSpine({ skel: 'https://cdn.example/a.skel', atlas: 'https://cdn.example/a.atlas', anims: {} }), true);
  assert.equal(validSpine({ skel: 'https://cdn.example/a.skel?v=0123456789abcdef', atlas: 'https://cdn.example/a.atlas?v=0123456789abcdef', anims: {} }), true, 'the per-file cache-bust query is allowed');
  for (const skel of ['javascript:alert(1).skel', 'data:application/octet-stream,x.skel', 'https://u:p@cdn.example/a.skel', 'https://cdn.example/a.png',
    'https://cdn.example/a.skel?v=short', 'https://cdn.example/a.skel?x=1', 'https://cdn.example/a.skel?v=0123456789abcdef&x=1', 'https://cdn.example/a.skel#v=0123456789abcdef']) {
    assert.equal(validSpine({ skel, atlas: 'x', anims: {} }), false);
  }
  for (const url of ['/data/assets.json', '/js/main.js', '/vendor/pixi.min.js', '/api/rooms/ABCD/status', '/ws', 'https://third.example/assets/x.png']) {
    assert.equal(assetCdnUrl(url, cdn), url);
  }
});

test('a per-file manifest turns art into immutable ?v= URLs and falls back to bare for unlisted files', () => {
  const cdn = { base: 'https://cdn.example/static', version: '', manifest: '/assets-manifest.json?v=1234567890abcdef', hashes: { '/assets/x.skel': 'aaaaaaaaaaaaaaaa', '/assets/[opt]x.png': 'bbbbbbbbbbbbbbbb' } };
  assert.equal(assetCdnUrl('/assets/x.skel', cdn), 'https://cdn.example/static/assets/x.skel?v=aaaaaaaaaaaaaaaa');
  assert.equal(assetCdnUrl('/assets/x.skel?v=2#f', cdn), 'https://cdn.example/static/assets/x.skel?v=aaaaaaaaaaaaaaaa', 'the per-file hash replaces any caller query');
  assert.equal(assetCdnUrl('/assets/other.png', cdn), 'https://cdn.example/static/assets/other.png', 'an unlisted file falls back to bare');
  assert.equal(assetCdnUrl('/_v/deadbeefdeadbeef/assets/x.skel', cdn), 'https://cdn.example/static/assets/x.skel?v=aaaaaaaaaaaaaaaa', 'the game-host namespace is stripped first');
  assert.equal(assetCdnUrl('/assets/x.skel', { ...cdn, hashes: null }), 'https://cdn.example/static/assets/x.skel', 'before the manifest loads, bare URLs answer');
  assert.equal(assetCdnUrl('/assets/x.skel', { ...cdn, manifest: '', version: '1234567890abcdef', hashes: null }), 'https://cdn.example/static/_v/1234567890abcdef/assets/x.skel', 'no manifest: the legacy release prefix');
  assert.equal(assetCdnUrl('https://cdn.example/static/assets/x.skel', cdn), 'https://cdn.example/static/assets/x.skel?v=aaaaaaaaaaaaaaaa', 'derived absolute CDN URLs gain their own hash');
  assert.equal(assetCdnUrl('https://cdn.example/static/assets/%5Bopt%5Dx.png', cdn), 'https://cdn.example/static/assets/%5Bopt%5Dx.png?v=bbbbbbbbbbbbbbbb', 'encoded filenames match the manifest key');
  const retry = 'https://cdn.example/static/assets/x.skel?v=aaaaaaaaaaaaaaaa&sp=retry';
  assert.equal(assetCdnUrl(retry, cdn), retry, 'keep published hashes and integrity retry parameters');
  assert.equal(assetCdnUrl('/fonts/fonts.css', cdn), '/fonts/fonts.css', 'nested font URLs require game-host CSS transformation');
});

test('image requests wait for the hash manifest, and imageNow uses the same versioned key', async (t) => {
  const previous = { cdn: globalThis.__spAssetCdn, ready: globalThis.__spManifestReady };
  t.after(() => { globalThis.__spAssetCdn = previous.cdn; globalThis.__spManifestReady = previous.ready; });
  globalThis.__spAssetCdn = { base: 'https://cdn.example', manifest: '/assets-manifest.json?v=1234567890abcdef' };
  let publish;
  globalThis.__spManifestReady = new Promise((resolve) => { publish = resolve; });
  const calls = [];
  const store = createAssets({ loadImage: async (src) => { calls.push(src); return { src }; } });
  const pending = store.image('https://cdn.example/assets/x.png');
  await Promise.resolve();
  assert.deepEqual(calls, [], 'no bare request while the manifest is pending');
  publish({ hashes: { '/assets/x.png': 'aaaaaaaaaaaaaaaa' } });
  const image = await pending;
  assert.deepEqual(calls, ['https://cdn.example/assets/x.png?v=aaaaaaaaaaaaaaaa']);
  assert.equal(store.imageNow('/assets/x.png'), image);
  assert.equal(await store.image('/assets/x.png'), image);
});

test('a failed hash manifest keeps the available bare image fallback', async (t) => {
  const previous = { cdn: globalThis.__spAssetCdn, ready: globalThis.__spManifestReady };
  t.after(() => { globalThis.__spAssetCdn = previous.cdn; globalThis.__spManifestReady = previous.ready; });
  globalThis.__spAssetCdn = { base: 'https://cdn.example', manifest: '/assets-manifest.json?v=1234567890abcdef' };
  globalThis.__spManifestReady = Promise.reject(new Error('offline'));
  const store = createAssets({ loadImage: async (src) => ({ src }) });
  assert.equal((await store.image('/assets/x.png')).src, 'https://cdn.example/assets/x.png');
});

test('a stalled manifest cannot block loading forever, and late hashes still take effect', async (t) => {
  const previous = { cdn: globalThis.__spAssetCdn, ready: globalThis.__spManifestReady };
  t.after(() => { globalThis.__spAssetCdn = previous.cdn; globalThis.__spManifestReady = previous.ready; });
  globalThis.__spAssetCdn = { base: 'https://cdn.example', manifest: '/assets-manifest.json?v=1234567890abcdef' };
  let publish;
  globalThis.__spManifestReady = new Promise((resolve) => { publish = resolve; });
  await resourceReady(5);
  assert.equal(resourceUrl('/assets/x.png'), 'https://cdn.example/assets/x.png');
  publish({ hashes: { '/assets/x.png': 'aaaaaaaaaaaaaaaa' } });
  await Promise.resolve();
  assert.equal(resourceUrl('/assets/x.png'), 'https://cdn.example/assets/x.png?v=aaaaaaaaaaaaaaaa');
});

test('Spine parses independently hashed atlas/pages and unloads those same keys', async (t) => {
  const previous = { cdn: globalThis.__spAssetCdn, pixi: globalThis.PIXI, fetch: globalThis.fetch };
  t.after(() => { globalThis.__spAssetCdn = previous.cdn; globalThis.PIXI = previous.pixi; globalThis.fetch = previous.fetch; });
  globalThis.__spAssetCdn = {
    base: 'https://cdn.example', manifest: '/assets-manifest.json?v=1234567890abcdef',
    hashes: { '/assets/x.skel': 'aaaaaaaaaaaaaaaa', '/assets/x.atlas': 'bbbbbbbbbbbbbbbb', '/assets/x.png': 'cccccccccccccccc', '/assets/x2.png': 'dddddddddddddddd' },
  };
  const calls = [], unloaded = [];
  const texture = { baseTexture: {} };
  const parsedAtlas = { pages: [] };
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, text: async () => 'atlas text' }; };
  globalThis.PIXI = { spine: { TextureAtlas: class {
    constructor(text, loadPage, done) {
      assert.equal(text, 'atlas text');
      let remaining = 2;
      for (const name of ['x.png', 'x2.png']) loadPage(name, (base) => {
        assert.equal(base, texture.baseTexture);
        if (!--remaining) done(parsedAtlas);
      });
    }
  } }, Assets: {
    load: async (source) => { calls.push(source); return { animations: [] }; },
    unload: async (url) => { unloaded.push(url); },
    loader: { load: async (url) => { calls.push(url); return texture; }, unload: async (url) => { unloaded.push(url); } },
  } };
  const entry = { skel: 'https://cdn.example/assets/x.skel?v=aaaaaaaaaaaaaaaa', atlas: 'https://cdn.example/assets/x.atlas?v=bbbbbbbbbbbbbbbb', textures: ['https://cdn.example/assets/x.png', '/assets/x2.png'] };
  await loadSpineData(entry);
  assert.equal(calls[0], entry.atlas);
  assert.deepEqual(calls.slice(1, 3), ['https://cdn.example/assets/x.png?v=cccccccccccccccc', 'https://cdn.example/assets/x2.png?v=dddddddddddddddd']);
  assert.deepEqual(calls[3], { src: entry.skel, data: { spineAtlas: parsedAtlas } });
  await unloadSpineData(entry);
  assert.deepEqual(new Set(unloaded), new Set([entry.skel, ...calls.slice(1, 3)]));
});

test('browser helpers honor CDN configuration and preserve remote audio URLs', (t) => {
  const previous = globalThis.__spAssetCdn;
  t.after(() => { if (previous === undefined) delete globalThis.__spAssetCdn; else globalThis.__spAssetCdn = previous; });
  globalThis.__spAssetCdn = assetCdnSettings('https://cdn.example');
  assert.equal(resourceUrl('/_v/aaaaaaaaaaaaaaaa/assets/a.png'), 'https://cdn.example/assets/a.png');
  assert.equal(resourceCache(resourceUrl('/assets/a.png')), 'default');
  assert.equal(resourceUrl('/data/chess.json', 'aaaaaaaaaaaaaaaa'), '/_v/aaaaaaaaaaaaaaaa/data/chess.json');
  assert.equal(mediaUrl(resourceUrl('/assets/audio/bgm/a.mp3'), 'https://game.example'), 'https://cdn.example/assets/audio/bgm/a.mp3');
  globalThis.__spAssetCdn = assetCdnSettings('https://cdn.example', '1234567890abcdef');
  assert.equal(resourceCache(resourceUrl('/assets/local/tiles.json')), 'default');
});

test('two hosts keep independent release versions, serve public CORS and retain local code/data/socket routes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
  };
  write('public/index.html', '<html><head><link href="/fonts/fonts.css"><script type="importmap">{"imports":{"preact":"/vendor/preact.js"}}</script></head><script src="/js/main.js"></script></html>');
  write('public/js/main.js', 'export const ready = true;');
  write('public/css/a.css', "a{background:url('/assets/x.png')}");
  write('public/fonts/fonts.css', "@font-face{font-family:x;src:url('/fonts/a.woff2')}");
  write('public/fonts/a.woff2', 'font');
  write('public/assets/x.png', 'image');
  write('public/assets/x.skel', 'skeleton');
  write('public/assets/x.atlas', 'x.png\nsize: 1,1\n');
  write('public/assets/audio/a.mp3', '0123456789');
  write('public/assets/local/tiles.json', JSON.stringify({ source: { D: { path: '/assets/x.png' } } }));
  write('data/assets.json', JSON.stringify({ spine: { skel: '/assets/x.skel', atlas: '/assets/x.atlas', textures: ['/assets/x.png'], anims: {} }, audio: '/assets/audio/a.mp3', foreign: 'https://third.example/x.png' }));
  write('data/chess.json', '{}');
  const opts = { port: 0, host: '127.0.0.1', quiet: true, workers: 0, publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'), assetsManifestFile: path.join(root, 'absent') };
  const remote = await startServer(opts);
  t.after(() => remote.close());
  const remoteHealth = await (await fetch(remote.url + '/healthz')).json();
  const game = await startServer({ ...opts, assetsCdn: remote.url, assetsCdnVersion: remoteHealth.artVersion });
  t.after(() => game.close());
  const health = await (await fetch(game.url + '/healthz')).json();
  assert.notEqual(health.artVersion, remoteHealth.artVersion);
  assert.notEqual(health.build, remoteHealth.build);
  assert.equal(health.assetsCdnVersion, remoteHealth.artVersion);
  const localPrefix = `/_v/${health.build}`;
  const remotePrefix = `${remote.url}/_v/${remoteHealth.artVersion}`;
  const html = await (await fetch(game.url + '/')).text();
  assert.ok(html.includes(`href="${remotePrefix}/fonts/fonts.css"`));
  assert.ok(html.includes(`src="${localPrefix}/js/main.js"`));
  const imports = JSON.parse(html.match(/type="importmap">(.*?)<\/script>/)[1]).imports;
  assert.equal(imports.preact, localPrefix + '/vendor/preact.js');
  const manifest = await (await fetch(game.url + localPrefix + '/data/assets.json')).json();
  assert.ok(validSpine(manifest.spine));
  assert.equal(manifest.spine.skel, remotePrefix + '/assets/x.skel');
  assert.equal(manifest.foreign, 'https://third.example/x.png');
  assert.equal(new URL('x.png', manifest.spine.atlas).href, manifest.spine.textures[0]);
  const image = await fetch(manifest.spine.textures[0], { headers: { Origin: game.url } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('access-control-allow-origin'), '*');
  assert.match(image.headers.get('cache-control'), /immutable/);
  const conditional = await fetch(manifest.spine.textures[0], { headers: { 'If-None-Match': image.headers.get('etag'), Origin: game.url } });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get('access-control-allow-origin'), '*');
  const preflight = await fetch(manifest.audio, { method: 'OPTIONS', headers: { Origin: game.url, 'Access-Control-Request-Headers': 'Range' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Range');
  const audio = await fetch(manifest.audio, { headers: { Origin: game.url, Range: 'bytes=2-5' } });
  assert.equal(audio.status, 206);
  assert.equal(await audio.text(), '2345');
  assert.equal(audio.headers.get('access-control-allow-origin'), '*');
  for (const path of ['/healthz', localPrefix + '/data/assets.json', localPrefix + '/js/main.js']) {
    assert.equal((await fetch(game.url + path)).headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await fetch(game.url + '/api/rooms/ABCD/status', { method: 'OPTIONS' })).status, 405);
  const css = await (await fetch(game.url + localPrefix + '/css/a.css')).text();
  assert.ok(css.includes(remotePrefix + '/assets/x.png'));
  const board = await (await fetch(remotePrefix + '/assets/local/tiles.json')).json();
  assert.equal(board.source.D.path, `/_v/${remoteHealth.artVersion}/assets/x.png`);

  const legacy = await startServer({ ...opts, assetsCdn: remote.url, assetsVersionFile: path.join(root, 'absent') });
  t.after(() => legacy.close());
  const legacyHealth = await (await fetch(legacy.url + '/healthz')).json();
  const legacyManifest = await (await fetch(legacy.url + `/_v/${legacyHealth.build}/data/assets.json`)).json();
  assert.equal(legacyManifest.spine.skel, remote.url + '/assets/x.skel', 'an older CDN has no release route');
});

test('resolveAssetsCdnVersion reads the published tag and degrades to unversioned on any failure', async () => {
  assert.equal(cdnLatestUrl(' https://cdn.example/ ', { now: () => 42 }), 'https://cdn.example/_v/latest?t=42');
  assert.equal(cdnLatestUrl(''), null);
  const tag = '1234567890abcdef';
  const ok = (body) => async () => ({ ok: true, status: 200, text: async () => body });
  await assert.equal(await resolveAssetsCdnVersion('https://cdn.example', { fetcher: ok(`\n  ${tag}\n`) }), tag);
  for (const [name, fetcher] of [
    ['404', async () => ({ ok: false, status: 404, text: async () => '' })],
    ['junk body', ok('not-a-tag')],
    ['rejected', async () => { throw new Error('offline'); }],
    ['no fetcher', undefined],
  ]) {
    assert.equal(await resolveAssetsCdnVersion('https://cdn.example', fetcher ? { fetcher } : {}), '', name);
  }
  assert.equal(await resolveAssetsCdnVersion('', { fetcher: ok(tag) }), '', 'no base, no lookup');
});

test('startServer resolves SP_ASSETS_CDN_VERSION from the CDN publication and keeps unversioned fallback', async (t) => {
  const previous = { cdn: process.env.SP_ASSETS_CDN, version: process.env.SP_ASSETS_CDN_VERSION };
  t.after(() => { process.env.SP_ASSETS_CDN = previous.cdn; process.env.SP_ASSETS_CDN_VERSION = previous.version; });
  delete process.env.SP_ASSETS_CDN;
  delete process.env.SP_ASSETS_CDN_VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-latest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
  };
  write('public/index.html', '<html><head><link href="/fonts/a.woff2"></head><script src="/js/main.js"></script></html>');
  write('public/js/main.js', 'export const ready = true;');
  write('public/fonts/a.woff2', 'font');
  write('public/assets/x.png', 'image');
  write('data/chess.json', '{}');
  const opts = { port: 0, host: '127.0.0.1', quiet: true, workers: 0, publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'), assetsManifestFile: path.join(root, 'absent') };

  const cdnOrigin = http.createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/_v/latest') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fedcba9876543210\n'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => cdnOrigin.listen(0, '127.0.0.1', resolve));
  t.after(() => cdnOrigin.close());
  const game = await startServer({ ...opts, assetsCdn: `http://127.0.0.1:${cdnOrigin.address().port}`, assetsVersionFile: path.join(root, 'absent') });
  t.after(() => game.close());
  const health = await (await fetch(game.url + '/healthz')).json();
  assert.equal(health.assetsCdnVersion, 'fedcba9876543210');
  const html = await (await fetch(game.url + '/')).text();
  assert.ok(html.includes(`http://127.0.0.1:${cdnOrigin.address().port}/_v/fedcba9876543210/fonts/a.woff2`));

  const missing = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => missing.listen(0, '127.0.0.1', resolve));
  t.after(() => missing.close());
  const fallback = await startServer({ ...opts, assetsCdn: `http://127.0.0.1:${missing.address().port}`, assetsVersionFile: path.join(root, 'absent') });
  t.after(() => fallback.close());
  const fallbackHealth = await (await fetch(fallback.url + '/healthz')).json();
  assert.equal(fallbackHealth.assetsCdnVersion, null, 'a CDN without a publication serves unversioned URLs');
  const fallbackHtml = await (await fetch(fallback.url + '/')).text();
  assert.ok(fallbackHtml.includes(`http://127.0.0.1:${missing.address().port}/fonts/a.woff2`));
  assert.ok(!fallbackHtml.includes('/_v/fedcba9876543210'));
});

test('the repo-shipped .assets-cdn-version wins over the network and travels with git pull', async (t) => {
  const previous = { cdn: process.env.SP_ASSETS_CDN, version: process.env.SP_ASSETS_CDN_VERSION };
  t.after(() => { process.env.SP_ASSETS_CDN = previous.cdn; process.env.SP_ASSETS_CDN_VERSION = previous.version; });
  delete process.env.SP_ASSETS_CDN;
  delete process.env.SP_ASSETS_CDN_VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
  };
  write('public/index.html', '<html><head><link href="/fonts/a.woff2"></head></html>');
  write('public/fonts/a.woff2', 'font');
  write('data/chess.json', '{}');
  const versionFile = path.join(root, '.assets-cdn-version');
  fs.writeFileSync(versionFile, '0123456789abcdef\n');
  // an unreachable CDN: the file must resolve the release without any network
  const game = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, workers: 0,
    publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'),
    assetsCdn: 'http://127.0.0.1:1', assetsVersionFile: versionFile, assetsManifestFile: path.join(root, 'absent'),
  });
  t.after(() => game.close());
  const health = await (await fetch(game.url + '/healthz')).json();
  assert.equal(health.assetsCdnVersion, '0123456789abcdef');
  const html = await (await fetch(game.url + '/')).text();
  assert.ok(html.includes('http://127.0.0.1:1/_v/0123456789abcdef/fonts/a.woff2'));
  fs.writeFileSync(versionFile, 'garbage\n');
  assert.equal(readAssetsCdnVersionFile(versionFile), '', 'a junk version file resolves to nothing');
  assert.equal(readAssetsCdnVersionFile(path.join(root, 'absent')), '');
});

test('a per-file manifest ships ?v= art URLs, its own endpoint and wins over the legacy tag chain', async (t) => {
  const previous = { cdn: process.env.SP_ASSETS_CDN, version: process.env.SP_ASSETS_CDN_VERSION };
  t.after(() => { process.env.SP_ASSETS_CDN = previous.cdn; process.env.SP_ASSETS_CDN_VERSION = previous.version; });
  delete process.env.SP_ASSETS_CDN;
  delete process.env.SP_ASSETS_CDN_VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
  };
  write('public/index.html', '<html><head><link href="/fonts/a.woff2"><link rel="stylesheet" href="/fonts/fonts.css"></head></html>');
  write('public/fonts/a.woff2', 'font');
  write('public/assets/x.png', 'image');
  write('data/assets.json', JSON.stringify({ pic: '/assets/x.png' }));
  write('public/fonts/fonts.css', "@font-face{font-family:x;src:url('/fonts/a.woff2')}");
  const manifestFile = path.join(root, '.assets-manifest.json');
  const manifest = { tag: '0123456789abcdef', hashes: { '/assets/x.png': 'aaaaaaaaaaaaaaaa', '/fonts/a.woff2': 'bbbbbbbbbbbbbbbb' } };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, '.assets-cdn-version'), 'fedcba9876543210\n');
  const game = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, workers: 0,
    publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'),
    assetsCdn: 'https://cdn.example', assetsManifestFile: manifestFile,
  });
  t.after(() => game.close());
  const health = await (await fetch(game.url + '/healthz')).json();
  assert.equal(health.assetsManifest, '0123456789abcdef');
  assert.equal(health.assetsCdnVersion, null, 'manifest mode needs no release tag');
  const html = await (await fetch(game.url + '/')).text();
  assert.ok(html.includes('globalThis.__spManifestReady=fetch("/assets-manifest.json?v=0123456789abcdef")'), 'the manifest fetch starts in <head> (same-origin, so the URL is relative)');
  assert.ok(!html.includes('"hashes"'), 'the hash map is fetched, never inlined into the page');
  assert.ok(html.includes('href="https://cdn.example/fonts/a.woff2?v=bbbbbbbbbbbbbbbb"'), 'manifest-listed art gets a per-file hash');
  const stylesheet = `/_v/${health.artVersion}/fonts/fonts.css`;
  assert.ok(html.includes(`href="${stylesheet}"`), 'the game serves font CSS instead of verbatim R2 CSS');
  const cssResponse = await fetch(game.url + stylesheet);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get('cache-control'), /immutable/);
  assert.ok((await cssResponse.text()).includes("url('https://cdn.example/fonts/a.woff2?v=bbbbbbbbbbbbbbbb')"));
  const data = await (await fetch(game.url + `/_v/${health.build}/data/assets.json`)).json();
  assert.equal(data.pic, 'https://cdn.example/assets/x.png?v=aaaaaaaaaaaaaaaa');
  const served = await fetch(game.url + '/assets-manifest.json?v=0123456789abcdef');
  assert.equal(served.status, 200);
  assert.match(served.headers.get('cache-control'), /immutable/);
  assert.deepEqual(await served.json(), manifest);
  assert.equal((await fetch(game.url + '/assets-manifest.json')).status, 404, 'the untagged URL answers nothing cacheable');
  assert.equal((await fetch(game.url + '/assets-manifest.json?v=ffffffffffffffff')).status, 404, 'a foreign tag gets no bytes');
  // readAssetsManifestFile rejects junk
  fs.writeFileSync(manifestFile, '{"tag":"nope"}');
  assert.equal(readAssetsManifestFile(manifestFile), null);
  assert.equal(readAssetsManifestFile(path.join(root, 'absent')), null);
});
