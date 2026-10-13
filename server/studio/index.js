// server/studio/index.js — the plugin studio 插件工作台 (DESIGN §32.9, docs/PLUGINS.md §15; the 0.3.0 plan's interface C5):
// a page in the browser where someone who does not write code makes, previews and packs a cosmetic plugin, and an API
// that experienced authors and AI agents can use the same way. Only for this machine and the local network
// (server/studio/gate.js: a request from anywhere else gets the 404 of a page that does not exist); every file it touches
// is inside plugins/<id>/ (server/studio/files.js).
//
//   GET  /studio/                       the page (public/studio/index.html and its modules under /studio/)
//   GET  /studio/api/info               the version, the templates, the target kinds, the limits, the hot reload
//   GET  /studio/api/targets?q=&kinds=  what a plugin can change, by official name (server/studio/targets.js)
//   GET  /studio/api/slots?template=&target=   the places a template fills for a target (server/studio/templates/)
//   GET  /studio/api/suggest-id?name=&target=&template=   a free plugin id
//   GET  /studio/api/plugins            every plugin folder: name, version, class, loaded or skipped, its findings
//   POST /studio/api/plugins            a new plugin from a template { template, id, name, target, authors, license, credits }
//   GET  /studio/api/plugins/<id>       its manifest, files, sections, findings (coded: shared/plugins/errors.js), lock
//   PUT  /studio/api/plugins/<id>/manifest     plugin.json as a whole (the advanced editor)
//   POST /studio/api/plugins/<id>/meta         basic fields { fields, lang }
//   POST /studio/api/plugins/<id>/sections     what the page edits { sections: [{ template, target }] }
//   POST /studio/api/plugins/<id>/slot         files for a slot { at, files: [{ name, data (base64), role? }], mode? }
//   POST /studio/api/plugins/<id>/ref          a slot borrows the installation's art { at, ref }
//   POST /studio/api/plugins/<id>/clear        a slot emptied { at }
//   POST /studio/api/plugins/<id>/fix          a one-click fix { code, at?, file?, params? }
//   POST /studio/api/plugins/<id>/pack         write plugin.lock.json, check (server/plugins/pack.js)
//   GET  /studio/api/plugins/<id>/zip          the folder as a zip (a download; packs nothing)
//   GET  /studio/api/plugins/<id>/preview      the temporary composition the page previews (server/studio/preview.js)
//   GET  /studio/api/plugins/<id>/f/<hash8>/<path>, …/files/<path>   a file of the folder (a draft's too)
//   PUT / DELETE /studio/api/plugins/<id>/files/<path>                write or remove one file (raw body)
//   POST /studio/api/authors            the page names its game sessions { tokens } — rooms they host apply plugin changes
//                                       by themselves
//   GET  /studio/api/events             server-sent events: { ids } of plugins whose state changed (hot reload)
// A change answers with the plugin's state as GET /studio/api/plugins/<id> does. Errors: `{ error: <code>, params,
// detail }` with an HTTP status (codes of the error catalogue). Every change has the registry read the folders at once
// (server/studio/watch.js rescan) — the rooms using the plugin follow: re-applied by themselves where the host is the
// author (a session the studio's page named) or the only player, else their host is told (P1a's notice). The watch and
// that rule start with the studio's first request (activate): a server whose owner never opens it behaves as before.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION, PLUGIN_API } from '../../shared/constants.js';
import { PLUGIN_MANIFEST, PLUGIN_LIMITS, PLUGIN_IMAGE_EXTS, PLUGIN_AUDIO_EXTS, extOf, isPackPath, isPluginId, readPluginManifest } from '../../shared/plugins/manifest.js';
import { LOCK_FILE, locateAssetPath, readPluginLock } from '../../shared/plugins/visual.js';
import { PLUGIN_ERRORS, isPluginErrorCode, issueList } from '../../shared/plugins/errors.js';
import { sendError, sendJson } from '../http/common.js';
import { MIME, serveFile, CompressCache } from '../http/files.js';
import { checkPluginFolder, packPlugin, zipPlugin } from '../plugins/pack.js';
import { studioAllowed, isStudioChange, studioMode } from './gate.js';
import { createPluginFiles, StudioError, STUDIO_LIMITS } from './files.js';
import { createTargetIndex, searchTargets, targetOf, targetSpec, TARGET_KINDS } from './targets.js';
import { TEMPLATES, templateById, createPlugin, manifestText } from './templates/index.js';
import { keyDir } from './templates/art.js';
import { openPlugin, editMeta, setSlot, clearSlot, filesOfOverlay, filesOfValue, atlasPages, FIXES, getIn } from './edit.js';
import { createPreviews } from './preview.js';
import { createPluginWatcher } from './watch.js';

