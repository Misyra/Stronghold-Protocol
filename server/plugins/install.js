// server/plugins/install.js — install a plugin zip into plugins/<id>/ (DESIGN §32.13, docs/PLUGINS.md §17). The CLI
// (tools/plugin.mjs install) and the studio (POST /studio/api/catalog/install) share it. A local zip is installed as it
// is; an https URL is downloaded by this process (the browser never uploads the zip), and only when a sha256 is given.
// The hash is checked on the bytes. The zip is extracted with readPluginZip (no traversal, no links, no bombs), written
// under plugins/_incoming/, and checkPluginFolder must pass. It is then renamed into plugins/<id>/. The same id is left
// untouched unless force: the old folder is renamed to plugins/_replaced/<id>-<time>/ and is not deleted. No file of
// the package is imported, spawned or otherwise run.
//
// [ASSUMED] a zip download waits 60 s, a catalogue document 20 s, and at most 5 redirects, each of which must stay
// https. A catalogue document is at most CATALOG_FETCH_MAX_BYTES (1 MB). The zip cap is PLUGIN_LIMITS.pluginBytes.
// The replaced-folder stamp is UTC YYYYMMDD-HHMMSS-mmm, with -2, -3, … if that name is taken. `bytes` on a catalogue
// entry, when install is told it, must equal the download. A failed check deletes only the temporary folder. A class
// this build will not load (script, trusted) may still be stored when the check passes; it is not executed. The
// installed folder name is the single wrapping folder when that folder is a plugin id, otherwise `id` in plugin.json.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PLUGIN_LIMITS, PLUGIN_MANIFEST, isPluginId } from '../../shared/plugins/manifest.js';
import { CATALOG_FETCH_MAX_BYTES, isCatalogUrl } from '../../shared/plugins/catalog.js';
import { isContentHash } from '../../shared/plugins/identity.js';
import { checkPluginFolder } from './pack.js';
import { readPluginZip } from './zip.js';

/** [ASSUMED] see the header. */
export const ZIP_FETCH_TIMEOUT_MS = 60 * 1000;
/** [ASSUMED] see the header. */
export const CATALOG_FETCH_TIMEOUT_MS = 20 * 1000;
/** [ASSUMED] see the header. */
export const MAX_REDIRECTS = 5;
/** The zip cap install enforces. Tests assert this stays PLUGIN_LIMITS.pluginBytes. */
export const INSTALL_MAX_BYTES = PLUGIN_LIMITS.pluginBytes;

const STATUS = Object.freeze({
  PLUGIN_CATALOG_SHAPE: 400,
  PLUGIN_CATALOG_URL: 400,
  PLUGIN_CATALOG_HASH: 400,
  PLUGIN_CATALOG_ID: 400,
  PLUGIN_CATALOG_FIELD: 400,
  PLUGIN_CATALOG_SIZE: 413,
  PLUGIN_CATALOG_FETCH: 502,
  PLUGIN_INSTALL_URL: 400,
  PLUGIN_INSTALL_HASH: 422,
  PLUGIN_INSTALL_SIZE: 413,
  PLUGIN_INSTALL_TIMEOUT: 502,
  PLUGIN_INSTALL_FETCH: 502,
  PLUGIN_INSTALL_REDIRECT: 502,
  PLUGIN_INSTALL_ZIP: 422,
  PLUGIN_INSTALL_CHECK: 422,
  PLUGIN_INSTALL_EXISTS: 409,
});

/**
 * A coded install or catalogue-fetch failure. `status` is the HTTP status the studio uses.
 */
export class InstallError extends Error {
  /**
   * @param {string} code @param {string} [detail] @param {Record<string, unknown>} [params] @param {number} [status]
   */
  constructor(code, detail = '', params = {}, status = STATUS[code] || 400) {
    super(detail || code);
    this.code = code;
    this.params = params;
    this.status = status;
  }
}

const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

/** Constant-time compare of two hex digests. Different lengths are not equal and are not compared. */
function hashEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * An address the CLI treats as remote (a scheme, or a protocol-relative URL). A filesystem path is not one.
 * @param {string} value
 */
export function isRemoteAddress(value) {
  return typeof value === 'string' && (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('//'));
}

