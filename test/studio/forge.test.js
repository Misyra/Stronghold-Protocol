// test/studio/forge.test.js — the studio's Forge import (DESIGN §32.12). The gate is the studio's own. The body is a
// zip or a file list, never a path on the server. Preview writes nothing; import writes plugins/<id>/ after the report.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';
import { zipFiles } from '../../server/plugins/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIN = path.join(ROOT, 'test', 'fixtures', 'forge', 'skin-pack');

function packZip(dir) {
  const files = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const p = path.join(abs, name);
      const next = rel ? `${rel}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, next);
      else files.push({ name: next, data: fs.readFileSync(p) });
    }
  };
  walk(dir, '');
  return zipFiles(files);
}

describe('studio Forge import', () => {
  let srv;
  let tmp;
  let plugins;
  let H;
  const call = async (method, url, body, headers = H) => {
    const r = await fetch(srv.url + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const raw = (method, url, headers = {}, body = null) => new Promise((resolve, reject) => {
    const u = new URL(srv.url + url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-forge-studio-'));
    plugins = path.join(tmp, 'plugins');
    fs.mkdirSync(plugins);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, pluginsDir: plugins, assetIndex: false });
    H = { 'x-sp-studio': srv.studio.key, 'content-type': 'application/json' };
  });
  after(async () => { await srv?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('the gate refuses a preview without the key, from a public client, and from another origin', async () => {
    const body = JSON.stringify({ zip: 'e30=' });
    assert.equal((await raw('POST', '/studio/api/forge/preview', { 'content-type': 'application/json' }, body)).status, 404);
    assert.equal((await raw('POST', '/studio/api/forge/import', { 'content-type': 'application/json', 'x-sp-studio': '1', 'x-forwarded-for': '203.0.113.9' }, body)).status, 404);
    assert.equal((await raw('POST', '/studio/api/forge/import', { 'content-type': 'application/json', 'x-sp-studio': srv.studio.key, origin: 'http://evil.example.com' }, body)).status, 404);
    assert.equal(fs.readdirSync(plugins).filter((n) => !n.startsWith('.')).length, 0);
  });

  test('a server path is refused; preview writes nothing; import writes the plugin; a second import is refused', async () => {
    const refused = await call('POST', '/studio/api/forge/preview', { path: SKIN });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'PLUGIN_FORGE_INPUT');
    const zip = packZip(SKIN).toString('base64');
    const preview = await call('POST', '/studio/api/forge/preview', { zip });
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 500));
    assert.equal(preview.body.report.ok, true);
    assert.equal(preview.body.report.wrote, false);
    assert.equal(preview.body.plugins[0].id, 'rose-skin');
    assert.equal(fs.existsSync(path.join(plugins, 'rose-skin')), false);
    const imported = await call('POST', '/studio/api/forge/import', { zip });
    assert.equal(imported.status, 200, JSON.stringify(imported.body).slice(0, 800));
    assert.equal(imported.body.report.wrote, true);
    assert.ok(fs.existsSync(path.join(plugins, 'rose-skin', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(plugins, 'rose-skin', 'IMPORT-REPORT.md')));
    const again = await call('POST', '/studio/api/forge/import', { zip });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'PLUGIN_FORGE_EXISTS');
    const list = await call('GET', '/studio/api/plugins');
    assert.ok(list.body.plugins.some((p) => p.id === 'rose-skin'));
  });

  test('a file list imports, and a path-escape name is refused', async () => {
    fs.rmSync(path.join(plugins, 'rose-skin'), { recursive: true, force: true });
    const files = [];
    const walk = (abs, rel) => {
      for (const name of fs.readdirSync(abs)) {
        const p = path.join(abs, name);
        const next = rel ? `${rel}/${name}` : name;
        if (fs.statSync(p).isDirectory()) walk(p, next);
        else files.push({ name: `skin-pack/${next}`, data: fs.readFileSync(p).toString('base64') });
      }
    };
    walk(SKIN, '');
    const preview = await call('POST', '/studio/api/forge/preview', { files });
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 500));
    assert.equal(preview.body.report.products[0].id, 'rose-skin');
    const bad = await call('POST', '/studio/api/forge/preview', { files: [{ name: '../evil.txt', data: Buffer.from('no').toString('base64') }, { name: 'pack.json', data: Buffer.from('{"id":"rose-evil","name":"x","version":"1.0.0"}').toString('base64') }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'PLUGIN_FORGE_ZIP');
    assert.equal(fs.existsSync(path.join(plugins, 'rose-skin')), false);
  });
});
