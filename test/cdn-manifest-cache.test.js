import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createStaticHandler } from '../server/http/static.js';

test('rewritten versioned JSON retains immutable caching, encoding validators and cached compression', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-cache-'));
  for (const name of ['data', 'public', 'shared', 'sim']) fs.mkdirSync(path.join(dir, name));
  const file = path.join(dir, 'data/assets.json');
  fs.writeFileSync(file, JSON.stringify({ ui: { icon: '/assets/a.png', padding: 'x'.repeat(12000) } }));
  const handler = createStaticHandler({ publicDir: path.join(dir, 'public'), dataDir: path.join(dir, 'data'),
    sharedDir: path.join(dir, 'shared'), simDir: path.join(dir, 'sim'), cdnBase: 'https://cdn.example',
    assetsManifest: { tag: '0123456789abcdef', hashes: { '/assets/a.png': 'aaaaaaaaaaaaaaaa' } } });
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
    const config = await request('/js/asset-cdn.js');
    const settings = await import('data:text/javascript,' + encodeURIComponent(config.body.toString()));
    assert.equal(settings.ASSETS_MANIFEST, '/assets-manifest.json?v=0123456789abcdef');
    const projection = JSON.parse((await request(settings.ASSETS_MANIFEST)).body);
    assert.deepEqual(Object.keys(projection).sort(), ['hashes', 'tag']);
    const url = `/_v/${handler.version}/data/assets.json`;
    const queryUrl = `/data/assets.json?v=${handler.version}`;
    assert.match((await request(queryUrl)).headers['cache-control'], /immutable/);
    const plain = await request('/data/assets.json');
    assert.equal(plain.headers['cache-control'], 'no-cache');
    const gz = await request(url, { 'Accept-Encoding': 'gzip' });
    assert.equal(gz.status, 200); assert.match(gz.headers['cache-control'], /immutable/);
    assert.equal(gz.headers.vary, 'Accept-Encoding'); assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(JSON.parse(gunzipSync(gz.body)).ui.icon, 'https://cdn.example/assets/a.png');
    const count = handler.cacheStats().gzipEntries;
    assert.deepEqual((await request(url, { 'Accept-Encoding': 'gzip' })).body, gz.body);
    assert.equal(handler.cacheStats().gzipEntries, count);
    const br = await request(url, { 'Accept-Encoding': 'br' });
    assert.equal(br.headers['content-encoding'], 'br'); assert.notEqual(br.headers.etag, gz.headers.etag);
    assert.deepEqual(brotliDecompressSync(br.body), gunzipSync(gz.body));
    assert.equal((await request(url, { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.headers.etag })).status, 304);
    assert.equal((await request(url, { 'Accept-Encoding': 'br', 'If-None-Match': gz.headers.etag })).status, 200);
    const head = await request(url, { 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), gz.body.length);
    fs.writeFileSync(file, '{"ui":{"icon":"/assets/b.png"}}');
    assert.equal((await request(url)).status, 503, 'old version cannot cache changed bytes');
    assert.equal((await request(queryUrl)).status, 503, 'matching query tag cannot cache changed bytes either');
    const fresh = await request('/data/assets.json');
    assert.equal(JSON.parse(fresh.body).ui.icon, 'https://cdn.example/assets/b.png');
    assert.notEqual(fresh.headers.etag, plain.headers.etag);
  } finally {
    await handler.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