const CODES = Object.freeze({
  zip: { url: 'PLUGIN_INSTALL_URL', size: 'PLUGIN_INSTALL_SIZE', timeout: 'PLUGIN_INSTALL_TIMEOUT', fetch: 'PLUGIN_INSTALL_FETCH', redirect: 'PLUGIN_INSTALL_REDIRECT' },
  catalog: { url: 'PLUGIN_CATALOG_URL', size: 'PLUGIN_CATALOG_SIZE', timeout: 'PLUGIN_CATALOG_FETCH', fetch: 'PLUGIN_CATALOG_FETCH', redirect: 'PLUGIN_CATALOG_FETCH' },
});

const isRedirectStatus = (status) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

async function cancelBody(res) {
  try { await res?.body?.cancel?.(); } catch { /* already closed */ }
}

/**
 * Read a response body, stopping once it passes `maxBytes` (the rest is cancelled, not buffered).
 * @param {Response} res @param {number} maxBytes @param {typeof CODES.zip} codes
 */
async function readCapped(res, maxBytes, codes) {
  const len = res.headers.get('content-length');
  if (len && /^\d+$/.test(len.trim()) && Number(len) > maxBytes) {
    await cancelBody(res);
    throw new InstallError(codes.size, `content-length ${len} is over the limit`, { max: maxBytes });
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new InstallError(codes.size, `${buf.length} bytes is over the limit`, { max: maxBytes });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    let step;
    try { step = await reader.read(); } catch {
      throw new InstallError(codes.fetch, 'the download failed', {});
    }
    if (step.done) break;
    n += step.value.byteLength;
    if (n > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new InstallError(codes.size, `the download passed ${maxBytes} bytes`, { max: maxBytes });
    }
    chunks.push(Buffer.from(step.value));
  }
  return Buffer.concat(chunks);
}

/**
 * GET an https URL. Redirects are followed only when the next URL is still https, at most MAX_REDIRECTS.
 * `redirect: 'manual'` is set so a non-https Location is never fetched. An opaque redirect (no Location) is refused.
 * @param {string} url
 * @param {{ fetch?: typeof fetch, maxBytes?: number, timeoutMs?: number, kind?: 'zip' | 'catalog', signal?: AbortSignal }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fetchHttps(url, { fetch: fetchImpl = globalThis.fetch, maxBytes = INSTALL_MAX_BYTES, timeoutMs, kind = 'zip', signal } = {}) {
  const codes = CODES[kind] || CODES.zip;
  const wait = timeoutMs ?? (kind === 'catalog' ? CATALOG_FETCH_TIMEOUT_MS : ZIP_FETCH_TIMEOUT_MS);
  if (!isCatalogUrl(url)) throw new InstallError(codes.url, 'only an https address, with no user or password, is accepted', {});
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), wait);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort);
    let res;
    try {
      res = await fetchImpl(current, { redirect: 'manual', signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) throw new InstallError(codes.timeout, `timed out after ${wait} ms`, {});
      throw new InstallError(codes.fetch, 'the download failed', {});
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (res.type === 'opaqueredirect' || res.status === 0) {
      await cancelBody(res);
      throw new InstallError(codes.redirect, 'a redirect hid its target', {});
    }
    if (isRedirectStatus(res.status)) {
      const loc = res.headers.get('location');
      await cancelBody(res);
      if (hop === MAX_REDIRECTS) throw new InstallError(codes.redirect, `more than ${MAX_REDIRECTS} redirects`, {});
      if (!loc) throw new InstallError(codes.redirect, 'a redirect without a location', {});
      let next;
      try { next = new URL(loc, current).href; } catch {
        throw new InstallError(codes.redirect, 'a redirect to an unreadable address', {});
      }
      if (!isCatalogUrl(next)) throw new InstallError(codes.redirect, 'a redirect left https', {});
      current = next;
      continue;
    }
    if (res.status !== 200) {
      await cancelBody(res);
      throw new InstallError(codes.fetch, `HTTP ${res.status}`, { status: res.status });
    }
    return readCapped(res, maxBytes, codes);
  }
  throw new InstallError(CODES[kind].redirect, `more than ${MAX_REDIRECTS} redirects`, {});
}

/**
 * The version in plugins/<id>/plugin.json. Undefined when the id is not installed. Null when the folder is there
 * (including a symbolic link, which is not followed) but the version cannot be read.
 * @param {string} pluginsDir @param {string} id
 * @returns {string | null | undefined}
 */
