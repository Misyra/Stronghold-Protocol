// The local stats viewer (per-browser match record, viewer + data management. Opened imperatively from the
// title screen / lobby (`openStats()`); <StatsHost/> is mounted once by main.js like <GuideHost/>.
//
// The page aggregates over the records of ui/stats.js (one per finished match the local player took part in):
//   总览    – games, wins, win rate, hidden-core reaches / clears, per-difficulty rows
//   策略    – per band: games used / passed (self alive on a winning team) / pass rate   (the user's ask)
//   称号    – each of config.titles' six 评语 with its count
//   战斗累计– the self player's summed combat bookkeeping
//   最近对局– the newest RECENT_SHOW records as rows; a row click re-views that match as its settlement
//             screen (the record is inverted into an m.result payload for <ResultScreen/>)
// Everything is 本机数据 (localStorage, `sp.pref.stats`): the note under the title says so, and 导出/导入
// (JSON file, merge-by-record-id on the way in) moves it between devices; 清空 resets after a confirm press.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTY_NAMES, PHASE } from '../../../shared/constants.js';
import { html, Icon, MicroLabel, Spinner, Button } from '../ui/components.js';
import { useGameData, BandIcon, Img } from '../ui/gameComponents.js';
import { data, useData } from '../data.js';
import { fmtNum } from '../ui/gameLogic.js';
import { titleIconUrl } from '../ui/assetUrls.js';
import { createStore, useStore, store, emptyMatch } from '../store.js';
import { ResultScreen } from './result.js';
import { toast, toastError } from '../ui/toasts.js';
import {
  loadStats, saveStats, emptyStats, importStats, exportStats, aggregateStats, recordToResult, RECENT_SHOW,
} from '../ui/stats.js';
import { t, N_ } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

const statsStore = createStore({ open: false });

/** Open the stats viewer (title screen / lobby entry points). */
export function openStats() {
  data.load('config');
  data.load('bands');
  data.load('assets');
  statsStore.set({ open: true });
}
export const closeStats = () => {
  // a replayed settlement is synthetic store state — take it away with the viewer
  if (store.get().match.result) store.set({ match: emptyMatch() });
  statsStore.set({ open: false });
};

/**
 * 最近对局行点击: one stored match re-viewed as its settlement screen, INSIDE the stats viewer — the
 * record is inverted into an m.result payload (ui/stats.js recordToResult) into store.match.result, and
 * StatsHost swaps its panel for the real <ResultScreen/> while a result exists (the settlement's
 * 返回大厅 empties match again → back to the list, ready to view the next row). Refused while a match
 * is actually live: the overlay is global and clobbering a running match's state would be destructive.
 * @param {any} rec
 */
export function openRecordResult(rec) {
  const s = store.get();
  if ((s.match.public && s.match.public.phase !== PHASE.LOBBY) || s.room?.inMatch) {
    toast(t('对局进行中，暂不能回看历史结算'), 'warn');
    return;
  }
  const res = recordToResult(rec);
  if (!res) return;
  store.set({ match: { ...emptyMatch(), public: { phase: PHASE.RESULT }, result: res } });
}

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
const dateTime = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const minsOf = (ms) => (ms > 0 ? Math.round(ms / 60000) : null);

/** One labelled number card. */
function StatCard({ label, micro, value, tone }) {
  return html`<div class=${cx('stcard', tone && `stcard--${tone}`)}>
    <${MicroLabel} tone=${tone === 'gold' ? 'gold' : 'mint'}>${micro}<//>
    <b class="stcard__num num">${value}</b>
    <span class="stcard__label">${label}</span>
  </div>`;
}

function Section({ title, micro, children }) {
  return html`<section class="stats-sec">
    <h3 class="stats-sec__h"><span>${title}</span><${MicroLabel}>${micro}<//></h3>
    ${children}
  </section>`;
}

