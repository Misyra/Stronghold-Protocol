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

/** One preload card's name; the ZIP card exports one card at a time, so it needs the same words (docs/ASSETS.md). */
const SCOPE_TEXT = { essential: () => t('必备资源'), voice: () => t('干员语音'), skin: () => t('干员皮肤'), fx: () => t('官方特效') };

export const scopeText = (id) => (SCOPE_TEXT[id] ? SCOPE_TEXT[id]() : t('全部资源'));

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
  if (st.phase === 'checking') return t('正在检查已缓存资源');
  if (st.phase === 'download') return t('正在下载');
  if (st.clearing) return t('正在清理');
  if (st.error && !st.manifestFiles) return t('读取失败');
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

/** Only selected, cacheable files contribute to this run; catalog totals remain visible in each card. */
export function resourcePlan(st) {
  const groups = st.groups || [];
  const total = groups.reduce((n, g) => n + g.totalBytes, 0);
  const cached = groups.reduce((n, g) => n + g.bytes, 0);
  const unknown = groups.reduce((n, g) => n + g.unknownSize, 0);
  const missing = Math.max(0, (st.wanted || 0) - (st.done || 0));
  const progress = st.selectionComplete ? 100 : !st.wanted ? 0
    : !unknown && total > 0 ? cached / total * 100 : (st.done || 0) / st.wanted * 100;
  return { total, cached, unknown, missing, remaining: Math.max(0, total - cached),
    progress: Math.max(0, Math.min(100, Math.round(progress))) };
}

export const RESOURCE_PRESETS = Object.freeze({
  essential: { preloadOptional: false, preloadVoices: false, preloadSkins: false, preloadSkinsAll: false, preloadFx: false, preloadAllVoices: false },
  daily: { preloadOptional: true, preloadVoices: true, preloadSkins: true, preloadSkinsAll: false, preloadFx: false, preloadAllVoices: false },
  full: { preloadOptional: true, preloadVoices: true, preloadSkins: true, preloadSkinsAll: true, preloadFx: true, preloadAllVoices: true },
});

const voiceName = (lang) => ({ cn: t('中文'), jp: t('日语'), en: t('英语'), kr: t('韩语') })[lang] || t('中文');

function ResourceChoice({ id, on, disabled, onChange, children }) {
  return html`<label class=${`resource-choice${on ? '' : ' is-off'}`}>
    <input type="checkbox" data-testid=${id} checked=${on} disabled=${disabled}
      onChange=${(e) => onChange?.(e.currentTarget.checked)} />${children}</label>`;
}

function ResourceScope({ st, enabled, disabled, preferences, onPreset }) {
  const plan = resourcePlan(st);
  return html`<section class="resource-scope" aria-label=${t('预载范围')}>
    <div class="resource-scope__head"><h3>${t('预载范围')}</h3>
      <span class="resource-scope__total">${t('只补齐缺少的文件，已缓存资源会保留。')}</span></div>
    <div class="resource-presets" role="group" aria-label=${t('快捷方案')}>
      ${[['essential', t('仅必备')], ['daily', t('日常推荐')], ['full', t('完整预载')]].map(([key, label]) => html`
        <button type="button" disabled=${disabled || !onPreset}
          aria-pressed=${Object.entries(RESOURCE_PRESETS[key]).every(([name, value]) => preferences[name] === value)}
          onClick=${() => onPreset?.(RESOURCE_PRESETS[key])}>${label}</button>`)}
    </div>
    <div class="resource-overview">
      <div><span>${t('本次预载')}</span><strong class="num">${formatBytes(plan.total)}${plan.unknown ? '+' : ''}</strong></div>
      <div><span>${t('已缓存')}</span><strong class="num">${formatBytes(plan.cached)}</strong></div>
      <div><span>${t('还需下载')}</span><strong class="num">${formatBytes(plan.remaining)}${plan.unknown && plan.missing ? '+' : ''}</strong></div>
    </div>
    <div class="resource-overview__state"><span>${stateText(st, enabled)}</span><span class="num">${plan.progress}% · ${t('{done} / {total} 个文件', { done: st.done, total: st.wanted })}</span></div>
    <${ProgressBar} value=${plan.progress} max=${100} size="sm" tone="mint" />
    ${plan.unknown ? html`<p class="set-hint">${t('{n} 个文件大小未知', { n: plan.unknown })}</p>` : null}
  </section>`;
}

