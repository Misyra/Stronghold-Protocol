#!/usr/bin/env node
// Targeted, local-only battle voice preparation. Never rebuilds art, models, SFX or BGM.
import { readFile, writeFile, mkdir, rename, readdir, lstat, realpath } from 'node:fs/promises';
import { statSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeVoiceLangs, VOICE_DIRS, VOICE_BATTLE_SLOTS } from './assets/audio.mjs';
import { contentHash, totalBytes } from './assets/manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'https://torappu.prts.wiki';
const MAX_BYTES = 8 * 1024 * 1024;
const exec = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const linesOf = (value) => Array.isArray(value) ? value : [value];
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const languagesOf = (value) => {
  const langs = normalizeVoiceLangs(value);
  if (langs.some((lang) => !['cn', 'jp', 'en'].includes(lang))) throw new Error('targeted preparation supports cn | jp | en only');
  return normalizeVoiceLangs(['cn', ...langs]);
};

/** Derive candidates only from installed CN battle slots and exact page-declared base directories. */
export function operatorVoicePlan(manifest, coverage, languages = ['cn', 'jp', 'en']) {
  const langs = languagesOf(languages), byId = new Map();
  for (const row of coverage?.rows || []) {
    if (byId.has(row.charId)) throw new Error(`duplicate coverage row ${row.charId}`);
    byId.set(row.charId, row);
  }
  if (!Object.keys(manifest?.audio?.voice || {}).length) throw new Error('installed CN battle voice is required');
  const jobs = [], excluded = [];
  for (const [charId, slots] of Object.entries(manifest.audio.voice)) {
    if (!/^char_\d+_[a-z0-9]+$/i.test(charId)) throw new Error('invalid voice charId');
    const files = new Set();
    for (const [slot, value] of Object.entries(slots)) {
      if (!VOICE_BATTLE_SLOTS.includes(slot) || !linesOf(value).length) throw new Error(`unsupported battle slot ${charId}.${slot}`);
      for (const url of linesOf(value)) {
        const match = typeof url === 'string' && /^\/assets\/audio\/voice\/cn\/(char_\d+_[a-z0-9]+)\/(cn_0(?:19|2\d|3[0-2])\.mp3)$/i.exec(url);
        if (!match || match[1] !== charId) throw new Error(`not a base CN battle file: ${charId}.${slot}`);
        files.add(match[2]);
      }
    }
    const row = byId.get(charId);
    if (!row) throw new Error(`coverage missing ${charId}`);
    for (const language of langs) {
      const base = `${VOICE_DIRS[language]}/${charId}`;
      const declared = row.declaredPaths?.[language === 'en' ? 'other' : language] || [];
      if (!declared.includes(base)) {
        if (language === 'cn') throw new Error(`CN base not declared: ${charId}`);
        excluded.push({ language, charId, name: row.name, missingSlots: Object.keys(slots).length, missingFiles: files.size, reason: 'base-directory-not-declared' });
        continue;
      }
      const events = new Set(Object.values(row.eventFiles || {}).map((file) => String(file).toLowerCase().replace(/\.wav$/, '.mp3')));
      for (const file of [...files].sort()) {
        if (!events.has(file)) throw new Error(`event not declared: ${charId}/${file}`);
        jobs.push({ language, charId, file, rel: `audio/voice/${language}/${charId}/${file}`, path: `/assets/audio/${base}/${file}` });
      }
    }
  }
  return { languages: langs, jobs, excluded };
}

