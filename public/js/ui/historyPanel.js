import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, MicroLabel, DifficultyTag, Spinner, confirmDialog } from './components.js';
import { useStore } from '../store.js';
import { historyStore, openHistory, closeHistory, refreshHistory, removeHistory, clearHistory, importHistory } from '../history/index.js';
import { HISTORY_LIMIT, HISTORY_IMPORT_BYTES, exportRecords } from '../history/record.js';
import { useGameData } from './gameComponents.js';
import { normalizeResult } from './gameLogic.js';
import { PlayerCard } from './resultPlayerCard.js';
import { t } from '../../../shared/i18n.js';

export function HistoryButton({ class: cls, variant = 'ghost', size = 'sm' }) {
  return html`<${Button} class=${['history-btn', cls].filter(Boolean).join(' ')} variant=${variant} size=${size}
    icon="book" onClick=${openHistory}>${t('对局记录')}<//>`;
}
export function HistorySaveStatus() {
  const state = useStore((s) => s.saveState, Object.is, historyStore);
  return html`<p class=${`history-save ${state === 'error' ? 'is-error' : ''}`} role="status">
    ${state === 'saved' ? t('本局已保存到此浏览器') : state === 'saving' ? t('正在保存本地记录…') :
      state === 'error' ? t('本局未能保存，请在对局记录中查看原因') : ''}</p>`;
}
const dateText = (n) => new Date(n).toLocaleString('zh-CN', { hour12: false });
const durationText = (ms) => t('{0} 分 {1} 秒', { 0: Math.floor(Math.max(0, ms || 0) / 60000), 1: Math.floor(Math.max(0, ms || 0) / 1000) % 60 });
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
      <strong class=${win ? 'history-win' : 'history-loss'}>${win ? t('成功卫戍') : t('模拟失败')}</strong>
      <${DifficultyTag} difficulty=${r.difficulty} />
      <span>${dateText(record.endedAt)}</span><span>${t('通过')} ${self?.roundsPassed ?? r.roundsPassed} ${t('回合')}</span>
      <span>${durationText(r.durationMs)}</span>
    </div>
    <p class="history-meta">${r.modeId?.includes('single') ? t('独立模拟') : t('同盟模拟')} ${t('· 版本')} ${record.appVersion || t('未知')} ${t('· 种子')} ${record.result.seed ?? t('未知')}</p>
    ${r.players.map((p) => html`<${PlayerCard} key=${p.playerId} p=${p} myId=${record.playerId}
      titles=${Array.isArray(gd.config?.titles) ? gd.config.titles : []} best=${{}} solo=${r.players.length < 2} />`)}
  </div>`;
}
function HistoryContent() {
  const { records, loading, error, saveError } = useStore((s) => s, Object.is, historyStore);
  const [selected, select] = useState(null);
  const [operationError, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState(null);
  const fileInput = useRef(null);
  const importInFlight = useRef(false);
  const record = records.find((r) => r.id === selected);
  useEffect(() => { if (selected && !record && !loading) select(null); }, [selected, record, loading]);
  async function erase(all) {
    if (busy || (!all && !record)) return;
    const id = record?.id;
    const confirmed = await confirmDialog({ title: all ? t('清空对局记录？') : t('删除这局记录？'),
      text: t('删除后无法恢复，可以先导出数据备份。'), okText: all ? t('清空') : t('删除'), danger: true });
    if (!confirmed) return;
    setBusy(true); setError('');
    try { if (all) await clearHistory(); else await removeHistory(id); select(null); }
    catch (err) { setError(err.message || t('删除失败，请重试')); }
    finally { setBusy(false); }
  }
  async function readImport(e) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file || importInFlight.current || busy) return;
    importInFlight.current = true; setBusy(true); setImporting(true); setError(''); setImportNotice(null);
    try {
      if (file.size > HISTORY_IMPORT_BYTES) throw new Error(t('对局记录文件过大，请选择不超过 16 MB 的 JSON 文件。'));
      const summary = await importHistory(await file.text());
      select(null); setImportNotice(summary);
    } catch (err) { setError(err.message ? t(err.message) : t('导入失败，请重试')); }
    finally { importInFlight.current = false; setBusy(false); setImporting(false); }
  }
  return html`<${Modal} open=${true} title=${t('对局记录')} micro="LOCAL MATCH HISTORY" onClose=${closeHistory}
    width="14rem" class="history-panel" actions=${html`
      ${record ? html`<${Button} icon="chevronLeft" onClick=${() => select(null)} disabled=${busy}>${t('返回列表')}<//>` : null}
      <${Button} class="history-import" variant="secondary" disabled=${loading || busy} loading=${importing} onClick=${() => fileInput.current?.click()}>${t('导入记录')}<//>
      <${Button} variant="secondary" disabled=${loading || busy || !records.length} onClick=${() => download(record ? [record] : records)}>${record ? t('导出本局') : t('导出全部')}<//>
      <${Button} disabled=${loading || busy || !records.length} onClick=${() => erase(!record)}>${record ? t('删除本局') : t('清空记录')}<//>
      <${Button} variant="primary" onClick=${closeHistory}>${t('关闭')}<//>`}>
    <p class="history-notice">${t('结算时自动保存最近 {HISTORY_LIMIT} 局，仅保存在当前浏览器和当前站点。清除网站数据会删除记录。', { HISTORY_LIMIT })}</p>
    <p class="history-notice">${t('支持导入本游戏导出的 JSON 文件，与已有记录合并，重复记录自动跳过，仅保留最近 {HISTORY_LIMIT} 局。', { HISTORY_LIMIT })}</p>
    <input ref=${fileInput} class="history-import-file" type="file" accept=".json,application/json" hidden onChange=${readImport} />
    ${importNotice ? html`<p class="history-import-notice" role="status">
      ${t('导入完成：新增 {added} 局，跳过 {skipped} 局重复记录。', importNotice)}
      ${importNotice.discarded ? t('{n} 局较早的记录超出保存上限，未保留。', { n: importNotice.discarded }) : ''}
    </p>` : null}
    ${error || operationError || saveError ? html`<p class="history-error" role="alert">${operationError || error || saveError}
      <${Button} size="sm" icon="refresh" onClick=${refreshHistory}>${t('重试读取')}<//></p>` : null}
    ${loading ? html`<div class="history-empty"><${Spinner} />${t('读取记录…')}</div>` : record ? html`<${HistoryDetail} record=${record} />` :
      records.length ? html`<div class="history-list">${records.map((rec) => {
        const p = rec.result.players.find((p) => p.playerId === rec.playerId);
        const win = typeof p?.victory === 'boolean' ? p.victory : rec.result.victory;
        return html`<button class="history-entry" key=${rec.id} onClick=${() => select(rec.id)}>
          <strong class=${win ? 'history-win' : 'history-loss'}>${win ? t('成功卫戍') : t('模拟失败')}</strong>
          <${DifficultyTag} difficulty=${rec.result.difficulty} />
          <span>${dateText(rec.endedAt)}</span><span>${p?.name || t('博士')}</span>
          <span>${t('通过')} ${p?.roundsPassed ?? rec.result.roundsPassed ?? 0} ${t('回合')}</span>
          <span>${durationText(rec.result.durationMs)}</span><span class="history-entry__view">${t('查看详情 ›')}</span>
        </button>`;
      })}</div>` : html`<p class="history-empty">${t('暂无对局记录，完成一局模拟后会自动保存。')}</p>`}
    <${MicroLabel}>${records.length} / ${HISTORY_LIMIT} RECORDS<//>
  <//>`;
}
export function HistoryHost() {
  const open = useStore((s) => s.open, Object.is, historyStore);
  return open ? html`<${HistoryContent} />` : null;
}
