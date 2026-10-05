// Player-package file selection. Dry-run only: no zip, no npm ci.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extraPaths,
  isExcluded,
  packageOutIsUnsafe,
  selectTracked,
  textHasHomePath,
  trackedFiles,
} from '../tools/package.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SAMPLE = [
  'server/index.js',
  'server/sim/rng.js',
  'shared/constants.js',
  'public/index.html',
  'public/js/main.js',
  'public/vendor/preact.mjs',
  'public/dev/game-mock.html',
  'public/assets/board.png',
  'public/fonts/fonts.css',
  'data/chess.json',
  'data/local-assets.json',
  'tools/setup.mjs',
  'tools/vendor.mjs',
  'tools/fetch-assets.mjs',
  'tools/assets/plan.mjs',
  'tools/local-extract/extract.py',
  'tools/golden.mjs',
  'tools/check-imports.mjs',
  'scripts/start.sh',
  'docs/PLAYING.md',
  'docs/DEPLOY.md',
  'docs/WINDOWS.md',
  'docs/ASSETS.md',
  'docs/img/combat.jpg',
  'docs/DESIGN.md',
  'docs/SIM.md',
  'docs/research/03-operators.json',
  'docs/research/10-networking-hosting.md',
  'test/version.test.js',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'NOTICE.md',
  'THIRD-PARTY-NOTICES.md',
  'README.md',
  'CHANGELOG.md',
  'Dockerfile',
  '.dockerignore',
  'AGENTS.md',
  '.env',
  '.env.local',
  'server/.env.production',
  'pv/clip.mp4',
  '3，9，11回合情况/note.txt',
  'handoff/HANDOFF.md',
  'node_modules/ws/index.js',
  '.cache/x',
  'eslint.config.js',
  'jsconfig.json',
  'types/core.js',
];

test('selectTracked keeps runtime files and drops the rest', () => {
  const got = selectTracked(SAMPLE);
  assert.deepEqual(got, selectTracked(SAMPLE, { lite: true }));
  for (const rel of [
    'server/index.js', 'tools/setup.mjs', 'tools/vendor.mjs', 'docs/PLAYING.md',
    'docs/DEPLOY.md', 'public/index.html', 'data/chess.json', 'package.json',
    'Dockerfile', 'scripts/start.sh', 'tools/assets/plan.mjs', 'tools/local-extract/extract.py',
  ]) assert.ok(got.includes(rel), rel);
  for (const rel of [
    'tools/golden.mjs', 'tools/check-imports.mjs', 'test/version.test.js', 'public/dev/game-mock.html',
    'public/assets/board.png', 'public/fonts/fonts.css', 'docs/research/10-networking-hosting.md',
    'docs/research/03-operators.json', 'docs/DESIGN.md', 'docs/SIM.md', 'AGENTS.md', '.env',
    '.env.local', 'server/.env.production', 'pv/clip.mp4', '3，9，11回合情况/note.txt',
    'handoff/HANDOFF.md', 'node_modules/ws/index.js', 'data/local-assets.json', 'eslint.config.js',
    'types/core.js',
  ]) assert.ok(!got.includes(rel), rel);
  assert.equal(isExcluded('docs/research/10-networking-hosting.md'), true);
});

test('lite extras skip art, fonts and the local manifest', () => {
  assert.deepEqual(extraPaths({ lite: true, hasLocalManifest: true }), ['public/vendor']);
  assert.deepEqual(extraPaths({ lite: false, hasLocalManifest: true }), [
    'public/vendor', 'public/assets', 'public/fonts', 'data/local-assets.json',
  ]);
  assert.deepEqual(extraPaths({ lite: false, hasLocalManifest: false }), [
    'public/vendor', 'public/assets', 'public/fonts',
  ]);
});

test('home-directory text and unsafe output directories', () => {
  assert.equal(textHasHomePath('see /Users/example/game'), 'mac-users');
  assert.equal(textHasHomePath('C:\\Users\\example\\game'), 'win-users');
  assert.equal(textHasHomePath('prefix /home/example/game'), 'posix-home');
  assert.equal(textHasHomePath('https://github.com/example/game'), null);
  assert.equal(packageOutIsUnsafe(ROOT, ROOT), true);
  assert.equal(packageOutIsUnsafe(path.dirname(ROOT), ROOT), true);
  assert.equal(packageOutIsUnsafe(path.join(ROOT, 'dist-pack'), ROOT), false);
});

test('real git ls-files: runtime in, dev and private out', () => {
  const got = new Set(selectTracked(trackedFiles(ROOT)));
  assert.ok(got.has('server/index.js'));
  assert.ok(got.has('tools/setup.mjs'));
  assert.ok(got.has('docs/PLAYING.md'));
  assert.ok(got.has('package-lock.json'));
  assert.equal(got.has('tools/golden.mjs'), false);
  assert.equal(got.has('tools/package.mjs'), false);
  assert.equal(got.has('test/golden.test.js'), false);
  assert.equal(got.has('docs/DESIGN.md'), false);
  assert.equal(got.has('eslint.config.js'), false);
  for (const rel of got) {
    assert.equal(rel.startsWith('docs/research/'), false, rel);
    assert.equal(rel.startsWith('test/'), false, rel);
    assert.equal(rel.startsWith('public/dev/'), false, rel);
    assert.equal(rel.startsWith('handoff/'), false, rel);
  }
});

test('dry-run lists the lite set and prints both size estimates', () => {
  const lite = spawnSync(process.execPath, ['tools/package.mjs', '--dry-run', '--lite'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(lite.status, 0, lite.stderr);
  assert.match(lite.stdout, /^mode: lite/m);
  assert.match(lite.stdout, /^dry-run: yes/m);
  assert.match(lite.stdout, /^file server\/index\.js$/m);
  assert.match(lite.stdout, /^file tools\/setup\.mjs$/m);
  assert.match(lite.stdout, /^file docs\/PLAYING\.md$/m);
  assert.match(lite.stdout, /^extra public\/vendor$/m);
  assert.doesNotMatch(lite.stdout, /^file tools\/golden\.mjs$/m);
  assert.doesNotMatch(lite.stdout, /^file test\//m);
  assert.doesNotMatch(lite.stdout, /^extra public\/assets$/m);
  assert.match(lite.stdout, /^uncompressed lite: \d+/m);
  assert.match(lite.stdout, /^uncompressed full estimate: \d+/m);
  assert.match(lite.stdout, /puppeteer-core/);
  const full = spawnSync(process.execPath, ['tools/package.mjs', '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /^mode: full/m);
  assert.match(full.stdout, /^extra public\/assets$/m);
  assert.match(full.stdout, /^extra public\/fonts$/m);
  const assets = Number((full.stdout.match(/^assets bytes: (\d+)/m) || [])[1]);
  assert.ok(assets > 300 * 1048576, `assets bytes ${assets}`);
});
