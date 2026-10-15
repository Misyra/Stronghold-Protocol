// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// Compact entry points share one global resource manager; closing it leaves background downloads running.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Modal, ProgressBar } from './components.js';
import { createStore, useStore } from '../store.js';
import { data, getChess } from '../data.js';
import { skinsStore } from './skins.js';
import { formatBytes } from '../resources/common.js';
import { clearResources, exportResources, importResources, inspectResources, pauseResources,
  resourceState, startResources, subscribeResources } from '../resources/index.js';
import { t } from '../../../shared/i18n.js';

const RESOURCE_DOWNLOAD_URL = 'https://b23.tv/A4vdQ1k';

export function byteText(st) {
  const total = Number.isFinite(st.totalBytes) && st.totalBytes > 0 ? st.totalBytes : 0;
  if (!total) return '';
  const done = Number.isFinite(st.bytes) ? st.bytes : 0;
  return st.sizedTotal ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(total);
}

export function detailText(st) {
  if (!st.total) return '';
  return [st.tier1Total ? t('必需 {tier1Done}/{tier1Total}', { tier1Done: st.tier1Done, tier1Total: st.tier1Total }) : '', t('全部 {done}/{total}', { done: st.done, total: st.total }), byteText(st)].filter(Boolean).join(' · ');
}

