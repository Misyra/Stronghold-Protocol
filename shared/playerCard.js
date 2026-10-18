// Room display metadata only. Never accept URLs, identity, stats or gameplay settings.
import { isSkinId } from './skins.js';

export const isCardOperatorId = (v) => typeof v === 'string' && (v === '' || (v.length <= 80 && /^char_[a-zA-Z0-9_]+$/.test(v)));

/** Avatar choice: a legacy operator id, or that operator's skin id (char_…@series#n). Never a URL. */
export function cardAvatarOperatorId(v) {
  if (isCardOperatorId(v)) return v;
  if (!isSkinId(v)) return '';
  const at = v.indexOf('@');
  const owner = v.slice(0, at);
  return at > 0 && at < v.length - 1 && v.indexOf('@', at + 1) < 0 && isCardOperatorId(owner) ? owner : '';
}
export const isCardAvatarId = (v) => v === '' || !!cardAvatarOperatorId(v);
// Portraits preserve the old charId field; it can now also carry an operator-owned skin id.
export const cardPortraitOperatorId = cardAvatarOperatorId;
export const isCardPortraitId = isCardAvatarId;

/**
 * Old or damaged saves degrade to defaults; unknown fields are not forwarded.
 * @param {any} v
 * @param {(id: string) => boolean} [isOperator]
 */
export function cleanPlayerCard(v, isOperator = () => true) {
  const id = (s) => isCardPortraitId(s) && s && isOperator(cardPortraitOperatorId(s)) ? s : '';
  const avatar = isCardAvatarId(v?.avatar) && isOperator(cardAvatarOperatorId(v.avatar)) ? v.avatar : '';
  return Object.freeze({ charId: id(v?.charId), avatar });
}
