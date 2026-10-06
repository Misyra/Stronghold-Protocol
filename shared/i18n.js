// shared/i18n.js — gettext-style translation for the browser and Node (no framework, no dependency, no Node builtin).
//
// The Chinese source string is the message id: `t('整备区已满')`, `t('还剩 {n} 秒', { n })`. A message without a
// translation in the current language falls back to the Chinese text, so an untranslated string is never blank.
// Chinese ('zh') is the default language; English ('en') is a switch (the owner's decision of 2026-10-05: an English
// browser still opens in Chinese until the player picks English). docs/I18N.md explains how to add and translate
// strings.
//
// Context: the same Chinese text may need two translations ('关闭' = "Close" on a button, "Off" on a switch):
// `tc('toggle', '关闭')` looks up the key 'toggle::关闭' first, then '关闭'; Chinese shows '关闭'.
// Module-level tables are evaluated once, before a language can change: mark their strings N_('…') (a no-op that
// tools/i18n.mjs extracts) and call t() where they are shown.
//
// Placeholders (the same in msgids and translations):
//   {name}             the value of params.name (params may also be an array: {0}, {1} …)
//   {n|one|other}      `one` when Number(params.n) === 1, else `other` — the only plural form (English needs no more)
// A value that is an array renders as a list joined with the language's separator ('、' / ', '); a value `{ dn: '…' }`
// (made by `dn()`) is a game-data name, translated through the name resolver the client installs (setNameResolver).
// A placeholder whose value is missing stays verbatim, so official templates such as '{0}博士…' survive untouched.
//
// Server → client messages (m.toast / m.ticker): the server builds `msg(msgid, params)` and sends
// `wireMessage(m)` = { text: <the Chinese rendering>, msgid, params } — `text` keeps older clients working, the client
// renders `translateWire(frame)` in its own language. A plain string message is its own msgid.

/** Supported languages; the first one is the default and the source language of every msgid. */
export const LANGS = Object.freeze(['zh', 'en']);
export const DEFAULT_LANG = 'zh';

/** List separator per language (array params). */
const LIST_SEP = Object.freeze({ zh: '、', en: ', ' });

/** @type {Map<string, Map<string, string>>} lang → msgid → translation */
const catalogs = new Map();
let current = DEFAULT_LANG;
/** @type {Set<(lang: string, prev: string) => void>} */
const listeners = new Set();
/** @type {((name: string, lang: string) => string) | null} */
let nameResolver = null;

/**
 * A supported language code from loose input ('en-US' → 'en', 'zh_CN' → 'zh'), or null.
 * @param {unknown} v
 * @returns {string|null}
 */
export function normalizeLang(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!s) return null;
  for (const l of LANGS) if (s === l || s.startsWith(`${l}-`) || s.startsWith(`${l}_`)) return l;
  return null;
}

/** The current language code. */
export function getLang() { return current; }

/**
 * Switch the language (unknown codes fall back to the default). Listeners run when it actually changed.
 * @param {unknown} lang
 * @returns {boolean} true when the language changed
 */
export function setLang(lang) {
  const next = normalizeLang(lang) || DEFAULT_LANG;
  if (next === current) return false;
  const prev = current;
  current = next;
  for (const fn of [...listeners]) {
    try { fn(next, prev); } catch (err) { /** @type {any} */ (globalThis).console?.error('[i18n] listener failed', err); }
  }
  return true;
}

/**
 * Subscribe to language changes.
 * @param {(lang: string, prev: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Add translations for a language (merged into what is there). Keys starting with '_' are metadata and skipped; only
 * non-empty string values count.
 * @param {string} lang
 * @param {Record<string, unknown> | null | undefined} dict msgid → translation
 * @returns {number} entries added
 */
export function addMessages(lang, dict) {
  const l = normalizeLang(lang);
  if (!l || !dict || typeof dict !== 'object') return 0;
  let cat = catalogs.get(l);
  if (!cat) { cat = new Map(); catalogs.set(l, cat); }
  let n = 0;
  for (const [k, v] of Object.entries(dict)) {
    if (k.startsWith('_') || typeof v !== 'string' || !v) continue;
    cat.set(k, v);
    n++;
  }
  return n;
}

/**
 * Replace a language's translations.
 * @param {string} lang
 * @param {Record<string, unknown> | null | undefined} dict
 * @returns {number}
 */
export function setMessages(lang, dict) {
  const l = normalizeLang(lang);
  if (!l) return 0;
  catalogs.delete(l);
  return addMessages(l, dict);
}

/**
 * Whether a msgid has a translation in a language (the default language always "has" its own msgids).
 * @param {string} msgid
 * @param {string} [lang]
 */
