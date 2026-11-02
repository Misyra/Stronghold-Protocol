// 干员皮肤：客户端状态与同步 (docs/SKINS.md).
//
// Where an appearance comes from: NOT from data/*.json. A skin is written by a COSMETIC PLUGIN's overlay
// (docs/PLUGINS.md §9) — `chars[<charId>].illust` and `chars[<charId>].skins[<skinKey>] = { name, group, avatar,
// avatarE2, portrait, portraitE2, illust, spine: { front, back? } }` — so the source of truth is the composed asset
// manifest: data.get('assets'), which data.js shows through public/js/cosmetics.js `cosmetics.apply` (the room's visual
// set, then this player's personal plugins, over the installation's own manifest). The plugin is INSTALLED by the
// server's owner and switched on by each player in 设置 → 外观插件 (`scope: ["personal"]`: no room, no host, no cs).
//
// Two different things live here and keeping them apart is what makes the picker work:
//
//   * the CATALOGUE — `chars[<charId>].skins` of the manifest above: whatever the enabled plugins write, plus the
//     operator's own `illust` as the 默认 tile's art. Picture-only outfits are wearable too (B6, maintainer option A,
//     2026-10-18): their missing model stays the operator's default.
//   * the CHOICE — a plain `{ [charId]: skinId }` map, persisted per browser in localStorage and mirrored to the
//     server through `room.skins` — the shape the loadout uses (ui/loadoutSync.js installPrefSync), except that this
//     one is PUBLIC: the server puts it in `Match.publicView().players[].skins` and in every unit of a watched board,
//     which is how a teammate sees your skin (server/match/match/views.js).
//
// The key is the OPERATOR id (`char_498_inside`), not the chess id: the manifest groups skins under the operator, and
// an operator's normal, elite and 自选 pieces are the same operator — one entry covers all three. The renderer agrees:
// a unit's skin is looked up by `charId` (server/match/match/views.js `skinFor`).

import { createStore, loadPref, savePref, useStore } from '../store.js';
import { data } from '../data.js';
import { SKIN_LIMITS } from '../../../shared/protocol.js';
import { isCharId, manifestSkinKey, skinsFor } from '../../../shared/skins.js';

/** The localStorage preference (`sp.pref.<key>`) of this browser's skin choices: `{ [charId]: skinId }`. */
export const SKINS_PREF = 'skins';
/** The localStorage preference of this browser's 商店立绘 choices (移植自用户分支, local only): `{ [chessId]: skinId | 'e2' }`. */
export const PORTRAITS_PREF = 'skins.portraits';

/** The store field the sync engine watches (ui/loadoutSync.js installPrefSync `key`) and its sync state field. */
export const SKINS_KEY = 'skins';
export const SKINS_SYNC_KEY = 'skinsSync';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Whether a skin record names a Spine model (not whether it can be worn). Like assets.js
 * `skinHasModel`; actual model loading additionally checks `validSpine`. This module is on the
 * boot path (main.js → screens/lobby.js → screens/loadout.js → ui/loadoutSync.js) and pulling the asset store in with
 * its Spine cache there would be a cost the title page never needs (test/ui/plugins-client.test.js pins that). The
 * difference can only be a skin whose model is written but does not resolve — the picker would offer it once and the
 * renderer would draw the operator's own body, which is the same fallback a plugin-withdrawn model gets.
 */
export const skinHasModel = (skin) => !!skin && isObj(skin.spine) && isObj(skin.spine.front) && typeof skin.spine.front.skel === 'string';

// B6: maintainer option A (2026-10-18), docs/history/0.3.2.md §35.4. [ASSUMED] The existing E2 and
// illust slots count as pictures too; metadata alone never offers a selectable outfit.
export const skinHasPictures = (skin) => !!skin && ['avatar', 'avatarE2', 'portrait', 'portraitE2', 'illust'].some((key) => str(skin[key]));

