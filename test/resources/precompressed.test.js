import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, stat, utimes, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createStaticHandler } from '../../server/http/static.js';
import { serveFile, CompressCache } from '../../server/http/files.js';
import { collectHashes } from '../../tools/asset-hashes.mjs';
import { ResourceStore } from '../../public/js/resources/store.js';
import { exportResourceZip, importResourceZip } from '../../public/js/resources/archive.js';
import { createResourceIndex } from '../../server/resources.js';

async function fixture(t, { size = 20000 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-precompressed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public');
  await mkdir(path.join(publicDir, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'data'));
  const raw = Buffer.alloc(size, 'skeleton raw bytes! ');
  const file = path.join(publicDir, 'assets', 'a.skel');
  const side = file + '.br', gz = file + '.gz';
  await writeFile(file, raw);
  const br = zlib.brotliCompressSync(raw);
  const gzip = zlib.gzipSync(raw);
  await writeFile(side, br); await writeFile(gz, gzip);
  const now = new Date();
  await utimes(file, now, now); await utimes(side, now, now); await utimes(gz, now, now);
  return { root, publicDir, file, side, gz, raw, br, gzip };
}

async function listen(t, handler) {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function request(port, headers = {}, method = 'GET', url = '/assets/a.skel') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

test('static Brotli/gzip preserve negotiation, ETags, MIME, HEAD, identity and raw Range', async (t) => {
  const f = await fixture(t);
  const cache = { get: () => { throw new Error('Static sibling must avoid compression cache'); } };
  const port = await listen(t, async (req, res) => serveFile(req, res, f.file, await stat(f.file),
    'public', ['assets', 'a.skel'], '', cache, {}));
  const br = await request(port, { 'Accept-Encoding': 'br, gzip' });
  assert.equal(br.status, 200);
  assert.deepEqual(br.body, f.br);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(Number(br.headers['content-length']), f.br.length);
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.equal(br.headers['content-type'], 'application/octet-stream');
  assert.equal(br.headers['cache-control'], 'public, max-age=86400');
  assert.match(br.headers.etag, /-br-static-/);
  const gzip = await request(port, { 'Accept-Encoding': 'gzip, br;q=0' });
  assert.deepEqual(gzip.body, f.gzip);
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.notEqual(gzip.headers.etag, br.headers.etag);
  const head = await request(port, { 'Accept-Encoding': 'br' }, 'HEAD');
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], br.headers['content-length']);
  const modified = await request(port, { 'Accept-Encoding': 'br', 'If-None-Match': br.headers.etag });
  assert.equal(modified.status, 304);
  const identity = await request(port, { 'Accept-Encoding': 'identity' });
  assert.deepEqual(identity.body, f.raw);
  assert.equal(identity.headers['content-encoding'], undefined);
  const range = await request(port, { 'Accept-Encoding': 'br', Range: 'bytes=2-7' });
  assert.equal(range.status, 206);
  assert.deepEqual(range.body, f.raw.subarray(2, 8));
  assert.equal(range.headers['content-encoding'], undefined);
  assert.equal(range.headers['content-range'], `bytes 2-7/${f.raw.length}`);
  assert.equal((await request(port, { Range: `bytes=${f.raw.length}-` })).status, 416);
});

test('stale or missing siblings fall back; new sibling revision invalidates ETag', async (t) => {
  const f = await fixture(t);
  const cache = new CompressCache();
  const port = await listen(t, async (req, res) => serveFile(req, res, f.file, await stat(f.file),
    'public', ['assets', 'a.skel'], '', cache, {}));
  const first = await request(port, { 'Accept-Encoding': 'br' });
  const future = new Date(Date.now() + 3000);
  await utimes(f.side, future, future);
  const changed = await request(port, { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  const past = new Date(Date.now() - 20000);
  await utimes(f.side, past, past);
  const stale = await request(port, { 'Accept-Encoding': 'br' });
  assert.deepEqual(zlib.brotliDecompressSync(stale.body), f.raw);
  assert.doesNotMatch(stale.headers.etag, /static/);
  assert.equal(cache.map.size, 1);
  await rm(f.gz);
  const missing = await request(port, { 'Accept-Encoding': 'gzip' });
  assert.deepEqual(zlib.gunzipSync(missing.body), f.raw);
  assert.equal(cache.map.size, 2);
});

test('large static sibling streams without dynamic cache and missing raw files remain 404', async (t) => {
  const f = await fixture(t, { size: 9 * 1024 * 1024 });
  const handler = createStaticHandler({ publicDir: f.publicDir, dataDir: path.join(f.root, 'data'),
    sharedDir: path.join(f.root, 'shared'), packsDir: path.join(f.root, 'packs'), clientBuild: false });
  const port = await listen(t, (req, res) => handler(req, res, req.url, ''));
  const response = await request(port, { 'Accept-Encoding': 'br' });
  assert.deepEqual(response.body, f.br);
  assert.equal(handler.cacheStats().gzipBytes, 0);
  await rm(f.file);
  assert.equal((await request(port, { 'Accept-Encoding': 'br' })).status, 404);
});

test('sidecar symlink outside the raw real directory is ignored', async (t) => {
  const f = await fixture(t);
  await rm(f.side);
  const outside = path.join(f.root, 'outside.br');
  await writeFile(outside, f.br);
  try { await symlink(outside, f.side); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink privilege unavailable');
    throw error;
  }
  const port = await listen(t, async (req, res) => serveFile(req, res, f.file, await stat(f.file),
    'public', ['assets', 'a.skel'], '', new CompressCache(), {}));
  assert.doesNotMatch((await request(port, { 'Accept-Encoding': 'br' })).headers.etag, /static/);
});

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

test('compressed transfers still hash/cache/export decoded bytes; existing cache needs no migration', async (t) => {
  const f = await fixture(t);
  const hashes = await collectHashes({ root: f.root });
  assert.equal(hashes.count, 1, 'static sidecars are not resource ZIP entries');
  await writeFile(path.join(f.root, 'data', 'assets.json'), JSON.stringify({ hash: 'fixture', ui: { a: '/assets/a.skel' } }));
  await writeFile(path.join(f.root, 'data', 'asset-hashes.json'), JSON.stringify(hashes));
  const { manifest } = await createResourceIndex({ dataDir: path.join(f.root, 'data'), publicDir: f.publicDir }).get();
  assert.equal(manifest.files[0].size, f.raw.length);
  const cache = new CompressCache();
  const port = await listen(t, async (req, res) => serveFile(req, res, f.file, await stat(f.file),
    'public', ['assets', 'a.skel'], '', cache, {}));
  const origin = `http://127.0.0.1:${port}`;
  const caches = new MemoryCaches();
  let calls = 0;
  const fetcher = (url, options) => {
    calls++;
    return fetch(url, { ...options, headers: { 'Accept-Encoding': 'br' } });
  };
  const store = new ResourceStore(manifest, { caches, origin, fetcher });
  assert.equal((await store.download()).downloaded, 1);
  const response = await (await caches.open(store.cacheName)).match(origin + '/assets/a.skel');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.raw);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal((await store.download()).downloaded, 0);
  assert.equal(calls, 1);
  const zip = await exportResourceZip(store);
  const destination = new ResourceStore(manifest, { caches: new MemoryCaches(), origin });
  assert.equal((await importResourceZip(destination, zip.blob)).imported, 1);
  assert.deepEqual(await readFile(f.file), f.raw);
});
