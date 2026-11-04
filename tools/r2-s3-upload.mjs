/**
 * Publish public art to Cloudflare R2 over the S3-compatible API (AWS SigV4) — no wrangler, no Cloudflare v4 API
 * token, no per-account admin-API rate limit. Same diff semantics as r2-sync.mjs: only objects whose published hash
 * changed get uploaded, and the preload manifest is rewritten only after every PUT succeeded.
 *
 * The two delivery paths have fixed roles (AGENTS.md): per-file requests — a preload that fell back, and everything a
 * match asks for outside the preloaded set — come from this bucket, while preload itself prefers the ModelScope ZIPs.
 * The pack ZIPs are therefore NOT uploaded here unless `--packs` is passed; they belong to `npm run resources:publish`.
 *
 * Credentials come from the environment, or from a `.env` beside this checkout (R2_* and MODELSCOPE_* live there):
 *
 *   node tools/r2-s3-upload.mjs [--bucket weishu] [--account <id>] [--dry-run] [--concurrency 6] [--packs]
 *
 * Exit codes: 0 done, 1 nothing to do / usage error, 2 upload failed (progress kept in the manifest).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fingerprintPublishedAsset, publishedAssetsManifest } from './published-assets.mjs';
import { prepareResourcePackUpload } from './resource-pack-publish.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST_FILE = path.join(ROOT, '.assets-manifest.json');

// `.env` is per-machine and git-ignored; a real environment variable always wins. Parsing it here keeps the tool
// runnable with nothing but `node tools/r2-s3-upload.mjs` on the publishing machine.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].trim();
  }
} catch {}

const argv = process.argv.slice(2);
const KNOWN = new Set(['--bucket', '--account', '--dry-run', '--concurrency', '--packs']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`Unknown option ${a}. Known options: ${[...KNOWN].join(' ')} (--bucket/--account/--concurrency take a value).`);
    process.exit(1);
  }
}
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const DRY = argv.includes('--dry-run');
const WITH_PACKS = argv.includes('--packs');
const BUCKET = flag('--bucket', process.env.R2_BUCKET);
const ACCOUNT = flag('--account', process.env.R2_ACCOUNT_ID);
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const HOST = process.env.R2_ENDPOINT_HOST || (ACCOUNT ? `${ACCOUNT}.r2.cloudflarestorage.com` : '');
const REGION = process.env.R2_REGION || 'auto';
const CONCURRENCY = Number(flag('--concurrency', '6'));
const MAX_ATTEMPTS = 5;

if (!BUCKET || !HOST) {
  console.error('R2_BUCKET / R2_ACCOUNT_ID (or R2_ENDPOINT_HOST) missing: set them in .env or the environment.');
  process.exit(1);
}
if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing: R2 → Manage R2 API Tokens → Create API token (Object Read & Write) gives the S3 key pair.');
  process.exit(1);
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html',
  '.wasm': 'application/wasm', '.zip': 'application/zip', '.bin': 'application/octet-stream',
  '.glsl': 'text/plain', '.frag': 'text/plain', '.vert': 'text/plain', '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream', '.atlas': 'text/plain', '.xml': 'application/xml',
};

function walk(dir, prefix, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, `${prefix}${e.name}/`, out);
    else if (e.isFile()) out.push({ key: `${prefix}${e.name}`, abs });
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const canonicalKey = (key) => key.split('/').map(uriEncode).join('/');

async function putObject(key, body, contentType, cacheControl) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalUri = `/${BUCKET}/${canonicalKey(key)}`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const kDate = createHmac('sha256', `AWS4${SECRET_KEY}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(REGION).digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(`https://${HOST}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'cache-control': cacheControl,
    },
    body,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    const err = new Error(`PUT ${key} -> ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
}

async function uploadWithRetry(job) {
  const body = await fs.promises.readFile(job.abs);
  const contentType = MIME[path.extname(job.key).toLowerCase()] ?? 'application/octet-stream';
  for (let attempt = 1; ; attempt++) {
    try {
      await putObject(job.key, body, contentType, job.cc);
      return;
    } catch (e) {
      const retriable = !e.status || e.status >= 500 || e.status === 429;
      if (!retriable || attempt >= MAX_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
}

// ---- collect + hash ----
const files = [];
for (const dir of ['assets', 'fonts', 'media']) {
  const abs = path.join(PUBLIC, dir);
  if (fs.existsSync(abs)) walk(abs, `${dir}/`, files);
}
if (!files.length) {
  console.error('No files under public/{assets,fonts,media}.');
  process.exit(1);
}

console.log(`Hashing ${files.length} files...`);
let cursor = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < files.length) {
    const f = files[cursor++];
    Object.assign(f, await fingerprintPublishedAsset(f.abs));
  }
}));

const manifest = publishedAssetsManifest(files);
/**
 * The resume state, written atomically (temp file + rename): a crash or power loss mid-write must never leave a
 * truncated `.assets-manifest.json` behind — an unparsable one makes the next run see no previous manifest and
 * re-upload the whole bucket. The rename is atomic on the same filesystem, which is why the temp lives beside it.
 * @param {object} doc
 */