/** The page's URL prefix and its API's. */
export const STUDIO_URL = '/studio/';
export const STUDIO_API = '/studio/api/';
/** The studio's own notes of a plugin folder (a dot file: never listed, served, checked or packed). */
export const SIDECAR = '.studio.json';
/** How long a game session the page named counts as the author's after the page last named it (ms) [ASSUMED]. */
export const AUTHOR_TTL_MS = 10 * 60 * 1000;
/** Types of the page's own files under public/studio/. */
const PAGE_TYPES = new Set(['.html', '.js', '.css', '.png', '.svg', '.json']);
/** One-click fixes the API runs itself (they move files or pack), beside the manifest edits of edit.js FIXES. */
export const API_FIXES = Object.freeze(['pack', 'moveOut']);

const noopLog = { info() {}, warn() {}, error() {} };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read a request body of at most `limit` bytes (413 beyond it).
 * @param {import('node:http').IncomingMessage} req @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > limit) { reject(new StudioError('PLUGIN_STUDIO_SIZE', 413, { max: `${Math.round(limit / 1048576)} MB` })); req.resume(); return; }
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new StudioError('PLUGIN_STUDIO_SIZE', 413, { max: `${Math.round(limit / 1048576)} MB` })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A JSON request body (an object). @param {import('node:http').IncomingMessage} req @param {number} [limit] */
async function readJson(req, limit = 1024 * 1024) {
  const body = await readBody(req, limit);
  let v;
  try { v = JSON.parse(body.toString('utf8') || '{}'); } catch { throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'the body is not JSON' }); }
  if (!isObj(v)) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'the body is not a JSON object' });
  return v;
}

/** The kind of a file for the page's file list. @param {string} rel */
function fileKind(rel) {
  const e = extOf(rel);
  if (PLUGIN_IMAGE_EXTS.includes(e)) return 'image';
  if (PLUGIN_AUDIO_EXTS.includes(e)) return 'audio';
  if (e === '.skel' || e === '.atlas') return 'spine';
  if (e === '.json') return 'json';
  if (e === '.md' || e === '.txt' || !e) return 'doc';
  return 'other';
}

/**
 * A free plugin id for a new plugin (see GET /studio/api/suggest-id): from the name when it has Latin letters, else from
 * the target's key (char_102_texas → texas) and the template — lower case, digits and '-', 2–32, with -2, -3 … when taken.
 * @param {{ name?: string, target?: { key: string } | null, template?: string }} what @param {Set<string>} taken (lower case)
 */
export function suggestId({ name = '', target = null, template = '' }, taken) {
  const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  let base = slug(name);
  if (base.length < 2 && target) {
    const k = String(target.key).replace(/^(char|enemy|token|trap|band|skchr|sktok)_(\d+_)?/, '');
    base = slug(`${k}${template ? `-${template}` : ''}`);
  }
  if (base.length < 2) base = `plugin${template ? `-${template}` : ''}`;
  base = base.replace(/^-+/, '');
  if (!/^[a-z0-9]/.test(base)) base = `p-${base}`;
  base = base.slice(0, 28).replace(/-+$/, '');
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(id.toLowerCase()) && /^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) return id;
  }
  return null;
}

/**
 * The studio of one server (see the header).
 * @param {{ publicDir: string, pluginsDir: string, dataDir: string,
 *   registry: ReturnType<typeof import('../plugins/registry.js').createPluginRegistry>,
 *   lobby?: { autoApplyPlugins?: Function | null } | null, sessions?: { byToken?: (t: string) => any } | null,
 *   log?: object, trustProxy?: 'auto' | boolean, mode?: 'lan' | 'local' | 'off', watch?: Function }} opts
 *   lobby: the rooms (its autoApplyPlugins is set to the studio's rule); sessions: the session registry (a token the page
 *   names → its player)
 */
