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

