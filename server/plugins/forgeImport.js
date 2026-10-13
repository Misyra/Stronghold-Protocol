// server/plugins/forgeImport.js — import a Forge workshop pack as one or more of our plugins (DESIGN §32.12,
// docs/PLUGINS.md §16). Forge packs are untrusted: this module only reads bytes. It never import()s, eval()s or
// require()s a file from the pack, and it never copies a script into the plugin it writes.
//
// A pack is a directory or a zip with pack.json at the root (a single wrapping folder is stripped, the same layout
// Forge's own importer accepts). What can be said in our manifest 2 becomes a plugin; everything else is named in
// IMPORT-REPORT.md with a reason in Chinese and in English.
//
// [ASSUMED] choices the author must confirm, also listed in the report:
//   * voices (Forge's default dub, which Forge documents as Japanese) → audio.voiceJp; voiceLangs.cn → audio.voice;
//     en/kr have no table here.
//   * skins[] collapse onto one overlay of that operator. Our cosmetic plugin has no wardrobe.
//   * DEFENDER / HEAVY / GUARDIAN → TANK, VANGUARD → PIONEER, GUARD → WARRIOR.
//   * A missing position is MELEE for tank/warrior/pioneer and RANGED otherwise.
//   * Forge form ranks are not our normal/elite pair: the lowest rank becomes normal, the highest elite (one rank
//     is copied into both).
//   * A missing range grid becomes [[0, 0]].
//   * Shop tier follows rarity when it is 1–6.
//   * Rarity below 6 cannot enter the 自选 pool; the operator is emitted as chess and the report says so.
//   * A skill script (.js) is never read as code. The operator gets kit "generic" and the report names the file.
//     A JSON object that passes validateSkillSpec is kept as kit.spec. No DSL part is written: declaring one makes
//     this version skip the plugin (PLUGIN_DSL_UNAVAILABLE).
//   * A flat { msgid: string } translation becomes a lang plugin. A { version: 1, files } document is content i18n
//     only when every leaf replaces an existing string. zh is the source language and is not a lang plugin.
//   * art.audio is not a documented Forge table. Tracks whose shape matches are still written: bgm lobby|prep|combat|
//     unite|boss, bossBgm as { loop }, sfx.ui / sfx.battle as one file, sfx.units attack|hit|skill|die|born and
//     skills|attacks|hits by index. Any other audio key is named and left out.
//   * client.panels: screen.game.hud and screen.game.aside → hud.right, screen.result.footer → result.tab, and only
//     when the panel does not wrap a component. The page is a stub; the author rewrites it to postMessage API v1.
//     The panel's script is not copied.
//   * Several products share the pack id. content keeps it; a cosmetic beside it is <id>-look; a ui plugin is
//     <id>-<slot>; a lang plugin is <id>-<lang>. --out names the primary folder and its id.
//   * dependencies / conflicts become requires / conflicts when the id becomes a plugin id. An omitted range is "*".
//   * The importer does not look for official art, same as the packer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from './zip.js';
import { checkPluginFolder, packPlugin } from './pack.js';
import { createPluginRegistry } from './registry.js';
import { buildContentSet } from './contentSet.js';
import { createVisualSets } from './visualSet.js';
import { PLUGIN_LIMITS, PLUGIN_MANIFEST, UI_SLOT_IDS, extOf, isPackPath, isPluginId, checkJsonLimits } from '../../shared/plugins/manifest.js';
import { ASSET_CONTAINERS, getPath, isAssetKey, readAssetOverlay } from '../../shared/plugins/visual.js';
import { namespace } from '../../shared/plugins/dataUtils.js';
import { validateSkillSpec } from '../../shared/plugins/skillSpec.js';
import { canonicalLang, languageName, SOURCE_LANG } from '../../shared/i18nPacks.js';

const APP_RANGE = '>=0.3.0 <0.4.0';
const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.webp']);
const AUDIO_EXT = new Set(['.mp3', '.ogg']);
const STAT_KEYS = ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'bat', 'aspd', 'respawnTime', 'spRecovery', 'hpRecoveryPerSec', 'moveSpeed', 'tauntLevel', 'massLevel', 'deployLimit', 'deckStack'];
const PROFESSIONS = new Set(['PIONEER', 'WARRIOR', 'TANK', 'SNIPER', 'CASTER', 'MEDIC', 'SUPPORT', 'SPECIAL']);
const PROFESSION_ALIAS = { DEFENDER: 'TANK', HEAVY: 'TANK', GUARDIAN: 'TANK', VANGUARD: 'PIONEER', GUARD: 'WARRIOR' };
const MELEE = new Set(['TANK', 'WARRIOR', 'PIONEER']);
const VOICE_SLOT = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const PANEL_SLOT = { 'screen.game.hud': 'hud.right', 'screen.game.aside': 'hud.right', 'screen.result.footer': 'result.tab' };
const CONTENT_NAMES = ['chess', 'units', 'items', 'enemies', 'stages', 'waves', 'tokens', 'bosses', 'factions', 'garrisons', 'bands', 'bonds', 'effects', 'choices'];
const PATCH_TABLE = {
  bonds: 'bonds', enemies: 'enemies', chess: 'chess', items: 'items', stages: 'stages', waves: 'waves', bands: 'bands',
  effects: 'effects', tokens: 'tokens', garrisons: 'garrisons', bosses: 'bosses', factions: 'factions', choices: 'choices',
};
const CHAR_FIELDS = new Set(['avatar', 'avatarE2', 'portrait', 'portraitE2']);
const SKIP_TOP = {
  server: ['这是服务端逻辑（会改协议或对局），不能导入。', 'This is server logic (it would change the protocol or the match) and cannot be imported.'],
  routes: ['没有只读的 HTTP 路由这类插件，不能导入。', 'There is no read-only HTTP-route plugin class, so this cannot be imported.'],
  assets: ['这是要替换的引擎资源容器（.spresources），不是一张能叠加的图，不能导入。', 'This replaces an engine resource container (.spresources), not a picture the overlay can carry, so it cannot be imported.'],
  forms: ['这是动画形态的行为声明，不是素材文件，不能导入。', 'This declares clip-set behaviour, not an asset file, so it cannot be imported.'],
  fx: ['这是特效相位的行为声明，不能导入。', 'This declares effect-phase behaviour and cannot be imported.'],
  variants: ['这是引擎里的口径开关，不是模式数据，不能导入。', 'This is an engine variant switch, not mode data, so it cannot be imported.'],
  behaviour: ['这是引擎里已经写死的行为开关，不能导入。', 'This selects an engine behaviour switch and cannot be imported.'],
  playtest: ['这是试玩名单，不是可以带进对局的数据，不能导入。', 'This is a playtest list, not data a match can load, so it cannot be imported.'],
  support: ['这是助战卡池规则，不是干员数据，不能导入。', 'This is the assist-pool rule, not operator data, so it cannot be imported.'],
  combat: ['这是战斗引擎的开关，不是数据，不能导入。', 'This is a combat-engine flag, not data, so it cannot be imported.'],
  layer: ['这是 Forge 的加载层声明，我们的清单没有这一格，不能导入。', 'This is Forge\'s loader-layer flag. Our manifest has no such field, so it cannot be imported.'],
};

/** @param {string} code @param {string} detail */
export class ForgeImportError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
    this.detail = detail;
  }
}
const fail = (code, detail) => { throw new ForgeImportError(code, detail); };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Recursively sort object keys so --json is byte-stable. Arrays keep their order. */
export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isObj(value)) return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = stableJson(value[k]);
  return out;
}

/**
 * A Forge pack id (or a --id) as a plugin id: lower case, "_" → "-", other runs → one "-".
 * @param {unknown} raw
 * @returns {string | null}
 */
export function forgeIdToPluginId(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return isPluginId(s) ? s : null;
}

function rangeOk(v) {
  if (v === '*') return true;
  if (typeof v !== 'string' || !v.trim() || v.length > 60) return false;
  const token = /^(\*|x|(\^|~|>=|<=|>|<|=)?v?\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?)$/;
  return v.trim().split(/\s+/).every((t) => token.test(t));
}

function fit(base, suffix) {
  const room = 32 - suffix.length;
  if (room < 2) return null;
  const stem = base.slice(0, room).replace(/-+$/g, '');
  if (stem.length < 2) return null;
  const id = `${stem}${suffix}`;
  return isPluginId(id) ? id : null;
}

/** @param {string} base @param {string[]} roles @param {string | null} primaryName */
function allocateIds(base, roles, primaryName) {
  const primary = roles.includes('content') ? 'content' : roles.includes('cosmetic') ? 'cosmetic' : roles[0];
  if (primaryName && !isPluginId(primaryName)) return { error: `"${primaryName}" is not a plugin id` };
  const used = new Set();
  const take = (want) => {
    let id = want;
    let n = 2;
    while (!id || !isPluginId(id) || used.has(id)) {
      const tail = `-${n++}`;
      const stem = String(want || base).slice(0, 32 - tail.length).replace(/-+$/g, '');
      id = `${stem}${tail}`;
      if (n > 80) return null;
    }
    used.add(id);
    return id;
  };
  /** @type {Record<string, string>} */
  const ids = {};
  ids[primary] = take(primaryName || base);
  for (const role of roles) {
    if (ids[role]) continue;
    let suffix = '-x';
    if (role === 'cosmetic') suffix = '-look';
    else if (role.startsWith('ui:')) suffix = `-${role.slice(3).replace(/\./g, '-')}`;
    else if (role.startsWith('lang:')) suffix = `-${role.slice(5).toLowerCase()}`;
    const id = take(fit(primaryName || base, suffix) || fit(base, suffix));
    if (!id) return { error: `no plugin id left for ${role}` };
    ids[role] = id;
  }
  return { ids, primary };
}

function unsafeZipName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return 'empty name or NUL';
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return 'absolute path';
  const parts = name.split(/[/\\]/);
  if (parts.some((p) => p === '..' || p === '.')) return 'path escapes the pack';
  if (name.includes('\\')) return 'backslash in the name';
  return null;
}

/** A file map the caller already read (the studio upload). Same name and size rules as a zip; nothing is executed. */
function assertSafeNames(files) {
  if (!(files instanceof Map)) fail('PLUGIN_FORGE_INPUT', 'files are not a map');
  if (files.size > PLUGIN_LIMITS.files) fail('PLUGIN_FORGE_ZIP', `more than ${PLUGIN_LIMITS.files} files`);
  let total = 0;
  for (const [name, data] of files) {
    const why = unsafeZipName(name);
    if (why) fail('PLUGIN_FORGE_ZIP', `${String(name).slice(0, 80)}: ${why}`);
    if (!Buffer.isBuffer(data)) fail('PLUGIN_FORGE_INPUT', `${String(name).slice(0, 80)}: not bytes`);
    total += data.length;
    if (data.length > PLUGIN_LIMITS.pluginBytes || total > PLUGIN_LIMITS.pluginBytes) fail('PLUGIN_FORGE_ZIP', `${String(name).slice(0, 80)}: larger than ${PLUGIN_LIMITS.pluginBytes} bytes`);
  }
}

