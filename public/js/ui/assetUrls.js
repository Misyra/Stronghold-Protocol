// Asset URL resolution against data/assets.json (docs/ASSETS.md). Pure: every function takes the
// manifest object (or null) and returns a URL string or null — callers draw their own fallback
// (glyph, CSS shape) when null. Only URLs present in the manifest are ever returned, so the client
// never requests files the asset pipeline did not produce (no 404 noise in the console). Every URL
// leaves pinned through resourceUrl (`pin`, below): with a CDN base it gains the art host prefix and
// its per-file `?v=<hash>`; without one it is returned unchanged.

import { manifestSkinKey } from '../../../shared/skins.js';
import { resourceUrl } from '../resourceUrl.js';

const str = (v) => (typeof v === 'string' && v ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : null);

/** Manifest URLs leave every helper pinned through resourceUrl — uiUrl's doc below carries the why
 *  (a bare CDN URL is cached for a year and never re-busts). null passes through untouched. */
const pin = (url) => (url ? resourceUrl(url) : null);

/** Skin pictures belong to the effective operator, never the original chess of a stand-in / DIY slot. */
function skinPicture(m, chess, skinId, field) {
  if (!skinId) return null;
  const id = chess?.charId || str(chess?.assets?.[field])?.replace(/_[12]$/, '');
  const skin = m?.chars?.[id]?.skins?.[skinId];
  const elite = chess?.isGolden || /_2$/.test(chess?.assets?.[field] || '');
  return pin(str(elite && skin?.[`${field}E2`]) || str(skin?.[field]) || (field === 'portrait' ? str(skin?.illust) : null));
}

/**
 * `ui` art by `group/key`, pinned through resourceUrl like every other art URL the client requests.
 * `ui` is the one family that reaches CSS directly (`--src:url(...)`, `background-image`, `mask-image`):
 * a bare CDN URL is cached for a year, and mask images fetch with CORS, so a response cached before the
 * bucket sent ACAO fails forever. A file hash (or the release tag before the manifest lands) makes a new
 * release's URL a cache miss instead. No CDN configured (tests, a plain static host): unchanged.
 * @param {any} m manifest @param {string} key 'group/key'
 */
export function uiUrl(m, key) {
  const url = str(obj(obj(m)?.ui)?.[key]);
  return url ? resourceUrl(url) : null;
}

/**
 * Operator avatar for a chess record (golden → E2 art when present).
 * @param {any} m manifest
 * @param {any} chess chess.json record (or { assets: { avatar } })
 */
export function chessAvatarUrl(m, chess, { skin = null } = {}) {
  const picture = skinPicture(m, chess, skin, 'avatar');
  if (picture) return picture;
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.avatar) || str(chess?.charId);
  if (!chars || !id) return null;
  if (id.endsWith('_2') && !chars[id]) {
    const base = chars[id.slice(0, -2)];
    return pin(str(base?.avatarE2) || str(base?.avatar));
  }
  // A golden piece whose avatar id is the character key uses that entry's E2 art when it has one.
  // Official ids are `charId` or `charId_2` (the suffix branch above). Model and voice have no E2
  // field on the character entry: the composed `spine` / `voice` id is already the form's.
  const entry = chars[id];
  if (entry && chess?.isGolden && str(entry.avatarE2)) return pin(entry.avatarE2);
  return pin(str(entry?.avatar) || (chess?.charId ? str(chars[chess.charId]?.avatar) : null));
}

/**
 * Half-body portrait (180×360) for a chess record (golden → E2 portrait when present).
 * @param {any} m
 * @param {any} chess
 */
