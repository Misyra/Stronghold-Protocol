// 对局音乐 (ported from the Stardust fork's bgmChoice.js; the owner's request of 2026-10-15): 休整期 and 作战 each play
// the mode's own music by default ('official': audio.js bgmKeyFor / combatTrackFor), one of the manifest's other tracks
// (`data/assets.json` `audio.bgm`), or 自选曲 — a file the player chose, kept in this browser like the 自定义大厅音乐
// (ui/lobbyMedia.js; nothing is hosted for it). The picks live in the settings `bgmPrep` / `bgmCombat` and are personal:
// other players keep their own music. 联防 / 最终攻势 / 隐秘核心 keep their own tracks.
//
// The fork also offers its 上海Major pause track; it is no official file and not in this manifest (a host had to serve it
// itself), so it is not offered here.

import { N_ } from '../../shared/i18n.js';

/** The tracks a player may pick: id, name (msgid), the track out of `audio.bgm` ({ intro?, loop }). */
export const BGM_TRACKS = Object.freeze([
  { id: 'prep', name: N_('卫戍协议 · 休整'), of: (b) => b?.prep },
  { id: 'fearless', name: N_('无畏者'), of: (b) => b?.combatAlts?.[1] },
  { id: 'knight', name: N_('骑士之日'), of: (b) => b?.combatAlts?.[0] },
  { id: 'unite', name: N_('联防'), of: (b) => b?.unite },
  { id: 'lobby', name: N_('卫戍协议 · 大厅'), of: (b) => b?.lobby },
]);

/** Every valid value of the settings `bgmPrep` / `bgmCombat`. */
export const BGM_CHOICES = Object.freeze(['official', ...BGM_TRACKS.map((t) => t.id), 'custom']);

/** @param {any} v @returns {string} a valid pick ('official' for anything else) */
export const sanitizeBgmChoice = (v) => (BGM_CHOICES.includes(v) ? v : 'official');

/**
 * Which pick a BGM key follows: 'prep' (休整期 and the other prep-like phases) or 'combat' (a normal 作战, the round's
 * own `combat:<i>` too); null for the lobby, 联防 and the boss phases.
 * @param {string|null} key audio.js bgmKeyFor
 * @returns {'prep'|'combat'|null}
 */
export function bgmChoiceKind(key) {
  if (key === 'prep') return 'prep';
  if (key === 'combat' || (typeof key === 'string' && key.startsWith('combat:'))) return 'combat';
  return null;
}

/** The track a manifest names for a pick, or null when this manifest does not have it. */
export function trackOf(manifest, id) {
  const track = BGM_TRACKS.find((t) => t.id === id)?.of(manifest?.audio?.bgm);
  return track && typeof track.loop === 'string' ? { intro: typeof track.intro === 'string' ? track.intro : null, loop: track.loop } : null;
}

/**
 * The picks a select offers for a kind: 官方, every track this manifest has (休整期's own official track is 官方, so it is
 * left out there), and 自选曲.
 * @param {'prep'|'combat'} kind @param {any} manifest
 * @returns {string[]}
 */
export function bgmOptions(kind, manifest) {
  const tracks = BGM_TRACKS.filter((t) => !(kind === 'prep' && t.id === 'prep') && trackOf(manifest, t.id)).map((t) => t.id);
  return ['official', ...tracks, 'custom'];
}

/**
 * The picked track for a BGM key, or null when the official one plays (no pick, an unknown one, a track this manifest
 * lacks, 自选曲 without a file, or a pick that failed to load this page — `failed`, by its `choice`).
 * @param {any} manifest data/assets.json
 * @param {string|null} key audio.js bgmKeyFor
 * @param {{ prep?: string, combat?: string }|null} choices
 * @param {{ failed?: Set<string>|null, local?: { prep?: { id: string, read: () => Promise<ArrayBuffer> }|null,
 *   combat?: { id: string, read: () => Promise<ArrayBuffer> }|null }|null, localPrefix?: string }} [o]
 *   local: the player's own files (a LOCAL_BGM id + its reader, like the lobby's track; audio.js buffers it, never fetches)
 * @returns {{ intro: string|null, loop: string, choice: string }|null} `choice`: the pick's id, or the file's id
 */
export function pickedBgm(manifest, key, choices, { failed = null, local = null, localPrefix = 'local-bgm:' } = {}) {
  const kind = bgmChoiceKind(key);
  if (!kind) return null;
  const id = sanitizeBgmChoice(choices?.[kind]);
  if (id === 'official') return null;
  if (id === 'custom') {
    const own = local?.[kind];
    if (!own || typeof own.read !== 'function' || typeof own.id !== 'string') return null;
    if (failed?.has(localPrefix + own.id)) return null;
    return { intro: null, loop: localPrefix + own.id, choice: own.id };
  }
  if (failed?.has(id)) return null;
  const track = trackOf(manifest, id);
  return track ? { intro: track.intro, loop: track.loop, choice: id } : null;
}