export function installedPluginVersion(pluginsDir, id) {
  if (!isPluginId(id)) return undefined;
  const dir = path.join(pluginsDir, id);
  let st;
  try { st = fs.lstatSync(dir); } catch { return undefined; }
  if (st.isSymbolicLink()) return null;
  if (!st.isDirectory()) return undefined;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST), 'utf8'));
    return typeof m.version === 'string' ? m.version : null;
  } catch { return null; }
}

/** UTC stamp for a replaced folder: YYYYMMDD-HHMMSS-mmm. [ASSUMED] */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}

/** A real directory, never a symbolic link. @param {string} dir */
function assertRealDir(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new InstallError('PLUGIN_INSTALL_ZIP', 'refusing to write through a symbolic link', {});
  return st;
}

/**
 * `parent` must be a real directory. Create `name` inside it (one level, not recursive) and return the new path.
 * @param {string} parent @param {string} name
 */
function mkdirChild(parent, name) {
  assertRealDir(parent);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new InstallError('PLUGIN_INSTALL_ZIP', 'a path escapes the plugin folder', {});
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  assertRealDir(dir);
  return dir;
}

/**
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {{ hint: string | null, files: { name: string, data: Buffer }[] }}
 */
function normalizeLayout(entries) {
  const files = entries.filter((e) => !e.name.endsWith('/'));
  if (!files.length) throw new InstallError('PLUGIN_INSTALL_ZIP', 'the zip has no files', {});
  if (files.some((f) => f.name === PLUGIN_MANIFEST)) return { hint: null, files };
  const tops = new Set(files.map((f) => f.name.split('/')[0]));
  if (tops.size !== 1) throw new InstallError('PLUGIN_INSTALL_ZIP', 'the zip must contain plugin.json, or one folder that contains it', {});
  const top = [...tops][0];
  if (!isPluginId(top) || !files.some((f) => f.name === `${top}/${PLUGIN_MANIFEST}`)) {
    throw new InstallError('PLUGIN_INSTALL_ZIP', 'the wrapping folder must be a plugin id and contain plugin.json', {});
  }
  return { hint: top, files: files.map((f) => ({ name: f.name.slice(top.length + 1), data: f.data })) };
}

/**
 * @param {{ name: string, data: Buffer }[]} files @param {string | null} hint
 */
function chooseId(files, hint) {
  const man = files.find((f) => f.name === PLUGIN_MANIFEST);
  if (!man) throw new InstallError('PLUGIN_INSTALL_ZIP', 'no plugin.json', {});
  let json;
  try { json = JSON.parse(man.data.toString('utf8')); } catch {
    throw new InstallError('PLUGIN_INSTALL_ZIP', 'plugin.json is not JSON', {});
  }
  const fromFile = json && typeof json.id === 'string' ? json.id : '';
  const id = isPluginId(hint) ? hint : (isPluginId(fromFile) ? fromFile : '');
  if (!isPluginId(id)) throw new InstallError('PLUGIN_INSTALL_ZIP', 'the zip has no plugin id (name the folder with the id, or set id in plugin.json)', {});
  return id;
}

/**
 * @param {string} dir @param {{ name: string, data: Buffer }[]} files
 */
function writeTree(dir, files) {
  assertRealDir(dir);
  for (const f of files) {
    const parts = f.name.split('/');
    if (!parts.length || parts.some((s) => !s || s === '.' || s === '..')) throw new InstallError('PLUGIN_INSTALL_ZIP', 'a path escapes the plugin folder', {});
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = path.join(cur, parts[i]);
      const st = fs.lstatSync(next, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new InstallError('PLUGIN_INSTALL_ZIP', 'refusing to write through a symbolic link', {});
      if (!st) cur = mkdirChild(cur, parts[i]);
      else if (!st.isDirectory()) throw new InstallError('PLUGIN_INSTALL_ZIP', 'a path is not a folder', {});
      else cur = next;
    }
    const abs = path.join(cur, parts[parts.length - 1]);
    const fileSt = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (fileSt) throw new InstallError('PLUGIN_INSTALL_ZIP', 'a file in the zip is not a plain new file', {});
    const fh = fs.openSync(abs, 'wx');
    try { fs.writeSync(fh, f.data); } finally { fs.closeSync(fh); }
  }
}

/**
 * Move plugins/<id> to plugins/_replaced/<id>-<stamp>/. The rename does not follow a symbolic link.
 * @param {string} pluginsDir @param {string} id
 * @returns {string} the new path
 */
