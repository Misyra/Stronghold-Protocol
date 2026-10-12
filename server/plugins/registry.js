// server/plugins/registry.js — this server's plugins and language packs (DESIGN §31, docs/PLUGINS.md; the formats:
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
//     manifest.js buildPluginIndex; the vanilla content hash beside it — server/plugins/identity.js).
// In this version only the lang class loads. A cosmetic or content plugin is validated and listed as `planned` (P1: the
// art and data plugins, not applied yet); a script, ui or trusted one is listed as `unsupported` and never loaded (no
// third-party code runs — the owner's decision of 2026-10-12). Nothing of a plugin folder is served yet.
// A broken manifest, a file the class may not carry, a second entry with an id (any case: one folder on Windows /
// macOS) or a language already taken: reported (`skipped`: the start log, `node tools/plugin.mjs list`), never listed.
// The folders are re-read when something in them changes (checked when the index or a pack file is asked for, at most
// once a second: a few stat calls), so a language pack or a plugin dropped in shows on the next page load — no restart.
// server/packs.js re-exports the pack API of this file for its old callers.

import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, PLUGIN_API } from '../../shared/constants.js';
import { PACK_TYPES, PACK_MANIFEST, PACKS_URL, normalizeManifest, packIndexEntry, buildPackIndex } from '../../shared/packs.js';
import { SOURCE_LANG, isLangCode, countStrings } from '../../shared/i18nPacks.js';
import {
  PLUGIN_MANIFEST, PLUGIN_LIMITS, appVersionMatches, buildPluginIndex, checkPluginFiles, classStatus, declaredPaths, readPluginManifest,
} from '../../shared/plugins/manifest.js';

/** The language folders' subdirectory (public/i18n/, data/i18n/). */
export const LANG_DIR = 'i18n';
/** Largest manifest / UI file read (bytes): a pack file is small text. */
const MAX_JSON_BYTES = PLUGIN_LIMITS.jsonBytes;
const noop = () => {};

/**
 * @typedef {{ rel: string, abs: string, url: string }} PackFile
 * @typedef {import('../../shared/plugins/manifest.js').PluginManifest} PluginManifest
 * @typedef {{ id: string, type: string, class: string, status: 'loaded' | 'planned' | 'unsupported', source: 'i18n' | 'packs' | 'plugins',
 *   layout: 'file' | 'folder', where: string, supported: boolean, manifest: PluginManifest, files: Record<string, PackFile>,
 *   strings?: number, bytes?: number, count?: number }} Plugin
 *   One entry of the registry. type: the manifest 1 type (lang, assets, data …); status: what this version does with
 *   it; supported: loaded (the language entries of 0.2.0's pack registry); files: a lang entry's files with their URLs.
 * @typedef {Plugin} Pack an entry of the language-pack view (scanPacks)
 * @typedef {{ where: string, problems: string[] }} Skipped
 * @typedef {{ publicDir: string, dataDir: string, packsDir: string, pluginsDir?: string }} PluginDirs
 *   pluginsDir: the plugin folders (none: plugins/ is not read — the pack view of 0.2.0's callers)
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
 * Read one plugin folder: its manifest, its files, the paths the manifest names. With `problems` it stays out
 * (`plugin` null); otherwise `plugin` is its entry.
 * @param {string} dir the folder (its name is the id)
 * @param {{ app?: string, api?: { current: number, min: number }, where?: string }} [opts]
 * @returns {{ plugin: Plugin | null, problems: string[], warnings: string[] }}
 */
export function readPluginFolder(dir, { app = APP_VERSION, api = PLUGIN_API, where } = {}) {
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
    id, type: manifest.type, class: manifest.class, status, source: 'plugins', layout: 'folder', where: at, supported: status === 'loaded',
    manifest, files: served, bytes: check.bytes, count: check.count,
  };
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
 * @param {{ app?: string, api?: { current: number, min: number } }} [opts]
 * @returns {{ plugins: Plugin[], skipped: Skipped[], warnings: { where: string, warning: string }[] }}
 */
