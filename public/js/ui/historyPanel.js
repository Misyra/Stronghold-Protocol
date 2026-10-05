import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, MicroLabel, DifficultyTag, Spinner, confirmDialog } from './components.js';
import { useStore } from '../store.js';
import { historyStore, openHistory, closeHistory, refreshHistory, removeHistory, clearHistory } from '../history/index.js';
import { HISTORY_LIMIT, exportRecords } from '../history/record.js';
import { useGameData } from './gameComponents.js';
import { normalizeResult } from './gameLogic.js';
import { PlayerCard } from './resultPlayerCard.js';

export function HistoryButton({ class: cls, variant = 'ghost', size = 'sm' }) {
  return html`<${Button} class=${['history-btn', cls].filter(Boolean).join(' ')} variant=${variant} size=${size}
    icon="book" onClick=${openHistory}>对局记录<//>`;
}
export function HistorySaveStatus() {
  const state = useStore((s) => s.saveState, Object.is, historyStore);
  return html`<p class=${`history-save ${state === 'error' ? 'is-error' : ''}`} role="status">
    ${state === 'saved' ? '本局已保存到此浏览器' : state === 'saving' ? '正在保存本地记录…' :
      state === 'error' ? '本局未能保存，请在对局记录中查看原因' : ''}</p>`;
}
const dateText = (n) => new Date(n).toLocaleString('zh-CN', { hour12: false });
const durationText = (ms) => `${Math.floor(Math.max(0, ms || 0) / 60000)} 分 ${Math.floor(Math.max(0, ms || 0) / 1000) % 60} 秒`;
function download(records) {
  const url = URL.createObjectURL(new Blob([exportRecords(records)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `stronghold-records-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function HistoryDetail({ record }) {
  const gd = useGameData();
  const r = normalizeResult(record.result);
  const self = record.result.players.find((p) => p.playerId === record.playerId);
  const win = typeof self?.victory === 'boolean' ? self.victory : r.victory;
  return html`<div class="history-detail">
    <div class="history-detail__summary">
      <strong class=${win ? 'history-win' : 'history-loss'}>${win ? '成功卫戍' : '模拟失败'}</strong>
      <${DifficultyTag} difficulty=${r.difficulty} />
      <span>${dateText(record.endedAt)}</span><span>通过 ${self?.roundsPassed ?? r.roundsPassed} 回合</span>
      <span>${durationText(r.durationMs)}</span>
    </div>
    <p class="history-meta">${r.modeId?.includes('single') ? '独立模拟' : '同盟模拟'} · 版本 ${record.appVersion || '未知'} · 种子 ${record.result.seed ?? '未知'}</p>
    ${r.players.map((p) => html`<${PlayerCard} key=${p.playerId} p=${p} myId=${record.playerId}
      titles=${Array.isArray(gd.config?.titles) ? gd.config.titles : []} best=${{}} solo=${r.players.length < 2} />`)}
  </div>`;
}
function HistoryContent() {
  const { records, loading, error, saveError } = useStore((s) => s, Object.is, historyStore);
  const [selected, select] = useState(null);
  const [operationError, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const record = records.find((r) => r.id === selected);
  useEffect(() => { if (selected && !record && !loading) select(null); }, [selected, record, loading]);
  async function erase(all) {
    if (busy || (!all && !record)) return;
    const id = record?.id;
    const confirmed = await confirmDialog({ title: all ? '清空对局记录？' : '删除这局记录？',
      text: '删除后无法恢复，可以先导出数据备份。', okText: all ? '清空' : '删除', danger: true });
    if (!confirmed) return;
    setBusy(true); setError('');
    try { if (all) await clearHistory(); else await removeHistory(id); select(null); }
    catch (err) { setError(err.message || '删除失败，请重试'); }
    finally { setBusy(false); }
  }
  return html`<${Modal} open=${true} title="对局记录" micro="LOCAL MATCH HISTORY" onClose=${closeHistory}
    width="14rem" class="history-panel" actions=${html`
      ${record ? html`<${Button} icon="chevronLeft" onClick=${() => select(null)} disabled=${busy}>返回列表<//>` : null}
      <${Button} variant="secondary" disabled=${loading || busy || !records.length} onClick=${() => download(record ? [record] : records)}>${record ? '导出本局' : '导出全部'}<//>
      <${Button} disabled=${loading || busy || !records.length} onClick=${() => erase(!record)}>${record ? '删除本局' : '清空记录'}<//>
      <${Button} variant="primary" onClick=${closeHistory}>关闭<//>`}>
    <p class="history-notice">结算时自动保存最近 ${HISTORY_LIMIT} 局，仅保存在当前浏览器和当前站点。清除网站数据会删除记录。</p>
    ${error || operationError || saveError ? html`<p class="history-error" role="alert">${operationError || error || saveError}
      <${Button} size="sm" icon="refresh" onClick=${refreshHistory}>重试读取<//></p>` : null}
    ${loading ? html`<div class="history-empty"><${Spinner} />读取记录…</div>` : record ? html`<${HistoryDetail} record=${record} />` :
      records.length ? html`<div class="history-list">${records.map((rec) => {
        const p = rec.result.players.find((p) => p.playerId === rec.playerId);
        const win = typeof p?.victory === 'boolean' ? p.victory : rec.result.victory;
        return html`<button class="history-entry" key=${rec.id} onClick=${() => select(rec.id)}>
          <strong class=${win ? 'history-win' : 'history-loss'}>${win ? '成功卫戍' : '模拟失败'}</strong>
          <${DifficultyTag} difficulty=${rec.result.difficulty} />
          <span>${dateText(rec.endedAt)}</span><span>${p?.name || '博士'}</span>
          <span>通过 ${p?.roundsPassed ?? rec.result.roundsPassed ?? 0} 回合</span>
          <span>${durationText(rec.result.durationMs)}</span><span class="history-entry__view">查看详情 ›</span>
        </button>`;
      })}</div>` : html`<p class="history-empty">暂无对局记录，完成一局模拟后会自动保存。</p>`}
    <${MicroLabel}>${records.length} / ${HISTORY_LIMIT} RECORDS<//>
  <//>`;
}
export function HistoryHost() {
  const open = useStore((s) => s.open, Object.is, historyStore);
  return open ? html`<${HistoryContent} />` : null;
}
