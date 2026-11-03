// shared/collabAssets.js — the collab art pack (联动干员, the owner's decision of 2026-11-02; docs/ASSETS.md "The collab
// pack"). The art, voices and models of the collab 6★ (data/backups.json `diy.excluded`) never ship in the normal pack:
// their files live under COLLAB_ASSET_PREFIX (public/assets/collab/…, published as a pack of its own) and their entries
// in data/assets-collab.json — the schema of data/assets.json, collab operators (and their summons) only —, never in
// data/assets.json. A page loads that manifest only in a room whose host turned 联动干员 on (public/js/content.js) and
// lays it over its own manifest (public/js/cosmetics.js): add-only, so it never changes an entry of the normal pack.
// Pure ESM shared by the server (the served view), the tools (coverage, the pack builder) and the browser.

import { splitHashedPath } from './assetPaths.js';

/** Where the collab pack's files live: every URL of data/assets-collab.json starts with it. */
export const COLLAB_ASSET_PREFIX = '/assets/collab/';
/** The collab pack's manifest, as the page fetches it. */
export const COLLAB_MANIFEST_URL = '/data/assets-collab.json';
/** Its file under data/. */
export const COLLAB_MANIFEST_FILE = 'assets-collab.json';
/** The sections of the manifest the pack may fill (the others are the normal pack's alone). */
export const COLLAB_SECTIONS = Object.freeze(['chars', 'tokens', 'skills', 'skillsById', 'modules', 'skins', 'audio']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether a manifest URL is one of the pack's: under COLLAB_ASSET_PREFIX, with or without the served content-hash
 * segment (`/assets/~<hash>/collab/…`, shared/assetPaths.js).
 * @param {unknown} url
 */
export function isCollabUrl(url) {
  if (typeof url !== 'string') return false;
  return splitHashedPath(url).path.startsWith(COLLAB_ASSET_PREFIX);
}

/**
 * The pack's URL of a normal-pack URL: `/assets/char/avatar/x.png` → `/assets/collab/char/avatar/x.png`; a URL already
 * in the pack, or outside /assets/, unchanged.
 * @param {string} url
 */
export function toCollabUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/assets/') || isCollabUrl(url)) return url;
  return COLLAB_ASSET_PREFIX + url.slice('/assets/'.length);
}

/**
 * Every URL a manifest (or a part of one) names: the strings that start with '/'.
 * @param {unknown} doc
 * @returns {string[]}
 */
export function manifestUrls(doc) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (v.startsWith('/')) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (isObj(v)) for (const x of Object.values(v)) walk(x);
  };
  walk(doc);
  return out;
}

/**
 * What is wrong with a collab manifest (empty = fine): not an object, a section outside COLLAB_SECTIONS, a URL outside
 * the pack's prefix.
 * @param {unknown} doc
 * @returns {string[]}
 */
export function collabManifestProblems(doc) {
  if (!isObj(doc)) return ['not a manifest'];
  const problems = [];
  for (const [key, value] of Object.entries(doc)) {
    if (['version', 'hash', 'generator', 'stats', 'kind', 'prefix'].includes(key)) continue;
    if (!COLLAB_SECTIONS.includes(key)) { problems.push(`section ${key} is the normal pack's`); continue; }
    for (const url of manifestUrls(value)) if (!isCollabUrl(url)) problems.push(`${key}: ${url} is outside ${COLLAB_ASSET_PREFIX}`);
  }
  return problems;
}

/** Add-only: `next`'s keys that `prev` lacks, recursively; every value `prev` has (objects, arrays, null) stays. */
function addOnly(prev, next) {
  if (!isObj(prev) || !isObj(next)) return prev;
  let out = prev;
  for (const [key, value] of Object.entries(next)) {
    const cur = Object.hasOwn(prev, key) ? prev[key] : undefined;
    const merged = cur === undefined ? value : addOnly(cur, value);
    if (merged !== cur) { if (out === prev) out = { ...prev }; out[key] = merged; }
  }
  return out;
}

/**
 * The page's manifest with the collab pack laid over it: the pack's sections added where the base has no entry (an
 * operator, a skill icon, a voice line), nothing of the base changed. A pack that fails collabManifestProblems is not
 * laid at all (the base comes back). Returns `base` itself when nothing is added.
 * @param {any} base the page's manifest (data/assets.json as served)
 * @param {any} collab data/assets-collab.json as served, or null
 */
export function mergeCollabManifest(base, collab) {
  if (!isObj(collab) || collabManifestProblems(collab).length) return base;
  const root = isObj(base) ? base : {};
  let out = root;
  for (const key of COLLAB_SECTIONS) {
    if (!isObj(collab[key])) continue;
    const cur = isObj(root[key]) ? root[key] : {};
    const merged = addOnly(cur, collab[key]);
    if (merged !== root[key]) { if (out === root) out = { ...root }; out[key] = merged; }
  }
  return out === root ? base : out;
}

