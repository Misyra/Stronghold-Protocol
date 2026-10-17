import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { readAssetsCdnVersionFile, readAssetsManifestFile } from '../server/assetVersion.js';
import { parseAssetCdn } from '../server/http/config.js';
import { createStaticHandler } from '../server/http/static.js';
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

test('Spine refuses a parsed skeleton with destroyed atlas pages and clears the poisoned cache', async (t) => {
  const previous = { pixi: globalThis.PIXI, cdn: globalThis.__spAssetCdn };
  t.after(() => { globalThis.PIXI = previous.pixi; globalThis.__spAssetCdn = previous.cdn; });
  globalThis.__spAssetCdn = undefined;
  const unloaded = [];
  globalThis.PIXI = { spine: {}, Assets: {
    load: async () => ({ spineData: { animations: [] }, spineAtlas: { pages: [{ baseTexture: { destroyed: true } }] } }),
    unload: async (u) => unloaded.push(u), loader: { unload: async (u) => unloaded.push(u) },
  } };
  await assert.rejects(loadSpineData({ skel: '/assets/bad.skel' }), /invalid spine atlas/);
  assert.deepEqual(unloaded, ['/assets/bad.skel', '/assets/bad.atlas', '/assets/bad.png']);
});

test('Spine page loading rejects invalid textures and callback errors instead of leaving an unresolved atlas', async (t) => {
  const previous = { pixi: globalThis.PIXI, cdn: globalThis.__spAssetCdn, fetch: globalThis.fetch };
  t.after(() => { globalThis.PIXI = previous.pixi; globalThis.__spAssetCdn = previous.cdn; globalThis.fetch = previous.fetch; });
  globalThis.__spAssetCdn = { base: 'https://cdn.example', manifest: '/manifest.json', hashes: {} };
  globalThis.fetch = async () => ({ ok: true, text: async () => 'atlas' });
  let valid = false;
  globalThis.PIXI = { spine: { TextureAtlas: class {
    constructor(text, loadPage) { loadPage('bad.png', () => { throw new Error('bad atlas region'); }); }
  } }, Assets: {
    load: async () => { throw new Error('must not parse an invalid atlas'); },
    loader: { load: async () => ({ baseTexture: { valid, destroyed: !valid } }) },
  } };
  await assert.rejects(loadSpineData({ skel: '/assets/bad.skel' }), /invalid atlas texture/);
  valid = true;
  await assert.rejects(loadSpineData({ skel: '/assets/bad.skel' }), /bad atlas region/);
});

