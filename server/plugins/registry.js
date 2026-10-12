// server/plugins/registry.js — this server's plugins and language packs (DESIGN §32, docs/PLUGINS.md; the formats:
// shared/plugins/manifest.js, shared/packs.js). One registry over four folders:
//
//   public/i18n/<code>.json (+ data/i18n/<code>.json)   single-file language packs — manifest 1, the file's `_meta`
//   packs/<id>/pack.json + its files                      folder packs — manifest 1 (type lang loads; assets / data
//                                                         were planned and stay unloaded)
//   plugins/<id>/plugin.json + its files                  plugins — manifest 2, any class; a folder whose name starts
//                                                         with '_' (the templates) or '.' is never read, nor is a file
//                                                         at the top of plugins/ (README.md, the server policy of P1c)
//
// It validates them (manifest, the file rules and limits, the paths a manifest names — inside the folder once links
// are resolved) and answers
//   * GET /packs/index.json — the language entries (lang class) exactly as server/packs.js always did, so the language
//     menu (public/js/ui/lang.js) is unchanged; a lang plugin of plugins/ is listed there like a pack folder;
//   * GET /packs/<id>/<file> — only a file the manifest of a loaded lang folder (pack or plugin) names (servable);
//   * GET /plugins/index.json — the catalogue: every plugin and pack found, by class, with its status (shared/plugins/
//     manifest.js buildPluginIndex; the vanilla content hash beside it — server/plugins/identity.js);
//   * the files of a loaded cosmetic plugin (pluginFile) — served at /p/<id>/<hash8>/<path> (server/http/static.js; the
//     visual sets that use them: server/plugins/visualSet.js).
// The classes lang and cosmetic load (P1a). A cosmetic plugin's asset overlay is read when it is scanned
// (shared/plugins/visual.js readAssetOverlay: its shape, files, references to data/assets.json, permissions; plugin.lock.json
// for its Spine models) and the files that shape it are hashed — SHA-256, kept by path + size + mtime, so a rescan reads
// only what changed [ASSUMED: at scan, synchronously — a 200 MB plugin costs about a second once]; a problem keeps it out
// like any other. A content plugin is validated and listed as `planned` (P1b); a script, ui or trusted one is listed as
// `unsupported` and never loaded (no third-party code runs — the owner's decision of 2026-10-12). Of a plugin folder only
// the files a lang manifest names (at /packs/<id>/<file>) and the files a cosmetic overlay names (at /p/…) are served;
// nothing else — not plugin.json, the lock, documents or a file the overlay does not name.
// A broken manifest, a file the class may not carry, a second entry with an id (any case: one folder on Windows /
// macOS) or a language already taken: reported (`skipped`: the start log, `node tools/plugin.mjs list`), never listed.
// An entry that cannot even be read (an error while reading it) is skipped the same way: one bad folder never stops
// the scan, the index or the server's start.
// The folders are re-read when something in them changes (checked when the index or a pack file is asked for, at most
// once a second: a few stat calls), so a language pack or a plugin dropped in shows on the next page load — no restart.
// server/packs.js re-exports the pack API of this file for its old callers.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { APP_VERSION, PLUGIN_API } from '../../shared/constants.js';
import { PACK_TYPES, PACK_MANIFEST, PACKS_URL, normalizeManifest, packIndexEntry, buildPackIndex } from '../../shared/packs.js';
import { SOURCE_LANG, isLangCode, countStrings } from '../../shared/i18nPacks.js';
import {
  PLUGIN_MANIFEST, PLUGIN_LIMITS, appVersionMatches, buildPluginIndex, checkJsonLimits, checkPluginFiles, classStatus, declaredPaths, readPluginManifest,
} from '../../shared/plugins/manifest.js';
import {
  FILE_URL_DIGITS, LOCK_FILE, attachSpineMeta, modelHashOf, readAssetOverlay, readPluginLock, visualHashOf,
} from '../../shared/plugins/visual.js';
import { canonicalJson } from '../../shared/plugins/identity.js';

/** The language folders' subdirectory (public/i18n/, data/i18n/). */
export const LANG_DIR = 'i18n';
/** Largest manifest / UI file read (bytes): a pack file is small text. */
const MAX_JSON_BYTES = PLUGIN_LIMITS.jsonBytes;
const noop = () => {};

