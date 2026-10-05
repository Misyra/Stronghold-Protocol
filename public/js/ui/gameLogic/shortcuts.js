// ui/gameLogic/shortcuts.js — in-match keyboard shortcuts. Re-exported from ../gameLogic.js.


// ---- keyboard ---------------------------------------------------------------------------------------------------

/**
 * Map a keydown to a game shortcut (R refresh, F freeze, D level-up, Q retreat, X sell, Space ready, Esc close).
 * Space means ready even while a HUD button has focus (a mouse click leaves the shop card / 刷新 focused, and
 * Space must not re-trigger it); the caller prevents the button's own activation. Enter still activates buttons.
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, repeat?: boolean, target?: any }} e
 * @returns {'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready'|'escape'|null}
 */
export function shortcutFor(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target;
  const tag = t && typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return null;
  if (e.key === 'Escape') return 'escape';
  if (e.repeat) return null;
  const code = e.code || '';
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  if (code === 'KeyR' || key === 'r') return 'refresh';
  if (code === 'KeyF' || key === 'f') return 'freeze';
  if (code === 'KeyD' || key === 'd') return 'levelUp';
  if (code === 'KeyQ' || key === 'q') return 'retreat';
  if (code === 'KeyX' || key === 'x') return 'sell';
  if (code === 'Space' || key === ' ') return 'ready';
  return null;
}

/**
 * Whether a press on the field closes the open detail card: a card opened from the field itself (an own piece — tap,
 * right-click or long press — or a battle / teammate unit). Shop, reward, bond-member and intel (enemy) cards stay.
 * @param {{ kind?: string }|null|undefined} detail
 */
export const closesOnFieldPress = (detail) => detail?.kind === 'piece' || detail?.kind === 'unit';

/**
 * Whether an open overlay swallows a game shortcut: a modal / the guide own the keyboard (Esc included — they close
 * themselves); the 本局信息 / 敌方情报 drawer is a dialog too — only Esc (it closes the drawer) passes, R / F / D / Space
 * never act behind it.
 * @param {'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready'|'escape'|null} act shortcutFor
 * @param {{ modal?: boolean, drawer?: boolean }} open
 */
export function shortcutBlocked(act, { modal = false, drawer = false } = {}) {
  if (!act) return true;
  if (modal) return true;
  return !!drawer && act !== 'escape';
}
