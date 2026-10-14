// 干员皮肤：客户端状态与同步 (docs/SKINS.md).
//
// Two different things live here, and keeping them apart is what makes 「按需安装」 work:
//
//   * the CATALOGUE (data/skins.json) — every skin the project knows about, installed or not: ids, names, series.
//     It carries no URLs, because a skin that is not installed has no files to point at.
//   * what is INSTALLED (data/assets.json → chars[charId].skins) — the skins whose models are actually on this
//     server. `availableSkins()` marks which is which, and the picker greys out (or offers to install) the rest.
//
// The choice itself is a plain `{ [chessId]: skinId }` map, persisted per browser in localStorage and mirrored to
// the server through `room.skins` — the same shape and the same wiring as the operator loadout (ui/loadoutSync.js),
// except that this one is PUBLIC: the server puts it in `Match.publicView().players[]`, which is how a teammate
// sees your skin.

import { createStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';

export const SKINS_PREF = 'skins';
/**
 * The 商店立绘 choice lives in its own preference (and store field): unlike `skins` it is **local only** — the shop
 * card is private to this browser, so there is nothing to sync and no protocol message for it. Default = the
 * operator's own portrait (ui/assetUrls.js skinPortraitUrl / chessPortraitUrl).
 */
export const PORTRAITS_PREF = 'skinPortraits';
export const SYNC_DEBOUNCE_MS = 500;
export const RETRY_MS = 1500;

/** A stored `{ [chessId]: skinId }` map from one preference key (junk entries dropped). */
function readPref(pref) {
  const raw = loadPref(pref, null);
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [chessId, skinId] of Object.entries(raw)) {
      if (typeof chessId === 'string' && typeof skinId === 'string' && skinId) out[chessId] = skinId;
    }
  }
  return out;
}

function readStored() {
  return readPref(SKINS_PREF);
}

/**
 * The chosen skins (per browser), the 商店立绘 choices, the sync state, and the skin currently being installed —
 * kept apart from the app store for the same reason the loadout is.
 */
export const skinsStore = createStore({
  entries: readStored(), portraits: readPref(PORTRAITS_PREF), sync: 'idle', installing: null, installingProgress: null,
});

/**
 * Ask the server to install a skin's files (docs/SKINS.md).
 *
 * The reply is only an acknowledgement — an install takes tens of seconds, far longer than the 8 s a request is
 * allowed (net.js REQUEST_TIMEOUT_MS) — so the outcome arrives as `skins.changed`, which installSkinsSync()
 * handles here because it is the one place that owns the socket.
 * @param {any} net
 * @param {string} skinId
 * @returns {Promise<{ ok: boolean, state?: string }>}
 */
export async function requestSkinInstall(net, skinId) {
  skinsStore.set({ installing: skinId, installingProgress: { skinId, phase: 'queued', done: 0, total: 0 } });
  try {
    // A resolved request() already means the server accepted it. The framework answers with a bare
    // `{ t: 'ok', rid }` (server/net.js) and carries NO payload, so there is nothing here to inspect: checking
    // `.ok` on the reply (which the first version did) read undefined, treated every accepted request as a
    // failure and cleared `installing` at once — the panel fell back to its normal header and the progress the
    // server was sending all along had nothing left to render into. Errors arrive as a rejection.
    await net.request('room.skin.install', { skinId });
    return { ok: true };
  } catch (e) {
    skinsStore.set({ installing: null, installingProgress: null });
    throw e;
  }
}

/** Replace the whole selection (persisted at once; the sync picks the change up). */
export function setSkins(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof skinId === 'string' && skinId) next[chessId] = skinId;
  }
  savePref(SKINS_PREF, next);
  skinsStore.set({ entries: next });
}

/** Choose a skin for one operator. */
export function setSkin(chessId, skinId) {
  setSkins({ ...skinsStore.get().entries, [chessId]: skinId });
}

/** Drop one operator's choice (it goes back to its default model). */
export function clearSkin(chessId) {
  const next = { ...skinsStore.get().entries };
  delete next[chessId];
  setSkins(next);
}

/** The skin this browser picked for an operator, or null. */
export const skinFor = (chessId) => skinsStore.get().entries[chessId] || null;

// ---- 商店立绘 (local only) ---------------------------------------------------------------------------------------

/** Replace the whole 商店立绘 selection (persisted at once; nothing is synced). */
export function setPortraits(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof skinId === 'string' && skinId) next[chessId] = skinId;
  }
  savePref(PORTRAITS_PREF, next);
  skinsStore.set({ portraits: next });
}

/** Show one skin's 立绘 on that operator's shop card (independent of the battle model). */
export function setPortrait(chessId, skinId) {
  setPortraits({ ...skinsStore.get().portraits, [chessId]: skinId });
}

