// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { VOICE_LANGS, sanitizeVoiceOverrides } from '../../voicePrefs.js';
export { VOICE_LANGS } from '../../voicePrefs.js';

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';
import { normalizeFrameRate } from '../../frameRate.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * The operator voice dubs (settings 语音语言): 'cn' 中文 (`audio.voice`, the default), 'jp' 日本語 (`audio.voiceJp`),
 * 'en' English (`audio.voiceEn`) and 'kr' 한국어 (`audio.voiceKr`), each falling back to the Chinese line it lacks
 * (public/js/audio.js voiceLine). Not tied to the interface language. `voiceNative` is the 本土语言 switch: an
 * operator who has `audio.voiceNative` speaks that dub unless their own override says otherwise.
 */

/** 显示弹药与能量数量 (0.3.1): one switch; the retired `ammoCount` / `mysticEnergy` flags are read here and never returned. */
function ammoEnergyCountOf(r) {
  if (typeof r.ammoEnergyCount === 'boolean') return r.ammoEnergyCount;
  return r.ammoCount === true || r.mysticEnergy === true;
}



/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). voiceLang: VOICE_LANGS.
 *  voiceNative: the 本土语言 switch (default off).
 *  textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js applyTextSize).
 *  officialDamageNumbers: show only the numbers the official game shows (upstream 0.2.5, default off).
 *  ammoEnergyCount: 设置「显示弹药与能量数量」 (0.3.1) — the rounds left / the magazine under an ammo skill's bar
 *  (PR #552) and a 秘术师's stored attack energies (PR #636), one switch; off by default: the official HUD has neither
 *  number (the maintainer's decisions of 2026-10-13 and 2026-10-15). A stored boolean wins over the retired keys.
 *  combatMetrics: 设置「作战统计」 (PR #618) — the local damage/healing meter. **On by default** (YG, 2026-10-16);
 *  turning it off drops the corner button and leaves the hooks unattached, so a player who wants the bare official HUD
 *  gets it back from the settings modal.
 *  prepDeployZoom: 设置「整备期拖动缩放」 — temporarily fold the shop and zoom while deploying, off by default.
 *  fpsLimit: the render cap 0|30|60|120 (frameRate.js FRAME_RATES; 0 = uncapped, display only).
 *  officialFx: 设置「官方特效」 (0.3.0, render/vfx): 'auto' (完整 on a desktop, 精简 on a touch device — render/vfx/tier.js),
 *  'off', 'lite' (精简), 'full' (完整); only shown when effects were extracted from the local client.
 *  preload / preloadOptional / preloadVoices / preloadAllVoices / preloadSkins / preloadSkinsAll / preloadFx:
 *  independent resource scopes. The master stays off on first visit. Voices migrate from the older optional-audio
 *  choice; presets change scope flags in one update and never start a paused download. */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', voiceNative: false, voiceOverrides: Object.freeze({}), muted: false, damageNumbers: true, officialDamageNumbers: false, ammoEnergyCount: false, combatMetrics: true, prepDeployZoom: false,  quality: 'high', officialFx: 'auto', fpsLimit: 0, textSize: 'sm', preload: false, preloadOptional: true, preloadVoices: true, preloadAllVoices: false, preloadSkins: true, preloadSkinsAll: false, preloadFx: true, keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];
/** The values of 设置「官方特效」 (render/vfx/tier.js OFFICIAL_FX). */
export const OFFICIAL_FX_MODES = Object.freeze(['auto', 'off', 'lite', 'full']);

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp'|'en'|'kr', voiceNative: boolean, voiceOverrides: Record<string, string>, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoEnergyCount: boolean, combatMetrics: boolean, prepDeployZoom: boolean, quality: 'high'|'medium'|'low', officialFx: 'auto'|'off'|'lite'|'full',
 *   fpsLimit: 0|30|60|120, preload: boolean, preloadOptional: boolean, preloadVoices: boolean, preloadAllVoices: boolean, preloadSkins: boolean, preloadSkinsAll: boolean, preloadFx: boolean,
 *   textSize: 'sm'|'md'|'lg'|'xl', keys: Record<'buy'|'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceNative: r.voiceNative === true,
    voiceOverrides: sanitizeVoiceOverrides(r.voiceOverrides),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoEnergyCount: ammoEnergyCountOf(r),
    combatMetrics: typeof r.combatMetrics === 'boolean' ? r.combatMetrics : DEFAULT_SETTINGS.combatMetrics,
    prepDeployZoom: r.prepDeployZoom === true,
    
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    fpsLimit: normalizeFrameRate(r.fpsLimit),
    preload: r.preload === true,
    preloadOptional: typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadOptional,
    preloadVoices: typeof r.preloadVoices === 'boolean' ? r.preloadVoices
      : typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadVoices,
    preloadAllVoices: r.preloadAllVoices === true,
    // 皮肤 and 特效 default to on (DEFAULT_SETTINGS): only the master switch starts off, so a first visit caches
    // nothing until it is turned on — a saved `false` is respected either way.
    preloadSkins: typeof r.preloadSkins === 'boolean' ? r.preloadSkins : DEFAULT_SETTINGS.preloadSkins,
    preloadSkinsAll: r.preloadSkinsAll === true,
    preloadFx: typeof r.preloadFx === 'boolean' ? r.preloadFx : DEFAULT_SETTINGS.preloadFx,
    officialFx: OFFICIAL_FX_MODES.includes(r.officialFx) ? r.officialFx : DEFAULT_SETTINGS.officialFx,
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    keys: sanitizeHotkeys(r.keys),
  };
}
