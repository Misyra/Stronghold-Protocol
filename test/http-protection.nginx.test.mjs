// Opt in: NGINX_PATH=<binary> node --test test/http-protection.nginx.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequestHandler } from '../server/http/routes.js';
import { createIpBanStore } from '../server/http/ipBans.js';

const binary = process.env.NGINX_PATH;

test('real nginx: build polling shares neither the bare-health bucket nor other IP budgets, but remains bounded',
  { skip: !binary, timeout: 20000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-build-budget-'));
    const prefix = dir.replaceAll('\\', '/') + '/';
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.mkdirSync(path.join(dir, 'temp'));
    const reserve = http.createServer(); const port = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    let child;
    t.after(async () => {
      if (child) {
        spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-s', 'quit'], { windowsHide: true, timeout: 3000 });
        if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1000)]);
        if (child.exitCode === null) child.kill();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const template = read('nginx.conf.example');
    const perIpHealth = template.match(/map \$sp_health_global_key \$sp_health_key[^\n]+/)[0];
    const healthZone = template.match(/limit_req_zone \$sp_health_key[^\n]+/)[0];
    const limits = template.match(/limit_req zone=sp_(?:health|build)(?:_global)? burst=\d+ nodelay;/g).join('\n');
    // Static files still pass through nginx's preaccess limiter; return/rewrite would bypass it.
    fs.writeFileSync(path.join(dir, 'healthz'), 'ok');
    fs.writeFileSync(path.join(dir, 'nginx.conf'), `pid nginx.pid;
events { worker_connections 256; }
http {
map $remote_addr $sp_local_api_monitor { default 0; }
${read('hardening/sp-health-cache-map.conf')}
${perIpHealth}
${healthZone}
server {
listen 127.0.0.1:${port};
set_real_ip_from 127.0.0.1;
real_ip_header X-Test-IP;
limit_req_status 429;
${limits}
location = /healthz { root "${prefix}"; }
location = /ready { return 200 'ready'; }
}}
`);
    const checked = spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-t'], { encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, checked.stderr);
    child = spawn(binary, ['-p', prefix, '-c', 'nginx.conf', '-g', 'daemon off; master_process off;'], { windowsHide: true, stdio: 'ignore' });
    const request = async (query, ip = '203.0.113.1') => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz${query}`, { headers: { 'X-Test-IP': ip } });
      await response.text(); return response.status;
    };
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/ready`); await r.text(); ready = true; break; }
      catch { await delay(25); }
    }
    assert.ok(ready);
    // Four bare requests fit the initial burst. The fifth is blocked, but four players can still poll.
    for (let i = 0; i < 4; i++) assert.equal(await request(''), 200);
    assert.equal(await request('?nonce=bare'), 429);
    for (let i = 0; i < 4; i++) assert.equal(await request(`?build=1&nonce=${i}`), 200);
    // Changing query arguments cannot buy another build burst; another source retains its own tokens.
    const flood = [];
    for (let i = 0; i < 30; i++) flood.push(await request(`?build=1&random=${i}`));
    assert.ok(flood.includes(429));
    assert.equal(await request('?build=1', '203.0.113.2'), 200);
    assert.equal(await request('', '203.0.113.2'), 200);
    // Even independent IPs are subject to the shared build ceiling.
    const distributed = [];
    for (let i = 0; i < 200; i++) distributed.push(await request('?build=1', `198.51.100.${i + 1}`));
    assert.ok(distributed.includes(429), 'global build flood is bounded');
  });
