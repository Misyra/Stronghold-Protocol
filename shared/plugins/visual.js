// shared/plugins/visual.js — the cosmetic plugins (DESIGN §32 P1a, docs/PLUGINS.md §9): the asset overlay a cosmetic
// plugin carries — its `assets` part, written in the shape of data/assets.json (docs/ASSETS.md "Manifest schema") with
// the plugin's own files and references to the installation's entries — read and checked (readAssetOverlay), resolved
// against a manifest and rewritten to the plugin's served URLs (resolveOps), merged in load order with a warning where
// two plugins change the same thing (mergePluginOps) and laid over a manifest (applyOps); the visual hash `vs` that
// names a set of them (visualHashOf) and the check a browser runs on what it downloaded (checkVisualDoc). No Node
// builtin: the server builds a room's visual set with it (server/plugins/registry.js reads, server/plugins/visualSet.js
// builds), the browser lays the player's personal plugins over the page's manifest with it (public/js/assets.js), the
// tools check and pack with it (tools/plugin.mjs).
//
// The overlay (`assets`, inline in plugin.json or a .json file of the plugin) — the record containers of data/assets.json
// a plugin may write (ASSET_CONTAINERS), each record in the manifest's own shape:
//   chars[charId]            { avatar, avatarE2, portrait, portraitE2: image, spine: { front, back: Spine } }
//   enemies[key]             { icon: image, spine: Spine }          tokens[id]  { avatar: image, spine: Spine }
//   bonds / items / bands / skills / modules / ui[key], prof.icon / large / battlecard / sub[key]     image
//   audio.bgm[lobby|prep|combat|unite|boss], audio.bossBgm[bossId]     a track { loop, intro? }: replaced as a whole
//   audio.voice / voiceJp[charId]  { <slot>: audio or a list of 1–16 }      audio.sfx.ui / battle[key]  audio
//   audio.sfx.units[id]      { attack, hit, skill, die, born: audio, skills / attacks / hits: { <index>: audio } }
// A value is a path inside the plugin folder (an image .png .jpg .webp, audio .mp3 .ogg), a Spine object
// `{ skel, atlas, textures?, pma? }` (.skel and .atlas side by side with one name — pixi-spine finds the atlas next to the
// skeleton —, the pages inside the atlas's folder, default `<name>.png`; its clip roles, durations, events, hits and
// bounds come from plugin.lock.json — tools/plugin.mjs pack — never by hand: `"anims": "auto"` or nothing), or a
// reference `{ "ref": "<key>" }` to the entry of the same container in the installation's manifest: a whole record
// (`chars.char_102_texas = { "ref": "char_112_siege" }` — that record, replaced as a whole; other keys beside the ref
// then change fields of it) or one field (`chars.char_102_texas.avatar = { "ref": "char_112_siege" }` — that field of
// char_112_siege). A reference always names the installation's own entry, never another plugin's: the order of the
// plugins never changes what it means [ASSUMED]. A missing entry is a problem. Anything else — another top-level
// section (fonts, skillsById …), a field the record has not — is a warning and is left out; numbers, booleans and free
// text are never written into the manifest. A field a plugin does not write keeps the installation's value (an `avatar`
// alone leaves `avatarE2`), but a track is written whole (a `loop` alone plays without the installation's intro), and a
// model written for an enemy or a token (its `spine`, a model or a reference) also takes away the entry's local-client
// model `spineLocal` — the client would draw that one first (public/js/assets.js spineEntry) [ASSUMED].
//
// The ops: the overlay as a list of writes `{ at: [path…], … }` in the order the plugin wrote them — a plugin file
// (`file` / `files`), a Spine model (`spine`), a reference (`ref`, `from`: the path it reads). Resolved (resolveOps),
// each op is `{ at, value }`: a file becomes `/p/<id>/<8 hex>/<path>` (PLUGIN_FILES_URL; the first 8 hex digits of the
// file's SHA-256 — of a Spine model's files' hashes for every file of the model, so the skeleton, the atlas and the pages
// share one folder, as pixi-spine needs), a reference the entry's value in the manifest it is resolved against (the
// served one: its /assets/~<hash>/ URLs). applyOps writes the values: a whole value at its path (a record replaced by a
// whole-record reference, a Spine object, a file list), the objects on the way copied, never changed in place.
//
//   vs = sha256(canonical({ v: 1, assets: <SHA-256 of data/assets.json>, overlays: [{ id, version, files }] }))
//   files: { <path>: SHA-256 } — every file that shapes the plugin's overlay: plugin.json, plugin.lock.json, the
//   `assets` file and every file the overlay serves [ASSUMED] — so a changed byte in any of them changes `vs`. The
//   asset URLs of the installation's entries (0.2.6: /assets/~<hash>/…) follow the server's asset index, not `vs`: the
//   documents a visual set is served as (/vs/<vs16>/assets.json, /vs/<vs16>/overlay.json) carry their composition, and a
//   browser checks that the composition hashes to the `vs` it was told (checkVisualDoc) — cosmetics never change a battle.