export function scanPlugins({ publicDir, dataDir, packsDir, pluginsDir }, { app = APP_VERSION, api = PLUGIN_API } = {}) {
  /** @type {Plugin[]} */
  const found = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const warnings = [];
  const warn = (where, list) => { for (const w of list) warnings.push({ where, warning: w }); };

  // single-file language packs: public/i18n/<code>.json
  const uiDir = path.join(publicDir, LANG_DIR);
  for (const name of readDirSorted(uiDir)) {
    if (!name.endsWith('.json')) continue;
    const code = name.slice(0, -5);
    const where = `public/${LANG_DIR}/${name}`;
    if (!isLangCode(code)) { skipped.push({ where, problems: [`"${code}" is not a language code in its usual case (en, ja, zh-TW, pt-BR …)`] }); continue; }
    if (code === SOURCE_LANG) { skipped.push({ where, problems: ['"zh" is the source language (the msgids), never a pack'] }); continue; }
    const abs = path.join(uiDir, name);
    const r = readJson(abs);
    if (r.error) { skipped.push({ where, problems: [r.error] }); continue; }
    if (!r.json || typeof r.json !== 'object' || Array.isArray(r.json)) { skipped.push({ where, problems: ['not a JSON object of msgid → translation'] }); continue; }
    const { manifest, problems, warnings: w } = normalizeManifest(r.json._meta, { id: code, type: 'lang', lang: code, app });
    warn(where, w);
    if (!manifest) { skipped.push({ where, problems }); continue; }
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
    const man = path.join(dir, PACK_MANIFEST);
    if (!isFile(man)) {
      const hint = isFile(path.join(dir, PLUGIN_MANIFEST)) ? ` (${PLUGIN_MANIFEST} belongs in plugins/${id}/)` : '';
      skipped.push({ where, problems: [`no ${PACK_MANIFEST}${hint}`] });
      continue;
    }
    const r = readJson(man);
    if (r.error) { skipped.push({ where, problems: [`${PACK_MANIFEST}: ${r.error}`] }); continue; }
    const { manifest, problems, warnings: w } = normalizeManifest(r.json, { id, folder: true, app });
    warn(where, w);
    if (!manifest) { skipped.push({ where, problems }); continue; }
    const kind = PACK_TYPES[manifest.type];
    if (kind.status !== 'supported') {
      skipped.push({ where, problems: [`type "${manifest.type}" is planned (${kind.summary}), not loaded by this version — its successor is a ${kind.class} plugin (plugins/<id>/${PLUGIN_MANIFEST}, docs/PLUGINS.md)`] });
      continue;
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
    if (missing.length) { skipped.push({ where, problems: missing }); continue; }
    /** @type {Plugin} */
    const pack = { id, type: manifest.type, class: manifest.class, status: 'loaded', source: 'packs', layout: 'folder', where, supported: true, manifest, files };
    if (manifest.type === 'lang') {
      const ui = readJson(files.ui.abs);
      if (ui.error || !ui.json || typeof ui.json !== 'object' || Array.isArray(ui.json)) {
        skipped.push({ where, problems: [`files.ui: ${ui.error || 'not a JSON object of msgid → translation'}`] });
        continue;
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
      const r = readPluginFolder(dir, { app, api, where });
      warn(where, r.warnings);
      if (!r.plugin) { skipped.push({ where, problems: r.problems }); continue; }
      found.push(r.plugin);
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
  return { plugins, skipped, warnings };
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
  if (pluginsDir) add(pluginsDir, 3, 'x:');
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
    sig = s;
    const scan = scanPlugins(dirs, { app });
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
  };
}

/** The pack registry of 0.2.0 (server/packs.js): the same object; it reads plugins/ when `dirs.pluginsDir` is given. */
export const createPackRegistry = createPluginRegistry;
