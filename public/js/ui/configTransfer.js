// public/js/ui/configTransfer.js — 统一配置导入导出入口 (统一入口; 干员预设语义参考 Stardust fork)。
//
// 本仓此前的配置导入导出散在各处: 干员调配遮罩的每个页签 (screens/loadout.js: 调配 / 干员持有 / 自选编队 / 皮肤配置)、
// 统计页 (screens/stats.js)。本模块把它们收拢成一个面板 (挂在 ui/settings.js 的设置弹窗里 —— 标题页 / 大厅 / 对局中
// 都可达, 而旧入口原样保留), 每类配置一行, 独立「导出 ↓」(下载 JSON 文件) 与「导入 ↑」(粘贴或选文件)。
//
// 每类仍由各自的模型序列化与解析 (旧格式照常可导入, 语义不变); 导入按信封 `kind` 分发到对应模型的 parser —— kind
// 未知明确报错, 绝不落到别的 parser 上。干员预设 (ui/operatorPresetModel.js, kind 'stronghold.operator-preset') 是
// 把玩法配置 + 展示配置打包在一起的新总纲格式。统计数据 (ui/stats.js, kind 'local-stats') 沿用它的纯函数
// importStats / exportStats, 不改其逻辑。

import { useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel } from './components.js';
import { data } from '../data.js';
import { loadoutStore, applyOperatorPreset } from './loadoutSync.js';
import { skinsStore } from './skins.js';
import { serializeExport, LOADOUT_EXPORT_KIND, LOADOUT_IMPORT_MAX_BYTES } from './loadoutModel.js';
import { serializeOwnership, OWNERSHIP_EXPORT_KIND, OWNERSHIP_IMPORT_MAX_BYTES } from './ownershipModel.js';
import { serializeDiy, DIY_EXPORT_KIND, DIY_IMPORT_MAX_BYTES } from './diyModel.js';
import { serializeSkinConfig, SKIN_EXPORT_KIND, SKIN_IMPORT_MAX_BYTES } from './skinTransfer.js';
import { diySlotIds } from '../../../shared/diy.js';
import { serializeOperatorPreset, parseOperatorPreset, OPERATOR_PRESET_KIND, OPERATOR_PRESET_MAX_BYTES } from './operatorPresetModel.js';
import { exportStats, importStats, loadStats, saveStats, IMPORT_MAX_CHARS } from './stats.js';
import { t, N_ } from '../../../shared/i18n.js';
import { toast } from './toasts.js';

/** The stats envelope's `kind` (ui/stats.js exportStats; no constant exported there). */
const STATS_EXPORT_KIND = 'local-stats';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The kinds the panel offers, in display order. `file` names the download, `maxBytes` refuses a picked file before it
 * is read into memory (the parsers enforce their own limits on pasted text).
 */
export const CONFIG_KINDS = [
  {
    id: 'operator-preset', kind: OPERATOR_PRESET_KIND, micro: 'OPERATOR PRESET', file: 'operator-preset',
    label: N_('干员预设'), maxBytes: OPERATOR_PRESET_MAX_BYTES,
    hint: N_('全部玩法配置（技能 / 模组、潜能 / 练度、干员持有、自选编队）与皮肤 / 商店立绘选择打包为一份预设，在别的服务器或浏览器上一次导入。'),
  },
  {
    id: 'loadout', kind: LOADOUT_EXPORT_KIND, micro: 'LOADOUT', file: 'loadout',
    label: N_('干员调配'), maxBytes: LOADOUT_IMPORT_MAX_BYTES,
    hint: N_('每名干员的技能 / 模组与潜能 / 练度选择（皮肤选择随文件携带）。'),
  },
  {
    id: 'ownership', kind: OWNERSHIP_EXPORT_KIND, micro: 'OWNERSHIP', file: 'ownership',
    label: N_('干员持有'), maxBytes: OWNERSHIP_IMPORT_MAX_BYTES,
    hint: N_('标记为未持有的干员名单。'),
  },
  {
    id: 'diy', kind: DIY_EXPORT_KIND, micro: 'CUSTOM SQUAD', file: 'diy',
    label: N_('自选编队'), maxBytes: DIY_IMPORT_MAX_BYTES,
    hint: N_('四个自选名额的甄选与槽位的皮肤 / 商店立绘选择。'),
  },
  {
    id: 'skins', kind: SKIN_EXPORT_KIND, micro: 'SKINS', file: 'skins',
    label: N_('皮肤配置'), maxBytes: SKIN_IMPORT_MAX_BYTES,
    hint: N_('战斗模型与商店立绘的皮肤选择（跨服务器携带，不涉及调配）。'),
  },
  {
    id: 'stats', kind: STATS_EXPORT_KIND, micro: 'STATS', file: 'stats',
    label: N_('统计数据'), maxBytes: IMPORT_MAX_CHARS,
    hint: N_('本机的对局记录备份（与统计页的导出 / 导入相同，两处入口都能用）。'),
  },
];