import { sha256Hex } from '../sha256.js';
import { canonicalJson, isContentHash } from './identity.js';
import { isPackPath, extOf } from './manifest.js';

/** The version of the `vs` composition above (a change of it changes every `vs`). */
export const VISUAL_HASH_VERSION = 1;
/** Hex digits of `vs` in a URL (/vs/<16 hex>/assets.json). */
export const VS_URL_DIGITS = 16;
/** Hex digits of a file's (or a Spine model's) hash in its URL (/p/<id>/<8 hex>/<path>). */
export const FILE_URL_DIGITS = 8;
/** Where a cosmetic plugin's files are served (server/http/static.js). */
export const PLUGIN_FILES_URL = '/p/';
/** Where visual sets are served: /vs/<vs16>/assets.json (the effective manifest), /vs/<vs16>/overlay.json (the overlay). */
export const VISUAL_SETS_URL = '/vs/';
/** The lock file tools/plugin.mjs pack writes next to plugin.json. */
export const LOCK_FILE = 'plugin.lock.json';
/** The version of plugin.lock.json. */
export const LOCK_VERSION = 1;
/**
 * [ASSUMED] limits: writes per plugin, files of one voice slot, the art a set may serve in all (the design study's 300 MB
 * per room), the override warnings one set reports.
 */
export const VISUAL_LIMITS = Object.freeze({ ops: 20000, listFiles: 16, setBytes: 300 * 1024 * 1024, warnings: 32 });

/** A full visual hash: 64 lowercase hex digits (the form of `cs`). */
export const isVisualHash = isContentHash;
/** The URL form of `vs`: its first VS_URL_DIGITS digits. @param {string} vs */
export const vsUrlPart = (vs) => String(vs).slice(0, VS_URL_DIGITS);

const IMAGE = Object.freeze(['.png', '.jpg', '.webp']);
const AUDIO = Object.freeze(['.mp3', '.ogg']);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const short = (v) => { try { return String(JSON.stringify(v)).slice(0, 40); } catch { return typeof v; } };

/**
 * A field's kind: 'image' | 'audio' | 'audioList' (one audio file or a list) | 'track' (a BGM `{ loop, intro? }`, written
 * whole) | 'spine' — or an object of named fields `{ fields }`, or one whose keys are free `{ each, key }` (a voice slot,
 * a skill index).
 * @typedef {'image' | 'audio' | 'audioList' | 'track' | 'spine' | { fields: Record<string, any> } | { each: any, key: RegExp }} AssetKind
 * @typedef {{ path: string[], record: AssetKind, keys?: string[] }} AssetContainer
 */

const SLOT = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const INDEX = /^\d{1,2}$/;
const SFX_UNIT = { fields: { attack: 'audio', hit: 'audio', skill: 'audio', die: 'audio', born: 'audio',
  skills: { each: 'audio', key: INDEX }, attacks: { each: 'audio', key: INDEX }, hits: { each: 'audio', key: INDEX } } };

/** @type {readonly AssetContainer[]} the record containers a cosmetic plugin writes (see the header) */
export const ASSET_CONTAINERS = Object.freeze(/** @type {AssetContainer[]} */ ([
  { path: ['chars'], record: { fields: { avatar: 'image', avatarE2: 'image', portrait: 'image', portraitE2: 'image', spine: { fields: { front: 'spine', back: 'spine' } } } } },
  { path: ['enemies'], record: { fields: { icon: 'image', spine: 'spine' } } },
  { path: ['tokens'], record: { fields: { avatar: 'image', spine: 'spine' } } },
  ...['bonds', 'items', 'bands', 'skills', 'modules', 'ui'].map((k) => ({ path: [k], record: 'image' })),
  ...['icon', 'large', 'battlecard', 'sub'].map((k) => ({ path: ['prof', k], record: 'image' })),
  // audio.bgm: the tracks by name — not combatAlts, a list of tracks the client reads by round
  { path: ['audio', 'bgm'], record: 'track', keys: ['lobby', 'prep', 'combat', 'unite', 'boss'] },
  { path: ['audio', 'bossBgm'], record: 'track' },
  { path: ['audio', 'voice'], record: { each: 'audioList', key: SLOT } },
  { path: ['audio', 'voiceJp'], record: { each: 'audioList', key: SLOT } },
  { path: ['audio', 'sfx', 'ui'], record: 'audio' },
  { path: ['audio', 'sfx', 'battle'], record: 'audio' },
  { path: ['audio', 'sfx', 'units'], record: SFX_UNIT },
]).map((c) => Object.freeze(c)));

