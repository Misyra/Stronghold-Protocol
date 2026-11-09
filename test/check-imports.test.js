// Boundary checker: fixture rules, plus the real tree's current violation list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSpecifiers, scan } from '../tools/check-imports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'sp-imp-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

test('comments are not imports, and a multiline import is', () => {
  const specs = findSpecifiers(`
    // import fs from 'node:fs'
    /* require('node:path') */
    import {
      a,
      b,
    } from './tier1.js';
    export function fromThing() { return 1; }
  `);
  assert.deepEqual(specs.map((s) => s.spec), ['./tier1.js']);
});

test('sim and match rules on a fixture tree', () => {
  const root = fixture({
    'server/sim/clean.js': `
      // import fs from 'node:fs'
      import { a } from './other.js';
      export function load() { return 1; }
      export { a };
    `,
    'server/sim/bad.js': `
      import '../match/Match.js';
      import '../lobby.js';
      import '../index.js';
      import '../net.js';
      import '../../public/js/main.js';
      import fs from 'node:fs';
      import 'fs';
      export { z } from '../match/board.js';
      const p = await import('node:path');
    `,
    'server/match/ok.js': `
      import '../sim/rng.js';
      import 'node:fs';
      import '../data.js';
    `,
    'server/match/bad.js': `
      import '../../public/js/main.js';
      import 'node:http';
      import 'ws';
      import '../net.js';
      import '../index.js';
    `,
  });
  try {
    const keys = scan(root).violations.map((v) => `${v.file} ${v.spec} ${v.code}`).sort();
    assert.deepEqual(keys, [
      'server/match/bad.js ../../public/js/main.js match-client',
      'server/match/bad.js ../index.js match-http',
      'server/match/bad.js ../net.js match-http',
      'server/match/bad.js node:http match-http',
      'server/match/bad.js ws match-http',
      'server/sim/bad.js ../../public/js/main.js sim-client',
      'server/sim/bad.js ../index.js sim-entry',
      'server/sim/bad.js ../lobby.js sim-lobby',
      'server/sim/bad.js ../match/Match.js sim-match',
      'server/sim/bad.js ../match/board.js sim-match',
      'server/sim/bad.js ../net.js sim-http',
      'server/sim/bad.js fs sim-node',
      'server/sim/bad.js node:fs sim-node',
      'server/sim/bad.js node:path sim-node',
    ]);
    assert.equal(scan(root).notes.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('this repo: the Node bridge (nodeData.js) is file-exempt; everything else stays clean', () => {
  const { violations, notes } = scan(ROOT);
  assert.deepEqual(violations, [], 'nodeData.js 的 Node 内建引用按文件豁免（classify），其余仍然零违规');
  assert.ok(notes.some((n) => n.file === 'server/sim/nodeData.js' && n.resolved === 'server/data.js'));
  assert.ok(notes.every((n) => n.resolved === 'server/data.js'));
});

test('the CLI: the real tree passes both modes; --strict fails on a violating tree', () => {
  const loose = spawnSync(process.execPath, ['tools/check-imports.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(loose.status, 0);
  assert.match(loose.stdout, /no import-boundary violations/);
  const strict = spawnSync(process.execPath, ['tools/check-imports.mjs', '--strict'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(strict.status, 0, 'nodeData.js 豁免后 --strict 在真实树上也通过');
  // 违规树：--strict 真的拦截（npm run check:imports 的语义）
  const root = fixture({ 'server/sim/bad.js': "import fs from 'node:fs';\n" });
  try {
    const looseBad = spawnSync(process.execPath, ['tools/check-imports.mjs', '--root', root], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(looseBad.status, 0);
    assert.match(looseBad.stdout, /sim-node/);
    const strictBad = spawnSync(process.execPath, ['tools/check-imports.mjs', '--strict', '--root', root], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(strictBad.status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