/** All manifest assets, deduplicated exactly as the original asset/skin tools count them. */
export function voiceManifestMetadata(manifest, assetRoot) {
  const { version, hash, generator, stats, ...body } = manifest;
  const files = new Set();
  const walk = (value) => {
    if (typeof value === 'string' && value.startsWith('/assets/')) files.add(value.slice('/assets/'.length));
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(body);
  return { ...manifest, hash: contentHash(body), stats: { ...stats, files: files.size, bytes: totalBytes(assetRoot, files) } };
}

/** Only validated, installed candidate objects become new language URLs. CN and other sections are unchanged. */
export function mergeOperatorVoices(manifest, plan, verifiedRels, assetRoot) {
  const accepted = new Set(verifiedRels), candidates = new Set(plan.jobs.map((job) => job.rel));
  for (const rel of accepted) if (!candidates.has(rel) || !isFile(join(assetRoot, rel))) throw new Error(`uninstalled or unplanned voice ${rel}`);
  const voiceByLang = { ...(manifest.audio.voiceByLang || {}), cn: manifest.audio.voice };
  for (const language of plan.languages.filter((lang) => lang !== 'cn')) {
    const chars = { ...(voiceByLang[language] || {}) };
    for (const [charId, slots] of Object.entries(manifest.audio.voice)) {
      const next = { ...(chars[charId] || {}) };
      for (const [slot, value] of Object.entries(slots)) {
        const lines = linesOf(value).map((url) => url.replace('/voice/cn/', `/voice/${language}/`)).filter((url) => accepted.has(url.slice('/assets/'.length)));
        if (lines.length) next[slot] = Array.isArray(value) ? lines : lines[0];
      }
      if (Object.keys(next).length) chars[charId] = next;
    }
    voiceByLang[language] = chars;
  }
  return voiceManifestMetadata({ ...manifest, audio: { ...manifest.audio, voiceByLang } }, assetRoot);
}

/** Validate complete bodies, not only an MP3 prefix or duration metadata. */
export async function validateVoiceFile(path, expected = null) {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_BYTES) throw new Error('invalid voice file');
  const bytes = await readFile(path);
  if (!(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224))) throw new Error('invalid MP3 prefix');
  const hash = sha(bytes);
  if (expected && (bytes.length !== expected.bytes || hash !== expected.sha256)) throw new Error('voice receipt/body mismatch');
  const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', path], { timeout: 15000, maxBuffer: 128 * 1024 });
  const parsed = JSON.parse(probe.stdout);
  if (parsed.streams?.length !== 1 || parsed.streams[0].codec_name !== 'mp3' || !(Number(parsed.format?.duration) > 0)) throw new Error('invalid MP3 stream');
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', path, '-f', 'null', '-'], { timeout: 20000, maxBuffer: 128 * 1024 });
  return { bytes: bytes.length, sha256: hash, duration: Number(parsed.format.duration), stream: parsed.streams[0] };
}

async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const old = await lstat(path);
    if (!old.isFile() || !(await readFile(path)).equals(bytes)) throw new Error('refusing to replace existing different voice');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(path, bytes, { flag: 'wx' });
  }
}

async function bounded(jobs, concurrency, run, stopped = () => false) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length && !stopped()) await run(jobs[next++]);
  }));
}

async function fetchBody(job) {
  const response = await fetch(HOST + job.path, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'audio/mpeg', 'Accept-Encoding': 'identity' } });
  if (response.status !== 200) {
    await response.body?.cancel();
    const error = new Error(`source HTTP ${response.status}`); error.status = response.status; throw error;
  }
  const length = Number(response.headers.get('content-length'));
  if (response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/mpeg' || !Number.isInteger(length) || length <= 0 || length > MAX_BYTES) {
    await response.body?.cancel(); throw new Error('invalid source headers');
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > MAX_BYTES) throw new Error('source body too large');
    chunks.push(Buffer.from(chunk));
  }
  if (size !== length) throw new Error('incomplete source body');
  return Buffer.concat(chunks);
}

async function safeSource(source, rel) {
  const path = join(source, rel), actual = await realpath(path);
  const within = relative(await realpath(source), actual);
  if (within.startsWith('..' + sep) || within === '..' || within.startsWith(sep) || actual !== path) throw new Error('unsafe source path');
  return path;
}