/** The containers whose records may carry a local-client model (`spineLocal`) a written `spine` takes away. */
const LOCAL_MODELS = new Set(['enemies', 'tokens']);

/** The containers as a tree: section → (sub-section →)… → the container. */
const TREE = (() => {
  const root = {};
  for (const c of ASSET_CONTAINERS) {
    let node = root;
    c.path.forEach((k, i) => { node = node[k] ||= (i === c.path.length - 1 ? { $container: c } : {}); });
  }
  return root;
})();

/** A record key of the manifest (an id, a 'group/key' of `ui`): plain characters, never a name of Object.prototype. @param {unknown} k */
export const isAssetKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 128 && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(k) && !FORBIDDEN.has(k);

/** The value at `path` of a plain-data tree (own properties only), or undefined. @param {any} obj @param {string[]} path */
export function getPath(obj, path) {
  let node = obj;
  for (const k of path) {
    if (!isObj(node) || !has(node, k)) return undefined;
    node = node[k];
  }
  return node;
}

/** A deep copy of plain JSON data. @template T @param {T} v @returns {T} */
const cloneJson = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * @typedef {{ anims: Record<string, any>, animations: Record<string, number>, events: string[],
 *   hits: Record<string, number[]>, bounds: { x: number, y: number, width: number, height: number } | null }} SpineMeta
 *   what plugin.lock.json holds of a skeleton (tools/assets/skel.mjs, anim-roles.mjs — the fields of a manifest Spine)
 * @typedef {{ skel: string, atlas: string, textures: string[], pma: boolean, meta?: SpineMeta }} SpineOp
 * @typedef {{ at: string[], file?: string, files?: string[], track?: { loop: string, intro?: string }, spine?: SpineOp,
 *   ref?: string, from?: string[], clear?: true, implied?: true }} AssetOp
 *   one write of an overlay (see the header); `clear`: the entry's value taken away (an enemy's or a token's
 *   `spineLocal` when its model is written — `implied`: a consequence of another write, never an override of its own)
 * @typedef {{ at: string[], value: any }} ResolvedOp
 * @typedef {{ ops: AssetOp[], files: string[], models: string[][], problems: string[], warnings: string[] }} AssetOverlay
 */

const pathText = (at) => `assets.${at.join('.')}`;
const kindName = (kind) => (typeof kind === 'string' ? (kind === 'audioList' ? 'audio' : kind === 'spine' ? 'Spine model' : kind) : 'record');
/** The write that takes away an enemy's or a token's local-client model when its `spine` is written (see the header). */
const localModelClear = (loc) => (LOCAL_MODELS.has(loc.container[0]) && loc.field.length === 1 && loc.field[0] === 'spine'
  ? { at: [...loc.container, loc.key, 'spineLocal'], clear: /** @type {true} */ (true), implied: /** @type {true} */ (true) } : null);

/**
 * Read a cosmetic plugin's `assets` part (see the header): its shape, the files it names, its references and the
 * permissions they need.
 * @param {unknown} assets the parsed overlay
 * @param {{ vanilla?: any, permissions?: string[] | null, has?: ((rel: string) => boolean) | null }} [ctx]
 *   vanilla: the installation's manifest (data/assets.json) — references must name one of its entries and a write to an
 *   entry it has needs `assets.override`, a new entry `assets.add` (unchecked without it); permissions: the manifest's;
 *   has: whether the plugin folder holds a file (unchecked without it)
 * @returns {AssetOverlay}
 */
