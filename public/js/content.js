// content.js — what this page shows beyond the installation's own art (DESIGN §32 P1a, docs/PLUGINS.md §5): the room's
// visual set — the cosmetic plugins its host switched on, named by room.state.content.vs — and the player's personal
// cosmetic plugins (设置 → 外观插件, kept in this browser only: `sp.pref.cosmetics`), laid over the art manifest every
// screen reads (assets.js `cosmetics`; data.js shows `assets` through them, so `data.get('assets')` is the art the room
// draws). Nothing here changes a battle: a room's `cs` stays the vanilla one, and nobody else sees a personal plugin.
//
//   * The room: whenever room.state.content.vs changes, /vs/<vs16>/assets.json is fetched as text, parsed and checked
//     (shared/plugins/visual.js checkVisualDoc — its composition hashes to the `vs` the room named; the document carries
//     this server's asset URLs, which follow its asset index, so its bytes are not what is checked [ASSUMED]) and becomes
//     the room layer. Leaving the room, or a room without plugins, takes the layer away again: one room's art never
//     stays behind or piles up. A document that fails the check or will not download (two retries) leaves the original
//     art and says so once (a toast).
//   * Personal plugins: the catalogue (/plugins/index.json — loadCatalog) names each loaded cosmetic plugin of scope
//     `personal` with the `vs` of the set of it alone; every switched-on one is fetched as /vs/<vs16>/overlay.json,
//     checked the same way and applied after the room's, in the catalogue's order (by id) [ASSUMED]. A plugin this
//     server does not have is skipped and stays switched on here (it shows again when the server has it). The catalogue
//     is fetched only when something needs it: a switched-on personal plugin, the room's 插件 panel (ui/pluginPanel.js),
//     设置's 外观插件 (ui/settings.js) or the title screen's 「本服务器安装了 N 个插件」.

import { createStore, loadPref, savePref, store as appStore } from './store.js';
import { data as dataStore } from './data.js';
import { cosmetics } from './assets.js';
import { PLUGINS_URL } from '../../shared/plugins/manifest.js';
import { VISUAL_SETS_URL, checkVisualDoc, isVisualHash, vsUrlPart } from '../../shared/plugins/visual.js';
import { getLang, langChain, t } from '../../shared/i18n.js';

/** The localStorage preference (`sp.pref.<key>`) of the personal cosmetic plugins: their ids. */
export const PERSONAL_PREF = 'cosmetics';
/** Waits (ms) before a visual set's document is fetched again after a transient failure (like data.js). */
export const VISUAL_RETRY_MS = Object.freeze([600, 2000]);

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

/**
 * Fetch the catalogue (never cached by the browser: the server lists what its plugins/ holds now). Shared while one is
 * on its way; `force` fetches again even when one is there (a panel opened later sees a plugin dropped in meanwhile).
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

/** Switch a personal cosmetic plugin on or off (this browser only). @param {string} id @param {boolean} on */
export function setPersonalPlugin(id, on) {
  const ids = personal.get().ids.filter((x) => x !== id);
  if (on) ids.push(id);
  personal.set({ ids: ids.sort() });
}

/**
 * Fetch a visual set's document (/vs/<vs16>/assets.json or overlay.json) as text, parse it and check it against `vs`
 * (shared/plugins/visual.js checkVisualDoc). A network error or HTTP 5xx / 408 / 429 is tried again (VISUAL_RETRY_MS).
 * @param {'assets' | 'overlay'} kind
 * @param {string} vs the full visual hash the room (or the catalogue) named
 * @param {{ fetch?: typeof fetch, retryDelays?: readonly number[], wait?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ doc: any } | { error: string }>}
 */
export async function fetchVisualDoc(kind, vs, { fetch: doFetch = defaultFetch, retryDelays = VISUAL_RETRY_MS, wait = sleep } = {}) {
  if (!isVisualHash(vs)) return { error: 'no visual hash' };
  const url = `${VISUAL_SETS_URL}${vsUrlPart(vs)}/${kind}.json`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await doFetch(url, { cache: 'no-cache' }); } catch { res = null; }
    const transient = !res || res.status >= 500 || res.status === 408 || res.status === 429;
    if (res && res.ok) {
      let doc;
      try { doc = JSON.parse(await res.text()); } catch { return { error: `${url}: not JSON` }; }
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
  let told = false;
  const tell = (why) => {
    console.warn(`[content] ${why}`);
    if (!told && toast) { told = true; toast(t('外观插件没有载入，显示原版素材'), 'warn'); }
  };

  // the room's visual set
  let roomVs = null;
  let roomReq = 0;
  const syncRoom = (s) => {
    const vs = isVisualHash(s?.room?.content?.vs) ? s.room.content.vs : null;
    if (vs === roomVs) return;
    roomVs = vs;
    const req = ++roomReq;
    if (!vs) { layers.setRoom(null); return; }
    fetchVisualDoc('assets', vs, { fetch: doFetch, retryDelays }).then((r) => {
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
    if (!ids.length) { layers.setPersonal([]); return; }
    const entries = cosmeticPlugins(await loadCatalog({ fetch: doFetch }), 'personal').filter((p) => ids.includes(p.id) && isVisualHash(p.vs));
    const list = [];
    for (const p of entries) {
      if (!overlays.has(p.vs)) overlays.set(p.vs, fetchVisualDoc('overlay', p.vs, { fetch: doFetch, retryDelays }));
      const r = await overlays.get(p.vs);
      if ('error' in r) { overlays.delete(p.vs); tell(r.error); continue; }
      list.push({ id: p.id, ops: Array.isArray(r.doc.ops) ? r.doc.ops : [] });
    }
    if (req === personalReq) layers.setPersonal(list);
  };

  const offStore = store.subscribe((s) => syncRoom(s));
  syncRoom(store.get());
  const offPersonal = personal.subscribe(() => { syncPersonal(); });
  // a catalogue fetched again may name a plugin's new `vs` (its files changed): the switched-on ones follow
  let catalogAt = catalog.get().at;
  const offCatalog = catalog.subscribe((c) => { if (c.at !== catalogAt) { catalogAt = c.at; if (personal.get().ids.length) syncPersonal(); } });
  if (personal.get().ids.length) syncPersonal();
  return () => { offStore(); offPersonal(); offCatalog(); offLayers(); data.setView('assets', null); layers.setRoom(null); layers.setPersonal([]); };
}

/**
 * What the diagnostics name of this page's personal plugins (public/js/diag.js contentLine): `[{ id }]` of the
 * switched-on ones the page applies now.
 */
export const personalApplied = () => cosmetics.personal.map((p) => ({ id: p.id }));