export function chessPortraitUrl(m, chess, { skin = null } = {}) {
  const picture = skinPicture(m, chess, skin, 'portrait');
  if (picture) return picture;
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.portrait);
  if (!chars) return null;
  if (id) {
    // A golden piece whose portrait id is the character key uses portraitE2 when the entry has one.
    // An entry with only `portrait` (a custom golden URL included) keeps that URL. Official ids are
    // `charId_1` / `charId_2` and are not character keys, so they stay on the suffix branches below.
    if (chars[id]) return pin((chess?.isGolden ? str(chars[id].portraitE2) : null) || str(chars[id].portrait));
    if (id.endsWith('_2')) {
      const base = chars[id.slice(0, -2)];
      if (base) return pin(str(base.portraitE2) || str(base.portrait));
    }
    if (id.endsWith('_1')) {
      const base = chars[id.slice(0, -2)];
      if (base) return pin(str(base.portrait));
    }
  }
  const byChar = chess?.charId ? chars[chess.charId] : null;
  if (!byChar) return null;
  return pin((chess?.isGolden ? str(byChar.portraitE2) : null) || str(byChar.portrait));
}

/** Skill icon of a chess record (manifest `skills[iconId]`, else the empty skill sprite). */
export function skillIconUrl(m, chess) {
  const skills = obj(obj(m)?.skills);
  const id = str(chess?.assets?.skillIcon) || str(chess?.skill?.iconId) || str(chess?.skill?.skillId);
  if (skills && id && skills[id]) return pin(str(skills[id]));
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && chess?.skill?.skillId ? byId[chess.skill.skillId] : null;
  if (skills && alt && skills[alt]) return pin(str(skills[alt]));
  return uiUrl(m, 'skillIcon/empty');
}

/**
 * Skill icon of one skill record (DESIGN §16 `skills[]`: iconId / skillId), else the empty skill sprite — or null with
 * `{ empty: false }` (the asset manifest only carries the default skills' icons: callers then draw a lettered S1–S3
 * tile instead of a blank square).
 */
export function skillRecordIconUrl(m, skill, { empty = true } = {}) {
  const skills = obj(obj(m)?.skills);
  for (const id of [str(skill?.iconId), str(skill?.skillId)]) if (skills && id && skills[id]) return pin(str(skills[id]));
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && skill?.skillId ? byId[skill.skillId] : null;
  if (skills && alt && skills[alt]) return pin(str(skills[alt]));
  return empty ? uiUrl(m, 'skillIcon/empty') : null;
}

const PROF_KEY = {
  PIONEER: 'pioneer', WARRIOR: 'warrior', TANK: 'tank', SNIPER: 'sniper', CASTER: 'caster', MEDIC: 'medic',
  SUPPORT: 'support', SPECIAL: 'special',
};

/** Profession icon (small white glyph). */
export function profIconUrl(m, profession) {
  const k = PROF_KEY[String(profession || '').toUpperCase()];
  return k ? pin(str(obj(obj(obj(m)?.prof)?.icon)?.[k])) : null;
}

/** Square profession glyph (manifest `prof.large`: a black glyph on white, drawn as a white one by loadout.css). */
export function profGlyphUrl(m, profession) {
  const v = obj(obj(obj(m)?.prof)?.large)?.[String(profession || '').toLowerCase()];
  return pin(str(v));
}

/** Sub-profession icon from a chess record (`assets.subProfIcon` = 'sub_<id>_icon'). */
export function subProfIconUrl(m, chess) {
  const sub = obj(obj(obj(m)?.prof)?.sub);
  if (!sub) return null;
  const raw = str(chess?.assets?.subProfIcon);
  const id = raw ? raw.replace(/^sub_/, '').replace(/_icon$/, '') : str(chess?.subProfessionId);
  return id ? pin(str(sub[id])) : null;
}

/** Bond glyph (white; tint in CSS). */
export function bondIconUrl(m, bondId) {
  return bondId ? pin(str(obj(obj(m)?.bonds)?.[bondId])) : null;
}

/** Band (strategy) icon. */
export function bandIconUrl(m, bandId) {
  return bandId ? pin(str(obj(obj(m)?.bands)?.[bandId])) : null;
}

/** Item icon for an items.json record (by trapId / iconId) or a raw trap id. */
export function itemIconUrl(m, item) {
  const items = obj(obj(m)?.items);
  if (!items) return null;
  if (typeof item === 'string') return pin(str(items[item]));
  return pin(str(items[item?.iconId]) || str(items[item?.trapId]));
}