export function readAssetOverlay(assets, { vanilla = null, permissions = null, has: hasFile = null } = {}) {
  /** @type {string[]} */ const problems = [];
  /** @type {string[]} */ const warnings = [];
  /** @type {AssetOp[]} */ const ops = [];
  /** @type {string[]} */ const files = [];
  /** @type {string[][]} */ const models = [];
  const addFile = (rel) => { if (!files.includes(rel)) files.push(rel); };
  if (!isObj(assets)) return { ops, files, models, problems: ['"assets" is not an object in the shape of data/assets.json'], warnings };

  /** A plugin file of an allowed extension (else a problem, false). */
  const fileOk = (rel, exts, at) => {
    if (typeof rel !== 'string' || !isPackPath(rel)) { problems.push(`${pathText(at)}: ${short(rel)} is not a path inside the plugin folder`); return false; }
    if (!exts.includes(extOf(rel))) { problems.push(`${pathText(at)}: ${rel} is not ${exts.join(' / ')}`); return false; }
    if (hasFile && !hasFile(rel)) { problems.push(`${pathText(at)}: ${rel} is missing`); return false; }
    return true;
  };

  /** A Spine object (see the header) → a SpineOp, or null with a problem. */
  const readSpine = (v, at) => {
    for (const k of Object.keys(v)) {
      if (k === 'anims' && v.anims === 'auto') continue;
      if (['animations', 'events', 'hits', 'bounds', 'anims'].includes(k)) { problems.push(`${pathText(at)}.${k}: a plugin's Spine clips come from ${LOCK_FILE} (node tools/plugin.mjs pack), never by hand — write "anims": "auto" or leave it out`); return null; }
      if (!['skel', 'atlas', 'textures', 'pma'].includes(k)) warnings.push(`${pathText(at)}.${k} is not a field of a Spine model (ignored)`);
    }
    if (!fileOk(v.skel, ['.skel'], [...at, 'skel'])) return null;
    const dir = v.skel.replace(/[^/]*$/, '');
    const name = v.skel.slice(dir.length, -'.skel'.length);
    const atlas = v.atlas === undefined ? `${dir}${name}.atlas` : v.atlas;
    if (!fileOk(atlas, ['.atlas'], [...at, 'atlas'])) return null;
    if (atlas !== `${dir}${name}.atlas`) { problems.push(`${pathText(at)}.atlas: ${atlas} — the atlas sits next to its skeleton with the same name (${dir}${name}.atlas): pixi-spine looks for it there`); return null; }
    const textures = v.textures === undefined ? [`${dir}${name}.png`] : v.textures;
    if (!Array.isArray(textures) || !textures.length || textures.length > 64) { problems.push(`${pathText(at)}.textures: not a list of 1–64 page images`); return null; }
    for (const [i, t] of textures.entries()) {
      if (!fileOk(t, IMAGE, [...at, 'textures', String(i)])) return null;
      if (!t.startsWith(dir)) { problems.push(`${pathText(at)}.textures: ${t} is outside the atlas's folder (${dir || 'the plugin folder'}) — its pages are found next to it`); return null; }
    }
    if (v.pma !== undefined && typeof v.pma !== 'boolean') { problems.push(`${pathText(at)}.pma: not true or false`); return null; }
    const model = [v.skel, atlas, ...new Set(textures)];
    for (const rel of model) addFile(rel);
    models.push(model);
    return { skel: v.skel, atlas, textures: [...new Set(textures)], pma: v.pma === true };
  };

  /**
   * One value of a record (see the header).
   * @param {AssetKind} kind @param {unknown} v @param {{ container: string[], key: string, field: string[] }} loc
   */
  const readValue = (kind, v, loc) => {
    const at = [...loc.container, loc.key, ...loc.field];
    if (ops.length >= VISUAL_LIMITS.ops) { if (ops.length === VISUAL_LIMITS.ops) problems.push(`more than ${VISUAL_LIMITS.ops} writes`); return; }
    if (isObj(v) && has(v, 'ref')) {
      const key = /** @type {any} */ (v).ref;
      if (!isAssetKey(key)) { problems.push(`${pathText(at)}: { "ref": ${short(key)} } does not name an entry`); return; }
      const from = [...loc.container, key, ...loc.field];
      if (vanilla && getPath(vanilla, from) === undefined) {
        problems.push(`${pathText(at)}: { "ref": "${key}" } — this installation's art manifest (data/assets.json) has no ${from.join('.')}`);
        return;
      }
      ops.push({ at, ref: key, from });
      const clear = localModelClear(loc);
      if (clear) ops.push(clear);
      const rest = Object.keys(v).filter((k) => k !== 'ref');
      if (!rest.length) return;
      if (typeof kind === 'string') { problems.push(`${pathText(at)}: a reference to a ${kindName(kind)} takes no other key (${rest.join(', ')})`); return; }
      readFields(kind, Object.fromEntries(rest.map((k) => [k, v[k]])), loc);
      return;
    }
    if (kind === 'image' || kind === 'audio') {
      if (fileOk(v, kind === 'image' ? IMAGE : AUDIO, at)) { ops.push({ at, file: /** @type {string} */ (v) }); addFile(v); }
      return;
    }
    if (kind === 'audioList') {
      if (typeof v === 'string') { if (fileOk(v, AUDIO, at)) { ops.push({ at, file: v }); addFile(v); } return; }
      if (!Array.isArray(v) || !v.length || v.length > VISUAL_LIMITS.listFiles) { problems.push(`${pathText(at)}: not an audio file or a list of 1–${VISUAL_LIMITS.listFiles}`); return; }
      if (v.every((rel, i) => fileOk(rel, AUDIO, [...at, String(i)]))) { ops.push({ at, files: [...v] }); for (const rel of v) addFile(rel); }
      return;
    }
    if (kind === 'track') {
      const tr = /** @type {any} */ (v);
      if (!isObj(tr) || tr.loop === undefined) { problems.push(`${pathText(at)}: not a track { "loop", "intro"? } or a reference`); return; }
      for (const k of Object.keys(tr)) if (k !== 'loop' && k !== 'intro') warnings.push(`${pathText(at)}.${k} is not a field of a track (ignored)`);
      if (!fileOk(tr.loop, AUDIO, [...at, 'loop']) || (tr.intro !== undefined && !fileOk(tr.intro, AUDIO, [...at, 'intro']))) return;
      ops.push({ at, track: { loop: tr.loop, ...(tr.intro !== undefined ? { intro: tr.intro } : {}) } });
      addFile(tr.loop);
      if (tr.intro !== undefined) addFile(tr.intro);
      return;
    }
    if (kind === 'spine') {
      if (!isObj(v) || typeof /** @type {any} */ (v).skel !== 'string') { problems.push(`${pathText(at)}: not a Spine model { "skel", "atlas", "textures" } or a reference`); return; }
      const spine = readSpine(v, at);
      if (spine) {
        ops.push({ at, spine });
        const clear = localModelClear(loc);
        if (clear) ops.push(clear);
      }
      return;
    }
    if (!isObj(v)) { problems.push(`${pathText(at)}: ${short(v)} is not an object of fields (${'fields' in kind ? Object.keys(kind.fields).join(', ') : 'keyed entries'})`); return; }
    readFields(kind, /** @type {Record<string, unknown>} */ (v), loc);
  };

  /** The fields of an object kind. @param {any} kind @param {Record<string, unknown>} obj @param {{ container: string[], key: string, field: string[] }} loc */
  const readFields = (kind, obj, loc) => {
    for (const [k, x] of Object.entries(obj)) {
      const at = [...loc.container, loc.key, ...loc.field, k];
      const sub = kind.fields ? (has(kind.fields, k) ? kind.fields[k] : undefined) : kind.key.test(k) && !FORBIDDEN.has(k) ? kind.each : undefined;
      if (!sub) { warnings.push(`${pathText(at)} is not a field a cosmetic plugin changes (ignored)`); continue; }
      readValue(sub, x, { ...loc, field: [...loc.field, k] });
    }
  };

  /** The tree of sections down to the containers. */
  const walk = (node, obj, path) => {
    for (const [k, x] of Object.entries(obj)) {
      const at = [...path, k];
      const next = has(node, k) ? node[k] : null;
      if (!next) { warnings.push(`${pathText(at)} is not something a cosmetic plugin changes (ignored)`); continue; }
      if (!isObj(x)) { problems.push(`${pathText(at)}: not an object`); continue; }
      const c = /** @type {AssetContainer | undefined} */ (next.$container);
      if (!c) { walk(next, x, at); continue; }
      for (const [key, v] of Object.entries(x)) {
        if (!isAssetKey(key)) { problems.push(`${pathText(at)}: ${short(key)} is not an entry key (letters, digits, _ . / -)`); continue; }
        if (c.keys && !c.keys.includes(key)) { warnings.push(`${pathText([...at, key])} is not one of ${c.keys.join(', ')} (ignored)`); continue; }
        readValue(c.record, v, { container: c.path, key, field: [] });
      }
    }
  };
  walk(TREE, assets, []);

  // what the writes need: an entry of the installation's manifest → assets.override, a new one → assets.add
  if (vanilla && Array.isArray(permissions)) {
    const told = new Set();
    for (const op of ops) {
      if (op.implied) continue;
      const depth = ASSET_CONTAINERS.find((c) => c.path.every((k, i) => op.at[i] === k))?.path.length ?? 1;
      const exists = getPath(vanilla, op.at.slice(0, depth + 1)) !== undefined;
      const need = exists ? 'assets.override' : 'assets.add';
      if (!permissions.includes(need) && !told.has(need)) {
        told.add(need);
        problems.push(`${pathText(op.at)}: ${exists ? 'changes an entry of this installation\'s manifest' : 'adds an entry'} — needs the permission "${need}"`);
      }
    }
  }
  return { ops, files, models, problems, warnings };
}