function moveAside(pluginsDir, id) {
  const src = path.join(pluginsDir, id);
  const replacedRoot = path.join(pluginsDir, '_replaced');
  fs.mkdirSync(replacedRoot, { recursive: true });
  const rst = fs.lstatSync(replacedRoot);
  if (rst.isSymbolicLink() || !rst.isDirectory()) throw new InstallError('PLUGIN_INSTALL_ZIP', 'plugins/_replaced is not a real folder', {});
  const base = `${id}-${stamp()}`;
  let dest = path.join(replacedRoot, base);
  for (let n = 2; fs.lstatSync(dest, { throwIfNoEntry: false }); n++) {
    if (n > 50) throw new InstallError('PLUGIN_INSTALL_EXISTS', `${id} could not be moved aside`, { id });
    dest = path.join(replacedRoot, `${base}-${n}`);
  }
  fs.renameSync(src, dest);
  return dest;
}

/**
 * Install zip bytes into plugins/<id>/. See the header. Never runs code from the package.
 * @param {Buffer | Uint8Array} bytes
 * @param {{ pluginsDir: string, force?: boolean, expectedId?: string, maxBytes?: number }} opts
 * @returns {{ id: string, dir: string, replaced: string | null }}
 */
export function installPluginBytes(bytes, { pluginsDir, force = false, expectedId = '', maxBytes = INSTALL_MAX_BYTES } = {}) {
  if (!pluginsDir) throw new InstallError('PLUGIN_INSTALL_ZIP', 'no plugins directory', {});
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > maxBytes) throw new InstallError('PLUGIN_INSTALL_SIZE', `${buf.length} bytes is over the limit`, { max: maxBytes });
  let top;
  try { top = fs.lstatSync(pluginsDir); } catch {
    throw new InstallError('PLUGIN_INSTALL_ZIP', 'the plugins directory cannot be read', {});
  }
  if (top.isSymbolicLink() || !top.isDirectory()) throw new InstallError('PLUGIN_INSTALL_ZIP', 'the plugins directory is not a real directory', {});
  let entries;
  try { entries = readPluginZip(buf, { maxBytes, maxFiles: PLUGIN_LIMITS.files }); } catch (e) {
    if (e instanceof InstallError) throw e;
    throw new InstallError('PLUGIN_INSTALL_ZIP', e?.code === 'PLUGIN_INSTALL_ZIP' ? String(e.message).slice(0, 300) : String(e?.code || 'PLUGIN_INSTALL_ZIP'), {});
  }
  const layout = normalizeLayout(entries);
  const id = chooseId(layout.files, layout.hint);
  if (expectedId && id !== expectedId) throw new InstallError('PLUGIN_INSTALL_ZIP', `the zip is ${id}, not ${expectedId}`, { id, expected: expectedId });
  const incomingRoot = path.join(pluginsDir, '_incoming');
  const incomingExisting = fs.lstatSync(incomingRoot, { throwIfNoEntry: false });
  if (incomingExisting?.isSymbolicLink()) throw new InstallError('PLUGIN_INSTALL_ZIP', 'plugins/_incoming is not a real folder', {});
  if (!incomingExisting) fs.mkdirSync(incomingRoot);
  assertRealDir(incomingRoot);
  /** @type {string | null} */
  let incoming = null;
  /** @type {string | null} */
  let tempPlugin = null;
  let committed = false;
  /** @type {string | null} */
  let replaced = null;
  try {
    incoming = mkdirChild(incomingRoot, randomBytes(8).toString('hex'));
    tempPlugin = mkdirChild(incoming, id);
    writeTree(tempPlugin, layout.files);
    const checked = checkPluginFolder(tempPlugin, `plugins/${id}/`);
    if (checked.problems.length) throw new InstallError('PLUGIN_INSTALL_CHECK', checked.problems[0], { id });
    const finalDir = path.join(pluginsDir, id);
    const existing = fs.lstatSync(finalDir, { throwIfNoEntry: false });
    if (existing) {
      if (!force) throw new InstallError('PLUGIN_INSTALL_EXISTS', `${id} is already installed`, { id });
      replaced = moveAside(pluginsDir, id);
    }
    try {
      fs.renameSync(tempPlugin, finalDir);
    } catch (e) {
      if (replaced) {
        try { fs.renameSync(replaced, finalDir); } catch { /* the old folder stays in plugins/_replaced */ }
      }
      throw new InstallError('PLUGIN_INSTALL_ZIP', String(e?.code || 'rename failed'), { id });
    }
    committed = true;
    return { id, dir: finalDir, replaced };
  } finally {
    if (incoming) fs.rmSync(incoming, { recursive: true, force: true });
  }
}