/** 总览: cards + the per-difficulty table. */
function Overview({ agg }) {
  const rows = Object.entries(agg.byDifficulty).sort((a, b) => b[1].games - a[1].games);
  const playedMins = minsOf(agg.duration.totalMs);
  return html`<${Section} title=${t('总览')} micro="OVERVIEW">
    <div class="stats-cards">
      <${StatCard} micro="GAMES" value=${fmtNum(agg.count)} label=${t('总局数')} />
      <${StatCard} micro="WINS" value=${fmtNum(agg.wins)} label=${t('胜场')} tone="mint" />
      <${StatCard} micro="WIN RATE" value=${pct(agg.wins, agg.count)} label=${t('胜率')} tone="gold" />
      <${StatCard} micro="HIDDEN CORE" value=${fmtNum(agg.hidden.reached)} label=${t('到达隐秘核心')} />
      <${StatCard} micro="HIDDEN CLEAR" value=${fmtNum(agg.hidden.cleared)} label=${t('通关隐秘核心')} />
      <${StatCard} micro="BEST ROUND" value=${fmtNum(agg.rounds.max)} label=${t('最远回合')} />
      ${playedMins != null ? html`<${StatCard} micro="TIME PLAYED" value=${t('{n} 分', { n: fmtNum(playedMins) })} label=${t('累计时长')} />` : null}
    </div>
    ${rows.length ? html`<table class="stats-table">
      <thead><tr><th>${t('难度')}</th><th class="num">${t('局数')}</th><th class="num">${t('胜场')}</th><th class="num">${t('胜率')}</th><th class="num">${t('隐秘核心通关')}</th></tr></thead>
      <tbody>
        ${rows.map(([d, v]) => html`<tr key=${d}>
          <td>${DIFFICULTY_NAMES[d] || d}</td>
          <td class="num">${fmtNum(v.games)}</td>
          <td class="num">${fmtNum(v.wins)}</td>
          <td class="num">${pct(v.wins, v.games)}</td>
          <td class="num">${fmtNum(v.hiddenCleared)}</td>
        </tr>`)}
      </tbody>
    </table>` : null}
  <//>`;
}

/** 策略: per-band used / passed / pass rate, most used first (the user's headline ask). */
function Bands({ agg, gd }) {
  const rows = Object.entries(agg.bands).sort((a, b) => b[1].games - a[1].games);
  if (!rows.length) return null;
  return html`<${Section} title=${t('策略')} micro="BANDS">
    <table class="stats-table">
      <thead><tr><th>${t('策略')}</th><th class="num">${t('使用局数')}</th><th class="num">${t('通过局数')}</th><th class="num">${t('通过率')}</th></tr></thead>
      <tbody>
        ${rows.map(([bandId, v]) => {
          const band = gd.band(bandId);
          return html`<tr key=${bandId}>
            <td class="stats-band">${band ? html`<${BandIcon} bandId=${band.bandId} size="xs" />${band.name}` : bandId}</td>
            <td class="num">${fmtNum(v.games)}</td>
            <td class="num">${fmtNum(v.wins)}</td>
            <td class="num">${pct(v.wins, v.games)}</td>
          </tr>`;
        })}
      </tbody>
    </table>
  <//>`;
}

/** 称号: all six 评语 with counts (0 dimmed), official order. */
function Titles({ agg, gd }) {
  const list = (Array.isArray(gd.config?.titles) ? gd.config.titles : [])
    .map((t) => ({ ...t, count: agg.titles[t.id]?.count || 0 }));
  if (!list.length) return null;
  return html`<${Section} title=${t('称号')} micro="TITLES">
    <div class="stats-titles">
      ${list.map((t) => html`<div key=${t.id} class=${cx('stit', !t.count && 'stit--none')} title=${t.text || ''}>
        <${Img} src=${titleIconUrl(gd.m, t.picId)} class="stit__icon" fallback=${html`<${Icon} name="crown" />`} />
        <div class="stit__text"><span>${t.name}</span><b class="num">${fmtNum(t.count)}</b></div>
      </div>`)}
    </div>
  <//>`;
}