// ---- plugin.lock.json -------------------------------------------------------------------------------------------------

const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isNumList = (v) => Array.isArray(v) && v.length <= 256 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * @typedef {{ files: Record<string, { sha256: string, bytes: number }>, spine: Record<string, SpineMeta & { sha256: string }> }} PluginLock
 */

/**
 * Read plugin.lock.json (tools/plugin.mjs pack): `{ lock: 1, id, version, generator, files: { <path>: { sha256, bytes } },
 * spine: { <skel path>: { sha256, anims, animations, events, hits, bounds } } }`. A broken lock is a problem; it is only
 * ever needed for Spine models (attachSpineMeta).
 * @param {unknown} raw
 * @returns {{ lock: PluginLock | null, problems: string[] }}
 */
export function readPluginLock(raw) {
  const problems = [];
  const bad = (why) => { problems.push(`${LOCK_FILE}: ${why} — write it again with node tools/plugin.mjs pack`); return { lock: null, problems }; };
  if (!isObj(raw)) return bad('not a JSON object');
  const r = /** @type {any} */ (raw);
  if (r.lock !== LOCK_VERSION) return bad(`"lock": ${short(r.lock)} is not ${LOCK_VERSION}`);
  /** @type {PluginLock} */
  const lock = { files: {}, spine: {} };
  for (const [rel, f] of Object.entries(isObj(r.files) ? r.files : {})) {
    if (!isPackPath(rel) || !isObj(f) || !isHex64(f.sha256) || !Number.isInteger(f.bytes) || f.bytes < 0) return bad(`files.${short(rel)} is not { sha256, bytes }`);
    lock.files[rel] = { sha256: f.sha256, bytes: f.bytes };
  }
  for (const [rel, s] of Object.entries(isObj(r.spine) ? r.spine : {})) {
    const ok = isPackPath(rel) && isObj(s) && isHex64(s.sha256) && isObj(s.anims) && isObj(s.animations)
      && Object.values(s.animations).every((d) => typeof d === 'number' && Number.isFinite(d))
      && Array.isArray(s.events) && s.events.every((e) => typeof e === 'string')
      && isObj(s.hits) && Object.values(s.hits).every(isNumList)
      && (s.bounds === null || (isObj(s.bounds) && ['x', 'y', 'width', 'height'].every((k) => typeof s.bounds[k] === 'number' && Number.isFinite(s.bounds[k]))));
    if (!ok) return bad(`spine.${short(rel)} is not the data of a skeleton`);
    lock.spine[rel] = { sha256: s.sha256, anims: s.anims, animations: s.animations, events: s.events, hits: s.hits, bounds: s.bounds };
  }
  return { lock, problems };
}

