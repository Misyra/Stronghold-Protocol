// content.js — what this page shows beyond the installation's own art (DESIGN §32 P1a, docs/PLUGINS.md §9): the room's
// visual set — the cosmetic plugins its host switched on, named by room.state.content.vs — and the player's personal
// cosmetic plugins (设置 → 外观插件, kept in this browser only: `sp.pref.cosmetics`), laid over the art manifest every
// screen reads (assets.js `cosmetics`; data.js shows `assets` through them, so `data.get('assets')` is the art the room
// draws). Nothing here changes a battle: a room's `cs` stays the vanilla one, and nobody else sees a personal plugin.
//
//   * The room: whenever room.state.content.vs changes, /vs/<vs16>/overlay.json is fetched as text, parsed and checked
//     (shared/plugins/visual.js checkVisualDoc — its composition hashes to the `vs` the room named) and becomes the room
//     layer: the page composes the art itself, on the manifest it loaded — every plugin URL built from that composition's
//     file table, every reference copied out of its own manifest, a write that does not fit left out (assets.js
//     createCosmeticLayers) —, never a manifest the server put together. Leaving the room, or a room without plugins,
//     takes the layer away again: one room's art never stays behind or piles up. A document that fails the check or
//     will not download (two retries; an attempt is given up after VISUAL_TIMEOUT_MS) leaves the original art; that, a
//     write left out or a plugin file that will not load is said once (a toast). A plugin file that will not load — an
//     `<img>` of the interface (caught here, for every image of the page), an image or a model of the board (assets.js
//     reports its own), a sound (audio.js, through main.js) — makes its entry fall back to the art beneath it: the
//     installation's, or the room's under a personal plugin (assets.js createCosmeticLayers fail).
//   * Personal plugins: the catalogue (/plugins/index.json — loadCatalog) names each loaded cosmetic plugin of scope
//     `personal` with the `vs` of the set of it alone and what the load order reads of it (requires, conflicts,
//     loadAfter / loadBefore, priority). The plugins the player switched on are ordered exactly like a room's set
//     (shared/plugins/order.js: their requirements switched on too — 「自动」 —, a conflict refused) — personalSet; a
//     switch that would make a conflict or needs a plugin the server lacks is refused with the room's message
//     (setPersonalPlugin → PLUGIN_CONFLICT / PLUGIN_DEPENDENCY), and a choice that turned bad since (the server's
//     plugins changed) keeps what still fits, by id [ASSUMED]. Each plugin of the set is fetched as
//     /vs/<vs16>/overlay.json of its catalogue `vs`, checked the same way (side by side) and applied after the room's,
//     in that order. A plugin this server does not have is skipped and stays switched on here (it shows again when the
//     server has it).
//   * The catalogue is fetched only on a server that has plugins — `content.plugins` > 0 in /healthz (the build guard's
//     first check, before any hello) or welcome (main.js keeps it as the store's `installedPlugins`: installedCount; a
//     server without any sends none, and its page never asks for /plugins/index.json) — and only when something needs
//     it: a switched-on personal plugin, the room's 插件 panel (ui/pluginPanel.js), 设置's 外观插件 (ui/settings.js) or
//     the list behind the title screen's 「本服务器安装了 N 个插件」 (that count is the server's).

import { createStore, loadPref, savePref, store as appStore } from './store.js';
import { data as dataStore } from './data.js';
import { cosmetics } from './assets.js';
import { PLUGINS_URL } from '../../shared/plugins/manifest.js';
import { VISUAL_DOC_FILE, VISUAL_SETS_URL, checkVisualDoc, isVisualHash, vsUrlPart } from '../../shared/plugins/visual.js';
import { getLang, langChain, t, N_ } from '../../shared/i18n.js';