const slotIdsOf = () => { try { return new Set(diySlotIds({ chess: data.get('chess'), backups: data.get('backups') })); } catch { return new Set(); } };
const skinPart = (map, slots, wantSlots) => Object.fromEntries(Object.entries(map || {}).filter(([id]) => slots.has(id) === wantSlots));

/**
 * The export text of one kind, from the live stores — every envelope its model has always written (a 调配 export
 * carries the roster's 皮肤, a 自选 export the slots', exactly like the 干员调配 dialog's).
 * @param {string} id a CONFIG_KINDS id
 * @param {{ now?: number }} [o]
 * @returns {string|null} null for an unknown id
 */
export function exportConfigText(id, { now = Date.now() } = {}) {
  const st = loadoutStore.get();
  const skins = skinsStore.get();
  const slots = slotIdsOf();
  switch (id) {
    case 'operator-preset':
      return serializeOperatorPreset({
        byChar: st.byChar || {}, ops: st.ops || {}, notOwnedChars: st.notOwnedChars || [],
        diy: st.diy || {}, skins: skins.entries || {}, portraits: skins.portraits || {},
      }, { now });
    case 'loadout':
      return serializeExport(st.byChar || {}, { now, ops: st.ops || {},
        skins: skinPart(skins.entries, slots, false), portraits: skinPart(skins.portraits, slots, false) });
    case 'ownership':
      return serializeOwnership(st.notOwnedChars || [], { now });
    case 'diy':
      return serializeDiy(st.diy || {}, { now, version: st.diyVersion,
        skins: skinPart(skins.entries, slots, true), portraits: skinPart(skins.portraits, slots, true) });
    case 'skins':
      return serializeSkinConfig({ skins: skins.entries || {}, portraits: skins.portraits || {} }, { now });
    case 'stats':
      return JSON.stringify(exportStats(loadStats()), null, 2);
    default:
      return null;
  }
}

/**
 * Parse an imported payload by its envelope `kind`, dispatching to the owning model's parser. A kind this module does
 * not know is an explicit error — it must never fall through to another parser. A payload without a `kind` (the older
 * bare shapes: an id array, a `{ picks }` / `{ entries }` map …) is sniffed by the preset parser's legacy dispatch.
 * @param {any} input payload object or serialised text
 * @returns {{ ok: true, id: string, parsed: object, raw?: any } | { ok: false, error: string, params?: object }}
 *   `id`: the CONFIG_KINDS id the payload routes to; `parsed`: that model's parse result (stats: the raw doc as `raw`)
 */
export function parseConfigPayload(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: false, error: N_('没有可导入的内容') };
    try { raw = JSON.parse(raw); } catch { return { ok: false, error: N_('无法识别的内容') }; }
  }
  if (!isObj(raw) && !Array.isArray(raw)) return { ok: false, error: N_('无法识别的格式') };
  const kind = isObj(raw) && typeof raw.kind === 'string' ? raw.kind : null;
  if (kind === STATS_EXPORT_KIND) return { ok: true, id: 'stats', parsed: { ok: true, scope: 'stats', patch: {}, raw }, raw };
  if (kind && !CONFIG_KINDS.some((c) => c.kind === kind)) {
    return { ok: false, error: N_('无法识别的配置类型（{kind}），未做任何改动'), params: { kind } };
  }
  // stronghold.* 与无 kind 的旧形态统一走预设的分发 (ui/operatorPresetModel.js), 它按 kind / 形状调对应模型的 parser
  const parsed = parseOperatorPreset(raw);
  if (!parsed.ok) return parsed;
  const id = parsed.scope === 'notOwned' ? 'ownership' : parsed.scope === 'all' ? 'operator-preset' : parsed.scope;
  return { ok: true, id, parsed, raw };
}

