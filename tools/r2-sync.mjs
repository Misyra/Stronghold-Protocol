#!/usr/bin/env node
/**
 * Sync public art (public/assets, public/fonts, public/media) to a Cloudflare R2 bucket
 * so it can be served via SP_ASSETS_CDN (https://developers.cloudflare.com/r2/).
 *
 * Incremental: every file lives under its plain path (`assets/…`) and the repo's
 * `.assets-manifest.json` records the content hash each published path had when this script
 * last ran. A run uploads only the files whose hash differs — usually a handful — then
 * rewrites the manifest (`{ tag, hashes, preload }`); `tag` is the first 16 hex chars of sha256 over
 * every path + hash, so it only changes when art actually changes. Servers commit the
 * manifest with the release and hand it to clients (server/index.js), which turn it into a
 * per-file `?v=<hash>` query on every CDN URL: immutable per URL, and a release re-busts
 * only the files it changed (see docs/operations/CDN.md). Server-only `preload` metadata
 * holds SHA-1 fingerprints and sizes of the same bytes for cache import verification.
 * `--metadata-only` refreshes it offline, refusing any unpublished file changes.
 *
 * The manifest IS the resume state: an interrupted run left it untouched, so the next run
 * simply re-diffs against it and re-uploads what is still missing.
 *
 * The legacy `.assets-cdn-version` / `_v/<tag>/` snapshot layout stays readable for rollback
 * (server/assetVersion.js still resolves it), but this script no longer writes either — an
 * old server that pulled a new tag would otherwise point at `_v/` keys that no longer exist.
 *
 * Wrangler's OAuth token is re-read and refreshed (via `wrangler whoami`) when the API
 * answers 401/403. `--push` additionally commits just the manifest and pushes master to
 * every remote except `origin` (the upstream).
 *
 * Usage:
 *   node tools/r2-sync.mjs [--bucket weishu] [--account <account_id>] [--dry-run] [--push] [--metadata-only]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fingerprintPublishedAsset, publishedAssetsManifest } from './published-assets.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST_FILE = path.join(ROOT, '.assets-manifest.json');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const args = process.argv.slice(2);
const KNOWN_ARGS = new Set(['--bucket', '--account', '--dry-run', '--push', '--metadata-only']);
for (const a of args) {
  // The flags take no `=` values and unknown flags must fail loudly: a typo here used to be
  // silently ignored and turned a `--help` into a real full upload.
  if (a.startsWith('--') && !KNOWN_ARGS.has(a)) {
    console.error(`Unknown option ${a}. Known options: ${[...KNOWN_ARGS].join(' ')} (--bucket/--account take a value). --metadata-only refuses unpublished bytes.`);
    process.exit(1);
  }
}
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BUCKET = flag('--bucket', 'weishu');
const DRY = args.includes('--dry-run');
const CONCURRENCY = 8;
// api.cloudflare.com caps accounts at ~1200 requests / 5 min on the free plan (4/s);
// pace just under it, and back off globally on any 429.
const MIN_INTERVAL_MS = 300;
const MAX_ATTEMPTS = 40;

const CONFIG_PATH = path.join(os.homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml');
let OAUTH = null;
function readToken() {
  const toml = fs.readFileSync(CONFIG_PATH, 'utf8');
  OAUTH = /oauth_token\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? null;
  const account = /account_id\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  if (!OAUTH) throw new Error('No oauth_token in wrangler config; run `npx wrangler login` first.');
  return account;
}
let refreshPromise = null;
function refreshToken() {
  // Single flight: Cloudflare refresh tokens are rotating, so concurrent wrangler spawns
  // would invalidate each other and wedge the run.
  if (!refreshPromise) {
    refreshPromise = (async () => {
      console.log('Refreshing wrangler OAuth token...');
      // wrangler is not a project dependency: without a local install, `npx wrangler` fetches it
      // into the npx cache — spawning the bare bin path would just fail with MODULE_NOT_FOUND.
      const local = fs.existsSync(WRANGLER_BIN);
      const done = await new Promise((resolve) => {
        const child = local
          ? spawn(process.execPath, [WRANGLER_BIN, 'whoami'], { stdio: 'ignore', cwd: ROOT })
          : spawn('npx', ['wrangler', 'whoami'], { stdio: 'ignore', cwd: ROOT, shell: true });
        child.on('exit', resolve);
        child.on('error', resolve);
      });
      if (done !== 0) console.log(`  wrangler whoami exited ${done}; re-reading the config anyway`);
      readToken();
    })();
    refreshPromise.finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain',
  '.atlas': 'text/plain', '.obj': 'text/plain', '.mtl': 'text/plain',
  '.html': 'text/html', '.js': 'text/javascript',
};

function walk(dir, prefix, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (e.name.startsWith('.') || e.name.endsWith('~') || e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name), key = prefix + e.name.replace(/\\/g, '/');
    if (e.isDirectory()) { walk(abs, key + '/', out); continue; }
    if (e.isFile()) out.push({ abs, key });
  }
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
let cooldownUntil = 0;
let cooldownMs = 30000;
let authFailures = 0;
async function acquireSlot() {
  const now = Date.now();
  nextSlot = Math.max(nextSlot, now) + MIN_INTERVAL_MS;
  if (nextSlot > now) await sleep(nextSlot - now);
  if (Date.now() < cooldownUntil) await sleep(cooldownUntil - Date.now());
}

async function putObject(key, body, contentType, cacheControl) {
  const url = `${API}/${key.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 1; ; attempt++) {
    await acquireSlot();
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${OAUTH}`,
        'content-type': contentType,
        'content-length': body.length,
        'cache-control': cacheControl,
      },
      body,
    });
    if (res.ok) { cooldownMs = 30000; return; }
    const detail = (await res.text()).slice(0, 200);
    if ((res.status === 401 || res.status === 403) && attempt <= 3 && authFailures < 6) {
      authFailures++;
      await refreshToken();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`PUT ${key} -> ${res.status}: authorization failed after token refresh; run \`npx wrangler login\` and re-run this script (progress is kept)`);
    }
    if (res.status === 429 && attempt <= MAX_ATTEMPTS) {
      // Global cooldown: every worker eases off, then resumes at the paced rate.
      const after = Number(res.headers.get('retry-after')) * 1000;
      const backoff = Number.isFinite(after) && after > 0 ? after : (cooldownMs = Math.min(cooldownMs * 2, 180000));
      cooldownUntil = Date.now() + backoff + Math.random() * 5000;
      console.log(`  429 rate limit, cooling down ${Math.round(backoff / 1000)}s...`);
      continue;
    }
    if (res.status >= 500 && attempt <= 5) { await sleep(1000 * attempt); continue; }
    throw new Error(`PUT ${key} -> ${res.status}: ${detail}`);
  }
}

async function put(key, abs, cacheControl) {
  await putObject(key, await fs.promises.readFile(abs), MIME[path.extname(key).toLowerCase()] ?? 'application/octet-stream', cacheControl);
}

/** Commit the manifest with the release: servers read it at startup after `git pull` (server/index.js). */
function pushManifest(tag) {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
    return r.stdout;
  };
  const name = path.basename(MANIFEST_FILE);
  if (!git('status', '--porcelain', '--', name).trim()) {
    console.log(`${name} unchanged; nothing to commit.`);
    return;
  }
  git('add', '--', name);
  git('commit', '-m', `素材：R2 增量发布 ${tag}`, '--', name);
  // Push targets: every remote except the read-only references — `origin` (the upstream this
  // fork syncs from) and `xinhai` (the lingxia repository, pull-only per AGENTS.md; pushing it
  // used to 403 AFTER the other pushes and fail the whole run).
  const pushable = (r) => {
    if (!r || r === 'origin') return false;
    const url = git('remote', 'get-url', r).trim();
    return !/github\.com[:/]xinhai-ai\//i.test(url);
  };
  const remotes = git('remote').split(/\r?\n/).filter(pushable);
  let failures = 0;
  for (const remote of remotes) {
    try { console.log(git('push', remote, 'master').trim()); }
    catch (e) {
      failures++;
      console.error(`  push ${remote} failed (the manifest commit is local; retry later): ${e.message}`);
    }
  }
  if (failures === remotes.length && remotes.length > 0) throw new Error(`every push failed; the manifest is committed locally`);
}