function writeManifest(doc) {
  const temp = `${MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(doc) + '\n', { flag: 'wx' });
    fs.renameSync(temp, MANIFEST_FILE);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* already renamed */ }
  }
}
let previous = null;
try {
  const doc = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  if (doc && /^[a-f0-9]{16}$/.test(doc.tag) && doc.hashes && typeof doc.hashes === 'object') previous = doc;
  else if (fs.existsSync(MANIFEST_FILE)) console.warn('Manifest has an unexpected shape; every object will be re-uploaded.');
} catch (err) {
  // A damaged resume state is recoverable (everything gets re-hashed and re-diffed), but a silent full re-upload is
  // the expensive surprise this warning exists to explain.
  if (fs.existsSync(MANIFEST_FILE)) console.warn(`Manifest unreadable (${err.message}); every object will be re-uploaded.`);
}

const jobs = (previous ? files.filter((f) => previous.hashes[`/${f.key}`] !== f.hash) : files)
  .map((f) => ({ key: f.key, abs: f.abs, cc: 'public, max-age=3600' }));
const packUpload = WITH_PACKS ? await prepareResourcePackUpload(ROOT) : { jobs: [], commit: async () => {} };
jobs.push(...packUpload.jobs);
const bytes = jobs.reduce((s, j) => s + fs.statSync(j.abs).size, 0);
console.log(`Manifest tag: ${manifest.tag}${previous ? ` (previous ${previous.tag})` : ' (no previous manifest)'}`);
console.log(`Bucket ${BUCKET} · ${jobs.length} PUT(s), ${(bytes / 1048576).toFixed(1)} MiB, ${files.length} files tracked`);
if (DRY) {
  for (const j of jobs.slice(0, 20)) console.log(`  ${j.key}`);
  if (jobs.length > 20) console.log(`  ... and ${jobs.length - 20} more`);
  process.exit(jobs.length ? 0 : 1);
}
if (!jobs.length) {
  writeManifest(manifest);
  await packUpload.commit();
  console.log('Nothing to upload; manifest refreshed.');
  process.exit(0);
}

// ---- upload ----
let index = 0, done = 0, failed = 0;
const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (index < jobs.length) {
    const job = jobs[index++];
    try {
      await uploadWithRetry(job);
      done++;
      if (done % 25 === 0 || done === jobs.length) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ${done}/${jobs.length} uploaded (${secs}s)`);
      }
    } catch (e) {
      failed++;
      console.error(`  FAILED ${e.message}`);
    }
  }
}));

if (failed) {
  console.error(`${failed} upload(s) failed; manifest NOT rewritten so the next run re-diffs the same set.`);
  process.exit(2);
}
writeManifest(manifest);
await packUpload.commit();
console.log(`Uploaded ${done} object(s) in ${((Date.now() - started) / 1000).toFixed(1)}s; manifest -> ${manifest.tag}`);
