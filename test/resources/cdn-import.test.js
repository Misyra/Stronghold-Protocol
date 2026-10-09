import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaticHandler } from '../../server/index.js';
import { readAssetsManifestFile } from '../../server/assetVersion.js';
import { createResourceIndex } from '../../server/resources.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { exportResourceZip, importResourceZip } from '../../public/js/resources/archive.js';
import { fingerprintPublishedAsset, publishedAssetsManifest } from '../../tools/published-assets.mjs';

class MemoryCache {
  entries = new Map();
  async put(key, response) { this.entries.set(typeof key === 'string' ? key : key.url, response.clone()); }
  async match(key) { return this.entries.get(typeof key === 'string' ? key : key.url)?.clone(); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(key) { return this.entries.delete(typeof key === 'string' ? key : key.url); }
}
class MemoryCaches {
  entries = new Map();
  async open(name) { if (!this.entries.has(name)) this.entries.set(name, new MemoryCache()); return this.entries.get(name); }
  async keys() { return [...this.entries.keys()]; }
  async delete(name) { return this.entries.delete(name); }
}
const CDN = 'https://cdn.example/game';
const sha = (body, algorithm, length) => createHash(algorithm).update(body).digest('hex').slice(0, length);
const bodies = new Map([
  ['/assets/char/avatar/a.png', 'portrait'],
  ['/assets/spine/op/a.skel', 'skeleton'],
  ['/assets/spine/op/[opt]a.png', 'texture'],
  ['/assets/audio/voice/jp/a/cn_001.mp3', 'voice'],
  ['/assets/audio/sfx/a.mp3', 'sound'],
]);
function install(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), publicDir = path.join(root, 'public');
  fs.mkdirSync(dataDir); fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(dataDir, 'assets.json'), JSON.stringify({ chars: [...bodies.keys()] }));
  const published = publishedAssetsManifest([...bodies].map(([url, body]) => ({ key: url.slice(1),
    hash: sha(body, 'sha256', 16), contentHash: sha(body, 'sha1', 12), size: Buffer.byteLength(body) })));
  const manifestFile = path.join(root, '.assets-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(published));
  return { root, dataDir, publicDir, manifestFile, published };
}
function rewrite(v, published, base = CDN) {
  if (typeof v === 'string' && v.startsWith('/assets/')) return base + v + '?v=' + published.hashes[v];
  if (Array.isArray(v)) return v.map((x) => rewrite(x, published, base));
  return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, published, base)])) : v;
}
function store(manifest, caches = new MemoryCaches()) {
  const calls = [];
  return { calls, caches, store: new ResourceStore(manifest, { caches, origin: 'https://game.example', fetcher: async (url) => {
    calls.push(url);
    const key = decodeURI(new URL(url).pathname).replace('/game', '');
    assert.ok(bodies.has(key), 'only fixture assets may be downloaded');
    return new Response(bodies.get(key));
  } }) };
}

