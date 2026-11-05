import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createStaticHandler } from '../server/http/static.js';

const packIndex = (padding) => JSON.stringify({
  format: 'stronghold-resource-pack-index',
  version: 1,
  packs: [{ id: 'ui-01', name: 'ui', url: 'https://origin.example/packs/ui-01.zip',
    files: [{ path: 'avatar/ui-01.png', url: '/assets/avatar/ui-01.png' }, { path: 'pad', url: `/assets/pad/${padding}` }] }],
});

test('the resource pack index is routed once per file identity, 304s without a rebuild, and rebuilds when the file changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-packs-memo-'));
  for (const name of ['data', 'public', 'shared', 'sim']) fs.mkdirSync(path.join(dir, name));
  const file = path.join(dir, 'data/resource-packs.json');
  fs.writeFileSync(file, packIndex('x'.repeat(1200)));
  const handler = createStaticHandler({ publicDir: path.join(dir, 'public'), dataDir: path.join(dir, 'data'),
    sharedDir: path.join(dir, 'shared'), simDir: path.join(dir, 'sim'),
    resourcePackRoutes: ['https://mirror.example/{file}'] });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handler(req, res, url.pathname, url.search.slice(1)).catch((error) => { res.destroy(error); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  try {
    // first request: the doc is read, routed (server setting's mirrors first, the pack's own url last) and memoized
    const first = await request('/data/resource-packs.json');
    assert.equal(first.status, 200);
    const routed = JSON.parse(first.body);
    assert.deepEqual(routed.packs[0].urls,
      ['https://mirror.example/ui-01.zip', 'https://origin.example/packs/ui-01.zip']);
    assert.match(first.headers.etag, /^"resource-packs-[0-9a-f]{64}"$/);
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.equal(handler.cacheStats().packsMemoBuilds, 1);

    // second request: stat identity hit — no rebuild, byte-for-byte the same answer
    const second = await request('/data/resource-packs.json');
    assert.deepEqual({ status: second.status, etag: second.headers.etag, body: second.body },
      { status: first.status, etag: first.headers.etag, body: first.body });
    assert.equal(handler.cacheStats().packsMemoBuilds, 1);
    assert.equal(handler.cacheStats().packsMemoHits, 1);

    // `?v=<release tag>` verified → immutable, same memoized bytes
    const tagged = await request(`/data/resource-packs.json?v=${handler.version}`);
    assert.match(tagged.headers['cache-control'], /immutable/);
    assert.equal(tagged.body.toString(), second.body.toString());
    assert.equal(handler.cacheStats().packsMemoHits, 2);

    // gzip: same routed body, its own ETag; the compression is memoized per ETag by the gzip cache
    const gz = await request('/data/resource-packs.json', { 'Accept-Encoding': 'gzip' });
    assert.equal(gz.status, 200); assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.equal(gz.headers.etag, `"${first.headers.etag.slice(1, -1)}-gz"`);
    assert.deepEqual(JSON.parse(gunzipSync(gz.body)), routed);
    const gzHits = handler.cacheStats().packsMemoHits;
    assert.deepEqual((await request('/data/resource-packs.json', { 'Accept-Encoding': 'gzip' })).body, gz.body);
    assert.equal(handler.cacheStats().packsMemoHits, gzHits + 1);

    // 304 revalidation answers from the memo too — including the gz validator
    assert.equal((await request('/data/resource-packs.json', { 'If-None-Match': first.headers.etag })).status, 304);
    assert.equal((await request('/data/resource-packs.json', { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.headers.etag })).status, 304);
    assert.equal((await request('/data/resource-packs.json', { 'Accept-Encoding': 'br', 'If-None-Match': gz.headers.etag })).status, 200, 'a br request does not match the gz validator');
    const head = await request('/data/resource-packs.json', {}, 'HEAD');
    assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), first.body.length);

    // identity invalidation: rewritten bytes (different size) rebuild, with a new ETag — old validator misses
    fs.writeFileSync(file, packIndex('y'.repeat(2400)));
    const changed = await request('/data/resource-packs.json');
    assert.equal(changed.status, 200);
    assert.equal(JSON.parse(changed.body).packs[0].urls[0], 'https://mirror.example/ui-01.zip');
    assert.notEqual(changed.headers.etag, first.headers.etag);
    assert.equal(handler.cacheStats().packsMemoBuilds, 2);
    assert.equal((await request('/data/resource-packs.json', { 'If-None-Match': first.headers.etag })).status, 200);
    assert.equal((await request('/data/resource-packs.json', { 'If-None-Match': changed.headers.etag })).status, 304);

    // a same-size rewrite with a moved mtime is another file too (rsync -t / touch -r protection)
    fs.writeFileSync(file, packIndex('z'.repeat(2400)));
    const st = fs.statSync(file);
    fs.utimesSync(file, new Date(), new Date(st.mtimeMs + 5000));
    const rewritten = await request('/data/resource-packs.json');
    const rerouted = JSON.parse(rewritten.body);
    assert.equal(rerouted.packs[0].files[1].url, `/assets/pad/${'z'.repeat(2400)}`, 'the new bytes are served, not the memoized old ones');
    assert.deepEqual(rerouted.packs[0].urls, ['https://mirror.example/ui-01.zip', 'https://origin.example/packs/ui-01.zip']);
    assert.equal(handler.cacheStats().packsMemoBuilds, 3);

    // gone is gone: a deleted file answers 404 from the stat alone
    fs.rmSync(file);
    assert.equal((await request('/data/resource-packs.json')).status, 404);
  } finally {
    await handler.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a resource pack index of another shape is served verbatim and still memoized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-packs-memo-'));
  for (const name of ['data', 'public', 'shared', 'sim']) fs.mkdirSync(path.join(dir, name));
  const file = path.join(dir, 'data/resource-packs.json');
  fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
  const handler = createStaticHandler({ publicDir: path.join(dir, 'public'), dataDir: path.join(dir, 'data'),
    sharedDir: path.join(dir, 'shared'), simDir: path.join(dir, 'sim'),
    resourcePackRoutes: ['https://mirror.example/{file}'] });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handler(req, res, url.pathname, url.search.slice(1)).catch((error) => { res.destroy(error); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = (url, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, headers }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  try {
    // no `format`/`version`: no routing pass — but the memo still answers the repeat and the 304
    const first = await request('/data/resource-packs.json');
    assert.deepEqual(JSON.parse(first.body), { hello: 'world' });
    assert.equal((await request('/data/resource-packs.json')).body.toString(), first.body.toString());
    assert.equal((await request('/data/resource-packs.json', { 'If-None-Match': first.headers.etag })).status, 304);
    assert.equal(handler.cacheStats().packsMemoBuilds, 1);
    assert.equal(handler.cacheStats().packsMemoHits, 2);
  } finally {
    await handler.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
