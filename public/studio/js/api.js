// public/studio/js/api.js — the studio page's calls to its API (/studio/api/*, server/studio/index.js). A change carries
// the header X-SP-Studio: 1 (server/studio/gate.js: a page of another site cannot send it); an error answers
// `{ error: <code>, params, detail }`, thrown as a StudioApiError the page explains with the error catalogue
// (shared/plugins/errors.js).

export const API = '/studio/api/';

/** An error the API answered: its catalogue code, params, technical detail and HTTP status. */
export class StudioApiError extends Error {
  constructor(code, params = {}, detail = '', status = 0) {
    super(detail || code);
    this.code = code;
    this.params = params;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * One call. `body`: an object (sent as JSON), a Blob / ArrayBuffer (sent as it is) or nothing.
 * @param {string} method @param {string} path relative to /studio/api/ @param {any} [body]
 */
export async function call(method, path, body) {
  const headers = {};
  let payload;
  if (method !== 'GET' && method !== 'HEAD') headers['X-SP-Studio'] = '1';
  if (body !== undefined && body !== null) {
    if (body instanceof Blob || body instanceof ArrayBuffer) payload = body;
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(API + path, { method, headers, body: payload, cache: 'no-store' }); } catch (e) {
    throw new StudioApiError('PLUGIN_STUDIO_REQUEST', { detail: String(e?.message || e) }, String(e?.message || e), 0);
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (data && typeof data.error === 'string') throw new StudioApiError(data.error, data.params || {}, data.detail || '', res.status);
    throw new StudioApiError('PLUGIN_STUDIO_REQUEST', { detail: `HTTP ${res.status}` }, `HTTP ${res.status}`, res.status);
  }
  return data;
}

export const get = (path) => call('GET', path);
export const post = (path, body = {}) => call('POST', path, body);
export const put = (path, body) => call('PUT', path, body);

/** The plugin path of the API. @param {string} id @param {string} [sub] */
export const pluginPath = (id, sub = '') => `plugins/${encodeURIComponent(id)}${sub ? `/${sub}` : ''}`;

/** A file as base64 (a slot's upload). @param {Blob} file */
export function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/**
 * The page's game sessions (localStorage `sp.tokens`, public/js/net.js): the studio names them so that a room this
 * player hosts applies a plugin's changes by itself (POST /studio/api/authors). Never fails the page.
 */
export async function nameAuthor() {
  let tokens;
  try { const v = JSON.parse(globalThis.localStorage?.getItem('sp.tokens') || '[]'); tokens = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, 8) : []; } catch { tokens = []; }
  try { const tok = globalThis.sessionStorage?.getItem('sp.token'); if (tok && !tokens.includes(tok)) tokens.unshift(tok); } catch { /* none */ }
  if (!tokens.length) return 0;
  try { return (await post('authors', { tokens })).players || 0; } catch { return 0; }
}