/**
 * Display choice for an effective operator body. #686 keeps each seat independent; no viewer choice leaks into
 * another seat. [ASSUMED] Latest public choices (including clears) beat old unit metadata, as in render/app.js.
 * An omitted owner means the local picker; null means an unowned catalogue entry. Official skin_table.charSkins
 * groups pictures by charId; activity_table backupCharId / the DIY pick decides which charId callers pass.
 */
/**
 * A summon's outfit as this viewer may see it (#876): the skin id its owner's operator carries (a piece's `skin`, a unit's
 * `skin`), shown for one's own summons always and for another player's only with 显示其他玩家的皮肤 — the operators' gate.
 */
export function tokenSkinShown(skin, { ownerId = null, myId = null, otherSkins = true } = {}) {
  const s = str(skin);
  if (!s) return null;
  return ownerId != null && ownerId !== myId && !otherSkins ? null : s;
}

export function ownerSkin(charId, { ownerId, myId = null, players = [], localSkins = {}, skin = null, otherSkins = true } = {}) {
  if (!charId || ownerId === null) return null;
  if (ownerId === undefined) return str(localSkins[charId]);
  if (ownerId !== myId && !otherSkins) return null;
  const owner = players.find((p) => p.playerId === ownerId);
  if (owner) return str(owner.skins?.[charId]);
  return str(skin);
}

/**
 * A stored selection as the store holds it: `{ [charId]: skinId }`, both non-empty strings, at most
 * `SKIN_LIMITS.entries` of them.
 *
 * The cap is the WIRE's own (shared/protocol.js isSkinSelection) and it is applied here because this is the only parse
 * of a stored selection: the store's initial state, every edit (setSkins / setSkin / clearSkin) and what the sync sends
 * (ui/loadoutSync.js installSkinsSync `prepare`) all come through it. Over the limit is not a bigger message the server
 * trims — it is BAD_MSG for the whole `room.skins`, so nothing would be stored and the sync would sit in 'error'
 * (ui/loadoutSync.js installPrefSync). Pairs are kept in insertion order, the way the not-owned list keeps the first ids
 * it can hold (ui/ownershipModel.js cleanIds); only a hand-edited localStorage gets near the limit, and junk that is not
 * a pair does not spend the budget.
 */
export function parseStoredSkins(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  let kept = 0;
  for (const [charId, skinId] of Object.entries(raw)) {
    if (kept >= SKIN_LIMITS.entries) break;
    if (!str(charId) || !str(skinId)) continue;
    out[charId] = skinId;
    kept++;
  }
  return out;
}

/**
 * This browser's choices and their sync state, kept apart from the app store for the same reason the loadout is
 * (ui/loadoutSync.js: it must survive a room / match reset). `ui/loadoutSync.js installSkinsSync` watches
 * `SKINS_KEY` and mirrors it to the server as `room.skins`.
 *
 * 移植自用户分支的双轨: `entries` / `portraits` 是选择器写读的原表(chess id / 自选槽 id 为键, 商店立绘是本机
 * 的), `SKINS_KEY` 是同一选择的 charId 键归一像(skinChoicesOf), 既有同步引擎与渲染读取都不用改。
 */
export const skinsStore = createStore({
  [SKINS_KEY]: parseStoredSkins(loadPref(SKINS_PREF, null)),
  [SKINS_SYNC_KEY]: 'idle',
  entries: parseStoredSkins(loadPref(SKINS_PREF, null)),
  portraits: parseStoredSkins(loadPref(PORTRAITS_PREF, null)),
});

/**
 * Replace the whole stored selection (persisted at once; the sync engine picks the change up). Out-of-match data, so
 * nothing is sanitised away here: a stored id whose plugin is switched off today is kept, and comes back with it
 * (`chosenSkin` reports it as 默认 while it resolves to nothing).
 * @param {Record<string, string>} entries
 */