/**
 * Why an import cannot run now — the game data the sanitisers check against is missing (the rule of
 * screens/loadout.js importRefusal, GitHub #173: sanitising against absent data would wipe the saved settings) — or
 * null. 皮肤 and 统计 need no game data.
 * @param {string} id a CONFIG_KINDS id
 * @param {(name: string) => string} [status] the data store's status (data.status)
 * @returns {{ text: string, tone: 'warn'|'error' } | null}
 */
export function configImportRefusal(id, status = data.status) {
  if (id === 'skins' || id === 'stats') return null;
  const files = id === 'operator-preset' || id === 'diy' ? ['chess', 'backups'] : ['chess'];
  if (files.some((name) => status(name) === 'missing')) {
    return { text: N_('导入失败：游戏数据没有载入，未做任何改动。请刷新页面；仍不行时，请检查广告拦截插件和网络'), tone: 'error' };
  }
  return null;
}

/**
 * Import a stats export (the pure ui/stats.js merge, unchanged logic): dedupe against the current records, persist.
 * @param {any} raw the parsed JSON document
 * @returns {{ ok: true, added: number, skipped: number, dropped: number } | { ok: false, error: string }}
 */
export function importStatsPayload(raw) {
  try {
    const { stats, added, skipped, dropped } = importStats(raw, loadStats());
    if (added && !saveStats(stats)) return { ok: false, error: N_('无法写入本机存储，可能已满') };
    return { ok: true, added, skipped, dropped };
  } catch (err) {
    // the same two refusals the 统计数据 page shows (screens/stats.js)
    return { ok: false, error: err?.code === 'stats-newer-version'
      ? N_('导入失败：这份文件由更新版本的客户端导出，请先升级客户端')
      : N_('导入失败：不是有效的统计导出文件') };
  }
}

/**
 * Apply a parsed payload of any kind. Everything stronghold.* funnels through applyOperatorPreset
 * (ui/loadoutSync.js — the preset model dispatches the legacy kinds, all-or-nothing validated); stats takes its own
 * path. Call configImportRefusal FIRST: the game data must be on the page before anything is sanitised.
 * @param {string} id a CONFIG_KINDS id @param {object} parsed parseConfigPayload's `parsed`
 * @param {{ lookup?: (id: string) => any, data?: { chess: any, backups: any }, kitted?: Iterable<string>|null }} [deps]
 */
export function applyConfig(id, parsed, deps = {}) {
  if (id === 'stats') return importStatsPayload(parsed.raw);
  return applyOperatorPreset(parsed, deps);
}

