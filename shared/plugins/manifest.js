// shared/plugins/manifest.js — the plugin manifest (DESIGN §32, docs/PLUGINS.md; the design study's §4): one format
// for everything a server picks up from a folder — language packs, art and data plugins, and later code. No Node
// builtin: the server's registry (server/plugins/registry.js), the tools (tools/plugin.mjs, tools/packs.mjs) and the
// browser share it. shared/packs.js keeps the language-pack index on top of it.
//
// Two manifest versions:
//   manifest 1   packs/<id>/pack.json, or the `_meta` block of public/i18n/<code>.json — the content packs of 0.2.0,
//                read as they always were (readPackManifest): type "lang" loads; "assets" and "data" were planned
//                types and stay unloaded (their successors are the classes cosmetic and content below)
//   manifest 2   plugins/<id>/plugin.json, `"manifest": 2` (readPluginManifest), any class
//
// Classes (PLUGIN_CLASSES; `status` says what this version does with one):
//   lang       a language: UI strings and, optionally, game texts             loaded (as the language packs always were)
//   cosmetic   art, models, audio (the asset overlay: shared/plugins/visual.js) loaded (P1a): the room's host switches
//                                                                            it on for the room, a player for themself
//   content    data patches and new records: operators, enemies, waves …    planned (P1b): validated, listed, not applied
//   script     code the battle or the match runs                             unsupported: listed, never loaded
//   ui         interface widgets in a sandboxed frame                        loaded (P4): personal, read-only postMessage,
//                                                                            never a match intent (shared/plugins/ui.js)
//   trusted    page or server code with full trust                           unsupported
// No sim or server code from a plugin runs (the owner's decision of 2026-10-12). A ui plugin's page (P4, DESIGN §32.8)
// runs only inside the sandboxed frame and cannot send a match intent. Everything but `lang` is marked unofficial
// wherever it is shown: the original content stays the default.
//
// Manifest 2 (plugin.json; `problems` keep a plugin out, `warnings` do not):
//   manifest     2 (required)
//   id           the folder name decides: ^[a-z0-9][a-z0-9-]{1,31}$ (stricter than a pack id: it becomes part of record
//                ids; lower case only, for case-insensitive file systems); a different `id` in the file is a warning
//   name, description   a string (in `sourceLang`) or { <lang>: text }; englishName  a string
//   version      semver (required);  app  the game versions it is made for, a range (required but for lang)
//   api          the plugin API level, an integer within PLUGIN_API (shared/constants.js; required but for lang)
//   class        one of the classes above (required); every part the manifest names must belong to it
//   scope        ["room"] | ["personal"] | ["room","personal"] | ["server"], as the class allows (default: the class's)
//   authors, credits, license, homepage (http/https), sourceLang (default zh)
//   requires, optional, conflicts   { "<plugin id>": "<version range>" };  loadAfter, loadBefore  [ids];  priority  int
//   settings     { <key>: { type: boolean|integer|number|enum, default?, min/max/step (integer, number: min and max
//                required), options (enum), label } } — ≤ 32, no free text
//   permissions  what the plugin does (PERMISSIONS); each part needs one, each permission must fit the class
//   parts        assets, theme (cosmetic, content+) · data, operators, enemies, modes, stages, dsl (content+) — a path,
//                a list of paths or (assets, theme) the object inline · i18n { <lang>: path } (content+) — paths are
//                inside the folder (isPackPath) and .json, the files an inline `assets` names are art, models, audio
//                or fonts
//   entry        { sim, meta } (script, .js) · { client } (ui: .html, required) · { server } (trusted, .js)
//   slots        ui only: hud.right, result.tab, stats.tab, room.panel (UI_SLOT_IDS). Absent or []: a warning, the
//                plugin still loads but the host grants no slot. A bad list, or slots on another class: a problem.
//   lang class   the language fields of manifest 1 (lang, base, fallback, complete, machineTranslated, numberUnits —
//                shared/i18nPacks.js) and files { ui (required), data }, both .json
//
// Files (checkPluginFiles, the design study's §4.10): by class, images .png .jpg .webp (no SVG), Spine .skel .atlas, audio
// .mp3 .ogg, fonts .woff2, data .json, code .js (script, trusted), frames .html .js .css .png (ui, under its client's
// folder); documents (.md, .txt, README / LICENSE / NOTICE …) may sit beside them and are never served; nothing else.
// PLUGIN_LIMITS: 8 MB per JSON file, nesting ≤ 64, numbers finite within ±1e9, 200 MB and 5000 files per plugin
// [ASSUMED — every limit].

import { APP_VERSION, PLUGIN_API } from '../constants.js';
import { SOURCE_LANG, canonicalLang, isLangCode, languageName, langFields } from '../i18nPacks.js';

/** A plugin folder's manifest file (manifest 2). */
export const PLUGIN_MANIFEST = 'plugin.json';
/** A pack folder's manifest file (manifest 1, packs/<id>/). */
export const PACK_MANIFEST = 'pack.json';
/** The format of GET /plugins/index.json. */
export const PLUGIN_INDEX_VERSION = 1;
/** Where the plugin catalogue is served (server/http/static.js). */
export const PLUGINS_URL = '/plugins/';

/** [ASSUMED] limits (see the header). */
export const PLUGIN_LIMITS = Object.freeze({
  jsonBytes: 8 * 1024 * 1024,
  jsonDepth: 64,
  number: 1e9,
  pluginBytes: 200 * 1024 * 1024,
  files: 5000,
  settings: 32,
  options: 32,
  deps: 32,
});

/**
 * @typedef {'supported' | 'planned' | 'unsupported'} ClassStatus
 * @typedef {{ status: ClassStatus, summary: string, scopes: string[], defaultScope: string[], unofficial: boolean,
 *   packType: string, ext: string[] }} PluginClass
 */

const IMAGE = ['.png', '.jpg', '.webp'];
const SPINE = ['.skel', '.atlas'];
const AUDIO = ['.mp3', '.ogg'];
const FONT = ['.woff2'];
/** The image files a cosmetic plugin's overlay names (shared/plugins/visual.js). */
export const PLUGIN_IMAGE_EXTS = Object.freeze([...IMAGE]);
/**
 * The audio files a cosmetic plugin's overlay names — also fetched without the extension (server/http/static.js,
 * public/js/media.js: here, so the page's audio code needs nothing more of the plugin system at start).
 */
export const PLUGIN_AUDIO_EXTS = Object.freeze([...AUDIO]);
/** The extensions an `assets` entry may name. */
export const ASSET_EXT = Object.freeze([...IMAGE, ...SPINE, ...AUDIO, ...FONT]);
const MEDIA = ['.json', ...ASSET_EXT];

