// test/plugins/install.test.js — install a plugin zip (DESIGN §32.13, docs/PLUGINS.md §17).
// Downloads use an injected fetch. Nothing here contacts the public network. The production cap
// INSTALL_MAX_BYTES is asserted equal to PLUGIN_LIMITS.pluginBytes; oversized cases pass a small maxBytes
// or declare an uncompressed size over the real cap before inflate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PLUGIN_LIMITS } from '../../shared/plugins/manifest.js';
import { zipFiles } from '../../server/plugins/zip.js';
import {
  INSTALL_MAX_BYTES, installFromFile, installFromUrl, installPluginBytes, installedPluginVersion, loadCatalogText,
} from '../../server/plugins/install.js';
import { main } from '../../tools/plugin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const HASH = 'ab'.repeat(32);

function pluginZip(id, manifestExtra = {}, files = {}) {
  const manifest = {
    manifest: 2, id, name: { zh: '测试', en: 'Test' }, version: '1.0.0', app: '*', api: 1,
    class: 'cosmetic', scope: ['room', 'personal'], permissions: ['assets.override'], assets: {},
    ...manifestExtra,
  };
  const entries = [{ name: `${id}/plugin.json`, data: Buffer.from(JSON.stringify(manifest)) }];
  for (const [rel, data] of Object.entries(files)) entries.push({ name: `${id}/${rel}`, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  return zipFiles(entries);
}

function patchCentral(zip, name, edit) {
  const z = Buffer.from(zip);
  const nb = Buffer.from(name, 'utf8');
  let p = 0;
  while ((p = z.indexOf(nb, p)) !== -1) {
    if (p >= 46 && z.readUInt32LE(p - 46) === 0x02014b50) {
      edit(z, p - 46);
      return z;
    }
    p += 1;
  }
  throw new Error(`no central entry for ${name}`);
}

async function quiet(argv) {
  const out = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try { return { code: await main(argv), out: out.join('\n') }; }
  finally { console.log = log; console.error = err; }
}

const rejects = async (fn, code, status) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.code, code, e.message);
    if (status !== undefined) assert.equal(e.status, status);
    return true;
  });
};

test('the production download cap is PLUGIN_LIMITS.pluginBytes', () => {
  assert.equal(INSTALL_MAX_BYTES, PLUGIN_LIMITS.pluginBytes);
  assert.equal(INSTALL_MAX_BYTES, 209715200);
});