/** Enemy icon (manifest keeps fallbacks resolved). */
export function enemyIconUrl(m, enemyKey) {
  const e = enemyKey ? obj(obj(obj(m)?.enemies)?.[enemyKey]) : null;
  if (e?.icon) return pin(str(e.icon));
  // `_2` / `_3` variants fall back to their base enemy
  const base = typeof enemyKey === 'string' ? enemyKey.replace(/_\d+$/, '') : null;
  return base && base !== enemyKey ? pin(str(obj(obj(obj(m)?.enemies)?.[base])?.icon)) : null;
}

/** Token avatar: `tokens[id].skins[opts.skin]`, else the token's avatar, else its owner's (docs/SKINS.md). */
export function tokenAvatarUrl(m, tokenId, opts) {
  const tokens = obj(obj(m)?.tokens);
  const t = tokenId ? obj(tokens?.[tokenId]) : null;
  if (!t) return null;
  const skin = opts?.skin ? obj(obj(t.skins)?.[String(opts.skin)]) : null;
  if (skin?.avatar) return pin(str(skin.avatar));
  if (t.avatar) return pin(str(t.avatar));
  if (t.owner) return pin(str(obj(obj(obj(m)?.chars)?.[t.owner])?.avatar));
  return null;
}

/** Faction (特训敌人 type) icon: `enemyTypeIcon/<icon>`. */
export function factionIconUrl(m, iconId) {
  return iconId ? uiUrl(m, `enemyTypeIcon/${iconId}`) : null;
}

/** Title (评语) icon: `titleIcon/<picId>`. */
export function titleIconUrl(m, picId) {
  return picId ? uiUrl(m, `titleIcon/${picId}`) : null;
}

