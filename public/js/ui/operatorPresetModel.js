// public/js/ui/operatorPresetModel.js — 干员预设 (operator preset) as one portable file.
//
// 把一个玩家对干员的全部配置打包成一份可导入导出的 JSON 预设 (参考 Stardust fork 的同名模型
// public/js/ui/operatorPresetModel.js, 按本仓自己的存储模型重组):
//   * 玩法配置 — 技能 / 模组选择 (ui/loadoutModel.js v2, by operator: `byChar`)、潜能 / 练度 (`ops`, 0.2.2)、
//     干员持有 (ui/ownershipModel.js v2: `notOwnedChars`)、自选编队 (ui/diyModel.js: `diy`);
//   * 展示配置 — 皮肤 / 商店立绘 (ui/skins.js 的 `entries` / `portraits` 双轨原表, 棋子 id 与自选槽 id 为键)。
// 每一部分沿用本仓各模型自己的解析器与校验器 (parseStored* / clean* / sanitize*), 本模块只负责信封: kind + v 版本化、
// 字节数上限、把各段分发给对应的模型, 并在动任何 store 之前整体验证 (prepareOperatorPreset — 一段不可用即整体拒绝,
// 不做任何改动)。
//
// 兼容 (参考 fork 的分发): 旧的单段文件 (stronghold.loadout / stronghold.ownership / stronghold.diy / stronghold.skins
// 以及更老的无 kind 形态) 也照常可被 parseOperatorPreset 接受, 按各自的解析器解析, 只更新文件包含的那一段。

import {
  parseStoredOps, parseStoredByChar, parseImport, sanitizeEntries, sanitizeOps, entriesView,
  LOADOUT_EXPORT_KIND,
} from './loadoutModel.js';
import { cleanIds, parseOwnershipImport, sanitizeNotOwned, notOwnedView, OWNERSHIP_EXPORT_KIND } from './ownershipModel.js';
import { cleanPicks, parseDiyImport, sanitizeDiyPicks, DIY_EXPORT_KIND } from './diyModel.js';
import { parseSkinConfig, SKIN_EXPORT_KIND } from './skinTransfer.js';
import { checkLoadout, checkLoadoutOps, cultivationCharIds } from '../../../shared/protocol.js';
import { N_ } from '../../../shared/i18n.js';

/** `kind` of an exported operator preset envelope. */
export const OPERATOR_PRESET_KIND = 'stronghold.operator-preset';

/** Envelope version. A reader refuses a HIGHER one instead of guessing. */
export const OPERATOR_PRESET_VERSION = 1;

/** A pasted payload / picked file longer than this is refused before parsing (a real preset is a few KB). */
export const OPERATOR_PRESET_MAX_BYTES = 256 * 1024;

/** The sections a complete preset carries, all required: a partial file is a legacy one, not a broken preset. */
const SECTIONS = ['byChar', 'ops', 'notOwnedChars', 'diy', 'skins', 'portraits'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
const fail = (error, params) => ({ ok: false, error, ...(params ? { params } : {}) });
/** id keys a parsed map must never inject (ui/loadoutModel.js parseStored's rule). */
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

/**
 * Structural clean of an imported 皮肤 / 商店立绘 map — the same shape ui/loadoutModel.js cleanSkinsRaw enforces
 * (duplicated here to keep this module dependency-free, as there): bounded charset keys, never a prototype key. A value
 * this build does not know simply draws nothing (ui/skins.js), which is what makes the file portable.
 * @param {any} raw
 * @returns {Record<string, string>}
 */
function cleanSkinsRaw(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (typeof id === 'string' && !UNSAFE_IDS.has(id) && ID_RE.test(id) && typeof v === 'string' && v) out[id] = v;
  }
  return out;
}

/**
 * Portable payload of a player's operator settings, as downloaded / copied by 导出 — every section through its own
 * model's structural clean, so the file is exactly what a parse round-trips.
 * @param {{ byChar?: Record<string, any>, ops?: Record<string, any>, notOwnedChars?: string[],
 *   diy?: Record<string, any>, skins?: Record<string, string>, portraits?: Record<string, string> }} state
 *   the stores' fields (loadoutStore byChar / ops / notOwnedChars / diy, skinsStore entries / portraits)
 * @param {{ now?: number }} [o]
 */
export function operatorPresetPayload(state, { now = Date.now() } = {}) {
  return {
    kind: OPERATOR_PRESET_KIND,
    v: OPERATOR_PRESET_VERSION,
    exportedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    byChar: parseStoredByChar({ v: 2, byChar: state?.byChar }),
    ops: parseStoredOps({ ops: state?.ops }),
    notOwnedChars: cleanIds(state?.notOwnedChars),
    diy: cleanPicks(state?.diy),
    skins: cleanSkinsRaw(state?.skins),
    portraits: cleanSkinsRaw(state?.portraits),
  };
}