export function setSkins(entries) {
  const next = parseStoredSkins(entries);
  const mirror = skinChoicesOf(next);
  try { savePref(SKINS_PREF, mirror); } catch { /* private mode: the session keeps it */ }
  skinsStore.set({ [SKINS_KEY]: mirror, entries: next });
}

/** Choose one operator's appearance (移植自用户分支的一次选择语义: 战斗模型与商店立绘同时写). */
export function setSkin(chessId, skinId) {
  const id = str(chessId), skin = str(skinId);
  if (!id || !skin) return;
  setSkins({ ...(skinsStore.get().entries || {}), [id]: skin });
  applyPortraits({ ...(skinsStore.get().portraits || {}), [id]: skin });
}

/** Drop one operator's choice (it goes back to its default model). */
export function clearSkin(charId) {
  const id = str(charId);
  const next = { ...(skinsStore.get()[SKINS_KEY] || {}) };
  if (!(id in next)) return;
  delete next[id];
  setSkins(next);
}

/**
 * 本浏览器当前装备的皮肤键 (移植自用户分支, the resource preload follows them): the equipped skin ids of the raw
 * choice map and the 商店立绘 map, as the `<charId>/<official skin id>` keys the 资源预载 names (docs/SKINS.md;
 * tools/assets/plan.mjs) — picking one in 干员调配 starts its download. A choice written against a chess id (干员调配
 * works per chess) resolves to the operator the manifest groups skins under (data.lookup('chess', …)?.charId); a
 * charId-keyed entry (the 0.3.3 form) passes through. The art-only values (`PORTRAIT_E2`, `''`) name no outfit.
 * @returns {string[]} sorted, deduplicated
 */
export function equippedSkinKeys() {
  const keys = new Set();
  const add = (chessId, skinId) => {
    // a catalogue id maps to the manifest key; a skin installed ahead of a catalogue refresh carries that key already
    // (official ids start with `char_`, so `e2` — the 精英二立绘 pick — still names no outfit and is skipped)
    const mapped = typeof skinId === 'string' ? manifestSkinKey(skinId) : null;
    const key = mapped || (typeof skinId === 'string' && skinId.startsWith('char_') ? skinId : null);
    if (!key) return;
    if (isCharId(chessId)) { keys.add(`${chessId}/${key}`); return; }
    const charId = data.lookup('chess', chessId)?.charId;
    if (charId) keys.add(`${charId}/${key}`);
  };
  for (const [chessId, skinId] of Object.entries(skinsStore.get().entries || {})) add(chessId, skinId);
  for (const [chessId, skinId] of Object.entries(skinsStore.get().portraits || {})) add(chessId, skinId);
  return [...keys].sort();
}

/** The equipped keys after the server sync has had a chance to land (the preload re-applies its scope with them). */
export async function loadEquippedSkinKeys() {
  return equippedSkinKeys();
}

// ---- 商店立绘 (移植自用户分支, local only) -----------------------------------------------------------------------

/** Replace the whole 商店立绘 selection (persisted at once; nothing is synced). */
export function setPortraits(entries) { applyPortraits(entries); }

/** Write the shop-art map (`portraits`) alone — the bulk shape, no cross-sync. */
function applyPortraits(entries) {
  const next = parseStoredSkins(entries);
  try { savePref(PORTRAITS_PREF, next); } catch { /* private mode: the session keeps it */ }
  skinsStore.set({ portraits: next });
}

/**
 * Pick what an operator's shop card shows. A real outfit also becomes that operator's battle model — otherwise the same
 * choice would have to be made again in the model group (custom_docs/SKINS.md). `PORTRAIT_E2` ('e2') and `''` (原始立绘)
 * restore the default battle model; the battlefield still chooses its normal or elite form from the piece itself.
 */
export function setPortrait(chessId, skinId) {
  const id = str(chessId);
  if (!id) return;
  const pick = str(skinId);
  applyPortraits({ ...(skinsStore.get().portraits || {}), [id]: pick || '' });
  if (pick && pick.startsWith('char_')) setSkins({ ...(skinsStore.get().entries || {}), [id]: pick });
  else if (pick === 'e2' || !pick) clearSkin(id);
}