/** @type {Readonly<Record<string, Readonly<PluginClass>>>} the classes, in display order (see the header) */
export const PLUGIN_CLASSES = Object.freeze({
  lang: Object.freeze({ status: 'supported', summary: 'a language: UI strings and, optionally, game texts', scopes: ['personal'], defaultScope: ['personal'], unofficial: false, packType: 'lang', ext: ['.json'] }),
  cosmetic: Object.freeze({ status: 'supported', summary: 'art, models and audio: the room\'s host switches it on for the room, a player for themself (P1a)', scopes: ['room', 'personal'], defaultScope: ['room', 'personal'], unofficial: true, packType: 'assets', ext: MEDIA }),
  content: Object.freeze({ status: 'planned', summary: 'data patches and new records: operators, enemies, waves, modes (P1b)', scopes: ['room'], defaultScope: ['room'], unofficial: true, packType: 'data', ext: MEDIA }),
  script: Object.freeze({ status: 'unsupported', summary: 'code the battle or the match runs (never loaded by this version)', scopes: ['room'], defaultScope: ['room'], unofficial: true, packType: 'script', ext: [...MEDIA, '.js'] }),
  ui: Object.freeze({ status: 'supported', summary: 'interface widgets in a sandboxed frame (P4): read-only, personal, cannot send a match intent', scopes: ['personal'], defaultScope: ['personal'], unofficial: true, packType: 'ui', ext: ['.json', '.html', '.js', '.css', '.png'] }),
  trusted: Object.freeze({ status: 'unsupported', summary: 'page or server code with full trust (never loaded by this version)', scopes: ['server', 'room'], defaultScope: ['server'], unofficial: true, packType: 'trusted', ext: [...MEDIA, '.js', '.html', '.css'] }),
});

/**
 * @typedef {{ required?: boolean, ext: string[] }} FileRole a role of a folder pack's `files`
 * @typedef {{ status: 'supported' | 'planned', summary: string, live?: boolean, files?: Record<string, FileRole>,
 *   class: string }} PackType
 *   live: a server picks up its changes without a restart (lang: the client loads packs on demand). files: the roles a
 *   folder pack of the type names, with the extensions a server may serve for them (nothing else is ever served)
 */

/** @type {Readonly<Record<string, Readonly<PackType>>>} the types of manifest 1 (docs/PACKS.md); `class`: the manifest 2 class */
export const PACK_TYPES = Object.freeze({
  lang: Object.freeze({
    status: 'supported', live: true, summary: 'a language: UI strings and, optionally, game texts', class: 'lang',
    files: Object.freeze({ ui: Object.freeze({ required: true, ext: ['.json'] }), data: Object.freeze({ ext: ['.json'] }) }),
  }),
  assets: Object.freeze({ status: 'planned', summary: 'art, audio and font replacements, client side', class: 'cosmetic' }),
  data: Object.freeze({ status: 'planned', summary: 'data patches the server applies at start', class: 'content' }),
});

/** Permissions a manifest 2 may declare, with the classes that may hold each. */
export const PERMISSIONS = Object.freeze({
  'assets.override': ['cosmetic', 'content', 'script', 'trusted'],
  'assets.add': ['cosmetic', 'content', 'script', 'trusted'],
  theme: ['cosmetic', 'trusted'],
  'data.patch': ['content', 'script', 'trusted'],
  'data.add': ['content', 'script', 'trusted'],
  dsl: ['content', 'script', 'trusted'],
  'sim.code': ['script', 'trusted'],
  'meta.code': ['script', 'trusted'],
  'mode.code': ['script', 'trusted'],
  'ui.frame': ['ui'],
  'trusted.page': ['trusted'],
  'trusted.server': ['trusted'],
});

/**
 * The parts of manifest 2: the classes that may carry each, how it is written, the permissions one of which it needs.
 * shape: 'inline' — a path to a .json file or the object inline; 'list' — a .json path or a list of them; 'langs' —
 * { <lang>: .json path }.
 */
const PARTS = Object.freeze({
  assets: { classes: ['cosmetic', 'content', 'script', 'trusted'], shape: 'inline', needs: ['assets.override', 'assets.add'] },
  theme: { classes: ['cosmetic', 'trusted'], shape: 'inline', needs: ['theme'] },
  data: { classes: ['content', 'script', 'trusted'], shape: 'list', needs: ['data.patch', 'data.add'] },
  operators: { classes: ['content', 'script', 'trusted'], shape: 'list', needs: ['data.add'] },
  enemies: { classes: ['content', 'script', 'trusted'], shape: 'list', needs: ['data.add'] },
  modes: { classes: ['content', 'script', 'trusted'], shape: 'list', needs: ['data.add'] },
  stages: { classes: ['content', 'script', 'trusted'], shape: 'list', needs: ['data.add'] },
  dsl: { classes: ['content', 'script', 'trusted'], shape: 'list', needs: ['dsl'] },
  i18n: { classes: ['content', 'script', 'trusted'], shape: 'langs', needs: [] },
});

/** `entry` keys: the classes that may have each, its extension, the permission it needs per class. */
const ENTRIES = Object.freeze({
  sim: { classes: ['script', 'trusted'], ext: '.js', needs: { script: 'sim.code', trusted: 'sim.code' } },
  meta: { classes: ['script', 'trusted'], ext: '.js', needs: { script: 'meta.code', trusted: 'meta.code' } },
  client: { classes: ['ui', 'trusted'], ext: '.html', needs: { ui: 'ui.frame', trusted: 'trusted.page' } },
  server: { classes: ['trusted'], ext: '.js', needs: { trusted: 'trusted.server' } },
});

const SETTING_TYPES = ['boolean', 'integer', 'number', 'enum'];
/** Top-level fields of manifest 2 (anything else is warned about and ignored). */
const V2_FIELDS = new Set(['$schema', 'manifest', 'id', 'name', 'englishName', 'description', 'version', 'app', 'api', 'class', 'scope',
  'authors', 'credits', 'license', 'homepage', 'sourceLang', 'requires', 'optional', 'conflicts', 'loadAfter', 'loadBefore', 'priority',
  'settings', 'permissions', 'entry', 'slots', 'files', 'lang', 'base', 'fallback', 'complete', 'machineTranslated', 'numberUnits', ...Object.keys(PARTS)]);
/** Fields only a lang plugin has. */
const LANG_ONLY = ['files', 'lang', 'base', 'fallback', 'complete', 'machineTranslated', 'numberUnits'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/**
 * A value quoted in a problem or warning, at most 40 characters. Never throws: JSON.parse reads nesting that
 * JSON.stringify cannot write back (a stack overflow), so such a value is named by its kind.
 */
const short = (v) => {
  try { return String(JSON.stringify(typeof v === 'string' && v.length > 40 ? v.slice(0, 40) : v)).slice(0, 40); } catch { return Array.isArray(v) ? '[…]' : v && typeof v === 'object' ? '{…}' : typeof v; }
};

/** A pack id (manifest 1): letters, digits, '.', '_', '-' (not first), at most 64. @param {unknown} v */
export const isPackId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);

/** A plugin id (manifest 2): lower-case letters, digits and '-', 2–32, not starting with '-'. @param {unknown} v */
export const isPluginId = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,31}$/.test(v);

/**
 * The slots a ui plugin may ask the host for (DESIGN §32.8). [ASSUMED] these four; the host mounts at most one plugin
 * in each (shared/plugins/ui.js).
 */
export const UI_SLOT_IDS = Object.freeze(['hud.right', 'result.tab', 'stats.tab', 'room.panel']);

/**
 * A path inside a pack or plugin folder ('ui.json', 'img/a.png'): relative, '/'-separated, no '.' / '..' / hidden /
 * empty segment, plain characters only.
 * @param {unknown} rel
 */
