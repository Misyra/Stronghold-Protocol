// Operator appearances are display-only: never replace charId, skill/module data or combat hit timings.
// IDs below are stable catalogue ids, not arbitrary resource URLs.
//
// 来源: Stardust-minus/Stronghold-Protocol @ fab1b97 shared/skins.js (verbatim) + the id limits its shared/protocol.js
// declares next to it, merged here so one module owns the model. Two local additions, both marked below:
//   * `isSkinId` / `CHAR_ID` / `isCharId` — they live in their shared/protocol.js, which imports shared/playerCard.js,
//     which needs `isSkinId`: keeping them HERE breaks that cycle.
//   * `manifestSkinKey` — our data/assets.json keys a skin by its OFFICIAL id (`char_498_inside@kitchen#2`, the id
//     tools/assets/plan.mjs writes) while the catalogue's own `id` is the stem (`char_498_inside_kitchen_2`). Their
//     manifest is flat and keyed by the stem. One helper translates, so nothing else has to know.
import { SKIN_CATALOGUE } from './skin-catalogue.js';

export const OPERATOR_SKINS = SKIN_CATALOGUE;
export const SKIN_LIMITS = Object.freeze({
  // The wire's ceiling for one `room.skins` (shared/protocol.js isSkinSelection): 256 is above the vanilla roster
  // (210 operators) and the same order as the loadout's own limit.
  choices: 256, entries: 256,
  // A skin id carries `@`, `#` and `+` (`char_002_amiya@winter#1`), so it cannot use protocol isId.
  idLen: 64,
  charIdLen: 64,
});

/** A skinId. NOT `isId`: that allows only `[A-Za-z0-9_\-.:]`, while a skin key carries `@`, `#` and `+`. */
export const isSkinId = (v) => typeof v === 'string' && v.length > 0 && v.length <= SKIN_LIMITS.idLen && /^[A-Za-z0-9_][A-Za-z0-9_@#+.\-]*$/.test(v);

/** An operator charId: official ids are `char_<digits>_<token>`, ours also `char_x_<token>` (a 自选 / 补位 stand-in). */
export const CHAR_ID = /^char_(?:x_[A-Za-z0-9_-]+|[0-9]+_[A-Za-z0-9_]+)$/;
export const isCharId = (v) => typeof v === 'string' && v.length <= SKIN_LIMITS.charIdLen && CHAR_ID.test(v);

const byId = new Map(OPERATOR_SKINS.map(s => [s.id, s]));
const byOfficial = new Map(OPERATOR_SKINS.map(s => [s.officialId, s]));
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

/**
 * The asset-manifest key of an appearance: our `chars[charId].skins` is keyed by the OFFICIAL id, and a browser
 * preference saved before the catalogue became a code module holds that official id too. Accepts either form, so the
 * renderer resolves a wire value (catalogue id) and a stored one (official id) with the same call. Null = unknown skin.
 * @param {unknown} skinId catalogue id (`char_498_inside_kitchen_2`) or official id (`char_498_inside@kitchen#2`)
 * @returns {string|null}
 */
export function manifestSkinKey(skinId) {
  if (typeof skinId !== 'string' || !skinId) return null;
  const skin = byId.get(skinId) || byOfficial.get(skinId);
  return skin ? skin.officialId : null;
}

/** The catalogue record of a skin, given either id form (used by the picker and the preview). */
export function skinById(skinId) {
  return (typeof skinId === 'string' && (byId.get(skinId) || byOfficial.get(skinId))) || null;
}
