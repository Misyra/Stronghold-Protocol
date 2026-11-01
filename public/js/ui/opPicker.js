// 干员选择器 (移植自用户分支 ui/opPicker.js, 2026-10-14 + feedback #9 / #24 / #100; B 适配): one picker serves both
// the room's 名片干员 pick (screens/room.js 更换立绘) and the local account's 头像 pick (ui/accounts.js) — search,
// rarity, the operators' avatars; the first tile clears the pick (默认). The 外观行 (`looks`, feedback #9 / #24): the
// picked operator's art to show — 默认 / 精二 / 精一 / its skins (ui/seatArt.js lookOptions) — in a row above the grid.
// The 头像 picker has a second tab, the official player avatars (feedback #100, ui/seatArt.js officialAvatars); B 的
// 资产清单还没有 playerAvatar 资源, 该页在分组为空时不显示 (优雅降级, 资源到位后自动出现).
// B 适配 (与 fork 的差异): 记录名不经过 tName (B 的 chess 记录名即所用语言的名字), 稀有度档位从列表推导
// (自选编队池的干员没有 6★), 头像页把选择解析成图片 URL 交给调用方 (B 的头像 pref 存的是 URL 字符串), 挑选一个
// 有外观可选的干员后选择器保持打开以便选外观, 选了外观即关闭.
import { useState } from '../../vendor/hooks.module.js';
import { html, Icon, Modal, TextField } from './components.js';
import { cardAvatarUrl, lookOptions, lookUrl, officialAvatars } from './seatArt.js';
import { t } from '../../../shared/i18n.js';

/** A picker tile's picture; the name's first character when the art pack has none or it fails to load. */
function Tile({ src, name, class: cls }) {
  const [bad, setBad] = useState(false);
  return html`<span class=${cls || 'cardpick__img'}>${src && !bad
    ? html`<img src=${src} alt="" loading="lazy" draggable=${false} onError=${() => setBad(true)} />`
    : html`<span class="cardpick__glyph">${[...(name || '?')][0]}</span>`}</span>`;
}

/**
 * The 干员选择器 itself: `list` ui/seatArt.js cardOperators; `current` '' = the first tile (autoLabel) picks ''.
 * `faceOf` a tile's picture (default the record's avatar), `looks` { kind, current, onLook } the 外观行, `tabs` a row
 * above everything, `body` replaces the search and the grid (the 头像 picker's official page).
 * @param {{ title: any, micro: string, current: string, list: any[], m: any, faceOf?: (c: any) => (string | null),
 *   autoLabel: any, autoTitle?: string, autoIcon?: string, note?: any, onPick: (charId: string) => void, onClose: Function,
 *   looks?: null | { kind: 'avatar' | 'portrait', current: string, onLook: (look: string) => void },
 *   tabs?: any, body?: any }} props
 */
export function OperatorPicker({ title, micro, current, list, m, faceOf = (c) => cardAvatarUrl(c.charId, m), autoLabel,
  autoTitle, autoIcon = 'refresh', note = null, onPick, onClose, looks = null, tabs = null, body = null }) {
  const [q, setQ] = useState('');
  const [star, setStar] = useState(0);
  const stars = [...new Set(list.map((c) => c.rarity).filter((r) => r > 0))].sort((a, b) => b - a);
  const known = !!current && list.some((c) => c.charId === current);
  const needle = q.trim().toLowerCase();
  const shown = list.filter((c) => (!star || c.rarity === star)
    && (!needle || [c.name, c.appellation].some((v) => String(v || '').toLowerCase().includes(needle))));
  return html`<${Modal} open=${true} class="cardpick" micro=${micro} title=${title} width="min(10.4rem, 96vw)"
      onClose=${onClose}>
    ${tabs}
    ${body || html`<div class="cardpick__bar">
      <${TextField} class="cardpick__search" size="sm" icon="search" value=${q} onInput=${setQ} placeholder=${t('搜索干员')} />
      <div class="cardpick__stars" role="radiogroup" aria-label=${t('稀有度')}>
        ${[0, ...stars].map((v) => html`<button key=${v} type="button" role="radio" aria-checked=${star === v ? 'true' : 'false'}
          class=${star === v ? 'is-on' : ''} onClick=${() => setStar(v)}>${v ? html`<span class="num">${v}★</span>` : t('全部')}</button>`)}
      </div>
    </div>
    ${looks ? html`<${LookBar} m=${m} charId=${current} looks=${looks} />` : null}
    <div class="cardpick__grid" data-testid="card-picker">
      <button type="button" class=${`cardpick__op cardpick__op--auto${known ? '' : ' is-on'}`} aria-pressed=${known ? 'false' : 'true'}
          data-char="" data-autofocus=${known ? undefined : ''} title=${autoTitle} onClick=${() => onPick('')}>
        <span class="cardpick__img"><${Icon} name=${autoIcon} /></span><span class="cardpick__name">${autoLabel}</span>
      </button>
      ${shown.map((c) => {
        const on = known && c.charId === current;
        return html`<button key=${c.charId} type="button" class=${`cardpick__op r${c.rarity}${on ? ' is-on' : ''}`} aria-pressed=${on ? 'true' : 'false'}
            data-char=${c.charId} data-autofocus=${on ? '' : undefined} title=${c.name} onClick=${() => onPick(c.charId)}>
          <${Tile} src=${faceOf(c)} name=${c.name} />
          <span class="cardpick__name">${c.name}</span>${c.rarity ? html`<span class="cardpick__star num">${c.rarity}★</span>` : null}
        </button>`;
      })}
    </div>
    ${shown.length ? null : html`<p class="cardpick__empty">${t('没有符合条件的干员')}</p>`}`}
    ${note ? html`<p class="cardpick__note"><${Icon} name="info" />${note}</p>` : null}
  <//>`;
}

