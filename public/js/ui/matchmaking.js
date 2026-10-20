// Compat shim (stronghold-ui-hub package) — install ONLY when the target has no public/js/ui/matchmaking.js.
// The original shows how many doctors are queueing (a presence count the server pushes). Without those counts the
// count is unknown, and an unknown count is not shown at all.
import { html, Button, useTicker, secondsLeft } from './components.js';
import { t } from '../../../shared/i18n.js';

/** "N 人匹配中" when `count` is known, else nothing. @param {{ count?: number }} props */
export function MatchmakingCount({ count }) {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  return html`<span class="matchmaking-count"><span class="num">${count}</span>${t('人匹配中')}</span>`;
}

/** The offer stays visible after accepting, until the server commits or withdraws it. */
export function matchmakingTitle(mm) {
  return mm?.allocationPending ? t('正在准备对局') : mm?.offerId ? t('等待全员确认') : t('搜寻中');
}

export function MatchmakingOffer({ mm, online, busy, onAccept }) {
  useTicker(1000);
  const remaining = secondsLeft(mm?.deadline);
  const pending = !!mm?.allocationPending;
  const accepted = !!mm?.accepted;
  return html`<p class="matchmaking-offer__progress">${pending ? t('全员已确认，正在准备对局…')
    : t('已确认 {accepted}/{target} · 剩余 {seconds} 秒', { accepted: mm?.acceptedCount ?? 0, target: mm?.target || mm?.required || 4, seconds: remaining ?? 0 })}</p>
    <${Button} variant="primary" block=${true} icon="check" disabled=${!online || !!busy || accepted || pending || remaining === 0}
      loading=${!!busy || pending} onClick=${onAccept}>${pending ? t('正在准备对局') : accepted ? t('已确认，等待队友') : t('确认入场')}<//>`;
}