/**
 * The collab manifest of a body of data/assets.json entries (the sections of COLLAB_SECTIONS for the collab operators,
 * with their normal-pack URLs): every URL moved under the pack's prefix (toCollabUrl), and the normal-pack paths of the
 * files it names (`moves`: [from, to] public/ paths, for the pack builder tools/collab-assets.mjs).
 * @param {any} body
 * @returns {{ doc: Record<string, any>, moves: [string, string][] }}
 */
export function collabManifestOf(body) {
  const moves = new Map();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!v.startsWith('/assets/') || isCollabUrl(v)) return v;
      const to = toCollabUrl(v);
      moves.set(v, to);
      return to;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const doc = {};
  for (const key of COLLAB_SECTIONS) if (isObj(body?.[key])) doc[key] = walk(body[key]);
  return { doc, moves: [...moves] };
}

// ---- the collab pack's official battle effects (DESIGN §33; the owner's decision of 2026-11-02) ---------------------
// Their files live under COLLAB_FX_PREFIX (public/assets/collab/local/fx/…: index.json, textures.json, prefabs, textures,
// meshes of the collab operators' effects that the normal set lacks), listed in data/local-fx-collab.json — the schema of
// data/local-fx.json (`groups`: fx, fx/prefabs, fx/tex, fx/mesh), every path under the prefix. The page's effects library
// (public/js/render/vfx/library.js) merges them — add-only, the normal set wins a key both have — only while the collab
// pack is laid (a room with 联动干员 on). Built by `node tools/collab-assets.mjs --fx <extraction dir>` from an
// `extract.py --only fx --fx-collab only` run into a directory of its own.

/** The collab effects' file list under data/ and as the page fetches it. */
export const COLLAB_FX_FILE = 'local-fx-collab.json';
export const COLLAB_FX_LIST_URL = `/data/${COLLAB_FX_FILE}`;
/** Where their files live. */
export const COLLAB_FX_PREFIX = `${COLLAB_ASSET_PREFIX}local/fx/`;
/** The file list's groups. */
export const FX_GROUPS = Object.freeze(['fx', 'fx/prefabs', 'fx/tex', 'fx/mesh']);
/** The sections of an effects index.json the collab one adds to (generic keys stay the normal set's). */
export const FX_INDEX_SECTIONS = Object.freeze(['units', 'projectiles', 'skills', 'skins', 'prefabs']);

/**
 * What is wrong with a collab effects file list (empty = fine): not an fx manifest, a group outside FX_GROUPS, a path
 * (or a texture's `half`) outside COLLAB_FX_PREFIX (hashed or not).
 * @param {unknown} list
 * @returns {string[]}
 */
export function collabFxListProblems(list) {
  const groups = isObj(list) ? /** @type {any} */ (list).groups : null;
  if (!isObj(groups)) return ['not an fx file list'];
  const problems = [];
  for (const [group, entries] of Object.entries(groups)) {
    if (!FX_GROUPS.includes(group)) { problems.push(`group ${group} is not an fx group`); continue; }
    if (!isObj(entries)) { problems.push(`group ${group} is not an object`); continue; }
    for (const [key, e] of Object.entries(entries)) {
      for (const field of ['path', 'half']) {
        const p = isObj(e) ? e[field] : undefined;
        if (p === undefined && field === 'half') continue;
        if (typeof p !== 'string' || !splitHashedPath(p).path.startsWith(COLLAB_FX_PREFIX)) problems.push(`${group}.${key}.${field}: ${p} is outside ${COLLAB_FX_PREFIX}`);
      }
    }
  }
  return problems;
}

/**
 * The file list's groups with the collab ones added where the normal list has no key (add-only).
 * @param {Record<string, any>|null} base the normal list's groups
 * @param {Record<string, any>|null} collab the collab list's groups
 */
export function mergeFxGroups(base, collab) {
  if (!isObj(collab)) return base;
  const out = { ...(isObj(base) ? base : {}) };
  for (const group of FX_GROUPS) {
    if (group === 'fx' || !isObj(collab[group])) continue;
    out[group] = { ...collab[group], ...(isObj(out[group]) ? out[group] : {}) };
  }
  return out;
}

/**
 * An effects index.json with the collab one's units, projectiles, skills, skins and prefab summaries added where the
 * normal index has no entry (add-only). Either may be null.
 * @param {any} base @param {any} collab
 */
export function mergeFxIndex(base, collab) {
  if (!isObj(collab)) return base;
  if (!isObj(base)) return collab;
  const out = { ...base };
  for (const key of FX_INDEX_SECTIONS) {
    if (!isObj(collab[key])) continue;
    out[key] = { ...collab[key], ...(isObj(base[key]) ? base[key] : {}) };
  }
  return out;
}