/** Pretty JSON of `operatorPresetPayload` — one preset per file / clipboard payload. */
export const serializeOperatorPreset = (state, opts) => JSON.stringify(operatorPresetPayload(state, opts), null, 2);

/**
 * Parse an imported preset. Strict about the envelope (a stats export or any other kind is refused with a reason) and
 * delegating about the values: a complete preset is carried as-is (STRUCTURAL validation only — prepareOperatorPreset
 * sanitises every section against the loaded data before a store is touched), a legacy single-section file goes through
 * its own model's parser and keeps that parser's semantics.
 * @param {any} input payload object or serialised text
 * @returns {{ ok: true, scope: 'all'|'loadout'|'notOwned'|'diy'|'skins', patch: Record<string, any> }
 *   | { ok: false, error: string, params?: Record<string, any> }}
 */
export function parseOperatorPreset(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).length > OPERATOR_PRESET_MAX_BYTES) return fail(N_('内容过长，无法导入'));
    const text = raw.trim();
    if (!text) return fail(N_('没有可导入的内容'));
    try { raw = JSON.parse(text); } catch { return fail(N_('无法识别的内容')); }
  }
  if (isObj(raw) && raw.kind === OPERATOR_PRESET_KIND) {
    if (Number.isInteger(raw.v) && raw.v > OPERATOR_PRESET_VERSION) return fail(N_('这份预设来自更新的版本，请先更新游戏'));
    if (raw.v !== OPERATOR_PRESET_VERSION || !SECTIONS.every((k) => own(raw, k))
      || !isObj(raw.byChar) || !isObj(raw.ops) || !Array.isArray(raw.notOwnedChars)
      || !isObj(raw.diy) || !isObj(raw.skins) || !isObj(raw.portraits)) {
      return fail(N_('完整预设缺少配置项或格式无效，未做任何改动'));
    }
    return { ok: true, scope: 'all', patch: { byChar: raw.byChar, ops: raw.ops, notOwnedChars: raw.notOwnedChars, diy: raw.diy, skins: raw.skins, portraits: raw.portraits } };
  }
  // 旧的单段文件 (兼容分发, 参考 fork): 只更新它们原本对应的那一段 — 每个解析器保持自己的语义与上限。
  const kind = isObj(raw) ? (typeof raw.kind === 'string' ? raw.kind : null) : null;
  if (kind === SKIN_EXPORT_KIND) {
    const r = parseSkinConfig(raw);
    return r.ok ? { ok: true, scope: 'skins', patch: { skins: r.skins, portraits: r.portraits } } : r;
  }
  if (kind === DIY_EXPORT_KIND || (!kind && isObj(raw) && own(raw, 'picks'))) {
    const r = parseDiyImport(raw);
    return r.ok ? { ok: true, scope: 'diy', patch: { diy: r.picks, ...(r.skins ? { skins: r.skins } : {}), ...(r.portraits ? { portraits: r.portraits } : {}) } } : r;
  }
  if (kind === OWNERSHIP_EXPORT_KIND || Array.isArray(raw) || (!kind && isObj(raw) && own(raw, 'notOwned'))) {
    const r = parseOwnershipImport(raw);
    return r.ok ? { ok: true, scope: 'notOwned', patch: r.notOwnedChars ? { notOwnedChars: r.notOwnedChars } : { notOwned: r.notOwned } } : r;
  }
  if (!kind || kind === LOADOUT_EXPORT_KIND) {
    const r = parseImport(raw);
    return r.ok ? {
      ok: true, scope: 'loadout',
      patch: {
        ...(r.byChar ? { byChar: r.byChar } : { entries: r.entries }),
        ...(r.ops ? { ops: r.ops } : {}),
        ...(r.skins ? { skins: r.skins } : {}),
        ...(r.portraits ? { portraits: r.portraits } : {}),
      },
    } : r;
  }
  return fail(N_('这不是干员预设的数据'));
}

/**
 * Validate every included section before any store is touched — each through its own model's sanitiser, all-or-nothing:
 * a section with content the current build cannot use aborts the whole import. An explicitly empty section of a complete
 * preset restores that section's defaults; a skin id this build has never heard of is carried through (that is the
 * point of the display half, ui/skinTransfer.js).
 * @param {{ ok: true, scope: string, patch: Record<string, any> } | { ok: false, error: string }} parsed
 *   parseOperatorPreset's result (a legacy v1 loadout / ownership patch must already be in the view of the data on
 *   screen — applyOperatorPreset maps it first: ui/loadoutSync.js importedEntries / importedNotOwned)
 * @param {{ lookup?: (id: string) => any, map?: { toChess: Map<string, string> } | null,
 *   data?: { chess: any, backups: any }, kitted?: Iterable<string>|null }} deps
 *   `map`: charKeyMap of the data on screen (ui/loadoutSync.js shownCharMap); `data`: { chess, backups } as
 *   screens/diy.js diyData() gives them; `kitted`: the operators a 自选 slot may field (welcome.diyKitted)
 * @returns {{ ok: true, scope: string, patch: Record<string, any>, counts: Record<string, number>, dropped: number }
 *   | { ok: false, error: string, params?: Record<string, any> }}
 */