export const isPackPath = (rel) => typeof rel === 'string' && rel.length <= 200 && /^[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/.test(rel)
  && rel.split('/').every((s) => s.trim() === s && s && !s.startsWith('.'));

/** The lower-case extension of a path ('.json'), or ''. @param {string} rel */
export const extOf = (rel) => { const m = /\.[A-Za-z0-9]+$/.exec(rel); return m ? m[0].toLowerCase() : ''; };

/** Semantic version 2.0.0: MAJOR.MINOR.PATCH, optionally -pre and +build. @param {unknown} v */
export const isSemver = (v) => typeof v === 'string' && v.length <= 64
  && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(v);

// ---- version ranges -------------------------------------------------------------------------------------------------

/** [major, minor, patch] of a version ('0.2.0-dev' → [0, 2, 0]: a pre-release counts as its release), or null. */
const versionCore = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One comparator of a range as [op, version] bounds, or null when it is not one. */
function bounds(c) {
  if (c === '*' || c === 'x') return [];
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(c);
  if (!m) return null;
  const [, op = '', a, b, d] = m;
  const wild = (s) => s === undefined || /^[xX*]$/.test(s);
  const M = Number(a);
  const N = wild(b) ? 0 : Number(b);
  const P = wild(d) ? 0 : Number(d);
  const partial = wild(b) ? 1 : wild(d) ? 2 : 3; // how many parts were given
  const lo = [M, N, P];
  if (op === '^') return [['>=', lo], ['<', M > 0 ? [M + 1, 0, 0] : partial >= 2 ? [0, N + 1, 0] : [1, 0, 0]]];
  if (op === '~') return [['>=', lo], ['<', partial >= 2 ? [M, N + 1, 0] : [M + 1, 0, 0]]];
  if (op === '' || op === '=') {
    if (partial === 3) return [['=', lo]];
    return [['>=', lo], ['<', partial === 2 ? [M, N + 1, 0] : [M + 1, 0, 0]]];
  }
  return [[op, lo]];
}

/** Whether `range` is a version range this file understands (an empty one is). @param {unknown} range */
export function isVersionRange(range) {
  const r = String(range ?? '').trim();
  if (!r) return true;
  return r.split('||').every((alt) => alt.trim().split(/\s+/).every((c) => bounds(c) !== null));
}

/**
 * Whether a version is in a range (">=0.2.0", ">=0.2.0 <0.3.0", "0.2.x", "^0.2.0", "~0.2.1", "*", alternatives with
 * "||"; a pre-release such as 0.2.0-dev counts as its release). An empty range, an unreadable range or version counts as
 * a match: the range is advice, the loader decides what an incompatible pack or plugin means.
 * @param {unknown} range
 * @param {unknown} [version] default: this build's APP_VERSION
 */
export function appVersionMatches(range, version = APP_VERSION) {
  const v = versionCore(version);
  const r = String(range ?? '').trim();
  if (!v || !r || !isVersionRange(r)) return true;
  return r.split('||').some((alt) => alt.trim().split(/\s+/).every((c) => bounds(c).every(([op, b]) => {
    const d = cmp(v, b);
    return op === '>=' ? d >= 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : op === '<' ? d < 0 : d === 0;
  })));
}

// ---- the normalised manifest ------------------------------------------------------------------------------------------

/**
 * @typedef {{ type: string, default: boolean | number | string, min?: number, max?: number, step?: number,
 *   options?: (string | number | boolean)[], label: Record<string, string> }} PluginSetting
 * @typedef {{ files: string[], inline?: Record<string, any>, langs?: Record<string, string> }} PluginPart
 * @typedef {{ manifest: number, id: string, class: string, type: string, name: string, englishName: string,
 *   names: Record<string, string>, description: Record<string, string>, version: string, app: string,
 *   compatible: boolean, api: number | null, scope: string[], authors: string[], credits: string, license: string,
 *   homepage: string, sourceLang: string, requires: Record<string, string>, optional: Record<string, string>,
 *   conflicts: Record<string, string>, loadAfter: string[], loadBefore: string[], priority: number,
 *   settings: Record<string, PluginSetting>, permissions: string[], parts: Record<string, PluginPart>,
 *   entry: Record<string, string>, slots: string[], files: Record<string, string>,
 *   lang?: string, base?: string | null, fallback?: string[], complete?: boolean, machineTranslated?: boolean,
 *   numberUnits?: string[] | null }} PluginManifest
 *   One shape for both versions. type: the manifest 1 type (lang, assets, data; the class name for the classes that
 *   have none). files: the lang class's role → path. parts / entry: manifest 2 (empty for manifest 1).
 * @typedef {PluginManifest} PackManifest
 * @typedef {{ manifest: PluginManifest | null, problems: string[], warnings: string[], draft?: PluginManifest }} ManifestResult
 *   draft (manifest 2): what could be read even with problems — tools/plugin.mjs checks its files too, so one run reports
 *   everything; never loaded
 */

/** The fields of manifest 2 that manifest 1 lacks, at their defaults. */
function v2Defaults(cls) {
  return {
    names: {}, description: {}, api: null, scope: [...(PLUGIN_CLASSES[cls]?.defaultScope || [])], homepage: '', sourceLang: SOURCE_LANG,
    requires: {}, optional: {}, conflicts: {}, loadAfter: [], loadBefore: [], priority: 0, settings: {}, permissions: [], parts: {}, entry: {},
    slots: [],
  };
}

/** The common authors field: a string or a list of strings (≤ 32). */
const authorsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((a) => str(a)).filter(Boolean).slice(0, 32);

/**
 * The language fields of a lang manifest (both versions), into `out` (shared/i18nPacks.js langFields).
 * @param {any} m the raw manifest
 * @param {string | undefined} fileLang a single-file pack's language code (its file name decides)
 * @param {PluginManifest} out
 * @param {string[]} problems
 * @param {string[]} warnings
 */
function readLangFields(m, fileLang, out, problems, warnings) {
  const code = fileLang || canonicalLang(m.lang);
  if (fileLang && m.lang !== undefined && canonicalLang(m.lang) !== fileLang) warnings.push(`"lang": "${m.lang}" is not its file's code ${fileLang}`);
  if (!code) problems.push(m.lang === undefined ? 'no "lang" (the language code)' : `"lang": "${m.lang}" is not a language code`);
  else if (code === SOURCE_LANG) problems.push('"zh" is the source language (the msgids), never a pack');
  else {
    if (m.lang !== undefined && !isLangCode(m.lang) && !fileLang) warnings.push(`"lang": "${m.lang}" read as ${code}`);
    Object.assign(out, langFields(code, m));
    // anything but true reads as false: say so when another value was meant
    const mt = m.machineTranslated;
    if (mt !== undefined && typeof mt !== 'boolean') warnings.push(`"machineTranslated": ${short(mt)} is not true or false (read as false)`);
    out.name ||= languageName(code);
    out.englishName ||= languageName(code, 'en');
  }
}

/**
 * The file roles of a folder's lang manifest (`files`: role → path), into `out.files`.
 * @param {any} m the raw manifest
 * @param {string} what 'a lang pack' / 'a lang plugin' (for the warnings)
 * @param {string} folder 'pack' / 'plugin' (for the problems)
 * @param {PluginManifest} out
 * @param {string[]} problems
 * @param {string[]} warnings
 * @param {boolean} [own] warn about every role that is not an own role (manifest 2); manifest 1 keeps 0.2.0's lookup,
 *   which also passes names of Object.prototype ("constructor", "toString") silently
 */
function readFileRoles(m, what, folder, out, problems, warnings, own = false) {
  const roles = PACK_TYPES.lang.files;
  const given = isObj(m.files) ? m.files : {};
  for (const [role, spec] of Object.entries(roles)) {
    const rel = given[role];
    if (rel === undefined || rel === null || rel === '') { if (spec.required) problems.push(`no "files.${role}"`); continue; }
    if (!isPackPath(rel)) problems.push(`"files.${role}": "${rel}" is not a path inside the ${folder} folder`);
    else if (!spec.ext.includes(extOf(rel))) problems.push(`"files.${role}" must be a ${spec.ext.join(' / ')} file`);
    else out.files[role] = rel;
  }
  for (const role of Object.keys(given)) if (own ? !has(roles, role) : !roles[role]) warnings.push(`"files.${role}" is not a role of ${what} (ignored)`);
}

/**
 * Read a manifest 1 (pack.json, or the `_meta` of a single-file language pack): the common fields, the type's fields,
 * a folder pack's file roles — exactly as the content packs of 0.2.0 were read (shared/packs.js normalizeManifest).
 * @param {unknown} raw pack.json, or the `_meta` of a single-file language pack (undefined: none)
 * @param {{ id: string, type?: string, lang?: string, folder?: boolean, app?: string }} ctx
 *   id: the folder name / the file's code; type: the type of the layout (a single-file language pack: 'lang');
 *   lang: a single file's language code; folder: a folder pack (its `files` are read); app: the app version
 * @returns {ManifestResult}
 */
export function readPackManifest(raw, ctx) {
  const problems = [];
  const warnings = [];
  if (raw !== undefined && !isObj(raw)) problems.push('the manifest is not a JSON object');
  const m = isObj(raw) ? /** @type {any} */ (raw) : {};
  const type = str(m.type, 20) || ctx.type || '';
  const kind = has(PACK_TYPES, type) ? PACK_TYPES[type] : null;
  if (!type) problems.push('no "type"');
  else if (!kind) problems.push(`unknown type "${type}" (known: ${Object.keys(PACK_TYPES).join(', ')})`);
  if (ctx.type && type !== ctx.type) problems.push(`"type": "${type}" where a ${ctx.type} pack belongs`);
  const id = ctx.id;
  if (!isPackId(id)) problems.push(`"${id}" is not a pack id (letters, digits, . _ -)`);
  if (m.id !== undefined && m.id !== id) warnings.push(`"id": "${m.id}" is not "${id}" (the folder or file name decides)`);
  const range = str(m.app, 60);
  if (range && !isVersionRange(range)) warnings.push(`"app": "${range}" is not a version range (">=0.2.0", "0.2.x" …)`);
  const app = ctx.app ?? APP_VERSION;
  const compatible = appVersionMatches(range, app);
  if (!compatible) warnings.push(`made for app ${range}; this is ${app}`);
  const cls = kind ? kind.class : 'lang';
  /** @type {PluginManifest} */
  const out = {
    manifest: 1, id, class: cls, type, name: str(m.name, 60), englishName: str(m.englishName, 60), version: str(m.version, 40), app: range, compatible,
    authors: authorsOf(m.authors), credits: str(m.credits, 500), license: str(m.license, 100), files: {}, ...v2Defaults(cls),
  };
  if (type === 'lang') readLangFields(m, ctx.lang, out, problems, warnings);
  out.name ||= id;
  out.englishName ||= out.name;
  if (ctx.folder && kind && kind.files) readFileRoles(m, `a ${type} pack`, 'pack', out, problems, warnings);
  return { manifest: problems.length ? null : out, problems, warnings };
}

/**
 * A text in one or more languages: a string (in `sourceLang`) or { <lang>: string }, as { <lang>: text }.
 * @param {unknown} v
 * @param {string} sourceLang
 * @param {number} max characters per text
 * @param {string} field for the warnings
 * @param {string[]} warnings
 * @returns {Record<string, string>}
 */
function localized(v, sourceLang, max, field, warnings) {
  /** @type {Record<string, string>} */
  const out = {};
  if (v === undefined || v === null) return out;
  if (typeof v === 'string') { const s = str(v, max); if (s) out[sourceLang] = s; return out; }
  if (!isObj(v)) { warnings.push(`"${field}" is neither a text nor { <lang>: text } (ignored)`); return out; }
  for (const [k, t] of Object.entries(v)) {
    const code = canonicalLang(k);
    const s = str(t, max);
    if (!code || !s) { warnings.push(`"${field}.${k}" is not a language code with a text (ignored)`); continue; }
    out[code] = s;
  }
  return out;
}

/**
 * A { <plugin id>: <version range> } map (requires / optional / conflicts).
 * @param {unknown} v @param {string} field @param {string} self the plugin's own id @param {string[]} problems
 * @returns {Record<string, string>}
 */
function depMap(v, field, self, problems) {
  /** @type {Record<string, string>} */
  const out = {};
  if (v === undefined) return out;
  if (!isObj(v)) { problems.push(`"${field}" is not { "<plugin id>": "<version range>" }`); return out; }
  const entries = Object.entries(v);
  if (entries.length > PLUGIN_LIMITS.deps) problems.push(`"${field}" names more than ${PLUGIN_LIMITS.deps} plugins`);
  for (const [id, range] of entries.slice(0, PLUGIN_LIMITS.deps)) {
    if (!isPluginId(id)) { problems.push(`"${field}": "${id}" is not a plugin id`); continue; }
    if (id === self) { problems.push(`"${field}" names the plugin itself`); continue; }
    const r = typeof range === 'string' ? range.trim() : null;
    if (r === null || r.length > 60 || !isVersionRange(r)) { problems.push(`"${field}.${id}": ${short(range)} is not a version range`); continue; }
    out[id] = r || '*';
  }
  return out;
}

/** A list of plugin ids (loadAfter / loadBefore). @param {unknown} v @param {string} field @param {string} self @param {string[]} problems */
function idList(v, field, self, problems) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > PLUGIN_LIMITS.deps) { problems.push(`"${field}" is not a list of at most ${PLUGIN_LIMITS.deps} plugin ids`); return []; }
  const out = [];
  for (const id of v) {
    if (!isPluginId(id)) problems.push(`"${field}": ${short(id)} is not a plugin id`);
    else if (id === self) problems.push(`"${field}" names the plugin itself`);
    else if (!out.includes(id)) out.push(id);
  }
  return out;
}