export function createStudio({ publicDir, pluginsDir, dataDir, registry, lobby = null, sessions = null, log = noopLog, trustProxy = 'auto', mode = studioMode(), watch }) {
  const pageDir = path.join(path.resolve(publicDir), 'studio');
  const files = createPluginFiles(pluginsDir);
  const targets = createTargetIndex(dataDir);
  const previews = createPreviews({ vanilla: () => registry.vanillaAssets() });
  const compress = new CompressCache();
  /** @type {Map<string, number>} playerId → when the page last named the session */
  const authors = new Map();
  /** @type {Set<import('node:http').ServerResponse>} the event streams of open pages */
  const streams = new Set();
  const send = (ids) => {
    const data = `event: change\ndata: ${JSON.stringify({ ids })}\n\n`;
    for (const res of [...streams]) { try { res.write(data); } catch { streams.delete(res); } }
  };
  const watcher = createPluginWatcher({ pluginsDir, registry, log, onChange: send, ...(watch ? { watch } : {}) });
  const heartbeat = setInterval(() => { for (const res of [...streams]) { try { res.write(': keep-alive\n\n'); } catch { streams.delete(res); } } }, 25000);
  heartbeat.unref?.();

  /**
   * The rooms that apply a change of their plugins by themselves (server/lobby.js autoApplyPlugins): one whose host is
   * the author — a game session this machine's studio page named (POST /studio/api/authors) within AUTHOR_TTL_MS — or
   * whose only player is its host (a single-player room, or a room the host is alone in).
   * @param {{ hostId: string, humans: number }} room
   */
  function autoApply(room) {
    if (!room) return false;
    if (Number(room.humans) <= 1) return true;
    const at = authors.get(room.hostId);
    return at !== undefined && Date.now() - at < AUTHOR_TTL_MS;
  }
  /**
   * The studio in use (its first request through the gate): plugins/ is watched (hot reload) and the lobby follows the
   * studio's rule for its rooms (autoApply) — a server whose owner never opens the studio keeps P1a's behaviour exactly:
   * no watch, every host told.
   */
  let active = false;
  function activate() {
    if (active) return;
    active = true;
    watcher.start();
    if (lobby && 'autoApplyPlugins' in lobby) lobby.autoApplyPlugins = autoApply;
  }

  /** The sections a plugin's page edits: its sidecar's, else read off its overlay (a plugin made by hand). */
  function sectionsOf(id, overlay) {
    try {
      const side = JSON.parse(fs.readFileSync(path.join(files.root(id), SIDECAR), 'utf8'));
      if (isObj(side) && Array.isArray(side.sections)) {
        return side.sections.filter((s) => isObj(s) && templateById(s.template) && typeof s.target === 'string').slice(0, 64).map((s) => ({ template: s.template, target: s.target }));
      }
    } catch { /* none yet */ }
    return inferSections(overlay);
  }

  /** Sections read off an overlay: for each entry it writes, the templates whose slots hold its fields. @param {any} overlay */
  function inferSections(overlay) {
    const { targets: list } = targets();
    const out = [];
    const seen = new Set();
    const add = (template, t) => { const k = `${template}|${targetSpec(t)}`; if (!seen.has(k)) { seen.add(k); out.push({ template, target: targetSpec(t) }); } };
    for (const t of list) {
      const v = getIn(overlay, [...t.container, t.key]);
      if (v === undefined) continue;
      for (const tpl of TEMPLATES) {
        if (!tpl.kinds.includes(t.kind)) continue;
        const slots = tpl.slots(t, targets().manifest);
        if (slots.some((s) => getIn(overlay, s.at) !== undefined)) add(tpl.id, t);
      }
    }
    // voices and unit sounds live under audio, keyed by the operator
    for (const [book, tpl] of [[['audio', 'voice'], 'voice'], [['audio', 'sfx', 'units'], 'audio']]) {
      for (const key of Object.keys(isObj(getIn(overlay, book)) ? getIn(overlay, book) : {})) {
        const t = list.find((x) => x.key === key && ['operator', 'token', 'enemy'].includes(x.kind));
        if (t) add(tpl, t);
      }
    }
    return out;
  }

  /** Save the sections a page edits. */
  function saveSections(id, sections) {
    const clean = (Array.isArray(sections) ? sections : []).filter((s) => isObj(s) && templateById(s.template) && targetOf(targets().targets, s.target))
      .slice(0, 64).map((s) => ({ template: s.template, target: s.target }));
    fs.writeFileSync(path.join(files.root(id), SIDECAR), `${JSON.stringify({ v: 1, sections: clean }, null, 2)}\n`);
    return clean;
  }

  /**
   * A plugin's state (GET /studio/api/plugins/<id>): manifest, its raw text, files (used by the overlay or not), sections,
   * the folder's check with coded issues, the registry's view (loaded, vs), the lock.
   * @param {string} id
   */
  function stateOf(id) {
    const dir = files.root(id);
    let text = null;
    let manifest;
    try { text = fs.readFileSync(path.join(dir, PLUGIN_MANIFEST), 'utf8'); manifest = JSON.parse(text); } catch { manifest = null; }
    const vanilla = registry.vanillaAssets();
    const check = checkPluginFolder(dir, `plugins/${id}/`, { vanilla });
    const read = isObj(manifest) ? readPluginManifest(manifest, { id }) : null;
    const draft = read?.manifest || read?.draft || null;
    let overlay = isObj(manifest?.assets) ? manifest.assets : {};
    if (typeof manifest?.assets === 'string' && isPackPath(manifest.assets)) {
      try { overlay = JSON.parse(fs.readFileSync(files.resolve(id, manifest.assets), 'utf8')); } catch { overlay = {}; }
    }
    const used = filesOfOverlay(overlay);
    const list = files.list(id).filter((f) => !f.link).map((f) => ({ rel: f.rel, bytes: f.bytes, kind: fileKind(f.rel), used: used.has(f.rel) || f.rel === PLUGIN_MANIFEST }));
    const entry = registry.plugin(id);
    let lock = { present: false, fresh: false };
    if (list.some((f) => f.rel === LOCK_FILE)) {
      lock = { present: true, fresh: !check.issues.some((i) => i.code === 'PLUGIN_LOCK_STALE' || i.code === 'PLUGIN_LOCK_MISSING' || i.code === 'PLUGIN_LOCK') };
      try { if (!readPluginLock(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'))).lock) lock.fresh = false; } catch { lock.fresh = false; }
    }
    return {
      id, manifest, text, overlay, class: draft?.class || manifest?.class || null,
      names: draft?.names || {}, version: draft?.version || null, files: list, sections: sectionsOf(id, overlay),
      check: { ok: !check.problems.length, problems: check.problems.length, warnings: check.warnings.length, issues: check.issues },
      loaded: !!(entry && entry.source === 'plugins' && entry.status === 'loaded'), vs: entry?.visual?.vs ?? null, lock,
      bytes: list.reduce((n, f) => n + f.bytes, 0),
    };
  }

  /** Every plugin folder for the list (GET /studio/api/plugins). */
  function listPlugins() {
    const report = registry.report();
    return files.ids().map((id) => {
      let name = id;
      let version = null;
      let cls = null;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(files.root(id), PLUGIN_MANIFEST), 'utf8'));
        const r = readPluginManifest(m, { id });
        const d = r.manifest || r.draft;
        if (d) { name = d.name; version = d.version || null; cls = d.class; }
      } catch { /* no readable manifest: listed by its id */ }
      const entry = registry.plugin(id);
      const skipped = report.skipped.find((k) => k.where === `plugins/${id}/`);
      const loaded = !!(entry && entry.source === 'plugins');
      return {
        id, name, version, class: cls, status: loaded ? entry.status : 'skipped',
        problems: skipped ? skipped.problems.length : 0, warnings: report.warnings.filter((w) => w.where === `plugins/${id}/`).length,
        codes: skipped ? [...new Set((skipped.issues || []).map((i) => i.code))] : [],
      };
    });
  }

  /** After a change: read the folders now (hot reload) and answer with the plugin's state. */
  const changed = (id) => { watcher.rescan(); return stateOf(id); };

  /** A slot of the plugin's sections at `at` (its dir and base), else one made from the path. */
  function slotAt(id, overlay, at) {
    const loc = locateAssetPath(at);
    if (!loc) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: `${at.join('.')} is not something a cosmetic plugin changes` });
    const { targets: list, manifest } = targets();
    for (const s of sectionsOf(id, overlay)) {
      const t = targetOf(list, s.target);
      const tpl = templateById(s.template);
      const hit = t && tpl ? tpl.slots(t, manifest).find((x) => x.at.join('\u0001') === at.join('\u0001')) : null;
      if (hit) return hit;
    }
    const kind = typeof loc.kind === 'string' ? loc.kind : null;
    if (!kind) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: `${at.join('.')} is a whole record, not one place` });
    return { at, kind, field: at[at.length - 1], dir: `assets/${keyDir(loc.key)}`, base: keyDir(at[at.length - 1]) };
  }

  /** Decode the files of a slot request (base64), each within the limits. */
  function decodeFiles(list) {
    if (!Array.isArray(list) || !list.length || list.length > 24) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'no files' });
    return list.map((f) => {
      const name = String(f?.name || '').split(/[\\/]/).pop() || '';
      const ext = extOf(name);
      if (!name || name.length > 120) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'a file without a name' });
      const data = Buffer.from(String(f?.data || ''), 'base64');
      if (data.length > STUDIO_LIMITS.fileBytes) throw new StudioError('PLUGIN_STUDIO_SIZE', 413, { max: `${STUDIO_LIMITS.fileBytes / 1048576} MB`, file: name });
      return { name, ext, data, role: f?.role === 'intro' ? 'intro' : f?.role === 'loop' ? 'loop' : null };
    });
  }

  /**
   * Put dropped files into a slot (POST …/slot): written into the slot's folder under its name (a model's skeleton and
   * atlas under one name, its pages by theirs), the slot set to them, the files it named before removed when nothing
   * else names them.
   */
  function putSlot(id, body) {
    const at = body.at;
    if (!Array.isArray(at) || !at.every((k) => typeof k === 'string')) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'no slot' });
    const p = openPlugin(files, id);
    const slot = slotAt(id, p.overlay, at);
    const got = decodeFiles(body.files);
    const kindName = { image: '.png / .jpg / .webp', audio: '.mp3 / .ogg', audioList: '.mp3 / .ogg', track: '.mp3 / .ogg', spine: '.skel + .atlas + .png' }[slot.kind];
    const expect = (ok, f) => { if (!ok) throw new StudioError('PLUGIN_STUDIO_FILE_KIND', 400, { kind: kindName, ext: f.ext || f.name }, `${f.name}: not ${kindName}`); };
    const before = filesOfValue(getIn(p.overlay, at));
    const written = [];
    const put = (rel, data) => { files.write(id, rel, data); written.push(rel); return rel; };
    let value;
    if (slot.kind === 'image' || slot.kind === 'audio') {
      const exts = slot.kind === 'image' ? PLUGIN_IMAGE_EXTS : PLUGIN_AUDIO_EXTS;
      if (got.length !== 1) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'one file for this place' });
      expect(exts.includes(got[0].ext), got[0]);
      value = put(`${slot.dir}/${slot.base}${got[0].ext}`, got[0].data);
    } else if (slot.kind === 'audioList') {
      for (const f of got) expect(PLUGIN_AUDIO_EXTS.includes(f.ext), f);
      const prev = body.mode === 'append' ? (Array.isArray(getIn(p.overlay, at)) ? getIn(p.overlay, at) : typeof getIn(p.overlay, at) === 'string' ? [getIn(p.overlay, at)] : []) : [];
      const start = prev.length;
      if (start + got.length > 16) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'at most 16 files in one line' });
      const rels = got.map((f, i) => put(`${slot.dir}/${slot.base}${start + i === 0 && got.length === 1 && !start ? '' : `_${start + i + 1}`}${f.ext}`, f.data));
      const all = [...prev, ...rels];
      value = all.length === 1 ? all[0] : all;
    } else if (slot.kind === 'track') {
      for (const f of got) expect(PLUGIN_AUDIO_EXTS.includes(f.ext), f);
      const intro = got.find((f) => f.role === 'intro');
      const loop = got.find((f) => f.role === 'loop') || got.find((f) => f !== intro);
      if (!loop || got.length > 2) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'a track is a loop and an optional intro' });
      value = { loop: put(`${slot.dir}/loop${loop.ext}`, loop.data), ...(intro ? { intro: put(`${slot.dir}/intro${intro.ext}`, intro.data) } : {}) };
    } else if (slot.kind === 'spine') {
      const skel = got.filter((f) => f.ext === '.skel');
      const atlas = got.filter((f) => f.ext === '.atlas');
      const pages = got.filter((f) => PLUGIN_IMAGE_EXTS.includes(f.ext));
      for (const f of got) expect(f.ext === '.skel' || f.ext === '.atlas' || PLUGIN_IMAGE_EXTS.includes(f.ext), f);
      const cur = getIn(p.overlay, at);
      if (skel.length > 1 || atlas.length > 1) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'one model at a time: one .skel and one .atlas' });
      if (!skel.length && !(isObj(cur) && typeof cur.skel === 'string')) throw new StudioError('PLUGIN_STUDIO_FILE_KIND', 400, { kind: kindName, ext: got.map((f) => f.ext).join(' ') });
      const skelRel = skel.length ? put(`${slot.dir}/${slot.base}.skel`, skel[0].data) : cur.skel;
      const atlasRel = skelRel.replace(/\.skel$/, '.atlas');
      if (atlas.length) put(atlasRel, atlas[0].data);
      const folder = skelRel.replace(/[^/]*$/, '');
      for (const f of pages) put(`${folder}${f.name.replace(/[^A-Za-z0-9._ -]+/g, '_')}`, f.data);
      let textures;
      try { textures = atlasPages(files, id, atlasRel); } catch { textures = pages.map((f) => `${folder}${f.name}`); }
      value = { skel: skelRel, atlas: atlasRel, textures };
    } else throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: `${slot.kind} is not a place for files` });
    setSlot(p, at, value);
    p.save();
    // files the slot named before and nothing names now (another file type replaced them)
    const still = filesOfOverlay(p.overlay);
    for (const rel of before) if (!still.has(rel) && !written.includes(rel)) { try { files.remove(id, rel); } catch { /* gone or not a file */ } }
    return changed(id);
  }

  /** Move a file out of the plugin (the one-click fix of PLUGIN_FILE_TYPE): to plugins/_moved/<id>/<path>, never deleted. */
  function moveOut(id, rel) {
    const { abs } = files.stat(id, rel);
    const dest0 = path.join(files.base, '_moved', id, ...rel.split('/'));
    let dest = dest0;
    for (let n = 2; fs.existsSync(dest) && n < 1000; n++) dest = `${dest0}.${n}`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest);
    return path.relative(files.base, dest).split(path.sep).join('/');
  }

  /** Run a one-click fix (POST …/fix). */
  function fix(id, body) {
    const code = String(body.code || '');
    const name = isPluginErrorCode(code) ? PLUGIN_ERRORS[code].autofix : null;
    if (!name) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: `${code.slice(0, 40)} has no one-click fix` });
    const issue = { at: Array.isArray(body.at) ? body.at.map(String) : undefined, file: typeof body.file === 'string' ? body.file : undefined, params: isObj(body.params) ? body.params : {} };
    let did;
    if (name === 'pack') {
      const r = packPlugin(files.root(id), { vanilla: registry.vanillaAssets() });
      did = r.wrote ? 'packed' : 'not packed';
    } else if (name === 'moveOut') {
      if (!issue.file || !isPackPath(issue.file)) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400, { detail: 'no file' });
      did = `moved to plugins/${moveOut(id, issue.file)}`;
    } else {
      const p = openPlugin(files, id);
      did = FIXES[name](p, issue, { files, id });
      p.save();
    }
    log.info?.(`[studio] ${id}: fix ${code} — ${did}`);
    return { ...changed(id), fixed: { code, did } };
  }

  /** Serve a file of the page (public/studio/). */
  async function servePage(req, res, rel, query) {
    const segments = rel.split('/').filter(Boolean);
    if (!segments.length) segments.push('index.html');
    if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.')) || !PAGE_TYPES.has(path.extname(segments[segments.length - 1]).toLowerCase())) return false;
    const abs = path.join(pageDir, ...segments);
    if (!abs.startsWith(pageDir + path.sep)) return false;
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return false;
    await serveFile(req, res, abs, st, 'studio', segments, query, compress, log, { cacheControl: 'no-cache' });
    return true;
  }

  /** Serve a file of a plugin folder (a draft's too) to the page. */
  async function servePluginFile(req, res, id, rel, query) {
    const { abs, st } = files.stat(id, rel);
    if (!MIME[path.extname(abs).toLowerCase()] && extOf(rel) !== '.skel') throw new StudioError('PLUGIN_STUDIO_PATH', 404, { detail: rel });
    await serveFile(req, res, abs, st, 'studio', rel.split('/'), query, compress, log, { cacheControl: 'no-cache' });
  }

  /** The API (see the header). @returns {Promise<boolean>} whether it answered */
  async function api(req, res, route, query) {
    const q = new URLSearchParams(query);
    const method = req.method;
    const json = (status, obj) => { sendJson(req, res, status, obj); return true; };
    if (route === 'info' && method === 'GET') {
      return json(200, {
        app: APP_VERSION, api: PLUGIN_API, mode, watching: watcher.active, limits: { ...STUDIO_LIMITS, pluginBytes: PLUGIN_LIMITS.pluginBytes },
        templates: TEMPLATES.map((t) => ({ id: t.id, class: t.class, kinds: t.kinds })), kinds: Object.keys(TARGET_KINDS),
      });
    }
    if (route === 'targets' && method === 'GET') {
      const kinds = (q.get('kinds') || '').split(',').filter((k) => Object.hasOwn(TARGET_KINDS, k));
      const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 40));
      return json(200, { targets: searchTargets(targets().targets, q.get('q') || '', { kinds: kinds.length ? kinds : null, limit }) });
    }
    if (route === 'slots' && method === 'GET') {
      const tpl = templateById(q.get('template'));
      if (!tpl) throw new StudioError('PLUGIN_STUDIO_TEMPLATE', 404, { template: String(q.get('template') || '').slice(0, 40) });
      const t = targetOf(targets().targets, q.get('target') || '');
      if (!t) throw new StudioError('PLUGIN_STUDIO_TARGET', 404, { target: String(q.get('target') || '').slice(0, 80) });
      return json(200, { template: tpl.id, target: t, slots: tpl.kinds.includes(t.kind) ? tpl.slots(t, targets().manifest) : [] });
    }
    if (route === 'suggest-id' && method === 'GET') {
      const t = q.get('target') ? targetOf(targets().targets, q.get('target')) : null;
      const taken = new Set(files.ids().map((x) => x.toLowerCase()));
      try { for (const n of fs.readdirSync(files.base)) taken.add(n.toLowerCase()); } catch { /* no plugins/ yet */ }
      return json(200, { id: suggestId({ name: q.get('name') || '', target: t, template: q.get('template') || '' }, taken) });
    }
    if (route === 'authors' && method === 'POST') {
      if (!isStudioChange(req)) return false;
      const body = await readJson(req, 16 * 1024);
      const ids = [];
      for (const tok of (Array.isArray(body.tokens) ? body.tokens : []).slice(0, 8)) {
        const s = typeof tok === 'string' && tok.length <= 64 ? sessions?.byToken?.(tok) : null;
        if (s?.playerId) { authors.set(s.playerId, Date.now()); ids.push(s.playerId); }
      }
      for (const [pid, at] of authors) if (Date.now() - at > AUTHOR_TTL_MS) authors.delete(pid);
      return json(200, { players: ids.length });
    }
    if (route === 'events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ watching: watcher.active })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return true;
    }
    if (route === 'plugins' && method === 'GET') return json(200, { plugins: listPlugins() });
    if (route === 'plugins' && method === 'POST') {
      if (!isStudioChange(req)) return false;
      const body = await readJson(req, 64 * 1024);
      const tpl = templateById(body.template);
      if (!tpl) throw new StudioError('PLUGIN_STUDIO_TEMPLATE', 404, { template: String(body.template || '').slice(0, 40) });
      const id = String(body.id || '');
      if (!isPluginId(id)) throw new StudioError('PLUGIN_ID', 400, { id: id.slice(0, 40) });
      const t = body.target ? targetOf(targets().targets, String(body.target)) : null;
      if (body.target && !t) throw new StudioError('PLUGIN_STUDIO_TARGET', 404, { target: String(body.target).slice(0, 80) });
      if (t && !tpl.kinds.includes(t.kind)) throw new StudioError('PLUGIN_STUDIO_TARGET', 400, { target: targetSpec(t) });
      const made = createPlugin(tpl, { id, name: body.name, target: t, authors: body.authors, license: body.license, credits: body.credits, lang: body.lang === 'en' ? 'en' : 'zh' });
      files.root(id, { create: true });
      files.write(id, PLUGIN_MANIFEST, Buffer.from(manifestText(made.manifest)));
      for (const [rel, text] of Object.entries(made.files)) files.write(id, rel, Buffer.from(text));
      if (t) saveSections(id, [{ template: tpl.id, target: targetSpec(t) }]);
      log.info?.(`[studio] new plugin ${id} (${tpl.id}${t ? `, ${targetSpec(t)}` : ''})`);
      return json(201, changed(id));
    }
    const m = /^plugins\/([^/]+)(?:\/(.*))?$/.exec(route);
    if (!m) return false;
    const id = decodeURIComponent(m[1]);
    const sub = m[2] ?? '';
    if (!isPluginId(id)) throw new StudioError('PLUGIN_ID', 400, { id: id.slice(0, 40) });
    if (method === 'GET' || method === 'HEAD') {
      if (sub === '') return json(200, stateOf(id));
      if (sub === 'preview') return json(200, previews.preview(id, files.root(id)));
      if (sub === 'zip') {
        const z = zipPlugin(files.root(id));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': z.body.length, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${z.name}"` });
        res.end(method === 'HEAD' ? undefined : z.body);
        return true;
      }
      const f = /^(?:f\/[0-9a-f]{8}|files)\/(.+)$/.exec(sub);
      if (f) { await servePluginFile(req, res, id, f[1].split('/').map(decodeURIComponent).join('/'), query); return true; }
      return false;
    }
    if (!isStudioChange(req)) return false;
    if (method === 'PUT' && sub === 'manifest') {
      const body = await readBody(req, STUDIO_LIMITS.manifestBytes);
      let v;
      try { v = JSON.parse(body.toString('utf8')); } catch (e) { throw new StudioError('PLUGIN_JSON', 400, { file: PLUGIN_MANIFEST, detail: String(e?.message || e) }); }
      if (!isObj(v)) throw new StudioError('PLUGIN_MANIFEST_SHAPE', 400, {});
      files.root(id);
      files.write(id, PLUGIN_MANIFEST, Buffer.from(manifestText(v)));
      return json(200, changed(id));
    }
    const fileRoute = /^files\/(.+)$/.exec(sub);
    if (fileRoute && (method === 'PUT' || method === 'DELETE')) {
      const rel = fileRoute[1].split('/').map(decodeURIComponent).join('/');
      if (method === 'DELETE') files.remove(id, rel);
      else files.write(id, rel, await readBody(req, STUDIO_LIMITS.fileBytes));
      return json(200, changed(id));
    }
    if (method !== 'POST') return false;
    if (sub === 'slot') return json(200, putSlot(id, await readJson(req, STUDIO_LIMITS.bodyBytes)));
    const body = await readJson(req, 256 * 1024);
    if (sub === 'meta') { const p = openPlugin(files, id); editMeta(p, body.fields, typeof body.lang === 'string' ? body.lang : 'zh'); p.save(); return json(200, changed(id)); }
    if (sub === 'sections') { files.root(id); saveSections(id, body.sections); return json(200, stateOf(id)); }
    if (sub === 'ref') {
      const key = String(body.ref || '');
      const p = openPlugin(files, id);
      setSlot(p, Array.isArray(body.at) ? body.at.map(String) : [], { ref: key });
      p.save();
      return json(200, changed(id));
    }
    if (sub === 'clear') {
      const at = Array.isArray(body.at) ? body.at.map(String) : [];
      const p = openPlugin(files, id);
      const before = filesOfValue(getIn(p.overlay, at));
      clearSlot(p, at);
      p.save();
      const still = filesOfOverlay(p.overlay);
      for (const rel of before) if (!still.has(rel)) { try { files.remove(id, rel); } catch { /* gone */ } }
      return json(200, changed(id));
    }
    if (sub === 'fix') return json(200, fix(id, body));
    if (sub === 'pack') {
      const r = packPlugin(files.root(id), { vanilla: registry.vanillaAssets() });
      const list = issueList();
      list.take(r.build);
      log.info?.(`[studio] ${id}: pack — ${r.wrote ? 'plugin.lock.json written' : 'not written'}`);
      return json(200, { ...changed(id), pack: { wrote: r.wrote, issues: list.issues } });
    }
    return false;
  }

  /**
   * Answer a request whose path is the studio's (handles): the gate, then the page or the API. A request the gate refuses,
   * or one nothing here answers, gets the 404 page.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   * @param {string} rawPath @param {string} query
   */
  async function handle(req, res, rawPath, query) {
    const notFound = () => sendError(req, res, 404, '页面不存在 · Not found', rawPath.length <= 200 ? rawPath : '');
    const gate = studioAllowed(req, { trustProxy, mode });
    if (!gate.ok) { notFound(); return; }
    activate();
    if (rawPath === '/studio') { res.writeHead(301, { Location: `/studio/${query ? `?${query}` : ''}`, 'Cache-Control': 'no-cache', 'Content-Length': 0 }); res.end(); return; }
    try {
      if (rawPath.startsWith(STUDIO_API)) {
        let route;
        try { route = rawPath.slice(STUDIO_API.length); decodeURIComponent(route); } catch { notFound(); return; }
        if (!(await api(req, res, route, query))) notFound();
        return;
      }
      let rel;
      try { rel = decodeURIComponent(rawPath.slice(STUDIO_URL.length)); } catch { notFound(); return; }
      if ((req.method === 'GET' || req.method === 'HEAD') && (await servePage(req, res, rel, query))) return;
      notFound();
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof StudioError) { sendJson(req, res, e.status, { error: e.code, params: e.params, detail: e.message }); return; }
      if (e?.code === 'ENOSPC' || e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EROFS') {
        sendJson(req, res, 500, { error: 'PLUGIN_UNREADABLE', params: { detail: e.code }, detail: String(e.message || e).slice(0, 200) });
        return;
      }
      log.error?.('[studio] request failed', e);
      sendJson(req, res, 500, { error: 'PLUGIN_STUDIO_REQUEST', params: { detail: 'internal error' }, detail: 'internal error' });
    }
  }

  return {
    /** Is this path the studio's? @param {string} rawPath */
    handles: (rawPath) => rawPath === '/studio' || rawPath.startsWith(STUDIO_URL),
    handle,
    autoApply,
    watcher,
    activate,
    /** Whether the studio has been used (activate). */
    get active() { return active; },
    /** Stop watching and close the event streams. */
    close() {
      active = false;
      watcher.stop();
      clearInterval(heartbeat);
      for (const res of streams) { try { res.end(); } catch { /* gone */ } }
      streams.clear();
      if (lobby && lobby.autoApplyPlugins === autoApply) lobby.autoApplyPlugins = null;
    },
  };
}