const SUM_ROWS = [
  ['kills', N_('击倒敌人')], ['bossDamage', N_('领袖伤害')], ['dmgDealt', N_('造成伤害')], ['activatedLayers', N_('盟约层数')],
  ['merges', N_('晋升次数')], ['itemsEquipped', N_('配发装备')], ['gold', N_('消耗资金')], ['perfectRounds', N_('完美作战')],
  ['refreshes', N_('刷新次数')], ['leaks', N_('未击倒')], ['lpLost', N_('损失生命')],
];

/** 战斗累计: the self player's sums. */
function CombatSums({ agg }) {
  const rows = SUM_ROWS.filter(([k]) => Number.isFinite(agg.sums[k]));
  if (!rows.length) return null;
  return html`<${Section} title=${t('战斗累计')} micro="COMBAT TOTALS">
    <div class="stats-cards stats-cards--sums">
      ${rows.map(([k, label]) => html`<div key=${k} class="ssum"><span>${t(label)}</span><b class="num">${fmtNum(agg.sums[k])}</b></div>`)}
    </div>
  <//>`;
}

/** 最近对局: newest RECENT_SHOW records (records are stored newest first). A row click re-views that
    match as its settlement screen (openRecordResult → match.result → <ResultScreen/>). */
function Recent({ records, gd }) {
  const rows = records.slice(0, RECENT_SHOW);
  if (!rows.length) return null;
  return html`<${Section} title=${t('最近对局')} micro=${`RECENT · ${records.length}`}>
    <table class="stats-table">
      <thead><tr><th>${t('时间')}</th><th>${t('难度')}</th><th>${t('模式')}</th><th>${t('策略')}</th><th>${t('结果')}</th><th class="num">${t('回合')}</th><th aria-hidden="true"></th></tr></thead>
      <tbody>
        ${rows.map((r) => {
          const self = r.players.find((p) => p.playerId === r.selfId) || r.players[0] || null;
          const won = self ? !!self.victory : !!r.victory;
          const band = self?.bandId ? gd.band(self.bandId) : null;
          return html`<tr key=${r.id} class=${cx('is-clickable', won ? 'is-win' : 'is-lose')} title=${t('点击查看该局结算')}
            onClick=${() => openRecordResult(r)}>
            <td class="stats-t">${dateTime(r.t)}</td>
            <td>${DIFFICULTY_NAMES[r.difficulty] || r.difficulty || '—'}</td>
            <td>${r.roomMode === 'solo' ? t('单人') : r.roomMode === 'coop' ? t('同盟') : '—'}</td>
            <td>${band ? band.name : self?.bandId || '—'}</td>
            <td class=${won ? 't-win' : 't-lose'}>${won ? t('胜') : t('负')}</td>
            <td class="num">${fmtNum(r.roundsPassed)}</td>
            <td class="stats-go"><${Icon} name="chevronRight" /></td>
          </tr>`;
        })}
      </tbody>
    </table>
    <p class="stats-hint">${t('点击任意一行，回看该局结算。')}</p>
  <//>`;
}