/** The picked operator's 外观行 (默认 / 精二 / 精一 / skins): nothing when it has only one option. */
function LookBar({ m, charId, looks }) {
  const opts = charId ? lookOptions(m, charId, looks.kind) : [];
  if (opts.length < 2) return null;
  const on = opts.some((o) => o.id === looks.current) ? looks.current : '';
  return html`<div class="cardpick__looks" role="radiogroup" aria-label=${t('外观')}>
    <span class="cardpick__looks-label">${t('外观')}</span>
    ${opts.map((o) => html`<button key=${o.id || 'def'} type="button" role="radio" aria-checked=${on === o.id ? 'true' : 'false'}
      class=${`cardpick__look${on === o.id ? ' is-on' : ''}${looks.kind === 'portrait' ? ' is-tall' : ''}`} title=${t(o.name)} onClick=${() => looks.onLook(o.id)}>
      <${Tile} src=${o.src} name=${t(o.name)} /><span class="cardpick__name">${t(o.name)}</span>
    </button>`)}
  </div>`;
}

/**
 * The 头像 picker: the operators' avatars (the local account's 头像, ui/accounts.js), with the official player avatars
 * as a second tab when the art manifest has them (feedback #100; B 的清单暂无, 页面隐藏). `current` is the stored
 * avatar value (a picture URL, or null for 默认): an operator's tile is on when its avatar is the stored one, a look
 * option when its art is; picking resolves to the picture URL handed to `onPick` (null = 默认).
 * @param {{ current: string | null, list: any[], m: any, onPick: (url: string | null) => void, onClose: Function }} props
 */
export function AvatarPicker({ current, list, m, onPick, onClose }) {
  const groups = officialAvatars(m);
  const url = typeof current === 'string' && current ? current : null;
  // the operator the stored picture came from (its avatar, or one of its looks) — so the picker reopens highlighted
  const from = url ? list.find((c) => c.charId && (cardAvatarUrl(c.charId, m) === url
    || lookOptions(m, c.charId, 'avatar').some((o) => o.src === url))) : null;
  const [charId, setCharId] = useState(from ? from.charId : '');
  const [official, setOfficial] = useState(!!url && groups.some((g) => g.items.some((a) => a.src === url)));
  const lookId = charId ? (lookOptions(m, charId, 'avatar').find((o) => o.src === url)?.id ?? '') : '';
  const pickOperator = (id) => {
    setCharId(id);
    onPick(id ? cardAvatarUrl(id, m) : null);
    // 有外观可选 (精二 / 精一 / 皮肤): 留在外观行挑; 没有则到此为止
    if (!id || lookOptions(m, id, 'avatar').length < 2) onClose();
  };
  const pickLook = (look) => { onPick(lookUrl(m, charId, look, 'avatar') || cardAvatarUrl(charId, m)); onClose(); };
  const tab = (on, label, to) => html`<button type="button" role="tab" aria-selected=${on ? 'true' : 'false'}
    class=${on ? 'is-on' : ''} onClick=${() => setOfficial(to)}>${label}</button>`;
  const tabs = groups.length ? html`<div class="cardpick__tabs" role="tablist">${tab(!official, t('干员'), false)}${tab(official, t('官方头像'), true)}</div>` : null;
  const body = official ? html`<div class="cardpick__grid cardpick__grid--official" data-testid="card-picker">
    ${groups.map((g) => html`<h4 key=${g.key} class="cardpick__group">${t(g.title)}</h4>
      ${g.items.map((a) => html`<button key=${a.id} type="button" class=${`cardpick__op${url === a.src ? ' is-on' : ''}`} data-avatar=${a.id}
        aria-label=${t('官方头像')} onClick=${() => { onPick(a.src); onClose(); }}>
        <${Tile} src=${a.src} name=${a.id} /></button>`)}`)}
  </div>` : null;
  return html`<${OperatorPicker} title=${t('头像')} micro="AVATAR" current=${charId} list=${list} m=${m}
    faceOf=${(c) => cardAvatarUrl(c.charId, m)} looks=${official ? null : { kind: 'avatar', current: lookId, onLook: pickLook }}
    tabs=${tabs} body=${body}
    autoLabel=${t('默认')} autoTitle=${t('不使用头像：显示名字首字')} autoIcon="user"
    note=${t('头像保存在这台设备的浏览器里，不上传服务器；同盟里的博士看不到它。')}
    onPick=${pickOperator} onClose=${onClose} />`;
}
