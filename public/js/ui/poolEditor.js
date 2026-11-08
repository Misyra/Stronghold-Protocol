// The room's 手动指定卡池编组 (feedback #49): one card per card pool, one strip per seat. The plan on room.state is the only
// state (shared/poolPlan.js): every pool has a seat, and a pool left without one is gone. Moving a seat is pick then place,
// which a mouse, a finger and a keyboard all do the same way: press a seat, then press another pool (its 移到此处, the card,
// or a seat in it); pressing the seat again or Esc lets go. A desktop can also drag it there. Every change goes to the
// server at once; a page that may not edit reads the same cards, its own seat marked.

import { useLayoutEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon } from './components.js';
import { evenPoolPlan, mergeLastPool, moveSeat, poolScale, poolSeats, splitPool } from '../../../shared/poolPlan.js';
import { t } from '../../../shared/i18n.js';

/** A pool's size as the room reads it now: its taken seats, or its seats while none is taken. */
export function poolStock(seatIds, seats) {
  const taken = seatIds.filter((seat) => seats[seat]).length;
  return { taken, scale: poolScale(taken || seatIds.length) };
}

function SeatStrip({ index, seat, hostId, myId, picked, editable, onPress, onDrag, onDragEnd }) {
  const mine = !!seat && seat.playerId === myId;
  const press = () => { if (editable) onPress(index); };
  const name = seat ? seat.name || t('博士') : t('空席');
  const cls = `pooled__seat${seat ? '' : ' is-empty'}${mine ? ' is-me' : ''}${picked ? ' is-picked' : ''}${editable ? ' is-editable' : ''}`;
  // a div: Firefox never starts a drag on a <button>, and the older browsers we keep are Firefox
  return html`<div class=${cls} data-testid=${`pool-seat-${index}`} role="button" tabindex=${editable ? 0 : -1} aria-pressed=${picked ? 'true' : 'false'}
      aria-disabled=${editable ? undefined : 'true'} aria-label=${t('P{n} {name}', { n: index + 1, name })} draggable=${editable}
      onClick=${(e) => { e.stopPropagation(); press(); }} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); press(); } }}
      onDragStart=${(e) => { e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.effectAllowed = 'move'; onDrag(index); }} onDragEnd=${onDragEnd}>
    <span class="pooled__no num">P${index + 1}</span>
    <span class="pooled__name">${name}</span>
    ${seat?.isBot ? html`<${Icon} name="robot" class="pooled__mark" />` : null}
    ${seat && seat.playerId === hostId ? html`<${Icon} name="crown" class="pooled__mark" />` : null}
    ${mine ? html`<em class="pooled__me">${t('你')}</em>` : null}
  </div>`;
}

/**
 * @param {{ plan: number[], seats: any[], hostId: any, myId: any, editable: boolean, busy: boolean, onPlan: (plan: number[]) => void }} props
 */
export function PoolEditor({ plan, seats, hostId, myId, editable, busy, onPlan }) {
  const [picked, setPicked] = useState(null);
  const [dragged, setDragged] = useState(null);
  const can = editable && !busy;
  useLayoutEffect(() => {
    if (picked == null) return undefined;
    // before the dialog's own Esc (a capture on window goes first): Esc lets go of the seat, the next one closes
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setPicked(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picked]);
  const groups = poolSeats(plan);
  const pools = groups.length, capacity = plan.length;
  const moving = dragged ?? picked;
  const send = (next) => { setPicked(null); setDragged(null); if (can) onPlan(next); };
  const place = (seat, pool) => { if (seat != null && groups[pool] && !groups[pool].includes(seat)) send(moveSeat(plan, seat, pool)); };
  const press = (seat, pool) => {
    if (picked === seat) setPicked(null);
    else if (picked != null && !groups[pool].includes(picked)) place(picked, pool);
    else setPicked(seat);
  };
  return html`<section class="pooled" data-testid="pool-editor" data-pools=${pools}>
    <div class="pooled__bar">
      <span class="pooled__total">${t('共 {n} 个卡池', { n: pools })}</span>
      ${editable ? html`
        <div class="pooled__step">
          <${Button} size="sm" square=${true} icon="minus" data-testid="pool-fewer" disabled=${!can || pools <= 1} onClick=${() => send(mergeLastPool(plan))} title=${t('减少卡池')} aria-label=${t('减少卡池')} />
          <${Button} size="sm" square=${true} icon="plus" data-testid="pool-more" disabled=${!can || pools >= capacity} onClick=${() => send(splitPool(plan))} title=${t('增加卡池')} aria-label=${t('增加卡池')} />
        </div>
        <${Button} size="sm" data-testid="pool-even" disabled=${!can} onClick=${() => send(evenPoolPlan(capacity, pools))}>${t('均分')}<//>
        <small class="pooled__hint pooled__hint--mouse">${t('点击席位再选择目标卡池，也可直接拖动')}</small>
        <small class="pooled__hint pooled__hint--touch">${t('点击席位再选择目标卡池')}</small>` : null}
    </div>
    <div class="pooled__grid">
      ${groups.map((seatIds, pool) => {
        const { taken, scale } = poolStock(seatIds, seats);
        const target = can && moving != null && !seatIds.includes(moving);
        const mine = seatIds.some((seat) => seats[seat] && seats[seat].playerId === myId);
        return html`<article key=${pool} class=${`pooled__card${target ? ' is-target' : ''}${mine ? ' is-mine' : ''}${seatIds.length > 6 ? ' is-wide' : ''}`}
            data-testid=${`pool-card-${pool}`} aria-label=${t('卡池 {n}，{count} 席', { n: pool + 1, count: seatIds.length })}
            onClick=${() => { if (target && dragged == null) place(picked, pool); }}
            onDragOver=${(e) => { if (target) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop=${(e) => { e.preventDefault(); place(dragged, pool); }}>
          <header class="pooled__head">
            <b>${t('卡池 {n}', { n: pool + 1 })}</b>
            <span>${t('{n} 人', { n: taken })} · ${scale === 1 ? t('完整牌库') : t('牌库 ×{n}', { n: scale })}</span>
            ${target ? html`<button type="button" class="pooled__here" data-testid=${`pool-here-${pool}`} onClick=${(e) => { e.stopPropagation(); place(moving, pool); }}>${t('移到此处')}</button>` : null}
          </header>
          <div class="pooled__seats">
            ${seatIds.map((index) => html`<${SeatStrip} key=${index} index=${index} seat=${seats[index]} hostId=${hostId} myId=${myId} picked=${picked === index}
              editable=${can} onPress=${(seat) => press(seat, pool)} onDrag=${setDragged} onDragEnd=${() => setDragged(null)} />`)}
          </div>
        </article>`;
      })}
    </div>
  </section>`;
}
