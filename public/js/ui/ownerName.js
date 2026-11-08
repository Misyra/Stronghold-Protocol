// 服主 mark (移植自用户分支): the server marks a verified owner's seat and spectator seat (room.state seats[].owner /
// spectators[].owner — server: SP_OWNER_FILE and the key in hello.owner, public/js/ownerKey.js) and keeps the owner's
// nicknames for the owner alone. The client never decides it from a name. 服主验证 in 设置 keeps the key on the owner's
// own browser; it shows with #owner in the address, or while a key is kept.
//
// In the match too: a match player is the owner while the room.state the client holds marks that playerId's seat (or
// spectator seat) — the same room.state the match screens already read the 名片 from (screens/settle.js). Display only:
// nothing reaches the match, its DTO or a version host. An AI seat never shows it, whatever a frame says.
import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon } from './components.js';
import { useStore } from '../store.js';
import { ownerKey, setOwnerKey, OWNER_KEY_MAX } from '../ownerKey.js';
import { t } from '../../../shared/i18n.js';

/** Whether a room.state seat / spectator is the verified owner. */
export const isOwnerSeat = (s) => !!s && s.owner === true && !s.isBot;

/**
 * Whether the match player / result row `player` is the owner by the room.state `room` (seats, then spectator seats,
 * by playerId). An AI player never is, nor a player the room no longer seats.
 * @param {any} room room.state payload (store `room`) @param {any} player { playerId, isBot? }
 */
export function isOwnerPlayer(room, player) {
  const id = player && typeof player === 'object' ? player.playerId : player;
  if (typeof id !== 'string' || !id || (player && typeof player === 'object' && player.isBot === true) || !room || typeof room !== 'object') return false;
  for (const list of [room.seats, room.spectators]) {
    if (!Array.isArray(list)) continue;
    const s = list.find((x) => x && x.playerId === id);
    if (s) return isOwnerSeat(s);
  }
  return false;
}

/** isOwnerPlayer against the room.state in the store (re-renders only when the answer changes). */
export const useIsOwner = (player) => useStore((s) => isOwnerPlayer(s.room, player));

/**
 * The 服主 tag after a name: a thin crown and 服主 (English "Owner", the i18n key 服主). `compact`: the crown alone — only
 * where no name is shown at all (it then carries 服主 as its title and label). `owner` decides it when given (a match
 * player: useIsOwner), else the room.state `seat`.
 */
export function OwnerBadge({ seat = null, owner, compact = false, class: cls = '' }) {
  if (!(owner === undefined ? isOwnerSeat(seat) : owner === true)) return null;
  const label = t('服主');
  return html`<span class=${`sp-owner-badge${compact ? ' sp-owner-badge--compact' : ''} ${cls}`} title=${label} aria-label=${compact ? label : undefined}
    role=${compact ? 'img' : undefined} data-owner-badge="1"><${Icon} name="crown" />${compact ? null : html`<span class="sp-owner-badge__text">${label}</span>`}</span>`;
}

/** The tag of a match player (a playerId or { playerId, isBot }) when the room.state marks it, else nothing. */
export function OwnerMark({ player, compact = false, class: cls = '' }) {
  const owner = useIsOwner(player);
  return owner ? html`<${OwnerBadge} owner=${true} compact=${compact} class=${cls} />` : null;
}

/** 设置 → 服主验证 (only for the owner's browser: #owner in the address, or a key already kept). */
export function OwnerKeySection() {
  const verified = useStore((s) => s.me?.owner === true);
  const [kept, setKept] = useState(() => !!ownerKey());
  const [value, setValue] = useState('');
  const [shown] = useState(() => kept || globalThis.location?.hash === '#owner');
  if (!shown) return null;
  const save = () => { setOwnerKey(value); setKept(!!ownerKey()); setValue(''); };
  const clear = () => { setOwnerKey(null); setKept(false); };
  return html`<section class="set-owner">
    <h4>${t('服主验证')}</h4>
    <p class="set-hint">${verified ? t('已验证为服主：你的席位会显示服主标记') : kept ? t('服主密钥已保存在本机，刷新页面后由服务器验证') : t('输入服主密钥后保存在本机，之后每次连接由服务器验证')}</p>
    <div class="set-owner__row">
      <input type="password" autocomplete="off" spellcheck="false" maxlength=${OWNER_KEY_MAX} value=${value} placeholder=${kept ? t('已保存（输入新密钥可替换）') : t('服主密钥')}
        onInput=${(e) => setValue(e.currentTarget.value)} />
      <${Button} size="sm" variant="secondary" disabled=${!value.trim()} onClick=${save}>${t('保存')}<//>
      ${kept ? html`<${Button} size="sm" variant="ghost" onClick=${clear}>${t('清除')}<//>` : null}
    </div>
  </section>`;
}