/**
 * Give every Spine model of the ops its clip data from the lock — when the lock's entry was made from the skeleton the
 * folder holds now (its SHA-256); else a problem (a missing or stale lock).
 * @param {AssetOp[]} ops
 * @param {PluginLock | null} lock
 * @param {(rel: string) => string | null} sha the SHA-256 of a file of the plugin
 * @returns {{ ops: AssetOp[], problems: string[] }}
 */
export function attachSpineMeta(ops, lock, sha) {
  const problems = [];
  const out = ops.map((op) => {
    if (!op.spine) return op;
    const e = lock?.spine?.[op.spine.skel];
    if (!e) { problems.push(`${pathText(op.at)}: ${LOCK_FILE} has no clip data for ${op.spine.skel} — run node tools/plugin.mjs pack`); return op; }
    if (e.sha256 !== sha(op.spine.skel)) { problems.push(`${pathText(op.at)}: ${LOCK_FILE} was made from another ${op.spine.skel} — run node tools/plugin.mjs pack again`); return op; }
    const { anims, animations, events, hits, bounds } = e;
    return { ...op, spine: { ...op.spine, meta: { anims, animations, events, hits, bounds } } };
  });
  return { ops: out, problems };
}

// ---- URLs, resolution, merge ------------------------------------------------------------------------------------------