function moveDir(from, dest) {
  try { fs.renameSync(from, dest); }
  catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    fs.cpSync(from, dest, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function inflateCapped(raw, cap) {
  return new Promise((resolve, reject) => {
    const inf = zlib.createInflateRaw();
    const chunks = [];
    let total = 0;
    let failed = false;
    const stop = (e) => { if (failed) return; failed = true; try { inf.destroy(); } catch { /* already closed */ } reject(e); };
    inf.on('data', (c) => {
      if (failed) return;
      total += c.length;
      if (total > cap) { stop(new ForgeImportError('PLUGIN_FORGE_ZIP', `uncompressed size exceeds ${cap} bytes`)); return; }
      chunks.push(Buffer.from(c));
    });
    inf.on('error', (e) => stop(new ForgeImportError('PLUGIN_FORGE_ZIP', `deflate: ${e.message}`)));
    inf.on('end', () => { if (!failed) resolve(Buffer.concat(chunks, total)); });
    inf.end(raw);
  });
}

/**
 * Entries of an untrusted zip: central-directory names only, no symlink, no path escape, sizes capped at PLUGIN_LIMITS.
 * A single wrapping directory that itself holds pack.json is removed.
 * @param {Buffer} zip
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function readUntrustedZip(zip) {
  if (!Buffer.isBuffer(zip) || zip.length < 22) fail('PLUGIN_FORGE_ZIP', 'not a zip archive');
  if (zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])) || zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))) fail('PLUGIN_FORGE_ZIP', 'ZIP64 is not accepted');
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0 || endAt + 22 > zip.length) fail('PLUGIN_FORGE_ZIP', 'not a zip archive');
  const count = zip.readUInt16LE(endAt + 10);
  const cdSize = zip.readUInt32LE(endAt + 12);
  const cdOff = zip.readUInt32LE(endAt + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) fail('PLUGIN_FORGE_ZIP', 'ZIP64 is not accepted');
  if (count > PLUGIN_LIMITS.files) fail('PLUGIN_FORGE_ZIP', `more than ${PLUGIN_LIMITS.files} files`);
  if (cdOff + cdSize > zip.length) fail('PLUGIN_FORGE_ZIP', 'central directory is outside the file');
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let p = cdOff;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) fail('PLUGIN_FORGE_ZIP', 'broken central directory');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const rawSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const external = zip.readUInt32LE(p + 38);
    const local = zip.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > zip.length) fail('PLUGIN_FORGE_ZIP', 'broken central directory');
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (extraLen >= 4) {
      const extra = zip.subarray(p - commentLen - extraLen, p - commentLen);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e);
        const sz = extra.readUInt16LE(e + 2);
        if (id === 0x0001) fail('PLUGIN_FORGE_ZIP', 'ZIP64 is not accepted');
        e += 4 + sz;
      }
    }
    if (name.endsWith('/')) continue;
    const why = unsafeZipName(name);
    if (why) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: ${why}`);
    const mode = (external >>> 16) & 0o170000;
    if (mode === 0o120000) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: symbolic link`);
    if (flags & 0x1) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: encrypted`);
    if (flags & 0x8) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: data descriptor (size not in the header)`);
    if (rawSize > PLUGIN_LIMITS.pluginBytes || compSize > PLUGIN_LIMITS.pluginBytes) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: larger than ${PLUGIN_LIMITS.pluginBytes} bytes`);
    if (total + rawSize > PLUGIN_LIMITS.pluginBytes) fail('PLUGIN_FORGE_ZIP', `more than ${PLUGIN_LIMITS.pluginBytes} bytes uncompressed`);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: broken local header`);
    const lName = zip.readUInt16LE(local + 26);
    const lExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + lName + lExtra;
    if (start + compSize > zip.length) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: truncated`);
    const stored = zip.subarray(start, start + compSize);
    let data;
    if (method === 0) {
      if (stored.length !== rawSize) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: stored size does not match`);
      data = Buffer.from(stored);
    } else if (method === 8) {
      data = await inflateCapped(stored, rawSize);
      if (data.length !== rawSize) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: uncompressed size does not match`);
    } else fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: compression method ${method} is not supported`);
    if (crc32(data) !== crc) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: CRC mismatch`);
    if (files.has(name)) fail('PLUGIN_FORGE_ZIP', `${name.slice(0, 80)}: duplicate name`);
    files.set(name, data);
    total += data.length;
  }
  return stripWrapper(files);
}

/** @param {Map<string, Buffer>} files */
function stripWrapper(files) {
  if (files.has('pack.json')) return files;
  const tops = new Set([...files.keys()].map((n) => n.split('/')[0]));
  if (tops.size !== 1) return files;
  const top = [...tops][0];
  if (!files.has(`${top}/pack.json`)) return files;
  const out = new Map();
  for (const [n, d] of files) if (n.length > top.length + 1) out.set(n.slice(top.length + 1), d);
  return out;
}

/**
 * A directory of untrusted files. Symbolic links are refused (not followed). Sizes use PLUGIN_LIMITS.
 * @param {string} dir
 * @returns {Map<string, Buffer>}
 */
export function readUntrustedDir(dir) {
  let root;
  try { root = fs.realpathSync(dir); } catch { fail('PLUGIN_FORGE_INPUT', 'not a directory'); }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) fail('PLUGIN_FORGE_ZIP', 'the pack directory is a symbolic link');
  if (!st.isDirectory()) fail('PLUGIN_FORGE_INPUT', 'not a directory');
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let count = 0;
  let total = 0;
  const walk = (abs, rel) => {
    const cur = fs.lstatSync(abs);
    if (cur.isSymbolicLink()) fail('PLUGIN_FORGE_ZIP', `${rel || '.'}: symbolic link`);
    if (cur.isDirectory()) {
      if (rel && rel.split('/').length > 32) fail('PLUGIN_FORGE_ZIP', `${rel}: nested too deep`);
      for (const name of fs.readdirSync(abs)) {
        if (name === '.' || name === '..') continue;
        walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (!cur.isFile()) fail('PLUGIN_FORGE_ZIP', `${rel}: not a regular file`);
    count += 1;
    if (count > PLUGIN_LIMITS.files) fail('PLUGIN_FORGE_ZIP', `more than ${PLUGIN_LIMITS.files} files`);
    if (cur.size > PLUGIN_LIMITS.pluginBytes || total + cur.size > PLUGIN_LIMITS.pluginBytes) fail('PLUGIN_FORGE_ZIP', `${rel}: larger than ${PLUGIN_LIMITS.pluginBytes} bytes`);
    const why = unsafeZipName(rel);
    if (why) fail('PLUGIN_FORGE_ZIP', `${rel}: ${why}`);
    files.set(rel, fs.readFileSync(abs));
    total += cur.size;
  };
  walk(root, '');
  return stripWrapper(files);
}

function readJsonBuf(buf, label) {
  if (buf.length > PLUGIN_LIMITS.jsonBytes) fail('PLUGIN_FORGE_JSON', `${label}: larger than ${PLUGIN_LIMITS.jsonBytes} bytes`);
  let value;
  try { value = JSON.parse(buf.toString('utf8')); } catch (e) { fail('PLUGIN_FORGE_JSON', `${label}: ${e instanceof SyntaxError ? e.message : e.code || 'unreadable'}`); }
  const bad = checkJsonLimits(value);
  if (bad) fail('PLUGIN_FORGE_JSON', `${label}: ${bad}`);
  return value;
}

function lookup(files, rel) {
  const norm = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || unsafeZipName(norm)) return null;
  if (files.has(norm)) return norm;
  if (files.has(`assets/${norm}`)) return `assets/${norm}`;
  return null;
}

function destOf(rel) {
  const clean = String(rel).split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const under = clean.startsWith('files/') ? clean : `files/${clean}`;
  return isPackPath(under) ? under : null;
}

/** @param {Map<string, Buffer>} files @param {Set<string>} used @param {unknown} rel */
function takeMedia(files, used, rel, kind) {
  if (typeof rel !== 'string') return null;
  const found = lookup(files, rel);
  if (!found) return null;
  const ext = extOf(found);
  const ok = kind === 'image' ? IMAGE_EXT.has(ext) : kind === 'audio' ? AUDIO_EXT.has(ext) : kind === 'spine' ? (ext === '.skel' || ext === '.atlas' || IMAGE_EXT.has(ext)) : false;
  if (!ok) return { error: ext || 'no extension' };
  const dest = destOf(found);
  if (!dest) return { error: 'path' };
  used.add(found);
  return { src: found, dest, data: files.get(found) };
}

function setAt(root, keys, value) {
  let n = root;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObj(n[keys[i]])) n[keys[i]] = {};
    n = n[keys[i]];
  }
  n[keys[keys.length - 1]] = value;
}

function textOf(v, depth = 0) {
  if (depth > 8) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map((x) => textOf(x, depth + 1)).filter(Boolean).join('\n');
  if (!isObj(v)) return '';
  const preferred = ['title', 'text', 'body', 'name', 'credit', 'credits', 'content'];
  const parts = [];
  for (const k of preferred) if (typeof v[k] === 'string') parts.push(v[k].trim());
  if (!parts.length) for (const x of Object.values(v)) { const t = textOf(x, depth + 1); if (t) parts.push(t); }
  return parts.join('\n');
}

function noticeText(files, used, value) {
  if (typeof value === 'string') {
    const found = lookup(files, value);
    if (!found) return value.trim().slice(0, 800);
    used.add(found);
    const buf = files.get(found);
    if (extOf(found) === '.json') return textOf(readJsonBuf(buf, found)).slice(0, 800);
    return buf.toString('utf8').trim().slice(0, 800);
  }
  return textOf(value).slice(0, 800);
}

function semverOf(v) {
  return typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(v.trim()) ? v.trim() : null;
}

function slug(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  return t || 'x';
}

