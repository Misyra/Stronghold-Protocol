#!/usr/bin/env node
/**
 * Sync public art (public/assets, public/fonts, public/media) to a Cloudflare R2 bucket
 * so it can be served via SP_ASSETS_CDN (https://developers.cloudflare.com/r2/).
 *
 * Usage:
 *   node tools/r2-sync.mjs [--bucket weishu] [--account <account_id>] [--dry-run]
 *
 * Every file is written under two keys:
 *   assets/...            plain path (used when SP_ASSETS_CDN_VERSION is unset)
 *   _v/<tag>/assets/...   content-addressed release (used with SP_ASSETS_CDN_VERSION=<tag>)
 * The tag is the first 16 hex chars of sha256 over every file's path + content hash,
 * so it only changes when art actually changes. On success it is written to the repo's
 * `.assets-cdn-version` (commit it with the release: servers resolve the tag from this file
 * after `git pull`, falling back to the published `_v/latest` object; see docs/CDN.md §6).
 *
 * Resumable: uploaded keys are recorded in .cache/r2-sync-progress.json, so an
 * interrupted run continues where it stopped. Wrangler's OAuth token is re-read
 * and refreshed (via `wrangler whoami`) when the API answers 401/403.
 *
 * `--push` additionally commits just the version file and pushes master to every remote
 * except `origin` (the upstream).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PROGRESS_FILE = path.join(ROOT, '.cache', 'r2-sync-progress.json');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const args = process.argv.slice(2);
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
      await new Promise((resolve) => {
        const child = spawn(process.execPath, [WRANGLER_BIN, 'whoami'], { stdio: 'ignore', cwd: ROOT });
        child.on('exit', resolve);
        child.on('error', resolve);
      });
      readToken();
    })();
    refreshPromise.finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
const CONFIG_ACCOUNT = readToken();
const ACCOUNT = flag('--account', CONFIG_ACCOUNT || '66c7c5b7bad286a799db484a5ba4a7fb');
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects`;

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

async function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(abs).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
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

/** Publish the current tag as `_v/latest` so servers resolve SP_ASSETS_CDN_VERSION automatically
 *  (shared/assetCdn.js resolveAssetsCdnVersion). no-store: every reader must see the real value. */
async function publishLatest(tag) {
  await putObject('_v/latest', Buffer.from(tag), 'text/plain', 'no-store');
  console.log(`Published _v/latest = ${tag}`);
}

/** Ship the tag with the repo: servers read it at startup after `git pull` (server/assetVersion.js). */
const VERSION_FILE = path.join(ROOT, '.assets-cdn-version');
function writeVersionFile(tag) {
  fs.writeFileSync(VERSION_FILE, tag + '\n');
  console.log(`Wrote ${path.basename(VERSION_FILE)} = ${tag} — commit it with the release.`);
}

function pushVersionFile(tag) {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
    return r.stdout;
  };
  if (!git('status', '--porcelain', '--', path.basename(VERSION_FILE)).trim()) {
    console.log('.assets-cdn-version unchanged; nothing to commit.');
    return;
  }
  git('add', '--', path.basename(VERSION_FILE));
  git('commit', '-m', `素材：R2 发布 ${tag}`, '--', path.basename(VERSION_FILE));
  const remotes = git('remote').split(/\r?\n/).filter((r) => r && r !== 'origin');
  for (const remote of remotes) {
    console.log(git('push', remote, 'master').trim());
  }
}

// ---- collect files ----
const files = [];
for (const dir of ['assets', 'fonts', 'media']) {
  const abs = path.join(PUBLIC, dir);
  if (fs.existsSync(abs)) walk(abs, `${dir}/`, files);
}
if (!files.length) { console.error('No files found under public/{assets,fonts,media}.'); process.exit(1); }

// ---- content-addressed version tag ----
console.log(`Hashing ${files.length} files...`);
for (const f of files) f.hash = await hashFile(f.abs);
const tagHash = createHash('sha256');
for (const f of files.sort((a, b) => a.key.localeCompare(b.key, 'en'))) tagHash.update(`${f.key}\0${f.hash}\0`);
const tag = tagHash.digest('hex').slice(0, 16);

// ---- resume state ----
let progress = { tag: null, uploaded: [] };
try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch {}
if (progress.tag !== tag) progress = { tag, uploaded: [] };
const uploadedSet = new Set(progress.uploaded);
let flushTimer = null;
function flushProgress(final = false) {
  try {
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ tag, uploaded: [...uploadedSet] }));
  } catch {}
  if (!final && !flushTimer) flushTimer = setTimeout(() => { flushTimer = null; }, 10000);
}

// ---- plan ----
const jobs = files.flatMap((f) => [
  { key: f.key, abs: f.abs, cc: 'public, max-age=3600' },
  { key: `_v/${tag}/${f.key}`, abs: f.abs, cc: 'public, max-age=31536000, immutable' },
]).filter((j) => !uploadedSet.has(j.key));

console.log(`Version tag: ${tag}`);
if (!jobs.length) {
  console.log(`All ${files.length * 2} objects already uploaded to bucket '${BUCKET}'. Nothing to do.`);
  await publishLatest(tag);
  writeVersionFile(tag);
  if (args.includes('--push')) pushVersionFile(tag);
  console.log(`SP_ASSETS_CDN_VERSION=${tag}`);
  process.exit(0);
}
const totalBytes = jobs.reduce((s, j) => s + fs.statSync(j.abs).size, 0);
console.log(`${jobs.length} PUTs remaining (${(totalBytes / 1048576).toFixed(1)} MiB) of ${files.length * 2} total${DRY ? ' [dry run]' : ''}`);
if (DRY) process.exit(0);

// ---- upload ----
let done = 0, failed = 0;
const failures = [];
const queue = [...jobs].reverse();
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const job = queue.pop();
    if (!job) break;
    try {
      await put(job.key, job.abs, job.cc);
      uploadedSet.add(job.key);
    } catch (err) {
      failed++; failures.push(String(err.message || err));
      continue;
    }
    if (++done % 250 === 0) { console.log(`  ${done}/${jobs.length} uploaded`); flushProgress(); }
  }
});
await Promise.all(workers);
flushProgress(true);

if (failed) {
  console.error(`\n${failed} uploads FAILED:`);
  for (const m of failures.slice(0, 20)) console.error('  ' + m);
  process.exit(1);
}
await publishLatest(tag);
writeVersionFile(tag);
if (args.includes('--push')) pushVersionFile(tag);
console.log(`\nAll ${files.length * 2} objects uploaded to R2 bucket '${BUCKET}'.`);
console.log(`Set in the server environment:\n  SP_ASSETS_CDN=https://<your-r2-domain>\n  SP_ASSETS_CDN_VERSION=${tag}`);
