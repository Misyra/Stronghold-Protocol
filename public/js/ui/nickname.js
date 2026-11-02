// 博士代号改名 (ported from the Stardust fork's ui/nickname.js): the account panel's 「更改代号」 opens the dialog.
// Saving validates the name with ui/playerName.js (the server's own sanitizeName rules, so a name the client accepts is
// never refused), stores it and hands it to net.js — `hello` carries it now, or as soon as the socket is open. On a live
// socket the server renames the session (server/net.js sets session.name) and a waiting room broadcasts the new seat
// name (server/lobby.js); a match in progress keeps its seats as they are.
//
// The fork also has a 「a refused name blocks play」 path (its server answers NAME_REJECTED); this server only sanitises,
// so a dialog opened by that path would never appear here — the ✎ is the only way in.

import { useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN } from '../../../shared/constants.js';
import { html, Button, Modal, TextField } from './components.js';
import { toast } from './toasts.js';
import { net, identity } from '../net.js';
import { store, useStore } from '../store.js';
import { sanitizeName, isValidName } from './playerName.js';
import { t } from '../../../shared/i18n.js';

/**
 * Use a nickname: remember it and send it (a first hello, or a rename on the live socket).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function setNickname(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
  store.set((s) => ({ me: { ...s.me, name } }));
  net.setName(name);
  return true;
}

/** Open the rename dialog (the account panel's 更改代号). */
export const openNameDialog = () => store.patch('ui', { nameDialog: true });

/** The rename dialog; mounted once (main.js App) and rendered while `ui.nameDialog` is on. */
export function NameHost() {
  const open = useStore((s) => !!s.ui?.nameDialog);
  return open ? html`<${NameDialog} />` : null;
}

function NameDialog() {
  const current = useStore((s) => s.me.name || '');
  const [value, setValue] = useState(() => current || identity.loadName() || '');
  const inputRef = useRef(null);
  // the current name selected (the Modal focused the field before this runs): typing replaces it
  useLayoutEffect(() => { inputRef.current?.select(); }, []);
  const close = () => store.patch('ui', { nameDialog: false });
  const valid = isValidName(value);
  const save = (e) => {
    // Enter: the closing dialog hands the focus back, which the same key would press again
    e?.preventDefault?.();
    if (!setNickname(value)) { toast(t('请输入博士代号'), 'warn'); return; }
    close();
  };
  return html`<${Modal} open=${true} micro="CALLSIGN" title=${t('博士代号')} onClose=${close} class="name-dialog"
    actions=${html`<${Button} variant="ghost" onClick=${close}>${t('取消')}<//>
      <${Button} variant="primary" disabled=${!valid} onClick=${save}>${t('确认')}<//>`}>
    <${TextField} size="lg" icon="user" value=${value} maxLength=${NAME_MAX_LEN}
      placeholder=${t('输入你的代号（最多 {NAME_MAX_LEN} 字）', { NAME_MAX_LEN })}
      inputRef=${inputRef} onInput=${setValue} onEnter=${save} />
  <//>`;
}
