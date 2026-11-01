// 名片干员 (PR #643 split 6): the portrait on a doctor's seat card in the waiting room (screens/room.js) and on the
// strategy draft's name cards (screens/bandDraft.js) — the operator the player picked (room.card; everybody sees it as
// room.state seats[].card), else one of the 5★/6★ operators chosen by the player id, the same on every client — worn in
// the player's outfit (seatCardSkin, the maintainer's decision 4 of 2026-10-21). The rules are pure: the screen passes
// the chess records (ui/assetUrls.js chessPortraitUrl turns the operator into its portrait; without the art pack the
// card keeps its avatar frame). The pick itself lives in `cardStore` (a pref; ui/loadoutSync.js installCardSync sends it).
// [ASSUMED] The event's card shows the account's assistant (名片形象, display_meta_table avatarTypeData ASSISTANT): this
// remake has no accounts, so the pick is made on one's own seat card and kept in this browser (CARD_PREF 'room.card').
// [ASSUMED] With no pick, a 5★/6★ operator is chosen by hash32(playerId) — a remake rule, so that every card has art as in
// the event's room and every client draws the same one.

import { createStore, loadPref, savePref } from '../store.js';
import { ownerSkin } from './skins.js';
import { manifestSkinKey } from '../../../shared/skins.js';
import { N_ } from '../../../shared/i18n.js';

/** 名片干员: the player's own pick (a localStorage pref, sent as room.card). */
export const CARD_PREF = 'room.card';

/** The store field of the pick (ui/loadoutSync.js installCardSync `key`) and its sync state field. */
export const CARD_KEY = 'card';
export const CARD_SYNC_KEY = 'cardSync';

/** A stored pick as the store holds it: a charId string, '' for none (默认). */
export function parseStoredCard(v) {
  return typeof v === 'string' ? v : '';
}

// ---- 名片外观与头像 (移植自用户分支 ui/seatArt.js, feedback #9 / #24 / #100; B 适配) --------------------------
// B 的 room.card 只携带 charId (shared/protocol.js 不含 look / avatar 字段, 线协议不动), 所以外观只在本地展示与
// 存储: CARD_LOOK 留在 localStorage, 只换自己坐席卡的画; 官方玩家头像页在资产清单没有 playerAvatar 资源时优雅
// 降级为不显示 (ui/opPicker.js)。
/**
 * 名片展示外观: the player's own look pick (a local pref; 同盟看不到它, [ASSUMED] B 的适配: fork 把 look 放进
 * room.card, B 的线协议不含它).
 */
export const CARD_LOOK_PREF = 'room.card.look';

/** The store field of the look pick (ui/opPicker.js 的外观行读写它). */
export const CARD_LOOK_KEY = 'cardLook';

/** A stored look as the store holds it: '' (默认) / 'e2' / 'e1' / a skin id of the picked operator. */
export function parseStoredLook(v) {
  return typeof v === 'string' ? v : '';
}

/** This browser's pick, its look and its sync state (survives room / match resets like ui/skins.js' store). */
export const cardStore = createStore({
  [CARD_KEY]: parseStoredCard(loadPref(CARD_PREF, '')),
  [CARD_LOOK_KEY]: parseStoredLook(loadPref(CARD_LOOK_PREF, '')),
  [CARD_SYNC_KEY]: 'idle',
});

/**
 * Pick the 名片干员 ('' = 默认): persisted at once, the sync engine sends it.
 * @param {string} charId
 */
export function setCard(charId) {
  const next = parseStoredCard(charId);
  try { savePref(CARD_PREF, next); } catch { /* private mode: the session keeps it */ }
  cardStore.set({ [CARD_KEY]: next });
}

/**
 * Pick the 名片展示外观 ('' = 默认): persisted at once, display only (B 的 room.card 不上报它).
 * @param {string} look
 */
export function setCardLook(look) {
  const next = parseStoredLook(look);
  try { savePref(CARD_LOOK_PREF, next); } catch { /* private mode: the session keeps it */ }
  cardStore.set({ [CARD_LOOK_KEY]: next });
}

/** FNV-1a of a string (the default portrait: the same operator for a player on every client). */
function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * The operators a seat card can show — the server's room.card whitelist (server/lobby.js cardCharIds): one record per
 * charId of the visible, non-自选 chess records (the elite form, for its E2 art), then the 自选编队 pool
 * (`backups.diy.ownedPool`, named and rated by `backups.diy.operators` — those operators have no chess record of their
 * own), 6★ first, then by name.
 * @param {any[]} chessList chess.json records
 * @param {any} [backups] backups.json (its 自选编队 pool joins the list)
 * @returns {any[]}
 */