/** Drop the choice: the shop card goes back to the operator's own portrait. */
export function clearPortrait(chessId) {
  const next = { ...skinsStore.get().portraits };
  delete next[chessId];
  setPortraits(next);
}

/** The skin whose 立绘 this browser shows for an operator's shop card, or null (its own portrait). */
export const portraitFor = (chessId) => skinsStore.get().portraits[chessId] || null;

/**
 * Every skin of an operator, whether or not this install has it.
 *
 * Takes the OPERATOR id (`char_498_inside`), not the chess id (`chess_char_1_01_a`): both data/skins.json and
 * data/assets.json are grouped per operator, while a skin *choice* is stored per chess — see ui/skinPicker.js.
 * @param {string} charId
 * @returns {{ id: string, name: string, group: string, installed: boolean }[]}
 */
export function availableSkins(charId) {
  const list = data.get('skins')?.chars?.[charId];
  if (!Array.isArray(list)) return [];
  const installedHere = data.get('assets')?.chars?.[charId]?.skins || {};
  return list.map((s) => ({ id: s.id, name: s.name, group: s.group || '', installed: !!installedHere[s.id] }));
}

/** Whether this install has the files for a skin (its model and avatar are in the asset manifest). @param {string} charId */
export function isInstalled(charId, skinId) {
  return !!data.get('assets')?.chars?.[charId]?.skins?.[skinId];
}

/** Load what the picker needs (the catalogue, and the manifest that says what is installed). */
export function loadSkinData() {
  data.load('skins').catch(() => {});
  data.load('assets').catch(() => {});
}

/**
 * Keep the server's copy of this browser's skins current.
 *
 * Mirrors installLoadoutSync, minus the sanitising: the loadout has to be checked against data/chess.json before
 * it is sent (a stale entry would be dropped by the server), whereas a skinId needs no lookup to be sent — the
 * server keeps the entries whose chess it recognises and drops the rest, and an unknown skinId is harmless.
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 * @returns {{ flush: () => Promise<void>, dispose: () => void }}
 */
export function installSkinsSync({ net, timers } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let timer = null;
  let seq = 0;
  let pendingJson = null;
  let lastSent = null;
  let disposed = false;

  const setState = (sync) => { if (skinsStore.get().sync !== sync) skinsStore.set({ sync }); };
  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed || net.status !== 'online') { setState('idle'); return; }
    try {
      const skins = skinsStore.get().entries;
      const json = JSON.stringify(skins);
      if (json === pendingJson) return;
      if (json === lastSent && pendingJson == null) { setState('synced'); return; }
      const my = ++seq;
      pendingJson = json;
      setState('sending');
      try {
        await net.request('room.skins', { skins });
        if (my !== seq) return;
        pendingJson = null;
        lastSent = json;
        setState('synced');
      } catch (err) {
        if (my !== seq) return;
        pendingJson = null;
        const code = err && err.code;
        if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') { schedule(RETRY_MS); return; }
        console.warn('[skins] room.skins refused', code, err && err.detail);
        setState('error');
      }
    } catch (e) {
      console.warn('[skins] sync failed', e);
      setState('error');
    }
  }

  const offWelcome = net.on('welcome', () => { lastSent = null; pendingJson = null; seq++; schedule(50); });
  const offStore = skinsStore.subscribe((s, prev) => { if (s.entries !== prev.entries) schedule(); });

  // A skin installed anywhere on this server rewrites data/assets.json for EVERYONE, so the cached copy has to go:
  // a client that keeps the manifest it loaded at boot cannot resolve the new model at all (the skin id the server
  // sends for a teammate's unit would find nothing) and would fall back to the default model for the rest of the
  // session. This is also where an install requested by this player reports back.
  const offChanged = net.on('skins.changed', (msg) => {
    data.invalidate('assets');
    void data.load('assets').catch(() => {});
    const s = skinsStore.get();
    if (s.installing && (!msg || !msg.skinId || msg.skinId === s.installing)) {
      skinsStore.set({ installing: null, installingProgress: null, lastInstalled: msg ? msg.skinId : null, lastInstalledOk: !msg || msg.ok !== false });
    }
  });

  // how far along the install this client asked for is (the requester only — the server sends it to nobody else)
  const offProgress = net.on('skin.progress', (msg) => {
    if (!msg) return;
    const s = skinsStore.get();
    if (s.installing && s.installing !== msg.skinId) return;
    skinsStore.set({ installingProgress: { skinId: msg.skinId, phase: msg.phase, done: msg.done | 0, total: msg.total | 0 } });
  });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStore?.();
      offChanged?.();
      offProgress?.();
    },
  };
}