export function hasMessage(msgid, lang = current) {
  const l = normalizeLang(lang) || DEFAULT_LANG;
  return l === DEFAULT_LANG || !!catalogs.get(l)?.has(String(msgid));
}

/**
 * Install the translator of game-data names (`{ dn: '…' }` params and `tName`). The client maps a Chinese name to the
 * current language through the localized game data; without a resolver names stay Chinese.
 * @param {((name: string, lang: string) => string) | null} fn
 */
export function setNameResolver(fn) { nameResolver = typeof fn === 'function' ? fn : null; }

/**
 * A game-data name (operator, item, bond …) in the current language.
 * @param {unknown} name the Chinese name from the data
 * @param {string} [lang]
 * @returns {string}
 */
export function tName(name, lang = current) {
  const s = name == null ? '' : String(name);
  if (!s || lang === DEFAULT_LANG || !nameResolver) return s;
  try { return nameResolver(s, lang) || s; } catch { return s; }
}

/**
 * Mark a param as a game-data name (translated by the client's name resolver).
 * @param {unknown} name
 * @returns {{ dn: string }}
 */
export const dn = (name) => ({ dn: name == null ? '' : String(name) });

const own = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Render one param value.
 * @param {unknown} v
 * @param {string} lang
 * @param {((name: string, lang: string) => string) | null} resolve
 * @returns {string}
 */
function renderValue(v, lang, resolve) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => renderValue(x, lang, resolve)).filter((s) => s !== '').join(LIST_SEP[lang] || LIST_SEP.en);
  if (typeof v === 'object') {
    if (own(v, 'dn')) {
      const name = String(/** @type {any} */ (v).dn ?? '');
      if (!resolve || lang === DEFAULT_LANG || !name) return name;
      try { return resolve(name, lang) || name; } catch { return name; }
    }
    return '';
  }
  return String(v);
}

const PLACEHOLDER = /\{([A-Za-z0-9_$]+)(?:\|([^{}|]*)\|([^{}|]*))?\}/g;

/**
 * Fill a template's placeholders (pure: no global language state).
 * @param {unknown} template
 * @param {Record<string, unknown> | unknown[] | null | undefined} [params]
 * @param {{ lang?: string, resolveName?: ((name: string, lang: string) => string) | null }} [opts]
 * @returns {string}
 */
export function format(template, params, opts = {}) {
  const s = template == null ? '' : String(template);
  if (!params || typeof params !== 'object' || !s.includes('{')) return s;
  const lang = normalizeLang(opts.lang) || DEFAULT_LANG;
  const resolve = opts.resolveName || null;
  return s.replace(PLACEHOLDER, (m, key, one, other) => {
    if (!own(params, key)) return m;
    const v = /** @type {any} */ (params)[key];
    if (one !== undefined) return Number(v) === 1 ? one : other;
    return renderValue(v, lang, resolve);
  });
}

/**
 * Translate a message into the current language (gettext style: the msgid is the Chinese text).
 * @param {unknown} msgid
 * @param {Record<string, unknown> | unknown[] | null} [params]
 * @returns {string}
 */
export function t(msgid, params) {
  const id = msgid == null ? '' : String(msgid);
  let text = id;
  if (current !== DEFAULT_LANG) {
    const tr = catalogs.get(current)?.get(id);
    if (tr) text = tr;
  }
  return params ? format(text, params, { lang: current, resolveName: nameResolver }) : text;
}

/**
 * Translate a message with a context (see the header): the key `${context}::${msgid}` first, then the msgid alone.
 * @param {string} context
 * @param {unknown} msgid
 * @param {Record<string, unknown> | unknown[] | null} [params]
 * @returns {string}
 */
export function tc(context, msgid, params) {
  const id = msgid == null ? '' : String(msgid);
  if (current !== DEFAULT_LANG) {
    const tr = catalogs.get(current)?.get(`${context}::${id}`);
    if (tr) return params ? format(tr, params, { lang: current, resolveName: nameResolver }) : tr;
  }
  return t(id, params);
}

/** A tParts() param kept as it is: an object that is not a `{ dn }` name (a vnode), or an array holding one. */
const isMarkup = (v) => !!v && typeof v === 'object' && !own(v, 'dn') && (!Array.isArray(v) || v.some((x) => isMarkup(x)));