const isScalar = (v) => (typeof v === 'string' && v.length <= 64) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
const onGrid = (v, min, step) => step === undefined || Math.abs((v - min) / step - Math.round((v - min) / step)) < 1e-9;

/**
 * One setting definition (see the header), or null with a problem.
 * @param {string} key @param {unknown} def @param {string} sourceLang @param {string[]} problems @param {string[]} warnings
 * @returns {PluginSetting | null}
 */
function readSetting(key, def, sourceLang, problems, warnings) {
  const at = `"settings.${key}"`;
  if (!isObj(def)) { problems.push(`${at} is not a setting definition`); return null; }
  const d = /** @type {any} */ (def);
  if (!SETTING_TYPES.includes(d.type)) { problems.push(`${at}: "type" ${short(d.type)} is not one of ${SETTING_TYPES.join(', ')}`); return null; }
  for (const k of Object.keys(d)) if (!['type', 'default', 'min', 'max', 'step', 'options', 'label'].includes(k)) warnings.push(`${at}.${k} is not a setting field (ignored)`);
  const label = localized(d.label, sourceLang, 80, `settings.${key}.label`, warnings);
  if (d.type === 'boolean') {
    if (d.default !== undefined && typeof d.default !== 'boolean') { problems.push(`${at}: the default of a boolean is true or false`); return null; }
    return { type: 'boolean', default: d.default === true, label };
  }
  if (d.type === 'enum') {
    const opts = d.options;
    if (!Array.isArray(opts) || !opts.length || opts.length > PLUGIN_LIMITS.options || !opts.every(isScalar) || new Set(opts).size !== opts.length) {
      problems.push(`${at}: "options" is not a list of 1–${PLUGIN_LIMITS.options} different texts (≤ 64 characters), numbers or booleans`);
      return null;
    }
    if (d.default !== undefined && !opts.includes(d.default)) { problems.push(`${at}: the default is not one of its options`); return null; }
    return { type: 'enum', default: d.default === undefined ? opts[0] : d.default, options: [...opts], label };
  }
  const int = d.type === 'integer';
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= PLUGIN_LIMITS.number && (!int || Number.isInteger(v));
  if (!num(d.min) || !num(d.max) || d.min > d.max) { problems.push(`${at}: an ${d.type} needs "min" ≤ "max" (${int ? 'integers' : 'finite numbers'} within ±${PLUGIN_LIMITS.number})`); return null; }
  if (d.step !== undefined && !(num(d.step) && d.step > 0)) { problems.push(`${at}: "step" must be a positive ${int ? 'integer' : 'number'}`); return null; }
  const dflt = d.default === undefined ? d.min : d.default;
  if (!num(dflt) || dflt < d.min || dflt > d.max || !onGrid(dflt, d.min, d.step)) { problems.push(`${at}: the default is not a value between min and max${d.step !== undefined ? ' on its step' : ''}`); return null; }
  /** @type {PluginSetting} */
  const out = { type: d.type, default: dflt, min: d.min, max: d.max, label };
  if (d.step !== undefined) out.step = d.step;
  return out;
}

