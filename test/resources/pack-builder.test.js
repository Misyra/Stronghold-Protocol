// 部署端的资源分包生成器（tools/resource_packs.py，取自 xinhai-ai/Stronghold-Protocol）：本文件把「生成 → 客户端读取」
// 这条链闭合起来。之前仓库里只有读取端（public/js/resources/transport.js + archive.js 的 readTransportPack），
// 生成器缺失，等于分包预载没法真的产出。
//
// 造一份本机假素材清单，跑真实脚本，再用浏览器同款 readTransportPack 读回来。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTransportPack } from '../../public/js/resources/archive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** python is an external tool here: a machine without it skips this file instead of failing it. */
function python() {
  for (const bin of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return bin; } catch { /* try the next one */ }
  }
  return null;
}
const PY = python();
const skip = PY ? false : 'python 不可用';

const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');

/** One file of the fixture install: where it lives, its tier, and its bytes. */
const FILES = [
  { url: '/assets/spine/op/x/front/x.skel', tier: 1, body: Buffer.from('skel-bytes') },
  { url: '/assets/spine/op/x/front/x.atlas', tier: 1, body: Buffer.from('atlas-bytes') },
  { url: '/assets/char/avatar/x.png', tier: 1, body: Buffer.from('avatar-bytes') },
  { url: '/assets/ui/a.png', tier: 1, body: Buffer.from('ui-bytes') },
  { url: '/assets/audio/voice/cn/v.mp3', tier: 2, body: Buffer.from('voice-bytes') },
  { url: '/assets/audio/bgm/b.mp3', tier: 2, body: Buffer.from('bgm-bytes') },
  { url: '/assets/local/fx/e.png', tier: 2, body: Buffer.from('fx-bytes') },
];

