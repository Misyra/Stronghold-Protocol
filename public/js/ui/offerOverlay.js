// Native offer UI: two-tap confirmation and the choice overlay's responsive cards.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, Countdown, Button } from './components.js';
import { GIcon } from './gameComponents.js';
import { spTap } from './choiceOverlay.js';
import { t } from '../../../shared/i18n.js';
import { offerSelectors, offerDefaultVariant, offerQuoteAllowed } from '../../../shared/plugins/offers.js';

export const offerSeat = (offer, myId) => offer?.seats?.find(s => s.playerId === myId) || null;
export const offerPickable = (offer, myId, readOnly, busy) => !readOnly && busy == null && offerSeat(offer, myId)?.picked === false;
export const offerBlocksPrep = offers => !!offers?.some(o => o.quorum !== 'none');
// [ASSUMED] Nonblocking picks auto-collapse; a deliberate reopen can inspect the completed seat. A window the local
// player holds no seat in (spectators, or a plugin window narrowed away by `when.bands` / card conditions) never
// auto-opens — the dock keeps an entry to inspect it.
export function offerVisible(offers, myId, dismissed = [], selected = null) {
  return offers.find(o => o.seq === selected?.seq && offerSeat(o, myId)?.picked === selected.picked)
    || offers.find(o => o.quorum !== 'none')
    || offers.find(o => offerSeat(o, myId) && !dismissed.includes(o.seq) && !offerSeat(o, myId)?.picked)
    || null;
}
const ICONS = { funds: 'sell', layers: 'bolt', item: 'shield', chess: 'rook', refresh: 'refresh' };

/** Quote only the local player's balance; no other seat's private counters are exposed in a window. */
export function offerCard(card, variantId, priv) {
  const resolved = { ...card, ...(card?.variants?.[variantId] || {}) };
  const q = resolved.quote;
  const funds = priv?.funds, debt = priv?.counters?.[q?.debtCounter], cap = priv?.counters?.[q?.creditLimitCounter];
  if (!q || ![funds, ...(q.creditLimitCounter ? [debt ?? 0, cap] : [])].every(Number.isFinite)) return resolved;
  const requested = Math.min(Math.floor(Math.max(0, funds) * q.fraction), q.stakeLimit ?? Infinity);
  const credit = Math.max(0, cap - (debt || 0));
  const stake = q.creditLimitCounter && q.multiplier > 1 ? Math.min(requested, Math.floor(credit / (q.multiplier - 1))) : requested;
  return { ...resolved, available: resolved.available !== false && stake > 0 && offerQuoteAllowed(q, priv?.counters),
    estimate: { stake, requested, amount: Math.round(stake * q.multiplier),
      ...(q.stakeLimit !== undefined ? { stakeLimit: q.stakeLimit } : {}) } };

}

export function offerVariantAllowed(offer, seat, variantId, priv) {
  if (!priv) return true;
  const cards = (seat?.slots || []).filter(card => card.variants);
  return !cards.length || cards.some(card => offerQuoteAllowed(card.variants?.[variantId]?.quote || card.quote, priv.counters));
}
export function offerAllowedVariant(offer, seat, variantId, priv) {
  if (!offer || offerVariantAllowed(offer, seat, variantId, priv)) return variantId;
  const selectors = offerSelectors(offer);
  let ids = [''];
  for (const group of selectors) ids = ids.flatMap(id => group.options.map(o => id ? id + ':' + o.id : o.id));
  return ids.find(id => offerVariantAllowed(offer, seat, id, priv)) ?? variantId;
}