function ResourceProgress({ groups }) {
  const sum = (field) => groups.reduce((n, g) => n + g[field], 0);
  const total = sum('allTotal'), done = sum('allPresent');
  return html`<div class="resource-tier__summary"><span class="num">${t('{done} / {total} 个文件', { done, total })}</span>
    <span class="num">${formatBytes(sum('allCached'))} / ${formatBytes(sum('allBytes'))}${sum('allUnknown') ? '+' : ''}</span></div>
    <${ProgressBar} value=${done} max=${Math.max(1, total)} size="sm" tone="mint" />`;
}

function ResourceGroupList({ st, groups, off = false }) {
  return html`<ul class="resource-tier__list">${groups.map((group) => html`
    <li key=${group.id} class=${off ? 'is-off' : ''}><span class="resource-tier__name">${t(group.name)}
      ${st.archivePhase === 'import' && st.archiveGroup === group.id ? html`<small>${t('正在导入')}</small>` : null}</span>
      <span class="num">${group.allPresent}/${group.allTotal}</span>
      <span class="num">${group.allUnknown ? t('大小待确认') : formatBytes(group.allBytes)}</span></li>`)}</ul>`;
}

function ResourceTier({ st, tier, optional, voices, disabled, onOptional, onVoices, voiceLang, allVoices, onVoiceLang, onAllVoices }) {
  const required = tier === 1;
  const groups = st.groups.filter((g) => required ? g.tier === 1 : g.id === 'voice');
  const extras = st.groups.filter((g) => g.tier === 2 && !['skin', 'fx', 'voice'].includes(g.id));
  const on = required || voices;
  return html`<section class=${`resource-tier${on ? '' : ' is-off'}`}>
    <header class="resource-tier__head"><div><${MicroLabel}>${required ? '01 / ESSENTIAL' : '02 / VOICE'}<//>
      <h3>${required ? t('必备资源') : t('干员语音')}</h3></div>
      ${required ? html`<span class="resource-badge">${t('始终预载')}</span>`
        : html`<${ResourceChoice} id="voice-preload" on=${voices} disabled=${disabled} onChange=${onVoices}>${t('预载')}<//>`}
    </header>
    <p class="resource-card__description">${required ? t('地图、干员图片与 Spine 等画面资源') : t('按所选语言缓存语音，切换后只补载缺少部分。')}</p>
    <${ResourceProgress} groups=${groups} />
    ${!on ? html`<p class="resource-card__note">${t('未预载')} · ${t('使用时按需加载')}</p>` : null}
    ${required ? html`<details class="resource-card__details"><summary>${t('资源明细')}</summary>
      <${ResourceGroupList} st=${st} groups=${groups} />
      <${ResourceGroupList} st=${st} groups=${extras} off=${!optional} /></details>
      ${extras.length ? html`<div class="resource-extra">
        <${ResourceChoice} id="optional-preload" on=${optional} disabled=${disabled} onChange=${onOptional}>${t('音效、音乐与玩法说明')}
          <span class="resource-choice__size">${formatBytes(extras.reduce((n, g) => n + g.allBytes, 0))}${extras.some((g) => g.allUnknown) ? '+' : ''}</span><//>
      </div>` : null}` : html`<section class="resource-manager__voice" aria-label=${t('语音预载')}>
      <div class="resource-voice-tabs" role="group" aria-label=${t('语音语言')}>
        ${['cn', 'jp', 'en', 'kr'].filter((lang) => lang === voiceLang || st.voiceLanguages?.includes(lang)).map((lang) => html`<button type="button" aria-pressed=${voiceLang === lang}
          disabled=${disabled || !onVoiceLang} onClick=${() => onVoiceLang?.(lang)}>${voiceName(lang)}</button>`)}
      </div>
      <label class="resource-choice resource-voice-all"><input type="checkbox" checked=${allVoices} disabled=${disabled || !voices}
        onChange=${(e) => onAllVoices?.(e.currentTarget.checked)} />${t('同时预载全部语音语言')}</label>
      <p class="resource-card__note">${allVoices ? t('缓存服务器提供的全部语音语言。')
        : st.manifestFiles && !st.voiceLanguages?.includes(voiceLang) ? t('服务器尚未提供所选语言的语音资源。')
          : t('当前语音：{language}', { language: voiceName(voiceLang) })}</p>
    </section>`}
  </section>`;
}

function ResourceSkins({ st, on, all, disabled, onSkin, onAll }) {
  const skins = st.skins || [];
  if (!skins.length) return null;
  const everyOutfit = !!(on && all);
  const keys = new Set(st.skinScope?.keys || []);
  // The main bar measures this run, not the complete catalog when only two outfits are equipped.
  const selected = on ? skins.filter((s) => everyOutfit || keys.has(s.id)) : [];
  const sum = (field) => selected.reduce((n, s) => n + s[field], 0);
  const cachedOutfits = skins.filter((s) => s.files > 0 && s.present >= s.files).length;
  const totalBytes = skins.reduce((n, s) => n + s.totalBytes, 0);
  return html`<section class=${`resource-skins${on ? '' : ' is-off'}`} aria-label=${t('干员皮肤')}>
    <header class="resource-tier__head"><div><${MicroLabel}>03 / SKINS<//><h3>${t('干员皮肤')}</h3></div>
      <${ResourceChoice} id="skin-preload" on=${on} disabled=${disabled} onChange=${onSkin}>${t('预载')}<//></header>
    <p class="resource-card__description">${t('默认跟随干员调配里选择的皮肤，也可缓存全部已安装皮肤。')}</p>
    <div class="resource-tier__summary"><span class="num">${t('本次 {n} 套', { n: selected.length })}</span>
      <span class="num">${formatBytes(sum('bytes'))} / ${formatBytes(sum('totalBytes'))}${selected.some((s) => s.unknownSize) ? '+' : ''}</span></div>
    <${ProgressBar} value=${sum('present')} max=${Math.max(1, sum('files'))} size="sm" tone="amber" />
    <label class="resource-choice resource-skins__all"><input type="checkbox" data-testid="skin-preload-all" checked=${everyOutfit}
      disabled=${disabled || !on} onChange=${(e) => onAll?.(e.currentTarget.checked)} />${t('全部皮肤（{total} 套）', { total: skins.length })}</label>
    <p class="resource-card__note">${t('服务器已安装 {total} 套 · 本机已缓存 {done} 套 · 共 {size}', { total: skins.length, done: cachedOutfits, size: formatBytes(totalBytes) })}</p>
    ${!on ? html`<p class="resource-card__note">${t('未预载')} · ${t('使用时按需加载')}</p>`
      : !everyOutfit && !selected.length ? html`<p class="resource-card__note">${t('还没选过皮肤：在干员调配里挑一套，这里会跟着缓存。')}</p>` : null}
  </section>`;
}

function ResourceEffects({ st, on, disabled, onChange }) {
  if (!(st.fxFiles > 0)) return null;
  const groups = st.groups.filter((g) => g.id === 'fx');
  return html`<section class=${`resource-tier resource-effects${on ? '' : ' is-off'}`}>
    <header class="resource-tier__head"><div><${MicroLabel}>04 / EFFECTS<//><h3>${t('额外特效')}</h3></div>
      <${ResourceChoice} id="fx-preload" on=${on} disabled=${disabled} onChange=${onChange}>${t('预载')}<//></header>
    <p class="resource-card__description">${t('官方战斗特效素材；是否显示仍跟随画质设置。')}</p>
    <${ResourceProgress} groups=${groups} />
    <p class="resource-card__note">${on ? t('提前缓存，减少战斗中首次加载。') : t('未预载') + ' · ' + t('使用时按需加载')}</p>
  </section>`;
}

/** Mounted once in main.js, above all screens including the settings modal. */
export function ResourceHost({ enabled, optional, voices = optional, allVoices, voiceLang = 'cn', skinPreload, skinPreloadAll, fxPreload,
  onVoiceLang, onChange, onOptional, onVoices = onOptional, onAllVoices, onSkinPreload, onSkinPreloadAll, onFxPreload, onPreset }) {
  const { open } = useStore((s) => s, Object.is, resourceUi);
  const st = useResources();
  const fileInput = useRef(null);
  useEffect(() => { if (open) void inspectResources().catch(() => {}); }, [open]);
  const archiveBusy = !!st.archive || !!st.clearing;
  // Which card the export writes (必备 / 语音 / 时装 / 特效): one package per card keeps a single blob — and the
  // 2 GiB package limit — within what a phone holds. Defaults to the first card that actually has bytes.
  const scopes = st.scopes || [];
  const [exportScope, setExportScope] = useState('');
  const chosenScope = scopes.find((s) => s.id === exportScope && s.cached) || scopes.find((s) => s.cached) || null;
  const preferences = { preloadOptional: !!optional, preloadVoices: !!voices, preloadAllVoices: !!allVoices,
    preloadSkins: !!skinPreload, preloadSkinsAll: !!skinPreloadAll, preloadFx: !!fxPreload };
  const pause = () => { pauseResources(); if (!archiveBusy) onChange(false); };
  const importFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try { await importResources(file, { onImported: () => onChange(true) }); } catch { /* controller displays the error */ }
  };
  const clearOptional = async () => {
    const result = await clearResources({ optionalOnly: true });
    if (!result?.busy && !result?.error) {
      // Clearing every optional set also deselects every optional set; a subsequent settings change must not refill it.
      if (onPreset) onPreset(RESOURCE_PRESETS.essential);
      else { onOptional(false); onVoices?.(false); onSkinPreload?.(false); onFxPreload?.(false); }
    }
  };
  const clearAll = async () => {
    const result = await clearResources();
    if (!result?.busy && !result?.error) onChange(false);
  };
  const exportFile = async () => {
    try {
      const scope = chosenScope?.id;
      const { blob, version } = await exportResources(scope);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stronghold-resources${scope ? `-${scope}` : ''}-${version.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* controller displays the error */ }
  };
  return html`<${Modal} open=${open} onClose=${closeResources} title=${t('预载资源管理')} micro="RESOURCE MANAGER" class="resource-modal" utility=${true}
    actions=${html`
      ${enabled ? html`<span class="resource-footer__hint">${t('关闭面板后，下载仍会在后台继续。')}</span>` : null}
      ${busy(st) ? html`<${Button} variant="secondary" icon="hourglass" disabled=${st.clearing} onClick=${pause}>${st.clearing ? t('正在清理') : archiveBusy ? t('取消处理') : t('暂停下载')}<//>`
        : html`<${Button} variant="primary" icon="play" disabled=${!st.supported || st.clearing}
          onClick=${() => enabled ? startResources() : onChange(true)}>${st.error ? t('重试') : st.selectionComplete ? t('检查资源') : enabled ? t('继续下载') : t('开始预载')}<//>`}
      <${Button} variant="secondary" onClick=${closeResources}>${t('关闭')}<//>`}>
    <div class="resource-manager">
      <${ResourceScope} st=${st} enabled=${enabled} disabled=${archiveBusy} preferences=${preferences} onPreset=${onPreset} />
      <div class="resource-manager__tiers">
        <${ResourceTier} st=${st} tier=${1} optional=${!!optional} disabled=${archiveBusy} onOptional=${onOptional} />
        <${ResourceTier} st=${st} tier=${2} voices=${!!voices} disabled=${archiveBusy} onVoices=${onVoices}
          voiceLang=${voiceLang} allVoices=${allVoices} onVoiceLang=${onVoiceLang} onAllVoices=${onAllVoices} />
        <${ResourceSkins} st=${st} on=${!!skinPreload} all=${!!skinPreloadAll} disabled=${archiveBusy}
          onSkin=${onSkinPreload} onAll=${onSkinPreloadAll} />
        <${ResourceEffects} st=${st} on=${!!fxPreload} disabled=${archiveBusy} onChange=${onFxPreload} />
      </div>
      ${st.combat && enabled ? html`<p class="resource-manager__intro">${t('作战中：画面资源低速预载，语音等可选资源将在作战结束后继续。')}</p>` : null}
      <p class=${`resource-manager__status${st.error ? ' is-error' : ''}`} role="status" aria-live="polite">
        ${st.message || (enabled ? t('预载已开启') : t('选择下载范围，然后开始预载；也可以直接导入资源包。'))}</p>
      ${st.worker ? html`<p class="resource-manager__warn">${st.worker}</p>` : null}
      ${st.failed ? html`<p class="resource-manager__warn">${t('{failed} 个文件下载失败，继续下载时重试。', { failed: st.failed })}</p>` : null}
      ${st.skipped ? html`<p class="resource-manager__warn">${t('{skipped} 个文件超过单文件缓存上限，使用时按需加载。', { skipped: st.skipped })}</p>` : null}
      ${st.failures?.length ? html`<details class="resource-manager__failures"><summary>${t('查看下载失败详情')}</summary>
        <ul>${st.failures.map((failure) => html`<li>${new URL(failure.url, window.location.href).pathname} — ${failure.message}</li>`)}</ul>
      </details>` : null}
      <details class="resource-archive" open=${!!st.archive || !!st.archiveResult}>
        <summary>${t('ZIP 资源包')}<span>${t('导入、导出与下载')}</span></summary>
        <div class="resource-archive__toolbar">
          <h3>${t('ZIP 资源包')}</h3>
          <div class="res-actions">
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported} onClick=${() => fileInput.current?.click()}>${t('导入 ZIP')}<//>
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported || !st.done} onClick=${exportFile}>${t('导出 ZIP')}<//>
            <${Button} variant="secondary" size="sm" icon="link"
              onClick=${() => window.open(RESOURCE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')}>${t('前往下载')}<//>
          </div>
        </div>
        <div class="resource-archive__scope">
          <span class="resource-archive__scope-label">${t('导出范围')}</span>
          <div class="resource-presets" role="group" aria-label=${t('导出范围')}>
            ${scopes.map((s) => html`<button type="button" key=${s.id} aria-pressed=${chosenScope?.id === s.id}
              disabled=${archiveBusy || !s.cached} onClick=${() => setExportScope(s.id)}>${scopeText(s.id)}</button>`)}
          </div>
          <span class="resource-archive__scope-size num">${chosenScope ? t('{n} 个文件 · {size}', { n: chosenScope.cached, size: formatBytes(chosenScope.bytes) }) : t('尚未缓存任何资源')}</span>
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
      </details>
      ${st.storage?.low ? html`<p class="resource-manager__warn">${t('预计可用空间可能不足。可先清理可选资源；浏览器仍可能因存储限制而停止处理，已保存进度会保留。')}</p>` : null}
      ${st.persistence && st.persistence.supported && !st.persistence.granted ? html`<p class="resource-manager__warn">${t('浏览器未授予持久化存储：空间紧张时可能自动清理已预载的资源。')}</p>` : null}
      <details class="resource-cache">
        <summary><span class="resource-cache__title">${t('缓存清理')}</span><span class="resource-cache__storage">${storageText(st.storage)}</span></summary>
        <div class="resource-cache__body">
          <p>${t('只清理本站预载资源，保留个人设置。清理全部资源后暂停下载。')}</p>
          <div class="res-actions">
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported} onClick=${clearOptional}>${t('清理可选资源')}<//>
            <${Button} variant="secondary" size="sm" disabled=${archiveBusy || !st.supported} onClick=${clearAll}>${t('清理全部资源')}<//>
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