/**
 * The files an inline `assets` object names: every string ending in a file extension (a dot, a letter, up to 7 more
 * letters or digits — '1.5' is no file), but a `ref` (a record of the installation's own manifest). The manifest checks
 * the paths; the shape of the asset entries, the files of an `assets` .json file and the references are checked by
 * shared/plugins/visual.js readAssetOverlay (the registry, for a cosmetic plugin).
 * @param {unknown} v
 * @returns {{ path: string, value: string }[]}
 */
function inlineAssetFiles(v) {
  const out = [];
  const stack = [{ v, path: 'assets' }];
  while (stack.length) {
    const { v: x, path } = /** @type {{ v: any, path: string }} */ (stack.pop());
    if (typeof x === 'string') { if (/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(x)) out.push({ path, value: x }); continue; }
    if (Array.isArray(x)) { x.forEach((y, i) => stack.push({ v: y, path: `${path}[${i}]` })); continue; }
    if (isObj(x)) for (const [k, y] of Object.entries(x)) if (k !== 'ref') stack.push({ v: y, path: `${path}.${k}` });
  }
  return out.reverse();
}

/** Whether an inline theme names a URL (theme values are colours, lengths and the plugin's own font names). */
function themeHasUrl(v) {
  const stack = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'string') { if (/url\s*\(|:\/\//i.test(x)) return true; continue; }
    if (x && typeof x === 'object') for (const y of Object.values(x)) stack.push(y);
  }
  return false;
}

/**
 * One part of manifest 2 (see PARTS), or null with a problem.
 * @param {string} name @param {unknown} v @param {string[]} problems
 * @returns {PluginPart | null}
 */
function readPart(name, v, problems) {
  const spec = PARTS[name];
  const json = (rel, at) => {
    if (!isPackPath(rel)) { problems.push(`${at}: ${short(rel)} is not a path inside the plugin folder`); return false; }
    if (extOf(rel) !== '.json') { problems.push(`${at}: ${rel} is not a .json file`); return false; }
    return true;
  };
  if (spec.shape === 'inline' && isObj(v)) {
    const part = { files: [], inline: /** @type {Record<string, any>} */ (v) };
    if (name === 'assets') {
      for (const f of inlineAssetFiles(v)) {
        if (!isPackPath(f.value)) problems.push(`${f.path}: ${short(f.value)} is not a path inside the plugin folder`);
        else if (!ASSET_EXT.includes(extOf(f.value))) problems.push(`${f.path}: ${f.value} is not an image, a Spine file, audio or a font (${ASSET_EXT.join(' ')})`);
        else if (!part.files.includes(f.value)) part.files.push(f.value);
      }
    } else if (name === 'theme' && themeHasUrl(v)) problems.push('"theme" names a URL (a theme sets colours, lengths and the plugin\'s own fonts)');
    return part;
  }
  if (spec.shape === 'langs') {
    if (!isObj(v)) { problems.push(`"${name}" is not { "<lang>": "<file>.json" }`); return null; }
    /** @type {PluginPart} */
    const part = { files: [], langs: {} };
    for (const [k, rel] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
      const code = canonicalLang(k);
      if (!code) { problems.push(`"${name}.${k}" is not a language code`); continue; }
      if (json(rel, `"${name}.${k}"`)) { part.langs[code] = /** @type {string} */ (rel); if (!part.files.includes(/** @type {string} */ (rel))) part.files.push(/** @type {string} */ (rel)); }
    }
    return part;
  }
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || !list.length || list.length > 256) {
    problems.push(`"${name}" is not ${spec.shape === 'inline' ? 'an object, ' : ''}a .json path or a list of 1–256 of them`);
    return null;
  }
  const files = [];
  list.forEach((rel, i) => { if (json(rel, `"${name}"${Array.isArray(v) ? `[${i}]` : ''}`) && !files.includes(rel)) files.push(rel); });
  return { files };
}

/**
 * Read a manifest 2 (plugin.json, see the header). `problems` keep the plugin out (manifest null); `warnings` do not.
 * @param {unknown} raw the parsed plugin.json
 * @param {{ id: string, app?: string, api?: { current: number, min: number } }} ctx
 *   id: the folder name (it decides); app: the app version (default APP_VERSION); api: the supported API levels
 *   (default PLUGIN_API)
 * @returns {ManifestResult}
 */
