// 投票移出 (GitHub feedback #12; server/match/match/kickVote.js): a teammate the AI plays because they stayed offline
// (m.public players[].offlineTakeover) can be voted out by the connected humans in SP_DRAFT / PREP — a strict majority,
// the proposer counting as yes; it then leaves like a 中途退出. KickAction is the row button of the team panel,
// KickVoteNotice the open vote (m.public kickVote) above the rows: 同意 / 反对 for the voters, 撤回 for the proposer.
// UI hints only: the authority rechecks every rule.
import { useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Button, Icon, Countdown, confirmDialog } from './components.js';
import { act } from './gameActions.js';
import { useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** Whether `myId` may propose removing `target` now. */
export function kickable(pub, myId, target) {
  if (!pub || !target || target.playerId === myId || pub.kickVote) return false;
  if (pub.phase !== PHASE.SP_DRAFT && pub.phase !== PHASE.PREP) return false;
  const me = pub.players?.find((p) => p.playerId === myId);
  if (!me || me.isBot || me.status === 'left' || me.connected === false) return false;
  return !!target.offlineTakeover && !target.isBot && target.alive !== false && target.status !== 'left';
}

function useSend() {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const send = async (fn) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try { await fn(); } finally { pending.current = false; setBusy(false); }
  };
  return [busy, send];
}

export function KickAction({ pub, myId, target, compact = false }) {
  const online = useStore((s) => s.connection.status === 'online');
  const [busy, send] = useSend();
  if (!kickable(pub, myId, target)) return null;
  const name = target.name || t('博士');
  const propose = () => send(async () => {
    const ok = await confirmDialog({
      title: t('投票移出 {name}', { name }),
      text: t('{name} 已掉线，由 AI 托管其席位。超过半数在线队友同意后，该玩家按中途退出处理：干员回到卡池，不再参与本局。', { name }),
      okText: t('发起投票'),
    });
    if (ok) await act('g.kickVote', { targetId: target.playerId }, { sfx: 'confirm' });
  });
  return html`<div class=${compact ? 'team-rescue-action team-kick-action team-rescue-action--compact' : 'team-rescue-action team-kick-action'}>
    <${Button} variant="secondary" size="sm" icon="exit" disabled=${!online || busy} loading=${busy} onClick=${propose}
      aria-label=${t('投票移出')} title=${t('该玩家掉线由 AI 托管，可发起投票将其移出')}>${compact ? null : t('投票移出')}<//>
  </div>`;
}

export function KickVoteNotice({ pub }) {
  const myId = useStore((s) => s.me.playerId);
  const online = useStore((s) => s.connection.status === 'online');
  const [busy, send] = useSend();
  const vote = pub?.kickVote;
  if (!vote) return null;
  const players = pub.players || [];
  const nameOf = (id) => players.find((p) => p.playerId === id)?.name || t('博士');
  const voter = vote.voters.includes(myId);
  const agreed = vote.agreed.includes(myId), rejected = vote.rejected.includes(myId);
  const proposer = vote.proposerId === myId;
  const ballot = (agree) => send(() => act('g.kickBallot', { voteId: vote.id, agree }, { sfx: agree ? 'confirm' : 'back' }));
  return html`<div class="team-rescue team-kick" role="status" aria-live="polite">
    <strong><${Icon} name="exit" /> ${t('投票移出 {name}', { name: nameOf(vote.targetId) })}</strong>
    <${Countdown} deadline=${vote.deadline} size="sm" gauge=${false} label=${t('投票剩余')} />
    <small>${t('同意 {agreed}/{need} · 反对 {rejected}', { agreed: vote.agreed.length, need: vote.need, rejected: vote.rejected.length })}
      · ${t('{name} 发起', { name: nameOf(vote.proposerId) })}</small>
    ${voter ? html`<div class="team-kick__actions">
      ${proposer ? html`<${Button} size="sm" disabled=${busy || !online} onClick=${() => ballot(false)}>${t('撤回')}<//>`
        : html`<${Button} variant="primary" size="sm" disabled=${busy || !online || agreed} onClick=${() => ballot(true)}>${agreed ? t('已同意') : t('同意')}<//>
          <${Button} variant="danger" size="sm" disabled=${busy || !online || rejected} onClick=${() => ballot(false)}>${rejected ? t('已反对') : t('反对')}<//>`}
    </div>` : null}
  </div>`;
}

/**
 * The strip of 投票移出 buttons: one per teammate the AI plays because they stayed offline (m.public
 * players[].offlineTakeover). Nothing renders while no seat is under the takeover.
 */
export function KickBar({ pub, myId }) {
  const targets = (pub?.players || []).filter((p) => kickable(pub, myId, p));
  if (!targets.length) return null;
  return html`<div class="kick-bar" role="group" aria-label=${t('投票移出')}>
    ${targets.map((p) => html`<${KickAction} key=${p.playerId} pub=${pub} myId=${myId} target=${p} />`)}
  </div>`;
}
