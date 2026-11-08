import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createStaticHandler } from '../server/index.js';
import { resourceUrl, resourceCache } from '../public/js/resourceUrl.js';
import { mediaUrl } from '../public/js/media.js';
import { validSpine } from '../public/js/assets.js';
import { createAssetVersion } from '../server/assetVersion.js';

test('digest cache survives a new process and invalidates edits, replacements, additions and deletions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-release-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  const art = path.join(root, 'assets/a.png'), extra = path.join(root, 'assets/b.png');
  const cacheFile = path.join(root, '.cache/digests.json');
  fs.writeFileSync(art, 'original');
  fs.utimesSync(art, new Date(100000), new Date(100000));
  const mounts = [{ dir: root, prefix: '/' }];
  const make = () => createAssetVersion(mounts, 'shim', undefined, { cacheFile });
  const first = make();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { createAssetVersion } from ${JSON.stringify(new URL('../server/assetVersion.js', import.meta.url).href)};
    const open = fs.openSync;
    fs.openSync = (file, ...args) => {
      if (file === ${JSON.stringify(art)}) throw new Error('unchanged art must not be opened again');
      return open(file, ...args);
    };
    console.log(createAssetVersion(${JSON.stringify(mounts)}, 'shim', undefined, { cacheFile: ${JSON.stringify(cacheFile)} }).tag);
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), first.tag);
  const oldStat = fs.statSync(art);
  fs.writeFileSync(art, 'modified'); // same size; restore mtime to defeat a size/mtime-only cache
  fs.utimesSync(art, oldStat.atime, oldStat.mtime);
  assert.equal(fs.statSync(art).mtimeMs, oldStat.mtimeMs);
  assert.equal(fs.statSync(art).size, oldStat.size);
  const changed = make();
  assert.notEqual(changed.artTag, first.artTag);
  assert.equal(first.matchesFile(art, fs.statSync(art)), false);
  const replacement = path.join(root, '.replacement');
  fs.writeFileSync(replacement, 'replaced');
  fs.utimesSync(replacement, oldStat.atime, oldStat.mtime);
  fs.renameSync(replacement, art);
  const replaced = make();
  assert.notEqual(replaced.artTag, changed.artTag);
  fs.writeFileSync(extra, 'newly installed skin');
  assert.notEqual(make().artTag, replaced.artTag);
  fs.unlinkSync(extra);
  assert.equal(make().artTag, replaced.artTag);
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).files, extra));
  fs.writeFileSync(cacheFile, '{broken');
  assert.equal(make().tag, replaced.tag, 'a corrupt cache falls back to content hashing');
  const invalid = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  invalid.files[art][1] = 'invalid digest';
  fs.writeFileSync(cacheFile, JSON.stringify(invalid));
  assert.equal(make().tag, replaced.tag);
  assert.equal(createAssetVersion(mounts, 'shim', undefined, { cacheFile: null }).tag, replaced.tag);
});

test('release cache is optional and mount filters do not reuse excluded files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-release-filters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.js'), 'code'); fs.writeFileSync(path.join(root, 'b.css'), 'style');
  const cacheFile = path.join(root, '.cache/digests.json');
  const mounts = [{ dir: root, prefix: '/' }];
  const full = createAssetVersion(mounts, 'shim', undefined, { cacheFile });
  const filtered = [{ ...mounts[0], only: new Set(['.js']) }];
  assert.notEqual(createAssetVersion(filtered, 'shim', undefined, { cacheFile }).tag, full.tag);
  assert.equal(createAssetVersion(mounts, 'shim', undefined, { cacheFile }).tag, full.tag);
  const blocked = path.join(root, '.blocked'); fs.mkdirSync(blocked);
  assert.equal(createAssetVersion(mounts, 'shim', undefined, { cacheFile: blocked }).tag, full.tag, 'unwritable cache is nonfatal');
});