function fallbackCoverage(manifest) {
  return Object.fromEntries(['cn', 'jp', 'en'].map((language) => {
    const slots = [], missingFiles = [];
    for (const [charId, rec] of Object.entries(manifest.audio.voice)) for (const [slot, value] of Object.entries(rec)) {
      const present = manifest.audio.voiceByLang?.[language]?.[charId]?.[slot];
      if (!present || !linesOf(present).length) slots.push(`${charId}.${slot}`);
      const files = new Set(linesOf(present || []).map((url) => typeof url === 'string' ? url.split('/').at(-1) : ''));
      for (const url of linesOf(value)) if (!files.has(url.split('/').at(-1))) missingFiles.push(`${charId}/${url.split('/').at(-1)}`);
    }
    return [language, { missingSlotCount: slots.length, missingFileCount: missingFiles.length, fallback: language === 'cn' ? 'silence' : 'audio.voice CN per slot or decode failure', missingSlots: slots, missingFiles }];
  }));
}

export async function prepareOperatorVoices({ sourceDir, coverage, receipt = null, fetchSources = false, languages = ['cn', 'jp', 'en'], concurrency = 2, manifestPath = join(ROOT, 'data/assets.json'), assetRoot = join(ROOT, 'public/assets'), onProgress = () => {} }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('voice concurrency must be 1 or 2');
  const source = resolve(sourceDir), prior = await readFile(manifestPath), manifest = JSON.parse(prior);
  const plan = operatorVoicePlan(manifest, coverage, languages), inventory = [], failures = [], missing = [], accepted = new Set();
  const receipts = new Map();
  for (const record of receipt || []) {
    if (receipts.has(record.rel)) throw new Error('duplicate voice receipt');
    receipts.set(record.rel, record);
  }
  if (fetchSources) {
    await mkdir(source, { recursive: true });
    if ((await readdir(source)).length) throw new Error('downloads require a new empty source directory');
  }
  let blocked = false, processed = 0;
  const run = async (job) => {
    const expected = receipts.get(job.rel);
    try {
      let path;
      if (job.language === 'cn') path = await safeSource(resolve(assetRoot), job.rel);
      else if (fetchSources) { path = join(source, job.rel); await put(path, await fetchBody(job)); }
      else {
        if (receipt && expected?.status !== 'verified') { missing.push({ ...job, reason: expected?.status || 'no-success-receipt', httpStatus: expected?.httpStatus }); return; }
        path = await safeSource(source, job.rel);
      }
      const verified = await validateVoiceFile(path, job.language !== 'cn' && receipt ? expected : null);
      if (job.language !== 'cn') {
        const bytes = await readFile(path);
        if (bytes.length !== verified.bytes || sha(bytes) !== verified.sha256) throw new Error('source changed after validation');
        await put(join(assetRoot, job.rel), bytes);
      }
      accepted.add(job.rel);
      inventory.push({ ...job, ...verified, reusedLocalCN: job.language === 'cn', verification: 'complete-body-sha256-ffprobe-and-full-ffmpeg-decode' });
    } catch (error) {
      if ([403, 429].includes(error.status)) blocked = true;
      if (error.status === 404 || error.code === 'ENOENT') missing.push({ ...job, reason: error.status === 404 ? 'HTTP404' : 'file-missing' });
      else failures.push({ ...job, reason: error.status ? `HTTP${error.status}` : error.code || (error.message.startsWith('Command failed:') ? 'decoder-failed' : error.message) });
    } finally { processed++; if (processed % 250 === 0) onProgress({ processed, planned: plan.jobs.length }); }
  };
  const cn = plan.jobs.filter((job) => job.language === 'cn');
  await bounded(cn, concurrency, run);
  const cnReady = cn.every((job) => accepted.has(job.rel));
  const remote = plan.jobs.filter((job) => job.language !== 'cn');
  if (cnReady) {
    const controls = fetchSources ? remote.filter((job) => job.language === 'en' && job.file === 'cn_023.mp3').slice(0, 3) : [];
    for (const job of controls) { await run(job); if (!accepted.has(job.rel)) { blocked = true; break; } }
    const controlRels = new Set(controls.map((job) => job.rel));
    if (!blocked) await bounded(remote.filter((job) => !controlRels.has(job.rel)), concurrency, run, () => blocked);
  }
  const next = mergeOperatorVoices(manifest, plan, accepted, assetRoot);
  let written = false;
  if (cnReady && !blocked) {
    if (!(await readFile(manifestPath)).equals(prior)) throw new Error('manifest changed during voice preparation; refusing overwrite');
    await writeFile(manifestPath + '.voice-tmp', JSON.stringify(next) + '\n', { flag: 'wx' });
    await rename(manifestPath + '.voice-tmp', manifestPath); written = true;
  }
  return { manifestWritten: written, normalTLS: true, sourceHost: 'torappu.prts.wiki', credentialsUsed: false, maxConcurrency: concurrency, retries: 0, providerWrites: false, productionAccessed: false, blocked, planned: plan.jobs.length, processed, excluded: plan.excluded, inventory, failures, missing,
    verifiedByLang: Object.fromEntries(plan.languages.map((lang) => [lang, inventory.filter((item) => item.language === lang).length])),
    fallbackCoverage: fallbackCoverage(next), manifestHash: written ? next.hash : manifest.hash, stats: written ? next.stats : manifest.stats };
}