/**
 * @typedef {{ rel: string, abs: string, url: string }} PackFile
 * @typedef {import('../../shared/plugins/manifest.js').PluginManifest} PluginManifest
 * @typedef {{ abs: string, sha256: string, bytes: number, mtimeMs: number, urlHashes: Set<string> }} ServedFile
 *   a file a cosmetic overlay names: its SHA-256 and size / mtime when it was hashed, and the URL hash segments that name
 *   these bytes (the file's own first 8 hex digits, those of every Spine model it belongs to)
 * @typedef {{ ops: import('../../shared/plugins/visual.js').AssetOp[], served: Map<string, ServedFile>,
 *   composition: import('../../shared/plugins/visual.js').VisualOverlay, vs: string | null, bytes: number, hash: string, dir: string }} PluginVisual
 *   a loaded cosmetic plugin: its overlay's writes (Spine models with their clip data), the files it serves, its part of
 *   a `vs` (shared/plugins/visual.js) and the `vs` of the set of it alone (null without data/assets.json), the bytes it
 *   serves, a short hash of its composition (room.state.content.plugins[].hash), its folder
 * @typedef {{ id: string, type: string, class: string, status: 'loaded' | 'planned' | 'unsupported', source: 'i18n' | 'packs' | 'plugins',
 *   layout: 'file' | 'folder', where: string, supported: boolean, manifest: PluginManifest, files: Record<string, PackFile>,
 *   strings?: number, bytes?: number, count?: number, visual?: PluginVisual }} Plugin
 *   One entry of the registry. type: the manifest 1 type (lang, assets, data …); status: what this version does with
 *   it; supported: a language entry of 0.2.0's pack registry (the lang class, loaded — a loaded cosmetic plugin is none);
 *   files: a lang entry's files with their URLs; visual: a loaded cosmetic plugin's overlay.
 * @typedef {Plugin} Pack an entry of the language-pack view (scanPacks)
 * @typedef {{ where: string, problems: string[] }} Skipped
 * @typedef {{ publicDir: string, dataDir: string, packsDir: string, pluginsDir?: string }} PluginDirs
 *   pluginsDir: the plugin folders (none: plugins/ is not read — the pack view of 0.2.0's callers)
 * @typedef {Map<string, { size: number, mtimeMs: number, sha256: string }>} HashCache
 *   SHA-256 of files by absolute path, while they keep the size and mtime they were hashed with
 * @typedef {{ manifest: any, sha256: string | null }} VanillaAssets
 *   the installation's art manifest (data/assets.json, parsed: what a reference names) and the SHA-256 of its bytes
 *   (the `assets` of a `vs`); both null without the file
 */

const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };
const readDirSorted = (dir) => { try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); } catch { return []; } };

/** A JSON file of at most MAX_JSON_BYTES, or { error }. */
function readJson(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { error: 'not a file' };
    if (st.size > MAX_JSON_BYTES) return { error: `larger than ${MAX_JSON_BYTES >> 20} MB` };
    return { json: JSON.parse(fs.readFileSync(abs, 'utf8')) };
  } catch (e) {
    return { error: e instanceof SyntaxError ? `not valid JSON (${e.message})` : String(e?.code || e?.message || e) };
  }
}

/**
 * The SHA-256 of a file (hex), from `cache` while it keeps the size and mtime it was hashed with; null when it cannot be
 * read.
 * @param {string} abs
 * @param {HashCache} cache
 * @returns {{ sha256: string, size: number, mtimeMs: number } | null}
 */
export function hashFile(abs, cache) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = cache.get(abs);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  try {
    const rec = { size: st.size, mtimeMs: st.mtimeMs, sha256: createHash('sha256').update(fs.readFileSync(abs)).digest('hex') };
    cache.set(abs, rec);
    return rec;
  } catch { return null; }
}

/** The art manifest data/assets.json of `dataDir` (VanillaAssets), from `cache` while its size and mtime stay. */
export function readVanillaAssets(dataDir, cache = new Map()) {
  const abs = path.join(dataDir, 'assets.json');
  let st;
  try { st = fs.statSync(abs); } catch { return { manifest: null, sha256: null }; }
  const hit = cache.get(abs);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value = { manifest: null, sha256: null };
  try {
    const buf = fs.readFileSync(abs);
    value = { manifest: JSON.parse(buf.toString('utf8')), sha256: createHash('sha256').update(buf).digest('hex') };
  } catch { /* unreadable: no references can be checked, no vs */ }
  cache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, value });
  return value;
}

