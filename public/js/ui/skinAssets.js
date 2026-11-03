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

/**
 * The box a dynamic illustration is fitted to: the manifest's `bounds` (the setup-pose union the installer wrote), or,
 * when a record was installed before its skeleton carried a size, the posed actor measured by the runtime. Posing first
 * is what makes the measurement meaningful — pixi-spine leaves the RegionAttachment offsets unset in a setup pose
 * (render/spine.js), and render/spinePreview.js already fits from `getLocalBounds()` the same way.
 * @param {{ x?: number, y?: number, width?: number, height?: number } | null | undefined} record the manifest bounds
 * @param {{ getLocalBounds?: () => any } | null | undefined} actor the posed Spine instance
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function illustrationBounds(record, actor) {
  if (record && record.width > 0 && record.height > 0) {
    return { x: Number(record.x) || 0, y: Number(record.y) || 0, width: record.width, height: record.height };
  }
  try {
    const r = actor?.getLocalBounds?.();
    if (r && r.width > 0 && r.height > 0) return { x: Number(r.x) || 0, y: Number(r.y) || 0, width: r.width, height: r.height };
  } catch { /* a skeleton the runtime cannot measure keeps the static picture */ }
  return null;
}