test('release content is stable across mtimes and executable URLs survive art/CDN updates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-content-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets')); fs.mkdirSync(path.join(root, 'js'));
  const art = path.join(root, 'assets/a.png'), code = path.join(root, 'js/a.js');
  fs.writeFileSync(art, 'art'); fs.writeFileSync(code, 'export const value=1;');
  const mounts = [{ dir: root, prefix: '/' }];
  const first = createAssetVersion(mounts, 'shim');
  fs.utimesSync(art, new Date(100000), new Date(100000));
  fs.utimesSync(code, new Date(200000), new Date(200000));
  const touched = createAssetVersion(mounts, 'shim');
  assert.equal(touched.tag, first.tag); assert.equal(touched.artTag, first.artTag);
  fs.writeFileSync(art, 'new art');
  const next = createAssetVersion(mounts, 'shim');
  assert.notEqual(next.artTag, first.artTag); assert.notEqual(next.tag, first.tag);
  assert.equal(next.url('/js/a.js'), first.url('/js/a.js'));
  assert.notEqual(next.url('/data/assets.json'), first.url('/data/assets.json'));
  assert.notEqual(next.transform('body{background:url(/assets/a.png)}', '.css'), first.transform('body{background:url(/assets/a.png)}', '.css'));
  const cdn = createAssetVersion(mounts, 'shim', { base: 'https://cdn.example', version: '0123456789abcdef' });
  assert.equal(cdn.runtimeTag, next.runtimeTag); assert.notEqual(cdn.tag, next.tag);
  fs.writeFileSync(code, 'export const value=2;');
  const codeUpdate = createAssetVersion(mounts, 'shim');
  assert.notEqual(codeUpdate.runtimeTag, next.runtimeTag); assert.equal(codeUpdate.artTag, next.artTag);
});

