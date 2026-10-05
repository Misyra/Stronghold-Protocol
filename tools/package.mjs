// Player package: git-tracked runtime files, production dependencies, and (unless --lite) local art.
//
// scripts/make-windows-bundle.mjs is the Windows portable-Node pack. This tool is the release zip:
// a runtime allowlist, not the whole tree. The Docker image still copies docs/research as a sim
// fallback; this zip does not. Players on --lite run `npm run setup` to download art and fonts.
//
//   node tools/package.mjs [--dry-run] [--lite] [--out <dir>] [--no-install]
//
// --dry-run prints the file list and a size summary and writes nothing.
// A real full zip is large because public/assets is included. Do not point --out at the repo.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROOT_FILES = new Set([
  'package.json', 'package-lock.json', 'LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md',
  'README.md', 'CHANGELOG.md', 'Dockerfile', '.dockerignore',
]);

const PLAYER_DOCS = new Set([
  'docs/PLAYING.md', 'docs/DEPLOY.md', 'docs/WINDOWS.md', 'docs/ASSETS.md',
]);

const RUNTIME_TOOLS = new Set([
  'tools/setup.mjs', 'tools/vendor.mjs', 'tools/fetch-assets.mjs',
  'tools/doctor.mjs', 'tools/crop-board-atlas.mjs',
]);

const DROP_PREFIXES = [
  'test/', 'public/dev/', 'public/assets/', 'public/fonts/', 'docs/research/',
  'handoff/', 'node_modules/', '.cache/', 'pv/', '3，9，11回合情况/',
];

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.txt', '.yml', '.yaml',
  '.ps1', '.sh', '.cmd', '.bat', '.py', '.svg',
]);

const HOME_PATTERNS = [
  { name: 'mac-users', re: /\/Users\// },
  { name: 'win-users', re: /[A-Za-z]:\\Users\\/ },
  { name: 'posix-home', re: /\/home\// },
];

export function posixRel(rel) {
  return String(rel).split('\\').join('/');
}

/** True when the path must never ship, even if an allow rule would match. */
export function isExcluded(rel) {
  const p = posixRel(rel);
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (p === 'AGENTS.md' || p === 'docs/research/10-networking-hosting.md') return true;
  return DROP_PREFIXES.some((pre) => p === pre.slice(0, -1) || p.startsWith(pre));
}

/** Git-tracked paths that belong in the player package. `lite` does not change this set. */
export function selectTracked(paths, _opts = {}) {
  const out = [];
  for (const raw of paths) {
    const rel = posixRel(raw);
    if (!rel || isExcluded(rel)) continue;
    if (allowed(rel)) out.push(rel);
  }
  out.sort();
  return out;
}

function allowed(rel) {
  if (rel.startsWith('server/') || rel.startsWith('shared/')) return true;
  if (rel.startsWith('public/')) return true;
  if (rel.startsWith('data/')) return rel !== 'data/local-assets.json';
  if (rel.startsWith('scripts/')) return true;
  if (RUNTIME_TOOLS.has(rel)) return true;
  if (rel.startsWith('tools/assets/') || rel.startsWith('tools/local-extract/')) return true;
  if (PLAYER_DOCS.has(rel) || rel.startsWith('docs/img/')) return true;
  return ROOT_FILES.has(rel);
}

/** Directories and files copied in addition to the git allowlist. */
export function extraPaths({ lite, hasLocalManifest }) {
  const paths = ['public/vendor'];
  if (!lite) {
    paths.push('public/assets', 'public/fonts');
    if (hasLocalManifest) paths.push('data/local-assets.json');
  }
  return paths;
}

export function textHasHomePath(text) {
  for (const { name, re } of HOME_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

/** True when `out` is the repo or a parent of it (a wipe there would take the repo with it). */
export function packageOutIsUnsafe(out, root = ROOT) {
  const r = path.resolve(root);
  const o = path.resolve(out);
  if (o === r) return true;
  const rel = path.relative(o, r);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function trackedFiles(root = ROOT) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error('git ls-files failed; package only tracked runtime files, so run it inside the repo');
  }
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

function fileBytes(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/** Bytes under abs, following symlinks. Skips nested node_modules and .cache. */
export function treeBytes(abs) {
  let total = 0;
  const seen = new Set();
  function walk(dir) {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.cache') continue;
      const p = path.join(real, ent.name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) total += st.size;
    }
  }
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) return st.size;
    if (st.isDirectory()) walk(abs);
  } catch {
    return 0;
  }
  return total;
}

/** Uncompressed size of production lockfile entries present under root/node_modules. Dev entries are skipped. */
export function prodModulesBytes(root, lock) {
  let total = 0;
  const packages = lock?.packages || {};
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || entry.dev) continue;
    total += treeBytes(path.join(root, key));
  }
  return total;
}

