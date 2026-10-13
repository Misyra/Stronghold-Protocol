import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForkBoundaries } from '../tools/check-fork-boundaries.mjs';

test('boundary gate permits only the three explicit upstream Node loader imports', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-fork-boundaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'server/sim'), { recursive: true });
  mkdirSync(path.join(root, 'server/match'), { recursive: true });
  writeFileSync(path.join(root, 'server/sim/nodeData.js'), "import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';");
  assert.equal(checkForkBoundaries(root).violations.length, 0);
  writeFileSync(path.join(root, 'server/sim/probe.js'), "import fs from 'node:fs';");
  writeFileSync(path.join(root, 'server/match/probe.js'), "import {encode} from '../net.js';");
  assert.deepEqual(checkForkBoundaries(root).violations.map((v) => v.code).sort(), ['match-http', 'sim-node']);
  writeFileSync(path.join(root, 'server/sim/nodeData.js'), "import cp from 'node:child_process';");
  assert.equal(checkForkBoundaries(root).violations.length, 3, 'the whole loader is not blanket-exempt');
});

test('the current fork obeys all enforced import boundaries', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.deepEqual(checkForkBoundaries(root).violations, []);
});
