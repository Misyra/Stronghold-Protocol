// 干员皮肤：客户端状态与同步 (docs/SKINS.md).
//
// Two different things live here, and keeping them apart is what makes the picker honest:
//
//   * the CATALOGUE (shared/skin-catalogue.js, a code module): every outfit the project knows — 276 over 174 operators.
//     It carries no URLs, because an outfit that is not installed has no files to point at.
//   * what is INSTALLED (data/assets.json → chars[charId].skins[officialId]) — the outfits whose models are actually on
//     this server. `availableSkins()` marks which is which, and the picker lists the rest as 未安装.
//
// The choice itself is stored per browser as `{ [chessId]: skinId }` and mirrored to the server through
// `room.skins { choices }` as `{ [charId]: skinId }` — one entry per OPERATOR, which is the key the wire, the
// catalogue and the server's whitelist all use (shared/skins.js). The translation happens in `installSkinsSync`
// below and nowhere else; the local map stays chess-keyed because that is what the 干员调配 roster, the 自选 slots and
// the 商店立绘 choice are keyed by. This one is PUBLIC (unlike the 商店立绘): the server puts it in
// `Match.publicView().players[]` and in every unit of a watched board, which is how a teammate sees your skin.

import { createStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';
import { DIY_PREF, parseStoredDiy } from './diyModel.js';
import { manifestSkinKey, skinById, skinsFor } from '../../../shared/skins.js';

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

/**
 * A stored battle-model map as the catalogue names it: values are canonicalised to catalogue ids
 * (`char_498_inside_kitchen_2`), because a preference saved before the catalogue became a code module holds the
 * OFFICIAL id (`char_498_inside@kitchen#2`). Both a value the catalogue no longer knows and an unmatched one are
 * dropped — the operator simply wears its own model. Runs on read, so no migration step and no version stamp.
 * @param {Record<string, string>} raw
 */
function canonSkins(raw) {
  const out = {};
  for (const [chessId, skinId] of Object.entries(raw || {})) {
    const skin = skinById(skinId);
    if (skin) out[chessId] = skin.id;
  }
  return out;
}

function readStored() {
  return canonSkins(readPref(SKINS_PREF));
}

/**
 * The chosen skins (per browser), the 商店立绘 choices, the sync state, and the skin currently being installed —
 * kept apart from the app store for the same reason the loadout is.
 */
export const skinsStore = createStore({
  entries: readStored(), portraits: readPref(PORTRAITS_PREF), sync: 'idle',
});

/** Replace the whole selection (persisted at once; the sync picks the change up). */
export function setSkins(entries) {
  applySkins(entries);
}

/** Write the battle-model map (`entries`) without touching the shop art — the bulk shape the server sync and
 *  `syncDiySkins()` use, where a cross-sync would rewrite a local choice nobody asked about. */
function applySkins(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof skinId === 'string' && skinId) next[chessId] = skinId;
  }
  savePref(SKINS_PREF, next);
  skinsStore.set({ entries: next });
}

/**
 * Choose an outfit for one operator. One pick is enough: the battle model (public, synced) and the shop art (local) are
 * set together, so a player who wants an outfit does not have to make the same choice twice (custom_docs/SKINS.md). The art row
 * still offers 原始立绘 / 精英二立绘, and selecting either restores the default battle model.
 */
export function setSkin(chessId, skinId) {
  applySkins({ ...skinsStore.get().entries, [chessId]: skinId });
  applyPortraits({ ...skinsStore.get().portraits, [chessId]: skinId });
}

/** Drop one operator's choice (it goes back to its default model; an explicitly chosen art stays). */
export function clearSkin(chessId) {
  const next = { ...skinsStore.get().entries };
  delete next[chessId];
  applySkins(next);
}

/** The skin this browser picked for an operator, or null. */
export const skinFor = (chessId) => skinsStore.get().entries[chessId] || null;

/**
 * The outfits this browser has equipped, as the `<charId>/<official skin id>` keys the 资源预载 follows (docs/SKINS.md).
 * The choice is stored per chess, the asset manifest (hence the preload) is keyed per operator and by the official id,
 * so the chess table AND the catalogue have to be in for this to return anything — `loadEquippedSkinKeys()` waits.
 *
 * Both rows count: the battle model and the shop art are one choice now (`setSkin`), but 「默认模型 + 某套立绘」 is still
 * reachable by clearing the model afterwards, and that outfit's files are wanted just the same. The art-only values
 * (`PORTRAIT_E2`, `''`) name no outfit and add nothing.
 * @returns {string[]} sorted, deduplicated
 */