export function prepareOperatorPreset(parsed, { lookup, map, data, kitted } = {}) {
  if (!parsed?.ok || !isObj(parsed.patch)) return fail(N_('无法识别的格式'));
  const patch = parsed.patch;
  const out = {};
  const counts = {};
  let dropped = parsed.dropped || 0;
  const unavailable = () => fail(N_('这份预设包含当前版本不可用的配置，未做任何改动'));
  const noData = () => fail(N_('游戏数据没有载入'));
  const isOperator = () => {
    const ids = cultivationCharIds(data?.chess, data?.backups);
    return (id) => ids.has(id);
  };
  // 干员调配 (complete presets carry it by operator → the view of the data on screen; legacy v1 files arrive as `entries`)
  if (own(patch, 'byChar') || own(patch, 'entries')) {
    if (typeof lookup !== 'function') return noData();
    const byChar = own(patch, 'byChar');
    if (byChar && !map) return noData();
    const view = byChar ? entriesView(patch.byChar, map) : patch.entries;
    const asked = Object.keys(view || {}).length;
    const clean = sanitizeEntries(view, lookup);
    // nothing survived: unknown chess, or every choice illegal — but entries that are merely equal to the defaults are
    // legal (checkLoadout accepts them), so only a build that cannot use ANY of them aborts
    const legal = asked > 0 && Object.entries(view || {}).some(([id, e]) => checkLoadout({ [id]: e }, lookup).ok);
    if (asked && !Object.keys(clean).length && !legal) return unavailable();
    out.entries = clean;
    counts.entries = Object.keys(clean).length;
    dropped += Math.max(0, asked - counts.entries);
  }
  // 潜能 / 练度 (0.2.2): 自选 operators are in that list and only backups.json names them
  if (own(patch, 'ops')) {
    const asked = Object.keys(patch.ops || {}).length;
    if (asked && (data?.chess == null || data?.backups == null)) return noData();
    const clean = asked ? sanitizeOps(patch.ops, isOperator()) : {};
    const legal = asked > 0 && Object.entries(patch.ops).some(([id, value]) => checkLoadoutOps({ [id]: value }, isOperator()).ok);
    if (asked && !Object.keys(clean).length && !legal) return unavailable();
    out.ops = clean;
    counts.ops = Object.keys(clean).length;
    dropped += Math.max(0, asked - counts.ops);
  }
  // 干员持有 (complete presets by operator → the view; legacy v1 files arrive as `notOwned`)
  if (own(patch, 'notOwnedChars') || own(patch, 'notOwned')) {
    if (typeof lookup !== 'function') return noData();
    const byChar = own(patch, 'notOwnedChars');
    if (byChar && !map) return noData();
    const view = byChar ? notOwnedView(patch.notOwnedChars, map) : patch.notOwned;
    const asked = Array.isArray(view) ? view.length : 0;
    const clean = sanitizeNotOwned(view, lookup);
    if (asked && !clean.length) return unavailable();
    out.notOwned = clean;
    counts.notOwned = clean.length;
    dropped += Math.max(0, asked - clean.length);
  }
  // 自选编队: the picks the server would keep against the loaded data and the kit list
  if (own(patch, 'diy')) {
    const asked = Object.keys(patch.diy || {}).length;
    if (asked && (data?.chess == null || data?.backups == null)) return noData();
    if (asked && kitted == null) return fail(N_('自选编队数据尚未就绪，请稍后重试'));
    const clean = asked ? sanitizeDiyPicks(patch.diy, data, kitted) : {};
    if (asked && !Object.keys(clean).length) return unavailable();
    out.diy = clean;
    counts.diy = Object.keys(clean).length;
    dropped += Math.max(0, asked - counts.diy);
  }
  // 展示配置: structural only — an unknown id draws the default model, it never aborts the import
  if (own(patch, 'skins')) out.skins = cleanSkinsRaw(patch.skins);
  if (own(patch, 'portraits')) out.portraits = cleanSkinsRaw(patch.portraits);
  if (!Object.keys(out).length) return fail(N_('无法识别的格式'));
  return { ok: true, scope: parsed.scope, patch: out, counts, dropped };
}