/** Return to the operator's original portrait and default battle model. */
export function clearPortrait(chessId) { setPortrait(chessId, ''); }

/** The skin whose 立绘 this browser shows for an operator's shop card, or null (its own portrait). */
export const portraitFor = (chessId) => (str(chessId) ? (skinsStore.get().portraits || {})[chessId] || null : null);

// ---- reading the choice in a component (移植自用户分支) -----------------------------------------------------------

/**
 * A chess's 商店立绘 pick as a HOOK: `''` when nothing is chosen, else `PORTRAIT_E2` or a skin id (assetUrls.js
 * `shopPortraitUrl`). `chessId` may be nullish: the selector is a constant then. `Object.is` on the string means only
 * THIS chess's change re-renders the caller.
 * @param {string|null|undefined} chessId @returns {string} `''` | `'e2'` | skinId
 */
export function usePortraitPick(chessId) {
  return useStore((s) => (chessId ? s.portraits?.[chessId] || '' : ''), Object.is, skinsStore);
}

/** A chess's 皮肤 / battle-model pick as a hook (`''` when nothing is chosen) — same contract as `usePortraitPick`. */
export function useSkinPick(chessId) {
  return useStore((s) => (chessId ? s.entries?.[chessId] || '' : ''), Object.is, skinsStore);
}

// ---- 自选编队 slots (移植自用户分支) -------------------------------------------------------------------------------

/**
 * A skin selection's structural clean (for imports / loadout envelopes): `{ [chessId]: skinId }` with string values,
 * junk dropped. The lightness is deliberate — a value this build does not know resolves to nothing in spineEntry(), so
 * the shape is all that is worth checking before the values reach the store.
 * @param {any} raw
 * @returns {Record<string, string>}
 */
