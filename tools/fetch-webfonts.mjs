// Self-host the web fonts the root page used to load from fonts.googleapis.com:
// Noto Sans SC (400/500/700/900), Oxanium (400/500/600/700) and Rajdhani
// (500/600/700), as css2 unicode-range segments under public/fonts/google/.
// The css2 stylesheet is fetched with a browser User-Agent (otherwise the API
// answers TTF and skips the CJK subsets), its @font-face blocks are kept
// verbatim except that every fonts.gstatic.com URL is rewritten to the local
// file, and the result is written to public/fonts/webfonts.css beside the
// Bender/Novecento fonts.css. The woff2 files and the manifest
// (public/fonts/webfonts-manifest.json, sizes + SHA-256) are runtime files in
// git-ignored public/fonts, like fonts.css. A re-run keeps files whose bytes
// still match the manifest; --force re-downloads everything.
//
// Uses the asset pipeline's Downloader (ledger .cache/webfonts-ledger.json,
// retries, atomic writes) and the same HTTP(S)_PROXY restart as the other
// fetch scripts; no new dependencies. Run: node tools/fetch-webfonts.mjs
// [--force] [--concurrency=8] [--help]

import { createHash } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { Downloader } from './assets/downloader.mjs';
import { restartForEnvProxy } from './assets/env-proxy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FONTS_DIR = join(ROOT, 'public', 'fonts');
const LEDGER = join(ROOT, '.cache', 'webfonts-ledger.json');
const CSS_OUT = join(FONTS_DIR, 'webfonts.css');
const MANIFEST_OUT = join(FONTS_DIR, 'webfonts-manifest.json');

/** The exact css2 request the root page made before self-hosting (public/index.html). */
const CSS2_URL = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700;900'
  + '&family=Oxanium:wght@400;500;600;700&family=Rajdhani:wght@500;600;700&display=swap';
// css2 answers woff2 + unicode-range segments only to a browser-looking User-Agent.
const CSS2_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

/** Families and weights the page expects; the generated CSS is checked against this. */
const FAMILIES = Object.freeze({
  'Noto Sans SC': Object.freeze([400, 500, 700, 900]),
  'Oxanium': Object.freeze([400, 500, 600, 700]),
  'Rajdhani': Object.freeze([500, 600, 700]),
});

/** 常用界面字 (卫戍协议盟约): every one must be covered by some Noto Sans SC unicode-range. */
const CJK_PROBES = Object.freeze([0x536b, 0x620d, 0x534f, 0x8bae, 0x76df, 0x7ea6]);

const HELP = `Usage: node tools/fetch-webfonts.mjs [options]
  --force           re-download every segment even when present and valid
  --concurrency=N   parallel downloads (default 8)
  --help            this text
Environment: HTTP(S)_PROXY is honoured through the same restart as the other
fetch scripts (NODE_USE_ENV_PROXY=1).`;

function log(m) { console.log(m); }

function parseArgs(argv) {
  const o = { force: false, concurrency: 8, help: false };
  for (const a of argv) {
    const [k, v] = a.split('=');
    if (k === '--force') o.force = true;
    else if (k === '--concurrency') o.concurrency = Math.max(1, Math.min(64, parseInt(v, 10) || 8));
    else if (k === '--help' || k === '-h') o.help = true;
    else throw new Error(`unknown option ${a}\n${HELP}`);
  }
  return o;
}