/** A temp install: the files under an assets root plus the preload manifest that names them. */
function install(files = FILES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pack-build-'));
  const assetsRoot = path.join(dir, 'assets');
  const manifest = { format: 1, version: 'fixture-1', count: files.length, tier1: files.filter((f) => f.tier === 1).length,
    sized: files.length, totalBytes: files.reduce((n, f) => n + f.body.length, 0), files: [] };
  for (const file of files) {
    const abs = path.join(assetsRoot, file.url.slice(1));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.body);
    manifest.files.push({ url: file.url, tier: file.tier, size: file.body.length, hash: sha1(file.body).slice(0, 12), ...(file.skin ? { skin: file.skin } : {}) });
  }
  const manifestPath = path.join(dir, 'resource-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    dir, assetsRoot, manifestPath,
    output: path.join(dir, 'packs'),
    index: path.join(dir, 'resource-packs.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function build(inst) {
  return execFileSync(PY, [path.join(ROOT, 'tools', 'resource_packs.py'),
    '--manifest', inst.manifestPath, '--assets-root', inst.assetsRoot,
    '--output', inst.output, '--index', inst.index], { encoding: 'utf8' });
}

describe('资源分包生成器 → 客户端读取', { skip }, () => {
  test('多套皮肤共享普通大小的合并分包，不按每套生成小 ZIP', () => {
    const inst = install([
      { url: '/assets/spine/op/a/outfit/front/a.skel', tier: 2, skin: 'char_a/outfit', body: Buffer.from('skin-a') },
      { url: '/assets/char/avatar/skin/a.png', tier: 2, skin: 'char_a/outfit', body: Buffer.from('avatar-a') },
      { url: '/assets/spine/op/b/outfit/front/b.skel', tier: 2, skin: 'char_b/outfit', body: Buffer.from('skin-b') },
    ]);
    try {
      build(inst);
      const { packs } = JSON.parse(fs.readFileSync(inst.index, 'utf8'));
      assert.equal(packs.length, 1);
      assert.equal(packs[0].count, 3);
      assert.equal(packs[0].id, 'skin-01');
      assert.ok(packs.every((p) => p.group === 'skin' && p.tier === 2));
    } finally { inst.cleanup(); }
  });

  test('皮肤沿用 16 MB 上限，装不下的剩余内容另成尾包', () => {
    const inst = install(Array.from({ length: 4 }, (_, i) => ({
      url: `/assets/spine/op/char_${i}/skin/front/a.skel`, tier: 2,
      skin: `char_${i}/outfit`, body: Buffer.alloc(5_000_000, i),
    })));
    try {
      build(inst);
      const { packs } = JSON.parse(fs.readFileSync(inst.index, 'utf8'));
      assert.equal(packs.length, 2);
      assert.equal(packs.reduce((sum, pack) => sum + pack.count, 0), 4);
      assert.ok(packs.every((pack) => pack.size <= 16_000_000));
      assert.deepEqual(packs.map((pack) => pack.count), [3, 1]);
      assert.equal(packs[0].bytes, 15_000_000);
      assert.equal(packs[1].bytes, 5_000_000);
    } finally { inst.cleanup(); }
  });

  test('分类切包：索引形状、分组、整包 SHA-1 与文件名', () => {
    const inst = install();
    try {
      build(inst);
      const index = JSON.parse(fs.readFileSync(inst.index, 'utf8'));
      assert.equal(index.format, 'stronghold-resource-pack-index');
      assert.equal(index.version, 1);
      assert.equal(index.resourceVersion, 'fixture-1', 'the manifest version travels with the index');
      assert.equal(index.maxBytes, 16_000_000);
      assert.deepEqual(index.packs.map((p) => p.id), ['bgm-01', 'character-01', 'fx-01', 'spine-01', 'ui-01', 'voice_cn-01'],
        'one pack per category, named after it');
      for (const pack of index.packs) {
        const name = pack.url.split('/').pop();
        assert.match(name, new RegExp('^' + pack.id + '-' + sha1(fs.readFileSync(path.join(inst.output, name))).slice(0, 12) + '\\.zip$'),
          'the file name carries the package digest');
        assert.match(pack.sha1, /^[0-9a-f]{40}$/);
        assert.equal(pack.size, fs.statSync(path.join(inst.output, name)).size);
        assert.equal(pack.bytes, pack.files.reduce((n, f) => n + f.size, 0));
      }
      const spine = index.packs.find((p) => p.id === 'spine-01');
      assert.deepEqual(spine.files.map((f) => f.url), ['/assets/spine/op/x/front/x.atlas', '/assets/spine/op/x/front/x.skel'],
        'files inside a pack are sorted by URL, the order the reader expects');
      assert.equal(spine.tier, 1);
      assert.equal(index.packs.find((p) => p.id === 'voice_cn-01').tier, 2, 'a voice pack keeps its tier');
    } finally { inst.cleanup(); }
  });

  test('生成的分包能被浏览器同款的 readTransportPack 读回，字节与哈希都对得上', async () => {
    const inst = install();
    try {
      build(inst);
      const index = JSON.parse(fs.readFileSync(inst.index, 'utf8'));
      const pack = index.packs.find((p) => p.id === 'spine-01');
      const bytes = fs.readFileSync(path.join(inst.output, pack.url.split('/').pop()));
      const response = new Response(bytes);
      const entries = await readTransportPack(response, pack, { onProgress: () => {} });
      assert.equal(entries.length, 2, 'both files of the pack');
      for (const entry of entries) {
        const original = FILES.find((f) => f.url === entry.row.url).body;
        assert.deepEqual(Buffer.from(entry.bytes), original, entry.row.url);
        assert.equal(entry.row.hash, sha1(original).slice(0, 12));
      }
    } finally { inst.cleanup(); }
  });

  test('增量脚本：两份分包比出改动的那几个文件', () => {
    // the spine pack holds two files: one changes, one does not — exactly what a delta has to tell apart
    const changed = Buffer.from('skel-bytes-v2');
    const before = install();
    const after = install(FILES.map((f) => f.url === '/assets/spine/op/x/front/x.skel' ? { ...f, body: changed } : f));
    try {
      build(before);
      build(after);
      const packOf = (inst) => {
        const index = JSON.parse(fs.readFileSync(inst.index, 'utf8'));
        const pack = index.packs.find((p) => p.id === 'spine-01');
        return path.join(inst.output, pack.url.split('/').pop());
      };
      const output = path.join(before.dir, 'delta.zip');
      const report = path.join(before.dir, 'delta.report.json');
      execFileSync(PY, [path.join(ROOT, 'tools', 'resource_delta.py'), '--base', packOf(before), '--target', packOf(after),
        '--output', output, '--report', report], { encoding: 'utf8', stdio: 'ignore' });
      const doc = JSON.parse(fs.readFileSync(report, 'utf8'));
      assert.equal(doc.format, 'stronghold-resource-delta-report');
      assert.equal(doc.summary.changed.count, 1, 'exactly the file whose bytes changed');
      assert.equal(doc.changed[0].url, '/assets/spine/op/x/front/x.skel');
      assert.equal(doc.summary.unchanged.count, 1, 'and the untouched one stays out of the delta');
      assert.deepEqual(doc.summary.delta, { count: 1, bytes: changed.length });
      assert.ok(fs.statSync(output).size < fs.statSync(packOf(after)).size, 'the delta is smaller than the whole pack');
    } finally { before.cleanup(); after.cleanup(); }
  });
  test('清单与磁盘内容不符时直接失败，不产出半个包', () => {
    const inst = install();
    try {
      fs.writeFileSync(path.join(inst.assetsRoot, 'assets/ui/a.png'), Buffer.from('tampered'));
      assert.throws(() => build(inst), /manifest mismatch/);
      assert.equal(fs.existsSync(inst.index), false, 'no index was written');
    } finally { inst.cleanup(); }
  });
});
