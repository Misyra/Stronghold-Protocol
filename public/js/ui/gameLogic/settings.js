// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { VOICE_LANGS, sanitizeVoiceOverrides } from '../../voicePrefs.js';
export { VOICE_LANGS } from '../../voicePrefs.js';

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';
import { normalizeFrameRate } from '../../frameRate.js';
import { SKIN_KEY_RE } from '../../resources/common.js';

/** The 干员皮肤 preload modes (设置 ▸ 预载资源; docs/SKINS.md): off, the picked `preloadSkinIds`, or every skin. */
export const PRELOAD_SKIN_MODES = Object.freeze(['off', 'all', 'picked']);
/** A hand-edited settings blob cannot make the preload chase thousands of ids; the catalogue has 273 skins today. */
const MAX_SKIN_IDS = 400;

/** The chosen 干员皮肤 keys (`charId/skinId`), deduplicated and validated against what the manifest can carry. */
function sanitizeSkinIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    if (typeof id === 'string' && SKIN_KEY_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_SKIN_IDS) break;
  }
  return out;
}


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * The operator voice dubs (settings 语音语言): 'cn' 中文 (`audio.voice`, the default) and 'jp' 日本語 (`audio.voiceJp`,
 * falling back to the Chinese line it lacks — public/js/audio.js voiceLine). Not tied to the interface language.
 */


/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). voiceLang: VOICE_LANGS.
 *  textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js applyTextSize).
 *  officialDamageNumbers: show only the numbers the official game shows (upstream 0.2.5, default off).
 *  ammoCount: 设置「弹药数量」 — the rounds left / the magazine under an ammo skill's bar (render/units.js; PR #552), off
 *  by default: the official HUD has no such number (the maintainer's decision of 2026-10-13).
 *  fpsLimit: the render cap 0|30|60|120 (frameRate.js FRAME_RATES; 0 = uncapped, display only). */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', voiceOverrides: Object.freeze({}), muted: false, damageNumbers: true, officialDamageNumbers: false, ammoCount: false, quality: 'high', fpsLimit: 0, textSize: 'sm', preload: false, preloadOptional: true, preloadAllVoices: false, preloadSkins: 'off', preloadSkinIds: Object.freeze([]), keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp', voiceOverrides: Record<string, string>, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoCount: boolean, quality: 'high'|'medium'|'low', fpsLimit: 0|30|60|120,
 *   preload: boolean, preloadOptional: boolean, preloadAllVoices: boolean, preloadSkins: 'off'|'all'|'picked',
 *   preloadSkinIds: string[], textSize: 'sm'|'md'|'lg'|'xl', keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceOverrides: sanitizeVoiceOverrides(r.voiceOverrides),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoCount: typeof r.ammoCount === 'boolean' ? r.ammoCount : DEFAULT_SETTINGS.ammoCount,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    fpsLimit: normalizeFrameRate(r.fpsLimit),
    preload: r.preload === true,
    preloadOptional: typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadOptional,
    preloadAllVoices: r.preloadAllVoices === true,
    preloadSkins: PRELOAD_SKIN_MODES.includes(r.preloadSkins) ? r.preloadSkins : DEFAULT_SETTINGS.preloadSkins,
    preloadSkinIds: sanitizeSkinIds(r.preloadSkinIds),
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    keys: sanitizeHotkeys(r.keys),
  };
}