/** Greek type letters of some modules (ISW-α, …) → the Latin letter of the client's icon file names (isw-a). */
const GREEK = { 'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'Δ': 'd' };
/** Lower-cased key → path index of a local `groups.module` object (built once per manifest object). */
const moduleIconIndex = new WeakMap();

/**
 * Official module (uniequip) TYPE icon from the local-client art (DESIGN §13 / §16): `data/local-assets.json`
 * `groups.module[<type>]`, matched case-insensitively against the module's typeName ('MAR-X' → key 'mar-x', 'PRI-X' →
 * key 'PRI-X' — the client's file names are mixed case). null when the manifest, the group or the entry is missing
 * (callers draw the lettered tile / type text instead).
 * [ASSUMED] A late module branch introduced after the client's art hub (CSR-X / TAC-D, uniequip_002_svash2 /
 * uniequip_004_mlyss) has no official type icon in any gamedata table or in the extracted art. No URL is fabricated for
 * it — the function returns null and the UI keeps the lettered tile / type text. The asset guards whitelist exactly
 * these types; every other type must still resolve to an icon that exists on disk.
 * @param {any} local the local-art manifest (`data.get('local')`) or null
 * @param {string} typeName e.g. 'MAR-X'
 */
export function moduleTypeIconUrl(local, typeName) {
  const g = obj(obj(obj(local)?.groups)?.module);
  const t = str(typeName)?.trim();
  if (!g || !t) return null;
  const exact = str(obj(g[t])?.path);
  if (exact) return pin(exact);
  let idx = moduleIconIndex.get(g);
  if (!idx) {
    idx = new Map();
    for (const [k, v] of Object.entries(g)) {
      const p = str(obj(v)?.path);
      if (p && !idx.has(k.toLowerCase())) idx.set(k.toLowerCase(), p);
    }
    moduleIconIndex.set(g, idx);
  }
  const key = t.replace(/[αβγδΔ]/g, (c) => GREEK[c]).toLowerCase();
  return pin(idx.get(key) || null);
}

/**
 * Icon for an m.private.effects entry: { iconKind: 'band'|'choice'|'team'|'item'|'garrison', iconId }.
 * @param {any} m
 * @param {{ iconKind?: string, iconId?: string }} eff
 */
export function effectIconUrl(m, eff) {
  const kind = eff?.iconKind;
  const id = str(eff?.iconId);
  if (kind === 'band') return bandIconUrl(m, id) || (id && id.startsWith('icon_') ? bandIconUrl(m, `band_${id.slice(5)}`) : null);
  if (kind === 'item') return itemIconUrl(m, id);
  if (kind === 'garrison') return uiUrl(m, `garrisonTypeIcon/${id || 's_icon_bond'}`) || uiUrl(m, 'garrisonTypeIcon/s_icon_bond');
  if (kind === 'team') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_team_buff'}`);
  if (kind === 'choice') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_player_buff'}`);
  return id ? uiUrl(m, `buffIcon/${id}`) : null;
}

// ---- 商店立绘 (移植自用户分支, custom_docs/SKINS.md) -----------------------------------------------------------

/**
 * The operator's OWN 立绘 of a chess record: `e2` asks for the 精英二 one (`_2`), which falls back to the 原始 one
 * when the operator has no E2 art (1★/2★ have none) — that fallback is why the picker can offer the tile at all.
 * @param {any} m manifest @param {any} chess chess record @param {boolean} [e2]
 */
export function chessOwnPortraitUrl(m, chess, e2 = false) {
  const rec = obj(obj(m)?.chars?.[str(chess?.charId)]);
  if (!rec) return null;
  return pin((e2 ? str(rec.portraitE2) || str(rec.portrait) : str(rec.portrait)) || null);
}

/**
 * 商店立绘 (custom_docs/SKINS.md): the 180×360 art the shop card and the operator detail card draw for `chess` under this
 * browser's choice —
 *   * absent / `''` → the operator's own portrait, exactly as before the feature (`chessPortraitUrl`: E2 for an
 *     elite chess, which is what the card has always shown);
 *   * `PORTRAIT_E2`  → the 精英二 立绘 explicitly, even for a chess that is not elite;
 *   * a skinId      → that skin's 立绘.
 * Anything unknown (a skin this install does not have, a stale id) falls back to the operator's own portrait, so a
 * choice can never leave a card blank.
 * @param {any} m manifest @param {any} chess chess record @param {string|null|undefined} choice
 */
export function shopPortraitUrl(m, chess, choice) {
  const pick = str(choice);
  if (!pick) return chessPortraitUrl(m, chess);
  if (pick === PORTRAIT_E2) return chessOwnPortraitUrl(m, chess, true) || chessPortraitUrl(m, chess);
  return skinPortraitUrl(m, chess, pick) || chessPortraitUrl(m, chess);
}

/**
 * The 精英二 立绘 choice's value in the local 商店立绘 map (ui/skins.js). Every real skin id starts with `char_`
 * (shared/skin-catalogue.js — `isSkinId` in shared/skins.js is looser), so this cannot collide with one; and even a
 * collision would only fall back to the operator's own portrait (`shopPortraitUrl`).
 */
export const PORTRAIT_E2 = 'e2';

/**
 * 干员皮肤 (docs/SKINS.md): the tall 立绘 (180×360 — the same frame `chessPortraitUrl` fills) of a chosen skin, or null
 * when nothing is chosen / this install has no 立绘 for that skin. The skin is looked up through the operator
 * (`chars[charId].skins[<official id>]` — shared/skins.js manifestSkinKey turns either id form into that key), so a
 * portrait chosen for one chess shows for every chess of that operator.
 * @param {any} m manifest @param {any} chess chess record @param {string|null} skinId
 */
export function skinPortraitUrl(m, chess, skinId) {
  const id = str(skinId);
  const charId = str(chess?.charId);
  if (!id || !charId) return null;
  const skins = obj(obj(m)?.chars?.[charId])?.skins;
  // manifestSkinKey turns a catalogue id into the manifest key; a skin the catalogue does not list yet (installed ahead of
  // a catalogue refresh) is ALREADY keyed by its official id — ask the manifest with that id instead of giving up.
  return pin(str(obj(skins?.[manifestSkinKey(id) ?? id])?.portrait));
}