// ---- collect files ----
const files = [];
for (const dir of ['assets', 'fonts', 'media']) {
  const abs = path.join(PUBLIC, dir);
  if (fs.existsSync(abs)) walk(abs, `${dir}/`, files);
}
if (!files.length) { console.error('No files found under public/{assets,fonts,media}.'); process.exit(1); }

// ---- content-addressed manifest tag ----
console.log(`Hashing ${files.length} files...`);
for (const f of files) Object.assign(f, await fingerprintPublishedAsset(f.abs));
const manifest = publishedAssetsManifest(files);
const tag = manifest.tag;

// ---- diff against the manifest the last run wrote (also the resume state) ----
let previous = null;
try {
  const doc = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  if (doc && /^[a-f0-9]{16}$/.test(doc.tag) && doc.hashes && typeof doc.hashes === 'object') previous = doc;
} catch {}
const jobs = previous
  ? files.filter((f) => previous.hashes[`/${f.key}`] !== f.hash).map((f) => ({ key: f.key, abs: f.abs, cc: 'public, max-age=3600' }))
  : files.map((f) => ({ key: f.key, abs: f.abs, cc: 'public, max-age=3600' }));

console.log(`Manifest tag: ${tag}${previous ? ` (previous ${previous.tag})` : ' (no previous manifest — uploading every file)'}`);
if (args.includes('--metadata-only') && jobs.length) throw new Error('Unpublished asset changes found; metadata-only cannot authorize bytes not yet uploaded.');
if (!jobs.length) {
  // Old releases lack preload metadata. Refresh it locally even when no object needs uploading.
  if (!DRY) fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest) + '\n');
  console.log(`All ${files.length} files already published to bucket '${BUCKET}'. No object uploads; preload fingerprints ${DRY ? 'checked' : 'updated'}.`);
  if (!DRY && args.includes('--push')) pushManifest(tag);
  process.exit(0);
}
const totalBytes = jobs.reduce((s, j) => s + fs.statSync(j.abs).size, 0);
console.log(`${jobs.length} PUTs remaining (${(totalBytes / 1048576).toFixed(1)} MiB) of ${files.length} files${DRY ? ' [dry run]' : ''}`);
if (DRY) {
  for (const j of jobs.slice(0, 20)) console.log(`  ${j.key}`);
  if (jobs.length > 20) console.log(`  ... and ${jobs.length - 20} more`);
  process.exit(0);
}