function namespaced(prefix, pluginId, hint, seen) {
  const base = `${prefix}_${namespace(pluginId)}_${slug(hint)}`;
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}_${n++}`;
  seen.add(id);
  return id.length <= 64 ? id : id.slice(0, 64).replace(/_+$/g, '');
}

function loadTableFile(files, used, name) {
  for (const rel of [`${name}.json`, `data/${name}.json`, `content/${name}.json`]) {
    if (!files.has(rel)) continue;
    used.add(rel);
    return readJsonBuf(files.get(rel), rel);
  }
  return null;
}

function asMap(doc, idField) {
  if (Array.isArray(doc)) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const r of doc) {
      if (!isObj(r)) continue;
      const id = r[idField] || r.id || r.key;
      if (typeof id === 'string' && id) out[id] = r;
    }
    return out;
  }
  return isObj(doc) ? doc : {};
}

function leafOps(vanilla, partial, path, out, notes) {
  if (out.length > 2000) return;
  if (Array.isArray(partial)) {
    if (!Array.isArray(vanilla)) { notes.push(path.join('.')); return; }
    for (let i = 0; i < partial.length; i++) {
      if (i >= vanilla.length) { notes.push(`${path.join('.')}[${i}]`); continue; }
      leafOps(vanilla[i], partial[i], [...path, i], out, notes);
    }
    return;
  }
  if (isObj(partial)) {
    if (!isObj(vanilla)) { notes.push(path.join('.') || '(root)'); return; }
    for (const k of Object.keys(partial)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (!has(vanilla, k)) { notes.push([...path, k].join('.')); continue; }
      leafOps(vanilla[k], partial[k], [...path, k], out, notes);
    }
    return;
  }
  const same = (typeof partial === 'number' && typeof vanilla === 'number') || (typeof partial === 'string' && typeof vanilla === 'string') || (typeof partial === 'boolean' && typeof vanilla === 'boolean');
  if (!same) { if (path.length) notes.push(path.join('.')); return; }
  if (typeof partial === 'number' && (!Number.isFinite(partial) || Math.abs(partial) > PLUGIN_LIMITS.number)) { notes.push(path.join('.')); return; }
  if (partial !== vanilla && path.length) out.push({ path, value: partial });
}

function finiteStats(src, baseStats) {
  if (!isObj(src)) return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of STAT_KEYS) {
    if (!has(src, k) || typeof src[k] !== 'number' || !Number.isFinite(src[k])) continue;
    if (baseStats && has(baseStats, k) && typeof baseStats[k] !== 'number') continue;
    out[k] = src[k];
  }
  return Object.keys(out).length ? out : null;
}

function gridOf(v) {
  if (!Array.isArray(v) || !v.length || v.length > 1024) return null;
  const out = [];
  for (const cell of v) {
    if (!Array.isArray(cell) || cell.length < 2 || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) return null;
    if (Math.abs(cell[0]) > 64 || Math.abs(cell[1]) > 64) return null;
    out.push([cell[0], cell[1]]);
  }
  return out;
}

function formOrder(keys) {
  const nums = keys.every((k) => /^-?\d+$/.test(k));
  return [...keys].sort((a, b) => (nums ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Read a pack already in memory and describe the plugins it would become. Does not write.
 * @param {Map<string, Buffer>} files
 * @param {{ id?: string, dataDir?: string, vanilla?: { manifest?: any } | null }} [opts]
 */
export function planForgeImport(files, { id: idOverride, dataDir, vanilla } = {}) {
  if (!files.has('pack.json')) fail('PLUGIN_FORGE_INPUT', 'no pack.json');
  const pack = readJsonBuf(files.get('pack.json'), 'pack.json');
  if (!isObj(pack)) fail('PLUGIN_FORGE_INPUT', 'pack.json is not an object');
  const base = forgeIdToPluginId(idOverride || pack.id);
  if (!base) fail('PLUGIN_FORGE_ID', `pack id "${String(pack.id ?? '').slice(0, 40)}"`);
  /** @type {Set<string>} */
  const used = new Set(['pack.json']);
  /** @type {{ path: string, zh: string, en: string, code?: string }[]} */
  const skipped = [];
  /** @type {{ what: string, zh: string, en: string }[]} */
  const assumed = [];
  const skip = (p, zh, en, code) => skipped.push({ path: p, zh, en, ...(code ? { code } : {}) });
  const assume = (what, zh, en) => { if (!assumed.some((a) => a.what === what)) assumed.push({ what, zh, en }); };

  const version = semverOf(pack.version) || '0.1.0';
  if (!semverOf(pack.version)) assume('version', `版本「${String(pack.version ?? '').slice(0, 40)}」不是语义化版本，写成 ${version}。`, `Version "${String(pack.version ?? '').slice(0, 40)}" is not semver, so it was written as ${version}.`);
  const packName = typeof pack.name === 'string' && pack.name.trim() ? pack.name.trim().slice(0, 60) : base;
  let description = typeof pack.description === 'string' ? pack.description.trim().slice(0, 500) : '';
  let credits = '';
  if (isObj(pack.notices)) {
    try {
      if (pack.notices.announcements != null) {
        const t = noticeText(files, used, pack.notices.announcements);
        if (t) description = `${description}${description ? '\n' : ''}${t}`.slice(0, 500);
      }
      if (pack.notices.credits != null) credits = noticeText(files, used, pack.notices.credits).slice(0, 500);
    } catch (e) {
      if (e instanceof ForgeImportError) throw e;
      skip('notices', '公告或鸣谢读不了，没有写入清单。', 'Announcements or credits could not be read, so they were not written into the manifest.');
    }
  }
  const authors = typeof pack.author === 'string' && pack.author.trim() ? [pack.author.trim().slice(0, 80)] : [];
  const license = typeof pack.license === 'string' ? pack.license.trim().slice(0, 80) : '';

  /** @type {Record<string, string>} */
  const requires = {};
  /** @type {Record<string, string>} */
  const conflicts = {};
  for (const [field, dest] of [['dependencies', requires], ['conflicts', conflicts]]) {
    const list = pack[field];
    if (list == null) continue;
    if (!Array.isArray(list)) { skip(`pack.json:${field}`, '依赖声明不是列表，没有导入。', 'The dependency declaration is not a list, so it was not imported.'); continue; }
    for (const item of list) {
      const rawId = isObj(item) ? item.id : item;
      const pid = forgeIdToPluginId(rawId);
      const range = isObj(item) && rangeOk(item.range) ? String(item.range).trim() : '*';
      if (!pid) { skip(`${field}:${String(rawId ?? '').slice(0, 40)}`, '这个 id 变不成插件 id，没有写成依赖。', 'This id cannot become a plugin id, so it was not written as a dependency.'); continue; }
      if (isObj(item) && item.range != null && !rangeOk(item.range)) assume(`range-${pid}`, `「${pid}」的版本范围写不进我们的清单，改成 *。`, `The version range of "${pid}" does not fit our manifest, so it was written as *.`);
      dest[pid] = range;
    }
  }

  for (const key of Object.keys(SKIP_TOP)) {
    if (pack[key] == null) continue;
    if (key === 'combat' && pack.combat !== true) continue;
    const [zh, en] = SKIP_TOP[key];
    skip(`pack.json:${key}`, zh, en);
  }
  for (const key of Object.keys(pack)) {
    if (['id', 'name', 'version', 'author', 'license', 'description', 'gameVersion', 'game', 'api', 'content', 'overrides', 'voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'art', 'skins', 'operators', 'i18n', 'notices', 'target', 'dependencies', 'conflicts', 'client', ...Object.keys(SKIP_TOP)].includes(key)) continue;
    skip(`pack.json:${key}`, '我们的导入器不认识这个字段，没有导入。', 'The importer does not know this field, so it was not imported.');
  }
  if (pack.target != null && pack.target !== 'forge') skip('pack.json:target', `目标引擎是「${String(pack.target).slice(0, 40)}」，不是我们这一份。能对上的数据仍会导入，对不上的留在报告里。`, `The pack targets "${String(pack.target).slice(0, 40)}", not this game. Pieces that map are still imported; the rest stay in the report.`);

  const manifestArt = vanilla?.manifest ?? null;
  /** @type {Record<string, any>} */
  const assets = {};
  /** @type {Map<string, Buffer>} */
  const media = new Map();
  /** @type {string[]} */
  const importedAssets = [];
  /** @type {string[]} */
  const rewrittenAssets = [];
  const remember = (src, dest) => { if (!media.has(dest)) media.set(dest, files.get(src)); };

  const putImage = (container, key, field, rel) => {
    const got = takeMedia(files, used, rel, 'image');
    if (!got) { skip(String(rel), '声明了图片，但包里没有这个文件，没有导入。', 'An image was declared, but that file is not in the pack, so it was not imported.'); return; }
    if (got.error) { skip(String(rel), `图片扩展名 ${got.error} 不能放进外观插件，没有导入。`, `Image extension ${got.error} cannot go in a cosmetic plugin, so it was not imported.`); return; }
    const at = field ? [...container, key, ...field] : [...container, key];
    setAt(assets, at, got.dest);
    remember(got.src, got.dest);
    importedAssets.push(`${at.join('.')} ← ${got.src}`);
  };
  const putAudio = (container, key, slot, rels) => {
    const list = (Array.isArray(rels) ? rels : [rels]).filter((r) => typeof r === 'string');
    const dests = [];
    for (const rel of list.slice(0, 16)) {
      const got = takeMedia(files, used, rel, 'audio');
      if (!got || got.error) { skip(String(rel), '语音或音效文件不在包里，或扩展名不是 .mp3 / .ogg，没有导入。', 'The voice or sound file is missing, or it is not .mp3 / .ogg, so it was not imported.'); continue; }
      dests.push(got.dest);
      remember(got.src, got.dest);
    }
    if (!dests.length) return;
    setAt(assets, [...container, key, slot], dests.length === 1 ? dests[0] : dests);
    importedAssets.push(`${container.join('.')}.${key}.${slot} ← ${list.slice(0, dests.length).join(', ')}`);
  };
  const putSpine = (container, key, field, spec) => {
    if (!isObj(spec) || typeof spec.skel !== 'string') { skip(`${container.join('.')}.${key}`, '模型声明不完整（需要 skel），没有导入。', 'The model declaration is incomplete (skel is required), so it was not imported.'); return; }
    const skel = takeMedia(files, used, spec.skel, 'spine');
    const atlasRel = typeof spec.atlas === 'string' ? spec.atlas : spec.skel.replace(/\.skel$/i, '.atlas');
    const atlas = takeMedia(files, used, atlasRel, 'spine');
    if (!skel || skel.error || skel.dest && extOf(skel.dest) !== '.skel' || !atlas || atlas.error || extOf(atlas.dest) !== '.atlas') {
      skip(spec.skel, '模型的 skel 或 atlas 不在包里，没有导入。', 'The model\'s skel or atlas is not in the pack, so it was not imported.');
      return;
    }
    const dir = skel.dest.replace(/[^/]*$/, '');
    const name = skel.dest.slice(dir.length, -'.skel'.length);
    const atlasDest = `${dir}${name}.atlas`;
    if (atlas.dest !== atlasDest) {
      skip(spec.skel, 'atlas 必须和 skel 同目录同名，没有导入这个模型。', 'The atlas must sit next to the skel with the same name, so this model was not imported.');
      return;
    }
    const textures = [];
    const declared = Array.isArray(spec.textures) ? spec.textures : [`${spec.skel.replace(/\.skel$/i, '.png')}`];
    for (const rel of declared) {
      const page = takeMedia(files, used, rel, 'image');
      if (!page || page.error) { skip(String(rel), '模型的贴图页不在包里，没有导入这个模型。', 'A model page is not in the pack, so this model was not imported.'); return; }
      if (!page.dest.startsWith(dir)) { skip(String(rel), '模型的贴图页必须和 skel 在同一目录，没有导入。', 'A model page must sit in the skel\'s folder, so this model was not imported.'); return; }
      textures.push(page.dest);
      remember(page.src, page.dest);
    }
    remember(skel.src, skel.dest);
    remember(atlas.src, atlas.dest);
    const value = { skel: skel.dest, atlas: atlasDest, ...(textures.length ? { textures } : {}), ...(spec.pma === true ? { pma: true } : {}) };
    setAt(assets, [...container, key, ...field], value);
    if (spec.anims != null) assume('spine-anims', '模型上的 anims 没有照抄：剪辑由 plugin.lock.json 从骨架里读。', 'anims on a model were not copied: clip data is read from the skeleton into plugin.lock.json.');
    importedAssets.push(`${[...container, key, ...field].join('.')} ← ${skel.src}`);
  };

  const art = isObj(pack.art) ? pack.art : {};
  if (isObj(art.chars)) for (const [key, rec] of Object.entries(art.chars)) {
    if (!isObj(rec)) continue;
    for (const field of CHAR_FIELDS) if (typeof rec[field] === 'string') putImage(['chars'], key, [field], rec[field]);
    if (isObj(rec.spine)) {
      if (isObj(rec.spine.front)) putSpine(['chars'], key, ['spine', 'front'], rec.spine.front);
      if (isObj(rec.spine.back)) putSpine(['chars'], key, ['spine', 'back'], rec.spine.back);
    }
    for (const k of Object.keys(rec)) if (!CHAR_FIELDS.has(k) && k !== 'spine') skip(`art.chars.${key}.${k}`, '这个立绘字段我们的外观叠加没有，没有导入。', 'The cosmetic overlay has no such portrait field, so it was not imported.');
  }
  if (isObj(art.enemies)) for (const [key, rec] of Object.entries(art.enemies)) {
    if (!isObj(rec)) continue;
    if (typeof rec.icon === 'string') putImage(['enemies'], key, ['icon'], rec.icon);
    if (isObj(rec.spine)) putSpine(['enemies'], key, ['spine'], rec.spine);
  }
  if (isObj(art.tokens)) for (const [key, rec] of Object.entries(art.tokens)) {
    if (!isObj(rec)) continue;
    if (typeof rec.avatar === 'string') putImage(['tokens'], key, ['avatar'], rec.avatar);
    if (isObj(rec.spine)) putSpine(['tokens'], key, ['spine'], rec.spine);
    if (rec.owner != null) skip(`art.tokens.${key}.owner`, 'token 的 owner 不是素材，没有导入。', 'A token\'s owner is not an asset, so it was not imported.');
  }
  const flatArt = { skills: ['skills'], bonds: ['bonds'], bands: ['bands'], items: ['items'], modules: ['modules'], ui: ['ui'], profSub: ['prof', 'sub'] };
  for (const [table, container] of Object.entries(flatArt)) {
    if (!isObj(art[table])) continue;
    for (const [key, rel] of Object.entries(art[table])) if (typeof rel === 'string') putImage(container, key, null, rel);
  }
  if (isObj(pack.bondIcons)) {
    for (const [key, rel] of Object.entries(pack.bondIcons)) {
      if (isObj(art.bonds) && has(art.bonds, key)) { skip(`bondIcons.${key}`, '同一个盟约已经在 art.bonds 里，bondIcons 这一条没有再导入。', 'That bond is already in art.bonds, so this bondIcons entry was not imported again.'); continue; }
      if (typeof rel === 'string') putImage(['bonds'], key, null, rel);
    }
  }
  if (isObj(pack.itemIcons)) for (const [key, rel] of Object.entries(pack.itemIcons)) if (typeof rel === 'string') putImage(['items'], key, null, rel);

  const putVoices = (table, container, block) => {
    if (!isObj(block)) return;
    for (const [charId, lines] of Object.entries(block)) {
      if (!isObj(lines)) continue;
      for (const [slot, rel] of Object.entries(lines)) {
        if (!VOICE_SLOT.test(slot)) { skip(`${table}.${charId}.${slot}`, '语音槽位名字不符合规则，没有导入。', 'The voice-slot name does not match the rule, so it was not imported.'); continue; }
        putAudio(container, charId, slot, rel);
      }
    }
  };
  if (pack.voices != null) {
    assume('voices-jp', 'Forge 的 voices 是默认配音，文档写的是日文，所以写入 audio.voiceJp。', 'Forge voices are the default dub, documented as Japanese, so they were written to audio.voiceJp.');
    putVoices('voices', ['audio', 'voiceJp'], pack.voices);
    rewrittenAssets.push('voices → audio.voiceJp');
  }
  if (isObj(pack.voiceLangs)) {
    for (const [lang, block] of Object.entries(pack.voiceLangs)) {
      const code = canonicalLang(lang);
      if (code === 'zh' || code === 'cn' || lang === 'cn') {
        assume('voice-cn', 'voiceLangs.cn 写入 audio.voice（中文配音）。', 'voiceLangs.cn was written to audio.voice (the Chinese dub).');
        putVoices(`voiceLangs.${lang}`, ['audio', 'voice'], block);
        rewrittenAssets.push(`voiceLangs.${lang} → audio.voice`);
      } else skip(`voiceLangs.${lang}`, '我们只有 audio.voice 和 audio.voiceJp，这一档配音没有导入。', 'Only audio.voice and audio.voiceJp exist here, so this dub was not imported.');
    }
  }
  if (Array.isArray(pack.skins)) {
    assume('skins', 'Forge 的多套时装收成该干员的一份外观叠加（我们没有衣柜）。', 'Forge\'s several outfits were collapsed into one overlay of that operator (there is no wardrobe here).');
    for (const skin of pack.skins) {
      if (!isObj(skin) || typeof skin.charId !== 'string') { skip('skins', '一条时装没有 charId，没有导入。', 'A skin has no charId, so it was not imported.'); continue; }
      if (isObj(skin.art)) {
        for (const field of CHAR_FIELDS) if (typeof skin.art[field] === 'string') putImage(['chars'], skin.charId, [field], skin.art[field]);
        if (isObj(skin.art.spine?.front)) putSpine(['chars'], skin.charId, ['spine', 'front'], skin.art.spine.front);
      }
      if (isObj(skin.voices)) putVoices(`skins.${skin.id || skin.charId}`, ['audio', 'voiceJp'], { [skin.charId]: skin.voices });
    }
  }

  // BGM / sfx only when the path is clearly one of our track or sfx keys and the pack points at it.
  const bgmKeys = new Set(['lobby', 'prep', 'combat', 'unite', 'boss']);
  const maybeAudioTree = isObj(art.audio) ? art.audio : null;
  if (isObj(maybeAudioTree?.bgm)) {
    assume('art-audio', 'art.audio 不是 Forge 的正式表。形状对得上的音轨和音效仍然写入。', 'art.audio is not an official Forge table. Tracks and sounds whose shape matches were still written.');
    for (const [key, rel] of Object.entries(maybeAudioTree.bgm)) {
      if (!bgmKeys.has(key)) { skip(`art.audio.bgm.${key}`, '背景音乐只接受 lobby、prep、combat、unite、boss，没有导入。', 'Music only accepts lobby, prep, combat, unite and boss, so this was not imported.'); continue; }
      const file = typeof rel === 'string' ? rel : isObj(rel) ? rel.loop : null;
      const got = typeof file === 'string' ? takeMedia(files, used, file, 'audio') : null;
      if (!got || got.error) { skip(`art.audio.bgm.${key}`, '音乐文件不在包里，没有导入。', 'The music file is not in the pack, so it was not imported.'); continue; }
      setAt(assets, ['audio', 'bgm', key], { loop: got.dest });
      remember(got.src, got.dest);
      importedAssets.push(`audio.bgm.${key} ← ${got.src}`);
    }
  }
  const putTrack = (at, rel, label) => {
    const file = typeof rel === 'string' ? rel : isObj(rel) && typeof rel.loop === 'string' ? rel.loop : null;
    if (!file) { skip(label, '音乐要是文件路径，或 { loop }，没有导入。', 'Music must be a file path or { loop }, so it was not imported.'); return false; }
    const got = takeMedia(files, used, file, 'audio');
    if (!got || got.error) { skip(label, '音乐文件不在包里，或扩展名不是 .mp3 / .ogg，没有导入。', 'The music file is missing, or it is not .mp3 / .ogg, so it was not imported.'); return false; }
    const track = { loop: got.dest };
    remember(got.src, got.dest);
    if (isObj(rel) && typeof rel.intro === 'string') {
      const intro = takeMedia(files, used, rel.intro, 'audio');
      if (!intro || intro.error) skip(`${label}#intro`, 'intro 音轨不在包里，没有写入 intro。', 'The intro track is not in the pack, so intro was not written.');
      else { track.intro = intro.dest; remember(intro.src, intro.dest); }
    }
    setAt(assets, at, track);
    importedAssets.push(`${at.join('.')} ← ${got.src}`);
    return true;
  };
  if (isObj(maybeAudioTree?.bossBgm)) {
    assume('art-audio', 'art.audio 不是 Forge 的正式表。形状对得上的音轨和音效仍然写入。', 'art.audio is not an official Forge table. Tracks and sounds whose shape matches were still written.');
    for (const [key, rel] of Object.entries(maybeAudioTree.bossBgm)) {
      if (!isAssetKey(key)) { skip(`art.audio.bossBgm.${String(key).slice(0, 40)}`, 'boss 音乐的 id 不合规，没有导入。', 'The boss-music id is not a valid asset key, so it was not imported.'); continue; }
      putTrack(['audio', 'bossBgm', key], rel, `art.audio.bossBgm.${key}`);
    }
  }
  const sfxUnitAudio = new Set(['attack', 'hit', 'skill', 'die', 'born']);
  const sfxUnitMaps = new Set(['skills', 'attacks', 'hits']);
  if (isObj(maybeAudioTree?.sfx)) {
    assume('art-audio', 'art.audio 不是 Forge 的正式表。形状对得上的音轨和音效仍然写入。', 'art.audio is not an official Forge table. Tracks and sounds whose shape matches were still written.');
    for (const bucket of ['ui', 'battle']) {
      const block = maybeAudioTree.sfx[bucket];
      if (block == null) continue;
      if (!isObj(block)) { skip(`art.audio.sfx.${bucket}`, '音效表不是对象，没有导入。', 'The sound table is not an object, so it was not imported.'); continue; }
      for (const [key, rel] of Object.entries(block)) {
        if (!isAssetKey(key) || typeof rel !== 'string') { skip(`art.audio.sfx.${bucket}.${String(key).slice(0, 40)}`, '音效要是一个 .mp3 / .ogg 路径，没有导入。', 'A sound must be one .mp3 / .ogg path, so it was not imported.'); continue; }
        const got = takeMedia(files, used, rel, 'audio');
        if (!got || got.error) { skip(`art.audio.sfx.${bucket}.${key}`, '音效文件不在包里，或扩展名不是 .mp3 / .ogg，没有导入。', 'The sound file is missing, or it is not .mp3 / .ogg, so it was not imported.'); continue; }
        setAt(assets, ['audio', 'sfx', bucket, key], got.dest);
        remember(got.src, got.dest);
        importedAssets.push(`audio.sfx.${bucket}.${key} ← ${got.src}`);
      }
    }
    if (maybeAudioTree.sfx.units != null && !isObj(maybeAudioTree.sfx.units)) skip('art.audio.sfx.units', '干员音效不是对象，没有导入。', 'Unit sounds are not an object, so they were not imported.');
    if (isObj(maybeAudioTree.sfx.units)) {
      for (const [id, rec] of Object.entries(maybeAudioTree.sfx.units)) {
        if (!isAssetKey(id) || !isObj(rec)) { skip(`art.audio.sfx.units.${String(id).slice(0, 40)}`, '干员音效写得不对，没有导入。', 'This unit-sound entry is not usable, so it was not imported.'); continue; }
        const out = {};
        for (const [field, val] of Object.entries(rec)) {
          if (sfxUnitAudio.has(field) && typeof val === 'string') {
            const got = takeMedia(files, used, val, 'audio');
            if (!got || got.error) { skip(`art.audio.sfx.units.${id}.${field}`, '音效文件不在包里，或扩展名不是 .mp3 / .ogg，没有导入。', 'The sound file is missing, or it is not .mp3 / .ogg, so it was not imported.'); continue; }
            out[field] = got.dest;
            remember(got.src, got.dest);
          } else if (sfxUnitMaps.has(field) && isObj(val)) {
            const map = {};
            for (const [idx, rel] of Object.entries(val)) {
              if (!/^\d{1,2}$/.test(idx) || typeof rel !== 'string') { skip(`art.audio.sfx.units.${id}.${field}.${String(idx).slice(0, 8)}`, '分组音效的序号必须是 0–99，值是一个音频路径，没有导入。', 'A grouped sound index must be 0–99 and its value one audio path, so it was not imported.'); continue; }
              const got = takeMedia(files, used, rel, 'audio');
              if (!got || got.error) { skip(`art.audio.sfx.units.${id}.${field}.${idx}`, '音效文件不在包里，或扩展名不是 .mp3 / .ogg，没有导入。', 'The sound file is missing, or it is not .mp3 / .ogg, so it was not imported.'); continue; }
              map[idx] = got.dest;
              remember(got.src, got.dest);
            }
            if (Object.keys(map).length) out[field] = map;
          } else skip(`art.audio.sfx.units.${id}.${field}`, '这个音效字段对不上（只要 attack、hit、skill、die、born，或 skills / attacks / hits），没有导入。', 'This sound field does not match (attack, hit, skill, die, born, or skills / attacks / hits), so it was not imported.');
        }
        if (Object.keys(out).length) {
          setAt(assets, ['audio', 'sfx', 'units', id], out);
          importedAssets.push(`audio.sfx.units.${id}`);
        }
      }
    }
    for (const k of Object.keys(maybeAudioTree.sfx)) {
      if (k !== 'ui' && k !== 'battle' && k !== 'units') skip(`art.audio.sfx.${k}`, '音效只接受 ui、battle、units，没有导入。', 'Sounds only accept ui, battle and units, so this was not imported.');
    }
  }
  if (isObj(maybeAudioTree)) {
    for (const k of Object.keys(maybeAudioTree)) {
      if (k !== 'bgm' && k !== 'sfx' && k !== 'bossBgm') skip(`art.audio.${k}`, '这个音频字段对不上，没有导入。', 'This audio field does not match, so it was not imported.');
    }
  }

  const dataCache = new Map();
  const table = (name) => {
    if (dataCache.has(name)) return dataCache.get(name);
    let json = null;
    if (dataDir) {
      const file = name === 'units' ? 'backups.json' : name === 'modes' ? 'config.json' : `${name}.json`;
      try { json = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')); } catch { json = null; }
      if (name === 'units') json = json?.units ?? null;
      if (name === 'modes') json = json?.modes ?? null;
    }
    dataCache.set(name, json);
    return json;
  };

  /** @type {any[]} */
  const patches = [];
  /** @type {any[]} */
  const operators = [];
  /** @type {any[]} */
  const enemyRecords = [];
  /** @type {string[]} */
  const importedData = [];
  /** @type {string[]} */
  const rewrittenData = [];
  const seenIds = new Set();
  const overrideKeys = new Set();
  if (Array.isArray(pack.overrides)) for (const e of pack.overrides) {
    if (typeof e !== 'string' || !e.includes(':')) { skip(`overrides:${String(e).slice(0, 40)}`, '覆盖声明要写成「文件:id」，这一条没有导入。', 'An override must be "file:id", so this one was not imported.'); continue; }
    overrideKeys.add(e);
  } else if (pack.overrides != null) skip('overrides', 'overrides 不是列表，没有导入。', 'overrides is not a list, so it was not imported.');

  const declaredContent = Array.isArray(pack.content) ? pack.content.filter((n) => typeof n === 'string') : [];
  for (const name of declaredContent) {
    if (!CONTENT_NAMES.includes(name)) skip(`content:${name}`, '这不是 Forge 的数据文件名，也不能当成模式导入。', 'This is not a Forge data-file name, and it was not imported as a mode.');
  }

  const patchRecord = (file, id, partial) => {
    const prefix = file === 'units' ? ['units', id] : [];
    const vanillaRec = file === 'units' ? table('units')?.[id] : table(file)?.[id];
    if (!vanillaRec) { skip(`${file}:${id}`, '覆盖声明指向的官方记录不存在，没有改。', 'The override names an official record that does not exist, so nothing was changed.'); return; }
    const notes = [];
    const leaves = [];
    leafOps(vanillaRec, partial, prefix, leaves, notes);
    const dataFile = file === 'units' ? 'backups' : file;
    for (const leaf of leaves) {
      if (file === 'units') patches.push({ op: 'set', file: 'backups', path: leaf.path, value: leaf.value });
      else patches.push({ op: 'set', file: dataFile, id, path: leaf.path, value: leaf.value });
    }
    if (leaves.length) importedData.push(`${file}:${id} → ${leaves.length} set`);
    else skip(`${file}:${id}`, '没有类型对得上的字段，没有改这条官方记录。', 'No field kept its type, so this official record was not changed.');
    if (notes.length) skip(`${file}:${id}#${notes.slice(0, 3).join(',')}`, '有些字段对不上官方记录的类型或路径，那些字段没有改。', 'Some fields did not match the official type or path, so those fields were not changed.');
  };

  const mapOperator = (rawId, rec) => {
    if (!isObj(rec)) { skip(`units:${rawId}`, '干员记录不是对象，没有导入。', 'The operator record is not an object, so it was not imported.'); return; }
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 60) : '';
    let profession = typeof rec.profession === 'string' ? rec.profession.trim().toUpperCase() : '';
    if (PROFESSION_ALIAS[profession]) {
      assume(`prof-${profession}`, `职业 ${profession} 写成 ${PROFESSION_ALIAS[profession]}。`, `Profession ${profession} was written as ${PROFESSION_ALIAS[profession]}.`);
      profession = PROFESSION_ALIAS[profession];
    }
    if (!name || !PROFESSIONS.has(profession) || typeof rec.subProfessionId !== 'string' || !rec.subProfessionId.trim()) {
      skip(`units:${rawId}`, '干员缺名字、职业或分支，没有导入。', 'The operator lacks a name, profession or branch, so it was not imported.');
      return;
    }
    if (!Number.isInteger(rec.rarity) || rec.rarity < 1 || rec.rarity > 6) { skip(`units:${rawId}`, '星级不在 1–6，没有导入。', 'Rarity is not from 1 to 6, so it was not imported.'); return; }
    const formsIn = isObj(rec.forms) ? rec.forms : null;
    if (!formsIn) { skip(`units:${rawId}`, '没有形态（forms），没有导入。', 'There are no forms, so it was not imported.'); return; }
    const keys = formOrder(Object.keys(formsIn));
    const picked = keys.map((k) => formsIn[k]).filter((f) => isObj(f) && finiteStats(f.stats || f));
    if (!picked.length) { skip(`units:${rawId}`, '形态里没有能用的数值，没有导入。', 'No form has usable stats, so it was not imported.'); return; }
    const low = picked[0];
    const high = picked[picked.length - 1];
    assume('forms', 'Forge 的形态阶写成我们的 normal / elite：最低一阶是 normal，最高一阶是 elite。', 'Forge form ranks were written as normal / elite: the lowest rank is normal, the highest is elite.');
    const oneForm = (f) => {
      const stats = finiteStats(f.stats || f);
      const grid = gridOf(f.rangeGrid || rec.rangeGrid);
      if (!grid) assume('range', '缺攻击范围，写成 [[0, 0]]。请作者改成真实范围。', 'No attack range was found, so it was written as [[0, 0]]. The author should replace it.');
      return { stats, rangeGrid: grid || [[0, 0]] };
    };
    let position = rec.position === 'MELEE' || rec.position === 'RANGED' ? rec.position : '';
    if (!position) {
      position = MELEE.has(profession) ? 'MELEE' : 'RANGED';
      assume('position', `没有 position，按职业写成 ${position}。`, `No position was set, so it was written as ${position} from the profession.`);
    }
    const pool = isObj(pack.operators) ? pack.operators : {};
    const declared = has(pool, rawId) || has(pool, rec.charId);
    const poolRec = pool[rawId] || pool[rec.charId] || {};
    let as = 'chess';
    if (declared && rec.rarity === 6) as = 'both';
    else if (declared && rec.rarity !== 6) {
      as = 'chess';
      assume('diy-rarity', `「${name}」进了自选声明但不是六星。自选池只要六星，所以写成棋子（chess）。`, `"${name}" is declared for the recruit pool but is not 6★. The pool is 6★ only, so it was written as chess.`);
    }
    const bonds = [...(Array.isArray(poolRec.bonds) ? poolRec.bonds : []), ...(Array.isArray(rec.bonds) ? rec.bonds : [])].filter((b) => typeof b === 'string');
    const bondTable = table('bonds');
    const knownBonds = [...new Set(bonds)].filter((b) => bondTable && has(bondTable, b));
    if (bonds.length && knownBonds.length !== bonds.length) skip(`units:${rawId}#bonds`, '有的盟约在本安装里不存在，那些盟约没有写上。', 'Some bonds do not exist in this installation, so those bonds were not written.');
    if (as !== 'diy' && !knownBonds.length) { skip(`units:${rawId}`, '棋子需要至少一个本安装里存在的盟约，没有导入这个干员。', 'A chess operator needs a bond that exists in this installation, so this operator was not imported.'); return; }
    const charId = namespaced('char_x', base, rawId, seenIds);
    const skillSrc = Array.isArray(rec.skills) ? rec.skills.filter(isObj) : [];
    if (!skillSrc.length) { skip(`units:${rawId}`, '没有技能，不能做成干员，没有导入。', 'There is no skill, so this cannot become an operator and was not imported.'); return; }
    let defaultAt = skillSrc.findIndex((s) => s.default === true);
    if (defaultAt < 0) { defaultAt = 0; assume('skill-default', `「${name}」没有标默认技能，把第一条当成默认。`, `"${name}" marks no default skill, so the first one was used.`); }
    const skills = skillSrc.map((s, i) => {
      const skill = { skillId: namespaced('skx', base, `${rawId}_${i + 1}`, seenIds), name: typeof s.name === 'string' ? s.name.slice(0, 40) : '技能', default: i === defaultAt };
      for (const k of ['duration', 'spCost', 'initSp']) if (typeof s[k] === 'number' && Number.isFinite(s[k])) skill[k] = s[k];
      if (typeof s.desc === 'string') skill.desc = s.desc.slice(0, 200);
      if (isObj(s.bb)) {
        const bb = {};
        for (const [k, v] of Object.entries(s.bb)) if (typeof v === 'number' && Number.isFinite(v)) bb[k] = v;
        if (Object.keys(bb).length) skill.bb = bb;
      }
      return skill;
    });
    let kit = 'generic';
    const spec = isObj(rec.skillSpec) ? rec.skillSpec : isObj(rec.kit?.spec) ? rec.kit.spec : isObj(rec.spec) ? rec.spec : null;
    if (spec && !validateSkillSpec(spec).length) kit = { spec };
    else if (spec) skip(`units:${rawId}#spec`, 'JSON 技能规格没通过校验，改成通用 kit。', 'The JSON skill spec did not validate, so the kit is generic.');
    const kitPath = typeof rec.kit === 'string' ? rec.kit : typeof rec.kit?.script === 'string' ? rec.kit.script : typeof rec.kitFile === 'string' ? rec.kitFile : null;
    if (kit === 'generic') {
      const shown = kitPath || '(no kit file)';
      if (kitPath) {
        const found = lookup(files, kitPath);
        if (found) used.add(found);
      }
      skip(`units:${rawId}#kit`, `技能脚本映射不成 kitRef、JSON SkillSpec 或 DSL，「${name}」用通用 kit（${shown}）。`, `The skill script does not map to a kitRef, a JSON SkillSpec or DSL, so "${name}" uses the generic kit (${shown}).`, 'PLUGIN_FORGE_SCRIPT');
      rewrittenData.push(`${rawId} kit → generic`);
    }
    const op = {
      op: 1, charId, name, profession, subProfessionId: rec.subProfessionId.trim().slice(0, 40), position, rarity: rec.rarity, as,
      forms: { normal: oneForm(low), elite: oneForm(high) }, skills, kit,
    };
    if (as !== 'diy') op.chess = { tier: rec.rarity, bonds: knownBonds.length ? knownBonds : bonds };
    else if (knownBonds.length) op.chess = { bonds: knownBonds };
    if (typeof rec.trait === 'string') op.trait = { desc: rec.trait.slice(0, 120) };
    else if (isObj(rec.trait) && typeof rec.trait.desc === 'string') op.trait = { desc: rec.trait.desc.slice(0, 120) };
    const artRef = typeof rec.artRef === 'string' ? rec.artRef : typeof rec.art === 'string' ? rec.art : null;
    if (artRef && manifestArt?.chars && has(manifestArt.chars, artRef)) op.art = { ref: artRef };
    if (Array.isArray(poolRec.powers) && poolRec.powers.every((p) => typeof p === 'string') && as !== 'chess') op.powers = poolRec.powers.slice(0, 8);
    operators.push(op);
    importedData.push(`units:${rawId} → ${charId}`);
    rewrittenData.push(`${rawId} → ${charId}`);
    return charId;
  };

  for (const name of CONTENT_NAMES) {
    let doc;
    try { doc = loadTableFile(files, used, name); } catch (e) {
      if (e instanceof ForgeImportError) throw e;
      skip(`${name}.json`, '这个数据文件读不了，没有导入。', 'This data file could not be read, so it was not imported.');
      continue;
    }
    if (!doc) {
      if (declaredContent.includes(name)) skip(`content:${name}`, 'content 声明了这个文件，但包里没有对应的 JSON，没有导入。', 'content names this file, but the pack has no such JSON, so it was not imported.');
      continue;
    }
    const idField = name === 'units' ? 'charId' : name === 'enemies' ? 'key' : 'id';
    const map = asMap(doc, idField);
    for (const [id, rec] of Object.entries(map)) {
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      const exists = name === 'units' ? !!(table('units') && has(table('units'), id)) : !!(table(name) && has(table(name), id));
      const declared = overrideKeys.has(`${name}:${id}`);
      if (exists) {
        if (!declared) { skip(`${name}:${id}`, '这条官方记录没有写进 overrides，按 Forge 的规矩不能默默覆盖，没有导入。', 'This official record is not in overrides. Forge refuses a silent replace, so it was not imported.'); continue; }
        if (!PATCH_TABLE[name] && name !== 'units') { skip(`${name}:${id}`, '这张表对不上我们的补丁文件，没有导入。', 'This table does not match a patch file of ours, so it was not imported.'); continue; }
        patchRecord(name, id, rec);
        continue;
      }
      if (name === 'units') { mapOperator(id, isObj(rec) ? { ...rec, charId: rec.charId || id } : rec); continue; }
      if (name === 'enemies' && isObj(rec)) {
        const baseId = typeof rec.base === 'string' ? rec.base : typeof rec.special === 'string' ? rec.special : '';
        const enemies = table('enemies');
        if (!baseId || !enemies || !has(enemies, baseId)) {
          skip(`enemies:${id}`, '新敌人没有写一个本安装里存在的官方 base（或 special），不能凭空造一套技能，没有导入。', 'A new enemy has no official base (or special) that exists in this installation. A kit was not invented, so it was not imported.');
          continue;
        }
        const eid = namespaced('enemy_x', base, id, seenIds);
        const set = {};
        if (typeof rec.name === 'string' && rec.name.trim()) set.name = rec.name.trim().slice(0, 60);
        const stats = finiteStats(rec.stats || rec, enemies[baseId]?.stats);
        if (stats) set.stats = stats;
        enemyRecords.push({ id: eid, base: baseId, ...(rec.special && rec.special !== baseId ? { special: rec.special } : {}), ...(Object.keys(set).length ? { set } : {}) });
        importedData.push(`enemies:${id} → ${eid} (base ${baseId})`);
        rewrittenData.push(`${id} → ${eid}`);
        continue;
      }
      skip(`${name}:${id}`, '新记录没有安全的紧凑映射（模式不是 Forge 的表；其他表只自动导入带官方 base 的敌人和干员，以及已有记录上类型不变的补丁）。', 'A new record has no safe compact mapping (Forge has no mode table; other tables only auto-import enemies with an official base, operators, and type-preserving patches of existing records).');
    }
  }

  /** @type {{ lang: string, strings: Record<string, string>, kind: 'ui' | 'content', doc?: any }[]} */
  const translations = [];
  if (isObj(pack.i18n)) {
    for (const [lang, rel] of Object.entries(pack.i18n)) {
      if (typeof rel !== 'string') { skip(`i18n.${lang}`, '翻译不是一个文件路径，没有导入。', 'The translation is not a file path, so it was not imported.'); continue; }
      const found = lookup(files, rel);
      if (!found) { skip(`i18n.${lang}`, '翻译文件不在包里，没有导入。', 'The translation file is not in the pack, so it was not imported.'); continue; }
      used.add(found);
      let doc;
      try { doc = readJsonBuf(files.get(found), found); } catch (e) {
        if (e instanceof ForgeImportError) throw e;
        skip(found, '翻译文件读不了，没有导入。', 'The translation file could not be read, so it was not imported.');
        continue;
      }
      const code = canonicalLang(lang);
      if (!code) { skip(`i18n.${lang}`, '不是语言代码，没有导入。', 'Not a language code, so it was not imported.'); continue; }
      if (isObj(doc) && doc.version === 1 && canonicalLang(doc.lang) === code && isObj(doc.files)) {
        const badLeaf = contentLeavesBad(doc.files, table);
        if (badLeaf) { skip(found, `翻译要改的词「${badLeaf}」在本安装里不是现成的字符串，整份没有导入（放进内容翻译会让整套数据被拒）。`, `The translation touches "${badLeaf}", which is not an existing string in this installation, so the file was not imported (a bad content translation refuses the whole set).`); continue; }
        translations.push({ lang: code, strings: {}, kind: 'content', doc });
        importedData.push(`i18n:${code} → content`);
        continue;
      }
      if (code === SOURCE_LANG) { skip(found, '中文是原文，不是语言包，没有导入。', 'Chinese is the source language, not a language pack, so it was not imported.'); continue; }
      if (!isObj(doc) || !Object.values(doc).length || Object.values(doc).some((v) => typeof v !== 'string')) {
        skip(found, '翻译既不是界面词条表，也不是内容翻译（version 1），没有导入。', 'The translation is neither a UI string map nor a content translation (version 1), so it was not imported.');
        continue;
      }
      assume('i18n-ui', '扁平的界面词条写成 lang 插件，不写进内容翻译。', 'A flat UI string map was written as a lang plugin, not as content i18n.');
      /** @type {Record<string, string>} */
      const strings = {};
      for (const [k, v] of Object.entries(doc)) if (typeof v === 'string' && k && !k.startsWith('_')) strings[k] = v;
      translations.push({ lang: code, strings, kind: 'ui' });
      importedData.push(`i18n:${code} → lang`);
    }
  }

  /** @type {{ slot: string, module: string, title: string }[]} */
  const panels = [];
  const panelList = Array.isArray(pack.client?.panels) ? pack.client.panels : isObj(pack.client?.panels) ? Object.values(pack.client.panels) : pack.client?.panels != null ? [pack.client.panels] : [];
  const takenSlots = new Set();
  if (pack.client != null && !isObj(pack.client)) skip('client', 'client 不是对象，没有导入。', 'client is not an object, so it was not imported.');
  else if (isObj(pack.client)) {
    for (const k of Object.keys(pack.client)) if (k !== 'panels') skip(`client.${k}`, '除了只读面板，client 里的其他声明不能导入。', 'Apart from a read-only panel, other client declarations cannot be imported.');
  }
  for (const panel of panelList) {
    if (!isObj(panel)) { skip('client.panels', '面板不是对象，没有导入。', 'A panel is not an object, so it was not imported.'); continue; }
    const forgeSlot = typeof panel.slot === 'string' ? panel.slot : '';
    const module = typeof panel.module === 'string' ? panel.module : typeof panel.entry === 'string' ? panel.entry : '';
    const ours = PANEL_SLOT[forgeSlot];
    if (!ours || !UI_SLOT_IDS.includes(ours)) { skip(`client.panels:${forgeSlot || panel.id || '?'}`, '这个挂载点对不上我们的界面插槽（hud.right、result.tab、stats.tab、room.panel），不能导入。', 'This mount does not match our ui slots (hud.right, result.tab, stats.tab, room.panel), so it cannot be imported.'); continue; }
    if (panel.wraps != null || panel.readonly === false || panel.readOnly === false) { skip(`client.panels:${forgeSlot}`, '这个面板会改写页面组件，不是只读的，不能导入。', 'This panel rewrites a page component. It is not read-only, so it cannot be imported.'); continue; }
    if (takenSlots.has(ours)) { skip(`client.panels:${forgeSlot}`, `插槽 ${ours} 已经有一个面板，多出来的不能导入。`, `Slot ${ours} already has a panel, so the extra one cannot be imported.`); continue; }
    takenSlots.add(ours);
    if (module) {
      const found = lookup(files, module);
      if (found) used.add(found);
      skip(`client.panels:${forgeSlot}#module`, `面板脚本 ${module || '(none)'} 没有复制。生成的页面只是骨架，要作者手改成 postMessage API v1。`, `The panel script ${module || '(none)'} was not copied. The generated page is a stub; the author must rewrite it to postMessage API v1.`, 'PLUGIN_FORGE_SCRIPT');
    }
    panels.push({ slot: ours, module, title: typeof panel.name === 'string' ? panel.name.slice(0, 40) : typeof panel.id === 'string' ? panel.id.slice(0, 40) : ours });
    rewrittenAssets.push(`${forgeSlot} → ${ours}`);
  }

  for (const [rel, buf] of files) {
    if (used.has(rel)) continue;
    const ext = extOf(rel);
    if (SCRIPT_EXT.has(ext) || ext === '.spresources') {
      skip(rel, '这是脚本或引擎资源，导入时不执行、也不复制。', 'This is a script or an engine resource. The importer does not run it and does not copy it.', 'PLUGIN_FORGE_SCRIPT');
      continue;
    }
    // an unreferenced audio file whose name is exactly a bgm track
    const baseName = rel.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
    if (AUDIO_EXT.has(ext) && ['lobby', 'prep', 'combat', 'unite', 'boss'].includes(baseName) && !getPath(assets, ['audio', 'bgm', baseName])) {
      const dest = destOf(rel);
      if (dest) {
        assume('loose-bgm', `没有被 pack.json 引用、但文件名是音轨的 ${rel} 写入了 audio.bgm.${baseName}。`, `${rel} is not referenced by pack.json, but its name is a music track, so it was written to audio.bgm.${baseName}.`);
        setAt(assets, ['audio', 'bgm', baseName], { loop: dest });
        media.set(dest, buf);
        used.add(rel);
        importedAssets.push(`audio.bgm.${baseName} ← ${rel}`);
        continue;
      }
    }
    skip(rel, '文件在包里，但 pack.json 没有引用它，没有导入。', 'The file is in the pack, but pack.json does not reference it, so it was not imported.');
  }

  // point new-operator art at the namespaced id when the pack used the old id
  for (const line of rewrittenData) {
    const m = /^(\S+) → (char_x_\S+|enemy_x_\S+)$/.exec(line);
    if (!m) continue;
    const [from, to] = [m[1], m[2]];
    if (to.startsWith('char_x_') && isObj(assets.chars) && has(assets.chars, from) && !has(assets.chars, to)) {
      assets.chars[to] = assets.chars[from];
      delete assets.chars[from];
      rewrittenAssets.push(`art.chars.${from} → ${to}`);
    }
    if (to.startsWith('enemy_x_') && isObj(assets.enemies) && has(assets.enemies, from) && !has(assets.enemies, to)) {
      assets.enemies[to] = assets.enemies[from];
      delete assets.enemies[from];
      rewrittenAssets.push(`art.enemies.${from} → ${to}`);
    }
  }

  let assetNeed = [];
  if (Object.keys(assets).length) {
    const trial = readAssetOverlay(assets, { vanilla: manifestArt, permissions: ['assets.override', 'assets.add'], has: () => true });
    if (trial.problems.length) {
      skip('art', `外观叠加没有通过校验（${trial.problems[0]}），整份外观没有导入。`, `The asset overlay did not pass (${trial.problems[0]}), so none of the art was imported.`);
      for (const k of Object.keys(assets)) delete assets[k];
      media.clear();
    } else if (trial.warnings.length) {
      skip('art', `外观叠加有警告（${trial.warnings[0]}），严格检查通不过，整份外观没有导入。`, `The asset overlay has a warning (${trial.warnings[0]}). Strict check would fail, so none of the art was imported.`);
      for (const k of Object.keys(assets)) delete assets[k];
      media.clear();
    } else if (manifestArt) {
      const need = new Set();
      for (const op of trial.ops) {
        if (op.implied) continue;
        const depth = ASSET_CONTAINERS.find((c) => c.path.every((k, i) => op.at[i] === k))?.path.length ?? 1;
        need.add(getPath(manifestArt, op.at.slice(0, depth + 1)) !== undefined ? 'assets.override' : 'assets.add');
      }
      assetNeed = [...need];
    } else assetNeed = ['assets.add'];
  }

  /** @type {string[]} */
  const roles = [];
  const contentI18n = translations.filter((t) => t.kind === 'content');
  const hasContent = patches.length || operators.length || enemyRecords.length || contentI18n.length;
  if (hasContent) roles.push('content');
  if (Object.keys(assets).length && media.size) roles.push('cosmetic');
  for (const panel of panels) roles.push(`ui:${panel.slot}`);
  for (const t of translations.filter((x) => x.kind === 'ui')) roles.push(`lang:${t.lang}`);

  const meta = { base, packName, version, description, credits, authors, license, requires, conflicts, assets, media, assetNeed, patches, operators, enemyRecords, contentI18n, panels, translations: translations.filter((t) => t.kind === 'ui'), importedAssets, rewrittenAssets, importedData, rewrittenData, skipped, assumed, packId: typeof pack.id === 'string' ? pack.id : base };
  return { meta, roles };
}

