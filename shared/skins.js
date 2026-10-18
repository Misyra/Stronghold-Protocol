// Cosmetic preferences only: never change operator definitions or simulation rules.
export const SKIN_LIMITS = Object.freeze({ entries: 160, idLen: 64 });
export const isSkinId = (v) => typeof v === 'string' && v.length > 0
  && v.length <= SKIN_LIMITS.idLen && /^[A-Za-z0-9_@#+.\-]+$/.test(v);
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