export function equippedSkinKeys() {
  const keys = new Set();
  const add = (chessId, skinId) => {
    const charId = data.lookup('chess', chessId)?.charId;
    // the OFFICIAL id: the resource manifest keys an outfit's files by it (tools/assets/plan.mjs), so a catalogue id
    // here would name a key no file carries and the preload would quietly skip the outfit
    const key = manifestSkinKey(skinId);
    if (charId && key) keys.add(`${charId}/${key}`);
  };
  for (const [chessId, skinId] of Object.entries(skinsStore.get().entries || {})) add(chessId, skinId);
  for (const [chessId, skinId] of Object.entries(skinsStore.get().portraits || {})) add(chessId, skinId);
  return [...keys].sort();
}

/** `equippedSkinKeys()` once the chess table is loaded (resolves to the keys, or to `[]` when it cannot be loaded). */
export function loadEquippedSkinKeys() {
  return data.load('chess').then(() => equippedSkinKeys(), () => []);
}

// ---- 商店立绘 (local only) ---------------------------------------------------------------------------------------

/** Replace the whole 商店立绘 selection (persisted at once; nothing is synced). */
export function setPortraits(entries) {
  applyPortraits(entries);
}

/** Write the shop-art map (`portraits`) alone — the bulk shape, no cross-sync (see `applySkins`). */
function applyPortraits(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof skinId === 'string' && skinId) next[chessId] = skinId;
  }
  savePref(PORTRAITS_PREF, next);
  skinsStore.set({ portraits: next });
}

/**
 * Pick what an operator's shop card shows. A real outfit also becomes that operator's battle model — otherwise the same
 * choice would have to be made again in the model group (custom_docs/SKINS.md). `PORTRAIT_E2` ('e2') and `''` (原始立绘)
 * restore the default battle model; the battlefield still chooses its normal or elite form from the piece itself.
 */
export function setPortrait(chessId, skinId) {
  applyPortraits({ ...skinsStore.get().portraits, [chessId]: skinId });
  if (typeof skinId === 'string' && skinId.startsWith('char_')) applySkins({ ...skinsStore.get().entries, [chessId]: skinId });
  else if (skinId === 'e2' || skinId === '') clearSkin(chessId);
}

/** Return to the operator's original portrait and default battle model. */
export function clearPortrait(chessId) {
  setPortrait(chessId, '');
}

/** The skin whose 立绘 this browser shows for an operator's shop card, or null (its own portrait). */
export const portraitFor = (chessId) => skinsStore.get().portraits[chessId] || null;

// ---- 自选编队 slots -----------------------------------------------------------------------------------------------

/**
 * A skin selection's structural clean (for imports / loadout envelopes): `{ [chessId]: skinId }` with string values,
 * junk dropped. The lightness is deliberate — a value this build does not know resolves to nothing in spineEntry(), so
 * the shape is all that is worth checking before the values reach the store (the sync then leaves out what the catalogue
 * cannot name, see skinChoicesOf).
 * @param {any} raw
 * @returns {Record<string, string>}
 */
export function cleanSkinsMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [chessId, skinId] of Object.entries(raw)) {
    if (typeof skinId === 'string' && skinId) out[chessId] = skinId;
  }
  return out;
}

/**
 * Keep the 皮肤 / 商店立绘 choices of the 自选 slots honest when the picks change: a slot's entry names a skin of the
 * OPERATOR picked for it, so a re-pick to a different operator (or clearing the slot) must drop both choices — a
 * stale id would silently fall back to the default model (spineEntry) and, worse, keep looking "chosen" in the UI.
 * Same-operator re-picks keep theirs.
 * @param {Record<string, any>} oldPicks @param {Record<string, any>} newPicks `{ [slotId]: { charId } }`
 */
export function syncDiySkins(oldPicks, newPicks) {
  const oldEntries = skinsStore.get().entries;
  const oldPortraits = skinsStore.get().portraits;
  const slots = new Set([...Object.keys(oldPicks || {}), ...Object.keys(newPicks || {})]);
  let nextSkins = null;
  let nextPortraits = null;
  for (const slotId of slots) {
    const oldChar = oldPicks?.[slotId]?.charId ?? null;
    const newChar = newPicks?.[slotId]?.charId ?? null;
    if (oldChar === newChar) continue;
    if (oldEntries[slotId]) {
      nextSkins = nextSkins || { ...oldEntries };
      delete nextSkins[slotId];
    }
    if (oldPortraits[slotId]) {
      nextPortraits = nextPortraits || { ...oldPortraits };
      delete nextPortraits[slotId];
    }
  }
  if (nextSkins) setSkins(nextSkins);
  if (nextPortraits) setPortraits(nextPortraits);
}

