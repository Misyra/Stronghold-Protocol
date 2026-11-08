// The 服主 key (移植自用户分支): entered once on the owner's own browser (设置 → 服主验证, shown with #owner in the
// address or once a key is kept) and sent in every hello (`owner`; the server compares it with SP_OWNER_FILE
// (server/ownerFile.js) and marks the owner's seats). Kept in localStorage outside the sp.pref.* preferences; never
// logged, shown or exported.
const KEY = 'sp.ownerKey';
export const OWNER_KEY_MAX = 128;

/** @returns {string|null} */
export function ownerKey() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return typeof v === 'string' && v.length > 0 && v.length <= OWNER_KEY_MAX ? v : null;
  } catch {
    return null;
  }
}

/** @param {string|null} value '' / null forgets it */
export function setOwnerKey(value) {
  try {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v && v.length <= OWNER_KEY_MAX) globalThis.localStorage?.setItem(KEY, v);
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* storage may be unavailable */ }
}
