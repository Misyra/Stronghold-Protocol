// Result screen (research 06 §10.6): victory / defeat hero with rounds passed, boss medallions, and a
// card per player — band, final lineup avatars with elite marks, stats, title (评语) with its icon —
// plus 返回同盟.
//
// Expected m.result (free-form in DESIGN §8.2; fields read tolerantly, see gameLogic.normalizeResult):
//   { victory, roundsPassed, lastRound?, hiddenCleared?, bossId?, hiddenBossId?, difficulty?, modeId?, durationMs?,
//     players: [{ playerId, seat, name, isBot, alive, lp, bandId, roundsPassed?,
//                 title: 'comment_1' | { id, name? } | null,
//                 lineup: [{ id /* chessId, golden id if elite */, golden?, tier?, items?: [itemId] }],
//                 bonds?: [{ bondId, layers, active }],
//                 stats: { dmgDealt, kills, leaks, gold /* funds SPENT */, refreshes, merges, bossDamage?, itemsEquipped?,
//                          activatedLayers?, lpLost?, perfectRounds? } }] }

import { useEffect } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, DifficultyTag } from '../ui/components.js';
import { useGameData, Img, Sprite } from '../ui/gameComponents.js';
import { normalizeResult } from '../ui/gameLogic.js';
import { enemyIconUrl, uiUrl } from '../ui/assetUrls.js';
import { store, useStore, emptyMatch } from '../store.js';
import { audio } from '../audio.js';
import { STAT_ROWS, PlayerCard } from '../ui/resultPlayerCard.js';
import { HistoryButton, HistorySaveStatus } from '../ui/historyPanel.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** RESULT screen. */
export function ResultScreen() {
  const res = useStore((s) => s.match.result);
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const hasRoom = useStore((s) => !!s.room);
  const gd = useGameData();
  const r = normalizeResult(res, pub);
  const titles = Array.isArray(gd.config?.titles) ? gd.config.titles : [];
  const best = {};
  for (const [k] of STAT_ROWS) {
    let top = null;
    for (const p of r.players) if (Number.isFinite(p.stats[k]) && p.stats[k] > 0 && (top == null || p.stats[k] > top.v)) top = { v: p.stats[k], id: p.playerId };
    if (top && r.players.length > 1) best[k] = top.id;
  }
  useEffect(() => { audio.sfx(r.victory ? 'settlementSucceed' : 'settlementFail'); }, []);
  const back = () => store.set({ match: emptyMatch() });
  const boss = r.bossId ? gd.boss(r.bossId) : null;
  // the Hidden Core medal (and its corrupted leader) only once R15 was actually fought
  const hidden = r.hiddenBossId && r.hiddenReached ? gd.boss(r.hiddenBossId) : null;
  const bg = uiUrl(gd.m, r.victory ? 'settle/settlemen_teamshow_success' : 'settle/settlemen_teamshow_fail');
  const mins = r.durationMs ? Math.round(r.durationMs / 60000) : null;

  return html`<div class=${cx('screen', 'result', r.victory ? 'is-win' : 'is-lose')}>
    <div class="result__bg" aria-hidden="true" style=${bg ? `--result-bg:url("${bg}")` : undefined}></div>
    <div class="result__grid" aria-hidden="true"></div>
    <main class="result__main">
      <section class="result__hero">
        <div class="result__logo"><${Sprite} k="entry/season_logo_settle" class="result__logoimg" fallback=${html`<${MicroLabel} tone="mint">STRONGHOLD PROTOCOL</${MicroLabel}>`} /></div>
        ${r.difficulty ? html`<${DifficultyTag} difficulty=${r.difficulty} size="lg" />` : null}
        <h1 class="result__headline">${r.victory ? '模拟完成' : '模拟失败'}</h1>
        <p class="result__sub">${r.victory ? '成功卫戍 · 敌方领袖已被击败' : '防线已被突破'}</p>
        <div class="result__rounds">
          <span class="result__rlabel">通过回合</span>
          <b class="result__rnum num">${r.roundsPassed}</b>
          ${r.roundsPassed <= r.lastRound ? html`<span class="result__rof num">/${r.lastRound}</span>` : null}
        </div>
        <div class="result__medals">
          ${boss ? html`<div class=${cx('medal', r.victory && 'is-done')} title=${boss.name}>
            <${Img} src=${enemyIconUrl(gd.m, boss.enemyKey)} /><span class="medal__check">${r.victory ? html`<${Icon} name="check" />` : html`<${Icon} name="close" />`}</span>
            <span class="medal__label">敌方领袖</span></div>` : null}
          ${hidden ? html`<div class=${cx('medal', 'medal--hidden', r.hiddenCleared && 'is-done')} title=${hidden.name}>
            <${Img} src=${enemyIconUrl(gd.m, hidden.enemyKey)} /><span class="medal__check">${r.hiddenCleared ? html`<${Icon} name="check" />` : html`<${Icon} name="close" />`}</span>
            <span class="medal__label">隐秘核心</span></div>` : null}
        </div>
        ${mins ? html`<p class="result__time t-lo">本局耗时 <b class="num">${mins}</b> 分钟</p>` : null}
        <${HistorySaveStatus} />
        <footer class="result__foot">
          <${Button} variant="primary" size="xl" icon="chevronLeft" onClick=${back}>${hasRoom ? '返回同盟' : '返回大厅'}<//>
          <${HistoryButton} variant="secondary" size="xl" />
        </footer>
      </section>
      <section class="result__players">
        <h2 class="brief-h"><span>同盟成员</span><${MicroLabel}>ALLIANCE REPORT</${MicroLabel}></h2>
        ${r.players.length ? r.players.map((p) => html`<${PlayerCard} key=${p.playerId} p=${p} myId=${myId} titles=${titles} best=${best} solo=${r.players.length < 2} />`)
          : html`<p class="t-dim">暂无结算数据</p>`}
      </section>
    </main>
  </div>`;
}

