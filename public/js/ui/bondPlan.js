// 预选盟约 (bond plan, 移植自用户分支): in the match's opening a player names the core faction 盟约 they mean to build
// (g.bondPlan; the server accepts it from 确认本局信息 until round 1's first battle) and every player and spectator sees
// it — the draft order rows (screens/bandDraft.js) and the team panel (ui/teamPanel.js) read m.public
// players[].bondPlan, the briefing (screens/briefing.js) hosts the picker. Information only: it changes nothing in the
// match. A bond the mode switches off stays selectable and reads 本局禁用 on its card. Texts go through t()
// (docs/I18N.md).

import { html, Button, Icon, Modal } from './components.js';
import { BondGlyph } from './gameComponents.js';
import { PHASE } from '../../../shared/constants.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

const cx = (...a) => a.filter(Boolean).join(' ');

/**
 * The plannable bonds: every core faction bond (bonds.json isCore) in data order, in every mode — the server's
 * GameData.plannableBondIds().
 * @param {any[]} bonds gd.list('bonds')
 * @returns {any[]}
 */
export function plannableBonds(bonds) {
  return (Array.isArray(bonds) ? bonds : []).filter((b) => b && b.isCore === true);
}

const OPENING = new Set([PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK]);
const ROUND_ONE = new Set([PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP]);

/**
 * Whether the plan can still change: the opening and round 1 until its battle (the server's window,
 * Match.bondPlanOpen).
 * @param {any} pub m.public
 */
export function bondPlanOpen(pub) {
  if (!pub || typeof pub.phase !== 'string') return false;
  return OPENING.has(pub.phase) || (ROUND_ONE.has(pub.phase) && !(pub.round > 1));
}

/**
 * Other players' plans: bondId → their names (never the viewer).
 * @param {any[]} players m.public players
 * @param {string|null} myId
 */
export function bondPlanHolders(players, myId) {
  const out = new Map();
  for (const p of Array.isArray(players) ? players : []) {
    if (!p || p.playerId === myId || typeof p.bondPlan !== 'string') continue;
    if (!out.has(p.bondPlan)) out.set(p.bondPlan, []);
    out.get(p.bondPlan).push(p.name || t('博士'));
  }
  return out;
}

/** A player's plan: the bond's icon, and its name unless `compact`. */
export function BondPlanTag({ bondId, gd, compact = false, class: cls }) {
  if (typeof bondId !== 'string') return null;
  const name = (gd ? gd.bond?.(bondId) : data.lookup('bonds', bondId))?.name || bondId;
  return html`<span class=${cx('bplan', compact && 'bplan--compact', cls)} title=${t('预选盟约：{name}', { name })}>
    <${BondGlyph} bondId=${bondId} class="bplan__glyph" />${compact ? null : html`<span class="bplan__name">${name}</span>`}
  </span>`;
}

/**
 * The picker: the plannable bonds as cards (本局禁用 on the ones the mode switches off, teammates who planned it under
 * the name), the current one marked; 不预选 clears it.
 * @param {{ open: boolean, onClose: Function, bonds: any[], value: string|null, holders: Map<string, string[]>,
 *   off: Set<string>, busy: boolean, onPick: (bondId: string|null) => void }} props
 */
export function BondPlanPicker({ open, onClose, bonds, value, holders, off, busy, onPick }) {
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('预选盟约')} micro="BOND PLAN" class="bplan-dlg"
    actions=${html`
      <${Button} variant="ghost" icon="close" disabled=${busy || !value} onClick=${() => onPick(null)}>${t('不预选')}<//>
      <${Button} variant="secondary" data-autofocus onClick=${onClose}>${t('关闭')}<//>`}>
    <p class="bplan-dlg__tip t-dim">${t('选择你打算发展的盟约，所有博士都能看到。只作沟通，不影响对局。')}</p>
    <div class="bplan-dlg__grid" role="listbox" aria-label=${t('预选盟约')}>${bonds.map((b) => {
      const who = holders.get(b.bondId) || [];
      const isOff = off.has(b.bondId);
      return html`<button key=${b.bondId} type="button" role="option" aria-selected=${value === b.bondId ? 'true' : 'false'}
          class=${cx('bplan-card', value === b.bondId && 'is-sel', isOff && 'is-off')} disabled=${busy}
          onClick=${() => onPick(b.bondId)}>
        <${BondGlyph} bondId=${b.bondId} class="bplan-card__glyph" />
        <span class="bplan-card__name">${b.name}</span>
        ${isOff ? html`<span class="bplan-card__off">${t('本局禁用')}</span>` : null}
        ${who.length ? html`<span class="bplan-card__who" title=${who.join('、')}><${Icon} name="user" />${who.join('、')}</span>` : null}
        ${value === b.bondId ? html`<span class="bplan-card__mine"><${Icon} name="check" /></span>` : null}
      </button>`;
    })}</div>
  <//>`;
}
