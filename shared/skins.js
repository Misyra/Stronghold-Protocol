// Operator appearances are display-only: never replace charId, skill/module data or combat hit timings.
// Two layers live here, on purpose:
//   * the CATALOGUE (shared/skin-catalogue.js, a code module since 0.3.1): skinFor / skinsFor / skinIdFor — an admitted
//     appearance for an operator, keyed by the OPERATOR id (char_498_inside), which is what the renderer looks up.
//   * the fork's own bounds: cleanSkins / freezeSkins / visibleSkin, used by older call sites that still speak chess ids.
// Wire validation lives in shared/protocol.js (SKIN_LIMITS / isSkinId / isCharId / isSkinSelection / checkSkinSelection).
import { SKIN_CATALOGUE } from './skin-catalogue.js';

export const OPERATOR_SKINS = SKIN_CATALOGUE;
/** `choices`: the catalogue's own cap; `entries`/`idLen`: the fork's older chess-id-keyed map (kept until it is gone). */
export const SKIN_LIMITS = Object.freeze({ choices: 256, entries: 160, idLen: 64 });
const byId = new Map(OPERATOR_SKINS.map(s => [s.id, s]));
const plain = v => !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Resolve an admitted appearance for its actual operator (not a DIY slot or the replaced operator). */
export function skinFor(charId, skinId) {
  const skin = typeof skinId === 'string' ? byId.get(skinId) : null;
  return skin && skin.charId === charId ? skin : null;
}
export const skinsFor = charId => OPERATOR_SKINS.filter(s => s.charId === charId);
export function skinIdFor(choices, charId) {
  return plain(choices) && Object.hasOwn(choices, charId) ? skinFor(charId, choices[charId])?.id ?? null : null;
}

/** Exact whitelist: own charId keys and bound skin IDs only. An empty map restores default appearances. */
export function isSkinChoices(value) {
  return plain(value) && Object.keys(value).length <= SKIN_LIMITS.choices
    && Object.entries(value).every(([charId, skinId]) => !!skinFor(charId, skinId));
}
export function cleanSkinChoices(value) {
  if (!plain(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([charId, skinId]) => !!skinFor(charId, skinId)).slice(0, SKIN_LIMITS.choices));
}

// ---- the fork's older API (chess-id keyed); still used by the current picker and loadout ----------------

export const isSkinId = (v) => typeof v === 'string' && v.length > 0
  && v.length <= SKIN_LIMITS.idLen && /^[A-Za-z0-9_][A-Za-z0-9_@#+.\-]*$/.test(v);
const isChessId = (v) => /^[A-Za-z0-9_\-.:]{1,64}$/.test(v)
  && !['__proto__', 'constructor', 'prototype'].includes(v);

/** Bound and clean browser preferences / older checkpoints without trusting their shape. */
export function cleanSkins(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, skin] of Object.entries(raw)) {
    if (!isChessId(id) || !isSkinId(skin)) continue;
    out[id] = skin;
    if (Object.keys(out).length === SKIN_LIMITS.entries) break;
  }
  return out;
}

/** Choices use base chess ids; models/catalogue use char ids. Unknown skins safely render the default. */
export function freezeSkins(raw, getChess) {
  const out = {};
  for (const [id, skin] of Object.entries(cleanSkins(raw))) {
    const rec = getChess(id);
    if (!rec || rec.isGolden || rec.visible === false || rec.isHidden || rec.isDiy
        || (rec.baseId && rec.baseId !== id)) continue;
    out[id] = skin;
  }
  return Object.freeze(out);
}

/** A viewer opt-in, not the owner's preference: applies to every player's skin, including spectators. */
export function visibleSkin(skin, settings) {
  return settings?.skinsEnabled === true && isSkinId(skin) ? skin : null;
}