/** 导出 / 导入 / 清空, with the two-step clear confirm. */
function DataActions({ stats, onReload }) {
  const fileRef = useRef(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const doExport = () => {
    try {
      const payload = exportStats(stats);
      const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      a.href = URL.createObjectURL(blob);
      a.download = `stronghold-stats-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(t('已导出 {n} 条对局记录', { n: payload.records.length }), 'success');
    } catch (err) {
      toastError(err);
    }
  };

  const doFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const { stats: merged, added, skipped } = importStats(raw, stats);
      saveStats(merged);
      onReload();
      toast(added ? t('已导入 {added} 条记录{tail}', { added, tail: skipped ? t('（跳过重复 {skipped} 条）', { skipped }) : '' }) : t('没有新记录（全部与现有数据重复）'), 'success');
    } catch (err) {
      toastError(err.code === 'stats-newer-version' ? err : new Error(t('导入失败：不是有效的统计导出文件')));
    }
  };

  const doClear = () => {
    if (!confirming) { setConfirming(true); return; }
    saveStats(emptyStats());
    setConfirming(false);
    onReload();
    toast(t('已清空本机统计数据'), 'success');
  };

  return html`<div class="stats-actions">
    <${Button} size="sm" icon="exit" onClick=${doExport}>${t('导出')}<//>
    <${Button} size="sm" icon="plus" onClick=${() => fileRef.current?.click()}>${t('导入')}<//>
    <input ref=${fileRef} type="file" accept="application/json,.json" hidden onChange=${doFile} />
    <${Button} size="sm" variant="danger" icon=${confirming ? 'warn' : 'close'} class=${cx(confirming && 'stats-actions__confirm')}
      onClick=${doClear}>${confirming ? t('确认清空？') : t('清空')}<//>
  </div>`;
}

/**
 * Global stats viewer host — mounted once by main.js. Waits only on the files the page reads (config for the
 * title list, bands for names/icons, assets for the picture URLs), not all of useGameData's files.
 */
export function StatsHost() {
  const { open } = useStore((s) => s, Object.is, statsStore);
  const replaying = useStore((s) => !!s.match.result); // a replayed settlement replaces the whole panel
  const ready = useData('config', 'bands', 'assets');
  const gd = useGameData();
  const [stats, setStats] = useState(() => emptyStats());
  const boxRef = useRef(null);
  const reload = () => setStats(loadStats());

  useEffect(() => {
    if (!open) return undefined;
    setStats(loadStats());
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); closeStats(); }
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => boxRef.current?.focus?.(), 30);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(t); };
  }, [open]);

  if (!open) return null;
  if (replaying) {
    // the record re-viewed as its settlement (openRecordResult): the real <ResultScreen/>, full-bleed;
    // its 返回大厅 empties match.result and lands back on the list
    return html`<div class="stats"><div class="stats__replay"><${ResultScreen} /></div></div>`;
  }
  const agg = aggregateStats(stats.records);
  return html`<div class="stats" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) closeStats(); }}>
    <div class="stats__box brackets" role="dialog" aria-modal="true" aria-label=${t('统计数据')} tabindex="-1" ref=${boxRef}>
      <header class="stats__head">
        <div class="stats__titles">
          <${MicroLabel} tone="mint">STATISTICS // LOCAL DATA<//>
          <h2 class="stats__title">${t('统计数据')}</h2>
          <span class="stats__note">${t('本机数据 · 仅记录本浏览器中你参与的对局')}</span>
        </div>
        ${ready ? html`<${DataActions} stats=${stats} onReload=${reload} />` : null}
        <button type="button" class="stats__close" aria-label=${t('关闭')} title=${t('关闭 (Esc)')} onClick=${closeStats}><${Icon} name="close" /></button>
      </header>
      <div class="stats__body">
        ${!ready ? html`<div class="stats__loading"><${Spinner} size="md" /></div>`
          : stats.newer ? html`<p class="stats-empty">${t('检测到更新版本的统计数据，请先升级客户端再查看，以免覆盖数据。')}</p>`
            : !stats.records.length ? html`<p class="stats-empty">${t('还没有记录 —— 完成一局对局后，这里会开始积累。')}</p>`
              : html`<${Overview} agg=${agg} />
                <${Bands} agg=${agg} gd=${gd} />
                <${Titles} agg=${agg} gd=${gd} />
                <${CombatSums} agg=${agg} />
                <${Recent} records=${stats.records} gd=${gd} />`}
      </div>
    </div>
  </div>`;
}
