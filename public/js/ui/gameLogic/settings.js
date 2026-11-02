// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { VOICE_LANGS, sanitizeVoiceOverrides } from '../../voicePrefs.js';
export { VOICE_LANGS } from '../../voicePrefs.js';
import { normalizePreloadVoiceLanguages } from '../../resources/voices.js';
import { sanitizeBgmChoice } from '../../bgmChoice.js';

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


/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). voiceLang: VOICE_LANGS.
 *  voiceNative: the 本土语言 switch (default off). textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js
 *  applyTextSize). ammoEnergyCount: 设置「显示弹药与能量数量」 — the rounds left / the magazine under an ammo skill's
 *  bar and a 秘术师's stored attack energies as stored/cap (render/units.js). One switch for the old 「弹药数量」
 *  (`ammoCount`, PR #552) and 「秘术师能量」 (`mysticEnergy`, PR #636); off by default: the official HUD has neither
 *  number. A profile that still has either old key `true` migrates to on; those keys are not written back.
 *  [ASSUMED] a stored boolean `ammoEnergyCount` wins over the old keys, so turning the merged switch off stays off.
 *  bondTimers: selected-unit timed bond readouts (#746), off by default. [ASSUMED] Convenience HUD absent from
 *  the official game; maintainer approved 2026-10-18. Stored with the other preferences in sp.pref.settings.
 *  combatMetrics: 设置「作战统计」 (PR #618), ON by default (the maintainer's 2026-11-02 change; the official HUD has
 *  no such panel, so a player can turn it off).
 *  prepDeployFold: 设置「部署时收起商店」 — picking up a piece on the own prep board folds the shop and zooms
 *  (GitHub #602, PR #646). Default OFF (the maintainer's 2026-11-02 change; it was on from 0.3.0). Off: the pickup
 *  changes neither the shop's fold nor the camera. #692 adds 'partial': keep the shop at 70%, with halfway camera
 *  offsets. [ASSUMED] this middle level. [ASSUMED] the label.
 *  officialFx: 设置「官方特效」 (0.3.0, render/vfx): 'auto' (完整 on a desktop, 精简 on a touch device — render/vfx/tier.js),
 *  'off', 'lite' (精简), 'full' (完整); only shown when effects were extracted from the local client.
 *  otherSkins: 设置「显示其他玩家的皮肤」 (docs/SKINS.md), ON by default — draw the appearance another player chose instead
 *  of the operator's own model. A pure client preference (never sent): off, only this player's own pieces wear a skin.
 *  deploySnap: 设置「部署时按格子吸附」 (Stardust fork e6bd4003), off by default: a dragged unit stands on the tile it
 *  would drop on instead of following the pointer (render/app.js moveDragVisual). A pure client preference; the drop
 *  itself is the same.
 *  preload / preloadOptional / preloadVoices / preloadAllVoices / preloadVoiceLanguages / preloadSkins /
 *  preloadSkinsAll / preloadFx (移植自用户分支): independent resource scopes of the asset preload
 *  (public/js/resources/index.js). The master stays off on first visit; voices migrate from the older
 *  optional-audio choice; `preloadVoiceLanguages` is a normalized subset of VOICE_LANGS + 'native' or null (all).
 *  bgmPrep / bgmCombat: 对局音乐 (js/bgmChoice.js) — 'official' by default; a pure client preference.
 */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', voiceNative: false, voiceOverrides: Object.freeze({}), bgmPrep: 'official', bgmCombat: 'official', muted: false, damageNumbers: true, officialDamageNumbers: false, ammoEnergyCount: false, deploySnap: false, fullscreenWakeLock: false, bondTimers: false, combatMetrics: true, prepDeployFold: false, quality: 'high', fpsLimit: 0, officialFx: 'auto', otherSkins: true, textSize: 'sm', preload: false, preloadOptional: true, preloadVoices: true, preloadAllVoices: false, preloadVoiceLanguages: null, preloadSkins: true, preloadSkinsAll: false, preloadFx: true, keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];
/** The values of 设置「官方特效」 (render/vfx/tier.js OFFICIAL_FX). Display order in the dialog is low / medium / high. */
export const OFFICIAL_FX_MODES = Object.freeze(['auto', 'off', 'lite', 'full']);

/**
 * The merged 显示弹药与能量数量 switch. A stored boolean wins. Otherwise on when either retired key was the boolean
 * true (`ammoCount` PR #552, `mysticEnergy` PR #636). Junk and a missing key stay off.
 * [ASSUMED] the new boolean wins, so a leftover old key cannot turn the switch back on.
 * @param {Record<string, any>} r
 */
function ammoEnergyCountOf(r) {
  if (typeof r.ammoEnergyCount === 'boolean') return r.ammoEnergyCount;
  return r.ammoCount === true || r.mysticEnergy === true;
}

/**
 * Sanitize persisted settings. Retired keys `ammoCount` and `mysticEnergy` are read here and never returned.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp'|'en'|'kr', voiceNative: boolean, voiceOverrides: Record<string, string>, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoEnergyCount: boolean, fullscreenWakeLock: boolean, bondTimers: boolean, combatMetrics: boolean, prepDeployFold: boolean, quality: 'high'|'medium'|'low', fpsLimit: number, officialFx: 'auto'|'off'|'lite'|'full', otherSkins: boolean,
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
    // 对局音乐 (js/bgmChoice.js): which track 休整期 / 作战 follow — 'official', a manifest track's id, or 'custom'
    bgmPrep: sanitizeBgmChoice(r.bgmPrep),
    bgmCombat: sanitizeBgmChoice(r.bgmCombat),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoEnergyCount: ammoEnergyCountOf(r),
    bondTimers: r.bondTimers === true,
    combatMetrics: typeof r.combatMetrics === 'boolean' ? r.combatMetrics : DEFAULT_SETTINGS.combatMetrics,
    prepDeployFold: r.prepDeployFold === 'partial' ? 'partial' : typeof r.prepDeployFold === 'boolean' ? r.prepDeployFold : DEFAULT_SETTINGS.prepDeployFold,
    fullscreenWakeLock: typeof r.fullscreenWakeLock === 'boolean' ? r.fullscreenWakeLock : DEFAULT_SETTINGS.fullscreenWakeLock,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    fpsLimit: normalizeFrameRate(r.fpsLimit),
    officialFx: OFFICIAL_FX_MODES.includes(r.officialFx) ? r.officialFx : DEFAULT_SETTINGS.officialFx,
    otherSkins: r.otherSkins !== false,
    deploySnap: r.deploySnap === true,
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    preload: r.preload === true,
    preloadOptional: typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadOptional,
    preloadVoices: typeof r.preloadVoices === 'boolean' ? r.preloadVoices
      : typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadVoices,
    preloadAllVoices: r.preloadAllVoices === true,
    preloadVoiceLanguages: normalizePreloadVoiceLanguages(r.preloadVoiceLanguages),
    // 皮肤 and 特效 default to on (DEFAULT_SETTINGS): only the master switch starts off, so a first visit caches
    // nothing until it is turned on — a saved `false` is respected either way. (user fork)
    preloadSkins: typeof r.preloadSkins === 'boolean' ? r.preloadSkins : DEFAULT_SETTINGS.preloadSkins,
    preloadSkinsAll: r.preloadSkinsAll === true,
    preloadFx: typeof r.preloadFx === 'boolean' ? r.preloadFx : DEFAULT_SETTINGS.preloadFx,
    keys: sanitizeHotkeys(r.keys),
  };
}