export function OfferOverlay({ pub, priv, myId, readOnly = false, onAction }) {
  const [selected, setSelected] = useState(null);
  const [dismissed, setDismissed] = useState([]);
  const [armed, setArmed] = useState(null);
  const [busy, setBusy] = useState(null);
  const [variant, setVariant] = useState(null);
  const root = useRef(null);
  const offers = pub?.offers || [];
  const offer = offerVisible(offers, myId, dismissed, selected);
  const requestedVariant = offer && variant?.seq === offer.seq ? variant.id : offerSeat(offer, myId)?.variantId ?? offerDefaultVariant(offer);
  const variantId = offerAllowedVariant(offer, offerSeat(offer, myId), requestedVariant, priv);
  const open = o => { setSelected({ seq: o.seq, picked: offerSeat(o, myId)?.picked }); setArmed(null); };
  const dismissible = offer?.quorum === 'none';
  const dismiss = () => {
    if (!dismissible) return;
    setDismissed(ids => [...ids.filter(id => id !== offer.seq && offers.some(o => o.seq === id)), offer.seq]);
    setSelected(null); setArmed(null);
  };
  useEffect(() => { setArmed(null); setBusy(null); }, [offer?.seq]);
  useEffect(() => {
    if (!offer) return;
    const previous = document.activeElement;
    root.current?.focus();
    return () => previous?.focus?.();
  }, [offer?.seq]);
  if (!offer) return html`<${OfferDock} offers=${offers} myId=${myId} onOpen=${open} />`;
  const can = offerPickable(offer, myId, readOnly, busy);
  const act = async (idx, refresh = false) => {
    if (!can || !refresh && offerCard(offerSeat(offer, myId)?.slots[idx], variantId, priv).available === false) return;
    const token = `${offer.seq}:${idx}`;
    setArmed(null); setBusy(token);
    try { await onAction(offer, idx, refresh, offerSeat(offer, myId)?.slots[idx]?.id, variantId); }
    finally { setBusy(b => b === token ? null : b); }
  };
  const tap = idx => {
    if (offerCard(offerSeat(offer, myId)?.slots[idx], variantId, priv).available === false) return;
    const next = spTap(armed, idx, can);
    setArmed(next.armed);
    if (next.pick != null) void act(next.pick);
  };
  const onKeyDown = e => {
    if (e.key === 'Escape') { if (armed == null) dismiss(); setArmed(null); e.stopPropagation(); }
    if (e.key !== 'Tab') return;
    const buttons = [...root.current.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (!first) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { first.focus(); e.preventDefault(); }
  };
  return html`<div ref=${root} tabindex="-1" class="spov offerov" role="dialog" aria-modal="true" aria-label=${t('插件选择')} onKeyDown=${onKeyDown}>
    <div class="spov__veil" aria-hidden="true"></div>
    <div class="spov__inner">
      <nav class="offerov__tabs" aria-label=${t('插件选择')}>
        ${offers.map(o => html`<${Button} key=${o.seq} size="sm" onClick=${() => open(o)} aria-pressed=${o.seq === offer.seq}>${o.title || `${o.pluginId} / ${o.id}`}<//>`)}
        ${dismissible ? html`<${Button} size="sm" onClick=${dismiss}>${t('收起')}<//>` : null}
      </nav>
      <${OfferView} offer=${offer} priv=${priv} myId=${myId} readOnly=${readOnly} busy=${busy} armed=${armed}
        variantId=${variantId} onVariant=${id => { setVariant({ seq: offer.seq, id }); setArmed(null); }}
        onTap=${tap} onRefresh=${idx => act(idx, true)} />
    </div>
  </div>`;
}

export function OfferDock({ offers, myId, onOpen }) {
  return html`<nav class="offerov__dock" aria-label=${t('插件选择')}>
    ${offers.map(o => html`<${Button} key=${o.seq} size="sm" onClick=${() => onOpen(o)}>
      ${o.title || `${t('插件选择')} · ${o.id}`} · ${!offerSeat(o, myId) ? t('观战中') : offerSeat(o, myId)?.picked ? t('等待队友') : t('选择一项')}<//>`)}
  </nav>`;
}

/** Pure view for the native match popup and node rendering tests; all plugin text stays text. */
export function OfferView({ offer, priv, myId, readOnly = false, busy = null, armed = null, variantId = offerDefaultVariant(offer),
  onVariant = () => {}, onTap = () => {}, onRefresh = () => {} }) {
  const mine = offerSeat(offer, myId);
  const seat = mine || offer.seats[0];
  const can = offerPickable(offer, myId, readOnly, busy);
  variantId = offerAllowedVariant(offer, seat, variantId, mine ? priv : null);
  return html`<header class="spov__head">
    <div><h2>${offer.title || `${t('插件选择')} · ${offer.id}`}</h2><p>${t('点击卡牌选中，再次点击确认')}</p>
      <p role="status">${readOnly || !mine ? t('观战中') : mine.picked ? t('等待队友') : t('选择一项')}
        · ${t('还有 {n} 人未选择', { n: offer.waiting })}</p></div>
    <${Countdown} deadline=${offer.deadline} total=${offer.windowSec} size="md" />
  </header>
  ${offerSelectors(offer).map((selector, index) => html`<div class="offerov__selector" role="group" aria-label=${selector.label}>
    <span>${selector.label}</span><div class="offerov__options">
      ${selector.options.map(option => { const ids = (variantId || offerDefaultVariant(offer)).split(':'); ids[index] = option.id;
        return html`<button type="button" key=${option.id} disabled=${!can || !offerVariantAllowed(offer, seat, ids.join(':'), mine ? priv : null)}
        class=${variantId?.split(':')[index] === option.id ? 'is-selected' : ''} aria-pressed=${variantId?.split(':')[index] === option.id}
        onClick=${() => { const ids = (variantId || offerDefaultVariant(offer)).split(':'); ids[index] = option.id; onVariant(ids.join(':')); }}>${option.name}</button>`; })}
    </div></div>`)}
  <div class="spov__grid" style=${`--offer-cols:${Math.max(1, (seat?.slots || []).length)}`}>
    ${(seat?.slots || []).map(source => { const card = offerCard(source, variantId, mine && !mine.picked && !readOnly ? priv : null); return html`<div class="offerov__slot" key=${card.idx}>
      <button type="button" class=${`spcard ${can && card.available !== false ? 'is-pickable' : ''} ${can && card.available !== false && armed === card.idx ? 'is-armed' : ''}`}
        disabled=${!can || card.available === false} aria-pressed=${can && card.available !== false && armed === card.idx} aria-busy=${busy != null} onClick=${() => onTap(card.idx)}
        aria-label=${card.available !== false && armed === card.idx ? t('{name}，已选中，再次点击确认', { name: card.name }) : card.name}>
        <span class="spcard__head"><span class="spcard__icon" aria-hidden="true"><${GIcon} name=${ICONS[card.icon]} /></span>
          <b class="spcard__name">${card.name}</b></span>
        <span class="spcard__desc">${card.desc}</span>
        ${card.estimate ? html`<span class="offerov__quote">
          <b>${t('实际本金 {n}', { n: card.estimate.stake })}</b>
          <span class="offerov__profit">${t('押对净赚 +{n}', { n: card.estimate.amount })}</span>
          <span class="offerov__loss">${t('押错净亏 −{n}', { n: card.estimate.amount })}</span>
          ${card.estimate.stakeLimit !== undefined ? html`<small>${t('本笔本金上限 {n}', { n: card.estimate.stakeLimit })}</small>` : null}
          ${card.estimate.stake < card.estimate.requested ? html`<small>${t('受信用额度限制')}</small>` : null}
        </span>` : null}
        ${card.available === false ? html`<span class="spcard__unavailable">${card.estimate?.stake === 0 ? card.quote?.creditLimitCounter ? t('资金或信用额度不足') : t('资金不足') : t('暂不可用')}</span>` : null}
        ${can && card.available !== false && armed === card.idx ? html`<span class="spcard__confirm"><${Icon} name="check" />${t('确认选择')}</span>` : null}
      </button>
      ${card.remaining > 0 ? html`<${Button} size="sm" icon="refresh" disabled=${!can} onClick=${() => onRefresh(card.idx)}>
        ${t('刷新（剩余 {n} 次）', { n: card.remaining })}<//>
      ` : null}
    </div>`; })}
  </div>`;
}
