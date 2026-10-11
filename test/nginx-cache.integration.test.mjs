// Run with NGINX_PATH pointing to a local nginx executable. Uses only temporary
// config/cache/logs and loopback ports; never reads deployment credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { startAgent } from '../ops/agent.mjs';

const binary = process.env.NGINX_PATH;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalized = file => file.replaceAll('\\', '/');
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('real nginx examples: manifest caching, current health, log metadata and authenticated Agent',
  { skip: !binary && 'Set NGINX_PATH to run real nginx', timeout: 60000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-nginx-cache-'));
    for (const folder of ['logs', 'cache', 'temp', 'public/icons']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public/icons/app.svg'), '<svg/>');
    const hits = new Map(); let fail = false, healthSequence = 0;
    const body = JSON.stringify({ files: ['/assets/test.png'], count: 1 });
    const backend = await listen(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      hits.set(req.url, (hits.get(req.url) || 0) + 1);
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(url.searchParams.get('build') === '1' ? { build: 'release' } : { build: 'release', seq: ++healthSequence })); return;
      }
      if (url.pathname === '/api/rooms/random') {
        res.writeHead(429, { 'X-Portal-Reason': 'ROOM_CHECK_BUSY', 'Cache-Control': 'no-store' }); res.end('{}'); return;
      }
      if (url.pathname === '/api/announcement') {
        if (fail) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('{}'); return; }
        // Shorten only this fixture's TTL so stale-on-error is tested without a 30s wait.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Expires': '1' }); res.end('{"announcement":null}'); return;
      }
      if (url.searchParams.get('v') === 'old' || /nodedata\.js$/i.test(url.pathname)) {
        res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('missing'); return;
      }
      if (fail || url.searchParams.get('error')) { res.writeHead(500, { 'Cache-Control': 'no-store' }); res.end('failed'); return; }
      if (url.searchParams.get('lock')) await delay(100);
      const gz = /gzip/.test(req.headers['accept-encoding'] || '');
      const etag = gz ? '"manifest-gz"' : '"manifest"';
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': url.pathname.startsWith('/_v/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'Accept-Ranges': 'bytes', Vary: 'Accept-Encoding', ETag: etag,
        'X-Accel-Expires': url.pathname === '/data/resource-manifest.json' ? (url.searchParams.has('v') ? '43200' : '1') : '0' };
      // Static version/asset manifest uses normal Cache-Control, not X-Accel-Expires.
      if (url.pathname !== '/data/resource-manifest.json') delete headers['X-Accel-Expires'];
      if (gz) headers['Content-Encoding'] = 'gzip';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
      const encoded = gz ? gzipSync(body) : Buffer.from(body);
      headers['Content-Length'] = encoded.length;
      res.writeHead(200, headers); res.end(encoded);
    });
    const ended = Math.floor(Date.now() / 60000) * 60000;
    const minute = { httpMinuteStartedAt: ended - 60000, httpMinuteEndedAt: ended, httpMinuteErrors: 23, httpMinuteAborts: 52 };
    const sample = { current: { t: Date.now(), game: true, sockets: 2, gameMainThreadCpuPct: 42, gameEventLoopP99Ms: 60,
      cpuStealPct: 6, requestMinuteWindows: [minute], connsTop: ['private-test-address'] }, series: [], today: {}, history: [], capabilities: { sampleHistory: true }, diagnostics: { nginx: { status: 'ok' }, storage: { status: 'ok' } } };
    const cursor = Buffer.from(JSON.stringify({ file: 'samples-2026-10-11.jsonl', offset: 1, ino: '123' })).toString('base64url');
    const collector = await listen((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.startsWith('/api/samples') ? { schemaVersion: 1, records: [sample], nextCursor: cursor, hasMore: false } : sample));
    });
    const token = 'nginx-test-only-token-01234567890123456789';
    const agent = await startAgent({ token, collectorUrl: `http://127.0.0.1:${collector.port}/api/data`, intervalMs: 300000 });
    await agent.refresh();
    const reservation = await listen((_req, res) => res.end()); const port = reservation.port;
    await new Promise(resolve => reservation.server.close(resolve));
    const prefix = normalized(dir) + '/';
    const fragment = read('scripts/nginx-game-cache.conf.example').replaceAll('127.0.0.1:3000', `127.0.0.1:${backend.port}`).replaceAll('/opt/sp-public', normalized(path.join(dir, 'public')));
    fs.writeFileSync(path.join(dir, 'game.conf'), fragment);
    fs.writeFileSync(path.join(dir, 'log.conf'), read('scripts/nginx-log-format.conf.example'));
    let config = read('scripts/nginx.conf.example')
      .replace('include /etc/nginx/conf.d/sp-log-format.conf;', `include "${prefix}log.conf";`)
      .replace('include /etc/nginx/snippets/stronghold-game-cache.conf;', `include "${prefix}game.conf";`)
      .replace('/var/cache/nginx/sp_assets', 'cache').replace('/var/log/nginx/sp/stronghold.access.log', 'logs/access.log')
      .replace('listen 443 ssl;', `listen 127.0.0.1:${port};`)
      .replace(/^\s*ssl_certificate(?:_key)?\s+.*$/gm, '')
      .replaceAll('127.0.0.1:3000', `127.0.0.1:${backend.port}`)
      .replace('server_name game.example.com;', 'server_name game.example.com;\nproxy_buffering off;\n' + read('ops/deploy/nginx-agent.conf.example').replaceAll('127.0.0.1:3900', `127.0.0.1:${agent.port}`));
    config = 'pid logs/nginx.pid;\nerror_log logs/error.log;\n' + config;
    fs.writeFileSync(path.join(dir, 'nginx.conf'), config);
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-s', 'quit'], { windowsHide: true, timeout: 5000 });
        await Promise.race([exited, delay(5000)]);
        if (child.exitCode === null) child.kill();
      }
      await agent.close();
      for (const server of [backend.server, collector.server]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const check = spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-t'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    child = spawn(binary, ['-p', prefix, '-c', 'nginx.conf', '-g', 'daemon off; master_process off;'], { windowsHide: true, stdio: 'ignore' });
    const get = (url, init = {}) => fetch(`http://127.0.0.1:${port}${url}`, { ...init, signal: AbortSignal.timeout(5000), headers: { 'Accept-Encoding': 'identity', ...init.headers } });
    let ready = false;
    for (let i = 0; i < 50; i++) { try { await (await get('/healthz')).text(); ready = true; break; } catch { await delay(50); } }
    assert.ok(ready, fs.readFileSync(path.join(dir, 'logs/error.log'), 'utf8'));

    await t.test('versioned and plain manifests cache with query/host/encoding separation, ETag and HEAD', async () => {
      const url = '/data/resource-manifest.json?v=current';
      const first = await get(url); assert.equal(first.headers.get('x-resource-cache'), 'MISS'); assert.equal(await first.text(), body);
      const next = await get(url); assert.equal(next.headers.get('x-resource-cache'), 'HIT'); assert.equal(await next.text(), body);
      const conditional = await get(url, { headers: { 'If-None-Match': '"manifest"' } });
      assert.equal(conditional.status, 304); assert.equal(await conditional.text(), ''); assert.equal(hits.get(url), 1);
      const head = await get(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(hits.get(url), 1);
      const gzip = await get(url, { headers: { 'Accept-Encoding': 'gzip' } }); assert.equal(gzip.headers.get('content-encoding'), 'gzip'); assert.equal(await gzip.text(), body);
      assert.equal((await get(url, { headers: { 'Accept-Encoding': 'gzip' } })).headers.get('x-resource-cache'), 'HIT');
      // Use node:http: browser-style fetch may discard an explicit Host override.
      const otherHostCache = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: url, headers: { Host: 'other.example', 'Accept-Encoding': 'identity' } }, res => {
          res.resume(); res.on('end', () => resolve(res.headers['x-resource-cache']));
        }); req.on('error', reject);
      });
      assert.equal(otherHostCache, 'MISS');
      for (let i = 0; i < 2; i++) assert.equal((await get('/data/resource-manifest.json?v=old')).status, 404);
      assert.equal(hits.get('/data/resource-manifest.json?v=old'), 2);
      const plain = await get('/data/resource-manifest.json'); assert.equal(plain.headers.get('x-resource-cache'), 'MISS');
      assert.equal((await get('/data/resource-manifest.json')).headers.get('x-resource-cache'), 'HIT');
      await (await get('/api/announcement')).text();
      assert.equal((await get('/api/announcement')).headers.get('x-announcement-cache'), 'HIT');
      await delay(2200); fail = true;
      try {
        assert.equal((await get('/data/resource-manifest.json')).status, 500, 'expired plain manifests cannot mask failures');
        assert.equal((await get('/api/announcement')).status, 503, 'expired announcements cannot mask failures');
        assert.equal((await get(url)).headers.get('x-resource-cache'), 'HIT', 'versioned upstream TTL overrides the short default');
      }
      finally { fail = false; }
    });
    await t.test('cache lock coalesces fills, errors never cache, asset manifests and versioned resources hit', async () => {
      const url = '/data/resource-manifest.json?v=current&lock=1';
      const results = await Promise.all(Array.from({ length: 8 }, async () => { const r = await get(url); assert.equal(r.status, 200); await r.text(); }));
      assert.equal(results.length, 8); assert.equal(hits.get(url), 1);
      for (let i = 0; i < 2; i++) assert.equal((await get('/data/resource-manifest.json?v=current&error=1')).status, 500);
      assert.equal(hits.get('/data/resource-manifest.json?v=current&error=1'), 2);
      for (const [url, header] of [['/assets-manifest.json?v=art', 'x-asset-manifest-cache'], ['/_v/0123456789abcdef/js/main.js', 'x-asset-cache']]) {
        await (await get(url)).text(); assert.equal((await get(url)).headers.get(header), 'HIT'); assert.equal(hits.get(url), 1);
      }
      const range = await get('/_v/0123456789abcdef/js/main.js', { headers: { Range: 'bytes=0-3' } });
      assert.equal(range.status, 206); assert.equal(await range.text(), body.slice(0, 4));
    });
    await t.test('health and admin stay uncached; Agent forwards new metrics, enforces Bearer and strips private fields', async () => {
      const a = await (await get('/healthz')).json(), b = await (await get('/healthz')).json(); assert.notEqual(a.seq, b.seq);
      assert.deepEqual(await (await get('/healthz?build=1')).json(), { build: 'release' });
      const url = '/api/admin/v1/overview'; assert.equal((await get(url)).status, 403);
      const valid = await get(url, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(valid.status, 200);
      assert.equal(valid.headers.get('access-control-allow-origin'), null); assert.match(valid.headers.get('cache-control'), /no-store/);
      const data = await valid.json(); assert.equal(data.metrics.current.gameMainThreadCpuPct, 42); assert.equal(data.metrics.current.cpuStealPct, 6);
      assert.equal(data.metrics.current.gameEventLoopP99Ms, 60); assert.ok(!JSON.stringify(data).includes('private-test-address'));
      assert.equal(data.metrics.current.requestMinuteWindows[0].httpMinuteErrors, 23);
      const history = await (await get('/api/admin/v1/samples?limit=1', { headers: { Authorization: `Bearer ${token}` } })).json();
      assert.equal(history.records[0].current.requestMinuteWindows[0].httpMinuteStartedAt, ended - 60000);
      assert.equal(history.records[0].current.cpuStealPct, 6); assert.equal(history.nextCursor, cursor);
      assert.ok(!JSON.stringify(history).includes('private-test-address'));
      assert.equal((await get(url)).status, 403, 'authorized response must not leak through shared cache');
      assert.equal((await get('/internal/admin/test')).status, 404);
      assert.equal((await get('/icons/app.svg')).status, 200);
      await (await get('/api/rooms/random', { method: 'POST' })).text();
      await delay(5500);
      const log = fs.readFileSync(path.join(dir, 'logs/access.log'), 'utf8');
      assert.match(log, /rt=\d+\.\d+ urt=/); assert.match(log, /cache=HIT/); assert.match(log, /reason=ROOM_CHECK_BUSY/);
    });
  });