/**
 * A message as pieces for a renderer, for a sentence with markup inside (「第 <b>14</b> 回合」): the translation split at
 * its placeholders; a param that is markup (a vnode, or an array holding vnodes) is kept as it is, the others render as
 * in t() ({ dn } names, lists, {n|one|other}). Adjacent text joins, empty text is dropped, so the Chinese pieces are the
 * text around the markup exactly as written before:
 *   html`<span>${tParts('第 {r} 回合 · 最终攻势', { r: html`<b class="num">${n}</b>` })}</span>`
 * @param {unknown} msgid
 * @param {Record<string, unknown> | unknown[] | null} [params]
 * @returns {unknown[]} strings and the markup params, in the order of the translation
 */
export function tParts(msgid, params) {
  const id = msgid == null ? '' : String(msgid);
  let text = id;
  if (current !== DEFAULT_LANG) {
    const tr = catalogs.get(current)?.get(id);
    if (tr) text = tr;
  }
  /** @type {unknown[]} */
  const out = [];
  const push = (s) => {
    if (s === '') return;
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] += s;
    else out.push(s);
  };
  let last = 0;
  if (params && typeof params === 'object') {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const [whole, key, one, other] = m;
      if (!own(params, key)) continue;
      push(text.slice(last, m.index));
      const v = /** @type {any} */ (params)[key];
      if (one !== undefined) push(Number(v) === 1 ? one : other);
      else if (isMarkup(v)) out.push(v);
      else push(renderValue(v, current, nameResolver));
      last = m.index + whole.length;
    }
  }
  push(text.slice(last));
  return out;
}

/**
 * Mark a string as a msgid without translating it (module-level tables: translate with t() where it is shown).
 * @template {string} S
 * @param {S} s
 * @returns {S}
 */
export const N_ = (s) => s;

/**
 * A structured message (server → client): the msgid with its params.
 * @param {string} msgid
 * @param {Record<string, unknown> | unknown[]} [params]
 * @returns {{ msgid: string, params: Record<string, unknown> | unknown[] | undefined }}
 */
export const msg = (msgid, params) => ({ msgid: String(msgid), params });

/** @param {unknown} m @returns {m is { msgid: string, params?: any }} */
const isMsg = (m) => !!m && typeof m === 'object' && typeof (/** @type {any} */ (m).msgid) === 'string';

/**
 * The Chinese text of a message (a plain string is returned as is).
 * @param {unknown} m a string or msg()
 * @returns {string}
 */
export function renderMessage(m) {
  if (isMsg(m)) return format(m.msgid, m.params, { lang: DEFAULT_LANG });
  return m == null ? '' : String(m);
}

/**
 * JSON-safe copy of message params: strings, finite numbers, booleans, `{ dn }` and arrays of those (anything else is
 * dropped), so a frame never carries an object the client would have to trust.
 * @param {unknown} v
 * @param {number} [depth]
 * @returns {unknown}
 */
function cleanParam(v, depth = 0) {
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v) && depth < 1) return v.slice(0, 32).map((x) => cleanParam(x, depth + 1));
  if (v && typeof v === 'object' && own(v, 'dn')) return { dn: String(/** @type {any} */ (v).dn ?? '').slice(0, 200) };
  return null;
}

/**
 * The wire fields of a message for m.toast / m.ticker: `{ text }` for a plain string, `{ text, msgid, params }` for a
 * msg() — `text` is the Chinese rendering (older clients show it as before).
 * @param {unknown} m
 * @returns {{ text: string, msgid?: string, params?: Record<string, unknown> | unknown[] }}
 */
export function wireMessage(m) {
  if (!isMsg(m)) return { text: renderMessage(m) };
  const out = { text: renderMessage(m), msgid: m.msgid };
  const p = m.params;
  if (Array.isArray(p)) return { ...out, params: p.slice(0, 16).map((x) => cleanParam(x)) };
  if (p && typeof p === 'object') {
    /** @type {Record<string, unknown>} */
    const params = {};
    for (const [k, v] of Object.entries(p).slice(0, 16)) if (/^[A-Za-z0-9_$]{1,32}$/.test(k)) params[k] = cleanParam(v);
    return { ...out, params };
  }
  return out;
}

/**
 * The text of a received m.toast / m.ticker frame in the current language: its msgid with params when present, else
 * its text taken as a msgid (static server texts are their own msgid). Missing translations show the Chinese text.
 * @param {{ text?: unknown, msgid?: unknown, params?: unknown } | null | undefined} frame
 * @returns {string}
 */
export function translateWire(frame) {
  if (!frame || typeof frame !== 'object') return '';
  const params = frame.params && typeof frame.params === 'object' ? /** @type {any} */ (frame.params) : null;
  if (typeof frame.msgid === 'string' && frame.msgid) return t(frame.msgid, params);
  return typeof frame.text === 'string' ? t(frame.text) : '';
}
