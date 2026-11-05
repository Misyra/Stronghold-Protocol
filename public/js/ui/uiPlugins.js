// ui/uiPlugins.js — this browser's interface plugins (DESIGN §32.8). Kept in localStorage, never sent:
//   sp.pref.ui-plugins     the ids the player turned on (设置 → 界面插件)
//   sp.pref.ui-recommend   the ids the host marked 推荐 on this browser
// A recommendation does not turn a plugin on. Another player's page cannot see this browser's mark until the protocol
// supplies the list on the existing room.state (read here if it is already an array: room.uiRecommend,
// room.content.uiRecommend, room.state.uiRecommend, room.state.content.uiRecommend). No new protocol message.
// This module does not load the frame, the panel or the art compositor.

import { createStore, loadPref, savePref } from '../store.js';
import { isPluginId } from '../../../shared/plugins/manifest.js';
import { UI_ERRORS, UI_LIMITS } from '../../../shared/plugins/ui.js';

/** localStorage preference (`sp.pref.<key>`) of the interface plugins this browser has on. */
export const UI_PREF = 'ui-plugins';
/** localStorage preference of the ids this browser's host has marked 推荐. */
export const UI_RECOMMEND_PREF = 'ui-recommend';
/** localStorage preference of the ids this browser turned OFF explicitly (so `autoWith` cannot re-mount them). */
export const UI_OFF_PREF = 'ui-plugins-off';

const isIds = (v) => Array.isArray(v) && v.every((x) => isPluginId(x));

/** @param {string} key @returns {string[]} */
function loadIds(key) {
  const v = loadPref(key, []);
  return isIds(v) ? [...new Set(v)].sort() : [];
}

/** The interface plugins switched on here: `{ ids }`. */
export const uiPlugins = createStore({ ids: loadIds(UI_PREF) });
uiPlugins.subscribe((s) => savePref(UI_PREF, s.ids));

/** The ids this browser recommends (the host's own mark): `{ ids }`. */
export const uiRecommend = createStore({ ids: loadIds(UI_RECOMMEND_PREF) });
uiRecommend.subscribe((s) => savePref(UI_RECOMMEND_PREF, s.ids));

/** The ids this browser switched OFF against an automatic mount (manifest `autoWith`): `{ ids }`. */
export const uiPluginsOff = createStore({ ids: loadIds(UI_OFF_PREF) });
uiPluginsOff.subscribe((s) => savePref(UI_OFF_PREF, s.ids));

/**
 * Loaded interface plugins of scope `personal` in a catalogue.
 * @param {any[]} plugins
 * @param {boolean} [includeBundled]
 */
export function uiPluginEntries(plugins, includeBundled = false) {
  return (Array.isArray(plugins) ? plugins : []).filter((p) => p && p.status === 'loaded' && isPluginId(p.id)
    && Array.isArray(p.scope) && ((p.class === 'ui' && p.scope.includes('personal'))
      || (includeBundled && p.class === 'script' && p.scope.includes('room') && p.bundledFrame === true)));
}

/** Room-bundled frames cannot be mounted by a stale personal preference outside their room. */
export function shouldMountUiPlugin(p, { ids, off, roomIds }) {
  if (p.bundledFrame) return roomIds.includes(p.id) && !off.includes(p.id);
  const auto = !off.includes(p.id) && Array.isArray(p.autoWith) && p.autoWith.some((id) => roomIds.includes(id));
  return ids.includes(p.id) || auto;
}

/**
 * The ids the frame host mounts, capped at UI_LIMITS.maxPlugins in all: a room's bundled panels first (they mount
 * with the room, docs/PLUGINS.md §14), the personal switches filling the rest — both groups in catalogue order, so
 * eight personal plugins cannot crowd a bundled panel out of the queue.
 * @param {any[]} entries uiPluginEntries(plugins, true)
 * @param {{ ids: string[], off: string[], roomIds: string[], blocked?: string[] | Set<string>, max?: number }} opts
 * @returns {string[]}
 */
export function uiPluginWant(entries, { ids, off, roomIds, blocked = [], max = UI_LIMITS.maxPlugins }) {
  const bundled = [];
  const personal = [];
  const isBlocked = (id) => typeof blocked?.has === 'function' ? blocked.has(id) : blocked.includes(id);
  for (const p of Array.isArray(entries) ? entries : []) {
    if (!p || typeof p.id !== 'string' || isBlocked(p.id)) continue;
    if (!shouldMountUiPlugin(p, { ids, off, roomIds })) continue;
    (p.bundledFrame ? bundled : personal).push(p.id);
  }
  return [...bundled, ...personal].slice(0, Math.max(0, max));
}

/**
 * Turn one interface plugin on or off in this browser. More than UI_LIMITS.maxPlugins is refused.
 * An id the server does not have is still stored (it mounts when the server has it).
 * @param {string} id @param {boolean} on
 * @returns {{ ok: true } | { error: string }}
 */
export function setUiPlugin(id, on) {
  if (!isPluginId(id)) return { error: UI_ERRORS.PLUGIN_SHAPE };
  const cur = uiPlugins.get().ids.filter((x) => x !== id);
  if (on) {
    if (cur.length >= UI_LIMITS.maxPlugins) return { error: UI_ERRORS.PLUGIN_LIMIT };
    cur.push(id);
  }
  uiPlugins.set({ ids: cur.sort() });
  // An explicit OFF must survive the manifest's automatic mount (pluginFrame `autoWith`).
  const off = uiPluginsOff.get().ids.filter((x) => x !== id);
  if (!on) off.push(id);
  uiPluginsOff.set({ ids: off.sort() });
  return { ok: true };
}

/**
 * Mark or clear 推荐 for one id, on this browser only.
 * @param {string} id @param {boolean} on
 * @returns {{ ok: true } | { error: string }}
 */
export function toggleRecommend(id, on) {
  if (!isPluginId(id)) return { error: UI_ERRORS.PLUGIN_SHAPE };
  const cur = uiRecommend.get().ids.filter((x) => x !== id);
  if (on) cur.push(id);
  uiRecommend.set({ ids: cur.sort() });
  return { ok: true };
}

/** @param {unknown} v @returns {string[]} */
function idList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) if (isPluginId(x) && !out.includes(x)) out.push(x);
  return out;
}

/**
 * Ids a future room payload already carries. This version never sends them.
 * [ASSUMED] the field names a later package may use on the existing room.state.
 * @param {any} room
 * @returns {string[]}
 */
export function serverRecommend(room) {
  if (!room || typeof room !== 'object') return [];
  const bags = [room.uiRecommend, room.content?.uiRecommend, room.state?.uiRecommend, room.state?.content?.uiRecommend];
  const out = [];
  for (const bag of bags) for (const id of idList(bag)) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * What the room panel marks 房主推荐: this browser's marks when the local player is the host, plus any list the
 * server already sent. The host's own marks are not shown to someone else on this machine's data alone.
 * @param {any} room @param {boolean} isHost @param {string[]} [localIds]
 * @returns {string[]}
 */
export function visibleRecommend(room, isHost, localIds = uiRecommend.get().ids) {
  const out = [];
  if (isHost) for (const id of localIds) if (isPluginId(id) && !out.includes(id)) out.push(id);
  for (const id of serverRecommend(room)) if (!out.includes(id)) out.push(id);
  return out;
}