async function fetchCss2() {
  let lastErr = 'unknown error';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(CSS2_URL, {
        headers: { 'user-agent': CSS2_UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for the css2 stylesheet`);
      const css = await res.text();
      if (!css.includes('@font-face') || !css.includes('unicode-range') || !css.includes('fonts.gstatic.com')) {
        throw new Error(`css2 answer does not look like woff2 segments (${css.length} B) — check the User-Agent`);
      }
      return css;
    } catch (e) {
      lastErr = e?.message || String(e);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`could not fetch the css2 stylesheet: ${lastErr}`);
}

/** unicode-range value of one @font-face block → code-point tester (U+4e?? wildcards included). */
function rangeCovers(rangeValue, cp) {
  for (const token of rangeValue.split(',')) {
    const m = /^u\+([0-9a-f?]+)(?:-([0-9a-f?]+))?$/i.exec(token.trim());
    if (!m) continue;
    const lo = parseInt(m[1].replaceAll('?', '0'), 16);
    const hi = parseInt((m[2] ?? m[1]).replaceAll('?', 'f'), 16);
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * Pull the css2 sheet apart: per-URL local rel path, family/weight coverage,
 * CJK probe coverage. @font-face blocks are kept byte-for-byte; only the URLs move.
 * @param {string} css
 * @returns {{ rels: Map<string, string>, faces: { family: string, weight: number, url: string, range: string }[] }}
 */
export function planFaces(css) {
  const rels = new Map();
  const faces = [];
  for (const block of css.split('@font-face').slice(1)) {
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
    if (!family || !weight || !url || !range) throw new Error('css2 block without family/weight/url/unicode-range');
    if (!FAMILIES[family]) throw new Error(`css2 names unexpected family '${family}'`);
    const slug = /\/s\/([a-z0-9]+)\//.exec(url)?.[1];
    const base = url.slice(url.lastIndexOf('/') + 1);
    if (!slug || !base.endsWith('.woff2')) throw new Error(`unrecognized fonts.gstatic URL ${url}`);
    const rel = `google/${slug}/${base}`;
    if (rels.has(url) && rels.get(url) !== rel) throw new Error(`URL maps to two local paths: ${url}`);
    rels.set(url, rel);
    faces.push({ family, weight, url, range });
  }
  if (!faces.length) throw new Error('css2 answer has no @font-face blocks');
  const seen = new Set(faces.map((f) => `${f.family} ${f.weight}`));
  for (const [family, weights] of Object.entries(FAMILIES)) {
    for (const w of weights) {
      if (!seen.has(`${family} ${w}`)) throw new Error(`css2 answer lacks ${family} ${w}`);
    }
  }
  const missing = CJK_PROBES.filter((cp) => !faces.some((f) => f.family === 'Noto Sans SC' && rangeCovers(f.range, cp)));
  if (missing.length) throw new Error(`Noto Sans SC does not cover U+${missing.map((c) => c.toString(16)).join(', U+')}`);
  return { rels, faces };
}

/** Rewrite every fonts.gstatic URL in the css2 sheet to its local /fonts/ path. */
export function localizeCss(css, rels) {
  const out = css.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g, (m, url) => {
    const rel = rels.get(url);
    if (!rel) throw new Error(`no local file planned for ${url}`);
    return `url(/fonts/${rel})`;
  });
  if (/fonts\.(gstatic|googleapis)\.com/.test(out)) throw new Error('localized CSS still names Google hosts');
  return out;
}

/**
 * Files the previous manifest recorded but today's css2 no longer names
 * (Google bumped the font version). Reported, never deleted.
 * @param {object|null} manifest previous webfonts-manifest.json
 * @param {Set<string>} currentRels rel paths today's css2 needs
 */
function orphanCount(manifest, currentRels) {
  if (!manifest?.files) return 0;
  return Object.keys(manifest.files).filter((rel) => !currentRels.has(rel)).length;
}

/** Existing file whose bytes no longer match the manifest is removed so the run re-fetches it. */
async function pruneCorrupt(manifest, currentRels) {
  if (!manifest?.files) return 0;
  let pruned = 0;
  for (const [rel, entry] of Object.entries(manifest.files)) {
    if (!currentRels.has(rel)) continue;
    const abs = join(FONTS_DIR, rel);
    let buf;
    try { buf = await readFile(abs); } catch { continue; }
    if (buf.length === entry.bytes && createHash('sha256').update(buf).digest('hex') === entry.sha256) continue;
    await unlink(abs);
    log(`[webfonts] ${rel} no longer matches the manifest (${buf.length} B) — re-downloading`);
    pruned++;
  }
  return pruned;
}

async function sha256File(abs) {
  return createHash('sha256').update(await readFile(abs)).digest('hex');
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function main(opts) {
  log('[webfonts] fetching the css2 stylesheet (browser User-Agent, woff2 segments)');
  const css = await fetchCss2();
  const { rels, faces } = planFaces(css);
  const perFamily = {};
  for (const f of faces) {
    perFamily[f.family] ??= { weights: [...FAMILIES[f.family]], segments: 0 };
  }
  for (const rel of new Set(rels.values())) {
    const slug = /^google\/([a-z0-9]+)\//.exec(rel)?.[1];
    const family = Object.keys(FAMILIES).find((f) => f.toLowerCase().replace(/[^a-z0-9]/g, '') === slug);
    if (family) perFamily[family].segments++;
  }

  let previous = null;
  try { previous = JSON.parse(await readFile(MANIFEST_OUT, 'utf8')); } catch { /* first run */ }
  const currentRels = new Set(rels.values());
  const pruned = await pruneCorrupt(previous, currentRels);
  const orphans = orphanCount(previous, currentRels);
  if (orphans) log(`[webfonts] ${orphans} file(s) from an older css2 answer stay on disk (never deleted)`);

  const dl = new Downloader({ root: FONTS_DIR, ledgerPath: LEDGER, concurrency: opts.concurrency, force: opts.force, log });
  await dl.loadLedger();
  const jobs = [...rels.entries()].map(([url, rel]) => ({ rel, urls: [url], kind: 'font' }));
  const results = await dl.run(jobs, 'webfonts');
  const failures = jobs.filter((j) => !['ok', 'skip'].includes(results.get(j.rel)?.status));
  if (failures.length) {
    for (const j of failures) log(`[webfonts] ERROR ${j.rel}: ${results.get(j.rel)?.error}`);
    throw new Error(`${failures.length} of ${jobs.length} segment downloads failed; webfonts.css left unchanged`);
  }

  const files = {};
  let bytes = 0;
  for (const [url, rel] of rels) {
    const abs = join(FONTS_DIR, rel);
    const st = await stat(abs);
    bytes += st.size;
    files[rel] = { bytes: st.size, sha256: await sha256File(abs), url };
  }
  const local = localizeCss(css, rels);
  const header = `/* Generated by tools/fetch-webfonts.mjs — do not edit.
 * Self-hosted replacements for the css2 stylesheet the root page used to load
 * from fonts.googleapis.com. @font-face blocks are Google's css2 output with
 * the URLs rewritten to /fonts/google/**; re-generate with
 * \`node tools/fetch-webfonts.mjs\`.
 * Noto Sans SC, Oxanium and Rajdhani are distributed under the SIL Open Font License. */

`;
  await writeAtomic(CSS_OUT, header + local);
  await writeAtomic(MANIFEST_OUT, JSON.stringify({
    generator: 'tools/fetch-webfonts.mjs',
    css2Url: CSS2_URL,
    css: '/fonts/webfonts.css',
    families: perFamily,
    files,
  }, null, 1) + '\n');

  const counts = [...results.values()].reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  log(`[webfonts] ${Object.entries(perFamily).map(([f, p]) => `${f} ${p.weights.join('/')} × ${p.segments} segments`).join(', ')}`);
  log(`[webfonts] ${jobs.length} files: downloaded=${counts.ok || 0} kept=${counts.skip || 0}${pruned ? ` corruptPruned=${pruned}` : ''}${orphans ? ` orphansKept=${orphans}` : ''}, ${(bytes / 1048576).toFixed(2)} MB total`);
  log(`[webfonts] wrote ${CSS_OUT} and ${MANIFEST_OUT}`);
  return 0;
}

if (pathToFileURL(process.argv[1] || '').href === import.meta.url) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    log(HELP);
  } else if (!restartForEnvProxy()) {
    main(parseArgs(process.argv.slice(2))).catch((error) => { console.error(`[webfonts] ${error.message}`); process.exitCode = 1; });
  }
}