/** `stronghold-loadout-20261003-1245.json` — as the 干员调配 dialog names its downloads (screens/loadout.js). */
function exportFilename(now = new Date(), what = 'loadout') {
  const p = (n) => String(n).padStart(2, '0');
  return `stronghold-${what}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** Save `text` as a download (screens/loadout.js downloadText). Silent no-op when the browser refuses downloads. */
function downloadText(filename, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* ignore */ }
}

/** Read a picked file as text (`File.text()`, with a FileReader fallback — screens/loadout.js readFileText). */
function readFileText(file) {
  if (typeof file?.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsText(file);
  });
}

/** The deps the preset sanitisers need, from the page's data (call after the data is on the page). */
function presetDeps() {
  return {
    lookup: (id) => data.lookup('chess', id),
    data: { chess: data.get('chess'), backups: data.get('backups') },
    kitted: loadoutStore.get().diyKitted,
  };
}

/**
 * The 统一配置导入导出 section of the settings modal (ui/settings.js SettingsModal): one row per CONFIG_KINDS entry,
 * 「导出」downloads the file, 「导入」opens an inline editor (paste or pick a file) whose payload is dispatched by its
 * own `kind` — the row only decides what EXPORT writes. Textarea styled after the 干员调配 dialog's
 * (css/screens/loadout.css .lo-io__text); the section's styles live in css/screens/game.css beside the other .set-*.
 */
export function ConfigTransferSection() {
  const [openId, setOpenId] = useState(null); // the row whose import editor is open
  const [text, setText] = useState('');
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setOpenId(null); setText(''); };
  const openImport = (item) => { setOpenId(openId === item.id ? null : item.id); setText(''); };
  const doExport = (item) => {
    const textOut = exportConfigText(item.id);
    if (textOut == null) return;
    downloadText(exportFilename(new Date(), item.file), textOut);
    toast(t('已导出到下载文件夹'), 'success');
  };
  const pickFile = () => fileRef.current?.click();
  const onFile = async (e, item) => {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = ''; // picking the same file twice must fire again
    if (!f) return;
    if (f.size > item.maxBytes) { toast(t('文件过大，请选择「导出」下载的配置文件'), 'error'); return; }
    try { setText(await readFileText(f)); } catch { toast(t('读取文件失败'), 'error'); }
  };
  const doApply = async (item) => {
    if (busy) return;
    setBusy(true);
    try {
      const refused = configImportRefusal(item.id);
      if (refused) { toast(t(refused.text), refused.tone); return; }
      const r = parseConfigPayload(text);
      if (!r.ok) { toast(t('导入失败：{error}', { error: t(r.error, r.params) }), 'error'); return; }
      // the sanitisers need the game data on the page: load it now (an explicit import justifies the download;
      // 皮肤 / 统计 need none) — a file that never arrived still refuses, the saved settings untouched
      if (r.id !== 'skins' && r.id !== 'stats') {
        await data.load('chess');
        if (r.id === 'operator-preset' || r.id === 'diy') await data.load('backups');
        const late = configImportRefusal(r.id);
        if (late) { toast(t(late.text), late.tone); return; }
      }
      if (r.id === 'stats') {
        const s = importStatsPayload(r.raw);
        if (!s.ok) { toast(t(s.error), 'error'); return; }
        close();
        // the 统计数据 page's own wording (screens/stats.js doFile)
        const tail = (s.skipped ? t('（跳过重复 {skipped} 条）', { skipped: s.skipped }) : '')
          + (s.dropped ? t('（{n} 条无法读取）', { n: s.dropped }) : '');
        toast(s.added ? t('已导入 {added} 条记录{tail}', { added: s.added, tail }) : t('没有新记录（全部与现有数据重复）'), 'success');
        return;
      }
      const result = applyConfig(r.id, r.parsed, presetDeps());
      if (!result.ok) { toast(t('导入失败：{error}', { error: t(result.error, result.params) }), 'error'); return; }
      close();
      const done = result.scope === 'all' ? t('已导入完整干员预设') : t('已导入兼容配置，仅更新文件包含的项目');
      toast(done + (result.dropped ? t('（另有 {n} 项不可用，未导入）', { n: result.dropped }) : ''), result.dropped ? 'warn' : 'success');
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="set-cfg" aria-labelledby="set-cfg-title" data-testid="config-transfer-section">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-cfg-title">${t('配置导入导出')}<${MicroLabel}>CONFIG TRANSFER<//></span>
    </div>
    <p class="set-hint">${t('各类本机配置的备份收拢在此处，逐项导出为文件或从文件导入；干员调配界面与统计页的旧入口照常可用。')}</p>
    ${CONFIG_KINDS.map((item) => html`<div class="set-cfg__row" key=${item.id} data-testid=${`cfg-${item.id}`}>
      <span class="set-cfg__label">${t(item.label)}<${MicroLabel}>${item.micro}<//></span>
      <span class="set-cfg__actions">
        <${Button} variant="ghost" size="sm" data-testid=${`cfg-${item.id}-export`} onClick=${() => doExport(item)}
          title=${t('下载这类配置的 JSON 文件')}>${t('导出')}<//>
        <${Button} variant="ghost" size="sm" data-testid=${`cfg-${item.id}-import`} onClick=${() => openImport(item)}
          title=${t('粘贴或选择这类配置的文件导入')}>${t('导入')}<//>
      </span>
    </div>
    ${openId === item.id ? html`<div class="set-cfg__io" data-testid="cfg-io">
      <textarea class="set-cfg__text" rows=${6} spellcheck=${false}
        placeholder=${t('在此粘贴导出的配置内容，或点「选择文件」。导入按文件自身的类型分发，选错行也无妨。')}
        value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
      <span class="set-cfg__actions">
        <${Button} variant="ghost" size="sm" onClick=${pickFile}>${t('选择文件')}<//>
        <${Button} variant="primary" size="sm" disabled=${!text.trim() || busy} loading=${busy} onClick=${() => doApply(item)}>${t('导入')}<//>
        <${Button} variant="ghost" size="sm" onClick=${close}>${t('取消')}<//>
      </span>
      <input ref=${fileRef} type="file" accept="application/json,.json" class="set-cfg__file"
        onChange=${(e) => onFile(e, item)} />
    </div>` : null}
    <p class="set-hint set-cfg__hint">${t(item.hint)}</p>`)}
  </section>`;
}