function contentLeavesBad(files, table) {
  const walk = (base, overlay, path) => {
    if (typeof overlay === 'string') return typeof getBy(base, path) === 'string' ? null : path.join('.') || '(root)';
    if (!isObj(overlay)) return path.join('.') || '(root)';
    for (const [k, v] of Object.entries(overlay)) {
      const bad = walk(base, v, [...path, k]);
      if (bad) return bad;
    }
    return null;
  };
  const getBy = (node, p) => {
    let n = node;
    for (const k of p) { if (!isObj(n) || !has(n, k)) return undefined; n = n[k]; }
    return n;
  };
  for (const [file, records] of Object.entries(files)) {
    if (!isObj(records)) return file;
    const data = table(file);
    for (const [id, overlay] of Object.entries(records)) {
      if (!data || !has(data, id)) return `${file}.${id}`;
      const bad = walk(data[id], overlay, []);
      if (bad) return `${file}.${id}.${bad}`;
    }
  }
  return null;
}

function manifestCommon(id, meta, extra) {
  /** @type {Record<string, unknown>} */
  const out = {
    $schema: '../../schemas/plugin.schema.json',
    manifest: 2, id,
    name: { zh: meta.packName, en: meta.packName },
    version: meta.version, app: APP_RANGE, api: 1,
    sourceLang: 'zh',
    ...extra,
  };
  if (meta.description) out.description = { zh: meta.description, en: meta.description };
  if (meta.credits) out.credits = meta.credits;
  if (meta.authors.length) out.authors = meta.authors;
  if (meta.license) out.license = meta.license;
  if (Object.keys(meta.requires).length && !Object.keys(meta.requires).includes(id)) out.requires = Object.fromEntries(Object.entries(meta.requires).filter(([k]) => k !== id));
  if (Object.keys(meta.conflicts).length) out.conflicts = Object.fromEntries(Object.entries(meta.conflicts).filter(([k]) => k !== id));
  return out;
}

