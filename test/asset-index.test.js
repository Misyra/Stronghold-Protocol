// Content-hashed asset URLs (host bandwidth, layer 1; docs/ASSETS.md "The served manifests"):
//   * server/http/assetIndex.js — SHA-256 (16 hex) of every file under public/assets and public/fonts, cached by path +
//     size + mtime in a JSON file, never trusted for a file whose size or mtime changed; Spine models share one hash.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createAssetIndex, hash16 } from '../server/http/assetIndex.js';

const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hash-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const until = async (fn, ms = 3000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

describe('the asset index', () => {
  test('hashes every file under assets/ and fonts/ (dot names skipped, a linked folder followed), persists them, rehashes only what changed', async () => {
    const a = randomBytes(2000);
    const b = Buffer.from('atlas text\n'.repeat(50));
    const dir = tree({
      'public/assets/char/a.png': a, 'public/assets/spine/x/x.atlas': b, 'public/assets/.hidden': 'h', 'public/assets/.git/obj': 'o',
      'public/fonts/f.woff2': 'font', 'public/js/app.js': 'not indexed', 'elsewhere/linked/l.png': 'linked',
    });
    fs.symlinkSync(path.join(dir, 'elsewhere/linked'), path.join(dir, 'public/assets/link'), 'dir');
    const cacheFile = path.join(dir, '.cache/asset-hashes.json');
    try {
      const idx = createAssetIndex({ publicDir: path.join(dir, 'public'), cacheFile, delayMs: 0 });
      assert.equal(idx.ready, false);
      idx.start();
      await idx.whenReady();
      assert.equal(idx.ready, true);
      const st = (rel) => fs.statSync(path.join(dir, 'public', rel));
      assert.equal(idx.hashOf('assets/char/a.png', st('assets/char/a.png')), sha16(a));
      assert.equal(idx.hashOf('assets/spine/x/x.atlas'), sha16(b));
      assert.equal(idx.hashOf('fonts/f.woff2'), sha16(Buffer.from('font')));
      assert.equal(idx.hashOf('assets/link/l.png'), sha16(Buffer.from('linked')), 'a linked folder is followed');
      assert.equal(idx.hashOf('assets/.hidden'), null, 'dot names are never served, never hashed');
      assert.equal(idx.hashOf('assets/.git/obj'), null);
      assert.equal(idx.hashOf('js/app.js'), null, 'only the asset folders');
      assert.equal(idx.size, 4);
      assert.equal(idx.stats().last.hashed, 4);
      assert.equal(idx.hashOf('assets/CHAR/A.PNG'), sha16(a), 'a name that differs only in case finds the file');
      // a stat that no longer matches: no hash (the caller serves the plain way)
      assert.equal(idx.hashOf('assets/char/a.png', { size: 1, mtimeMs: st('assets/char/a.png').mtimeMs }), null);
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.equal(cached.version, 1);
      assert.deepEqual(cached.files['assets/char/a.png'], [a.length, st('assets/char/a.png').mtimeMs, sha16(a)]);
      idx.close();

      // a restart: the cache answers for the unchanged files; a changed file is hashed again; a removed one is dropped
      const a2 = randomBytes(2100);
      fs.writeFileSync(path.join(dir, 'public/assets/char/a.png'), a2);
      fs.rmSync(path.join(dir, 'public/fonts/f.woff2'));
      const idx2 = createAssetIndex({ publicDir: path.join(dir, 'public'), cacheFile, delayMs: 0 });
      idx2.start();
      await idx2.whenReady();
      assert.equal(idx2.stats().last.hashed, 1, 'only the changed file was read');
      assert.equal(idx2.stats().last.reused, 2);
      assert.equal(idx2.hashOf('assets/char/a.png'), sha16(a2));
      assert.equal(idx2.hashOf('fonts/f.woff2'), null);
      assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).files['fonts/f.woff2'], undefined);
      idx2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('models: one hash for a skeleton, its atlas and pages; urlHashOk accepts the own or the model hash, nothing else', async () => {
    const dir = tree({ 'public/assets/s/x.skel': 'skel', 'public/assets/s/x.atlas': 'atlas', 'public/assets/s/x.png': 'png', 'public/assets/o.png': 'other' });
    try {
      const idx = createAssetIndex({ publicDir: path.join(dir, 'public'), delayMs: 0 });
      idx.start();
      await idx.whenReady();
      const trio = ['assets/s/x.skel', 'assets/s/x.atlas', 'assets/s/x.png'];
      const m = idx.modelHash(trio);
      assert.equal(m, hash16(['skel', 'atlas', 'png'].map((s) => sha16(Buffer.from(s))).join('\n')));
      assert.equal(idx.modelHash([...trio, 'assets/missing.png']), null, 'a member the index does not know: no model hash');
      const st = (rel) => fs.statSync(path.join(dir, 'public', rel));
      assert.equal(idx.urlHashOk('assets/s/x.atlas', st('assets/s/x.atlas'), m), false, 'not before the lists are known');
      idx.setModels([trio]);
      for (const rel of trio) assert.equal(idx.urlHashOk(rel, st(rel), m), true, rel);
      assert.equal(idx.urlHashOk('assets/s/x.png', st('assets/s/x.png'), sha16(Buffer.from('png'))), true, 'the own hash too');
      assert.equal(idx.urlHashOk('assets/o.png', st('assets/o.png'), m), false, 'not a member');
      assert.equal(idx.urlHashOk('assets/s/x.png', st('assets/s/x.png'), '0000000000000000'), false);
      assert.equal(idx.urlHashOk('assets/s/x.png', { size: 99, mtimeMs: 1 }, m), false, 'changed since: never immutable');
      idx.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a served file the index no longer matches asks for a rescan (rate-limited); the new hash follows', async () => {
    const dir = tree({ 'public/assets/a.png': 'one' });
    try {
      let changes = 0;
      const idx = createAssetIndex({ publicDir: path.join(dir, 'public'), delayMs: 0, rescanGapMs: 50 });
      idx.onChange(() => changes++);
      idx.start();
      await idx.whenReady();
      assert.equal(changes, 1);
      const gen = idx.generation;
      fs.writeFileSync(path.join(dir, 'public/assets/a.png'), 'two!');
      assert.equal(idx.hashOf('assets/a.png', fs.statSync(path.join(dir, 'public/assets/a.png'))), null);
      idx.noteMiss('assets/a.png');
      idx.noteMiss('assets/a.png');
      assert.ok(await until(() => idx.generation > gen), 'rescanned');
      assert.equal(idx.hashOf('assets/a.png'), sha16(Buffer.from('two!')));
      assert.equal(changes, 2, 'one rescan for both misses');
      idx.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
