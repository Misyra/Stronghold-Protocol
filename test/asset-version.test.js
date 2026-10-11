import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStaticHandler } from '../server/index.js';
import { resourceUrl, resourceCache } from '../public/js/resourceUrl.js';
import { mediaUrl } from '../public/js/media.js';
import { validSpine } from '../public/js/assets.js';
import { createAssetVersion } from '../server/assetVersion.js';

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
  write('shared/a.js', 'export const a = 1;');
  write('sim/a.js', 'export const a = 1;');
  write('sim/nodeData.js', 'private');
  write('public/assets/p.png', 'picture');
  write('public/assets/x.skel', 'skeleton');
  write('public/assets/x.atlas', 'x.png\nsize: 1,1\n');
  write('public/assets/x.png', 'texture');
  write('public/assets/audio/a.mp3', '0123456789');
  write('data/assets.json', JSON.stringify({ spine: { skel: '/assets/x.skel', atlas: '/assets/x.atlas', textures: ['/assets/x.png'], anims: {} }, remote: 'https://cdn.example/x.png' }));
  const dirs = { publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'), simDir: path.join(root, 'sim') };
  const handler = createStaticHandler(dirs);
  const srv = http.createServer((req, res) => handler(req, res, req.url.split('?')[0], req.url.split('?')[1] || ''));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const get = (url, init) => fetch(`http://127.0.0.1:${srv.address().port}${url}`, init);
  const prefix = `/_v/${handler.version}`;
  try {
    const html = await (await get('/')).text();
    const artPrefix = `/_v/${JSON.parse(html.match(/__spArtVersion=("[^"]+")/)[1])}`;
    const codePrefix = `/_v/${JSON.parse(html.match(/__spRuntimeVersion=("[^"]+")/)[1])}`;
    assert.match(html, /globalThis\.__spAssetVersion=/);
    assert.ok(html.includes(`src="${codePrefix}/js/main.js"`));
    const imports = JSON.parse(html.match(/type="importmap">(.*?)<\/script>/)[1]).imports;
    assert.equal(imports.preact, codePrefix + '/vendor/preact.js');
    assert.equal(imports['/shared/'], codePrefix + '/shared/');
    assert.equal(imports['/_v/shared/'], codePrefix + '/shared/');
    assert.equal(new URL('../../../shared/a.js', 'http://localhost' + prefix + '/js/render/app.js').pathname, '/_v/shared/a.js');
    const script = await get(prefix + '/js/main.js');
    assert.match(script.headers.get('cache-control'), /31536000, immutable/);
    assert.ok((await script.text()).includes("import './child.js'"));
    assert.equal((await get(prefix + '/js/child.js')).status, 200);
    const css = await (await get(prefix + '/css/a.css')).text();
    assert.ok(css.includes(`url('${artPrefix}/assets/p.png')`));
    assert.ok(css.includes('url(../assets/p.png)'), 'relative URLs inherit the release path');
    const manifestRes = await get(prefix + '/data/assets.json');
    const manifest = await manifestRes.json();
    assert.ok(validSpine(manifest.spine));
    assert.equal(manifest.spine.skel, artPrefix + '/assets/x.skel');
    assert.equal(manifest.spine.textures[0], artPrefix + '/assets/x.png');
    assert.equal(manifest.remote, 'https://cdn.example/x.png');
    assert.equal(new URL('x.png', 'http://localhost' + manifest.spine.atlas).pathname, artPrefix + '/assets/x.png');
    const revalidate = await get(prefix + '/data/assets.json', { headers: { 'If-None-Match': manifestRes.headers.get('etag') } });
    assert.equal(revalidate.status, 304);
    const head = await get(prefix + '/css/a.css', { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(css));
    assert.equal(await head.text(), '');
    const audio = mediaUrl(artPrefix + '/assets/audio/a.mp3');
    assert.equal(audio, artPrefix + '/media/a');
    const range = await get(audio, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), '2345');
    for (const denied of ['/sim/nodeData.js', '/assets/.hidden', '/shared/../sim/nodeData.js']) assert.equal((await get(prefix + denied)).status, 404);
    assert.equal((await get('/js/main.js?v=made-up')).headers.get('cache-control'), 'no-cache');
    const stable = createStaticHandler(dirs).version;
    assert.equal(stable, handler.version);
    write('shared/a.js', 'export const a = 2;'); // same size; content is hashed
    const next = createStaticHandler(dirs);
    assert.notEqual(next.version, stable);
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

test('resource helpers preserve static-host compatibility, queries and external URLs', () => {
  const version = '1234567890abcdef';
  assert.equal(resourceUrl('/data/chess.json', version), `/_v/${version}/data/chess.json`);
  assert.equal(resourceUrl('/assets/a.png?v=2#x', version), `/_v/${version}/assets/a.png?v=2#x`);
  for (const u of ['https://cdn.example/a.png', '//cdn.example/a.png', `/_v/${version}/assets/a.png`, '/api/rooms/ABCD/status']) assert.equal(resourceUrl(u, version), u);
  assert.equal(resourceUrl('/assets/a.png', null), '/assets/a.png');
  assert.equal(resourceCache(`/_v/${version}/data/chess.json`), 'default');
  assert.equal(resourceCache('/data/chess.json'), 'no-cache');
});