const CONFIG_ACCOUNT = readToken();
const ACCOUNT = flag('--account', CONFIG_ACCOUNT || '66c7c5b7bad286a799db484a5ba4a7fb');
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects`;

// ---- upload only what changed ----
let done = 0;
let failed = 0;
const failures = [];
const queue = [...jobs].reverse();
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const job = queue.pop();
    if (!job) break;
    try {
      await put(job.key, job.abs, job.cc);
    } catch (err) {
      failed++; failures.push(String(err.message || err));
      continue;
    }
    if (++done % 250 === 0) console.log(`  ${done}/${jobs.length} uploaded`);
  }
});
await Promise.all(workers);

// The manifest is written only after every PUT succeeded, so a failed run leaves it untouched
// and the rerun re-uploads exactly the files that are still missing.
if (failed) {
  console.error(`\n${failed} uploads FAILED:`);
  for (const m of failures.slice(0, 20)) console.error('  ' + m);
  process.exit(1);
}
fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest) + '\n');
console.log(`\nAll ${files.length} files published to R2 bucket '${BUCKET}' (manifest ${tag}).`);
console.log(`Wrote ${path.basename(MANIFEST_FILE)} — commit it with the release, then \`git pull\` + restart the game servers.`);
if (args.includes('--push')) pushManifest(tag);