/** The served URL of a plugin file: /p/<id>/<hash8>/<path>, every segment URL-encoded. */
export const pluginFileUrl = (id, hash8, rel) => `${PLUGIN_FILES_URL}${id}/${hash8}/${String(rel).split('/').map(encodeURIComponent).join('/')}`;

/** The hash of a Spine model: the SHA-256 of its files' SHA-256s, one per line (skeleton, atlas, pages). @param {string[]} shas */
export const modelHashOf = (shas) => sha256Hex(shas.join('\n'));

/**
 * Resolve the ops of one plugin: its files to their served URLs, its references to the values of `base` (see the header).
 * @param {AssetOp[]} ops
 * @param {{ id: string, sha: (rel: string) => string | null, base: any }} ctx
 *   sha: the SHA-256 of a file of the plugin; base: the manifest references read (the served one)
 * @returns {{ ops: ResolvedOp[], problems: string[] }}
 */
export function resolveOps(ops, { id, sha, base }) {
  const problems = [];
  /** @type {ResolvedOp[]} */
  const out = [];
  const url = (rel, hash) => pluginFileUrl(id, String(hash).slice(0, FILE_URL_DIGITS), rel);
  const fileUrl = (rel) => { const h = sha(rel); if (!h) problems.push(`${rel}: not hashed`); return h ? url(rel, h) : null; };
  for (const op of ops) {
    if (op.ref !== undefined) {
      const v = getPath(base, op.from || []);
      if (v === undefined) { problems.push(`${pathText(op.at)}: { "ref": "${op.ref}" } — the manifest has no ${(op.from || []).join('.')}`); continue; }
      out.push({ at: op.at, value: cloneJson(v) });
    } else if (op.file !== undefined) {
      const u = fileUrl(op.file);
      if (u) out.push({ at: op.at, value: u });
    } else if (op.files) {
      const list = op.files.map(fileUrl);
      if (list.every(Boolean)) out.push({ at: op.at, value: list });
    } else if (op.track) {
      const loop = fileUrl(op.track.loop);
      const intro = op.track.intro !== undefined ? fileUrl(op.track.intro) : null;
      if (loop && (op.track.intro === undefined || intro)) out.push({ at: op.at, value: intro ? { intro, loop } : { loop } });
    } else if (op.clear) {
      out.push({ at: op.at, value: undefined });
    } else if (op.spine) {
      const s = op.spine;
      const shas = [s.skel, s.atlas, ...s.textures].map((rel) => sha(rel));
      if (shas.some((h) => !h)) { problems.push(`${pathText(op.at)}: a file of the model is not hashed`); continue; }
      if (!s.meta) { problems.push(`${pathText(op.at)}: no clip data (${LOCK_FILE})`); continue; }
      const m = modelHashOf(shas);
      out.push({ at: op.at, value: {
        skel: url(s.skel, m), atlas: url(s.atlas, m), textures: s.textures.map((rel) => url(rel, m)), pma: s.pma,
        anims: cloneJson(s.meta.anims), animations: cloneJson(s.meta.animations), events: [...s.meta.events], hits: cloneJson(s.meta.hits),
        bounds: s.meta.bounds ? { ...s.meta.bounds } : null,
      } });
    }
  }
  return { ops: out, problems };
}

/**
 * Lay resolved ops over a manifest: each value written whole at its path, the objects on the way copied — neither the
 * manifest nor an op's value is ever changed in place (a later op inside an earlier one's value copies it first). A path
 * through a name of Object.prototype is skipped. An undefined value takes the entry away (as JSON writes it: absent).
 * @param {any} manifest
 * @param {ResolvedOp[]} ops
 * @returns {any} the new manifest
 */
export function applyOps(manifest, ops) {
  const root = isObj(manifest) ? { ...manifest } : {};
  const fresh = new WeakSet([root]);
  for (const op of Array.isArray(ops) ? ops : []) {
    const at = op && Array.isArray(op.at) ? op.at : null;
    if (!at || !at.length || at.some((k) => typeof k !== 'string' || FORBIDDEN.has(k))) continue;
    let node = root;
    for (let i = 0; i < at.length - 1; i++) {
      const cur = has(node, at[i]) ? node[at[i]] : undefined;
      const next = isObj(cur) && fresh.has(cur) ? cur : isObj(cur) ? { ...cur } : {};
      fresh.add(next);
      node[at[i]] = next;
      node = next;
    }
    if (op.value === undefined) delete node[at[at.length - 1]];
    else node[at[at.length - 1]] = op.value;
  }
  return root;
}