function exists(root, rel) {
  try { return fs.statSync(path.join(root, rel)).isFile() || fs.statSync(path.join(root, rel)).isDirectory(); }
  catch { return false; }
}

/**
 * Selection plus uncompressed byte counts. Does not copy or install.
 * @param {string} root
 * @param {{ lite?: boolean, paths?: string[] }} [opts]
 */
export function measure(root, opts = {}) {
  const lite = !!opts.lite;
  const paths = opts.paths || trackedFiles(root);
  const tracked = selectTracked(paths, { lite });
  let trackedBytes = 0;
  for (const rel of tracked) trackedBytes += fileBytes(path.join(root, rel));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const hasLocal = exists(root, 'data/local-assets.json');
  const vendorBytes = treeBytes(path.join(root, 'public', 'vendor'));
  const fontsBytes = treeBytes(path.join(root, 'public', 'fonts'));
  const assetsBytes = treeBytes(path.join(root, 'public', 'assets'));
  const manifestBytes = hasLocal ? fileBytes(path.join(root, 'data', 'local-assets.json')) : 0;
  const prodBytes = prodModulesBytes(root, lock);
  const liteBytes = trackedBytes + vendorBytes + prodBytes;
  const fullBytes = liteBytes + fontsBytes + assetsBytes + manifestBytes;
  return {
    version: pkg.version,
    lite,
    tracked,
    extras: extraPaths({ lite, hasLocalManifest: hasLocal }),
    trackedBytes,
    vendorBytes,
    fontsBytes,
    assetsBytes,
    manifestBytes,
    prodBytes,
    liteBytes,
    fullBytes,
    prodDeps: Object.keys(pkg.dependencies || {}).sort(),
    devDeps: Object.keys(pkg.devDependencies || {}).sort(),
    assetsPresent: exists(root, 'public/assets'),
    fontsPresent: exists(root, 'public/fonts'),
    vendorPresent: exists(root, 'public/vendor'),
  };
}

export function formatSummary(m) {
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  const lines = [
    `mode: ${m.lite ? 'lite' : 'full'}`,
    `version: ${m.version}`,
    `tracked files: ${m.tracked.length}`,
    `tracked bytes: ${m.trackedBytes}`,
    `vendor bytes: ${m.vendorBytes}${m.vendorPresent ? '' : ' (absent)'}`,
    `fonts bytes: ${m.fontsBytes}${m.lite ? ' (omitted in lite)' : ''}`,
    `assets bytes: ${m.assetsBytes}${m.lite ? ' (omitted in lite)' : ''}`,
    `local manifest bytes: ${m.manifestBytes}${m.lite ? ' (omitted in lite)' : ''}`,
    `production node_modules estimate: ${m.prodBytes}`,
    `uncompressed lite: ${m.liteBytes} (${mb(m.liteBytes)})`,
    `uncompressed full estimate: ${m.fullBytes} (${mb(m.fullBytes)})`,
    `production dependencies: ${m.prodDeps.join(' ')}`,
    `omitted devDependencies: ${m.devDeps.join(' ')}`,
  ];
  return lines.join('\n') + '\n';
}

