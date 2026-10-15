// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// Compact entry points share one global resource manager; closing it leaves background downloads running.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Modal, ProgressBar } from './components.js';
import { createStore, useStore } from '../store.js';
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

/**
 * 干员皮肤 — one switch, no list (docs/SKINS.md). A full install is ~328 MiB, so it is off by default and never rides
 * 「同时预载可选资源」; when it is on, the preload follows the outfits equipped in 干员调配 (ui/skins.js), and picking one
 * there is what starts its download. The counters come from the manifest (`st.skins`), so a deployment without skins
 * installed simply shows nothing.
 */
function ResourceSkins({ st, enabled, on, disabled, onToggle }) {
  const skins = st.skins || [];
  if (!skins.length) return null;
  const equipped = (st.skinScope?.keys || []).length;
  const files = skins.reduce((n, s) => n + s.files, 0);
  const cachedFiles = skins.reduce((n, s) => n + s.present, 0);
  const totalBytes = skins.reduce((n, s) => n + s.totalBytes, 0);
  const cachedBytes = skins.reduce((n, s) => n + s.bytes, 0);
  const cachedOutfits = skins.filter((s) => s.files > 0 && s.present >= s.files).length;
  const hint = !enabled ? t('预载资源总开关没打开，先开它。')
    : on && !equipped ? t('还没选过皮肤：在干员调配里挑一套，这里会跟着缓存。') : '';
  return html`<section class="resource-skins" aria-label=${t('干员皮肤')}>
    <header class="resource-skins__head">
      <div><h3>${t('干员皮肤')}</h3>
        <p>${t('在干员调配里选中的皮肤会自动缓存到本机：一套约 1.2 MiB，{total} 套共 {size}。', { total: skins.length, size: formatBytes(totalBytes) })}</p></div>
      <label class="resource-choice"><input type="checkbox" data-testid="skin-preload" checked=${on} disabled=${disabled || !enabled}
        onChange=${(e) => onToggle(e.currentTarget.checked)} />${t('预载我选的皮肤')}</label>
    </header>
    <div class="resource-tier__summary">
      <span class="num">${t('本机已选 {n} 套 · 已缓存 {done} 套', { n: equipped, done: cachedOutfits })}</span>
      <span class="num">${formatBytes(cachedBytes)} / ${formatBytes(totalBytes)}</span>
    </div>
    <${ProgressBar} value=${cachedFiles} max=${Math.max(1, files)} size="sm" tone="amber" />
    ${hint ? html`<p class="set-hint resource-skins__hint">${hint}</p>` : null}
  </section>`;
}

/** Mounted once in main.js, above all screens including the settings modal. */
export function ResourceHost({ enabled, optional, allVoices, voiceLang = 'cn', skinPreload, onVoiceLang, onChange, onOptional, onAllVoices, onSkinPreload }) {
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
      <${ResourceSkins} st=${st} enabled=${enabled} on=${!!skinPreload} disabled=${archiveBusy}
        onToggle=${onSkinPreload || (() => {})} />
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
