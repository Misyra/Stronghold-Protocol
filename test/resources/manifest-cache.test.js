import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createResourceIndex } from '../../server/resources.js';
import { createStaticHandler } from '../../server/http/static.js';
import { CUSTOM_EMOTE_THEME, emoteArtPath } from '../../shared/constants.js';
import { resourceManifestUrl } from '../../public/js/resources/common.js';

function install(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-manifest-cache-'));
  const dirs = Object.fromEntries(['data', 'public', 'shared'].map(name => [name + 'Dir', path.join(root, name)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  const write = (name, value) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
  };
  write('data/assets.json', { ui: { test: '/assets/test.png' } });
  write('data/local-assets.json', { groups: { 'map/autochess': { atlas: { path: '/assets/local/map/autochess/TX_autochessi_D.png' } } } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...dirs, write };
}
async function serve(t, dirs, opts = {}) {
  const handler = createStaticHandler({ ...dirs, ...opts });
  const server = http.createServer((req, res) => {
    const [url, query = ''] = req.url.split('?'); void handler(req, res, url, query);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function reads(t, dataDir) {
  const counts = { json: 0 };
  const read = fsp.readFile;
  t.mock.method(fsp, 'readFile', (...args) => {
    if (String(args[0]).startsWith(dataDir + path.sep)) counts.json++;
    return read(...args);
  });
  return counts;
}

test('warm manifests skip JSON reads, rewrite and resource traversal; concurrent rebuilds share work', async t => {
  const inst = install(t), counts = reads(t, inst.dataDir);
  let rewrites = 0, stats = 0;
  const index = createResourceIndex({ ...inst, rewrite: doc => { rewrites++; return doc; },
    statFile: file => { stats++; return fsp.stat(file); } });
  const initial = await index.get();
  assert.equal(rewrites, 2); assert.equal(counts.json, 2);
  counts.json = rewrites = stats = 0;
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => index.get()));
  assert.ok(concurrent.every(result => result === initial));
  assert.equal(counts.json, 0); assert.equal(rewrites, 0);
  assert.ok(stats <= 12, 'only source manifests, site emotes and remembered tile dependencies are statted once');
  inst.write('data/assets.json', { ui: { test: '/assets/new-file.png' } });
  const rebuilt = await Promise.all(Array.from({ length: 20 }, () => index.get()));
  assert.ok(rebuilt.every(result => result === rebuilt[0]));
  assert.notEqual(rebuilt[0].etag, initial.etag);
  assert.equal(rewrites, 2); assert.equal(counts.json, 2);
});

test('early cache gate preserves tile/emote creation, updates/deletion, hash-file changes and failure recovery', async t => {
  const inst = install(t), index = createResourceIndex(inst);
  let previous = await index.get();
  const changed = async () => { const result = await index.get(); assert.notEqual(result.etag, previous.etag); previous = result; return result; };
  const tile = inst.write('public/assets/local/map/autochess/tiles.json', { version: 1 });
  assert.ok((await changed()).manifest.files.some(f => f.url.endsWith('/tiles.json')));
  inst.write('public/assets/local/map/autochess/tiles.json', { version: 222 }); await changed();
  fs.unlinkSync(tile); assert.equal((await changed()).manifest.files.some(f => f.url.endsWith('/tiles.json')), false);
  const emoteUrl = emoteArtPath(CUSTOM_EMOTE_THEME.emotes[0].id);
  const emote = inst.write('public' + emoteUrl, 'image');
  assert.ok((await changed()).manifest.files.some(f => f.url === emoteUrl));
  inst.write('public' + emoteUrl, 'updated-image'); await changed(); fs.unlinkSync(emote); await changed();
  const hashes = inst.write('data/asset-hashes.json', { files: { '/assets/test.png': 'aaaaaaaaaaaa' } });
  assert.equal((await changed()).manifest.files.find(f => f.url === '/assets/test.png').hash, 'aaaaaaaaaaaa');
  fs.unlinkSync(hashes); await changed();
  inst.write('data/assets.json', '{invalid'); await assert.rejects(index.get(), SyntaxError);
  inst.write('data/assets.json', { ui: { test: '/assets/restored.png' } }); await changed();
  fs.unlinkSync(path.join(inst.dataDir, 'local-assets.json'));
  assert.equal((await changed()).manifest.files.some(f => f.url.includes('/map/')), false);
});

test('warm-path tile errors reject instead of masquerading as missing dependencies', async t => {
  const inst = install(t);
  let fail = false;
  const index = createResourceIndex({ ...inst, statFile: file => {
    if (fail && String(file).endsWith('tiles.json')) return Promise.reject(Object.assign(new Error('tile stat failed'), { code: 'EIO' }));
    return fsp.stat(file);
  } });
  const previous = await index.get();
  fail = true;
  await assert.rejects(index.get(), /tile stat failed/);
  fail = false;
  assert.equal(await index.get(), previous);
});

test('reset during an in-flight build keeps the stale generation from replacing the newer cache', async t => {
  const inst = install(t);
  let release, entered, block = true;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const index = createResourceIndex({ ...inst, readFile: async (file, opts) => {
    const body = await fsp.readFile(file, opts);
    if (block && String(file) === path.join(inst.dataDir, 'assets.json')) { block = false; entered(); await gate; }
    return body;
  } });
  const old = index.get();
  await waiting;
  index.reset();
  inst.write('data/assets.json', { ui: { test: '/assets/new-generation.png' } });
  const fresh = await index.get();
  release();
  const stale = await old;
  assert.notEqual(stale.manifest.version, fresh.manifest.version);
  assert.equal(await index.get(), fresh);
});

test('HTTP 200, HEAD and 304 warm revalidation avoid JSON reads and keep encoding-specific validators', async t => {
  const inst = install(t), base = await serve(t, inst), counts = reads(t, inst.dataDir);
  const url = base + '/data/resource-manifest.json';
  const first = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
  const body = await first.text(), etag = first.headers.get('etag');
  assert.equal(counts.json, 2); counts.json = 0;
  const raw = await fetch(url, { headers: { 'Accept-Encoding': 'gzip;q=0' } });
  assert.equal(raw.headers.get('content-encoding'), null); assert.equal(await raw.text(), body);
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(url, { method, headers: { 'Accept-Encoding': 'identity', 'If-None-Match': etag } });
    assert.equal(response.status, 304); assert.equal(await response.text(), '');
    assert.equal(response.headers.get('etag'), etag);
  }
  const gzip = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(await gzip.text(), body); assert.notEqual(gzip.headers.get('etag'), etag);
  const cached = await fetch(url, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.get('etag') } });
  assert.equal(cached.status, 304); assert.equal(counts.json, 0);
});

test('public asset manifests serialize once, reuse gzip and return metadata-free, version-bound 304s', async t => {
  const inst = install(t), hashes = { '/assets/test.png': 'aaaaaaaaaaaaaaaa' };
  let serializations = 0;
  Object.defineProperty(hashes, 'toJSON', { value() { serializations++; return { ...hashes }; } });
  const doc = { tag: '0123456789abcdef', hashes, preload: { '/assets/test.png': { hash: 'aaaaaaaaaaaa', size: 5 } } };
  const base = await serve(t, inst, { assetsCdn: 'https://cdn.example', assetsManifest: doc });
  serializations = 0;
  const url = base + '/assets-manifest.json?v=' + doc.tag;
  const raw = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
  assert.deepEqual(await raw.json(), { tag: doc.tag, hashes: { ...hashes } });
  for (const encoding of ['identity', 'gzip', 'gzip;q=0']) {
    const response = await fetch(url, { headers: { 'Accept-Encoding': encoding } });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /immutable/); await response.arrayBuffer();
    const cached = await fetch(url, { method: 'HEAD', headers: { 'Accept-Encoding': encoding, 'If-None-Match': response.headers.get('etag') } });
    assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
  }
  assert.equal(serializations, 1);
  assert.equal((await fetch(base + '/assets-manifest.json?v=ffffffffffffffff')).status, 404);
});