test('release paths cover the module graph, CSS, manifests, Spine dependencies and audio; deploys invalidate them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-release-'));
  const write = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  };
  write('public/index.html', '<html><head><link href="/css/a.css"><script type="importmap">{"imports":{"preact":"/vendor/preact.js"}}</script></head><script type="module" src="/js/main.js"></script></html>');
  write('public/css/a.css', "a{background:url('/assets/p.png')}b{background:url(../assets/p.png)}");
  write('public/js/main.js', "import './child.js'; import '/shared/a.js';");
  write('public/js/child.js', 'export const x = 1;');
  write('public/icons/app.svg', '<svg/>');
  write('public/manifest.json', '{"icons":[{"src":"/icons/app.svg"}]}');
  write('shared/a.js', 'export const a = 1;');
  write('sim/a.js', 'export const a = 1;');
  write('sim/nodeData.js', 'private');
  write('public/assets/p.png', 'picture');
  write('public/assets/x.skel', 'skeleton');
  write('public/assets/x.atlas', 'x.png\nsize: 1,1\n');
  write('public/assets/x.png', 'texture');
  write('public/assets/audio/a.mp3', '0123456789');
  write('public/i18n/en.json', JSON.stringify({ 开始: 'Start', note: 'not/a/path' }));
  write('public/build/assets/nearl2-Bh3kX2mQ.webp', 'hashed webp');
  write('data/assets.json', JSON.stringify({ spine: { skel: '/assets/x.skel', atlas: '/assets/x.atlas', textures: ['/assets/x.png'], anims: {} }, remote: 'https://cdn.example/x.png' }));
  const dirs = { publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'), simDir: path.join(root, 'sim') };
  const handler = createStaticHandler(dirs);
  const srv = http.createServer((req, res) => handler(req, res, req.url.split('?')[0], req.url.split('?')[1] || ''));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const get = (url, init) => fetch(`http://127.0.0.1:${srv.address().port}${url}`, init);
    const prefix = `/_v/${handler.version}`;
    const dataPrefix = `/_v/${handler.dataVersion}`;
  const probe = (h, url) => new Promise((resolve) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { resolve({ status: this.status, headers: this.headers || {}, body }); } };
    h({ method: 'GET', headers: {} }, res, url, '');
  });
  try {
    const html = await (await get('/')).text();
    const artPrefix = `/_v/${JSON.parse(html.match(/__spArtVersion=("[^"]+")/)[1])}`;
    const codePrefix = `/_v/${JSON.parse(html.match(/__spRuntimeVersion=("[^"]+")/)[1])}`;
    const groups = JSON.parse(html.match(/__spCodeVersion=(\{[^}]+\})/)[1]);
    const jsPrefix = `/_v/${groups.js}`, vendorPrefix = `/_v/${groups.vendor}`, sharedPrefix = `/_v/${groups.shared}`;
    assert.match(html, /globalThis\.__spAssetVersion=/);
    assert.ok(html.includes(`src="${jsPrefix}/js/main.js"`), 'the entry script carries its own group tag');
    const imports = JSON.parse(html.match(/type="importmap">(.*?)<\/script>/)[1]).imports;
    assert.equal(imports.preact, vendorPrefix + '/vendor/preact.js');
    assert.equal(imports['/shared/'], sharedPrefix + '/shared/');
    assert.equal(imports['/_v/shared/'], sharedPrefix + '/shared/');
    assert.equal(imports['/data.js'], codePrefix + '/data.js', 'the generated shim stays on the whole-tree runtime tag');
    assert.equal(new URL('../../../shared/a.js', 'http://localhost' + prefix + '/js/render/app.js').pathname, '/_v/shared/a.js');
    const script = await get(prefix + '/js/main.js');
    assert.match(script.headers.get('cache-control'), /31536000, immutable/, 'the whole-tree tag keeps serving code through the legacy shim');
    const grouped = await get(jsPrefix + '/js/main.js');
    assert.match(grouped.headers.get('cache-control'), /31536000, immutable/, 'the group tag is the current immutable URL');
    assert.ok((await grouped.text()).includes(`import '${jsPrefix}/js/child.js'`), 'relative imports land in the module group namespace');
    const hashedArt = await get('/build/assets/nearl2-Bh3kX2mQ.webp');
    assert.match(hashedArt.headers.get('cache-control'), /31536000, immutable/, 'a Vite-hashed image name pins its bytes (webp included)');
    assert.equal((await get(prefix + '/js/child.js')).status, 200);
    const css = await (await get(prefix + '/css/a.css')).text();
    assert.ok(css.includes(`url('${artPrefix}/assets/p.png')`));
    assert.ok(css.includes('url(../assets/p.png)'), 'relative URLs inherit the release path');
    const manifestRes = await get(dataPrefix + '/data/assets.json');
    const manifest = await manifestRes.json();
    assert.ok(validSpine(manifest.spine));
    assert.equal(manifest.spine.skel, artPrefix + '/assets/x.skel');
    assert.equal(manifest.spine.textures[0], artPrefix + '/assets/x.png');
    assert.equal(manifest.remote, 'https://cdn.example/x.png');
    assert.equal(new URL('x.png', 'http://localhost' + manifest.spine.atlas).pathname, artPrefix + '/assets/x.png');
    const revalidate = await get(dataPrefix + '/data/assets.json', { headers: { 'If-None-Match': manifestRes.headers.get('etag') } });
    assert.equal(revalidate.status, 304);
    const head = await get(prefix + '/css/a.css', { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(css));
    assert.equal(await head.text(), '');
    const audio = mediaUrl(artPrefix + '/assets/audio/a.mp3');
    assert.equal(audio, artPrefix + '/media/a');
    const range = await get(audio, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), '2345');
    const lang = await get(prefix + '/i18n/en.json');
    assert.match(lang.headers.get('cache-control'), /31536000, immutable/, 'the language pack rides the release tag (P1-5 wiring)');
    assert.deepEqual(await lang.json(), { 开始: 'Start', note: 'not/a/path' }, 'i18n strings pass through the versioned transform untouched');
    for (const denied of ['/sim/nodeData.js', '/assets/.hidden', '/shared/../sim/nodeData.js']) assert.equal((await get(prefix + denied)).status, 404);
    assert.equal((await get('/js/main.js?v=made-up')).headers.get('cache-control'), 'no-cache');
    for (const url of ['/icons/app.svg', '/manifest.json']) {
      const response = await get(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
      await response.arrayBuffer();
      const head = await get(url, { method: 'HEAD' });
      assert.equal(head.headers.get('cache-control'), 'public, max-age=3600');
      assert.equal(await head.text(), '');
      const cached = await get(url, { headers: { 'If-None-Match': response.headers.get('etag') } });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get('cache-control'), 'public, max-age=3600');
    }
    assert.equal((await get('/icons/missing.svg')).status, 404);
    assert.equal((await get('/')).headers.get('cache-control'), 'no-cache');
    const stable = createStaticHandler(dirs).version;
    assert.equal(stable, handler.version);
    write('shared/a.js', 'export const a = 2;'); // same size; content is hashed
    const next = createStaticHandler(dirs);
    assert.notEqual(next.version, stable);
    // 组隔离：shared 变了，js 组的 tag 与 URL 原样有效——客户端的 js immutable 缓存跨发版续命（发版热点专项）。
    const nextHtml = await new Promise((resolve) => {
      const res = { writeHead() {}, end(body) { resolve(body.toString()); } };
      next({ method: 'GET', headers: {} }, res, '/', '');
    });
    const nextGroups = JSON.parse(nextHtml.match(/__spCodeVersion=(\{[^}]+\})/)[1]);
    assert.equal(nextGroups.js, groups.js, 'an untouched group keeps its tag across deploys');
    assert.notEqual(nextGroups.shared, groups.shared);
    const kept = await probe(next, jsPrefix + '/js/main.js');
    assert.equal(kept.status, 200, 'the untouched group still answers its old URL on the new release');
    assert.match(kept.headers['Cache-Control'], /31536000, immutable/);
    const stale = await probe(next, sharedPrefix + '/shared/a.js');
    assert.equal(stale.status, 404, 'the changed group retires its stale tag');
    assert.equal(stale.headers['Clear-Site-Data'], '"cache"');
    assert.equal((await probe(next, `/_v/${nextGroups.shared}/shared/a.js`)).status, 200);
    const changedHtml = await new Promise((resolve) => {
      const res = { writeHead() {}, end(body) { resolve(body.toString()); } };
      next({ method: 'GET', headers: {} }, res, '/', '');
    });
    assert.equal(JSON.parse(changedHtml.match(/__spArtVersion=("[^"]+")/)[1]), artPrefix.split('/').at(-1), 'code-only updates keep the art cache namespace');
    assert.equal((await get(prefix + '/shared/a.js')).status, 503, 'changed bytes cannot poison the running release cache');
    const wrong = await get(`/_v/${next.version}/js/main.js`);
    assert.equal(wrong.status, 404); assert.equal(wrong.headers.get('cache-control'), 'no-store');
    write('public/assets/p.png', 'updated picture');
    assert.notEqual(createStaticHandler(dirs).version, next.version);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('data JSONs carry their own content tag: a code-only release keeps data URLs, a data-only release keeps code URLs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-data-tag-'));
  const write = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  };
  write('public/index.html', '<html><head></head><script type="module" src="/js/main.js"></script></html>');
  write('public/js/main.js', 'export const x = 1;');
  write('data/chess.json', '{"a":1}');
  const dirs = { publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'), simDir: path.join(root, 'sim') };
  let handler = createStaticHandler(dirs);
  const srv = http.createServer((req, res) => handler(req, res, req.url.split('?')[0], req.url.split('?')[1] || ''));
  const page = (h) => new Promise((resolve) => { const res = { writeHead() {}, end(body) { resolve(body.toString()); } }; h({ method: 'GET', headers: {} }, res, '/', ''); });
  const groupsOf = async (h) => JSON.parse((await page(h)).match(/__spCodeVersion=(\{[^}]+\})/)[1]);
  try {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const get = (url) => fetch(`http://127.0.0.1:${srv.address().port}${url}`);
    const firstData = handler.dataVersion, firstGroups = await groupsOf(handler);
    assert.notEqual(firstData, handler.version, 'the data tag is its own namespace, not the whole-release tag');
    // 代码-only 发版：js 组 tag 动、__spDataVersion 与数据 URL 原样（客户端 immutable 缓存跨发版续命）。
    write('public/js/main.js', 'export const x = 2;');
    handler = createStaticHandler(dirs);
    const secondGroups = await groupsOf(handler);
    assert.notEqual(secondGroups.js, firstGroups.js);
    assert.equal(handler.dataVersion, firstData, 'a code-only release keeps every /data/ URL');
    // 数据-only 发版：数据 tag 动、js 组不动。
    write('data/chess.json', '{"a":2}');
    handler = createStaticHandler(dirs);
    assert.notEqual(handler.dataVersion, firstData);
    assert.equal((await groupsOf(handler)).js, secondGroups.js, 'a data-only release keeps code group URLs');
    const versioned = await get(`/_v/${handler.dataVersion}/data/chess.json`);
    assert.equal(versioned.status, 200);
    assert.match(versioned.headers.get('cache-control'), /31536000, immutable/);
    assert.equal(await versioned.text(), '{"a":2}');
    const stale = await get(`/_v/${firstData}/data/chess.json`);
    assert.equal(stale.status, 404, 'the changed data release retires its stale tag');
    assert.equal(stale.headers.get('clear-site-data'), '"cache"');
    assert.equal((await get('/data/chess.json')).headers.get('cache-control'), 'no-cache', 'the plain path keeps its revalidation behavior');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resource helpers preserve static-host compatibility, queries and external URLs', () => {
  const version = '1234567890abcdef';
  assert.equal(resourceUrl('/data/chess.json', version), `/_v/${version}/data/chess.json`);
  assert.equal(resourceUrl('/assets/a.png?v=2#x', version), `/_v/${version}/assets/a.png?v=2#x`);
  for (const u of ['https://cdn.example/a.png', '//cdn.example/a.png', `/_v/${version}/assets/a.png`, '/api/rooms/ABCD/status']) assert.equal(resourceUrl(u, version), u);
  assert.equal(resourceUrl('/assets/a.png', null), '/assets/a.png');
  assert.equal(resourceCache(`/_v/${version}/data/chess.json`), 'default');
  assert.equal(resourceCache('/data/chess.json'), 'no-cache');
});