export function readPluginManifest(raw, ctx) {
  const problems = [];
  const warnings = [];
  if (!isObj(raw)) return { manifest: null, problems: ['the manifest is not a JSON object'], warnings };
  const m = /** @type {any} */ (raw);
  const id = ctx.id;
  if (m.manifest !== 2) {
    problems.push(m.manifest === undefined ? 'no "manifest": 2 (plugin.json is manifest 2; pack.json in packs/ is the older manifest 1)' : `"manifest": ${short(m.manifest)} is not 2, the version this game reads`);
    return { manifest: null, problems, warnings };
  }
  if (!isPluginId(id)) problems.push(`"${id}" is not a plugin id (2–32 lower-case letters, digits and -, the folder name decides)`);
  if (m.id !== undefined && m.id !== id) warnings.push(`"id": ${short(m.id)} is not "${id}" (the folder name decides)`);
  for (const k of Object.keys(m)) if (!V2_FIELDS.has(k)) warnings.push(`"${k}" is not a field of manifest 2 (ignored)`);

  const cls = typeof m.class === 'string' ? m.class : '';
  const kind = has(PLUGIN_CLASSES, cls) ? PLUGIN_CLASSES[cls] : null;
  if (!kind) {
    problems.push(m.class === undefined ? `no "class" (${Object.keys(PLUGIN_CLASSES).join(', ')})` : `unknown class ${short(m.class)} (known: ${Object.keys(PLUGIN_CLASSES).join(', ')})`);
    return { manifest: null, problems, warnings };
  }
  const isLang = cls === 'lang';
  const sourceLang = m.sourceLang === undefined ? SOURCE_LANG : canonicalLang(m.sourceLang) || '';
  if (!sourceLang) problems.push(`"sourceLang": ${short(m.sourceLang)} is not a language code`);
  // a lang plugin's plain-text name is the language's own name (日本語), as in manifest 1 — not a text in sourceLang
  const ownName = isLang && typeof m.name === 'string';
  const names = ownName ? {} : localized(m.name, sourceLang || SOURCE_LANG, 60, 'name', warnings);
  const description = localized(m.description, sourceLang || SOURCE_LANG, 500, 'description', warnings);
  const langName = isLang ? canonicalLang(m.lang) : null;
  const name = ownName ? str(m.name, 60) : names[langName || sourceLang] || names[sourceLang] || Object.values(names)[0] || '';
  const englishName = str(m.englishName, 60) || names.en || '';

  const version = typeof m.version === 'string' ? m.version.trim() : '';
  if (!isSemver(version)) problems.push(m.version === undefined ? 'no "version" (semver, e.g. "1.0.0")' : `"version": ${short(m.version)} is not a semantic version (1.0.0, 0.2.1-beta.1 …)`);
  const range = typeof m.app === 'string' ? m.app.trim() : '';
  if (m.app !== undefined && (typeof m.app !== 'string' || range.length > 60 || !isVersionRange(range))) problems.push(`"app": ${short(m.app)} is not a version range (">=0.3.0 <0.4.0", "0.3.x" …)`);
  else if (!range && !isLang) problems.push('no "app" (the game versions it is made for, e.g. ">=0.3.0 <0.4.0")');
  const app = ctx.app ?? APP_VERSION;
  const compatible = appVersionMatches(range, app);
  if (range && !compatible) warnings.push(`made for app ${range}; this is ${app}`);
  const supported = ctx.api ?? PLUGIN_API;
  let api = null;
  if (m.api === undefined) { if (!isLang) problems.push(`no "api" (the plugin API level it is written for; this game supports ${supported.min}–${supported.current})`); }
  else if (!Number.isInteger(m.api)) problems.push(`"api": ${short(m.api)} is not an integer`);
  else if (m.api < supported.min || m.api > supported.current) problems.push(`"api": ${m.api} is not supported (this game: ${supported.min}–${supported.current})`);
  else api = m.api;

  let scope = [...kind.defaultScope];
  if (m.scope !== undefined) {
    const s = Array.isArray(m.scope) ? m.scope : [m.scope];
    const bad = s.filter((x) => !kind.scopes.includes(x));
    if (!s.length || bad.length || new Set(s).size !== s.length) problems.push(`"scope": ${short(m.scope)} — a ${cls} plugin's scope is ${kind.scopes.map((x) => `"${x}"`).join(' and/or ')}`);
    else scope = kind.scopes.filter((x) => s.includes(x));
  }
  let homepage = '';
  if (m.homepage !== undefined) {
    const h = str(m.homepage, 300);
    if (/^https?:\/\/[^\s]+$/i.test(h)) homepage = h;
    else warnings.push(`"homepage": ${short(m.homepage)} is not an http(s) address (ignored)`);
  }
  const requires = depMap(m.requires, 'requires', id, problems);
  const optional = depMap(m.optional, 'optional', id, problems);
  const conflicts = depMap(m.conflicts, 'conflicts', id, problems);
  for (const dep of Object.keys(conflicts)) if (has(requires, dep)) problems.push(`"${dep}" is both required and a conflict`);
  const loadAfter = idList(m.loadAfter, 'loadAfter', id, problems);
  const loadBefore = idList(m.loadBefore, 'loadBefore', id, problems);
  for (const dep of loadAfter) if (loadBefore.includes(dep)) problems.push(`"${dep}" is in loadAfter and in loadBefore`);
  let priority = 0;
  if (m.priority !== undefined) {
    if (Number.isInteger(m.priority) && Math.abs(m.priority) <= 1000) priority = m.priority;
    else problems.push(`"priority": ${short(m.priority)} is not an integer within ±1000`);
  }

  /** @type {Record<string, PluginSetting>} */
  const settings = {};
  if (m.settings !== undefined) {
    if (!isObj(m.settings)) problems.push('"settings" is not { "<key>": { "type": … } }');
    else {
      const keys = Object.keys(m.settings);
      if (keys.length > PLUGIN_LIMITS.settings) problems.push(`more than ${PLUGIN_LIMITS.settings} settings`);
      for (const key of keys.slice(0, PLUGIN_LIMITS.settings)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) { problems.push(`"settings.${key}": a key is a letter, then letters, digits or _ (≤ 32)`); continue; }
        const s = readSetting(key, m.settings[key], sourceLang || SOURCE_LANG, problems, warnings);
        if (s) settings[key] = s;
      }
    }
  }

  // the parts and the entry points: each must belong to the class
  /** @type {Record<string, PluginPart>} */
  const parts = {};
  for (const name of Object.keys(PARTS)) {
    if (m[name] === undefined) continue;
    if (!PARTS[name].classes.includes(cls)) { problems.push(`"${name}" is not something a ${cls} plugin carries (${PARTS[name].classes.join(', ')})`); continue; }
    const p = readPart(name, m[name], problems);
    if (p) parts[name] = p;
  }
  /** @type {Record<string, string>} */
  const entry = {};
  if (m.entry !== undefined) {
    if (!isObj(m.entry)) problems.push('"entry" is not { "sim" | "meta" | "client" | "server": "<path>" }');
    else {
      for (const [k, rel] of Object.entries(m.entry)) {
        const e = has(ENTRIES, k) ? ENTRIES[k] : null;
        if (!e) { warnings.push(`"entry.${k}" is not an entry point (ignored)`); continue; }
        if (!e.classes.includes(cls)) { problems.push(`"entry.${k}" is not something a ${cls} plugin has (${e.classes.join(', ')})`); continue; }
        if (!isPackPath(rel) || extOf(/** @type {string} */ (rel)) !== e.ext) { problems.push(`"entry.${k}": ${short(rel)} is not a ${e.ext} file inside the plugin folder`); continue; }
        entry[k] = /** @type {string} */ (rel);
      }
    }
  }
  if (!isLang) for (const k of LANG_ONLY) if (m[k] !== undefined) problems.push(`"${k}" belongs to a lang plugin, not a ${cls} one`);

  // slots: a ui plugin asks the host for one of UI_SLOT_IDS. Absent (or []): it loads, and the host grants none.
  /** @type {string[]} */
  let slots = [];
  if (m.slots !== undefined && cls !== 'ui') problems.push(`"slots" is not something a ${cls} plugin carries (ui)`);
  else if (cls === 'ui') {
    if (m.slots === undefined || (Array.isArray(m.slots) && m.slots.length === 0)) warnings.push('requests no slot (the host will not grant one)');
    else if (!Array.isArray(m.slots) || m.slots.length > UI_SLOT_IDS.length || new Set(m.slots).size !== m.slots.length
      || m.slots.some((s) => !UI_SLOT_IDS.includes(s))) {
      problems.push(`"slots": ${short(m.slots)} — a ui plugin lists ${UI_SLOT_IDS.join(', ')} (one each)`);
    } else slots = UI_SLOT_IDS.filter((s) => m.slots.includes(s));
    if (!entry.client) problems.push('"entry.client" is required for a ui plugin (an .html file)');
  }

  // permissions: known, allowed for the class, one for every part and entry point
  const permissions = [];
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) problems.push('"permissions" is not a list');
    else for (const p of m.permissions) {
      if (typeof p !== 'string' || !has(PERMISSIONS, p)) problems.push(`unknown permission ${short(p)} (known: ${Object.keys(PERMISSIONS).join(', ')})`);
      else if (!PERMISSIONS[p].includes(cls)) problems.push(`the permission "${p}" is not one a ${cls} plugin may have`);
      else if (!permissions.includes(p)) permissions.push(p);
    }
  }
  const used = new Set();
  for (const name of Object.keys(parts)) {
    const needs = PARTS[name].needs;
    if (!needs.length) continue;
    const got = needs.filter((p) => permissions.includes(p));
    if (!got.length) problems.push(`"${name}" needs the permission ${needs.map((p) => `"${p}"`).join(' or ')}`);
    for (const p of got) used.add(p);
  }
  for (const k of Object.keys(entry)) {
    const need = ENTRIES[k].needs[cls];
    if (!permissions.includes(need)) problems.push(`"entry.${k}" needs the permission "${need}"`);
    used.add(need);
    if (k === 'sim' || k === 'meta') used.add('mode.code');
  }
  for (const p of permissions) if (!used.has(p)) warnings.push(`the permission "${p}" is declared but nothing in the manifest uses it`);
  if (!isLang && !Object.keys(parts).length && !Object.keys(entry).length) warnings.push(`carries nothing a ${cls} plugin is made of`);

  /** @type {PluginManifest} */
  const out = {
    manifest: 2, id, class: cls, type: kind.packType, name, englishName, names, description, version, app: range, compatible, api, scope,
    authors: authorsOf(m.authors), credits: str(m.credits, 500), license: str(m.license, 100), homepage, sourceLang: sourceLang || SOURCE_LANG,
    requires, optional, conflicts, loadAfter, loadBefore, priority, settings, permissions, parts, entry, slots, files: {},
  };
  if (isLang) {
    readLangFields(m, undefined, out, problems, warnings);
    readFileRoles(m, 'a lang plugin', 'plugin', out, problems, warnings, true);
  }
  out.name ||= id;
  out.englishName ||= out.name;
  return { manifest: problems.length ? null : out, problems, warnings, draft: out };
}