/** Whether `abs` is inside `dir` once symbolic links are resolved (a pack file never leads out of its folder). */
export function inside(dir, abs) {
  try {
    const d = fs.realpathSync(dir);
    const f = fs.realpathSync(abs);
    return f.startsWith(d + path.sep);
  } catch { return false; }
}

const fileUrl = (id, rel) => `${PACKS_URL}${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Every file of a plugin folder, `rel` relative to it: dot files and folders left out (never served), a symbolic link
 * listed as one (not followed). Stops after the plugin file limit + 1, so a huge folder costs little.
 * @param {string} dir
 * @returns {{ rel: string, bytes: number, link?: boolean }[]}
 */
export function listPluginFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let names;
    try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      if (out.length > PLUGIN_LIMITS.files) return;
      if (d.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const child = path.join(abs, d.name);
      if (d.isSymbolicLink()) { out.push({ rel: childRel, bytes: 0, link: true }); continue; }
      if (d.isDirectory()) { walk(child, childRel); continue; }
      if (!d.isFile()) continue;
      let bytes;
      try { bytes = fs.statSync(child).size; } catch { continue; }
      out.push({ rel: childRel, bytes });
    }
  };
  walk(dir, '');
  return out;
}

/**
 * The asset overlay of a cosmetic plugin (see the header; shared/plugins/visual.js): its `assets` part read and checked
 * against the installation's manifest, plugin.lock.json for its Spine models, the files that shape it hashed.
 * @param {string} dir the plugin folder
 * @param {PluginManifest} manifest
 * @param {{ rel: string, bytes: number, link?: boolean }[]} listed the folder's files (listPluginFiles)
 * @param {{ vanilla: VanillaAssets, hashCache: HashCache }} ctx
 * @returns {{ visual: PluginVisual | null, problems: string[], warnings: string[] }}
 */
function readVisual(dir, manifest, listed, { vanilla, hashCache }) {
  const problems = [];
  const warnings = [];
  if (manifest.parts.theme) warnings.push('"theme" is not applied by this version (it applies the art of "assets")');
  const part = manifest.parts.assets;
  let assets = {};
  let assetsFile = null;
  if (part?.inline) assets = part.inline;
  else if (part) {
    assetsFile = part.files[0];
    if (part.files.length > 1) problems.push('"assets" names more than one file (one overlay per plugin)');
    const r = readJson(path.join(dir, ...assetsFile.split('/')));
    if (r.error) problems.push(`${assetsFile}: ${r.error}`);
    else { const bad = checkJsonLimits(r.json); if (bad) problems.push(`${assetsFile}: ${bad}`); else assets = r.json; }
  }
  const fileSet = new Set(listed.filter((f) => !f.link).map((f) => f.rel));
  let lock = null;
  if (fileSet.has(LOCK_FILE)) {
    const r = readJson(path.join(dir, LOCK_FILE));
    if (r.error) problems.push(`${LOCK_FILE}: ${r.error}`);
    else { const l = readPluginLock(r.json); problems.push(...l.problems); lock = l.lock; }
  }
  const ov = readAssetOverlay(assets, { vanilla: vanilla.manifest, permissions: manifest.permissions, has: (rel) => fileSet.has(rel) });
  problems.push(...ov.problems);
  warnings.push(...ov.warnings);
  if (problems.length) return { visual: null, problems, warnings };
  // the files that shape the overlay (shared/plugins/visual.js: the `files` of its part of a vs)
  const shaping = [...new Set([PLUGIN_MANIFEST, ...(lock ? [LOCK_FILE] : []), ...(assetsFile ? [assetsFile] : []), ...ov.files])];
  /** @type {Record<string, { sha256: string, size: number, mtimeMs: number }>} */
  const hashed = {};
  for (const rel of shaping) {
    const abs = path.join(dir, ...rel.split('/'));
    const h = inside(dir, abs) ? hashFile(abs, hashCache) : null;
    if (!h) problems.push(`${rel}: cannot be read inside the plugin folder`);
    else hashed[rel] = h;
  }
  if (problems.length) return { visual: null, problems, warnings };
  const sha = (rel) => hashed[rel]?.sha256 ?? null;
  const meta = attachSpineMeta(ov.ops, lock, sha);
  problems.push(...meta.problems);
  if (problems.length) return { visual: null, problems, warnings };
  /** @type {Map<string, ServedFile>} */
  const served = new Map();
  for (const rel of ov.files) {
    const h = hashed[rel];
    served.set(rel, { abs: path.join(dir, ...rel.split('/')), sha256: h.sha256, bytes: h.size, mtimeMs: h.mtimeMs, urlHashes: new Set([h.sha256.slice(0, FILE_URL_DIGITS)]) });
  }
  for (const model of ov.models) {
    const m = modelHashOf(model.map(sha)).slice(0, FILE_URL_DIGITS);
    for (const rel of model) served.get(rel)?.urlHashes.add(m);
  }
  const composition = { id: manifest.id, version: manifest.version, files: Object.fromEntries(shaping.sort().map((rel) => [rel, hashed[rel].sha256])) };
  const bytes = [...served.values()].reduce((n, f) => n + f.bytes, 0);
  return {
    visual: {
      ops: meta.ops, served, composition, bytes, dir,
      vs: vanilla.sha256 ? visualHashOf({ assets: vanilla.sha256, overlays: [composition] }) : null,
      hash: createHash('sha256').update(canonicalJson(composition)).digest('hex').slice(0, 16),
    },
    problems,
    warnings,
  };
}

/**
 * Read one plugin folder: its manifest, its files, the paths the manifest names — and, for a cosmetic plugin, its asset
 * overlay (readVisual). With `problems` it stays out (`plugin` null); otherwise `plugin` is its entry.
 * @param {string} dir the folder (its name is the id)
 * @param {{ app?: string, api?: { current: number, min: number }, where?: string, vanilla?: VanillaAssets | (() => VanillaAssets),
 *   hashCache?: HashCache }} [opts]
 *   vanilla: the installation's art manifest, or a function that reads it (called for a cosmetic plugin only; default:
 *   none — a cosmetic plugin's references are not checked and it has no `vs`); hashCache: kept file hashes (default: a
 *   new one)
 * @returns {{ plugin: Plugin | null, problems: string[], warnings: string[] }}
 */
export function readPluginFolder(dir, { app = APP_VERSION, api = PLUGIN_API, where, vanilla = { manifest: null, sha256: null }, hashCache = new Map() } = {}) {
  const id = path.basename(dir);
  const at = where ?? `plugins/${id}/`;
  const man = path.join(dir, PLUGIN_MANIFEST);
  if (!isFile(man)) {
    const hint = isFile(path.join(dir, PACK_MANIFEST)) ? ` (${PACK_MANIFEST} is the manifest 1 of a pack folder in packs/; a plugin has ${PLUGIN_MANIFEST}, "manifest": 2)` : '';
    return { plugin: null, problems: [`no ${PLUGIN_MANIFEST}${hint}`], warnings: [] };
  }
  const r = readJson(man);
  if (r.error) return { plugin: null, problems: [`${PLUGIN_MANIFEST}: ${r.error}`], warnings: [] };
  const { manifest, problems, warnings, draft } = readPluginManifest(r.json, { id, app, api });
  // the files are checked against what could be read even when the manifest has problems: one pass reports all
  const read = manifest || draft;
  if (!read) return { plugin: null, problems, warnings };
  const files = listPluginFiles(dir);
  const check = checkPluginFiles(read, files);
  problems.push(...check.problems);
  warnings.push(...check.warnings);
  for (const d of declaredPaths(read)) {
    const abs = path.join(dir, ...d.rel.split('/'));
    if (isFile(abs) && !inside(dir, abs)) problems.push(`"${d.at}": ${d.rel} leads out of the plugin folder`);
  }
  if (!manifest || problems.length) return { plugin: null, problems, warnings };
  const status = classStatus(manifest.class);
  /** @type {Record<string, PackFile>} */
  const served = {};
  if (manifest.class === 'lang') for (const [role, rel] of Object.entries(manifest.files)) served[role] = { rel, abs: path.join(dir, ...rel.split('/')), url: fileUrl(id, rel) };
  /** @type {Plugin} */
  const plugin = {
    id, type: manifest.type, class: manifest.class, status, source: 'plugins', layout: 'folder', where: at,
    supported: status === 'loaded' && manifest.class === 'lang', manifest, files: served, bytes: check.bytes, count: check.count,
  };
  if (manifest.class === 'cosmetic' && status === 'loaded') {
    const v = readVisual(dir, manifest, files, { vanilla: typeof vanilla === 'function' ? vanilla() : vanilla, hashCache });
    warnings.push(...v.warnings);
    if (!v.visual) return { plugin: null, problems: v.problems, warnings };
    plugin.visual = v.visual;
  }
  if (manifest.class === 'lang') {
    const ui = readJson(served.ui.abs);
    if (ui.error || !ui.json || typeof ui.json !== 'object' || Array.isArray(ui.json)) {
      return { plugin: null, problems: [`files.ui: ${ui.error || 'not a JSON object of msgid → translation'}`], warnings };
    }
    plugin.strings = countStrings(ui.json);
  }
  return { plugin, problems, warnings };
}

/**
 * Scan the folders once.
 * @param {PluginDirs} dirs
 * @param {{ app?: string, api?: { current: number, min: number }, hashCache?: HashCache, vanilla?: VanillaAssets | null,
 *   artCache?: Map<string, any> }} [opts]
 *   hashCache: file hashes kept from earlier scans (a registry's); vanilla: the installation's art manifest (default: read
 *   from dataDir — only when a cosmetic plugin is found, through `artCache`)
 * @returns {{ plugins: Plugin[], skipped: Skipped[], warnings: { where: string, warning: string }[], vanilla: VanillaAssets | null }}
 *   vanilla: the art manifest read for this scan (null when no cosmetic plugin needed it)
 */
export function scanPlugins({ publicDir, dataDir, packsDir, pluginsDir }, { app = APP_VERSION, api = PLUGIN_API, hashCache = new Map(), vanilla = null, artCache = new Map() } = {}) {
  let art = vanilla;
  const getArt = () => (art ||= readVanillaAssets(dataDir, artCache));
  /** @type {Plugin[]} */
  const found = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const warnings = [];
  const warn = (where, list) => { for (const w of list) warnings.push({ where, warning: w }); };
  /** Read one entry; an error while reading it skips that entry with the error as its problem (see the header). */
  const guard = (where, read) => {
    try { read(); } catch (e) { skipped.push({ where, problems: [`could not be read: ${String(e?.message || e).slice(0, 200)}`] }); }
  };

  // single-file language packs: public/i18n/<code>.json
  const uiDir = path.join(publicDir, LANG_DIR);
  for (const name of readDirSorted(uiDir)) {
    if (!name.endsWith('.json')) continue;
    const where = `public/${LANG_DIR}/${name}`;
    guard(where, () => readLangFile(name, where));
  }

  /** One single-file language pack. @param {string} name @param {string} where */
  function readLangFile(name, where) {
    const code = name.slice(0, -5);
    if (!isLangCode(code)) { skipped.push({ where, problems: [`"${code}" is not a language code in its usual case (en, ja, zh-TW, pt-BR …)`] }); return; }
    if (code === SOURCE_LANG) { skipped.push({ where, problems: ['"zh" is the source language (the msgids), never a pack'] }); return; }
    const abs = path.join(uiDir, name);
    const r = readJson(abs);
    if (r.error) { skipped.push({ where, problems: [r.error] }); return; }
    if (!r.json || typeof r.json !== 'object' || Array.isArray(r.json)) { skipped.push({ where, problems: ['not a JSON object of msgid → translation'] }); return; }
    const { manifest, problems, warnings: w } = normalizeManifest(r.json._meta, { id: code, type: 'lang', lang: code, app });
    warn(where, w);
    if (!manifest) { skipped.push({ where, problems }); return; }
    /** @type {Record<string, PackFile>} */
    const files = { ui: { rel: name, abs, url: `/${LANG_DIR}/${name}` } };
    const dataAbs = path.join(dataDir, LANG_DIR, name);
    if (isFile(dataAbs)) files.data = { rel: name, abs: dataAbs, url: `/data/${LANG_DIR}/${name}` };
    found.push({ id: code, type: 'lang', class: 'lang', status: 'loaded', source: 'i18n', layout: 'file', where, supported: true, manifest, files, strings: countStrings(r.json) });
  }

  // folder packs: packs/<id>/pack.json (manifest 1)
  for (const id of readDirSorted(packsDir)) {
    const dir = path.join(packsDir, id);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const where = `packs/${id}/`;
    guard(where, () => readPackFolder(id, dir, where));
  }

  /** One pack folder. @param {string} id @param {string} dir @param {string} where */
  function readPackFolder(id, dir, where) {
    const man = path.join(dir, PACK_MANIFEST);
    if (!isFile(man)) {
      const hint = isFile(path.join(dir, PLUGIN_MANIFEST)) ? ` (${PLUGIN_MANIFEST} belongs in plugins/${id}/)` : '';
      skipped.push({ where, problems: [`no ${PACK_MANIFEST}${hint}`] });
      return;
    }
    const r = readJson(man);
    if (r.error) { skipped.push({ where, problems: [`${PACK_MANIFEST}: ${r.error}`] }); return; }
    const { manifest, problems, warnings: w } = normalizeManifest(r.json, { id, folder: true, app });
    warn(where, w);
    if (!manifest) { skipped.push({ where, problems }); return; }
    const kind = PACK_TYPES[manifest.type];
    if (kind.status !== 'supported') {
      skipped.push({ where, problems: [`type "${manifest.type}" is planned (${kind.summary}), not loaded by this version — its successor is a ${kind.class} plugin (plugins/<id>/${PLUGIN_MANIFEST}, docs/PLUGINS.md)`] });
      return;
    }
    /** @type {Record<string, PackFile>} */
    const files = {};
    const missing = [];
    for (const [role, rel] of Object.entries(manifest.files)) {
      const abs = path.join(dir, ...rel.split('/'));
      if (!isFile(abs)) missing.push(`files.${role}: ${rel} is missing`);
      else if (!inside(dir, abs)) missing.push(`files.${role}: ${rel} leads out of the pack folder`);
      else files[role] = { rel, abs, url: fileUrl(id, rel) };
    }
    if (missing.length) { skipped.push({ where, problems: missing }); return; }
    /** @type {Plugin} */
    const pack = { id, type: manifest.type, class: manifest.class, status: 'loaded', source: 'packs', layout: 'folder', where, supported: true, manifest, files };
    if (manifest.type === 'lang') {
      const ui = readJson(files.ui.abs);
      if (ui.error || !ui.json || typeof ui.json !== 'object' || Array.isArray(ui.json)) {
        skipped.push({ where, problems: [`files.ui: ${ui.error || 'not a JSON object of msgid → translation'}`] });
        return;
      }
      pack.strings = countStrings(ui.json);
    }
    found.push(pack);
  }

  // plugin folders: plugins/<id>/plugin.json (manifest 2)
  if (pluginsDir) {
    for (const id of readDirSorted(pluginsDir)) {
      if (id.startsWith('_')) continue; // the templates
      const dir = path.join(pluginsDir, id);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const where = `plugins/${id}/`;
      guard(where, () => {
        const r = readPluginFolder(dir, { app, api, where, vanilla: getArt, hashCache });
        warn(where, r.warnings);
        if (!r.plugin) skipped.push({ where, problems: r.problems });
        else found.push(r.plugin);
      });
    }
  }

  // one entry per id (any case: one folder on Windows / macOS) and per language; the language folders' files first,
  // then packs/, then plugins/
  const plugins = [];
  const ids = new Map();
  const langs = new Map();
  for (const p of found) {
    const idKey = p.id.toLowerCase();
    if (ids.has(idKey)) { skipped.push({ where: p.where, problems: [`the id "${p.id}" is taken by ${ids.get(idKey)}`] }); continue; }
    if (p.class === 'lang' && langs.has(p.manifest.lang)) {
      skipped.push({ where: p.where, problems: [`the language ${p.manifest.lang} is already provided by ${langs.get(p.manifest.lang)}`] });
      continue;
    }
    ids.set(idKey, p.where);
    if (p.class === 'lang') langs.set(p.manifest.lang, p.where);
    plugins.push(p);
  }
  // what a plugin requires: installed, in its range (P1c refuses to enable it otherwise; here a warning)
  const byId = new Map(plugins.map((p) => [p.id, p]));
  for (const p of plugins) {
    for (const [dep, range] of Object.entries(p.manifest.requires)) {
      const d = byId.get(dep);
      if (!d) warn(p.where, [`requires "${dep}" ${range}, which is not installed`]);
      else if (!appVersionMatches(range, d.manifest.version)) warn(p.where, [`requires "${dep}" ${range}; the installed one is ${d.manifest.version || 'unversioned'}`]);
    }
  }
  return { plugins, skipped, warnings, vanilla: art };
}

/**
 * The language-pack view of a scan (0.2.0's server/packs.js scanPacks): the loaded entries — the lang class — and what
 * was skipped. A valid plugin of another class is neither (tools/plugin.mjs lists it).
 * @param {PluginDirs} dirs
 * @param {{ app?: string }} [opts]
 * @returns {{ packs: Pack[], skipped: Skipped[], warnings: { where: string, warning: string }[] }}
 */
export function scanPacks(dirs, { app = APP_VERSION } = {}) {
  const { plugins, skipped, warnings } = scanPlugins(dirs, { app });
  return { packs: plugins.filter((p) => p.supported), skipped, warnings };
}

/**
 * The index body of scanned packs (shared/packs.js buildPackIndex): the loaded language entries.
 * @param {Pack[]} packs
 * @param {{ app?: string }} [opts]
 */
export function packIndexOf(packs, { app = APP_VERSION } = {}) {
  const entries = packs.filter((p) => p.supported).map((p) => packIndexEntry(p.manifest, {
    files: Object.fromEntries(Object.entries(p.files).map(([role, f]) => [role, f.url])),
    strings: p.strings,
  }));
  return buildPackIndex(entries, { app });
}

/**
 * The catalogue body of scanned plugins (GET /plugins/index.json; shared/plugins/manifest.js buildPluginIndex).
 * @param {Plugin[]} plugins
 * @param {{ app?: string, vanilla?: string | null }} [opts] vanilla: this server's vanilla content hash
 */
export function pluginIndexOf(plugins, { app = APP_VERSION, vanilla = null } = {}) {
  return buildPluginIndex(plugins, { app, vanilla });
}

/** What changes when a pack or plugin is added, removed or edited: names, sizes and times of the files the scan reads. */
function signature({ publicDir, dataDir, packsDir, pluginsDir }) {
  const parts = [];
  const add = (dir, depth, tag, namesOnly = false) => {
    for (const n of readDirSorted(dir)) {
      const abs = path.join(dir, n);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (depth > 0) { parts.push(`${tag}${n}/`); add(abs, depth - 1, `${tag}${n}/`); }
        continue;
      }
      parts.push(namesOnly ? `${tag}${n}` : `${tag}${n}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  add(path.join(publicDir, LANG_DIR), 0, 'u:');
  add(path.join(dataDir, LANG_DIR), 0, 'd:', true); // a game-text file only counts by its presence
  add(packsDir, 3, 'p:');
  // a cosmetic plugin's art sits deeper (spine/<model>/front/…): six levels below plugins/
  if (pluginsDir) add(pluginsDir, 6, 'x:');
  return parts.join('\n');
}

