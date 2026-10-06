// Language switch of the client (docs/I18N.md): picks the language at boot, loads the UI translations
// (public/i18n/<lang>.json, shared/i18n.js) and the localized game data (data/i18n/<lang>.json through data.js), keeps
// the choice, and translates what the server sends (m.toast / m.ticker / error codes).
//
// Chinese is the default; English is a switch (the owner's decision of 2026-10-05) — the browser's language is not
// consulted. Order at boot: `?lang=en|zh` in the URL (then removed from the address bar and kept as the choice), the
// stored choice (localStorage `sp.pref.lang`), else Chinese. A switch re-renders the app in place (main.js App
// subscribes with useLang) — no reload; the game texts follow as soon as the data overlay has downloaded (data.js
// notifies its subscribers).

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { LANGS, DEFAULT_LANG, normalizeLang, getLang, setLang, onLangChange, addMessages, setNameResolver, tName, format, translateWire } from '../../../shared/i18n.js';
import { loadPref, savePref } from '../store.js';
import { data } from '../data.js';
import { html } from './components.js';

/** Labels of the language switch (each in its own language). */
export const LANG_LABELS = Object.freeze({ zh: '中文', en: 'English' }); // i18n-ignore: each language in its own name
/** The switch's own label, in both languages (whoever opens it may not read the current one). */
const SWITCH_LABEL = 'Language / 语言'; // i18n-ignore
const PREF_KEY = 'lang';
/** How long boot waits for the UI translations before rendering in Chinese anyway (they apply when they arrive). */
const BOOT_WAIT_MS = 2500;

/** @type {Map<string, Promise<boolean>>} */
const uiLoads = new Map();

/**
 * Download (once) the UI translations of a language.
 * @param {string} lang
 * @param {typeof fetch} [doFetch]
 * @returns {Promise<boolean>} false when unavailable (the UI stays Chinese)
 */
export function loadUiMessages(lang, doFetch = (...a) => globalThis.fetch(...a)) {
  if (lang === DEFAULT_LANG) return Promise.resolve(true);
  if (uiLoads.has(lang)) return uiLoads.get(lang);
  const p = (async () => {
    try {
      const res = await doFetch(`/i18n/${lang}.json`, { cache: 'no-cache' });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '???'}`);
      addMessages(lang, await res.json());
      return true;
    } catch (err) {
      console.warn(`[i18n] /i18n/${lang}.json unavailable (${err?.message || err}); the interface stays Chinese`);
      uiLoads.delete(lang);
      return false;
    }
  })();
  uiLoads.set(lang, p);
  return p;
}

/**
 * The language to start in: the URL's `?lang=`, then the stored choice, then Chinese.
 * @param {string} [search] location.search
 * @param {(key: string, fallback: any) => any} [load]
 * @returns {{ lang: string, fromUrl: boolean }}
 */
export function initialLang(search = globalThis.location?.search || '', load = loadPref) {
  let fromUrl = null;
  try { fromUrl = normalizeLang(new URLSearchParams(search).get('lang')); } catch { /* ignore */ }
  if (fromUrl) return { lang: fromUrl, fromUrl: true };
  let stored = null;
  try { stored = normalizeLang(load(PREF_KEY, null)); } catch { /* ignore */ }
  return { lang: stored || DEFAULT_LANG, fromUrl: false };
}

function stripLangParam() {
  try {
    const url = new URL(globalThis.location.href);
    if (!url.searchParams.has('lang')) return;
    url.searchParams.delete('lang');
    globalThis.history?.replaceState(globalThis.history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

/** <html lang> and the tab title follow the language. */
function applyDocument(lang) {
  const doc = globalThis.document;
  if (!doc) return;
  doc.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  doc.documentElement.dataset.lang = lang;
  doc.title = lang === 'en' ? 'Stronghold Protocol: Alliance · Web Simulation' : '卫戍协议：盟约 · STRONGHOLD PROTOCOL'; // i18n-ignore: one title per language
}

// `{ dn }` params and tName(): Chinese game-data names → the current language (data/i18n/<lang>.json names)
setNameResolver((name) => data.localeName(name));

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  onLangChange((lang) => { applyDocument(lang); });
}

/**
 * Boot: choose the language and load its UI translations (waits at most BOOT_WAIT_MS) before the first render; the
 * game-data overlay downloads in the background.
 * @returns {Promise<string>} the language in effect
 */
export async function initLang() {
  wire();
  const { lang, fromUrl } = initialLang();
  if (fromUrl) { savePref(PREF_KEY, lang); stripLangParam(); }
  applyDocument(getLang());
  if (lang === DEFAULT_LANG) return getLang();
  const ok = await Promise.race([loadUiMessages(lang), new Promise((r) => setTimeout(() => r(null), BOOT_WAIT_MS))]);
  if (ok === null) loadUiMessages(lang).then((loaded) => { if (loaded && normalizeLang(loadPref(PREF_KEY, null)) === lang) setLang(lang); });
  else if (ok) setLang(lang);
  data.setLocale(lang).catch(() => {});
  return getLang();
}

/**
 * Switch the language (the switch on the title screen and in 设置): keeps the choice, loads the translations, then
 * re-renders; the game texts follow when their overlay has downloaded.
 * @param {string} lang
 * @returns {Promise<string>} the language in effect
 */
export async function switchLang(lang) {
  wire();
  const want = normalizeLang(lang) || DEFAULT_LANG;
  savePref(PREF_KEY, want);
  if (want !== DEFAULT_LANG && !(await loadUiMessages(want))) return getLang();
  setLang(want);
  data.setLocale(want).catch(() => {});
  return getLang();
}

/**
 * Preact hook: the current language; the component re-renders when it changes.
 * @returns {string}
 */
export function useLang() {
  const [lang, setState] = useState(getLang);
  useEffect(() => {
    setState(getLang());
    return onLangChange((l) => setState(l));
  }, []);
  return lang;
}

/**
 * The language switch (segmented 中文 | English).
 * @param {{ class?: string }} props
 */
export function LangToggle({ class: cls }) {
  const lang = useLang();
  return html`<div class=${`set-seg lang-toggle${cls ? ` ${cls}` : ''}`} role="radiogroup" aria-label=${SWITCH_LABEL} data-testid="lang-toggle">
    ${LANGS.map((l) => html`<button key=${l} type="button" role="radio" lang=${l === 'zh' ? 'zh-CN' : 'en'} aria-checked=${lang === l ? 'true' : 'false'}
      class=${lang === l ? 'is-on' : ''} data-lang=${l} onClick=${() => { if (lang !== l) switchLang(l); }}>${LANG_LABELS[l]}</button>`)}
  </div>`;
}

/**
 * The text of an m.ticker frame in the current language. A config.broadcasts line (`id` + `args`, server ≥ 0.2.0) is
 * rebuilt from the localized broadcast template — `{0}` is the player's name (never translated), other args are
 * game-data names or numbers; any other line goes through translateWire (msgid + params, or its text as a msgid).
 * @param {{ text?: string, id?: string|null, args?: unknown[], msgid?: string, params?: any }} msg
 * @returns {string}
 */
export function tickerText(msg) {
  if (getLang() !== DEFAULT_LANG && typeof msg?.id === 'string' && Array.isArray(msg.args)) {
    const list = data.get('config')?.broadcasts;
    const b = Array.isArray(list) ? list.find((x) => x && x.id === msg.id) : null;
    if (b && typeof b.text === 'string') {
      const args = msg.args.map((a, i) => (i === 0 ? String(a ?? '') : tName(String(a ?? ''))));
      return format(b.text, args);
    }
  }
  return translateWire(msg);
}