test('a local zip installs, a bad hash is refused, an existing id is kept, --force moves the old folder', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-'));
  const plugins = path.join(tmp, 'plugins');
  fs.mkdirSync(plugins);
  const zip = pluginZip('demo-skin');
  const file = path.join(tmp, 'demo-skin.zip');
  fs.writeFileSync(file, zip);
  try {
    const first = installFromFile(file, { pluginsDir: plugins });
    assert.equal(first.id, 'demo-skin');
    assert.equal(JSON.parse(fs.readFileSync(path.join(plugins, 'demo-skin', 'plugin.json'), 'utf8')).version, '1.0.0');
    assert.equal(installedPluginVersion(plugins, 'demo-skin'), '1.0.0');
    fs.writeFileSync(path.join(plugins, 'demo-skin', 'README.md'), 'keep me');
    assert.throws(() => installFromFile(file, { pluginsDir: plugins, sha256: '0'.repeat(64) }), (e) => e.code === 'PLUGIN_INSTALL_HASH' && e.status === 422);
    assert.equal(fs.readFileSync(path.join(plugins, 'demo-skin', 'README.md'), 'utf8'), 'keep me', 'a bad hash did not replace it');
    assert.throws(() => installFromFile(file, { pluginsDir: plugins }), (e) => e.code === 'PLUGIN_INSTALL_EXISTS' && e.status === 409);
    const again = pluginZip('demo-skin', { version: '2.0.0' });
    const second = installPluginBytes(again, { pluginsDir: plugins, force: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(plugins, 'demo-skin', 'plugin.json'), 'utf8')).version, '2.0.0');
    assert.ok(second.replaced && second.replaced.startsWith(path.join(plugins, '_replaced', 'demo-skin-')));
    assert.equal(fs.readFileSync(path.join(second.replaced, 'README.md'), 'utf8'), 'keep me', 'the old folder was moved, not deleted');
    assert.equal(fs.existsSync(path.join(plugins, 'demo-skin', 'README.md')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a decoy script in the package is copied and not executed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-decoy-'));
  const plugins = path.join(tmp, 'plugins');
  const marker = path.join(tmp, 'ran');
  fs.mkdirSync(plugins);
  const prev = process.env.SP_INSTALL_DECOY;
  process.env.SP_INSTALL_DECOY = marker;
  const script = "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.SP_INSTALL_DECOY, 'ran');\n";
  const manifest = {
    manifest: 2, id: 'demo-widget', version: '1.0.0', app: '*', api: 1, class: 'ui', scope: ['personal'],
    permissions: ['ui.frame'], entry: { client: 'ui/index.html' }, slots: ['hud.right'],
  };
  const zip = zipFiles([
    { name: 'demo-widget/plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'demo-widget/ui/index.html', data: Buffer.from('<!doctype html><title>x</title>') },
    { name: 'demo-widget/ui/trap.js', data: Buffer.from(script) },
  ]);
  try {
    installPluginBytes(zip, { pluginsDir: plugins });
    assert.equal(fs.existsSync(marker), false, 'importing trap.js would have written the marker');
    assert.match(fs.readFileSync(path.join(plugins, 'demo-widget', 'ui', 'trap.js'), 'utf8'), /writeFileSync/);
  } finally {
    if (prev === undefined) delete process.env.SP_INSTALL_DECOY; else process.env.SP_INSTALL_DECOY = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('path traversal, a symbolic link, a hidden name, a declared size and a file-count bomb are refused before install', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-zip-'));
  const plugins = path.join(tmp, 'plugins');
  fs.mkdirSync(plugins);
  try {
    const travel = zipFiles([{ name: '../evil.txt', data: Buffer.from('no') }]);
    assert.throws(() => installPluginBytes(travel, { pluginsDir: plugins }), (e) => e.code === 'PLUGIN_INSTALL_ZIP');
    assert.equal(fs.existsSync(path.join(tmp, 'evil.txt')), false);
    const linked = patchCentral(pluginZip('demo-skin'), 'demo-skin/plugin.json', (z, at) => {
      z.writeUInt32LE((0o120777 << 16) >>> 0, at + 38);
    });
    assert.throws(() => installPluginBytes(linked, { pluginsDir: plugins }), (e) => e.code === 'PLUGIN_INSTALL_ZIP' && /symbolic link/.test(e.message));
    assert.equal(fs.existsSync(path.join(plugins, 'demo-skin')), false);
    const hidden = zipFiles([{ name: 'demo-skin/.secret', data: Buffer.from('no') }, { name: 'demo-skin/plugin.json', data: Buffer.from('{}') }]);
    assert.throws(() => installPluginBytes(hidden, { pluginsDir: plugins }), (e) => e.code === 'PLUGIN_INSTALL_ZIP');
    const huge = patchCentral(pluginZip('demo-skin'), 'demo-skin/plugin.json', (z, at) => {
      z.writeUInt32LE(PLUGIN_LIMITS.pluginBytes + 1, at + 24);
    });
    assert.throws(() => installPluginBytes(huge, { pluginsDir: plugins }), (e) => e.code === 'PLUGIN_INSTALL_ZIP' && /uncompressed size/.test(e.message));
    const bomb = zipFiles(Array.from({ length: PLUGIN_LIMITS.files + 1 }, (_, i) => ({ name: `n/${String(i).padStart(4, '0')}.png`, data: Buffer.from([1]) })));
    assert.throws(() => installPluginBytes(bomb, { pluginsDir: plugins }), (e) => e.code === 'PLUGIN_INSTALL_ZIP' && /entries/.test(e.message));
    assert.equal(fs.readdirSync(plugins).length, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('https install: hash required before fetch, redirect manual, http and a bad redirect refused, size and timeout stop', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-https-'));
  const plugins = path.join(tmp, 'plugins');
  fs.mkdirSync(plugins);
  const zip = pluginZip('demo-skin');
  const digest = sha(zip);
  let calls = 0;
  const fetch = async (url, init) => {
    calls += 1;
    assert.equal(init.redirect, 'manual');
    if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: 'https://example.invalid/file.zip' } });
    if (url.endsWith('/to-http')) return new Response(null, { status: 302, headers: { location: 'http://example.invalid/file.zip' } });
    if (url.endsWith('/opaque')) return { status: 0, type: 'opaqueredirect', headers: { get() { return null; } }, body: { cancel() {} } };
    if (url.endsWith('/big-len')) return new Response(new Uint8Array(4), { status: 200, headers: { 'content-length': '999' } });
    if (url.endsWith('/stream')) {
      let left = 80;
      const body = new ReadableStream({ pull(c) { if (left <= 0) { c.close(); return; } const n = Math.min(left, 16); c.enqueue(new Uint8Array(n)); left -= n; } });
      return new Response(body, { status: 200 });
    }
    if (url.endsWith('/hang')) return new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
    if (url.endsWith('/500')) return new Response('no', { status: 500 });
    return new Response(zip, { status: 200 });
  };
  try {
    calls = 0;
    await rejects(() => installFromUrl('http://example.invalid/a.zip', { pluginsDir: plugins, sha256: digest, fetch }), 'PLUGIN_INSTALL_URL', 400);
    await rejects(() => installFromUrl('https://user:pass@example.invalid/a.zip', { pluginsDir: plugins, sha256: digest, fetch }), 'PLUGIN_INSTALL_URL', 400);
    await rejects(() => installFromUrl('https://example.invalid/a.zip', { pluginsDir: plugins, sha256: '', fetch }), 'PLUGIN_INSTALL_HASH', 400);
    assert.equal(calls, 0, 'refused before any fetch');
    await rejects(() => installFromUrl('https://example.invalid/to-http', { pluginsDir: plugins, sha256: digest, fetch }), 'PLUGIN_INSTALL_REDIRECT', 502);
    await rejects(() => installFromUrl('https://example.invalid/opaque', { pluginsDir: plugins, sha256: digest, fetch }), 'PLUGIN_INSTALL_REDIRECT', 502);
    await rejects(() => installFromUrl('https://example.invalid/file.zip', { pluginsDir: plugins, sha256: HASH, fetch }), 'PLUGIN_INSTALL_HASH', 422);
    assert.equal(fs.existsSync(path.join(plugins, 'demo-skin')), false);
    const ok = await installFromUrl('https://example.invalid/start', { pluginsDir: plugins, sha256: digest, fetch });
    assert.equal(ok.id, 'demo-skin');
    await rejects(() => installFromUrl('https://example.invalid/big-len', { pluginsDir: plugins, sha256: digest, fetch, maxBytes: 100 }), 'PLUGIN_INSTALL_SIZE', 413);
    await rejects(() => installFromUrl('https://example.invalid/stream', { pluginsDir: plugins, sha256: digest, fetch, maxBytes: 32 }), 'PLUGIN_INSTALL_SIZE', 413);
    await rejects(() => installFromUrl('https://example.invalid/hang', { pluginsDir: plugins, sha256: digest, fetch, timeoutMs: 30 }), 'PLUGIN_INSTALL_TIMEOUT', 502);
    await rejects(() => installFromUrl('https://example.invalid/500', { pluginsDir: plugins, sha256: digest, fetch }), 'PLUGIN_INSTALL_FETCH', 502);
    await rejects(() => installFromUrl('https://example.invalid/file.zip', { pluginsDir: plugins, sha256: digest, fetch, expectedBytes: 1 }), 'PLUGIN_INSTALL_SIZE', 413);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a symlink id is not followed: status has no version, and --force renames the link', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-link-'));
  const plugins = path.join(tmp, 'plugins');
  const real = path.join(tmp, 'real');
  fs.mkdirSync(plugins);
  fs.mkdirSync(path.join(real, 'elsewhere'), { recursive: true });
  fs.writeFileSync(path.join(real, 'elsewhere', 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
  fs.symlinkSync(path.join(real, 'elsewhere'), path.join(plugins, 'demo-skin'));
  const incoming = path.join(tmp, 'incoming-target');
  fs.mkdirSync(incoming);
  fs.symlinkSync(incoming, path.join(plugins, '_incoming'));
  try {
    assert.equal(installedPluginVersion(plugins, 'demo-skin'), null);
    assert.throws(() => installPluginBytes(pluginZip('demo-skin'), { pluginsDir: plugins }), (e) => e.code === 'PLUGIN_INSTALL_ZIP');
    assert.equal(fs.readdirSync(incoming).length, 0, 'a linked _incoming was not written through');
    fs.unlinkSync(path.join(plugins, '_incoming'));
    const done = installPluginBytes(pluginZip('demo-skin'), { pluginsDir: plugins, force: true });
    assert.equal(fs.lstatSync(done.replaced).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(real, 'elsewhere', 'plugin.json'), 'utf8').includes('9.9.9'), true, 'the link target was not deleted');
    assert.equal(fs.lstatSync(path.join(plugins, 'demo-skin')).isSymbolicLink(), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the CLI installs a local zip, refuses https without --sha256, and lists a catalogue', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-cli-'));
  const plugins = path.join(tmp, 'plugins');
  fs.mkdirSync(plugins);
  const zip = pluginZip('demo-skin');
  const file = path.join(tmp, 'demo.zip');
  fs.writeFileSync(file, zip);
  const catalog = {
    catalog: 1, name: 'CLI catalogue',
    plugins: [{ id: 'demo-skin', name: 'Demo', version: '2.0.0', class: 'cosmetic', url: 'https://example.invalid/a.zip', sha256: HASH, app: '*' }],
  };
  fs.writeFileSync(path.join(tmp, 'catalog.json'), JSON.stringify(catalog));
  try {
    const missing = await quiet(['install', 'https://example.invalid/a.zip', '--root', tmp]);
    assert.equal(missing.code, 1, missing.out);
    assert.match(missing.out, /PLUGIN_INSTALL_HASH/);
    const http = await quiet(['install', 'http://example.invalid/a.zip', '--sha256', HASH, '--root', tmp]);
    assert.equal(http.code, 1, http.out);
    assert.match(http.out, /PLUGIN_INSTALL_URL/);
    const ok = await quiet(['install', file, '--root', tmp]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /plugins\/demo-skin\//);
    const listed = await quiet(['catalog', path.join(tmp, 'catalog.json'), '--json', '--root', tmp]);
    assert.equal(listed.code, 0, listed.out);
    const body = JSON.parse(listed.out);
    assert.equal(body.plugins[0].status, 'updatable');
    const words = await quiet(['catalog', path.join(tmp, 'catalog.json'), '--root', tmp]);
    assert.match(words.out, /可更新/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a catalogue document over 1 MB is refused, and https catalogue fetch does not follow http', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-catalog-fetch-'));
  const big = path.join(tmp, 'big.json');
  fs.writeFileSync(big, `{${' '.repeat(1024 * 1024)}}`);
  let calls = 0;
  const fetch = async (url, init) => {
    calls += 1;
    assert.equal(init.redirect, 'manual');
    if (url.endsWith('/redir')) return new Response(null, { status: 302, headers: { location: 'http://example.invalid/c.json' } });
    return new Response('{}', { status: 200 });
  };
  try {
    await rejects(() => loadCatalogText(big), 'PLUGIN_CATALOG_SIZE', 413);
    await rejects(() => loadCatalogText('http://example.invalid/c.json', { fetch }), 'PLUGIN_CATALOG_URL', 400);
    assert.equal(calls, 0);
    await rejects(() => loadCatalogText('https://example.invalid/redir', { fetch }), 'PLUGIN_CATALOG_FETCH', 502);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI catalogue of the example file exits 0 and does not mark the documentation entries installed', async () => {
  const r = await quiet(['catalog', path.join(ROOT, 'docs/plugin-catalog.example.json'), '--json', '--root', ROOT]);
  assert.equal(r.code, 0, r.out);
  const body = JSON.parse(r.out);
  assert.equal(body.plugins.length, 2);
  assert.ok(body.plugins.every((e) => e.status === 'available' || e.status === 'incompatible'));
});