/**
 * The registry: the scan, re-done when the folders change (see the header).
 * @param {PluginDirs} dirs
 * @param {{ log?: { info: Function, warn: Function }, app?: string, recheckMs?: number }} [opts]
 *   recheckMs: how long a scan stays trusted before the folders are looked at again (default 1000; 0 = every call)
 */
export function createPluginRegistry(dirs, { log = { info: noop, warn: noop }, app = APP_VERSION, recheckMs = 1000 } = {}) {
  let sig = null;
  let checkedAt = -Infinity;
  /** @type {ReturnType<typeof scanPlugins> & { packs: Plugin[], index: ReturnType<typeof packIndexOf>, byId: Map<string, Plugin> }} */
  let state = null;
  /** @type {HashCache} the file hashes of the cosmetic plugins, kept across scans (an unchanged file is never read again) */
  const hashCache = new Map();
  const artCache = new Map();
  const told = new Set();
  const tell = (fn, line) => { if (!told.has(line)) { told.add(line); fn(line); } };
  const tag = (where) => (where.startsWith('plugins/') ? '[plugins]' : '[packs]');

  function refresh(force = false) {
    const now = Date.now();
    if (state && !force && now - checkedAt < recheckMs) return state;
    checkedAt = now;
    const s = signature(dirs);
    if (state && s === sig) return state;
    const first = !state;
    const scan = scanPlugins(dirs, { app, hashCache, artCache });
    // the hashes of a plugin that is gone (removed, or now skipped) are forgotten
    const kept = scan.plugins.filter((p) => p.visual).map((p) => p.visual.dir + path.sep);
    for (const abs of [...hashCache.keys()]) if (!kept.some((d) => abs.startsWith(d))) hashCache.delete(abs);
    sig = s; // after the scan: a scan that throws is tried again on the next look
    const packs = scan.plugins.filter((p) => p.supported);
    state = { ...scan, packs, index: packIndexOf(packs, { app }), byId: new Map(scan.plugins.map((p) => [p.id, p])) };
    const line = `[packs] ${packs.length ? packs.map((p) => `${p.type} ${p.type === 'lang' ? p.manifest.lang : p.id} (${p.manifest.name})`).join(', ') : 'none'}`;
    if (first || packs.length) tell((m) => log.info(m), line);
    const plugins = scan.plugins.filter((p) => p.source === 'plugins');
    if (plugins.length) tell((m) => log.info(m), `[plugins] ${plugins.map((p) => `${p.id} ${p.manifest.version} (${p.class}, ${p.status})`).join(', ')}`);
    for (const k of scan.skipped) tell((m) => log.warn(m), `${tag(k.where)} ${k.where} skipped: ${k.problems.join('; ')}`);
    for (const w of scan.warnings) tell((m) => log.warn(m), `${tag(w.where)} ${w.where}: ${w.warning}`);
    return state;
  }

  return {
    /** Re-read the folders now if they changed (force: even within recheckMs). */
    refresh: (force = false) => { refresh(force); },
    /**
     * Re-read the folders now even when their names, sizes and times look unchanged: a served file was found changed
     * (server/http/static.js /p/), deeper than the signature looks or within a second of the last look.
     */
    rescan: () => { sig = null; refresh(true); },
    /** The entry of an id (any class, any status), or null. @param {string} id @returns {Plugin | null} */
    plugin: (id) => refresh().byId.get(id) || null,
    /** The installation's art manifest (VanillaAssets): the one the last scan read, else read now (kept by size + mtime). */
    vanillaAssets: () => refresh().vanilla || readVanillaAssets(dirs.dataDir, artCache),
    /** The loaded language entries, optionally of one manifest 1 type. @param {string} [type] @returns {Plugin[]} */
    list: (type) => refresh().packs.filter((p) => !type || p.type === type),
    /** Every plugin and pack found, optionally of one class. @param {string} [cls] @returns {Plugin[]} */
    plugins: (cls) => refresh().plugins.filter((p) => !cls || p.class === cls),
    /** The language-pack index body (GET /packs/index.json). */
    index: () => refresh().index,
    /**
     * The catalogue body (GET /plugins/index.json).
     * @param {{ vanilla?: string | null }} [opts] vanilla: the server's vanilla content hash
     */
    pluginIndex: ({ vanilla = null } = {}) => pluginIndexOf(refresh().plugins, { app, vanilla }),
    /** Packs and plugins that were not loaded and why, and the warnings of the loaded ones. */
    report: () => { const s = refresh(); return { skipped: s.skipped, warnings: s.warnings }; },
    /**
     * The file behind /packs/<id>/<rel>, or null: only a file a loaded lang folder (pack or plugin) names.
     * @param {string} id
     * @param {string} rel
     */
    servable(id, rel) {
      const p = refresh().byId.get(id);
      if (!p || !p.supported || p.layout !== 'folder') return null;
      for (const f of Object.values(p.files)) if (f.rel === rel) return f.abs;
      return null;
    },
    /**
     * A file of a loaded cosmetic plugin that its overlay names (served at /p/<id>/<hash8>/<rel>), with its plugin folder,
     * or null — the only files of plugins/ ever served beside a lang plugin's.
     * @param {string} id
     * @param {string} rel
     * @returns {(ServedFile & { dir: string }) | null}
     */
    pluginFile(id, rel) {
      const p = refresh().byId.get(id);
      const f = p && p.status === 'loaded' && p.visual ? p.visual.served.get(rel) : null;
      return f ? { ...f, dir: p.visual.dir } : null;
    },
  };
}

/** The pack registry of 0.2.0 (server/packs.js): the same object; it reads plugins/ when `dirs.pluginsDir` is given. */
export const createPackRegistry = createPluginRegistry;