/**
 * Download an https zip and install it. `sha256` is required. `expectedBytes`, when set, must match the download.
 * @param {string} url
 * @param {{ pluginsDir: string, sha256: string, force?: boolean, expectedId?: string, expectedBytes?: number,
 *   fetch?: typeof fetch, maxBytes?: number, timeoutMs?: number }} opts
 */
export async function installFromUrl(url, opts) {
  if (!isCatalogUrl(url)) throw new InstallError('PLUGIN_INSTALL_URL', 'only an https address, with no user or password, is accepted', {});
  if (!isContentHash(opts.sha256)) throw new InstallError('PLUGIN_INSTALL_HASH', 'an https install needs a sha256', {}, 400);
  const maxBytes = opts.maxBytes ?? INSTALL_MAX_BYTES;
  const buf = await fetchHttps(url, { fetch: opts.fetch, maxBytes, timeoutMs: opts.timeoutMs, kind: 'zip' });
  if (opts.expectedBytes !== undefined && buf.length !== opts.expectedBytes) {
    throw new InstallError('PLUGIN_INSTALL_SIZE', `the zip is ${buf.length} bytes, the catalogue says ${opts.expectedBytes}`, { bytes: buf.length, expected: opts.expectedBytes });
  }
  const got = sha256Of(buf);
  if (!hashEqual(got, opts.sha256)) throw new InstallError('PLUGIN_INSTALL_HASH', 'the zip sha256 does not match', { sha256: got });
  return installPluginBytes(buf, opts);
}

/**
 * Install a zip that is already a file. `sha256`, when given, is checked. It is not required for a local file.
 * @param {string} file
 * @param {{ pluginsDir: string, sha256?: string, force?: boolean, expectedId?: string, maxBytes?: number }} opts
 */
export function installFromFile(file, opts) {
  const maxBytes = opts.maxBytes ?? INSTALL_MAX_BYTES;
  let st;
  try { st = fs.lstatSync(file); } catch {
    throw new InstallError('PLUGIN_INSTALL_ZIP', 'the zip cannot be read', {});
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new InstallError('PLUGIN_INSTALL_ZIP', 'the zip is not a plain file', {});
  if (st.size > maxBytes) throw new InstallError('PLUGIN_INSTALL_SIZE', `${st.size} bytes is over the limit`, { max: maxBytes });
  const buf = fs.readFileSync(file);
  if (opts.sha256) {
    if (!isContentHash(opts.sha256)) throw new InstallError('PLUGIN_INSTALL_HASH', 'sha256 must be 64 lowercase hex digits', {}, 400);
    if (!hashEqual(sha256Of(buf), opts.sha256)) throw new InstallError('PLUGIN_INSTALL_HASH', 'the zip sha256 does not match', {});
  }
  return installPluginBytes(buf, { ...opts, maxBytes });
}

/**
 * The text of a catalogue file or an https URL. The document is capped at 1 MB. The URL is not required to carry a hash.
 * @param {string} spec a filesystem path or an https URL
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function loadCatalogText(spec, { fetch: fetchImpl, timeoutMs } = {}) {
  if (isRemoteAddress(spec)) {
    const buf = await fetchHttps(spec, { fetch: fetchImpl, maxBytes: CATALOG_FETCH_MAX_BYTES, timeoutMs: timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS, kind: 'catalog' });
    return buf.toString('utf8');
  }
  const abs = path.resolve(spec);
  let st;
  try { st = fs.lstatSync(abs); } catch {
    throw new InstallError('PLUGIN_CATALOG_FETCH', 'the catalogue file cannot be read', {});
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new InstallError('PLUGIN_CATALOG_FETCH', 'the catalogue is not a plain file', {});
  if (st.size > CATALOG_FETCH_MAX_BYTES) throw new InstallError('PLUGIN_CATALOG_SIZE', 'the catalogue is over 1 MB', {});
  return fs.readFileSync(abs, 'utf8');
}