/**
 * Every outfit of an operator, whether or not this server has its files.
 *
 * Takes the OPERATOR id (`char_498_inside`), not the chess id (`chess_char_1_01_a`): the catalogue
 * (shared/skin-catalogue.js) and data/assets.json are both grouped per operator, while the local *choice* is stored per
 * chess — see ui/skinPicker.js. The row id is the CATALOGUE id, which is what the wire, the server's whitelist and the
 * menu all speak; `installed` compares against the official id the asset manifest is keyed by (shared/skins.js
 * manifestSkinKey), so the two id forms never have to meet anywhere else.
 * @param {string} charId
 * @returns {{ id: string, name: string, group: string, installed: boolean }[]}
 */
export function availableSkins(charId) {
  if (typeof charId !== 'string' || !charId) return [];
  const installedHere = data.get('assets')?.chars?.[charId]?.skins || {};
  return skinsFor(charId).map((s) => ({
    id: s.id, name: s.name, group: s.brand || '', installed: !!installedHere[manifestSkinKey(s.id)],
  }));
}

/** Whether this server has the files of a skin (its model and avatar are in the asset manifest). @param {string} charId */
export function isInstalled(charId, skinId) {
  const key = manifestSkinKey(skinId);
  return !!key && !!data.get('assets')?.chars?.[charId]?.skins?.[key];
}

/** Load what the picker needs: the asset manifest, which says which outfits this server actually has. */
export function loadSkinData() {
  data.load('assets').catch(() => {});
}

/**
 * The `room.skins { choices }` payload of a local `{ [chessId]: skinId }` map: `{ [charId]: skinId }`, one entry per
 * OPERATOR — the key the wire, the catalogue and the server's whitelist use (shared/skins.js isSkinChoices).
 *
 * A chess id reaches its operator through data/chess.json; a 自选 slot has no charId of its own (its `charId` is null:
 * the SLOT is not an operator), so it takes the operator PICKED for it from the stored roster (sp.pref.diy). Two slots
 * picking the same operator collapse to one entry, which is exactly the wire's model. Anything this browser cannot
 * resolve to an operator is left out — the server would refuse the whole map otherwise, and a piece would quietly keep
 * a default model nobody asked for.
 * @param {Record<string, string>} entries @returns {Record<string, string>}
 */
export function skinChoicesOf(entries) {
  const out = {};
  let picks = null;
  for (const [chessId, skinId] of Object.entries(entries || {})) {
    const rec = data.lookup('chess', chessId);
    let charId = typeof rec?.charId === 'string' ? rec.charId : null;
    if (!charId && rec?.isDiy) {
      if (picks === null) { try { picks = parseStoredDiy(loadPref(DIY_PREF, null)); } catch { picks = {}; } }
      charId = picks?.[chessId]?.charId ?? null;
    }
    if (!charId || typeof skinId !== 'string' || !skinId) continue;
    out[charId] = skinId;
  }
  return out;
}

/**
 * Keep the server's copy of this browser's appearances current.
 *
 * What is sent is `skinChoicesOf(entries)`, so the server sees the operator-keyed map it validates; the local map stays
 * chess-keyed. A choice the server refuses is a display preference, never an error worth a toast: it retries on RATE /
 * TIMEOUT / OFFLINE and otherwise parks in 'error' until the next edit.
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
      const choices = skinChoicesOf(skinsStore.get().entries);
      const json = JSON.stringify(choices);
      if (json === pendingJson) return;
      if (json === lastSent && pendingJson == null) { setState('synced'); return; }
      const my = ++seq;
      pendingJson = json;
      setState('sending');
      try {
        await net.request('room.skins', { choices });
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
  // The chess table decides which operator a stored chess key belongs to, so a sync that ran before it landed is worth
  // one more run once it does (skinChoicesOf would otherwise send nothing at all).
  const offChess = data.load('chess').then(() => schedule(50), () => {});
  const offStore = skinsStore.subscribe((s, prev) => { if (s.entries !== prev.entries) schedule(); });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStore?.();
      void offChess;
    },
  };
}