// ---- files ------------------------------------------------------------------------------------------------------------

/** Documents a plugin may carry next to its files: never served, never counted against its class. */
const isDocument = (rel) => /\.(?:md|txt)$/i.test(rel) || /^(?:.*\/)?(?:README|LICEN[CS]E|COPYING|NOTICE|AUTHORS|CHANGELOG|CREDITS)$/i.test(rel);
/** The manifest and the lock file `tools/plugin.mjs pack` writes (shared/plugins/visual.js LOCK_FILE). */
const isOwnFile = (rel) => rel === PLUGIN_MANIFEST || rel === 'plugin.lock.json';

/**
 * Every path the manifest names, with where it is named.
 * @param {PluginManifest} manifest
 * @returns {{ rel: string, at: string }[]}
 */
export function declaredPaths(manifest) {
  const out = [];
  const add = (rel, at) => { if (!out.some((x) => x.rel === rel)) out.push({ rel, at }); };
  for (const [role, rel] of Object.entries(manifest.files || {})) add(rel, `files.${role}`);
  for (const [name, part] of Object.entries(manifest.parts || {})) for (const rel of part.files) add(rel, name);
  for (const [k, rel] of Object.entries(manifest.entry || {})) add(rel, `entry.${k}`);
  return out;
}

/**
 * The file rules of a plugin folder (see the header): types by class, sizes, counts, and that every path the manifest
 * names is there. Pure: the caller lists the folder (dot files left out — they are never served).
 * @param {PluginManifest} manifest
 * @param {{ rel: string, bytes: number, link?: boolean }[]} files every file of the folder, `rel` relative to it
 * @returns {{ problems: string[], warnings: string[], bytes: number, count: number }}
 */
export function checkPluginFiles(manifest, files) {
  const problems = [];
  const warnings = [];
  const kind = PLUGIN_CLASSES[manifest.class] || PLUGIN_CLASSES.content;
  const clientDir = manifest.class === 'ui' && manifest.entry?.client ? manifest.entry.client.replace(/[^/]*$/, '') : null;
  let bytes = 0;
  let count = 0;
  const seen = new Set();
  for (const f of files) {
    const rel = String(f.rel);
    seen.add(rel);
    bytes += Number(f.bytes) || 0;
    if (f.link) { problems.push(`${rel}: a symbolic link (a plugin's files are plain files inside its folder)`); continue; }
    if (!isPackPath(rel)) { problems.push(`${rel}: not a plain file name (letters, digits, . _ - and spaces; no hidden or ".." part)`); continue; }
    if (isOwnFile(rel) || isDocument(rel)) continue;
    count++;
    const ext = extOf(rel);
    if (!kind.ext.includes(ext)) { problems.push(`${rel}: ${ext || 'a file without an extension'} is not a file a ${manifest.class} plugin may carry (${kind.ext.join(' ')}, documents)`); continue; }
    if (clientDir !== null && ['.html', '.js', '.css', '.png'].includes(ext) && !rel.startsWith(clientDir)) problems.push(`${rel}: a frame file outside the folder of entry.client (${clientDir || 'the plugin folder'})`);
    if (ext === '.json' && f.bytes > PLUGIN_LIMITS.jsonBytes) problems.push(`${rel}: ${(f.bytes / 1048576).toFixed(1)} MB, larger than the ${PLUGIN_LIMITS.jsonBytes / 1048576} MB a JSON file may be`);
  }
  if (files.length > PLUGIN_LIMITS.files) problems.push(`${files.length} files, more than ${PLUGIN_LIMITS.files}`);
  if (bytes > PLUGIN_LIMITS.pluginBytes) problems.push(`${(bytes / 1048576).toFixed(1)} MB in all, more than ${PLUGIN_LIMITS.pluginBytes / 1048576} MB`);
  for (const d of declaredPaths(manifest)) if (!seen.has(d.rel)) problems.push(`"${d.at}": ${d.rel} is missing`);
  return { problems, warnings, bytes, count };
}