function uiHtml(slot, title, modulePath) {
  const safeTitle = title.replace(/[<>&]/g, '');
  const note = modulePath ? `Forge module was not copied: ${modulePath.replace(/[<>&]/g, '')}. ` : '';
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>html,body{margin:0;background:transparent;color:#e8e0d0;font:12px/1.4 sans-serif}body{padding:6px}</style>
</head>
<body>
<p>${safeTitle}</p>
<p>这是从 Forge 面板生成的骨架。${note}请手改成 postMessage API v1（welcome → ready，再发 slot / resize）。不要把原来的脚本贴回来。</p>
<script>
window.addEventListener('message', function (ev) {
  var m = ev.data;
  if (!m || m.v !== 1 || m.t !== 'welcome') return;
  parent.postMessage({ v: 1, t: 'ready' }, '*');
});
parent.postMessage({ v: 1, t: 'ready' }, '*');
parent.postMessage({ v: 1, t: 'slot', slot: '${slot}' }, '*');
parent.postMessage({ v: 1, t: 'resize', height: 72 }, '*');
</script>
</body>
</html>
`;
}

function readme(id, cls, lines) {
  return `# ${id}\n\n从 Forge 工坊包导入的 ${cls} 插件。导入器不执行包里的脚本，也不检查官方素材。\n\n${lines.join('\n')}\n\n详细对照见同一次导入的 IMPORT-REPORT.md。界面骨架要手改成 postMessage API v1。\n`;
}

/**
 * @param {ReturnType<typeof planForgeImport>['meta']} meta
 * @param {Record<string, string>} ids
 * @param {string} primaryRole
 */
function buildProducts(meta, ids, primaryRole) {
  /** @type {{ id: string, class: string, role: string, files: Map<string, Buffer | string>, imported: string[], rewritten: string[] }[]} */
  const products = [];
  if (ids.content) {
    const perms = [];
    /** @type {Record<string, unknown>} */
    const man = manifestCommon(ids.content, meta, { class: 'content', scope: ['room'] });
    const files = new Map();
    if (meta.patches.length) {
      perms.push('data.patch');
      man.data = ['data/patch.json'];
      files.set('data/patch.json', `${JSON.stringify({ patch: 1, ops: meta.patches }, null, 2)}\n`);
    }
    if (meta.operators.length) {
      perms.push('data.add');
      man.operators = ['operators/imported.json'];
      files.set('operators/imported.json', `${JSON.stringify(meta.operators.length === 1 ? meta.operators[0] : meta.operators, null, 2)}\n`);
    }
    if (meta.enemyRecords.length) {
      if (!perms.includes('data.add')) perms.push('data.add');
      man.enemies = ['enemies/imported.json'];
      files.set('enemies/imported.json', `${JSON.stringify(meta.enemyRecords.length === 1 ? meta.enemyRecords[0] : meta.enemyRecords, null, 2)}\n`);
    }
    if (meta.contentI18n.length) {
      man.i18n = {};
      for (const t of meta.contentI18n) {
        const rel = `i18n/${t.lang}.json`;
        man.i18n[t.lang] = rel;
        files.set(rel, `${JSON.stringify(t.doc, null, 2)}\n`);
      }
    }
    if (!perms.length && !meta.contentI18n.length) perms.push('data.patch');
    man.permissions = [...new Set(perms)];
    files.set('README.md', readme(ids.content, 'content', ['- 数值补丁、干员和敌人见 data/、operators/、enemies/。', '- 技能脚本没有执行，映射不上的用通用 kit。']));
    products.push({ id: ids.content, class: 'content', role: 'content', files, imported: meta.importedData, rewritten: meta.rewrittenData, manifest: man });
  }
  if (ids.cosmetic) {
    const man = manifestCommon(ids.cosmetic, meta, {
      class: 'cosmetic', scope: ['room', 'personal'], permissions: meta.assetNeed.length ? meta.assetNeed : ['assets.add'], assets: 'assets.json',
    });
    const files = new Map();
    files.set('assets.json', `${JSON.stringify(meta.assets, null, 2)}\n`);
    for (const [rel, buf] of meta.media) files.set(rel, buf);
    files.set('README.md', readme(ids.cosmetic, 'cosmetic', ['- 素材在 assets.json 指向的文件里。', '- Spine 的剪辑由 pack 写入 plugin.lock.json，不要手写 anims。']));
    products.push({ id: ids.cosmetic, class: 'cosmetic', role: 'cosmetic', files, imported: meta.importedAssets, rewritten: meta.rewrittenAssets, manifest: man });
  }
  for (const panel of meta.panels) {
    const role = `ui:${panel.slot}`;
    const id = ids[role];
    if (!id) continue;
    const man = manifestCommon(id, meta, {
      class: 'ui', scope: ['personal'], permissions: ['ui.frame'], entry: { client: 'ui/index.html' }, slots: [panel.slot],
    });
    const files = new Map();
    files.set('ui/index.html', uiHtml(panel.slot, panel.title, panel.module));
    files.set('README.md', readme(id, 'ui', [`- 插槽 ${panel.slot}。`, `- 原面板脚本没有复制${panel.module ? `（${panel.module}）` : ''}。`, '- 请把页面改成 postMessage API v1，不要贴回 Forge 的模块。']));
    products.push({ id, class: 'ui', role, files, imported: [`client.panels → ${panel.slot}`], rewritten: panel.module ? [`${panel.module} → ui/index.html（骨架，未复制脚本）`] : [], manifest: man });
  }
  for (const t of meta.translations) {
    const role = `lang:${t.lang}`;
    const id = ids[role];
    if (!id) continue;
    const man = {
      manifest: 2, id, class: 'lang', lang: t.lang, name: languageName(t.lang), version: meta.version, files: { ui: 'ui.json' },
    };
    const files = new Map();
    files.set('ui.json', `${JSON.stringify(t.strings, null, 2)}\n`);
    files.set('README.md', readme(id, 'lang', [`- 语言 ${t.lang}。`, '- 这是界面词条，不是内容翻译。']));
    products.push({ id, class: 'lang', role, files, imported: [`i18n/${t.lang} → files.ui`], rewritten: [], manifest: man });
  }
  return { products, primaryRole };
}

function reportMarkdown(report) {
  const line = (s) => s || '（无）';
  const bullets = (rows, fmt) => (rows.length ? rows.map(fmt).join('\n') : '- （无）');
  return `# 导入报告 IMPORT-REPORT

来源：${report.pack.id} ${report.pack.name} ${report.pack.version}
写入：${report.wrote ? '是' : '否'}${report.dryRun ? '（dry-run，没有写文件）' : ''}

导入器只读文件，不执行包里的任何脚本，也不拦截官方素材（和打包工具一样，作者自己对素材负责）。

## 导入了什么

${bullets(report.products, (p) => `### ${p.class} \`${p.id}\`\n\n${p.imported.length ? p.imported.map((x) => `- ${x}`).join('\n') : '- （这一类没有条目）'}`)}

## 改成了什么

${bullets(report.products.flatMap((p) => p.rewritten.map((x) => `- \`${p.id}\` ${x}`)), (x) => x)}

## 没有导入

${bullets(report.skipped, (s) => `- \`${s.path}\`：${s.zh} (${s.en})`)}

## 需要作者确认的 [ASSUMED]

${bullets(report.assumed, (a) => `- ${a.zh} (${a.en})`)}

## 检查

${line(report.check)}
`;
}

function publicReport({ meta, products, primaryId, wrote, dryRun, check, issues }) {
  const report = {
    assumed: [...meta.assumed].sort((a, b) => (a.what < b.what ? -1 : a.what > b.what ? 1 : 0)),
    check, dryRun, issues, ok: issues.length === 0, pack: { id: meta.packId, name: meta.packName, version: meta.version },
    primary: primaryId,
    products: products.map((p) => ({
      class: p.class, dir: `plugins/${p.id}`, id: p.id, imported: [...p.imported], permissions: p.manifest.permissions || [], rewritten: [...p.rewritten],
    })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    skipped: [...meta.skipped].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    wrote,
  };
  report.markdown = reportMarkdown(report);
  return report;
}

function writeTree(dir, files, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PLUGIN_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, body] of files) {
    if (rel.split('/').some((s) => !s || s === '.' || s === '..')) fail('PLUGIN_FORGE_ZIP', rel);
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

/**
 * Import a Forge pack.
 * @param {string | { zip?: Buffer, files?: Map<string, Buffer> }} source a directory, a .zip path, or bytes already read
 * @param {{ out?: string, id?: string, dryRun?: boolean, pluginsDir?: string, dataDir?: string, root?: string, vanilla?: { manifest?: any } | null }} [opts]
 *   out: the primary plugin folder. Other products are siblings. dryRun writes nothing there.
 */
export async function importForge(source, opts = {}) {
  const root = opts.root || process.cwd();
  const dataDir = opts.dataDir || path.join(root, 'data');
  const pluginsDir = opts.pluginsDir || path.join(root, 'plugins');
  const dryRun = !!opts.dryRun;
  /** @type {{ code: string, detail: string }[]} */
  const issues = [];
  const empty = (extra) => {
    const report = stableJson({ assumed: [], check: extra.check || '', dryRun, issues, markdown: '', ok: false, pack: { id: '', name: '', version: '' }, primary: null, products: [], skipped: [], wrote: false, ...extra.report });
    report.markdown = extra.markdown || reportMarkdown({ ...report, products: [], skipped: [], assumed: [] });
    return { ok: false, wrote: false, dryRun, issues, report, markdown: report.markdown };
  };
  try {
    let files;
    if (isObj(source) && source.zip) files = await readUntrustedZip(source.zip);
    else if (isObj(source) && source.files) { assertSafeNames(source.files); files = stripWrapper(source.files); }
    else if (typeof source === 'string') {
      const abs = path.resolve(source);
      let st;
      try { st = fs.lstatSync(abs); } catch { fail('PLUGIN_FORGE_INPUT', 'path does not exist'); }
      if (st.isSymbolicLink()) fail('PLUGIN_FORGE_ZIP', 'the pack path is a symbolic link');
      if (st.isDirectory()) files = readUntrustedDir(abs);
      else if (st.isFile()) files = await readUntrustedZip(fs.readFileSync(abs));
      else fail('PLUGIN_FORGE_INPUT', 'not a directory or a zip');
    } else fail('PLUGIN_FORGE_INPUT', 'no pack');
    const vanilla = opts.vanilla || null;
    const planned = planForgeImport(files, { id: opts.id, dataDir, vanilla });
    if (!planned.roles.length) {
      const report = publicReport({ meta: planned.meta, products: [], primaryId: null, wrote: false, dryRun, check: '没有可导入的内容。', issues: [] });
      return { ok: true, wrote: false, dryRun, issues: [], report: stableJson(report), markdown: report.markdown };
    }
    const primaryName = opts.out ? path.basename(path.resolve(opts.out)) : null;
    const alloc = allocateIds(planned.meta.base, planned.roles, primaryName);
    if (alloc.error || !alloc.ids) fail('PLUGIN_FORGE_ID', alloc.error || 'no id');
    const built = buildProducts(planned.meta, alloc.ids, alloc.primary);
    const parent = opts.out ? path.dirname(path.resolve(opts.out)) : pluginsDir;
    for (const p of built.products) {
      const dest = path.join(parent, p.id);
      if (fs.existsSync(dest)) fail('PLUGIN_FORGE_EXISTS', p.id);
    }
    // A dry-run stays in the system temp dir, so plugins/ is not touched. A real write stages in a dot folder of the
    // destination's parent (the registry skips dot folders; rename stays on the same filesystem).
    if (!dryRun) fs.mkdirSync(parent, { recursive: true });
    const stage = fs.mkdtempSync(dryRun ? path.join(os.tmpdir(), 'forge-import-') : path.join(parent, '.forge-import-'));
    /** @type {string[]} */
    const checkLines = [];
    try {
      for (const p of built.products) {
        const dir = path.join(stage, p.id);
        writeTree(dir, p.files, p.manifest);
        const checked = checkPluginFolder(dir, `plugins/${p.id}/`, { vanilla: vanilla || undefined });
        if (checked.problems.length || checked.warnings.length) {
          for (const text of [...checked.problems, ...checked.warnings]) issues.push({ code: 'PLUGIN_INVALID', detail: `${p.id}: ${text}` });
        }
        const packed = packPlugin(dir, { vanilla: vanilla || undefined, where: `plugins/${p.id}/` });
        if (!packed.wrote || packed.build.problems.length) {
          for (const text of packed.build.problems) issues.push({ code: 'PLUGIN_INVALID', detail: `${p.id}: ${text}` });
          if (!packed.wrote && !packed.build.problems.length) issues.push({ code: 'PLUGIN_INVALID', detail: `${p.id}: pack wrote nothing` });
        }
        if (packed.check) {
          for (const text of [...packed.check.problems, ...packed.check.warnings]) {
            const detail = `${p.id}: ${text}`;
            if (!issues.some((i) => i.detail === detail)) issues.push({ code: 'PLUGIN_INVALID', detail });
          }
        }
      }
      if (!issues.length) {
        const registry = createPluginRegistry({
          publicDir: path.join(root, 'public'), packsDir: path.join(root, 'packs'), pluginsDir: stage, dataDir,
        }, { recheckMs: 0, log: { info() {}, warn() {} } });
        const visual = createVisualSets({ registry });
        for (const p of built.products) {
          if (p.class === 'cosmetic') {
            const got = visual.resolve([p.id]);
            if (!got.ok) issues.push({ code: 'PLUGIN_INVALID', detail: `${p.id}: visual set ${got.error || ''} ${got.detail || ''}`.trim() });
            else if (got.set?.problems?.length || got.set?.warnings?.length) issues.push({ code: 'PLUGIN_INVALID', detail: `${p.id}: visual set ${got.set.problems?.length || 0} problems, ${got.set.warnings?.length || 0} warnings` });
          }
          if (p.class === 'content') {
            const set = buildContentSet({ registry, ids: [p.id] });
            if (!set || set.problems?.length) issues.push({ code: set?.problems?.[0]?.code || 'PLUGIN_INVALID', detail: `${p.id}: ${set?.problems?.[0]?.message || set?.problems?.[0]?.code || 'content set failed'}` });
            else if (set.warnings?.length) issues.push({ code: 'PLUGIN_INVALID', detail: `${p.id}: content set ${set.warnings.length} warnings` });
          }
        }
      }
      if (issues.length) {
        checkLines.push(issues.map((i) => `${i.code}: ${i.detail}`).join('\n'));
        const report = publicReport({ meta: planned.meta, products: built.products, primaryId: alloc.ids[alloc.primary], wrote: false, dryRun, check: checkLines.join('\n'), issues });
        return { ok: false, wrote: false, dryRun, issues, report: stableJson(report), markdown: report.markdown };
      }
      const primary = built.products.find((p) => p.role === alloc.primary) || built.products[0];
      const report = publicReport({ meta: planned.meta, products: built.products, primaryId: primary.id, wrote: !dryRun, dryRun, check: 'check --strict 与 pack 通过；外观走 visual set，数据走 content set。', issues: [] });
      const md = report.markdown;
      if (!dryRun) {
        fs.writeFileSync(path.join(stage, primary.id, 'IMPORT-REPORT.md'), md);
        for (const p of built.products) moveDir(path.join(stage, p.id), path.join(parent, p.id));
      }
      return { ok: true, wrote: !dryRun, dryRun, issues: [], report: stableJson(report), markdown: md };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } catch (e) {
    if (e instanceof ForgeImportError) {
      issues.push({ code: e.code, detail: e.detail });
      return empty({ check: `${e.code}: ${e.detail}`, markdown: `# 导入报告 IMPORT-REPORT\n\n没有写入。\n\n- ${e.code}：${e.detail}\n` });
    }
    throw e;
  }
}
