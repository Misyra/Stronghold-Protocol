// 重刷本局 (INFO_CHECK): a server-owned vote of the connected humans that passes at ¾ (m.public rerollVote need,
// server/match/match/setupVote.js). The host of a private room proposes; in a matchmade room (野排) any seated human
// does. Voters may change their answer until it ends; the proposer withdraws, the host cancels. At most
// MAX_SETUP_REROLLS rerolls per match, one proposal per player per setup. Reconnects render the current vote from
// m.public; a failed vote just restores the confirmation countdown and the panel closes.
import { useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Countdown } from './components.js';
import { actions } from './gameActions.js';
import { useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** Successful rerolls per match (server setupVote.js MAX_SETUP_REROLLS; setupRevision counts them). */
export const MAX_SETUP_REROLLS = 3;

export function SetupReroll({ pub }) {
  const myId = useStore((s) => s.me.playerId);
  const hostId = useStore((s) => s.room?.hostId);
  const matchmade = useStore((s) => !!s.room?.fromMatchmaking || !!s.room?.source);
  const online = useStore((s) => s.connection.status === 'online');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const vote = pub.rerollVote;
  const host = myId === hostId;
  const players = pub.players || [];
  const me = players.find((p) => p.playerId === myId && p.status !== 'left' && !p.isBot);
  const used = pub.setupRevision ?? 0;
  const spent = used >= MAX_SETUP_REROLLS;
  const voter = !!vote?.voters.includes(myId);
  const agreed = !!vote?.agreed.includes(myId);
  const rejected = !!vote?.rejected?.includes(myId);
  const proposer = vote?.proposerId === myId;
  const send = async (fn) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try { await fn(); } finally { pending.current = false; setBusy(false); }
  };
  if (!vote && (!me || !(host || matchmade) || spent)) return null;
  const need = vote ? vote.need ?? vote.voters.length : 0;
  const answer = (id) => vote.agreed.includes(id) ? ['is-agreed', t('已同意')] : vote.rejected?.includes(id) ? ['is-rejected', t('已拒绝')] : ['', t('待表态')];
  return html`<section class="brief-reroll" aria-label=${t('重刷本局')} aria-live="polite">
    <div class="brief-reroll__text">
      <strong>${vote ? t('重刷本局投票：{agreed}/{need}', { agreed: vote.agreed.length, need }) : t('重刷本局')}</strong>
      <span>${vote ? t('{need} 人同意即可重新随机战场、领袖、特训敌人和禁用（在线玩家的 3/4）；确认倒计时已暂停。', { need })
        : spent ? t('本局的 {n} 次重刷已用完。', { n: MAX_SETUP_REROLLS })
        : t('保留房间和个人配置，重新随机全部开局信息；需 3/4 在线玩家同意，本局还可重刷 {n} 次。', { n: MAX_SETUP_REROLLS - used })}</span>
      ${vote ? html`<div class="brief-reroll__players">${vote.voters.map((id) => {
        const p = players.find((p) => p.playerId === id);
        const [cls, text] = answer(id);
        return html`<span key=${id} class=${cls}>${p?.name || id} · ${text}</span>`;
      })}</div>` : null}
    </div>
    <div class="brief-reroll__actions">
      ${vote && vote.deadline > 0 ? html`<${Countdown} deadline=${vote.deadline} size="sm" gauge=${false} label=${t('投票剩余')} />` : null}
      ${!vote ? html`<${Button} icon="refresh" size="lg" loading=${busy} disabled=${!online || spent}
        title=${t('3/4 在线玩家同意后刷新，随机结果可能重复。')}
        onClick=${() => send(() => actions.rerollSetup(used))}>${t('重刷本局')}<//>` : null}
      ${vote && voter && !proposer ? html`<${Button} variant="primary" loading=${busy} disabled=${!online || agreed}
        onClick=${() => send(() => actions.rerollVote(vote.id, true))}>${agreed ? t('已同意') : t('同意重刷')}<//>
        <${Button} variant="danger" disabled=${busy || !online || rejected}
          onClick=${() => send(() => actions.rerollVote(vote.id, false))}>${rejected ? t('已拒绝') : t('拒绝重刷')}<//>` : null}
      ${vote && proposer ? html`<${Button} disabled=${busy || !online}
        onClick=${() => send(() => actions.rerollVote(vote.id, false))}>${t('撤回投票')}<//>` : null}
      ${vote && host && me && !proposer ? html`<${Button} disabled=${busy || !online}
        onClick=${() => send(() => actions.cancelReroll(vote.id))}>${t('取消投票')}<//>` : null}
    </div>
  </section>`;
}