/**
 * The limits of a JSON value a plugin carries (see the header): nesting depth, numbers finite (JSON.parse reads 1e999
 * as Infinity) and within ±1e9. [ASSUMED] P1b's schema will name the fields allowed beyond ±1e9.
 * @param {unknown} value a parsed JSON value
 * @returns {string | null} the first problem, or null
 */
export function checkJsonLimits(value) {
  const stack = [{ v: value, depth: 0, at: '$' }];
  while (stack.length) {
    const { v, depth, at } = /** @type {{ v: any, depth: number, at: string }} */ (stack.pop());
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return `${at}: a number that is not finite`;
      if (Math.abs(v) > PLUGIN_LIMITS.number) return `${at}: ${v} is beyond ±${PLUGIN_LIMITS.number}`;
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    if (depth + 1 > PLUGIN_LIMITS.jsonDepth) return `${at}: nested deeper than ${PLUGIN_LIMITS.jsonDepth} levels`;
    if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], depth: depth + 1, at: `${at}[${i}]` });
    else for (const k of Object.keys(v).reverse()) stack.push({ v: v[k], depth: depth + 1, at: `${at}.${k}` });
  }
  return null;
}

// ---- the catalogue ----------------------------------------------------------------------------------------------------

/**
 * What this version does with a class: 'loaded' (lang, cosmetic, ui), 'planned' (validated and listed, not applied yet) or
 * 'unsupported' (script and trusted: listed, never loaded).
 * @param {string} cls
 * @returns {'loaded' | 'planned' | 'unsupported'}
 */
export function classStatus(cls) {
  const s = PLUGIN_CLASSES[cls]?.status;
  return s === 'supported' ? 'loaded' : s === 'planned' ? 'planned' : 'unsupported';
}

/**
 * @typedef {{ id: string, class: string, status: string, source: string, manifest: PluginManifest, bytes?: number,
 *   count?: number, visual?: { vs: string | null, bytes: number },
 *   ui?: { vs: string | null, bytes: number, slots: string[], entry: string, frameFiles: Record<string, string> } }} PluginEntry
 *   what the registry knows of one plugin or pack (server/plugins/registry.js; `visual`: a loaded cosmetic plugin's own
 *   visual set and the bytes of art it serves; `ui`: a loaded interface plugin's frame — its own `vs`, the bytes it
 *   serves, the slots it asked for, the client entry and each frame file's hash)
 */

/**
 * The catalogue entry of a plugin or pack (GET /plugins/index.json): what a client may know — never a path on the
 * server. `unofficial` marks every class but lang; requires / optional / conflicts / loadAfter / loadBefore / priority
 * when set (what the load order reads: shared/plugins/order.js); a loaded cosmetic plugin adds `vs` (the visual set of
 * that plugin alone: a player's personal plugin is fetched as /vs/<vs16>/overlay.json, shared/plugins/visual.js) and
 * `artBytes` (the art it serves). A loaded interface plugin adds `slots`, `entry` (the client page, relative), `vs`
 * (the same hash family, of that plugin alone), `frameBytes` and `frameFiles` (relative path → SHA-256, so a page can
 * build /p/<id>/<hash8>/<path>). Never a path on disk.
 * @param {PluginEntry} p
 * @returns {Record<string, unknown>}
 */
export function pluginIndexEntry(p) {
  const m = p.manifest;
  /** @type {Record<string, unknown>} */
  const e = { id: p.id, class: p.class, status: p.status, source: p.source, manifest: m.manifest, name: m.name, englishName: m.englishName };
  if (PLUGIN_CLASSES[p.class]?.unofficial) e.unofficial = true;
  if (Object.keys(m.names).length) e.names = { ...m.names };
  if (Object.keys(m.description).length) e.description = { ...m.description };
  if (m.version) e.version = m.version;
  if (m.app) e.app = m.app;
  e.compatible = m.compatible;
  if (m.api !== null) e.api = m.api;
  e.scope = [...m.scope];
  if (m.authors.length) e.authors = [...m.authors];
  if (m.credits) e.credits = m.credits;
  if (m.license) e.license = m.license;
  if (m.homepage) e.homepage = m.homepage;
  if (p.class === 'lang' && m.lang) e.lang = m.lang;
  for (const k of ['requires', 'optional', 'conflicts']) if (Object.keys(m[k]).length) e[k] = { ...m[k] };
  // the load order's other inputs: a browser orders a player's personal plugins with the same function as a room's set
  // (shared/plugins/order.js — public/js/content.js)
  for (const k of ['loadAfter', 'loadBefore']) if (m[k].length) e[k] = [...m[k]];
  if (m.priority) e.priority = m.priority;
  if (Object.keys(m.settings).length) e.settings = JSON.parse(JSON.stringify(m.settings));
  if (m.permissions.length) e.permissions = [...m.permissions];
  if (Number.isFinite(p.bytes)) e.bytes = p.bytes;
  if (Number.isFinite(p.count)) e.files = p.count;
  if (p.visual && typeof p.visual.vs === 'string') e.vs = p.visual.vs;
  if (p.visual && Number.isFinite(p.visual.bytes)) e.artBytes = p.visual.bytes;
  if (p.ui) {
    e.slots = [...(p.ui.slots || [])];
    if (typeof p.ui.entry === 'string') e.entry = p.ui.entry;
    if (typeof p.ui.vs === 'string') e.vs = p.ui.vs;
    if (Number.isFinite(p.ui.bytes)) e.frameBytes = p.ui.bytes;
    if (p.ui.frameFiles && typeof p.ui.frameFiles === 'object') e.frameFiles = { ...p.ui.frameFiles };
  }
  return e;
}

/**
 * The catalogue body: { version, app, api, content?, plugins: [entry …] } — by class (PLUGIN_CLASSES order), then id.
 * @param {PluginEntry[]} plugins
 * @param {{ app?: string, api?: { current: number, min: number }, vanilla?: string | null }} [opts]
 *   vanilla: this server's vanilla content hash (server/plugins/identity.js)
 */
export function buildPluginIndex(plugins, { app = APP_VERSION, api = PLUGIN_API, vanilla = null } = {}) {
  const order = Object.keys(PLUGIN_CLASSES);
  const rank = (p) => order.indexOf(p.class);
  const list = [...plugins].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /** @type {Record<string, unknown>} */
  const body = { version: PLUGIN_INDEX_VERSION, app, api: { current: api.current, min: api.min } };
  if (vanilla) body.content = { vanilla };
  body.plugins = list.map(pluginIndexEntry);
  return body;
}