/** The localStorage preference (`sp.pref.<key>`) of the personal cosmetic plugins: their ids. */
export const PERSONAL_PREF = 'cosmetics';
/** Waits (ms) before a visual set's document is fetched again after a transient failure (like data.js). */
export const VISUAL_RETRY_MS = Object.freeze([600, 2000]);
/** How long one attempt at a visual set's document may take before it counts as a transient failure [ASSUMED]. */
export const VISUAL_TIMEOUT_MS = 30000;
/** What the page says (once) when a set's document will not load, or when writes were left out / a file failed. */
const NOT_LOADED = N_('外观插件没有载入，显示原版素材');
const PARTLY = N_('部分外观插件素材无法使用，相应位置显示原版素材');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isIds = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{1,31}$/.test(x));
const defaultFetch = (...a) => globalThis.fetch(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The plugin catalogue (GET /plugins/index.json): `status` 'idle' | 'loading' | 'ready' | 'failed', `plugins` its
 * entries (shared/plugins/manifest.js pluginIndexEntry), `app` the server's version.
 */
export const catalog = createStore({ status: 'idle', plugins: [], app: null, at: 0 });
let catalogLoad = null;

/** shared/plugins/order.js — loaded with the catalogue (a page of a server without plugins never needs it). */
let orderModule = null;
/** Load the load-order function (with the catalogue; tests). @returns {Promise<boolean>} whether it is there */
export const loadPluginOrder = () => (orderModule ? Promise.resolve(true)
  : import('../../shared/plugins/order.js').then((m) => { orderModule = m; return true; }, () => false));

/**
 * Fetch the catalogue (never cached by the browser: the server lists what its plugins/ holds now) — and the load-order
 * function the personal plugins need with it (loadPluginOrder). Shared while one is on its way; `force` fetches again
 * even when one is there (a panel opened later sees a plugin dropped in meanwhile).
 * @param {{ force?: boolean, fetch?: typeof fetch }} [opts]
 * @returns {Promise<any[]>} the entries ([] when it is unavailable)
 */
export function loadCatalog({ force = false, fetch: doFetch = defaultFetch } = {}) {
  const cur = catalog.get();
  if (catalogLoad) return catalogLoad;
  if (cur.status === 'ready' && !force) return Promise.resolve(cur.plugins);
  catalog.set({ status: cur.status === 'ready' ? 'ready' : 'loading' });
  catalogLoad = (async () => {
    try {
      const res = await doFetch(`${PLUGINS_URL}index.json`, { cache: 'no-store' });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '???'}`);
      const body = await res.json();
      const plugins = isObj(body) && Array.isArray(body.plugins) ? body.plugins.filter(isObj) : [];
      await loadPluginOrder();
      catalog.set({ status: 'ready', plugins, app: typeof body?.app === 'string' ? body.app : null, at: Date.now() });
      return plugins;
    } catch (err) {
      console.warn(`[content] ${PLUGINS_URL}index.json unavailable (${err?.message || err})`);
      catalog.set({ status: cur.status === 'ready' ? 'ready' : 'failed' });
      return catalog.get().plugins;
    } finally {
      catalogLoad = null;
    }
  })();
  return catalogLoad;
}

/**
 * How many unofficial plugins the server has (/healthz or welcome `content.plugins`, kept by main.js as the store's
 * `installedPlugins`; 0 when it sent none): the title screen's count, and whether the catalogue is ever worth fetching.
 * @param {any} s the app store's state
 */
export const installedCount = (s) => (Number.isInteger(s?.installedPlugins) && s.installedPlugins > 0 ? s.installedPlugins : 0);

/** The catalogue's unofficial entries — every plugin but a language (the title screen's count, §7.4). @param {any[]} plugins */
export const unofficialPlugins = (plugins) => (Array.isArray(plugins) ? plugins.filter((p) => p && p.unofficial) : []);

/**
 * The loaded cosmetic plugins of the catalogue (of `scope`, when given): what a room's host (room) or a player (personal)
 * may switch on, in the catalogue's order (by id).
 * @param {any[]} plugins @param {'room' | 'personal'} [scope]
 */
export const cosmeticPlugins = (plugins, scope) => (Array.isArray(plugins) ? plugins : [])
  .filter((p) => p && p.class === 'cosmetic' && p.status === 'loaded' && (!scope || (Array.isArray(p.scope) && p.scope.includes(scope))));

/**
 * A plugin's name in the interface language: its name in the first language of the chain it has, else its own name.
 * @param {any} p a catalogue entry
 */
export function pluginName(p) {
  const names = isObj(p?.names) ? p.names : {};
  for (const code of [...langChain(getLang()), 'zh']) if (typeof names[code] === 'string' && names[code]) return names[code];
  return typeof p?.name === 'string' && p.name ? p.name : String(p?.id ?? '');
}

// ---- personal plugins -----------------------------------------------------------------------------------------------

/** The personal cosmetic plugins switched on in this browser: `{ ids }` (persisted as PERSONAL_PREF). */
export const personal = createStore({ ids: (() => { const v = loadPref(PERSONAL_PREF, []); return isIds(v) ? v : []; })() });
personal.subscribe((s) => savePref(PERSONAL_PREF, s.ids));

/** What the load order reads of a catalogue entry (shared/plugins/order.js OrderEntry). @param {any} p */
const orderEntry = (p) => ({
  id: p.id, version: typeof p.version === 'string' ? p.version : '0.0.0',
  requires: isObj(p.requires) ? p.requires : {}, optional: isObj(p.optional) ? p.optional : {}, conflicts: isObj(p.conflicts) ? p.conflicts : {},
  loadAfter: Array.isArray(p.loadAfter) ? p.loadAfter : [], loadBefore: Array.isArray(p.loadBefore) ? p.loadBefore : [],
  priority: Number.isInteger(p.priority) ? p.priority : 0,
});

/**
 * The personal set of the plugins `ids` switched on, among the catalogue's personal cosmetic plugins `entries` (see the
 * header): ordered like a room's set — their requirements switched on too (`auto`) — or, when the choice as a whole is
 * refused (a conflict, a requirement gone: the server's plugins changed since), what still fits, taken by id
 * [ASSUMED]; `skipped`: the chosen ones left out that way. Ids the catalogue does not offer are ignored (kept switched on).
 * @param {string[]} ids @param {any[]} entries cosmeticPlugins(…, 'personal') with a `vs`
 * @returns {{ order: string[], auto: string[], skipped: string[] }}
 */
export function personalSet(ids, entries) {
  const byId = new Map((Array.isArray(entries) ? entries : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, orderEntry(p)]));
  const lookup = (id) => byId.get(id) || null;
  const chosen = [...new Set(ids)].filter((id) => byId.has(id)).sort();
  // (the function comes with the catalogue — without it, which never happens once the catalogue is there: as chosen)
  const resolvePluginOrder = orderModule?.resolvePluginOrder;
  if (!resolvePluginOrder) return { order: chosen, auto: [], skipped: [] };
  const full = resolvePluginOrder(chosen, lookup);
  if (!('error' in full)) return { order: full.order, auto: full.auto, skipped: [] };
  let kept = [];
  let best = { order: [], auto: [] };
  for (const id of chosen) {
    const r = resolvePluginOrder([...kept, id], lookup);
    if ('error' in r) continue;
    kept = [...kept, id];
    best = r;
  }
  return { order: best.order, auto: best.auto, skipped: chosen.filter((id) => !kept.includes(id)) };
}

/**
 * Switch a personal cosmetic plugin on or off (this browser only). Switching one on that would conflict with the others
 * or needs a plugin this server lacks is refused (the catalogue loaded: the room's PLUGIN_CONFLICT / PLUGIN_DEPENDENCY);
 * off always works (a plugin another one needs stays in the set, 「自动」).
 * @param {string} id @param {boolean} on
 * @returns {{ ok: true } | { error: string, detail: string }}
 */
export function setPersonalPlugin(id, on) {
  const ids = personal.get().ids.filter((x) => x !== id);
  if (on) {
    const cat = catalog.get();
    if (cat.status === 'ready' && orderModule) {
      const entries = cosmeticPlugins(cat.plugins, 'personal').filter((p) => isVisualHash(p.vs));
      if (entries.some((p) => p.id === id)) {
        const byId = new Map(entries.map((p) => [p.id, orderEntry(p)]));
        const r = orderModule.resolvePluginOrder([...new Set([...ids, id])].filter((x) => byId.has(x)).sort(), (x) => byId.get(x) || null);
        if ('error' in r) return { error: r.error, detail: r.detail };
      }
    }
    ids.push(id);
  }
  personal.set({ ids: ids.sort() });
  return { ok: true };
}

/**
 * Fetch a visual set's document (/vs/<vs16>/overlay.json) as text, parse it and check it against `vs`
 * (shared/plugins/visual.js checkVisualDoc). A network error, an attempt over `timeoutMs` (VISUAL_TIMEOUT_MS) or HTTP 5xx
 * / 408 / 429 is tried again (VISUAL_RETRY_MS).
 * @param {string} vs the full visual hash the room (or the catalogue) named
 * @param {{ fetch?: typeof fetch, retryDelays?: readonly number[], wait?: (ms: number) => Promise<void>, timeoutMs?: number }} [opts]
 * @returns {Promise<{ doc: any } | { error: string }>}
 */
export async function fetchVisualDoc(vs, { fetch: doFetch = defaultFetch, retryDelays = VISUAL_RETRY_MS, wait = sleep, timeoutMs = VISUAL_TIMEOUT_MS } = {}) {
  if (!isVisualHash(vs)) return { error: 'no visual hash' };
  const url = `${VISUAL_SETS_URL}${vsUrlPart(vs)}/${VISUAL_DOC_FILE}`;
  for (let attempt = 0; ; attempt++) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => { ctrl?.abort(); resolve(null); }, timeoutMs); });
    let res;
    let text = null;
    try {
      res = await Promise.race([doFetch(url, { cache: 'no-cache', signal: ctrl?.signal }), timedOut]);
      if (res && res.ok) text = await Promise.race([res.text(), timedOut]);
    } catch { res = null; }
    clearTimeout(timer);
    const transient = !res || res.status >= 500 || res.status === 408 || res.status === 429 || (res.ok && text === null);
    if (res && res.ok && text !== null) {
      let doc;
      try { doc = JSON.parse(text); } catch { return { error: `${url}: not JSON` }; }
      const bad = checkVisualDoc(doc, vs);
      return bad ? { error: `${url}: ${bad}` } : { doc };
    }
    if (transient && attempt < retryDelays.length) { await wait(retryDelays[attempt]); continue; }
    return { error: `${url}: ${res ? `HTTP ${res.status}` : 'unreachable'}` };
  }
}

/**
 * Keep the page's cosmetic layers in step with the room and the personal plugins (see the header): data.js shows
 * `assets` through them from now on. Idempotent per store; returns the uninstall.
 * @param {{ store?: typeof appStore, data?: typeof dataStore, layers?: typeof cosmetics, fetch?: typeof fetch,
 *   toast?: ((text: string, kind?: string) => void) | null, retryDelays?: readonly number[] }} [opts]
 */
export function installContent({ store = appStore, data = dataStore, layers = cosmetics, fetch: doFetch = defaultFetch, toast = null,
  retryDelays = VISUAL_RETRY_MS } = {}) {
  const view = (v) => layers.apply(v);
  data.setView('assets', view);
  // every layer change: data.js tells the `assets` subscribers (useData('assets') re-renders the interface's art)
  const offLayers = layers.subscribe(() => data.setView('assets', view));
  // the page says it once, whatever the trouble: a document that will not load, writes left out, a file that failed
  let told = false;
  const tell = (why, text = NOT_LOADED) => {
    console.warn(`[content] ${why}`);
    if (!told && toast) { told = true; toast(t(text), 'warn'); }
  };
  layers.onDrop((reasons, count) => tell(`${count} write(s) of a visual set left out: ${reasons.join('; ')}`, PARTLY));
  let failedTold = layers.failed?.length || 0;
  const offFailed = layers.subscribe(() => {
    const now = layers.failed?.length || 0;
    if (now > failedTold) { failedTold = now; tell(`a plugin file did not load: ${layers.failed[now - 1]}`, PARTLY); }
  });
  // an <img> of the interface (a card, a portrait, an icon) whose plugin file will not load: its entry falls back (error
  // events do not bubble — caught on the way down)
  const doc = globalThis.document;
  const onImgError = (e) => { const el = e?.target; if (el && el.tagName === 'IMG') layers.fail?.(el.currentSrc || el.src); };
  doc?.addEventListener?.('error', onImgError, true);

  // the room's visual set
  let roomVs = null;
  let roomReq = 0;
  const syncRoom = (s) => {
    const vs = isVisualHash(s?.room?.content?.vs) ? s.room.content.vs : null;
    if (vs === roomVs) return;
    roomVs = vs;
    const req = ++roomReq;
    if (!vs) { layers.setRoom(null); return; }
    fetchVisualDoc(vs, { fetch: doFetch, retryDelays }).then((r) => {
      if (req !== roomReq) return; // another room (or none) meanwhile
      if ('error' in r) { layers.setRoom(null); tell(r.error); return; }
      layers.setRoom(r.doc);
    });
  };

  // the personal plugins: each one's overlay, kept by its vs (a set's document never changes for one vs)
  /** @type {Map<string, Promise<{ doc: any } | { error: string }>>} */
  const overlays = new Map();
  let personalReq = 0;
  const syncPersonal = async () => {
    const req = ++personalReq;
    const ids = personal.get().ids;
    // none switched on, or a server without plugins (never even asked for its catalogue)
    if (!ids.length || !installedCount(store.get())) { layers.setPersonal([]); return; }
    const offered = cosmeticPlugins(await loadCatalog({ fetch: doFetch }), 'personal').filter((p) => isVisualHash(p.vs));
    // the set as a room's would be (requirements switched on, a conflict refused — what still fits), in its load order
    const set = personalSet(ids, offered);
    if (set.skipped.length) console.warn(`[content] personal plugins left out (a conflict or a missing requirement): ${set.skipped.join(', ')}`);
    const entries = set.order.map((id) => offered.find((p) => p.id === id));
    // side by side; applied in that order
    for (const p of entries) if (!overlays.has(p.vs)) overlays.set(p.vs, fetchVisualDoc(p.vs, { fetch: doFetch, retryDelays }));
    const results = await Promise.all(entries.map((p) => overlays.get(p.vs)));
    const list = [];
    entries.forEach((p, i) => {
      const r = results[i];
      if ('error' in r) { overlays.delete(p.vs); tell(r.error); return; }
      list.push({ id: p.id, doc: r.doc });
    });
    if (req === personalReq) layers.setPersonal(list);
  };

  // the server's plugin count arrives with welcome (or changes on a reconnect): the personal plugins follow it
  let installed = installedCount(store.get());
  const offStore = store.subscribe((s) => {
    syncRoom(s);
    const n = installedCount(s);
    if (n !== installed) { installed = n; if (personal.get().ids.length) syncPersonal(); }
  });
  syncRoom(store.get());
  const offPersonal = personal.subscribe(() => { syncPersonal(); });
  // a catalogue fetched again may name a plugin's new `vs` (its files changed): the switched-on ones follow
  let catalogAt = catalog.get().at;
  const offCatalog = catalog.subscribe((c) => { if (c.at !== catalogAt) { catalogAt = c.at; if (personal.get().ids.length) syncPersonal(); } });
  if (personal.get().ids.length) syncPersonal();
  return () => {
    offStore(); offPersonal(); offCatalog(); offLayers(); offFailed(); layers.onDrop(null);
    doc?.removeEventListener?.('error', onImgError, true);
    data.setView('assets', null); layers.setRoom(null); layers.setPersonal([]);
  };
}

/**
 * What the diagnostics name of this page's personal plugins (public/js/diag.js contentLine): `[{ id }]` of the
 * switched-on ones the page applies now.
 */
export const personalApplied = () => cosmetics.personal.map((p) => ({ id: p.id }));
