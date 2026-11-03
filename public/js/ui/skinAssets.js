// Appearance records of one operator: the composed manifest keys skins by the OFFICIAL id, while the catalogue and a
// saved choice may use the stem form (shared/skins.js manifestSkinKey). Every UI preview resolves through here, so a
// picker, a detail panel and the illustration component cannot disagree about which record a choice names.
import { manifestSkinKey, dynamicIllustration } from '../../../shared/skins.js';

/**
 * The manifest skin record of an admitted appearance, or null. `charId` is the operator the record must belong to.
 * @param {any} m composed manifest (data.get('assets'))
 * @param {string} charId
 * @param {unknown} skinId catalogue id or official id
 */
export function appearanceEntry(m, charId, skinId) {
  if (!m || typeof charId !== 'string' || !charId || typeof skinId !== 'string' || !skinId) return null;
  const key = manifestSkinKey(skinId) || (skinId.startsWith('char_') ? skinId : null);
  const entry = key ? m.chars?.[charId]?.skins?.[key] : null;
  return entry && typeof entry === 'object' ? entry : null;
}

/** The still picture a preview draws before / instead of the animation: the outfit's own illustration, else portrait. */
export function appearanceStaticSrc(entry) {
  for (const key of ['illust', 'portrait', 'portraitE2', 'avatar', 'avatarE2']) {
    if (entry && typeof entry[key] === 'string' && entry[key]) return entry[key];
  }
  return null;
}

/** The playable layered illustration of a manifest record, or null (shared/skins.js dynamicIllustration). */
export function appearanceDynamic(entry) {
  return dynamicIllustration(entry);
}

/** Convenience: the dynamic record of one operator + skin choice, without asking the caller for the manifest key. */
export function dynamicFor(m, charId, skinId) {
  return appearanceDynamic(appearanceEntry(m, charId, skinId));
}
