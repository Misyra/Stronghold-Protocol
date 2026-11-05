#!/usr/bin/env node
// Build preload ZIPs on the publishing machine; this command does not upload anything.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createResourceIndex } from '../server/resources.js';
import { hashFile } from '../server/fileHash.js';
import { resourcePackPath } from './resourcePackPath.mjs';
import { gapFilesOf, gapGroups, mergeAppendOnly } from './assets/gapPacks.mjs';

const script = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const options = { root: path.resolve(path.dirname(script), '..'), python: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), scopes: 'all', dryRun: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--help') {
    console.log('Usage: npm run resources:packs -- [--scopes fx,skin|all|gap] [--python python3] [--root <install>] [--dry-run]');
    process.exit(0);
  }
  if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
  const key = { '--root': 'root', '--python': 'python', '--scopes': 'scopes' }[argv[i]];
  if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`);
  options[key] = argv[++i];
}
const scopes = new Set(options.scopes.split(','));
if ([...scopes].some((scope) => !['all', 'fx', 'skin', 'gap'].includes(scope))) throw new Error('Scopes must be fx,skin,all or gap');
// `gap` is append-only: it must never be combined with `all`, which would skip the merge
// and replace the whole index. A mixed scope is a mistake, not a request.
if (scopes.has('gap') && scopes.size !== 1) throw new Error('--scopes gap cannot be combined with other scopes (it is append-only)');
const GAP = scopes.has('gap');
const root = path.resolve(options.root);
const publicDir = path.join(root, 'public');
const indexPath = path.join(root, 'data', 'resource-packs.json');
const { manifest } = await createResourceIndex({ dataDir: path.join(root, 'data'), publicDir }).get();

// --- append-only gap mode ---------------------------------------------------------------------------------------
// Build ONLY the files the current index does not name yet. Every existing pack entry is kept
// verbatim; the new packs are appended with a `gap-` id prefix so they cannot collide with a
// legacy pack id that an old index still points at. (AGENTS.md "ModelScope is append-only".)
let gapFiles = null;
let previous = null;
if (GAP) {
  try { previous = JSON.parse(await fs.readFile(indexPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  gapFiles = gapFilesOf(manifest, previous);
  const groups = gapGroups(gapFiles);
  const coveredCount = previous?.packs?.reduce((n, p) => n + (p.files?.length || 0), 0) ?? 0;
  console.log(`gap: index names ${coveredCount} file entries; manifest has ${manifest.files.length}; building ${gapFiles.length} uncovered file(s)`);
  for (const [g, n] of Object.entries(groups).sort()) console.log(`  gap group ${g.padEnd(12)} ${n}`);
  if (!gapFiles.length) { console.log('gap: nothing to add; index left untouched'); process.exit(0); }
  if (options.dryRun) { console.log('dry-run: no ZIPs written, index untouched'); process.exit(0); }
}

const files = GAP ? gapFiles : manifest.files.filter((file) => scopes.has('all') || scopes.has('fx') && file.fx || scopes.has('skin') && file.skin);
if (!files.length) throw new Error('No selected resources installed. Build packs on the machine with the extracted FX/skins.');
// Package the bytes actually on disk. R2 publication will publish their matching
// fingerprints; an old .assets-manifest.json must not authorize stale pack bytes.
for (const file of files) {
  // The manifest URL is data: decode once, then prove the file really lives under `public/` (no `%2F`/`%5C`, no `..`).
  const abs = resourcePackPath(publicDir, file.url);
  if (!abs) throw new Error(`Unsafe resource path: ${file.url}. Refusing to build packs from outside ${publicDir}.`);
  try {
    const { hash, bytes } = await hashFile(abs);
    file.hash = hash;
    file.size = bytes;
  } catch (cause) { throw new Error(`Resource missing/unreadable: ${file.url}. Build on the machine holding the complete selected assets.`, { cause }); }
}
const version = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 12);
const scratch = path.join(root, '.cache', 'resource-pack-build');
await fs.mkdir(scratch, { recursive: true });
const input = path.join(scratch, 'resource-manifest.json');
const nextIndex = path.join(scratch, 'resource-packs.next.json');
await fs.writeFile(input, JSON.stringify({ ...manifest, version, files, packs: undefined }));
const result = spawnSync(options.python, [path.join(path.dirname(script), 'resource_packs.py'),
  '--manifest', input, '--assets-root', publicDir,
  '--output', path.join(publicDir, 'resource-packs'), '--index', nextIndex], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const generated = JSON.parse(await fs.readFile(nextIndex, 'utf8'));
if (!scopes.has('all')) {
  if (!previous) {
    try { previous = JSON.parse(await fs.readFile(indexPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (previous?.format === 'stronghold-resource-pack-index' && Array.isArray(previous.packs)) {
    await fs.copyFile(indexPath, path.join(scratch, 'resource-packs.previous.json'));
    if (GAP) {
      Object.assign(generated, mergeAppendOnly(previous, generated));
    } else {
      generated.packs = [...previous.packs.filter((pack) => !(scopes.has('skin') &&
        (pack.group === 'skin' || pack.group?.startsWith('skin-') || pack.id?.startsWith('skin-'))
        || scopes.has('fx') && pack.group === 'fx')), ...generated.packs];
      generated.resourceVersion = createHash('sha1').update(JSON.stringify(generated.packs.map((pack) => pack.sha1))).digest('hex').slice(0, 12);
    }
  }
}
await fs.writeFile(nextIndex, JSON.stringify(generated) + '\n');
if (options.dryRun) { console.log('dry-run: no index written'); process.exit(0); }
await fs.rename(nextIndex, indexPath);
console.log(`Built ${files.length} resources (${options.scopes}). Publish ZIPs with npm run resources:publish, then deploy data/resource-packs.json and rebuild the frontend.`);
