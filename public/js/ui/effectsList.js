// Active effects list (m.private.effects: band / 机变 / team / item / garrison effects with counters):
// compact icon column at the right edge, rich-text tooltip per effect. `counterText` (a 悬赏's "还剩 N 场作战", user
// playtest #6 item 4) replaces the bare counter in the tooltip's kind line.

import { html, Tooltip, MicroLabel } from './components.js';
import { Img, RichText, GIcon } from './gameComponents.js';
import { effectIconUrl } from './assetUrls.js';
import { data } from '../data.js';
import { t, N_ } from '../../../shared/i18n.js';

const KIND = { band: N_('策略'), choice: N_('机变'), team: N_('团队增益'), item: N_('道具'), garrison: N_('特质') };

/**
 * A 悬赏's counter line in the current language: the battles its enemies still come for (server/match/player/views.js
 * sends the same Chinese text as `counterText` beside the count; a multi-round card has no count).
 * @param {{ counter?: number|null }} e
 */
export const bountyCounterText = (e) => (e.counter == null ? t('之后的每场作战') : t('还剩 {left} 场作战', { left: e.counter }));

/** @param {{ effects: any[] }} props */
export function EffectsList({ effects }) {
  const list = (Array.isArray(effects) ? effects : []).filter((e) => e && (e.name || e.desc));
  if (!list.length) return null;
  const m = data.get('assets');
  return html`<div class="effects" aria-label=${t('生效中的效果')}>
    <${MicroLabel}>EFFECTS</${MicroLabel}>
    ${list.slice(0, 10).map((e, i) => html`<${Tooltip} key=${e.id ?? i} placement="bottom" text=${html`<div class="efftip">
        <b>${e.name || t('效果')}</b><span class="efftip__kind">${t(KIND[e.iconKind] || '')}${e.counterText ? ` · ${bountyCounterText(e)}` : e.counter != null ? ` · ${e.counter}` : ''}</span>
        <${RichText} as="p" text=${e.desc || ''} />
      </div>`}>
      <span class=${`effect effect--${e.iconKind || 'x'}`}>
        <${Img} src=${effectIconUrl(m, e)} fallback=${html`<${GIcon} name="bolt" />`} />
        ${e.counter != null && e.counter !== '' ? html`<b class="effect__n num">${e.counter}</b>` : null}
      </span>
    <//>`)}
  </div>`;
}