export function percent(st) {
  if (!st.total) return 0;
  if (st.complete) return 100;
  const byBytes = st.totalBytes > 0 && st.sizedTotal === st.total;
  const pct = byBytes ? (st.bytes / st.totalBytes) * 100 : (st.done / Math.max(1, st.wanted || st.total)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function skipReasonText(reasons = {}) {
  return [
    reasons.removed ? t('当前版本不再使用：{n} 个', { n: reasons.removed }) : '',
    reasons.fingerprint ? t('服务器缺少内容指纹：{n} 个', { n: reasons.fingerprint }) : '',
    reasons.changed ? t('资源内容已更新：{n} 个', { n: reasons.changed }) : '',
    reasons.size ? t('资源大小不匹配：{n} 个', { n: reasons.size }) : '',
    reasons.oversized ? t('超过单文件上限：{n} 个', { n: reasons.oversized }) : '',
  ].filter(Boolean).join('；');
}

export function storageText(storage) {
  if (!storage) return '';
  const parts = [];
  if (storage.usage != null) parts.push(t('本站已用约 {size}', { size: formatBytes(storage.usage) }));
  if (storage.available != null) parts.push(t('预计可用 {size}', { size: formatBytes(storage.available) }));
  parts.push(t('预计新增 {size}', { size: formatBytes(storage.requiredBytes) }));
  if (storage.unknownFiles) parts.push(t('{n} 个文件大小未知', { n: storage.unknownFiles }));
  return parts.join(' · ');
}

const resourceUi = createStore({ open: false });
export const openResources = () => resourceUi.set({ open: true });
const closeResources = () => resourceUi.set({ open: false });
const busy = (st) => !!st.clearing || !!st.archive || st.phase === 'download' || st.phase === 'checking';

function useResources() {
  const [state, setState] = useState(resourceState);
  useEffect(() => subscribeResources(setState), []);
  return state;
}

function stateText(st, enabled) {
  if (st.archive) return st.archive === 'import' ? t('正在导入') : t('正在导出');
  if (st.phase === 'foreign') return t('另一标签页处理中');
  if (busy(st)) return t('处理中');
  // The selection decides the wording: with optional files (or chosen 干员皮肤) in it, 「全部已保存」 means those too.
  if (st.selectionComplete) return st.tier2Wanted > 0 ? t('全部已保存') : t('必备已保存');
  if (st.requiredComplete && st.tier1Total) return t('必备已保存');
  return enabled ? t('已暂停') : t('未开启');
}

export function ResourceRow({ enabled }) {
  const st = useResources();
  return html`<div class="set-res">
    <div class="set-row">
      <span class="set-row__label">${t('预载资源')}<${MicroLabel}>PRELOAD<//></span>
      <${Button} variant="secondary" size="sm" icon="expand" onClick=${openResources}>${t('资源管理')}<//>
    </div>
    <p class="set-hint">${stateText(st, enabled)} ${t('· 管理必备与可选资源，或导入、导出 ZIP 资源包。')}</p>
  </div>`;
}

export function ResourceLauncher({ enabled }) {
  const st = useResources();
  return html`<div class=${`res-pill${enabled ? ' is-on' : ''}`}>
    <button type="button" class="res-pill__head" title=${t('管理预载资源和 ZIP 资源包')} onClick=${openResources}>
      <span class="res-pill__label">${t('预载资源')}<${MicroLabel}>PRELOAD<//></span>
      <span class="res-pill__state">${stateText(st, enabled)}</span>
    </button>
    <p class="res-pill__hint">${t('必备 / 可选资源 · ZIP 导入与导出')}</p>
  </div>`;
}

function ResourceTier({ st, tier, optional, onOptional, disabled }) {
  // 干员皮肤 are tier 2 too, but they are picked item by item in their own section (ResourceSkins below): keeping them
  // out of this list is what makes 「可选资源」 mean voices/sound/music/tutorials again.
  const groups = st.groups.filter((g) => g.tier === tier && g.id !== 'skin');
  const total = groups.reduce((n, g) => n + g.wanted, 0);
  const done = groups.reduce((n, g) => n + g.present, 0);
  const bytes = groups.reduce((n, g) => n + g.bytes, 0);
  const totalBytes = groups.reduce((n, g) => n + g.totalBytes, 0);
  const unknown = groups.some((g) => g.unknownSize);
  return html`<section class="resource-tier">
    <header class="resource-tier__head">
      <div><h3>${tier === 1 ? t('必备资源') : t('可选资源')}</h3>
        <p>${tier === 1 ? t('地图、干员图片与 Spine 等画面资源') : t('角色语音、音效、背景音乐与玩法说明图片')}</p></div>
      ${tier === 2 ? html`<label class="resource-choice"><input type="checkbox" checked=${optional} disabled=${disabled}
        onChange=${(e) => onOptional(e.currentTarget.checked)} />${t('同时预载')}</label>` : html`<${MicroLabel}>REQUIRED<//>`}
    </header>
    <div class="resource-tier__summary"><span class="num">${t('{done} / {total} 个文件', { done, total })}</span>
      <span class="num">${unknown ? t('部分大小未知') : `${formatBytes(bytes)} / ${formatBytes(totalBytes)}`}</span></div>
    <${ProgressBar} value=${done} max=${Math.max(1, total)} size="sm" tone=${tier === 1 ? 'mint' : 'amber'} />
    <ul class="resource-tier__list">
      ${groups.map((group) => html`<li key=${group.id}
        class=${st.archivePhase === 'import' && st.archiveGroup === group.id ? 'is-importing' : ''}><span>${t(group.name)}${group.id === 'voice' && !st.allVoices ? ` · ${st.voiceLang === 'jp' ? t('日语') : t('中文')}` : ''}
          ${st.archivePhase === 'import' && st.archiveGroup === group.id ? html`<small>${t('正在导入')}</small>` : null}</span>
        <span class="num">${group.present}/${group.wanted}</span>
        <span class="num">${group.unknownSize ? t('大小待确认') : formatBytes(group.totalBytes)}</span></li>`)}
    </ul>
  </section>`;
}

/** The skins this browser has equipped (ui/skins.js), as the `charId/skinId` keys a manifest carries. */
function equippedSkinKeys() {
  const keys = new Set();
  for (const [chessId, skinId] of Object.entries(skinsStore.get().entries || {})) {
    const charId = getChess(chessId)?.charId;
    if (charId && skinId) keys.add(`${charId}/${skinId}`);
  }
  return keys;
}

/** The label tables the list renders from, read in one go (`{ names, assets, catalogue }`). */
function labelTables() {
  return { names: operatorNames(), assets: data.get('assets'), catalogue: data.get('skins')?.chars };
}

/** Name and series of one `charId/skinId`, from the tables read by `labelTables()`. */
function skinLabel(key, { names, assets, catalogue }) {
  const slash = key.indexOf('/');
  const charId = key.slice(0, slash), skinId = key.slice(slash + 1);
  const entry = assets?.chars?.[charId]?.skins?.[skinId];
  const fromCatalogue = (catalogue?.[charId] || []).find((s) => s.id === skinId);
  return {
    charId,
    operator: names.get(charId) || charId,
    skin: entry?.name || fromCatalogue?.name || skinId,
    group: entry?.group || fromCatalogue?.group || '',
  };
}

/**
 * `charId` → operator name, from the chess table's records (the same table the skin sync itself is keyed by). That table
 * is the game's roster, and the skin catalogue is wider than it — 174 operators ship outfits here against 266 chess
 * records over 121 operators — so an outfit whose operator the roster does not carry keeps its charId as the label
 * (`skinLabel`), which is at least searchable.
 */
function operatorNames() {
  const out = new Map();
  for (const record of data.list('chess')) {
    if (record?.charId && record.name && !out.has(record.charId)) out.set(record.charId, record.name);
  }
  return out;
}

/**
 * 干员皮肤 — the one optional group a player picks item by item (docs/SKINS.md). A full install is ~328 MiB, so it is
 * off by default and never rides 「同时预载可选资源」: the modes are off / the picked ones / every skin the server offers.
 * The counters come from the manifest (`st.skins`), so a deployment without skins installed simply shows nothing.
 */
function ResourceSkins({ st, scope, disabled, onScope }) {
  const skins = st.skins || [];
  if (!skins.length) return null;
  const mode = scope.mode || 'off';
  const picked = scope.keys || [];
  const pickedSet = new Set(picked);
  const files = skins.reduce((n, s) => n + s.files, 0);
  const cachedFiles = skins.reduce((n, s) => n + s.present, 0);
  const totalBytes = skins.reduce((n, s) => n + s.totalBytes, 0);
  const cachedBytes = skins.reduce((n, s) => n + s.bytes, 0);
  const done = skins.filter((s) => s.files > 0 && s.present >= s.files).length;
  // Keep the picks while the mode is off/all: switching back to 「挑选」 restores what the player chose.
  const setMode = (next) => onScope({ mode: next, keys: picked });
  const setKeys = (keys) => onScope({ mode: 'picked', keys: [...new Set(keys)].sort() });
  return html`<section class="resource-skins" aria-label=${t('干员皮肤')}>
    <header class="resource-skins__head">
      <div><h3>${t('干员皮肤')}</h3>
        <p>${t('按套下载皮肤模型与立绘：一套约 1.2 MiB，{total} 套共 {size}。', { total: skins.length, size: formatBytes(totalBytes) })}</p></div>
      <div class="resource-skin--modes" role="group" aria-label=${t('皮肤预载范围')} data-testid="skin-modes">
        ${[['off', t('不预载')], ['picked', t('挑选')], ['all', t('全部')]].map(([id, label]) => html`<button type="button" key=${id}
          aria-pressed=${mode === id ? 'true' : 'false'} disabled=${disabled} onClick=${() => setMode(id)}>${label}</button>`)}
      </div>
    </header>
    <div class="resource-tier__summary">
      <span class="num">${t('{done} / {total} 套已保存', { done, total: skins.length })}
        ${mode === 'picked' ? ` · ${t('已选 {n} 套', { n: pickedSet.size })}` : ''}</span>
      <span class="num">${formatBytes(cachedBytes)} / ${formatBytes(totalBytes)}</span>
    </div>
    <${ProgressBar} value=${cachedFiles} max=${Math.max(1, files)} size="sm" tone="amber" />
    ${mode === 'picked' ? html`<${SkinList} skins=${skins} picked=${pickedSet} disabled=${disabled} setKeys=${setKeys} />` : null}
  </section>`;
}

/** The item-by-item half of the section: search, per-skin checkboxes, 全选 / 清空 / 跟随我的皮肤选择. */
function SkinList({ skins, picked, disabled, setKeys }) {
  const [query, setQuery] = useState('');
  // Names come from the asset manifest (skin name/series) and the chess table (operator name) — loaded on demand, only
  // once the player opens this list, so a client that never picks skins never pays for either table. The tables are read
  // *into state* and re-read whenever one of them settles (or the locale switches), which is what makes the first paint
  // after the loads show names instead of ids: reading them during the render would race the load.
  const [labels, setLabels] = useState(labelTables);
  useEffect(() => {
    let live = true;
    const refresh = () => { if (live) setLabels(labelTables()); };
    const unsub = data.subscribe(refresh);
    void data.loadAll('assets', 'chess').then(refresh, refresh);
    refresh();
    return () => { live = false; unsub(); };
  }, []);
  const rows = skins.map((skin) => ({ ...skin, ...skinLabel(skin.id, labels) }));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = terms.length ? rows.filter((row) => terms.every((term) =>
    `${row.operator} ${row.skin} ${row.group} ${row.id}`.toLowerCase().includes(term))) : rows;
  const toggle = (key, on) => setKeys(on ? [...picked, key] : [...picked].filter((k) => k !== key));
  const follow = () => {
    const equipped = equippedSkinKeys();
    setKeys(skins.map((s) => s.id).filter((id) => equipped.has(id)));
  };
  return html`<div class="resource-skins__list" data-testid="skin-list">
    <div class="resource-skins__tools">
      <input type="search" value=${query} disabled=${disabled} placeholder=${t('搜索干员、皮肤或系列')}
        aria-label=${t('搜索干员、皮肤或系列')} onInput=${(e) => setQuery(e.currentTarget.value)} />
      <${Button} variant="secondary" size="sm" disabled=${disabled} onClick=${follow}>${t('跟随我的皮肤选择')}<//>
      <${Button} variant="secondary" size="sm" disabled=${disabled} onClick=${() => setKeys(rows.map((r) => r.id))}>${t('全选')}<//>
      <${Button} variant="secondary" size="sm" disabled=${disabled || !picked.size} onClick=${() => setKeys([])}>${t('清空')}<//>
    </div>
    <p class="set-hint">${t('只预载勾选的皮肤；未勾选的不会下载，已缓存的其他皮肤不会被清理。')}</p>
    <ul class="resource-skins__rows">
      ${shown.map((row) => {
        const cached = row.files > 0 && row.present >= row.files;
        return html`<li key=${row.id} class=${cached ? 'is-cached' : ''} data-skin=${row.id} title=${row.id}>
          <label><input type="checkbox" checked=${picked.has(row.id)} disabled=${disabled}
            onChange=${(e) => toggle(row.id, e.currentTarget.checked)} />
            <span class="resource-skins__name">${row.skin}${row.group ? html`<small>${row.group}</small>` : null}</span>
            <span class="resource-skins__op">${row.operator}</span>
            <span class="num">${formatBytes(row.totalBytes)}</span>
            <span class="num">${cached ? t('已保存') : t('未保存')}</span></label></li>`;
      })}
    </ul>
    ${shown.length ? null : html`<p class="set-hint">${t('没有匹配的皮肤。')}</p>`}
  </div>`;
}

/** Mounted once in main.js, above all screens including the settings modal. */
export function ResourceHost({ enabled, optional, allVoices, voiceLang = 'cn', skins, onVoiceLang, onChange, onOptional, onAllVoices, onSkins }) {
  const { open } = useStore((s) => s, Object.is, resourceUi);
  const st = useResources();
  const fileInput = useRef(null);
  useEffect(() => { if (open) void inspectResources().catch(() => {}); }, [open]);
  const archiveBusy = !!st.archive || !!st.clearing;
  const importFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try { await importResources(file, { onImported: () => onChange(true) }); } catch { /* controller displays the error */ }
  };
  const clearOptional = async () => {
    const result = await clearResources({ optionalOnly: true });
    if (!result?.busy && !result?.error) onOptional(false);
  };
  const exportFile = async () => {
    try {
      const { blob, version } = await exportResources();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stronghold-resources-${version.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* controller displays the error */ }
  };
  return html`<${Modal} open=${open} onClose=${closeResources} title=${t('预载资源管理')} micro="RESOURCE MANAGER" class="resource-modal" utility=${true}
    actions=${html`
      ${busy(st) ? html`<${Button} variant="secondary" icon="hourglass" disabled=${st.clearing} onClick=${pauseResources}>${st.clearing ? t('正在清理') : archiveBusy ? t('取消处理') : t('暂停下载')}<//>`
        : html`<${Button} variant="primary" icon="play" disabled=${!st.supported || st.clearing}
          onClick=${() => enabled ? startResources() : onChange(true)}>${st.selectionComplete ? t('检查资源') : enabled ? t('继续下载') : t('开始预载')}<//>`}
      <${Button} variant="secondary" onClick=${closeResources}>${t('关闭')}<//>`}>
    <div class="resource-manager">
      <section class="resource-manager__voice" aria-label=${t('语音预载')}
        title=${optional ? allVoices ? t('预载中文和日语语音。') : t('仅预载{language}语音；切换语言后补载缺少的资源，已缓存语音保留。', { language: voiceLang === 'jp' ? t('日语') : t('中文') }) : t('可选资源预载已关闭，语音在使用时加载。')}>
        <div class="resource-manager__voice-head"><h3>${t('语音语言')}</h3>
          <div class="resource-voice-tabs" role="group" aria-label=${t('语音语言')}>
            ${['cn', 'jp'].map((lang) => html`<button type="button" aria-pressed=${voiceLang === lang}
              disabled=${archiveBusy || !onVoiceLang} onClick=${() => onVoiceLang?.(lang)}>${lang === 'cn' ? t('中文') : t('日语')}</button>`)}
          </div>
        </div>
        <label class="resource-choice resource-voice-all"><input type="checkbox" checked=${allVoices} disabled=${archiveBusy || !optional}
          onChange=${(e) => onAllVoices(e.currentTarget.checked)} />${t('同时预载全部语音语言')}</label>
      </section>
      <div class="resource-manager__tiers">
        <${ResourceTier} st=${st} tier=${1} />
        <${ResourceTier} st=${st} tier=${2} optional=${optional} onOptional=${onOptional} disabled=${archiveBusy} />
      </div>
      <${ResourceSkins} st=${st} scope=${skins || { mode: 'off', keys: [] }} disabled=${archiveBusy} onScope=${onSkins || (() => {})} />
      ${st.combat && enabled ? html`<p class="resource-manager__intro">${t('作战中：画面资源低速预载，语音等可选资源将在作战结束后继续。')}</p>` : null}
      <p class=${`resource-manager__status${st.error ? ' is-error' : ''}`} role="status" aria-live="polite">
        ${st.message || (enabled ? t('预载已开启') : t('选择下载范围，然后开始预载；也可以直接导入资源包。'))}</p>
      ${st.worker ? html`<p class="resource-manager__warn">${st.worker}</p>` : null}
      ${st.failed ? html`<p class="resource-manager__warn">${t('{failed} 个文件下载失败，继续下载时重试。', { failed: st.failed })}</p>` : null}
      ${st.skipped ? html`<p class="resource-manager__warn">${t('{skipped} 个文件超过单文件缓存上限，使用时按需加载。', { skipped: st.skipped })}</p>` : null}
      ${st.failures?.length ? html`<details class="resource-manager__failures"><summary>${t('查看下载失败详情')}</summary>
        <ul>${st.failures.map((failure) => html`<li>${new URL(failure.url, window.location.href).pathname} — ${failure.message}</li>`)}</ul>
      </details>` : null}
      <section class="resource-archive">
        <div class="resource-archive__toolbar">
          <h3>${t('ZIP 资源包')}</h3>
          <div class="res-actions">
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported} onClick=${() => fileInput.current?.click()}>${t('导入 ZIP')}<//>
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported || !st.done} onClick=${exportFile}>${t('导出 ZIP')}<//>
            <${Button} variant="secondary" size="sm" icon="link"
              onClick=${() => window.open(RESOURCE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')}>${t('前往下载')}<//>
          </div>
        </div>
        <details class="resource-archive__help">
          <summary>${t('资源包说明')}</summary>
          <p>${t('点击「前往下载」查看资源包链接。lite 仅含基础画面资源，full 还包含中日语音、音效、音乐等；也可导出已缓存资源分享。')}</p>
          <p>${t('导入时会校验文件，并跳过不适用的资源；开启预载后可补齐缺少部分。若提示校验失败或 ZIP 损坏，请重新下载完整资源包。')}</p>
          <p>${t('跨站导入说明：本站资源包包含额外的地图与模型配置，导入 xinhai（linxia）站点时可能提示「资源路径无效」并中止。请使用目标站点提供的资源包。')}</p>
        </details>
        ${st.archiveResult ? html`<div class=${`resource-archive__result${st.archiveResult.status === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">
          <p>${st.archiveResult.message}</p>
          ${skipReasonText(st.archiveResult.skipReasons) ? html`<p>${skipReasonText(st.archiveResult.skipReasons)}</p>` : null}
        </div>` : null}
        ${st.archive ? html`<${ProgressBar} value=${st.archivePercent} max=${100} size="sm" tone="mint" />` : null}
        <input ref=${fileInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange=${importFile} />
      </section>
      ${st.storage?.low ? html`<p class="resource-manager__warn">${t('预计可用空间可能不足。可先清理可选资源；浏览器仍可能因存储限制而停止处理，已保存进度会保留。')}</p>` : null}
      <details class="resource-cache">
        <summary><span class="resource-cache__title">${t('缓存清理')}</span><span class="resource-cache__storage">${storageText(st.storage)}</span></summary>
        <div class="resource-cache__body">
          <p>${t('只清理本站预载资源，保留个人设置。清理全部资源后暂停下载。')}</p>
          <div class="res-actions">
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported} onClick=${clearOptional}>${t('清理可选资源')}<//>
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported} onClick=${() => { void clearResources(); }}>${t('清理全部资源')}<//>
          </div>
          <div class="resource-manager__maintenance">
            ${enabled ? html`<button type="button" class="res-link" onClick=${() => onChange(false)}>${t('关闭预载')}</button>` : null}
            <span>${t('关闭预载会保留已缓存资源。')}</span>
          </div>
        </div>
      </details>
    </div>
  <//>`;
}