test('a CDN-only server imports an old synthetic-hash ZIP and adopts its existing cache without resource downloads', async (t) => {
  const inst = install(t);
  const handler = createStaticHandler({ ...inst, sharedDir: inst.publicDir, assetsCdn: CDN, assetsManifest: readAssetsManifestFile(inst.manifestFile) });
  const server = http.createServer((req, res) => {
    const [p, q] = req.url.split('?'); handler(req, res, p, q || '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const current = await (await fetch(base + '/data/resource-manifest.json')).json();
  assert.equal(current.files.length, bodies.size);
  assert.equal(current.sized, bodies.size, 'sizes come from publication even with an empty public directory');
  for (const f of current.files) {
    const key = decodeURI(new URL(f.url).pathname).replace('/game', '');
    assert.equal(f.hash, inst.published.preload[key].hash);
    assert.equal(f.size, inst.published.preload[key].size);
  }
  const publicManifest = await fetch(base + '/assets-manifest.json?v=' + inst.published.tag);
  assert.equal(await publicManifest.text(), JSON.stringify({ tag: inst.published.tag, hashes: inst.published.hashes }),
    'adding server-only metadata preserves the exact body at the existing immutable URL');
  const oldManifest = { ...current, version: 'old', files: current.files.map((f) => ({ ...f, hash: 'syn-old', size: null })) };
  const source = store(oldManifest);
  await source.store.download();
  const exported = await exportResourceZip(source.store);
  const incomplete = store(oldManifest);
  assert.equal((await importResourceZip(incomplete.store, exported.blob)).imported, 0, 'reproduces the original skip');
  const target = store(current);
  const result = await importResourceZip(target.store, exported.blob);
  assert.equal(result.imported, bodies.size);
  assert.equal(result.skippedPackage, 0);
  await target.store.download();
  assert.deepEqual(target.calls, [], 'old packages need no second export or resource network requests');
  const upgraded = store(current, source.caches);
  const adopted = await upgraded.store.download();
  assert.equal(adopted.complete, true);
  assert.equal(adopted.adopted, bodies.size);
  assert.deepEqual(upgraded.calls, [], 'pre-existing synthetic-hash cache bytes are verified and adopted');
});

test('published metadata wins over stale local bytes only for the matching CDN URL version', async (t) => {
  const inst = install(t);
  const [url] = bodies.keys();
  const abs = path.join(inst.publicDir, url);
  fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'stale local data');
  const opts = { ...inst, cdnBase: CDN, assetsManifest: inst.published, rewrite: (v) => rewrite(v, inst.published) };
  const current = (await createResourceIndex(opts).get()).manifest.files.find((f) => f.url.includes('/char/'));
  assert.equal(current.hash, inst.published.preload[url].hash);
  assert.equal(current.size, inst.published.preload[url].size);
  const local = (await createResourceIndex({ ...opts, cdnBase: '', rewrite: (v) => v }).get()).manifest.files.find((f) => f.url === url);
  assert.equal(local.hash, sha('stale local data', 'sha1', 12));
  assert.equal(local.size, Buffer.byteLength('stale local data'));
  fs.rmSync(abs);
  const mismatched = (await createResourceIndex({ ...opts,
    rewrite: (v) => rewrite(v, { ...inst.published, hashes: Object.fromEntries([...bodies.keys()].map((p) => [p, 'ffffffffffffffff'])) }),
  }).get()).manifest;
  assert.ok(mismatched.files.every((f) => f.hash.startsWith('syn-')));
  assert.equal(mismatched.sized, 0);
  const foreign = (await createResourceIndex({ ...opts, rewrite: (v) => rewrite(v, inst.published, 'https://elsewhere.example') }).get()).manifest;
  assert.ok(foreign.files.every((f) => f.hash.startsWith('syn-')));
});

test('manifest reader ignores unlisted and malformed preload rows while retaining legacy publications', (t) => {
  const inst = install(t), [url] = bodies.keys();
  const doc = { ...inst.published, preload: {
    [url]: inst.published.preload[url],
    '/assets/unlisted.png': { hash: 'aaaaaaaaaaaa', size: 1 },
    '/assets/spine/op/a.skel': { hash: 'syn-invalid', size: 1 },
    '/assets/audio/sfx/a.mp3': { hash: 'aaaaaaaaaaaa', size: -1 },
  } };
  fs.writeFileSync(inst.manifestFile, JSON.stringify(doc));
  assert.deepEqual(readAssetsManifestFile(inst.manifestFile).preload, { [url]: inst.published.preload[url] });
  delete doc.preload;
  fs.writeFileSync(inst.manifestFile, JSON.stringify(doc));
  assert.deepEqual(readAssetsManifestFile(inst.manifestFile), doc);
});

test('metadata-only publishing is offline, preserves all CDN keys, and refuses unpublished bytes', async (t) => {
  const inst = install(t);
  const tools = path.join(inst.root, 'tools'); fs.mkdirSync(tools);
  for (const name of ['r2-sync.mjs', 'published-assets.mjs']) fs.copyFileSync(new URL('../../tools/' + name, import.meta.url), path.join(tools, name));
  const networkGuard = path.join(inst.root, 'network-guard.mjs');
  fs.writeFileSync(networkGuard, "globalThis.fetch = () => { throw Error('network forbidden'); };\n");
  const files = [];
  for (const [url, body] of bodies) {
    const abs = path.join(inst.publicDir, url);
    fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body);
    files.push({ key: url.slice(1), ...await fingerprintPublishedAsset(abs) });
  }
  const legacy = { tag: inst.published.tag, hashes: inst.published.hashes };
  const original = JSON.stringify(legacy) + '\n';
  fs.writeFileSync(inst.manifestFile, original);
  // Independently reproduce the pre-fix publisher's tag algorithm.
  const tag = createHash('sha256');
  for (const f of files.sort((a, b) => a.key.localeCompare(b.key, 'en'))) tag.update(f.key + '\0' + f.hash + '\0');
  assert.equal(publishedAssetsManifest(files).tag, tag.digest('hex').slice(0, 16));
  const run = (...args) => spawnSync(process.execPath, ['--import', pathToFileURL(networkGuard).href, path.join(tools, 'r2-sync.mjs'), '--metadata-only', ...args], { encoding: 'utf8' });
  const dry = run('--dry-run'); assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.readFileSync(inst.manifestFile, 'utf8'), original);
  const updated = run(); assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(inst.manifestFile, 'utf8')), inst.published);
  const before = fs.readFileSync(inst.manifestFile, 'utf8');
  fs.writeFileSync(path.join(inst.publicDir, [...bodies.keys()][0]), 'unpublished');
  const refused = run(); assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Unpublished asset changes/);
  assert.equal(fs.readFileSync(inst.manifestFile, 'utf8'), before);
});