async function fetch(input, init) {
  try { return await globalThis.fetch(input, init); }
  catch (cause) { throw new Error(`${init?.method || 'GET'} ${input} failed`, { cause }); }
}
const read = (name) => fs.readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('real nginx: defense rejections send zero HTTP bytes, retain 444 logs, preserve normal errors and WebSocket',
  { skip: !binary, timeout: 40000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-http-protection-nginx-'));
    const prefix = dir.replaceAll('\\', '/') + '/';
    fs.mkdirSync(path.join(dir, 'logs')); fs.mkdirSync(path.join(dir, 'temp'));
    fs.mkdirSync(path.join(dir, 'public', 'icons'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'icons', 'test.svg'), '<svg/>');
    const bans = createIpBanStore({ file: path.join(dir, 'bans.jsonl'), log: { warn() {}, error: assert.fail } });
    const backend = http.createServer(createRequestHandler({ ipBans: bans, log: { error: assert.fail },
      apiMainlandOnly: true, apiCountryLookup: (ip) => {
        if (ip === '198.51.100.8') throw new Error('GeoIP fixture unavailable');
        return ip === '60.249.21.30' ? 'TW' : ip === '198.51.100.9' ? null : 'CN';
      },
      publicApiLimits: { burst: 3, banThreshold: 4 },
      health: { startedAt: Date.now(), network: { connectionCount: 0 }, registry: { size: 0 }, lobby: { stats: () => ({ rooms: 0 }) } },
      serveStatic: async (req, res) => {
        const error = /^\/ordinary-error\/(403|404|500|503)$/.exec(req.url)?.[1];
        if (error) { res.writeHead(Number(error), { 'Content-Type': 'text/plain' }); res.end('ordinary error'); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : 'cached asset');
      } }));
    const wss = new WebSocketServer({ server: backend, path: '/ws' });
    wss.on('connection', (ws) => ws.send('connected'));
    const port = await listen(backend);
    const reserve = http.createServer(); const nginxPort = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    fs.writeFileSync(path.join(dir, 'log.conf'), read('nginx-log-format.conf.example'));
    fs.writeFileSync(path.join(dir, 'api-map.conf'), read('hardening/sp-public-api-map.conf'));
    fs.writeFileSync(path.join(dir, 'health-map.conf'), read('hardening/sp-health-cache-map.conf'));
    fs.writeFileSync(path.join(dir, 'business-map.conf'), read('hardening/sp-business-limit-map.conf'));
    fs.writeFileSync(path.join(dir, 'page-global.conf'), read('hardening/sp-page-global.conf'));
    fs.writeFileSync(path.join(dir, 'game.conf'), read('nginx-game-cache.conf.example')
      .replaceAll('127.0.0.1:3000', `127.0.0.1:${port}`).replaceAll('/opt/sp-public', prefix + 'public'));
    let config = read('nginx.conf.example')
      // The platform-independent suite exercises Node geography; the real GeoIP2 module has a Linux fixture.
      .replace('load_module /usr/lib/nginx/modules/ngx_http_geoip2_module.so;', '')
      .replace('include /etc/nginx/conf.d/sp-geoip-country.conf;', '')
      .replace('if ($sp_geoip_denied) { return 444; }', '')
      .replace('include /etc/nginx/conf.d/sp-log-format.conf;', `include "${prefix}log.conf";`)
      .replace('include /etc/nginx/conf.d/sp-business-limit-map.conf;', `include "${prefix}business-map.conf";`)
      .replace('include /etc/nginx/conf.d/sp-page-global.conf;', `include "${prefix}page-global.conf";`)
      .replace('include /etc/nginx/conf.d/sp-public-api-map.conf;', `include "${prefix}api-map.conf";\nmap "$sp_local_api_monitor:$http_x_test_public_api_closed:$uri" $sp_test_close_public_api { default 0; ~^0:1:/(?:api|metrics)(?:/|$) 1; }`)
      .replace('include /etc/nginx/conf.d/sp-health-cache-map.conf;', `include "${prefix}health-map.conf";\nmap "$sp_local_api_monitor:$http_x_test_health_cache" $sp_test_health_bypass { default 1; "0:1" 0; }`)
      .replaceAll('proxy_cache_bypass $sp_local_api_monitor;', 'proxy_cache_bypass $sp_test_health_bypass;')
      .replaceAll('proxy_no_cache $sp_local_api_monitor;', 'proxy_no_cache $sp_test_health_bypass;')
      // Keep this fixture's shortened Node ban window reachable; strict admission is covered separately.
      .replace('$sp_health_key zone=sp_health:10m rate=30r/m;', '$sp_health_key zone=sp_health:10m rate=60r/m;')
      .replace('limit_req zone=sp_health_global burst=18', 'limit_req zone=sp_health_global burst=40')
      // Pin the WebSocket admission values this suite asserts on; shipped defaults are looser
      // (30r/m, burst 10, 8 per IP) so real reconnects survive them.
      .replace('$binary_remote_addr zone=sp_ws_rate:10m rate=30r/m;', '$binary_remote_addr zone=sp_ws_rate:10m rate=5r/m;')
      .replace('limit_req zone=sp_ws_rate burst=10 nodelay;', 'limit_req zone=sp_ws_rate burst=3 nodelay;')
      .replace('limit_conn sp_ws_conn 8;', 'limit_conn sp_ws_conn 4;')
      // Test-only switch: exercise the underlying Node defenses and the closed API overlay in one server.
      .replace('if ($sp_close_public_api)', 'if ($sp_test_close_public_api)')
      .replace('include /etc/nginx/snippets/stronghold-game-cache.conf;', `include "${prefix}game.conf";`)
      .replace('/var/cache/nginx/sp_assets', 'cache').replace('/var/log/nginx/sp/stronghold.access.log', 'logs/access.log')
      .replace('buffer=64k flush=5s', 'buffer=64k flush=100ms')
      .replace('listen 443 ssl;', `listen 127.0.0.1:${nginxPort};`)
      .replace(/^\s*ssl_certificate.*;\r?\n/gm, '')
      .replaceAll('127.0.0.1:3000', `127.0.0.1:${port}`)
      // Test-only trusted header: exercise real_ip restoration and subsequent overwrite of forged CF headers.
      .replace('server_name game.example.com;', 'server_name game.example.com;\nset_real_ip_from 127.0.0.1;\nreal_ip_header X-Test-IP;');
    config = 'pid logs/nginx.pid;\nerror_log logs/error.log;\n' + config;
    fs.writeFileSync(path.join(dir, 'nginx.conf'), config);
    let child;
    t.after(async () => {
      if (child) {
        spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-s', 'quit'], { windowsHide: true, timeout: 3000 });
        if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1000)]);
        if (child.exitCode === null) child.kill();
      }
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const check = spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-t'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    assert.equal(check.status, 0, check.stderr);
    child = spawn(binary, ['-p', prefix, '-c', 'nginx.conf', '-g', 'daemon off; master_process off;'], { windowsHide: true, stdio: 'ignore' });
    const url = `http://127.0.0.1:${nginxPort}`;
    const get = async (pathname, ip = '203.0.113.9') => {
      try { return await fetch(url + pathname, { headers: {
        'X-Test-IP': ip, 'CF-Connecting-IP': '127.0.0.1', 'X-Real-IP': '127.0.0.1',
      } }); } catch (cause) { throw new Error(`GET ${pathname} as ${ip} failed`, { cause }); }
    };
    const dropped = (pathname, ip = '203.0.113.9', method = 'GET', closed = false) => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: nginxPort });
      const chunks = [];
      socket.setTimeout(3000, () => socket.destroy(new Error('drop timed out')));
      socket.on('connect', () => socket.write(`${method} ${pathname} HTTP/1.1\r\nHost: game.example.com\r\nX-Test-IP: ${ip}\r\nX-Test-Public-Api-Closed: ${Number(closed)}\r\nCF-Connecting-IP: 127.0.0.1\r\nX-SP-Drop-Rejections: 0\r\nConnection: close\r\n\r\n`));
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
      socket.on('close', () => { try { assert.equal(Buffer.concat(chunks).length, 0, pathname); resolve(); } catch (error) { reject(error); } });
    });
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const res = await get('/icons/test.svg'); await res.text(); ready = true; break; } catch { await delay(25); }
    }
    assert.ok(ready, 'nginx started');
    const publicPing = await get('/api/ping', '127.0.0.1');
    assert.equal(publicPing.status, 200, 'the allowlisted public ping API reaches Node');
    assert.deepEqual(await publicPing.json(), { ok: true });
    for (const pathname of ['/metrics', '/api', '/api/ping', '/api/announcement', '/api/rooms/AAAA/status', '/api/portal-room', '//api//ping', '/%61pi/ping']) {
      await dropped(pathname, '198.51.100.70', 'GET', true);
    }
    const localProbe = await fetch(url + '/healthz', { headers: { 'X-Test-Public-Api-Closed': '1' } });
    assert.equal(localProbe.status, 200, 'loopback monitoring survives API closure'); await localProbe.text();
    await dropped('/api/nickname/validate', '198.51.100.71', 'POST', true);
    const cacheHeaders = { 'X-Test-IP': '198.51.100.72', 'X-Test-Health-Cache': '1', 'X-Test-Public-Api-Closed': '1' };
    const healthMiss = await fetch(url + '/healthz?nonce=1', { headers: cacheHeaders });
    assert.equal(healthMiss.status, 200); assert.equal(healthMiss.headers.get('x-health-cache'), 'MISS');
    const healthBody = await healthMiss.json(); assert.equal(healthBody.memory, undefined);
    const healthHit = await fetch(url + '/healthz?traffic=1&nonce=2', { headers: cacheHeaders });
    assert.equal(healthHit.headers.get('x-health-cache'), 'HIT'); assert.deepEqual(await healthHit.json(), healthBody);
    const forcedRefresh = await fetch(url + '/healthz?random=3', { headers: { ...cacheHeaders, 'Cache-Control': 'no-cache', Range: 'bytes=0-1,3-4', Host: 'another.example' } });
    assert.equal(forcedRefresh.status, 200); assert.equal(forcedRefresh.headers.get('x-health-cache'), 'HIT');
    assert.deepEqual(await forcedRefresh.json(), healthBody, 'host, refresh headers and ranges cannot amplify/cache-bust public health');
    await assert.rejects(fetch(url + '/healthz', { headers: { ...cacheHeaders, Authorization: 'Bearer cache-buster' } }));
    const buildMiss = await fetch(url + '/healthz?build=1', { headers: cacheHeaders });
    assert.equal(buildMiss.headers.get('x-health-cache'), 'MISS'); const buildBody = await buildMiss.json();
    assert.deepEqual(Object.keys(buildBody), ['build']);
    const buildHit = await fetch(url + '/healthz?BUILD=1&traffic=1', { headers: cacheHeaders });
    assert.equal(buildHit.headers.get('x-health-cache'), 'HIT'); assert.deepEqual(await buildHit.json(), buildBody);
    const privateHealth = await fetch(url + '/healthz?traffic=1', { headers: { 'X-Test-Health-Cache': '1' } });
    assert.equal(privateHealth.headers.get('x-health-cache'), 'BYPASS'); assert.ok((await privateHealth.json()).memory);
    // nginx expiry timestamps have one-second granularity.
    await delay(6100);
    const healthExpired = await fetch(url + '/healthz', { headers: cacheHeaders });
    assert.equal(healthExpired.headers.get('x-health-cache'), 'EXPIRED'); await healthExpired.text();
    const asset = '/_v/0123456789abcdef/assets/test.txt';
    await (await get(asset)).text();
    const cached = await get(asset); assert.equal(cached.headers.get('x-asset-cache'), 'HIT'); await cached.text();
    assert.equal((await get('/_sp/ip-check')).status, 404, 'auth endpoint is nginx-internal');
    assert.equal((await get('/_sp/http-drop')).status, 404, 'drop endpoint is nginx-internal');
    await dropped('/healthz', '60.249.21.30');
    await dropped('/api/announcement', '60.249.21.30');
    await dropped('/api/nickname/validate', '60.249.21.30', 'POST');
    for (let i = 0; i < 3; i++) {
      const res = await get('/healthz?nonce=' + i); assert.equal(res.status, 200); await res.text();
    }
    await dropped('/healthz?limited=1');
    await dropped('/healthz?permanent=1');
    assert.equal(bans.size, 1);
    for (const pathname of [asset, '/icons/test.svg', '/healthz', '/api/ping']) {
      await dropped(pathname);
    }
    assert.equal((await get(asset, '198.51.100.1')).status, 200, 'another IP still receives cached assets');
    for (const status of [403, 404, 500, 503]) {
      const res = await get(`/ordinary-error/${status}`, '198.51.100.1');
      assert.equal(res.status, status); assert.equal(await res.text(), 'ordinary error');
    }
    const missingGeoip = await get('/healthz', '198.51.100.8');
    assert.equal(missingGeoip.status, 503); assert.equal((await missingGeoip.json()).error, 'GEOIP_UNAVAILABLE');
    await dropped('/ws', '198.51.100.1'); await dropped('/ws', '198.51.100.1', 'POST');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { headers: { 'X-Test-IP': '198.51.100.1' } });
      ws.on('error', reject);
      ws.on('message', (message) => { assert.equal(message.toString(), 'connected'); ws.close(); });
      ws.on('close', resolve);
    });
    // Keep real upgraded connections open: rate and concurrency limits act on different phases.
    const held = [];
    const openHeld = () => new Promise((resolve, reject) => {
      const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { headers: { 'X-Test-IP': '198.51.100.50' } });
      ws.on('error', reject);
      ws.once('open', () => { held.push(ws); resolve(); });
    });
    const rejectUpgrade = () => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: nginxPort });
      const chunks = [];
      socket.setTimeout(3000, () => socket.destroy(new Error('upgrade rejection timed out')));
      socket.on('connect', () => socket.write('GET /ws HTTP/1.1\r\nHost: game.example.com\r\nX-Test-IP: 198.51.100.50\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
      socket.on('close', () => {
        try { assert.equal(Buffer.concat(chunks).length, 0); resolve(); } catch (error) { reject(error); }
      });
    });
    for (let i = 0; i < 4; i++) await openHeld();
    await rejectUpgrade(); // burst exhausted: 5/minute with burst 3
    await delay(12100);
    await rejectUpgrade(); // rate recovered; four live connections still exhaust concurrency
    for (const ws of held) ws.close();
    // The fixture shortens only the log flush interval; wait for the final WS log to flush.
    let log = '';
    for (let i = 0; i < 40; i++) {
      log = fs.readFileSync(path.join(dir, 'logs/access.log'), 'utf8');
      if (/conn_limit=REJECTED/.test(log)) break;
      await delay(25);
    }
    assert.match(log, /"GET \/healthz\?limited=1 HTTP\/1\.1" 444 0 /);
    assert.match(log, /http_reject=FOREIGN_IP_BLOCKED/); assert.match(log, /http_reject=RATE_LIMITED/);
    assert.match(log, /"GET \/icons\/test\.svg HTTP\/1\.1" 444 0 /);
    assert.match(log, /req_limit=REJECTED/);
    assert.match(log, /conn_limit=REJECTED/);
    // Successful static downloads keep their own generous budget; dynamic routes share one bucket.
    for (let i = 0; i < 160; i++) {
      const res = await get('/js/fixture.js', '198.51.100.80'); assert.equal(res.status, 200); await res.text();
    }
    // The browser imports the simulation engine as many parallel /sim/*.js modules. These are static code too: if
    // they enter the business bucket, its burst rejects part of the first match startup and the
    // battle runner reports "simulation unavailable" (which leaves the board with no enemies).
    for (let i = 0; i < 160; i++) {
      const res = await get('/sim/fixture.js', '198.51.100.81'); assert.equal(res.status, 200); await res.text();
    }
    for (let i = 0; i < 160; i++) {
      const res = await get('/data.js', '198.51.100.82'); assert.equal(res.status, 200); await res.text();
    }
    for (let i = 0; i < 160; i++) {
      const res = await get('/_v/0123456789abcdef/data.js', '198.51.100.83'); assert.equal(res.status, 200); await res.text();
    }
    for (let i = 0; i < 160; i++) {
      const res = await get('/resource-sw.js?v=0123456789abcdef', '198.51.100.84'); assert.equal(res.status, 200); await res.text();
    }
    const shared = await Promise.all(Array.from({ length: 40 }, (_, i) => get('/business-' + i % 2, '198.51.100.80')
      .then(async res => { await res.text(); return res.status; }, () => 0)));
    assert.ok(shared.includes(200) && shared.includes(0), 'different business paths share the admission bucket');
  });
