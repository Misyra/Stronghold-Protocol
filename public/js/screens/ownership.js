// 干员持有 (operator ownership, 0.2.0 补位 — the approved plan, owner's decision 2026-10-05): the second tab of the
// 干员调配 overlay (screens/loadout.js). The 53 NORMAL chess of this season's shop, grouped by tier — each card shows the
// operator and its official stand-in (avatar, name, the skill it fields) and switches between 持有 and 未持有 with a
// tap. A chess marked 未持有 keeps its shop / hand card (name, bonds, price, with a 「替补：X」 badge) and is deployed
// as the stand-in (model, skills, talents, range). PRESET chess always field their own operator and are not listed.
// Default: everything owned; 全部持有 resets. Out of match: the next match takes the list (in co-op it only affects the
// player's own pieces). The list lives in ui/loadoutSync.js (localStorage + room.ownership); the model is
// ui/ownershipModel.js. Styles: css/screens/loadout.css (own-*).

import { useMemo, useState } from '../../vendor/hooks.module.js';
import { html, TierChip, Icon } from '../ui/components.js';
import { Img } from '../ui/gameComponents.js';
import { chessAvatarUrl } from '../ui/assetUrls.js';
import { data } from '../data.js';
import { PROF_NAME } from '../ui/loadoutModel.js';
import { ownershipRoster, rosterByTier, isOwned, standInSummary } from '../ui/ownershipModel.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

/** The roster of the tab (data.list('chess'), memoised on the data being ready). */
export function useOwnershipRoster(ready) {
  return useMemo(() => ownershipRoster(data.list('chess')), [ready]);
}

/** One chess: the operator → its stand-in, and the 持有 switch (the whole card is the switch). */
export function OwnCard({ m, chess, backups, owned, onToggle }) {
  const si = standInSummary(chess, backups);
  const skill = si?.skill;
  const slot = skill && Number.isInteger(skill.index) ? `S${skill.index + 1}` : '';
  const label = `${chess.name}：${owned ? '持有' : `未持有，由 ${si?.name || '替补干员'} 上场`}`;
  return html`<button type="button" role="switch" aria-checked=${owned ? 'true' : 'false'} aria-label=${label} data-chess=${chess.chessId}
      class=${cx('own-card', `own-card--t${chess.tier}`, !owned && 'is-off')} onClick=${() => onToggle(chess.chessId, !owned)}
      title=${owned ? `点击标记为未持有：由 ${si?.name || '替补干员'} 上场` : '点击恢复为持有'}>
    <span class="own-card__op">
      <span class="own-card__ava"><${Img} src=${chessAvatarUrl(m, chess)} fallback=${html`<b>${[...(chess.name || '?')][0]}</b>`} /></span>
      <span class="own-card__txt">
        <b class="own-card__name">${chess.name}</b>
        <small>${PROF_NAME[chess.profession] || ''}${chess.subProfessionName ? ` · ${chess.subProfessionName}` : ''}</small>
      </span>
    </span>
    <span class="own-card__arrow" aria-hidden="true"><${Icon} name="chevronRight" /></span>
    <span class="own-card__sub" data-standin=${si?.charId || ''}>
      <span class="own-card__ava own-card__ava--sub">${si ? html`<${Img} src=${chessAvatarUrl(m, si.record)} fallback=${html`<b>${[...(si.name || '?')][0]}</b>`} />` : null}</span>
      <span class="own-card__txt">
        <b class="own-card__name">${si ? si.name : '—'}</b>
        <small>${si ? `${PROF_NAME[si.profession] || ''}${slot ? ` · ${slot} ${skill.name || ''}` : ''}` : '无替补数据'}</small>
      </span>
    </span>
    <span class="own-card__state"><i class="own-switch" aria-hidden="true"><i></i></i>${owned ? '持有' : '未持有'}</span>
  </button>`;
}

/**
 * The tab's body.
 * @param {{ m: any, roster: any[], notOwned: string[], onToggle: (chessId: string, owned: boolean) => void }} props
 */
export function OwnershipPanel({ m, roster, notOwned, onToggle }) {
  const [offOnly, setOffOnly] = useState(false);
  const backups = data.get('backups');
  const list = offOnly ? roster.filter((c) => !isOwned(notOwned, c.chessId)) : roster;
  const groups = rosterByTier(list);
  return html`<main class="own" data-testid="ownership">
    <div class="own__bar">
      <p class="own__lead">未持有的干员由官方指定的<b>替补干员</b>上场：棋子的名字、盟约、特质、阶级与价格不变，上场的是替补干员（模型、技能、天赋、攻击范围）。预设干员无论是否持有都由本人上场，不在此列。</p>
      <button type="button" class=${cx('lo-toggle', offOnly && 'is-on')} aria-pressed=${offOnly ? 'true' : 'false'} onClick=${() => setOffOnly(!offOnly)}>
        <i class="lo-toggle__box"><${Icon} name="check" /></i>仅看未持有</button>
    </div>
    <div class="own__list">
      ${groups.length ? groups.map((g) => html`<section key=${g.tier} class="own-tier" data-tier=${g.tier} aria-label=${`${g.tier}阶`}>
        <h3 class="own-tier__head"><${TierChip} tier=${g.tier} size="sm" /><span class="num">${ROMAN[g.tier]}</span><span>阶</span><span class="num t-dim">${g.list.length}</span></h3>
        <div class="own-grid">
          ${g.list.map((c) => html`<${OwnCard} key=${c.chessId} m=${m} chess=${c} backups=${backups} owned=${isOwned(notOwned, c.chessId)} onToggle=${onToggle} />`)}
        </div>
      </section>`) : html`<p class="lo-empty t-dim">${offOnly ? '全部持有：没有由替补干员上场的棋子' : '没有可下掉的干员'}</p>`}
    </div>
  </main>`;
}