export function cleanSkinsMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [chessId, skinId] of Object.entries(raw)) {
    if (typeof chessId === 'string' && typeof skinId === 'string' && skinId) out[chessId] = skinId;
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
  const oldEntries = skinsStore.get().entries || {};
  const oldPortraits = skinsStore.get().portraits || {};
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

// ---- the wire's charId-keyed projection (既有同步引擎读它) --------------------------------------------------------

/** The 自选 picks the sync resolves slot entries against (ui/loadoutSync.js sets this at module load). */
let diyPicksProvider = () => ({});
/** @param {() => Record<string, { charId?: string }>} fn */
export function setDiyPicksProvider(fn) { diyPicksProvider = typeof fn === 'function' ? fn : () => ({}); }

/**
 * The `room.skins { choices }` payload of a local choice map: `{ [charId]: skinId }`, one entry per OPERATOR — the key
 * the wire, the catalogue and the server's whitelist use (shared/skins.js isSkinChoices).
 *
 * A chess id reaches its operator through data/chess.json; a charId-keyed entry (the 0.3.3 form, and the 自选槽以
 * 干员 charId 记的语义) passes through as-is; a 自选 slot id takes the operator PICKED for it from the stored roster.
 * Two slots picking the same operator collapse to one entry, which is exactly the wire's model. Anything this browser
 * cannot resolve to an operator is left out — the server would refuse the whole map otherwise.
 * @param {Record<string, string>} entries @returns {Record<string, string>}
 */
export function skinChoicesOf(entries) {
  const out = {};
  for (const [id, skinId] of Object.entries(entries || {})) {
    if (typeof skinId !== 'string' || !skinId) continue;
    if (isCharId(id)) { out[id] = skinId; continue; }
    const rec = data.lookup('chess', id);
    const charId = typeof rec?.charId === 'string' ? rec.charId
      : (diyPicksProvider()?.[id]?.charId ?? null);
    if (!charId) continue;
    out[charId] = skinId;
  }
  return out;
}

/** This browser's choice for one operator, or null. */
export const skinFor = (charId) => (str(charId) ? (skinsStore.get()[SKINS_KEY] || {})[charId] || null : null);

// ---- the catalogue (the composed asset manifest) --------------------------------------------------------------

/**
 * Every appearance of an operator the enabled plugins write, plus what the renderer makes of each (docs/SKINS.md).
 *
 * `playable` accepts a model or pictures. `pictureOnly` marks outfits using the default battle model.
 *
 * Art falls back the way the renderer falls back, and NEVER to a placeholder: a skin that ships no portrait shows the
 * operator's own (its `illust`, then its `portrait`). That is why `portrait` / `avatar` / `illust` here are already
 * resolved URLs, not raw manifest fields.
 * @param {string} charId operator id (`char_498_inside`)
 * @returns {{ id: string, name: string, group: string, playable: boolean, portrait: string|null, avatar: string|null,
 *   illust: string|null }[]}
 */
export function availableSkins(charId) {
  const id = str(charId);
  if (!id) return [];
  const m = data.get('assets');
  const rec = m && isObj(m.chars) ? m.chars[id] : null;
  // a record without `skins` still has its own appearance (the 默认 row below), because the picker's global display rule
  // shows the section for an operator the plugins wrote no skin for (hasAnySkinChoices, docs/SKINS.md)
  if (!rec) return [];
  const ownIllust = str(rec.illust);
  const ownPortrait = str(rec.portrait);
  const ownAvatar = str(rec.avatar);
  const rows = [];
  for (const [skinId, skin] of Object.entries(isObj(rec.skins) ? rec.skins : {})) {
    if (!str(skinId) || !isObj(skin)) continue;
    const hasModel = skinHasModel(skin);
    const playable = hasModel || skinHasPictures(skin);
    // the tile art: the fixed-size portrait family first (a 1:2 box the grid lines up on), then the illustration, then
    // the avatar; the operator's own portrait when the skin ships none (`fallbackArt`, which the picker draws a little
    // differently so a plugin that replaced only the model is legible)
    const ownArt = str(skin.portrait) || str(skin.portraitE2) || str(skin.illust);
    const portrait = ownArt || ownPortrait;
    const avatar = str(skin.avatar) || str(skin.avatarE2) || str(skin.illust) || ownAvatar;
    const illust = str(skin.illust) || portrait;
    rows.push({
      id: skinId,
      name: str(skin.name) || skinId,
      group: str(skin.group) || '',
      playable,
      pictureOnly: playable && !hasModel,
      portrait,
      avatar,
      illust,
      fallbackArt: !ownArt && !str(skin.avatar) && !str(skin.avatarE2),
      own: false,
      installed: true,
    });
  }
  // 目录制 (移植自用户分支): the catalogue lists every official skin of the operator. The ones this server carries
  // are already in the manifest loop above (the manifest is the installation's truth); the rest are listed 未安装
  // and not selectable — the picker shows them so a player can tell "the server has no such skin" from "there is
  // no such skin". Manifest keys are the official ids, so the two id forms are deduplicated through manifestSkinKey.
  const seen = new Set(rows.map((r) => r.id));
  for (const s of skinsFor(id)) {
    const cid = s && str(s.id);
    if (!cid || seen.has(cid) || seen.has(manifestSkinKey(cid))) continue;
    seen.add(cid);
    rows.push({
      id: cid, name: str(s.name) || cid, group: str(s.brand) || '', playable: false, pictureOnly: false,
      portrait: null, avatar: null, illust: null, fallbackArt: false, own: false, installed: false,
    });
  }
  // The operator's OWN appearance, always the first row — even for a record the plugins wrote no `skins` under, because
  // the picker shows the section for every operator as soon as one of them has a skin (hasAnySkinChoices).
  //
  // The art is what a plugin wrote for the operator: its 立绘 `chars[<charId>].illust` when there is one — the picture a
  // plugin replaces for the operator itself (docs/PLUGINS.md §9), which the 默认 tile is the only place to see — else its
  // portrait, else its avatar. Preferring the 立绘 is deliberate: a plugin may give an operator a picture and no skin at
  // all, and that picture must be visible rather than staying in the manifest unread. The tile box is 1:2 and crops to
  // the top, exactly as it already does for a skin that ships only an illust. Never null while the record has any of
  // the three: an empty art box is the one thing this row must not draw.
  rows.unshift({
    id: '', name: '', group: '', playable: true,
    portrait: ownIllust || ownPortrait, avatar: ownAvatar,
    illust: ownIllust || ownPortrait, fallbackArt: false, own: true, installed: true,
  });
  return rows;
}

/**
 * Whether the composed manifest offers a skin choice ANYWHERE: at least one operator of `data.get('assets').chars` has
 * one wear-able skin. This is the picker's display rule (docs/SKINS.md), and it is GLOBAL on purpose.
 *
 * The rule it replaced (a per-operator one, still available as `hasSkinChoices`) hid the whole section from every
 * operator a plugin wrote no skin for — so a player looking at such an operator could not tell "this operator has no
 * skin" from "the plugin did not load", and the feature read as broken. Since this rule, an operator without a skin
 * shows the section holding its 默认 tile alone: the plugin is plainly on, this operator simply has no look of its own.
 * Do NOT turn this back into a per-operator gate — that is the whole point of the change, and it reverses it.
 *
 * Nothing wearing anything means no section anywhere, keeping the promise that an installation without a cosmetic layer
 * looks exactly as it did before the feature: no plugin, a plugin that writes only pictures (`illust`) and no skin, or
 * only metadata-only skins (no model or pictures to wear).
 *
 * Counted through `hasSkinChoices` (one operator's rows at a time) so the global and the per-operator judgement can
 * never disagree about what a "wear-able skin" is.
 * @returns {boolean}
 */
export function hasAnySkinChoices() {
  const m = data.get('assets');
  const chars = m && isObj(m.chars) ? m.chars : null;
  if (!chars) return false;
  return Object.keys(chars).some((charId) => hasSkinChoices(charId));
}

/**
 * Whether ONE operator has a choice to offer at all: **默认 plus at least one wear-able appearance**.
 *
 * This is NOT the picker's display rule any more (that is `hasAnySkinChoices`, docs/SKINS.md): the section is shown for
 * every operator once one of them has a skin, so the single- 默认 box this returns false for is deliberately drawn.
 * Kept exported as the single-operator criterion — the question a badge, a filter or a future rule would ask, and what
 * `hasAnySkinChoices` is built from.
 *
 * A skin with art but no model counts too (B6); a metadata-only record does not.
 * @param {string} charId
 * @returns {boolean}
 */
export function hasSkinChoices(charId) {
  return availableSkins(charId).some((x) => !x.own && x.playable);
}

/**
 * The appearance this operator really wears for a stored selection, or null (默认).
 *
 * A stored id that is not one of THIS operator's wear-able appearances counts as no choice: the plugin may have been
 * switched off, the skin removed from its overlay, or the entry may name a model this client cannot resolve. The
 * entry itself is left alone — switching the plugin back on brings the appearance back — exactly as the renderer and
 * the server fall back to the default model for a skin they cannot resolve (assets.js spineEntry).
 * @param {string} charId @param {Record<string, string>} [entries] defaults to this browser's live selection
 * @returns {string|null}
 */
export function chosenSkin(charId, entries = null) {
  const id = str(charId);
  if (!id) return null;
  const want = str((entries || skinsStore.get()[SKINS_KEY] || {})[id]);
  if (!want) return null;
  return availableSkins(id).some((x) => !x.own && x.playable && x.id === want) ? want : null;
}

/** The files the picker reads: the composed manifest (the skins, and the 默认 tile's own art). */
export function loadSkinData() {
  data.load('assets').catch(() => {});
}
