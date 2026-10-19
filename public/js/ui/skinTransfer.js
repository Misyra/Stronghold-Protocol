// public/js/ui/skinTransfer.js — 皮肤配置 as a file of its own.
//
// A 调配 export carries the 皮肤 choices inside the operator entries (ui/loadoutModel.js), which is right for a backup
// of a loadout and wrong for the one thing players actually do with them: carry their picks to another server. That
// file also names skills, modules and 潜能, so reading it costs the receiving install its own loadout, and a file of
// skins alone was refused outright (`里面没有有效的调配条目`). This module is the standalone envelope: one JSON,
// `kind: 'stronghold.skins'`, two maps and nothing else — no skill, no module, no 潜能, no roster.
//
// The envelope is deliberately dumb: it does not know which chess ids this install has, and does not resolve a skin
// against the catalogue. An id this build has never heard of is carried through and simply draws nothing
// (`assets.js spineEntry` returns null for it), which is exactly what makes the file portable between servers whose
// plugin sets differ. The keys are what `ui/skins.js` stores: `{ [chessId]: skinId }` for the battle model and the
// 商店立绘 (`sp.pref.skins` / `sp.pref.skinPortraits`), 自选 slot ids included — a slot's choice is keyed by the slot.

import { t } from '../../../shared/i18n.js';

/** `kind` of a standalone skin-config envelope. Distinct from ui/loadoutModel.js `stronghold.loadout` on purpose: the
 *  two files must never be read as each other (neither parser accepts the other's kind). */
export const SKIN_EXPORT_KIND = 'stronghold.skins';

/** Envelope version. A reader refuses a HIGHER one instead of guessing. */
export const SKIN_TRANSFER_VERSION = 1;

/** A pasted payload / picked file longer than this is refused before parsing (a real one is a few KB). */
export const SKIN_IMPORT_MAX_BYTES = 64 * 1024;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
// a chess / slot id, same shape ui/loadoutModel.js parseStored enforces; `UNSAFE_IDS` there too, so a foreign file can
// never patch a prototype through the store
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const isId = (id) => !UNSAFE_IDS.has(id) && /^[A-Za-z0-9_\-.:]{1,64}$/.test(id);

/** `{ [chessId]: skinId }` with anything that is not a non-empty string dropped (a blank is 'no choice', not a value). */
function cleanMap(m) {
  const out = {};
  if (!isObj(m)) return out;
  for (const [chessId, skinId] of Object.entries(m)) {
    if (isId(chessId) && typeof skinId === 'string' && skinId) out[chessId] = skinId;
  }
  return out;
}

/**
 * The whole 皮肤 selection as one portable object.
 * @param {{ skins?: Record<string, string>, portraits?: Record<string, string> }} [maps] `skinsStore.get().entries` /
 *   `.portraits` — all keys, roster chess ids and 自选 slot ids alike (the file is about skins, not about a screen)
 * @param {{ now?: number }} [o]
 */
export function skinConfig(maps = {}, { now = Date.now() } = {}) {
  const skins = cleanMap(maps.skins);
  const portraits = cleanMap(maps.portraits);
  // one operator with both rows chosen counts once, which is why this is a set and not two lengths
  const operators = new Set([...Object.keys(skins), ...Object.keys(portraits)]);
  return {
    kind: SKIN_EXPORT_KIND,
    v: SKIN_TRANSFER_VERSION,
    exportedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    count: operators.size,
    skins,
    portraits,
  };
}

/** Pretty JSON of `skinConfig` — one file / clipboard payload. */
export function serializeSkinConfig(maps, opts) {
  return JSON.stringify(skinConfig(maps, opts), null, 2);
}

/**
 * Parse a skin-config file. Strict about the envelope (a 调配 file, a stored `sp.pref.skins` map or any other JSON is
 * refused with a reason) and structural about the values — see the header: unknown ids are the point, not an error.
 * @param {any} input payload object or serialised text
 * @returns {{ ok: true, skins: Record<string, string>, portraits: Record<string, string>, count: number }
 *   | { ok: false, error: string, params?: Record<string, any> }}
 */
export function parseSkinConfig(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > SKIN_IMPORT_MAX_BYTES) return { ok: false, error: t('内容过长，无法导入') };
    const text = raw.trim();
    if (!text) return { ok: false, error: t('没有可导入的内容') };
    try { raw = JSON.parse(text); } catch { return { ok: false, error: t('无法识别的内容') }; }
  }
  if (!isObj(raw)) return { ok: false, error: t('无法识别的格式') };
  const v = isInt(raw.v) ? raw.v : null;
  if (v != null && v > SKIN_TRANSFER_VERSION) {
    return { ok: false, error: t('这份皮肤配置来自更新的版本（v{v}），请先更新游戏', { v }) };
  }
  const kind = typeof raw.kind === 'string' ? raw.kind : null;
  if (kind && kind !== SKIN_EXPORT_KIND) return { ok: false, error: t('这不是皮肤配置的数据') };
  const skins = cleanMap(raw.skins);
  const portraits = cleanMap(raw.portraits);
  const count = new Set([...Object.keys(skins), ...Object.keys(portraits)]).size;
  // a file with the right envelope and nothing in it would silently wipe the selection on import: refuse it instead
  if (!count) return { ok: false, error: t('里面没有皮肤选择') };
  return { ok: true, skins, portraits, count };
}