export function parseVoicePreparationArgs(argv) {
  const opts = { languages: ['cn', 'jp', 'en'], concurrency: 2, fetchSources: false };
  let explicitLangs = [];
  for (const arg of argv) {
    const [key, ...parts] = arg.split('='), value = parts.join('=');
    if (key === '--voice-langs') explicitLangs = normalizeVoiceLangs([...explicitLangs, ...normalizeVoiceLangs([value])]);
    else if (key === '--source-dir') opts.sourceDir = value;
    else if (key === '--coverage') opts.coveragePath = value;
    else if (key === '--receipt') opts.receiptPath = value;
    else if (key === '--report') opts.reportPath = value;
    else if (key === '--fetch-sources') opts.fetchSources = true;
    else if (key === '--concurrency') opts.concurrency = Number(value);
    else if (key === '--help' || key === '-h') opts.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (explicitLangs.length) opts.languages = languagesOf(explicitLangs);
  if (![1, 2].includes(opts.concurrency)) throw new Error('voice concurrency must be 1 or 2');
  if (!opts.help && (!opts.sourceDir || !opts.coveragePath || !opts.reportPath)) throw new Error('--source-dir, --coverage and --report are required');
  if (opts.fetchSources && opts.receiptPath) throw new Error('existing receipts are offline import evidence, not a download retry');
  return opts;
}

const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url) {
  (async () => {
    const opts = parseVoicePreparationArgs(process.argv.slice(2));
    if (opts.help) { console.log('Usage: node tools/prepare-operator-voices.mjs --source-dir=DIR --coverage=JSON --report=JSON [--receipt=JSONL] [--voice-langs=cn,jp,en] [--fetch-sources] [--concurrency=2]\nDefault: offline complete-body validation/import only. Downloads require a new empty directory; fixed declared torappu paths, normal TLS, at most 2 concurrent requests, no retries, stop on 403/429.'); return; }
    const coverage = JSON.parse(await readFile(opts.coveragePath, 'utf8'));
    const receipt = opts.receiptPath ? (await readFile(opts.receiptPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)) : null;
    const report = await prepareOperatorVoices({ ...opts, coverage, receipt, onProgress: (progress) => console.log(JSON.stringify(progress)) });
    await writeFile(opts.reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ manifestWritten: report.manifestWritten, verifiedByLang: report.verifiedByLang, failures: report.failures.length, missing: report.missing.length, excludedOperators: report.excluded.length, manifestHash: report.manifestHash }));
    if (!report.manifestWritten || report.failures.length) process.exitCode = 1;
  })().catch((error) => { console.error(`voice preparation failed: ${error.message}`); process.exitCode = 1; });
}