test('12h proxy caching is bound to the current page release; plain and foreign URLs cannot acquire it', async t => {
  const inst = install(t);
  inst.write('public/index.html', '<html><head></head></html>');
  const base = await serve(t, inst);
  const html = await (await fetch(base + '/')).text();
  const version = /__spAssetVersion="([a-f0-9]{16})"/.exec(html)[1];
  assert.equal(resourceManifestUrl(version), '/data/resource-manifest.json?v=' + version);
  for (const invalid of [undefined, '', 'bad', '../../escape']) assert.equal(resourceManifestUrl(invalid), '/data/resource-manifest.json');
  const plain = await fetch(base + '/data/resource-manifest.json');
  assert.equal(plain.status, 200); assert.equal(plain.headers.get('x-accel-expires'), '15');
  const versioned = await fetch(base + resourceManifestUrl(version));
  assert.equal(versioned.status, 200); assert.equal(versioned.headers.get('x-accel-expires'), '43200');
  assert.equal(versioned.headers.get('cache-control'), 'no-cache');
  assert.deepEqual(await versioned.json(), await plain.json());
  const cached = await fetch(base + resourceManifestUrl(version), { headers: { 'If-None-Match': versioned.headers.get('etag') } });
  assert.equal(cached.status, 304); assert.equal(cached.headers.get('x-accel-expires'), '43200');
  for (const query of ['?v=ffffffffffffffff', '?v=', '?v=' + version + '&extra=1']) {
    const foreign = await fetch(base + '/data/resource-manifest.json' + query);
    assert.equal(foreign.status, 404); assert.equal(foreign.headers.get('x-accel-expires'), null);
    assert.equal(foreign.headers.get('cache-control'), 'no-store');
  }
});

test('preload-only metadata updates rotate the release URL even when the public art tag stays unchanged', async t => {
  const inst = install(t);
  inst.write('public/index.html', '<html><head></head></html>');
  const doc = { tag: '0123456789abcdef', hashes: { '/assets/test.png': 'aaaaaaaaaaaaaaaa' },
    preload: { '/assets/test.png': { hash: 'aaaaaaaaaaaa', size: 5 } } };
  const previous = await serve(t, inst, { assetsCdn: 'https://cdn.example', assetsManifest: doc });
  const oldHtml = await (await fetch(previous + '/')).text();
  const oldVersion = /__spAssetVersion="([a-f0-9]{16})"/.exec(oldHtml)[1];
  const nextDoc = { ...doc, preload: { '/assets/test.png': { hash: 'bbbbbbbbbbbb', size: 6 } } };
  const current = await serve(t, inst, { assetsCdn: 'https://cdn.example', assetsManifest: nextDoc });
  const html = await (await fetch(current + '/')).text();
  const version = /__spAssetVersion="([a-f0-9]{16})"/.exec(html)[1];
  assert.notEqual(version, oldVersion);
  assert.equal((await fetch(current + resourceManifestUrl(oldVersion))).status, 404);
  const manifest = await fetch(current + resourceManifestUrl(version));
  assert.equal(manifest.status, 200); assert.equal(manifest.headers.get('x-accel-expires'), '43200');
});