test('unload releases resolver atlas metadata without erasing a replacement atlas', async (t) => {
  const previous = { pixi: globalThis.PIXI, cdn: globalThis.__spAssetCdn };
  t.after(() => { globalThis.PIXI = previous.pixi; globalThis.__spAssetCdn = previous.cdn; });
  globalThis.__spAssetCdn = { manifest: '/manifest.json' };
  const oldAtlas = {}, replacement = {};
  const resolved = { data: { spineAtlas: oldAtlas, spineSkeletonScale: 2 } };
  let finish;
  globalThis.PIXI = { Assets: {
    resolver: { hasKey: () => true, resolve: () => resolved },
    unload: () => new Promise((resolve) => { finish = resolve; }),
    loader: { unload: async () => {} },
  } };
  let pending = unloadSpineData({ skel: '/assets/a.skel' });
  finish(); await pending;
  assert.deepEqual(resolved.data, { spineSkeletonScale: 2 });
  resolved.data.spineAtlas = oldAtlas;
  pending = unloadSpineData({ skel: '/assets/a.skel' });
  resolved.data.spineAtlas = replacement;
  finish(); await pending;
  assert.equal(resolved.data.spineAtlas, replacement);
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


// xinhai 的静态服务把 CDN 基址原样拼在 /assets/… 前，并在请求时生成 /js/asset-cdn.js。
// 这一条替代原先的四条「发布标签 / 逐文件 ?v=」用例：那条链路（server/assetVersion.js + _v/<tag>）已不在服务路径上。
test('CDN 基址由启动参数决定：/js/asset-cdn.js 与资源清单都带同一个前缀', async () => {
  const prev = { a: process.env.SP_ASSETS_CDN, d: process.env.SP_DATA_CDN };
  process.env.SP_ASSETS_CDN = 'https://cdn.example.test/game';
  process.env.SP_DATA_CDN = 'https://data.example.test/game';
  const srv = await startServer({ port: 0, quiet: true, stateFile: 'off' });
  try {
    const port = srv.port ?? srv.server?.address?.()?.port;
    const mod = await (await fetch(`http://127.0.0.1:${port}/js/asset-cdn.js`)).text();
    assert.match(mod, /https:\/\/cdn\.example\.test\/game/, 'ASSETS_CDN 进入客户端模块');
    assert.match(mod, /https:\/\/data\.example\.test\/game/, 'DATA_CDN 进入客户端模块');
    const manifest = await (await fetch(`http://127.0.0.1:${port}/data/resource-manifest.json`)).json();
    const sample = manifest.files.find((f) => typeof f.url === 'string' && f.url.startsWith('https://'));
    assert.ok(sample, '清单里的素材地址被改写到 CDN');
    assert.match(sample.url, /^https:\/\/cdn\.example\.test\/game\/assets\//);
    assert.equal(/\?v=/.test(sample.url), false, '不再做逐文件 ?v=（旧链路）');
  } finally {
    await srv.close();
    if (prev.a == null) delete process.env.SP_ASSETS_CDN; else process.env.SP_ASSETS_CDN = prev.a;
    if (prev.d == null) delete process.env.SP_DATA_CDN; else process.env.SP_DATA_CDN = prev.d;
  }
});

test('parseAssetCdn: 静态层接受的基址就是 xinhai 接受的那一组（尾斜杠、根路径、非法值）', () => {
  assert.equal(parseAssetCdn('https://cdn.example/'), 'https://cdn.example', 'trailing slashes are trimmed');
  assert.equal(parseAssetCdn('  http://cdn.example/static//  '), 'http://cdn.example/static', 'and only those');
  assert.equal(parseAssetCdn('/cdn'), '/cdn', 'a same-origin root path is a base too');
  assert.equal(parseAssetCdn(''), '', 'nothing configured');
  assert.equal(parseAssetCdn(undefined), '');
  assert.equal(parseAssetCdn(null), '');
  for (const bad of ['javascript:alert(1)', 'cdn.example', 'ftp://cdn.example', 'cdn.example:443']) {
    assert.equal(parseAssetCdn(bad), '', `${bad} is not a base`);
  }
  // their parser stops at「scheme or root path」: a protocol-relative host or a query string is assetCdnSettings' job
  assert.equal(parseAssetCdn('//cdn.example'), '//cdn.example');
  assert.equal(parseAssetCdn('https://cdn.example/?v=1/x'), 'https://cdn.example/?v=1/x');
});

test('每文件指纹清单：/assets-manifest.json?v=<tag> 只服务本次发布，并告诉客户端去哪儿取', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-data-'));
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-pub-'));
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const serve = async (assetsManifest) => {
    const handler = createStaticHandler({ publicDir, dataDir, sharedDir: path.resolve('shared'), cdnBase: 'https://cdn.example', assetsManifest, log });
    const srv = http.createServer((req, res) => { const [p, q] = (req.url || '/').split('?'); handler(req, res, p, q || ''); });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return { base: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise((r) => srv.close(r)) };
  };
  const manifest = { tag: '0123456789abcdef', hashes: { '/assets/x.png': 'aaaaaaaaaaaaaaaa' } };
  const withManifest = await serve(manifest);
  try {
    const config = await (await fetch(withManifest.base + '/js/asset-cdn.js')).text();
    assert.match(config, /export const ASSETS_CDN = "https:\/\/cdn\.example";/);
    assert.match(config, /ASSETS_MANIFEST = "\/assets-manifest\.json\?v=0123456789abcdef"/, 'the client is told the release URL');
    const url = withManifest.base + '/assets-manifest.json?v=' + manifest.tag;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /immutable/, 'a tag identifies one release: it may be cached forever');
    assert.deepEqual(await res.json(), manifest, 'tag and per-file hashes');
    assert.equal((await fetch(url, { headers: { 'if-none-match': res.headers.get('etag') } })).status, 304, 'revalidation works');
    assert.equal((await fetch(withManifest.base + '/assets-manifest.json?v=ffffffffffffffff')).status, 404, 'another release\'s tag is refused');
    assert.equal((await fetch(withManifest.base + '/assets-manifest.json')).status, 404, 'no tag, no manifest');
  } finally { await withManifest.close(); }
  const without = await serve(null);
  try {
    const config = await (await fetch(without.base + '/js/asset-cdn.js')).text();
    assert.match(config, /ASSETS_MANIFEST = ""/, 'without a manifest the client keeps bare URLs');
  } finally { await without.close(); }
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(publicDir, { recursive: true, force: true });
});