/**
 * @typedef {{ code: 'override', params: { path: string, plugins: string[] } }} OverrideWarning
 *   two plugins of a set change the same thing — the same path, or one inside the other; the later one applies
 */

/**
 * The ops of a set's plugins in load order (one list), and an override warning wherever a plugin changes what an
 * earlier one's change in effect there — the same path, or one inside the other (at most VISUAL_LIMITS.warnings, one
 * per path and pair).
 * @template {{ at: string[] }} T
 * @param {{ id: string, ops: T[] }[]} plugins in load order
 * @returns {{ ops: T[], warnings: OverrideWarning[] }}
 */
export function mergePluginOps(plugins) {
  const key = (at) => at.join('\u0001');
  const owner = new Map();          // path key → the plugin whose write there is in effect (the last one)
  const below = new Map();          // path key → the keys written strictly inside it
  const ops = [];
  /** @type {OverrideWarning[]} */
  const warnings = [];
  const seen = new Set();
  const warn = (at, earlier, later) => {
    const k = `${key(at)}\u0002${earlier}\u0002${later}`;
    if (seen.has(k) || warnings.length >= VISUAL_LIMITS.warnings) return;
    seen.add(k);
    warnings.push({ code: 'override', params: { path: at.join('.'), plugins: [earlier, later] } });
  };
  for (const { id, ops: list } of plugins) {
    // checked against the earlier plugins only: a plugin never conflicts with itself; an implied write is the
    // consequence of one that is checked
    for (const op of list) {
      if (/** @type {any} */ (op).implied) { ops.push(op); continue; }
      const at = op.at;
      for (let n = 1; n <= at.length; n++) {
        const o = owner.get(key(at.slice(0, n)));
        if (o !== undefined && o !== id) warn(at, o, id);
      }
      for (const d of below.get(key(at)) || []) { const o = owner.get(d); if (o !== undefined && o !== id) warn(at, o, id); }
      ops.push(op);
    }
    for (const op of list) {
      if (/** @type {any} */ (op).implied) continue;
      const k0 = key(op.at);
      owner.set(k0, id);
      for (let n = 1; n < op.at.length; n++) {
        const k = key(op.at.slice(0, n));
        if (!below.has(k)) below.set(k, new Set());
        below.get(k).add(k0);
      }
    }
  }
  return { ops, warnings };
}

// ---- the visual hash and the served documents ----------------------------------------------------------------------

/**
 * @typedef {{ id: string, version: string, files: Record<string, string> }} VisualOverlay
 * @typedef {{ v: number, assets: string, overlays: VisualOverlay[] }} VisualComposition
 */

/**
 * The input of the visual hash (see the header), in its canonical shape.
 * @param {{ assets: string, overlays?: VisualOverlay[] }} parts assets: the SHA-256 of data/assets.json
 * @returns {VisualComposition}
 */
export function visualHashInput({ assets, overlays = [] }) {
  return { v: VISUAL_HASH_VERSION, assets: String(assets), overlays: overlays.map((o) => ({ id: String(o.id), version: String(o.version), files: { ...o.files } })) };
}

/** The visual hash `vs` of a set (see the header): 64 lowercase hex digits. @param {{ assets: string, overlays?: VisualOverlay[] }} parts */
export const visualHashOf = (parts) => sha256Hex(canonicalJson(visualHashInput(parts)));

/**
 * The check a browser runs on a visual set's document (/vs/<vs16>/assets.json or overlay.json, its `visual` block
 * `{ v, vs, assets, overlays }`): the composition hashes to the `vs` the room (or the catalogue) named. null when it
 * does, else what is wrong.
 * @param {any} doc the parsed document
 * @param {string} vs the expected visual hash (64 hex)
 * @returns {string | null}
 */
export function checkVisualDoc(doc, vs) {
  if (!isVisualHash(vs)) return 'no visual hash to check against';
  const v = isObj(doc) ? doc.visual : null;
  if (!isObj(v) || v.v !== VISUAL_HASH_VERSION || typeof v.assets !== 'string' || !Array.isArray(v.overlays)) return 'not a visual set document';
  if (v.vs !== vs) return `the document names another set (${String(v.vs).slice(0, 16)})`;
  try {
    if (visualHashOf({ assets: v.assets, overlays: v.overlays }) !== vs) return 'its composition does not hash to its vs';
  } catch {
    return 'its composition is not plain data';
  }
  return null;
}
