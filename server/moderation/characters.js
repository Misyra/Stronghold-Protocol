// Shared nickname stripping and chat rejection rules. Emoji joiners remain valid in chat.
// Control chars, zero-width & bidi controls, BOM.
const STRIP_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const hexEscape = (n) => '\\u' + n.toString(16).padStart(4, '0');
export const STRIP_RE = new RegExp('[' + STRIP_RANGES.map(([a, b]) => (a === b ? hexEscape(a) : `${hexEscape(a)}-${hexEscape(b)}`)).join('') + ']', 'g');
export const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;


// Letters that are visually interchangeable with Latin ones. A nickname mixing Latin letters with Cyrillic or
// Greek ones is the cheap way to impersonate another player (УG for YG), so it is refused rather than normalized.
// CJK mixed with Latin — 甲YG — stays fine: those scripts are not confusable with Latin.
const HAS_LATIN = /\p{Script=Latin}/u;
const HAS_CONFUSABLE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
/** @param {unknown} name @returns {boolean} true when the name mixes look-alike scripts */
export function isConfusableName(name) {
  const s = String(name ?? '');
  return HAS_LATIN.test(s) && HAS_CONFUSABLE.test(s);
}

export const CHAT_FORBIDDEN_RE = /[\p{Cc}\p{Cs}\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
