// NGINX_PATH=<binary> node --test test/ops/static-connections.nginx.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.env.NGINX_PATH;
const listen = async (server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
test('static module concurrency has its own bounded per-IP budget and retains the global ceiling',
  { skip: !binary, timeout: 20000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-static-connections-'));
    const prefix = dir.replaceAll('\\', '/') + '/';
    fs.mkdirSync(path.join(dir, 'logs'));
    const pending = new Set(), requests = new Set();
    const backend = http.createServer((req, res) => {
      if (req.url === '/ready') { res.end('ready'); return; }
      pending.add(res); res.on('close', () => pending.delete(res));
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('held');
    });
    const backendPort = await listen(backend);
    const reserve = http.createServer(), port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const maps = fs.readFileSync(new URL('../../scripts/hardening/sp-business-limit-map.conf', import.meta.url), 'utf8');
    const template = fs.readFileSync(new URL('../../scripts/nginx.conf.example', import.meta.url), 'utf8');
    const limits = template.match(/limit_conn sp_(?:business_conn|static_conn) \d+;/g).join('\n');
    fs.writeFileSync(path.join(dir, 'nginx.conf'), `worker_processes 1; pid nginx.pid;
error_log logs/error.log notice;
events { worker_connections 2048; }
http { ${maps}
limit_conn_zone $server_name zone=test_global:1m;
server { listen 127.0.0.1:${port}; server_name fixture;
set_real_ip_from 127.0.0.1; real_ip_header X-Test-IP;
limit_conn_status 429;
${limits}
limit_conn test_global 260;
location / { proxy_pass http://127.0.0.1:${backendPort}; proxy_buffering off; }
}}
`);
    let child;
    t.after(async () => {
      for (const req of requests) req.destroy();
      for (const res of pending) res.destroy();
      backend.closeAllConnections();
      await new Promise(resolve => backend.close(resolve));
      if (child) {
        spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-s', 'quit'], { windowsHide: true });
        if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]);
        if (child.exitCode === null) child.kill();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const checked = spawnSync(binary, ['-p', prefix, '-c', 'nginx.conf', '-t'], { encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, checked.stderr);
    child = spawn(binary, ['-p', prefix, '-c', 'nginx.conf', '-g', 'daemon off; master_process off;'], { stdio: 'ignore', windowsHide: true });
    const get = (uri, ip = '198.51.100.1') => new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: uri, agent: false,
        headers: { 'X-Test-IP': ip } }, res => { res.on('error', () => {}); res.resume(); resolve(res.statusCode); });
      requests.add(req); req.on('close', () => requests.delete(req)); req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('fixture request timed out')));
    });
    for (let i = 0; i < 50; i++) {
      try { assert.equal(await get('/ready'), 200); break; } catch { await delay(25); }
    }
    // Source and versioned modules, built chunks, renderer vendors share one static pool.
    const paths = ['/sim/content/kits/ops/a.js', '/_v/0123456789abcdef/sim/spec.js',
      '/build/assets/app.js', '/_v/0123456789abcdef/vendor/pixi.min.js'];
    for (let i = 0; i < 192; i++) assert.equal(await get(paths[i % paths.length]), 200);
    for (let i = 0; i < 64; i++) assert.equal(await get('/api/fixture'), 200, 'static requests do not consume the business budget');
    assert.equal(await get('/api/fixture'), 429, 'business still stops at 64');
    assert.equal(await get('/sim/extra.js'), 200, 'business saturation cannot starve a module');
    // 257 held requests so far: three from another IP fit, the fourth hits the shared ceiling.
    for (let i = 0; i < 3; i++) assert.equal(await get('/sim/other.js', '198.51.100.2'), 200);
    assert.equal(await get('/sim/other.js', '198.51.100.2'), 429, 'global ceiling still applies across IPs');
    for (const req of [...requests]) req.destroy();
    for (let i = 0; i < 100 && pending.size; i++) await delay(10);
    assert.equal(pending.size, 0);
    for (let i = 0; i < 256; i++) assert.equal(await get(paths[i % paths.length]), 200);
    assert.equal(await get('/sim/too-many.js'), 429, 'all static aliases share a finite 256-request budget');
    assert.equal(await get('/api/fixture'), 200, 'static saturation cannot starve a business request');
  });