function copyRel(root, stage, rel) {
  const src = path.join(root, rel);
  const dest = path.join(stage, rel);
  if (!fs.existsSync(src)) throw new Error(`missing ${rel}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { dereference: true, recursive: true });
}

function scanStage(stage) {
  const hits = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (child === 'node_modules' || child.startsWith('node_modules/') || child.startsWith('public/assets') || child.startsWith('public/fonts')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs, child); continue; }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      const named = ent.name === 'Dockerfile' || ent.name === '.dockerignore';
      if (!named && !TEXT_EXT.has(ext)) continue;
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const hit = textHasHomePath(text);
      if (hit) hits.push(`${child} (${hit})`);
    }
  }
  walk(stage, '');
  return hits;
}

function build(root, m, { out, noInstall }) {
  if (packageOutIsUnsafe(out, root)) throw new Error(`refusing to write the package into the repo or a parent of it: ${out}`);
  const folder = `Stronghold-Protocol-${m.version}${m.lite ? '-lite' : ''}`;
  const stage = path.join(out, folder);
  if (fs.existsSync(stage)) throw new Error(`package directory already exists: ${stage}`);
  if (!m.lite) {
    if (!m.assetsPresent) throw new Error('public/assets is missing; a full package needs the local art (or pass --lite)');
    if (!m.fontsPresent) throw new Error('public/fonts is missing; a full package needs the local fonts (or pass --lite)');
  }
  fs.mkdirSync(stage, { recursive: true });
  for (const rel of m.tracked) copyRel(root, stage, rel);
  for (const rel of m.extras) {
    if (!fs.existsSync(path.join(root, rel))) {
      if (rel === 'data/local-assets.json') continue;
      if (rel === 'public/vendor' && !noInstall) continue; // npm ci postinstall (tools/vendor.mjs) fills it
      throw new Error(`missing ${rel}`);
    }
    copyRel(root, stage, rel);
  }
  if (!noInstall) {
    const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
    if (r.error || r.status !== 0) throw new Error('npm ci --omit=dev failed in the package directory');
    fs.rmSync(path.join(stage, 'node_modules', '.cache'), { recursive: true, force: true });
  }
  const hits = scanStage(stage);
  if (hits.length) {
    throw new Error(`refusing to pack; home-directory paths in:\n${hits.join('\n')}`);
  }
  const zipPath = path.join(out, `${folder}.zip`);
  const zip = spawnSync('zip', ['-r', '-q', zipPath, folder], { cwd: out });
  if (zip.error || zip.status !== 0) throw new Error('zip failed');
  return { stage, zipPath };
}

function main(argv) {
  let lite = false;
  let dry = false;
  let noInstall = false;
  let out = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lite') lite = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--no-install') noInstall = true;
    else if (a === '--out') {
      out = argv[++i];
      if (!out || out.startsWith('--')) {
        console.error('package: --out needs a directory');
        return 1;
      }
    } else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/package.mjs [--dry-run] [--lite] [--out <dir>] [--no-install]');
      return 0;
    } else {
      console.error(`package: unknown argument ${a}`);
      return 1;
    }
  }
  const m = measure(ROOT, { lite });
  process.stdout.write(formatSummary(m));
  if (dry) {
    process.stdout.write('dry-run: yes\n');
    for (const rel of m.tracked) process.stdout.write(`file ${rel}\n`);
    for (const rel of m.extras) process.stdout.write(`extra ${rel}\n`);
    return 0;
  }
  const dest = out || path.join(os.tmpdir(), `stronghold-protocol-package-${m.version}`);
  const built = build(ROOT, m, { out: dest, noInstall });
  console.log(`zip: ${built.zipPath}`);
  return 0;
}

const invoked = process.argv[1]
  && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invoked) process.exit(main(process.argv.slice(2)));