export function cardOperators(chessList, backups = null) {
  const by = new Map();
  for (const c of Array.isArray(chessList) ? chessList : []) {
    if (!c || c.isDiy || c.visible === false || typeof c.charId !== 'string') continue;
    const prev = by.get(c.charId);
    if (!prev || (c.isGolden && !prev.isGolden)) by.set(c.charId, c);
  }
  const diy = backups && typeof backups === 'object' ? backups.diy : null;
  const pool = diy && Array.isArray(diy.ownedPool) ? diy.ownedPool : [];
  const ops = diy && diy.operators && typeof diy.operators === 'object' ? diy.operators : {};
  for (const id of pool) {
    if (typeof id !== 'string' || !id || by.has(id)) continue;
    const rec = ops[id];
    by.set(id, { charId: id, name: rec && typeof rec.name === 'string' ? rec.name : id, rarity: rec && Number.isFinite(rec.rarity) ? rec.rarity : 0 });
  }
  return [...by.values()].sort((a, b) => ((b.rarity ?? 0) - (a.rarity ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh'));
}

/**
 * What the seat cards draw from: the pickable operators by charId and the default pool (5★/6★, by charId so every
 * client orders it the same).
 * @param {any[]} list cardOperators()
 */
export function cardContext(list, { pending = false } = {}) {
  return {
    // PR #894 follow-up: true while the room version's 自选 pool (backups) is still loading — a pick that is not in the
    // list yet waits for it instead of drawing a default pool operator for a moment
    pending,
    byChar: new Map(list.map((c) => [c.charId, c])),
    pool: list.filter((c) => (c.rarity ?? 0) >= 5).sort((a, b) => (a.charId < b.charId ? -1 : a.charId > b.charId ? 1 : 0)),
  };
}

/**
 * The operator on a seat card: the player's pick (one's own seat shows the local pick at once, the others the server's
 * seats[].card), else one of the pool chosen by the player id [ASSUMED, see the header]. null for an empty seat, a bot,
 * or before the data loads.
 * @param {any} seat room.state seat
 * @param {{ byChar: Map<string, any>, pool: any[], pending?: boolean }} ctx cardContext()
 * @param {{ myId?: any, myCard?: string }} [own]
 * @returns {{ chess: any, picked: boolean } | null}
 */
export function seatOperator(seat, { byChar, pool, pending = false }, { myId, myCard } = {}) {
  if (!seat || seat.playerId == null || seat.isBot) return null;
  const pick = (seat.playerId === myId ? myCard : seat.card) || '';
  const rec = pick && byChar ? byChar.get(pick) : null;
  if (rec) return { chess: rec, picked: true };
  if (pick && pending) return null;
  if (!Array.isArray(pool) || !pool.length) return null;
  return { chess: pool[hash32(seat.playerId) % pool.length], picked: false };
}

/**
 * The outfit a seat card's operator wears (docs/SKINS.md; the maintainer's decision 4 of 2026-10-21), by the rule of
 * every owner-aware card (ui/skins.js ownerSkin): one's own card wears this browser's choice at once (`localSkins`),
 * another doctor's the choice that seat published — `players` holds `{ playerId, skins }`: the room's seats
 * (room.state seats[].skins) or a match's public players — unless 「显示其他玩家的皮肤」 is off. null = the default art;
 * a skinId the local manifest does not hold (an appearance plugin this page lacks) also draws the default
 * (ui/assetUrls.js chessPortraitUrl falls back).
 * @param {any} seat a seat or player record (`playerId`, `isBot`)
 * @param {string | null | undefined} charId the operator the card shows (seatOperator)
 * @param {{ myId?: any, localSkins?: Record<string, string>, players?: any[], otherSkins?: boolean }} ctx
 * @returns {string | null}
 */
export function seatCardSkin(seat, charId, { myId = null, localSkins = {}, players = [], otherSkins = true } = {}) {
  if (!seat || seat.isBot || seat.playerId == null || !charId) return null;
  if (seat.playerId === myId) return ownerSkin(charId, { localSkins });
  return ownerSkin(charId, { ownerId: seat.playerId, myId, players: Array.isArray(players) ? players.filter(Boolean) : [], otherSkins });
}

/**
 * The picture a seat card draws: the first of `srcs` — the outfit's portrait, then the operator's default portrait — that
 * has not failed to load in this card (`failed`); null when none is left, and the card shows its avatar frame (§35.18's
 * leftover: an outfit file that failed went straight to the frame).
 * @param {(string | null | undefined)[]} srcs in order of preference
 * @param {readonly string[]} [failed]
 * @returns {string | null}
 */
export function seatArtSrc(srcs, failed = []) {
  for (const src of Array.isArray(srcs) ? srcs : []) if (src && !failed.includes(src)) return src;
  return null;
}

// ---- 外观与头像的画 (移植自用户分支 ui/seatArt.js lookUrl / lookOptions / cardAvatarUrl / officialAvatars; B 适配:
// B 的清单把皮肤放在 chars[charId].skins[manifestSkinKey(id)], 且坐席卡的默认画随 chess 记录 (非金卡用基础画),
// 所以 look '' 在这里返回 null — 调用方交回它自己的默认画, B 的默认显示不变) ------------------------------------

const str = (v) => (typeof v === 'string' && v ? v : null);
const manifestChars = (m) => (m && typeof m.chars === 'object' ? m.chars : null);

/**
 * An operator's art of a card look from the art manifest alone: `kind` 'avatar' | 'portrait'; look '' = null (默认画是
 * 调用方的), 'e2' = 精二 (没有精二画则基础画), 'e1' = 基础画, 一个皮肤 id = 该皮肤的画 (只在该干员名下,
 * manifestSkinKey 归一 id); null when unknown.
 * @param {any} m the art manifest @param {string} charId @param {string} [look] @param {'avatar'|'portrait'} [kind]
 */
export function lookUrl(m, charId, look = '', kind = 'avatar') {
  if (typeof charId !== 'string' || !m || !look) return null;
  const c = str(charId) && manifestChars(m)?.[charId];
  if (!c) return null;
  if (look === 'e2') return str(c[`${kind}E2`]) || str(c[kind]);
  if (look === 'e1') return str(c[kind]);
  const s = typeof c.skins === 'object' && c.skins ? c.skins[manifestSkinKey(look)] : null;
  return str(s?.[kind]) || str(s?.[`${kind}E2`]);
}

/**
 * The looks an operator offers on a card (ui/opPicker.js 的外观行, feedback #9 / #24): [{ id, name, src }] — 默认
 * (B 的默认画: 有精二画时是精二, 否则基础画), 精二 ('e2', 有精二画时才有), 精一 ('e1', 精二与基础画都有时才有) 和
 * 该干员清单里有 `kind` 画的每个皮肤; 一项 = 无可选 (外观行不显示).
 * @param {any} m @param {string} charId @param {'avatar'|'portrait'} kind
 */
export function lookOptions(m, charId, kind) {
  const c = (typeof charId === 'string' && manifestChars(m)?.[charId]) || null;
  if (!c) return [];
  const base = str(c[kind]);
  const e2 = str(c[`${kind}E2`]);
  const out = [{ id: '', name: N_('默认'), src: e2 || base }];
  if (e2) out.push({ id: 'e2', name: N_('精英二'), src: e2 });
  if (e2 && base) out.push({ id: 'e1', name: N_('精英一'), src: base });
  const skins = c.skins && typeof c.skins === 'object' ? c.skins : {};
  for (const [id, s] of Object.entries(skins)) {
    const src = str(s?.[kind]) || str(s?.[`${kind}E2`]);
    if (src) out.push({ id, name: str(s?.name) || id, src, skin: true });
  }
  return out;
}

/**
 * 头像: the avatar of an operator (ui/opPicker.js 头像页的干员格子与默认画): its 精二 avatar when the entry has one,
 * else the base one; `look` 同 lookUrl; null when unknown.
 * @param {string} charId @param {any} [m] the art manifest @param {string} [look]
 */
export function cardAvatarUrl(charId, m = null, look = '') {
  if (typeof charId !== 'string' || !charId) return null;
  const c = manifestChars(m)?.[charId];
  if (!c) return null;
  if (look) return lookUrl(m, charId, look, 'avatar');
  return str(c.avatarE2) || str(c.avatar);
}

/** The groups of the official player avatars (id prefixes), the 头像 picker's second page's order. */
const OFFICIAL_AVATAR_GROUPS = Object.freeze([
  { key: 'activity', title: N_('活动头像') }, { key: 'special', title: N_('特殊头像') },
  { key: 'def', title: N_('基础头像') }, { key: 'dyn', title: N_('动态头像') },
]);

/**
 * The official player avatars of the art manifest (feedback #100), by group: [{ key, title, items: [{ id, src }] }].
 * B 的清单还没有 playerAvatar/* 条目 (本机 public/assets 也没有这些文件), 所以现在恒为 [] — 头像选择器的第二页
 * 隐藏 (优雅降级); 资产管线将来产出这些资源时此页自动出现.
 * @param {any} m the art manifest
 */
export function officialAvatars(m) {
  const ui = m?.ui && typeof m.ui === 'object' ? m.ui : {};
  const ids = Object.keys(ui).filter((k) => k.startsWith('playerAvatar/')).map((k) => k.slice('playerAvatar/'.length))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return OFFICIAL_AVATAR_GROUPS.map((g) => ({ ...g, items: ids.filter((id) => id.startsWith(`avatar_${g.key}_`)).map((id) => ({ id, src: ui[`playerAvatar/${id}`] })) }))
    .filter((g) => g.items.length);
}
