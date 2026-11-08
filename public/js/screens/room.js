// Room screen (同盟等待室), laid out like the event's room: 4 tall seat cards (the 名片干员 portrait or the avatar frame,
// 创建者, the ready state at the bottom, the name plate under the card; an empty seat offers 邀请 — copies the key — and,
// to the host, 添加 AI 队友; the host's 移出 / 移除 AI 队友 at a card's top right), the top bar (leave, mode and ping, 统计 /
// 设置 / 玩法说明, 干员调配 and the 同盟密钥 with 复制 / the link), the bottom: the ready count and status line, the
// difficulty pill and ⚙ 同盟设置 (co-op; a timed solo's ⚙ is 模拟设置 and holds 「不限时」, DESIGN §35.23.10; the ⚙ sits where the event's pill has 快速搜寻 — matchmaking is dropped by the
// maintainer's PR #643 keep / drop list of 2026-10-15), and the big 开始模拟 / 准备就绪 button (its disabled reason in
// the project's Tooltip: hover, or a long press on touch; the status line says it too).
// Room settings: a co-op room is created at once from the lobby's 创建同盟 (the event's 联合模拟, research 06 §3.2; the
// maintainer's decision of 2026-10-21), so the difficulty is chosen here — the host's pill (or ⚙'s 模拟难度 row) opens
// 选择模拟协议 (screens/lobby.js ProtocolSelect) whose 确认 sends room.setDifficulty; the dialog closes only once the
// server took it (a refusal keeps it open with the error toast), and its hint states the server's rules: the other
// doctors have to ready again, a plugin mode the host chose is left. ⚙ 同盟设置 lists the 模拟难度 and the
// 「AI 队友最后选择」 switch. The other doctors (and spectators) open the same screens read-only — the cards shown,
// not chosen, 由创建者选择 / 由创建者设置 — and a toast tells them when the host changed the difficulty [ASSUMED: a
// remake aid, since the change reset their ready state; how the event tells the others is not recorded].
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.
// Spectator seats (community report #26, a remake feature): a co-op room with spectators shows the 观战席 strip under
// the seats — names, offline marks, the host's ✕ (room.removeSpectator) — and a spectator's own view swaps the ready
// button for 观战中 and offers 入座 (room.join of the room) while a player seat is free.
// Plugins (DESIGN §32 P1a): the tag under the title — 「原版」 or 「插件 ×N」 — opens the 插件 panel (ui/pluginPanel.js:
// the host switches the room's plugins, everybody else reads them). With gameplay plugins (§32.6: a content set of its
// own — the tag reads 「非官方」 too) every seat shows whether its page has loaded and checked the room's content
// (seats[].content: 载入中 / 就绪 / 校验失败), 准备就绪 and 开始模拟 wait for it (the server refuses them before:
// CONTENT_NOT_READY), and a plugin mode the host chose shows beside the mode name in the top bar (the orange chip).
// 名片干员 (PR #643 split 6): a doctor's seat card shows an operator's portrait — the one the player picked (更换立绘 on
// one's own seat opens the picker: search, rarity, 默认; kept as a pref — ui/seatArt.js cardStore — and sent as
// room.card by ui/loadoutSync.js installCardSync, so the room sees it as seats[].card), else one of the 5★/6★ operators
// chosen by the player id (ui/seatArt.js), the same on every client. [ASSUMED] The pick made here and kept in this
// browser stands in for the event's account assistant (名片形象); [ASSUMED] the default by player id is a remake rule.
// Outfits (docs/SKINS.md; the maintainer's decision 4 of 2026-10-21): the portrait wears the player's outfit — one's own
// card this browser's choice at once, another doctor's the map that seat published (room.state seats[].skins) unless
// 「显示其他玩家的皮肤」 is off; an outfit this page's appearance plugins do not have draws the default art (ui/seatArt.js
// seatCardSkin). The picker is one's own picker, so its tiles wear one's own outfits too (like 干员调配's).
// Without the art pack the card keeps its avatar frame; a bot keeps its robot frame.
// Official versions (DESIGN §35.23, M1; versions.js): a room plays one version (room.state.version; absent = 第二期下半).
// Another version's name shows beside the mode in the top bar (ui/pluginTag.js VersionTag) and every page loads and checks
// its data like a gameplay plugin's content set (content.js) — the seat tags read 版本数据载入中 / 就绪 / 校验失败 and
// 准备就绪 / 开始模拟 wait for it (needsContent: gameplay plugins or another version; 非官方 stays the plugins' alone).
// The version pill beside the difficulty (and ⚙'s 版本 row in co-op) opens the version picker (ui/versionPicker.js): the
// host's pick proposes the switch (room.proposeVersion: a lone human's room switches at once; otherwise the seated humans
// vote — ui/versionVote.js, the strip between the 观战席 and the footer); everybody else reads it (由创建者发起). It is off
// during a vote, with gameplay plugins on (they play 第二期下半 only) and offline. A switch is told to everybody (a toast,
// never on entering a room), and a room whose version is not this browser's lobby choice says that leaving restores it.
// Texts go through t() (docs/I18N.md).

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, MAX_SPECTATORS } from '../../../shared/constants.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyIcon, Tooltip, Spinner, confirmDialog, doctorNo, Modal,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { useGameData, BandIcon } from '../ui/gameComponents.js';
import { TestMark } from '../ui/testConsole.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { SettingsButton } from '../ui/settings.js';
import { AnnouncementButton } from '../ui/announcement.js';
import { LoadoutButton } from './loadout.js';
import { PluginTag, VersionTag, isModdedRoom } from '../ui/pluginTag.js';
import { VersionVote, versionVoteOf } from '../ui/versionVote.js';
import { VersionPicker } from '../ui/versionPicker.js';
import { DEFAULT_VERSION, lobbyVersion, needsContent, offeredDifficulties, roomVersion, serverDefaultVersion, soloTimedOf, soloTimeMsgid, versionLabel } from '../versions.js';
import { pageVersion } from '../content.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating, serverNow, savePref } from '../store.js';
import { data, useData, getConfig } from '../data.js';
import { chessAvatarUrl, chessPortraitUrl } from '../ui/assetUrls.js';
import { CARD_KEY, CARD_LOOK_KEY, CARD_AVATAR_KEY, CARD_FACE_KEY, CARD_BG_KEY, CARD_BG_Y_KEY, cardStore, setCard, setCardLook, setCardAvatar, setCardFace, setCardBackground, setCardBackgroundY, cardOperators, cardContext, seatOperator, seatCardSkin, seatArtSrc, seatCardView, cardAvatarUrl, lookUrl, lookOptions } from '../ui/seatArt.js';
import { OperatorPicker, CardAvatarPicker } from '../ui/opPicker.js';
import { NameCardPicker, NameCardLayer } from '../ui/namecards.js';
import { skinsStore, SKINS_KEY, ownerSkin } from '../ui/skins.js';
import { settingsStore } from '../ui/settingsStore.js';
import { difficultyInfo, ProtocolSelect } from './lobby.js';
import { useRise, usePresence } from '../ui/transitions.js';
// 匹配流程的搜寻/集结面板 (移植自用户分支): SearchPanel — 搜寻中(像素侦察兵+轮换提示+停止搜寻), FoundPanel — 搜寻成功
import { SearchPanel, FoundPanel } from '../ui/matchFlow.js';
import { MatchmakingOffer, matchmakingTitle } from '../ui/matchmaking.js';
import { t, tc } from '../../../shared/i18n.js';

/**
 * Seats padded to the room's capacity (co-op 4, an expanded room 8–20, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
export function normalizeSeats(room) {
  const cap = roomCapacity(room?.mode, room?.experimental);
  const src = Array.isArray(room?.seats) ? room.seats : [];
  const out = [];
  for (let i = 0; i < cap; i++) {
    const s = src[i];
    out.push(s && typeof s === 'object' ? { ...s, seat: Number.isInteger(s.seat) ? s.seat : i } : null);
  }
  return out;
}

/**
 * Derived room facts for the local player.
 * @param {any} room
 * @param {any} myId
 */
export function roomFacts(room, myId) {
  const seats = normalizeSeats(room);
  const occupied = seats.filter(Boolean);
  const humans = occupied.filter((s) => !s.isBot);
  const mine = occupied.find((s) => s.playerId === myId) || null;
  const isHost = room?.hostId != null && room.hostId === myId;
  const others = humans.filter((s) => s.playerId !== myId);
  // The host never readies: starting the match is the host's ready (server rule), so the count
  // treats the host as ready — "已就绪 0/1" next to "准许进入模拟" would contradict itself.
  const isReady = (s) => !!s.ready || s.playerId === room?.hostId;
  const readyHumans = humans.filter(isReady).length;
  const othersReady = others.every((s) => s.ready && s.connected !== false);
  // a room with gameplay plugins (DESIGN §32.6) or another official version (§35.23): every player's page has loaded and
  // checked its content (the host's too); `modded` (非官方) is the plugins' alone
  const modded = isModdedRoom(room);
  const loadsContent = needsContent(room);
  const contentReady = !loadsContent || humans.every((s) => s.content === 'ready');
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady,
    emptySeats: seats.filter((s) => !s).length,
    // 同盟匹配 (移植自用户分支, server/matchmakingRooms.js): 搜寻中的房间冻结开始模拟与房间选项,只有房主且
    // 全员就绪、无 AI、未满员、无对局在跑的同盟可以进队列。
    searching: !!room?.matchmaking,
    canStart: isHost && othersReady && !!mine && !room?.matchmaking && contentReady && (!room?.content?.trusted || humans.every(s => room.content.trusted.consent[s.seat])),
    canMatch: isHost && othersReady && !!mine && mine.connected !== false && !room?.matchmaking && !room?.inMatch &&
      room?.mode === 'coop' && occupied.length < MAX_SEATS && occupied.every((s) => !s.isBot),
    othersReady,
    modded,
    needsContent: loadsContent,
    // another official version (its seat tags and texts; a gameplay plugin room keeps the plugins' words)
    versionRoom: loadsContent && !modded,
    contentReady,
    myContent: loadsContent ? (mine?.content || 'loading') : 'ready',
    // spectator seats (never players: not in `humans`, never counted for ready / start)
    spectators: Array.isArray(room?.spectators) ? room.spectators.filter((s) => s && typeof s === 'object') : [],
    spectating: isSpectating(room, myId),
  };
}

/**
 * A seat still owes its trusted-script consent (roomFacts.canStart's consent clause): with every ready toggle on
 * and the content loaded, this — not a not-ready seat — is what keeps 开始模拟 disabled.
 * @param {any} room @param {ReturnType<typeof roomFacts>} facts
 */
export function consentMissing(room, facts) {
  const trusted = room?.content?.trusted;
  return !!trusted && facts.humans.some((s) => !trusted.consent?.[s.seat]);
}

/**
 * Search progress shown by the room screen. The queue reports `players` (waiting humans in the ticket's
 * pool) and `target` (the seats a match needs); clamping keeps an over-full pool from reading 5/4 or 6/4.
 * Without a search frame — the store's `matchmaking` is null — the room's occupied seats stand in.
 * @param {any} mm store matchmaking projection (status / players / target / joinedAt, main.js)
 * @param {number} [occupied] the room's occupied seats
 */
export function matchmakingProgress(mm, occupied = 0) {
  const searching = mm?.status === 'searching';
  const target = searching && Number.isFinite(mm.target) && mm.target > 0 ? mm.target : MAX_SEATS;
  const raw = searching && Number.isFinite(mm.players) ? mm.players : occupied;
  const matched = Number.isFinite(raw) ? Math.max(0, Math.min(raw, target)) : 0;
  return {
    matched, target,
    elapsed: searching && mm.joinedAt ? Math.max(0, (serverNow() - mm.joinedAt) / 1000) : 0,
  };
}

/**
 * The co-op room option 「AI 队友最后选择」 (GitHub #338; room.setAiPicksLast, room.state.aiPicksLast): in the strategy and
 * 机变 drafts every human picks before the AI teammates. null in a solo room (no AI teammates); otherwise its state (off
 * when the server sends none) and whether this player may switch it — the host only, the others see it read-only.
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function aiLastOption(room, myId) {
  if (!room || room.mode === 'solo') return null;
  return { on: room.aiPicksLast === true, editable: room.hostId != null && room.hostId === myId };
}

/**
 * 「允许重复策略」 (room.setBandDupes, 本仓新设): the co-op room option that lets several doctors hold the same strategy
 * in the draft. null in a solo room; otherwise its state and whether this player may switch it (the host only).
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function bandDupesOption(room, myId) {
  if (!room || room.mode === 'solo') return null;
  return { on: room.bandDupes === true, editable: room.hostId != null && room.hostId === myId };
}

/**
 * 扩展同盟人数 (room.setExperimental, 移植自 Stardust fork 的容量选项): the co-op room's seat capacity — 4 by default,
 * 8/12/16/20 as the host's experimental opt-in (shared/playerCapacity.js PLAYER_CAPACITIES). The whole option set goes to
 * the server at once (shared/experimental.js isExperimental), and a room the queue allocated can never widen.
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ capacity: number, expanded: boolean, editable: boolean } | null}
 */
export function capacityOption(room, myId) {
  if (!room || room.mode !== 'coop' || room.source === 'matchmaking') return null;
  const capacity = roomCapacity('coop', room.experimental);
  return { capacity, expanded: capacity > MAX_SEATS, editable: room.hostId != null && room.hostId === myId && !room.inMatch };
}

/**
 * The option set for a `room.setExperimental` that sets the seat `capacity` (capacityOption's sender): the two base
 * flags always travel, `playerCapacity` only above the official four (a standard room's payload stays two-flag), and
 * 禁用鸭爵策略 survives only an expanded room.
 * @param {number} capacity @param {any} [current] room.state experimental
 * @returns {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean }}
 */
export function capacityExperimental(capacity, current = null) {
  const base = { revivalEnabled: current?.revivalEnabled === true, disableSharedPool: current?.disableSharedPool === true };
  if (!isPlayerCapacity(capacity) || capacity === MAX_SEATS) return base;
  const next = { ...base, playerCapacity: capacity };
  if (current?.disableDuckLord === true) next.disableDuckLord = true;
  return next;
}

/**
 * 禁用鸭爵策略 (expanded rooms only, the fork's duckLordRow): the switch's state and who may change it — null while the
 * room sits at the official four seats.
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function duckLordOption(room, myId) {
  const cap = capacityOption(room, myId);
  if (!cap || !cap.expanded) return null;
  return { on: room.experimental?.disableDuckLord === true, editable: cap.editable };
}

/**
 * The option set for toggling 禁用鸭爵策略 (expanded rooms only, the fork's duckLordRow): an ordinary room's payload
 * keeps its shape without the key.
 * @param {boolean} on @param {any} [current] room.state experimental
 * @returns {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean }}
 */
export function duckLordExperimental(on, current = null) {
  const base = capacityExperimental(roomCapacity('coop', current), current);
  if (base.playerCapacity == null) return base;
  if (on === true) return { ...base, disableDuckLord: true };
  const { disableDuckLord: _dropped, ...rest } = base;
  return rest;
}

/** Spectator handover is available only in original default-version co-op rooms, with a host opt-in. */
export function aiTakeoverOption(room, myId) {
  if (!room || room.mode === 'solo' || roomVersion(room) !== DEFAULT_VERSION || room.content?.vanilla === false) return null;
  return { on: room.aiTakeoverEnabled === true, editable: room.hostId != null && room.hostId === myId && !room.inMatch };
}

/**
 * The solo room option 「不限时」 (DESIGN §35.23.10; room.setSoloUnlimited). null unless the room is solo AND `timed`
 * is exactly true (a version whose solo is timed, and whose data is on screen). Off when room.state omits the key.
 * The host switches it; everybody else sees it read-only.
 * @param {any} room room.state payload
 * @param {any} myId
 * @param {boolean | null} timed soloTimedOf(config, room version)
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function soloUnlimitedOption(room, myId, timed) {
  if (!room || room.mode !== 'solo' || timed !== true) return null;
  return { on: room.soloUnlimited === true, editable: room.hostId != null && room.hostId === myId };
}

/**
 * An AI teammate's name split into its 「AI·」 prefix and the rest, for the plate (room.css hides the prefix on a phone:
 * the avatar's badge and the card's AI 队友 tag say it, and at 特大 the prefix left one character of the name,
 * 「AI·华…」). Null for a human seat and for a name that is only a number after the prefix (`AI·2`).
 * @param {{ isBot?: boolean, name?: string } | null | undefined} seat
 * @returns {[string, string] | null}
 */
export function botNameParts(seat) {
  const m = seat?.isBot ? /^(AI\s*·\s*)(\D.*)$/su.exec(seat.name || '') : null;
  return m ? [m[1], m[2]] : null;
}

/** Invite link for a room code (current page URL with ?room=CODE). */
export function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy text to the clipboard (async API with a textarea fallback for insecure contexts). Moved to ui/clipboard.js so
 * 干员调配 can use it without importing this screen (which imports loadout.js): re-exported here for existing callers.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export { copyText };

/**
 * One seat: a tall card — the top strip (P#), the 名片干员 portrait (or the avatar frame: a bot, no art pack), 创建者, the
 * state at the bottom (准备中 / 待命中 / 已就绪 with its box) — and the name plate under it. The art's text sits in two
 * groups in flow, `.rseat__top` (the badge, 更换立绘, the tags) and `.rseat__low` (the operator's name, the state), so a
 * larger 文字大小 wraps and pushes them apart rather than drawing one over another (§35.18 review). One's own card offers 更换立绘
 * (`onPickCard`); the host gets 移出 / 移除 AI 队友 at the top right. An empty seat: 邀请 (copies the key) and, for the
 * host of a co-op room, 添加 AI 队友. `portrait` is the outfit's picture, `portraitDefault` the operator's default one
 * (given when an outfit is worn): a picture that fails to load gives way to the next, the last to the avatar frame.
 */
/** AI 指定策略 (room.setBotBand, 移植自用户分支): the strategy this AI seat takes in the strategy draft, or 自动选择. */
function BotBandChip({ seat, bands, editable, busy, onOpen }) {
  // 显示策略名（选择器里列的那个），不是 band_bldsk 这种 id：房间里看懂 id 的人不多
  const bandId = typeof seat.band === 'string' ? seat.band : null;
  const bandName = bandId ? (bands || []).find((b) => b.bandId === bandId)?.name || bandId : null;
  const body = html`${bandId ? html`<${BandIcon} bandId=${bandId} size="xs" /><span class="rseat__bandname">${bandName}</span>`
    : html`<${Icon} name="robot" /><span class="rseat__bandname">${t('自动选择')}</span>`}`;
  if (!editable || !onOpen) {
    return html`<span class=${`rseat__band${bandId ? ' is-set' : ''}`} title=${t('开局策略')}>${body}</span>`;
  }
  return html`<button type="button" class=${`rseat__band is-edit${bandId ? ' is-set' : ''}`} disabled=${!!busy}
    onClick=${onOpen} title=${t('指定该 AI 队友在开局时选择的策略')} aria-label=${t('指定 AI 策略')}>
    ${body}${busy ? html`<${Spinner} size="sm" />` : html`<${Icon} name="edit" />`}</button>`;
}

/**
 * AI 指定策略 (room.setBotBand, 移植自用户分支): a grid of the strategies the room's draft offers — 自动选择 first, a
 * strategy already designated to another AI seat greyed out (one AI seat per strategy) — unless 「允许重复策略」
 * (room.setBandDupes) is on: the guard stands down (phases.js bandTaken), every strategy stays pickable and several AI
 * seats may share one. The host only.
 */
function BotBandPicker({ open, seat, seats, bands, busy, dupes = false, onClose, onPick }) {
  if (!seat) return null;
  const others = new Map();
  if (!dupes) for (const x of seats || []) if (x && x.isBot && x !== seat && typeof x.band === 'string') others.set(x.band, x.name);
  const current = typeof seat.band === 'string' ? (bands || []).find((b) => b.bandId === seat.band) : null;
  return html`<${Modal} open=${open} utility=${true} title=${t('指定 AI 策略')} micro="AI STRATEGY" width="min(760px, 94vw)" onClose=${onClose}
    actions=${html`<${Button} variant="secondary" data-autofocus onClick=${onClose}>${t('关闭')}<//>`}>
    <p class="botband__tip t-dim">${dupes ? t('开局选择策略时，该 AI 队友会直接选择指定的策略；已开启允许重复策略，多个 AI 队友可共用同一种策略。') : t('开局选择策略时，该 AI 队友会直接选择指定的策略，其他博士不能再选它。')}</p>
    <div class="botband__grid" role="listbox" aria-label=${t('策略')}>
      <button type="button" role="option" aria-selected=${seat.band == null ? 'true' : 'false'} disabled=${!!busy}
        class=${`botband${seat.band == null ? ' is-sel' : ''}`} onClick=${() => onPick(null)}>
        <span class="botband__auto"><${Icon} name="robot" /></span><span class="botband__name">${t('自动选择')}</span>
      </button>
      ${(bands || []).map((b) => {
        const other = others.get(b.bandId) || null;
        return html`<button key=${b.bandId} type="button" role="option" aria-selected=${seat.band === b.bandId ? 'true' : 'false'}
          aria-disabled=${other ? 'true' : 'false'} disabled=${!!busy}
          class=${`botband${seat.band === b.bandId ? ' is-sel' : ''}${other ? ' is-used' : ''}`}
          title=${other ? t('已指定给 {name}', { name: other }) : (b.effectName || '')}
          onClick=${() => { if (!other) onPick(b.bandId); }}>
          <${BandIcon} bandId=${b.bandId} size="md" /><span class="botband__name">${b.name}</span>
          ${other ? html`<span class="botband__used">${other}</span>` : b.effectName ? html`<span class="botband__eff">${b.effectName}</span>` : null}
        </button>`;
      })}
    </div>
    <p class="botband__now t-dim">${current ? t('当前指定：{name}', { name: current.name }) : t('当前：自动选择')}</p>
  <//>`;
}

function SeatCard({ seat, index, room, facts, myId, busy, onAddBot, onRemoveBot, onKick, onInvite, portrait = null, portraitDefault = null, operator = null, avatar = null, bg = '', bgY = null, onPickCard = null, onPickAvatar = null, onPickBg = null, fresh = false, bands = null, onBotBand = null }) {
  const [badArt, setBadArt] = useState([]);
  const coop = room.mode !== 'solo';
  // the 转场 flash: a seat that turns ready (or becomes the host's), and an AI teammate added while the room is open
  // (`fresh`: this card mounted after the room was already on screen)
  const flash = useRise(!!seat && (seat.ready || seat.isBot || seat.playerId === room.hostId), 700, fresh);
  if (!seat) {
    const canAdd = coop && facts.isHost;
    const invitable = coop && !facts.spectating;
    return html`<article class="seat seat--empty rseat rseat--empty" style=${`--i:${index}`}>
      <span class="rseat__clip" aria-hidden="true"></span>
      <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
      <div class="rseat__art">
        ${invitable
          ? html`<button type="button" class="rseat__invite" onClick=${onInvite} title=${t('复制同盟密钥以邀请队友')}>
              <span class="rseat__plus" aria-hidden="true"></span><b>${t('邀请')}</b><small>${t('复制同盟密钥以邀请队友')}</small></button>`
          : html`<span class="rseat__wait"><small>${t('等待博士加入')}</small></span>`}
        ${canAdd ? html`<${Button} variant="secondary" size="sm" icon="robot" class="rseat__add" loading=${busy === 'add'} onClick=${onAddBot}>${t('添加 AI 队友')}<//>` : null}
        <span class="rseat__noinfo" aria-hidden="true">NOINFO</span>
      </div>
      <div class="rseat__plate rseat__plate--empty"><span class="seat__state t-dim">${t('空位')}</span></div>
    </article>`;
  }
  const consent = room.content?.trusted?.consent?.[seat.seat];
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  // The host never needs to toggle ready: starting the match readies them (server rule).
  const state = offline ? 'offline' : seat.ready || seat.isBot ? 'ready' : isHostSeat ? 'host' : 'waiting';
  const lit = state === 'ready' || state === 'host';
  const art = seat.isBot ? null : seatArtSrc([portrait, portraitDefault], badArt);
  const canPick = isMe && !seat.isBot && !!onPickCard;
  // an AI teammate's name without its 「AI·」 prefix on a phone (room.css; botNameParts)
  const botPrefix = botNameParts(seat);
  return html`<article class=${`seat rseat${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${seat.isBot ? ' is-bot' : ''}${art ? ' has-art' : ''}${lit ? ' is-lit' : ''}${flash ? ' is-flash' : ''} is-${state}`}
      style=${`--i:${index}`}>
    <span class="rseat__clip" aria-hidden="true"></span>
    <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
    <div class="seat__art rseat__art">
      ${art
        ? html`<img key=${art} class="seat__portrait" src=${art} alt="" draggable=${false} onError=${() => setBadArt((b) => (b.includes(art) ? b : [...b, art]))} />`
        : html`<${AvatarFrame} size="xl" name=${seat.name} seat=${index} bot=${seat.isBot} self=${isMe} ready=${state === 'ready'} offline=${offline} />`}
      <div class="rseat__top">
        ${isHostSeat ? html`<span class="rseat__host"><${Icon} name="crown" />${t('创建者')}</span>` : null}
        ${seat.isBot ? html`<span class="rseat__bot"><${Icon} name="robot" />${t('AI 队友')}</span>` : null}
        ${canPick ? html`<button type="button" class="rseat__pick" data-testid="seat-card-pick" onClick=${onPickCard}
          title=${t('更换名片干员')} aria-label=${t('更换名片干员')}><${Icon} name="edit" /><span>${t('更换立绘')}</span></button>` : null}
        ${consent ? html`<span class="rseat__tag" data-testid="script-consented">${t('已同意')}</span>` : null}
        ${facts.needsContent && !seat.isBot ? html`<span class=${`rseat__tag seat__content is-${seat.content || 'loading'}`} data-testid="seat-content">
          ${facts.versionRoom
            ? seat.content === 'ready' ? t('版本数据就绪') : seat.content === 'failed' ? t('版本数据校验失败') : t('版本数据载入中')
            : seat.content === 'ready' ? t('插件内容就绪') : seat.content === 'failed' ? t('插件内容校验失败') : t('插件内容载入中')}
        </span>` : null}
      </div>
      ${offline ? html`<span class="rseat__lost"><${Icon} name="wifiOff" />${t('连接中断')}</span>` : null}
      <div class="rseat__low">
        ${art ? html`<span class="seat__op">${operator?.name || ''}</span>` : null}
        <span class=${`rseat__state seat__state--${state}`}>
          <span class="rseat__box">${lit ? html`<${Icon} name="check" />` : null}</span>
          <span class="rseat__said">${state === 'ready' ? t('已就绪') : state === 'host' ? t('待命中') : state === 'offline' ? t('连接中断') : t('准备中')}</span>
        </span>
      </div>
    </div>
    ${seat.isBot && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${busy === `rm${index}`} onClick=${() => onRemoveBot(index)}
      title=${t('移除该 AI 队友')} aria-label=${t('移除 AI 队友')}><${Icon} name="robot" /><${Icon} name="close" /></button>` : null}
    ${!seat.isBot && !isMe && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${busy === `kick${index}`}
      onClick=${() => onKick(index, seat.name, seat.playerId)} title=${t('将该博士移出同盟')} aria-label=${t('移出该博士')}><${Icon} name="user" /><${Icon} name="close" /></button>` : null}
    ${seat.isBot && room.mode !== 'solo' ? html`<${BotBandChip} seat=${seat} bands=${bands} editable=${!!facts.isHost} busy=${busy === `band${index}`}
      onOpen=${onBotBand ? () => onBotBand(index) : null} />` : null}
    <div class=${`rseat__plate${bg ? ' has-nc' : ''}`}>
      ${bg ? html`<${NameCardLayer} card=${bg} y=${bgY} />` : null}
      ${isMe ? html`<span class="rseat__me" role="img" aria-label=${t('你')} title=${t('你')}><${Icon} name="info" /></span>` : null}
      ${isMe && onPickAvatar
        ? html`<button type="button" class="rseat__ava" data-testid="seat-avatar-pick" onClick=${onPickAvatar} title=${t('更换头像')} aria-label=${t('更换头像')}>
            <${AvatarFrame} size="sm" name=${seat.name} src=${avatar || undefined} seat=${index} bot=${seat.isBot} self=${true} /><span class="rseat__ava-pen" aria-hidden="true"><${Icon} name="edit" /></span></button>`
        : html`<${AvatarFrame} size="sm" name=${seat.name} src=${avatar || undefined} seat=${index} bot=${seat.isBot} self=${isMe} />`}
      <span class="rseat__who"><b class="seat__name">${botPrefix ? html`<span class="seat__name-pre">${botPrefix[0]}</span>${botPrefix[1]}` : seat.name || t('博士')}</b>${isMe ? html`<span class="seat__you" aria-hidden="true">${t('你')}</span>` : null}</span>
      <small class="rseat__doc">${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}</small>
      ${isMe && onPickBg ? html`<button type="button" class="rseat__bg" data-testid="seat-bg-pick" onClick=${onPickBg} title=${t('更换名片底图')} aria-label=${t('更换名片底图')}><${Icon} name="image" /></button>` : null}
    </div>
  </article>`;
}

/** 观战席: the room's spectators (host: ✕ frees a seat), and 入座 for a spectator while a player seat is free. */
function SpectatorBar({ facts, myId, busy, onRemove, onSit }) {
  if (!facts.spectators.length) return null;
  return html`<section class="specbar" aria-label=${t('观战席')}>
    <span class="specbar__label"><${Icon} name="eye" />${t('观战席')}<b class="num">${facts.spectators.length}</b><span class="num t-dim">/${MAX_SPECTATORS}</span></span>
    ${facts.spectators.map((s) => html`<span key=${s.playerId} class=${`specbar__who${s.playerId === myId ? ' is-me' : ''}${s.connected === false ? ' is-offline' : ''}`}>
      ${s.connected === false ? html`<${Icon} name="wifiOff" />` : null}${s.name || t('博士')}${s.playerId === myId ? html`<span class="seat__you">${t('你')}</span>` : null}
      ${facts.isHost ? html`<${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rs${s.playerId}`}
        onClick=${() => onRemove(s.playerId)} aria-label=${t('移出观战者 {name}', { name: s.name || '' })} title=${t('移出该观战者')} />` : null}
    </span>`)}
    ${facts.spectating && facts.emptySeats > 0 ? html`<${Button} size="sm" icon="user" loading=${busy === 'sit'} onClick=${onSit}>${t('入座')}<//>` : null}
  </section>`;
}

/** The 「不限时」 switch (a timed solo): the host toggles it, everybody else sees its state. */
function SoloUnlimitedToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('关闭本局休整与机变的计时。官方为休整期每轮 300 秒、机变 150 秒。')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-solo-unlimited"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('不限时')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/** The 「AI 队友最后选择」 switch (co-op): the host toggles it, everybody else sees its state. */
function AiLastToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('策略与机变轮选时，所有博士先于 AI 队友选择')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'}
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('AI 队友最后选择')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/** The 「允许重复策略」 switch (co-op, 本仓新设): the host toggles it, everybody else sees its state. */
function BandDupesToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('默认关闭。开启后，策略选人允许多名博士选择同一策略（含自动分配），不再标「队友已选」')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-band-dupes"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('允许重复策略')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/**
 * 扩展同盟人数 (room.setExperimental, 移植自 Stardust fork 的容量选项): the host's switch, and once expanded the
 * 8/12/16/20 seat picker — an experimental mode, so the picker line says what it costs (bigger rooms wait and settle
 * longer, and every member needs an up-to-date page). The others see the state read-only.
 */
function CapacityToggle({ option, busy, onCapacity }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('实验性选项：同盟扩到 8–20 人。可直接开局，人数较多时等待与演算时间可能增加；所有成员需更新页面。')}>
      <button type="button" role="switch" aria-checked=${option.expanded ? 'true' : 'false'} data-testid="room-capacity"
          class=${`dpick__opt ailast__opt${option.expanded ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onCapacity(option.expanded ? MAX_SEATS : 8)}>
        <${Icon} name="check" class=${option.expanded ? 'is-on' : ''} />${t('扩展同盟人数')}
      </button>
    <//>
    ${option.expanded ? html`<label class="rs-capacity" for="rs-capacity-pick" data-testid="room-capacity-pick">
      <span>${t('同盟人数模式')}</span>
      <select id="rs-capacity-pick" value=${option.capacity} disabled=${!option.editable || !!busy}
        onChange=${(e) => onCapacity(Number(e.currentTarget.value))}>
        ${PLAYER_CAPACITIES.map((n) => html`<option key=${n} value=${n}>${t('{n} 人', { n })}</option>`)}
      </select>
    </label>` : null}
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/** The 「禁用鸭爵策略」 switch (expanded rooms only, the fork's duckLordRow): the host toggles it, the others read it. */
function DuckLordToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('勾选后，本局无法选择鸭爵策略；不影响其他策略。')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-duck-lord"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('禁用鸭爵策略')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

function AiTakeoverToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('默认关闭。开启后，观战者可在休整期经同房间真人投票接替 AI；继承记录不计个人统计或奖励。')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-ai-takeover"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('允许观战者接替 AI')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/**
 * 开发者控制台 (room.console.enable, server/match/match/intents.js consoleGrant, 移植自用户分支): a private room may
 * grant itself in-match 干员 / 装备 / 盟约层数, quota-limited and broadcast to the team. A solo room's own seat may
 * switch it; every other room needs its host, and a matchmaking room can never use it.
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ on: boolean, editable: boolean }}
 */
export function consoleOption(room, myId) {
  if (!room) return { on: false, editable: false };
  const personal = room.mode === 'solo' && (room.seats || []).some((s) => s && !s.isBot && s.playerId === myId);
  return { on: room.consoleEnabled === true, editable: room.hostId != null ? (personal || room.hostId === myId) : personal };
}

/** The developer console switch: host-only (a solo room's own seat too), disabled while the room is matchmaking. */
function ConsoleToggle({ option, busy, onToggle, matching }) {
  return html`<div class="ailast">
    <${Tooltip} text=${t('对局内可发放干员、装备与盟约层数（每回合 {round} 次，全场 {total} 次），全队可见', { round: 5, total: 50 })}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-console"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy || (matching && !option.on)}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('开发者控制台')}
      </button>
    <//>
    ${option.on ? html`<span class="t-dim">${t('不能进入匹配队列')}</span>` : null}
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/**
 * ⚙ of the bottom pill (co-op): 同盟设置 — the 模拟难度 (opens 选择模拟协议: the host's 确认, the others' read-only view)
 * and the 「AI 队友最后选择」 switch. Closes on a click outside it or Esc.
 */
function RoomOptions({ option, takeoverOption, onAiTakeover, soloOption = null, room, isHost, busy, onAiLast, dupesOption = null, onBandDupes,
  capOption = null, onCapacity, duckOption = null, onDuckLord, onSoloUnlimited, onConsole, consoleOpt, onDifficulty, onClose, version = null }) {
  const info = difficultyInfo(room.mode, room.difficulty);
  const title = soloOption ? t('模拟设置') : t('同盟设置');
  useEffect(() => {
    const away = (e) => { if (!e.target.closest?.('.rs-opts, .rs-pill__gear')) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('pointerdown', away);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', onKey); };
  }, []);
  return html`<div class="rs-opts" role="dialog" aria-label=${title}>
    <h4>${title}</h4>
    ${soloOption ? null : html`<div class="rs-opts__row" data-testid="room-opt-difficulty">
      <button type="button" class="rs-opts__diff" disabled=${isHost && !!busy} onClick=${onDifficulty}
          title=${isHost ? t('更改模拟难度') : t('由创建者选择')}>
        <${DifficultyIcon} difficulty=${room.difficulty} />${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''}<span class="num rs-pill__code">${info.code}</span>
        ${isHost ? html`<em>${t('更改')}</em>` : null}
      </button>
    </div>`}
    ${!soloOption && version ? html`<div class="rs-opts__row" data-testid="room-opt-version">
      <${Tooltip} text=${version.why}>
        <button type="button" class="rs-opts__diff rs-opts__ver" disabled=${version.disabled} onClick=${version.onOpen}
            title=${version.editable ? t('发起切换版本') : t('由创建者发起')}>
          <${Icon} name="book" />${versionLabel(version.id)}${version.editable ? html`<em>${t('切换')}</em>` : null}
        </button>
      <//>
    </div>` : null}
    <${AiTakeoverToggle} option=${takeoverOption} busy=${busy} onToggle=${onAiTakeover} />
    ${soloOption
      ? html`<${SoloUnlimitedToggle} option=${soloOption} busy=${busy} onToggle=${onSoloUnlimited} />`
      : html`<${AiLastToggle} option=${option} busy=${busy} onToggle=${onAiLast} />`}
    <${BandDupesToggle} option=${dupesOption} busy=${busy} onToggle=${onBandDupes} />
    <${CapacityToggle} option=${capOption} busy=${busy} onCapacity=${onCapacity} />
    <${DuckLordToggle} option=${duckOption} busy=${busy} onToggle=${onDuckLord} />
    <${ConsoleToggle} option=${consoleOpt} busy=${busy} matching=${!!room.matchmaking} onToggle=${onConsole} />
  </div>`;
}

/** A gear (the pill's ⚙, in the place of the event's 快速搜寻: matchmaking is dropped — the maintainer's PR #643 keep / drop list, 2026-10-15). */
function GearGlyph() {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" /></svg>`;
}

/**
 * The big button of the bottom right (开始模拟 / 准备就绪 / 已就绪 / 观战中), styled like 选择模拟协议's. A disabled reason goes in
 * the project's Tooltip around it (review of PR #813: a native title never shows on touch).
 */
function GoButton({ label, onClick, disabled, loading = false, ready = null, icon = null }) {
  return html`<button type="button" class=${`proto-start rs-go${ready ? ' is-ready' : ''}`} disabled=${disabled} onClick=${onClick}
      aria-busy=${loading ? 'true' : 'false'}>
    ${ready != null
      ? html`<span class="rs-go__box" aria-hidden="true">${ready ? html`<${Icon} name="check" />` : null}</span>`
      : icon
        // (a spectator's 观战中: its eye in the mark's place, so the label keeps the width — §35.18 review)
        ? html`<span class="rs-go__icon" aria-hidden="true"><${Icon} name=${icon} /></span>`
        : html`<span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>`}
    <span class="proto-start__label">${loading ? html`<${Spinner} size="sm" />` : null}${label}</span>
    <span class="proto-start__deco" aria-hidden="true"></span>
  </button>`;
}

/** How long a version proposal refused as too frequent (RATE) waits before it is sent once more [ASSUMED]. */
const PROPOSE_RETRY_MS = 1200;

/** Room screen component. */
export function RoomScreen() {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  // 匹配队列票据 (queue.state 的投影, main.js): queued/offered 帧给出 waitingCount/required/joinedAt/offerId
  const mm = useStore((s) => s.matchmaking, shallowEqual);
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);
  // 搜寻成功 (移植自用户分支): 队列运行时最后一个座位补满 → 短暂展示后收起(服务器在同一拍停搜并补满)
  const [found, setFound] = useState(false);
  const prevEmpty = useRef(null);
  // 名片干员: the operators a seat card can show and the default pool (ui/seatArt.js), one's own pick (a pref the sync
  // engine sends: ui/loadoutSync.js installCardSync), and the outfits the cards wear — this browser's choices and the
  // 「显示其他玩家的皮肤」 switch (docs/SKINS.md)
  useData('chess', 'assets', 'config', 'backups');
  const chess = data.get('chess');
  const backups = data.get('backups');
  // the room version's chess records and 自选编队 pool (ui/seatArt.js cardOperators — the server's cardCharIds)
  const cardList = useMemo(() => cardOperators(data.list('chess'), backups), [chess, backups]);
  const cards = useMemo(() => cardContext(cardList, { pending: !backups }), [cardList, backups]);
  const myCard = useStore((s) => s[CARD_KEY], Object.is, cardStore);
  // 名片外观 (Stardust PR2, 2026-10-16): the 名片干员's art, the 名片头像 and its art, the 名片底图 and its framing —
  // all of them travel with room.card (ui/loadoutSync.js installCardSync) so the room sees the same card
  const myLook = useStore((s) => s[CARD_LOOK_KEY], Object.is, cardStore);
  const myAvatar = useStore((s) => s[CARD_AVATAR_KEY], Object.is, cardStore) || '';
  const myFace = useStore((s) => s[CARD_FACE_KEY], Object.is, cardStore) || '';
  const myBg = useStore((s) => s[CARD_BG_KEY], Object.is, cardStore) || '';
  const myBgY = useStore((s) => s[CARD_BG_Y_KEY], Object.is, cardStore) ?? null;
  const localSkins = useStore((s) => s[SKINS_KEY], Object.is, skinsStore);
  const otherSkins = useStore((s) => s.otherSkins !== false, Object.is, settingsStore);
  const [picking, setPicking] = useState(null);
  // AI 指定策略 (room.setBotBand, 移植自用户分支): the strategies a room's draft may offer (MULTI, sortId order), and
  // the AI seat whose strategy the host is picking
  const gd = useGameData();
  const bandList = useMemo(() => (gd.list('bands') || [])
    .filter((b) => b && (!Array.isArray(b.modeTypeList) || b.modeTypeList.includes('MULTI')))
    .sort((a, b) => (a.sortId ?? 99) - (b.sortId ?? 99) || (a.bandId < b.bandId ? -1 : 1)), [gd.ready]);
  const [bandSeat, setBandSeat] = useState(null);
  // the room whose seats are on screen: a seat card that mounts after its first render is new (an AI teammate added)
  const shownRoom = useRef('');
  useEffect(() => { shownRoom.current = room?.code || ''; });
  // 选择模拟协议 over the room — open, and the host's pick before 确认 (the others read it: the room's difficulty) — and
  // the ⚙ menu
  const [protoOpen, setProtoOpen] = useState(false);
  const [protoPick, setProtoPick] = useState(null);
  const [opts, setOpts] = useState(false);
  // the host's change of difficulty, told to the others (see the header); never on entering a room or switching rooms
  const seenDiff = useRef(room ? `${room.code}|${room.difficulty}` : '');
  useEffect(() => {
    if (!room) return;
    const key = `${room.code}|${room.difficulty}`;
    const before = seenDiff.current;
    seenDiff.current = key;
    if (!before || before === key || !before.startsWith(`${room.code}|`) || room.hostId === me.playerId) return;
    const name = DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : room.difficulty;
    toast(t('创建者已将模拟难度改为「{name}」', { name }), 'info');
  }, [room?.code, room?.difficulty]);
  // 扩展同盟人数 is told to the others the same way (a change resets their ready state — the server's rule)
  const seenExp = useRef(room ? `${room.code}|${roomCapacity('coop', room.experimental)}` : '');
  useEffect(() => {
    if (!room) return;
    const n = roomCapacity('coop', room.experimental);
    const key = `${room.code}|${n}`;
    const before = seenExp.current;
    seenExp.current = key;
    if (!before || before === key || !before.startsWith(`${room.code}|`) || room.hostId === me.playerId) return;
    toast(n > MAX_SEATS ? t('创建者已开启「{n} 人模式」', { n }) : t('创建者已关闭扩展同盟人数'), 'info');
  }, [room?.code, room?.experimental]);
  // official versions (DESIGN §35.23): the room's switch is told to everybody (the host's own page included — a vote's
  // result arrives later than the pick); never on entering a room or switching rooms
  const versions = useStore((s) => s.versions);
  const myLobby = useStore(lobbyVersion);
  const serverDefault = useStore(serverDefaultVersion);
  const [versionOpen, setVersionOpen] = useState(false);
  const seenVersion = useRef(room ? `${room.code}|${roomVersion(room)}` : '');
  useEffect(() => {
    if (!room) return;
    const key = `${room.code}|${roomVersion(room)}`;
    const before = seenVersion.current;
    seenVersion.current = key;
    if (!before || before === key || !before.startsWith(`${room.code}|`)) return;
    setVersionOpen(false);
    toast(t('同盟已切换到「{version}」', { version: versionLabel(roomVersion(room)) }), 'success');
  }, [room?.code, room?.version]);
  // the room sees one's pick once the server has it (seats[].card): ui/loadoutSync.js installCardSync sends it after
  // every pick, welcome and content change and retries a RATE / TIMEOUT / OFFLINE refusal (review of PR #813).
  // 名片干员选择器 (移植自用户分支 ui/opPicker.js): picking an operator that offers 外观 (精二 / 精一 / 皮肤) keeps the
  // picker open for its look row; picking a look (a pref, ui/seatArt.js setCardLook) closes it. The look now travels with
  // room.card art (Stardust PR2), so the room sees the same art; 名片头像 and 名片底图 work the same way.
  const pickCard = (charId) => {
    setCard(charId);
    // 换了干员就清掉上一个干员的外观 (皮肤 id 不属于新干员, 精二/精一也回到默认), 交给外观行重挑
    if (charId && myLook && !lookUrl(data.get('assets'), charId, myLook, 'portrait')) setCardLook('');
    if (!charId || lookOptions(data.get('assets'), charId, 'portrait').length < 2) setPicking(null);
  };
  const pickLook = (look) => { setCardLook(look); setPicking(null); };
  // 名片头像 (Stardust PR2): the operator avatar on one's plate and its 精一 / 精二 / skin variant
  const pickAvatar = (charId, face = '') => { setCardAvatar(charId); setCardFace(face); };
  // 名片底图 (ui/namecards.js): the background and its vertical framing
  const pickBg = (bg) => setCardBackground(bg);
  const pickBgY = (y) => setCardBackgroundY(y);

  // 同盟匹配的房间侧状态 (移植自用户分支): room.state.matchmaking 是真值(服务器给房间排队,补满或匹配成功时
  // 自行撤单),面板与按钮读它而不是本地意愿;人数与时钟来自玩家侧的 queue.state。
  const endedAt = useRef(0);
  const prevMatching = useRef(false);
  useEffect(() => {
    if (!room) return;
    if (prevMatching.current && !room.matchmaking) endedAt.current = Date.now();
    prevMatching.current = !!room.matchmaking;
  }, [room?.matchmaking]);
  useEffect(() => {
    if (!room) return;
    const empty = roomFacts(room, me.playerId).emptySeats;
    const wasSearching = !!room.matchmaking || Date.now() - endedAt.current < 2500;
    if (prevEmpty.current != null && empty < prevEmpty.current && wasSearching && empty === 0) setFound(true);
    prevEmpty.current = empty;
  }, [room?.code, room?.seats?.filter(Boolean).length]);
  useEffect(() => { if (!found) return undefined; const id = setTimeout(() => alive.current && setFound(false), 1900); return () => clearTimeout(id); }, [found]);

  // The room facts and the two usePresence hooks sit above the early return: a re-render with the room gone while the
  // screen is still mounted must not change the hooks order (their inputs are null-safe; briefing.js keeps the same
  // rule for planBonds).
  const facts = roomFacts(room, me.playerId);
  const coop = room?.mode !== 'solo';
  const searching = coop && !!facts.searching;
  // overlay 淡出期间保持挂载
  const [searchShown, searchLeaving] = usePresence(searching && !found, 220);
  const offerShown = !!(searching && mm?.offerId);
  const [foundShown, foundLeaving] = usePresence(found, 320);

  if (!room) return null;
  const online = conn.status === 'online';
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);
  // 开发者控制台与匹配互斥 (server/matchmakingRooms.js) —— 开着控制台的房间不进队列,所以「开始搜寻」留在原地并说明
  // 原因,而不是点下去才被服务器拒。
  const consoleOn = room?.consoleEnabled === true;
  // 扩展同盟人数 (移植自 Stardust fork): an expanded room's seat cards keep a readable width and scroll sideways
  const big = facts.seats.length > MAX_SEATS;
  // 玩法插件房间与官方匹配互斥 (server/matchmakingRooms.js matchmakingMembers): 官方队列只收原生内容,和开发者控制台同一条规则。
  const modded = isModdedRoom(room);
  const searchable = coop && facts.canMatch;
  // 队列自己的时钟: server/matchmaking.js 搜寻中报 { joinedAt, players, target, serverNow }
  const mmView = matchmakingProgress(mm, facts.occupied.length);
  const searchElapsed = mmView.elapsed;

  /** Runs one request at a time; resolves true once the server took it (false: not sent, or refused — toasted). */
  const run = async (kind, fn) => {
    if (inFlight.current) return false;
    if (!online) { toast(t('连接中断，请稍候重试'), 'warn'); return false; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); return true; } catch (err) { toastError(err); return false; } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const toggleReady = () => run('ready', () => net.request('room.ready', { ready: !myReady }));
  const start = () => run('start', () => net.request('room.start', {}));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat) => run(`rm${seat}`, () => net.request('room.removeBot', { seat }));
  // the host removes a human before the match (community report #17): asked first; the player may join again. The
  // confirmed player's id goes along: if they left and someone else took the seat meanwhile, the server refuses it.
  const kick = async (seat, name, playerId) => {
    if (inFlight.current) return;
    const ok = await confirmDialog({ title: t('移出同盟'), text: t('确定将「{name}」移出同盟吗？对方可以凭同盟密钥重新加入。', { name: name || t('博士') }), okText: t('移出'), danger: true });
    if (ok) run(`kick${seat}`, () => net.request('room.kick', { seat, playerId }));
  };
  const setDifficulty = (difficulty) => run('diff', () => net.request('room.setDifficulty', { difficulty }));
const setAiTakeover = (on) => run('aihandover', () => net.request('room.setAiTakeover', { on }));
const setAiLast = (on) => run('ailast', () => net.request('room.setAiPicksLast', { on }));
// 「允许重复策略」 (本仓新设): the host toggles it, the draft's 队友已选 guard stands down
const setBandDupes = (on) => run('dupes', () => net.request('room.setBandDupes', { on }));
// 扩展同盟人数 / 禁用鸭爵策略 (room.setExperimental, 移植自 Stardust fork): the whole option set goes to the server at
// once; the server resets the others' ready when it takes a change (server/lobby.js setExperimental)
const setCapacity = (capacity) => run('capacity', () => net.request('room.setExperimental', { experimental: capacityExperimental(capacity, room.experimental) }));
const setDuckLord = (on) => run('ducklord', () => net.request('room.setExperimental', { experimental: duckLordExperimental(on, room.experimental) }));
// AI 指定策略 (room.setBotBand, 移植自用户分支): the host names the strategy an AI seat takes in the draft (null = 自动选择)
const setBotBand = (seat, bandId) => run(`band${seat}`, async () => { await net.request('room.setBotBand', { seat, bandId }); setBandSeat(null); });
  // 开发者控制台 (移植自用户分支): two messages, host-only on the server (a solo room's own seat may toggle it).
  // Turning it ON costs the room its place in the 同盟匹配 queue, and that is worth saying out loud for five
  // seconds: the switch itself sits in the ⚙ sheet, far from the 开始搜寻 button it disables.
  const setConsole = (on) => run('console', async () => {
    await net.request(on ? 'room.console.enable' : 'room.console.disable', {});
    if (on) toast(t('开发者控制台已开启：本房间不会进入匹配队列'), 'warn', { ttl: 5000 });
  });
  // 开始搜寻 = 同盟匹配 (server/matchmakingRooms.js joinParty): 房间本身就是队列条目,无需重复排队 ——
  // room.state.matchmaking 说明它是否在跑,匹配成功或补满时服务器自行收尾。
  const queueMatch = () => run('match', () => net.request('room.matchmaking', {}));
  const cancelMatch = () => run('cancel-match', () => net.request('queue.cancel', { ticketId: mm?.ticketId }));
  // 确认入场: 报价需要组队里每个真人都确认后房间才会开局 (server/matchmaking.js)
  const acceptMatch = () => run('accept-match', () => net.request('queue.accept', { ticketId: mm?.ticketId, offerId: mm?.offerId }));
  // the room is the authority; the lobby card reads the same pref the next time this browser creates a solo room
  const setSoloUnlimited = async (on) => {
    const sent = await run('solofree', () => net.request('room.setSoloUnlimited', { on }));
    if (sent) savePref('lobby.soloUnlimited', on === true);
  };
  // spectator seats: the host frees one; a spectator takes a free player seat with room.join of this room
  const removeSpectator = (playerId) => run(`rs${playerId}`, () => net.request('room.removeSpectator', { playerId }));
  const sit = () => run('sit', () => net.request('room.join', { code: room.code, ...(room.test ? { testAck: true } : {}) }));
  const leave = async () => {
    if (inFlight.current) return;
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ title: t('离开同盟'), text: t('你是同盟的创建者，离开后创建者身份将移交或同盟解散。确定离开吗？'), okText: t('离开'), danger: true });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy('leave');
    try {
      await net.request('room.leave', {});
    } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM') toastError(err);
    } finally {
      // Leaving locally is always safe: the server either confirmed or no longer has us in the room.
      store.set({ room: null, match: emptyMatch() });
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const statusLine = !online
    ? html`<span class="t-orange"><${Icon} name="wifiOff" />${t('连接中断，正在重连…')}</span>`
    : facts.spectating
      ? html`<span class="t-lo"><${Icon} name="eye" />${t('观战中 · 不占博士席位，模拟开始后可切换观看各位博士')}</span>`
    : facts.searching
      ? html`<span class="t-mint"><${Icon} name="hourglass" />${mm?.offerId ? matchmakingTitle(mm) : t('正在搜寻队友')} · ${mmView.matched}/${mmView.target} ${t('名博士')}</span>`
    : !coop
      ? html`<span class="t-mint">${t('*模拟协议已就绪，准许进入模拟')}</span>`
    : facts.versionRoom && !facts.contentReady
      ? html`<span class="t-lo">${t('等待所有博士载入「{version}」的数据', { version: versionLabel(roomVersion(room)) })}</span>`
    : facts.needsContent && !facts.contentReady
      ? html`<span class="t-lo">${t('等待所有博士载入房间的插件内容')}</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">${t('*同盟人数达标，准许进入模拟')}</span>`
        : html`<span class="t-lo">${consentMissing(room, facts) ? t('等待所有博士同意受信任插件') : t('等待所有博士准备就绪')}</span>`
      : myReady
        ? html`<span class="t-mint">${t('已就绪 · 等待创建者开始模拟')}</span>`
        : html`<span class="t-lo">${t('准备就绪后，创建者即可开始模拟')}</span>`;

  const copy = async (what) => {
    // the copied link carries an invitation line (#103): 「{name}邀请你加入卫戍协议：盟约【{difficulty}】」 — with the
    // version's name for another official version (DESIGN §35.23)
    const params = { name: me.name ?? '', difficulty: DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : '' };
    const invite = roomVersion(room) !== DEFAULT_VERSION
      ? t('{name}邀请你加入卫戍协议：盟约·{version}【{difficulty}】', { ...params, version: versionLabel(roomVersion(room)) })
      : t('{name}邀请你加入卫戍协议：盟约【{difficulty}】', params);
    const ok = await copyText(what === 'code' ? room.code : `${inviteLink(room.code)} ${invite}`);
    if (ok) toast(what === 'code' ? t('已复制同盟密钥 {code}', { code: room.code }) : t('已复制邀请链接'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  // 选择模拟协议 over the room: the host picks and sends the difficulty on 确认 (nothing to send when it did not change —
  // unless a plugin mode is on, which picking a difficulty leaves: server/lobby.js setDifficulty); it closes only once the
  // server took it, and the accepted pick becomes the remembered difficulty (`lobby.difficulty`, the one 创建同盟 and
  // 独立模拟's 选择模拟协议 start from — README / PLAYING 难度沿用上次选的). Everybody else opens it read-only.
  const openProto = () => { setOpts(false); setProtoPick(room.difficulty); setProtoOpen(true); };
  const closeProto = () => { setProtoOpen(false); setProtoPick(null); };
  const pluginMode = room.content?.modeId ? (room.content.modes || []).find((m) => m.id === room.content.modeId)?.name || room.content.modeId : null;
  const confirmDifficulty = async () => {
    const d = protoPick || room.difficulty;
    if (d === room.difficulty && !pluginMode) { closeProto(); return; }
    if (!(await setDifficulty(d))) return;
    savePref('lobby.difficulty', d);
    // the plugin mode is gone: said, as a same-difficulty 确认 changes nothing else the host sees (§35.51; §35.18's nit)
    if (pluginMode) toast(t('已退出插件模式「{name}」', { name: pluginMode }), 'info');
    if (alive.current) closeProto();
  };
  // the difficulties the room's version offers (its config's modes, versions.js) — the page shows that version's data
  // once it is loaded; until then (or for a gameplay plugin room's own modes) all four
  const protoDifficulties = offeredDifficulties(pageVersion() === roomVersion(room) ? getConfig() : null, room.mode);
  const protoHint = pluginMode
    ? t('确认后将退出插件模式「{name}」', { name: pluginMode })
    : facts.humans.length > 1 ? t('更改难度后，其他博士需要重新准备就绪') : '';
  const aiLast = aiLastOption(room, me.playerId);
  const dupesOpt = bandDupesOption(room, me.playerId);
  const consoleOpt = consoleOption(room, me.playerId);
  const soloTimed = soloTimedOf(pageVersion() === roomVersion(room) ? getConfig() : null, roomVersion(room));
  const soloOpt = soloUnlimitedOption(room, me.playerId, soloTimed);
  const soloBrief = soloTimeMsgid('brief', { timed: soloTimed, unlimited: room.soloUnlimited === true });
  const modeName = coop ? t('同盟模拟') : t('独立模拟');
  // the room's version (DESIGN §35.23): the pill and ⚙'s row on a server that enables versions (or in a version room)
  const vote = versionVoteOf(room);
  const curVersion = roomVersion(room);
  const showVersion = Array.isArray(versions) || curVersion !== DEFAULT_VERSION;
  const versionWhy = !online ? t('连接中断，请稍候重试')
    : vote ? t('切换版本投票进行中，请等投票结束')
    : facts.modded ? t('请先关闭改变玩法的插件')
    : !Array.isArray(versions) || versions.length < 2 ? t('本服务器只启用了这一个版本') : null;
  const versionEditable = facts.isHost && !facts.spectating && !room.inMatch;
  // the room's version is not this browser's lobby choice: the banner says leaving restores it (on a short screen, where
  // the banner gives its room to the seats, the pill's tooltip says it)
  const bannerText = curVersion !== myLobby && Array.isArray(versions) ? t('本房间为「{room}」，离开后恢复你的大厅版本「{mine}」', { room: versionLabel(curVersion), mine: versionLabel(myLobby) }) : null;
  const versionCtl = showVersion ? {
    id: curVersion, editable: versionEditable, why: [versionEditable ? versionWhy : t('由创建者发起'), bannerText].filter(Boolean).join(' · ') || null,
    disabled: versionEditable ? !!versionWhy || !!busy : !Array.isArray(versions),
    onOpen: () => { setOpts(false); setVersionOpen(true); },
  } : null;
  // (a switch makes every page send its settings again, which share the server's budget of heavy messages with
  // room.proposeVersion: a RATE right after one is tried once more a moment later; the server's own 5 s pause after a
  // declined or expired vote answers RATE again and is told)
  const proposeVersion = async (version) => {
    const send = () => net.request('room.proposeVersion', { version });
    const sent = await run('version', async () => {
      try { await send(); } catch (err) {
        if (err?.code !== 'RATE') throw err;
        await new Promise((r) => setTimeout(r, PROPOSE_RETRY_MS));
        await send();
      }
    });
    if (sent && alive.current) setVersionOpen(false);
  };

  return html`<div class=${`screen room-screen rs${coop ? '' : ' rs--solo'}${big ? ' rs--big' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[room.difficulty] || 'var(--amber)'}; --n:${facts.seats.length}`}>
    <div class="rs__bg" aria-hidden="true"></div>
    <header class="topbar rs-top">
      <div class="topbar__left rs-top__left">
        <${Tooltip} text=${t('离开同盟')} placement="bottom">
          <button type="button" class="rs-exit" disabled=${busy === 'leave'} onClick=${leave} aria-label=${t('离开同盟')}><${Icon} name="exit" /></button>
        <//>
        <div class="rs-clock">
          <b>${modeName}${room.test ? html` <${TestMark} />` : null}<${VersionTag} room=${room} class="rs-clock__ver" />
            ${pluginMode ? html`<span class="rs-clock__sep"></span><span class="room-mode" data-testid="room-mode">${pluginMode}</span>` : null}
            ${big ? html`<span class="rs-clock__sep"></span><span class="room-capacity" data-testid="room-capacity-chip">${t('实验性 · {n} 人', { n: facts.seats.length })}</span>` : null}</b>
          <span class="rs-clock__ping">${t('当前延迟')}<${PingPill} ms=${conn.ping} online=${online} /></span>
        </div>
        <div class="rs-tools">
          <${Button} variant="secondary" size="sm" square=${true} icon="chart" class="stats-entry" onClick=${openStats} title=${t('统计数据')} aria-label=${t('统计数据')} />
          <${SettingsButton} class="room-settings" variant="secondary" square=${true} />
          <${AnnouncementButton} class="room-announce" variant="secondary" square=${true} />
          <${GuideButton} class="room-guide" variant="secondary" square=${true} />
        </div>
        <${PluginTag} room=${room} myId=${me.playerId} />
      </div>
      <div class="rs-top__right">
        <${LoadoutButton} from="room" size="md" class="hub-plate hub-plate--loadout rs-loadout room-loadout" label=${t('干员调配')} />
        ${coop ? html`<div class="rs-key">
          <span class="rs-key__k">${t('同盟密钥')}</span>
          <b class="rs-key__code num selectable" aria-label=${t('同盟密钥 {code}', { code: room.code })}>${room.code}</b>
          <button type="button" class="rs-key__copy" onClick=${() => copy('code')}>${t('复制')}</button>
          <button type="button" class="rs-key__link" onClick=${() => copy('link')} title=${t('复制邀请链接')} aria-label=${t('复制邀请链接')}><${Icon} name="link" /></button>
        </div>` : html`<div class="rs-key rs-key--solo"><${MicroLabel}>SINGLE OPERATOR<//><span>${t('仅限 1 名博士')}</span></div>`}
      </div>
    </header>

    <main class=${`seats rs-seats${coop ? '' : ' seats--solo'}`}>
      ${facts.seats.map((s, i) => {
        const op = seatOperator(s, cards, { myId: me.playerId, myCard });
        // the card's appearance: one's own shows this browser's picks at once (before the server echoes them), a
        // teammate's what that seat published (room.state seats[].cardAvatar / cardArt / cardFace / cardBg / cardBgY)
        const view = s && s.playerId === me.playerId
          ? { charId: myCard, art: myLook, avatar: myAvatar, face: myFace, bg: myBg, bgY: myBgY }
          : seatCardView(s);
        // the player's outfit for that operator (header "Outfits"); null = the default art.
        // 名片展示外观: the card's art when it has one — 精二 / 精一 / that operator's skin (ui/seatArt.js lookUrl);
        // a look leaves the outfit aside until 默认 clears it.
        const lookSrc = op && view.art ? lookUrl(data.get('assets'), op.chess.charId, view.art, 'portrait') : null;
        const skin = op ? seatCardSkin(s, op.chess.charId, { myId: me.playerId, localSkins, players: facts.occupied, otherSkins }) : null;
        const avatarSrc = view.avatar ? cardAvatarUrl(view.avatar, data.get('assets'), view.face) : null;
        return html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
          myId=${me.playerId} busy=${busy} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick} onInvite=${() => copy('code')}
          portrait=${op ? (lookSrc || chessPortraitUrl(data.get('assets'), op.chess, { skin })) : null}
          portraitDefault=${op && skin ? chessPortraitUrl(data.get('assets'), op.chess) : null} operator=${op?.chess}
          avatar=${avatarSrc} bg=${view.bg} bgY=${view.bgY}
          onPickCard=${() => setPicking('op')} onPickAvatar=${() => setPicking('avatar')} onPickBg=${() => setPicking('bg')}
          fresh=${shownRoom.current === room.code} bands=${bandList} onBotBand=${setBandSeat} />`;
      })}
      ${coop ? null : html`<aside class="solo-brief rs-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        <h2>${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''} <span class="num t-dim">${info.code}</span></h2>
        <p>${info.desc}</p>
        <ul>
          ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
          <li>${t('共')} <b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t('，满足条件时进入隐秘核心') : ''}</li>
          ${soloBrief ? html`<li>${t(soloBrief)}</li>` : null}
        </ul>
      </aside>`}
    </main>
    <${SpectatorBar} facts=${facts} myId=${me.playerId} busy=${busy} onRemove=${removeSpectator} onSit=${sit} />

    <${BotBandPicker} open=${bandSeat != null && !!facts.seats[bandSeat]?.isBot} seat=${bandSeat != null ? facts.seats[bandSeat] : null}
      seats=${facts.seats} bands=${bandList} busy=${busy === `band${bandSeat}`} dupes=${room.bandDupes === true} onClose=${() => setBandSeat(null)}
      onPick=${(bandId) => setBotBand(bandSeat, bandId)} />
    <${VersionVote} room=${room} />
    ${bannerText ? html`<p class="rs-verbanner" data-testid="version-banner"><${Icon} name="info" />${bannerText}</p>` : null}

    <footer class=${`room-bar rs-foot${opts ? ' is-opts' : ''}`}>
      <div class="rs-foot__left" aria-hidden="true"></div>
      <div class="rs-foot__center">
        <p class="rs-hint">${coop ? html`<span class="rs-ready num" title=${t('已就绪')}>${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}<b>${facts.readyHumans}</b>/${facts.humans.length}</span>` : null}<span class="room-bar__status">${statusLine}</span></p>
        <div class="rs-pill">
          <button type="button" class=${`rs-pill__diff${facts.isHost ? '' : ' is-ro'}`} disabled=${facts.isHost && !!busy} onClick=${openProto}
            title=${facts.isHost ? t('更改模拟难度') : t('由创建者选择')}><${DifficultyIcon} difficulty=${room.difficulty} />${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''}<span class="num rs-pill__code">${info.code}</span></button>
          ${versionCtl ? html`<${Tooltip} text=${versionCtl.why} class="rs-pill__version"><button type="button" class=${`rs-pill__ver${versionCtl.editable ? '' : ' is-ro'}`} data-testid="room-version"
            disabled=${versionCtl.disabled} onClick=${versionCtl.onOpen} aria-label=${t('游戏版本：{name}', { name: versionLabel(curVersion) })}><${Icon} name="book" /><span class="rs-pill__vername">${versionLabel(curVersion)}</span></button><//>` : null}
          <button type="button" class=${`rs-pill__gear${opts ? ' is-on' : ''}`} onClick=${() => setOpts((v) => !v)} title=${aiLast ? t('同盟设置') : t('模拟设置')} aria-label=${aiLast ? t('同盟设置') : t('模拟设置')}
            aria-expanded=${opts ? 'true' : 'false'}><${GearGlyph} /></button>
          ${opts ? html`<${RoomOptions} takeoverOption=${aiTakeoverOption(room, me.playerId)} onAiTakeover=${setAiTakeover} option=${aiLast} soloOption=${soloOpt} room=${room} isHost=${facts.isHost} busy=${busy} onAiLast=${setAiLast}
            dupesOption=${dupesOpt} onBandDupes=${setBandDupes}
            capOption=${capacityOption(room, me.playerId)} onCapacity=${setCapacity} duckOption=${duckLordOption(room, me.playerId)} onDuckLord=${setDuckLord}
            onConsole=${setConsole} consoleOpt=${consoleOpt} onSoloUnlimited=${setSoloUnlimited} onDifficulty=${openProto} onClose=${() => setOpts(false)} version=${versionCtl} />` : null}
        </div>
      </div>
      <div class="room-bar__right rs-foot__right">
        ${facts.isHost && searchable && facts.emptySeats > 0 && !searching
          ? html`<button type="button" class="rs-search" disabled=${!online || busy === 'match' || consoleOn || modded || big} onClick=${queueMatch}
              title=${modded ? t('房间启用了玩法插件，无法进入匹配队列') : consoleOn ? t('房间已开启开发者控制台，无法进入匹配队列') : big ? t('扩编房间不参与同盟匹配，请先把同盟人数调回 4 人') : undefined}>
              <${Icon} name="search" />${t('开始搜寻')}${busy === 'match' ? html`<${Spinner} size="sm" />` : null}</button>` : null}
        ${facts.isHost
          ? html`<${Tooltip} text=${facts.canStart ? null : vote ? t('切换版本投票进行中，请等投票结束') : !facts.contentReady ? (facts.versionRoom ? t('仍有博士未载入「{version}」的数据', { version: versionLabel(curVersion) }) : t('仍有博士未载入房间的插件内容')) : consentMissing(room, facts) ? t('仍有博士未同意受信任插件') : t('仍有博士未准备就绪')}>
              <${GoButton} label=${t('开始模拟')} loading=${busy === 'start'} disabled=${!facts.canStart || !online || busy === 'start' || !!vote} onClick=${start} />
            <//>`
          : facts.spectating
            ? html`<${GoButton} label=${t('观战中')} icon="eye" disabled=${true} />`
          : html`<${Tooltip} text=${!myReady && facts.myContent !== 'ready' ? (facts.versionRoom ? t('「{version}」的数据载入并通过校验后才能准备', { version: versionLabel(curVersion) }) : t('房间的插件内容载入并通过校验后才能准备')) : null}>
              <${GoButton} label=${myReady ? t('已就绪') : t('准备就绪')} ready=${myReady} loading=${busy === 'ready'}
                disabled=${!online || !facts.mine || busy === 'ready' || (!myReady && facts.myContent !== 'ready')} onClick=${toggleReady} />
            <//>`}
      </div>
    </footer>
    ${picking === 'op' ? html`<${OperatorPicker} title=${t('名片干员')} micro="SEAT CARD OPERATOR" current=${myCard} list=${cardList}
      m=${data.get('assets')} faceOf=${(c) => chessAvatarUrl(data.get('assets'), c, { skin: ownerSkin(c.charId, { localSkins }) })}
      autoLabel=${t('默认')} autoTitle=${t('按博士编号自动分配')}
      looks=${{ kind: 'portrait', current: myLook, onLook: pickLook }}
      note=${t('选择后，同盟里的博士都会看到这张立绘')}
      onPick=${pickCard} onClose=${() => setPicking(null)} />` : null}
    ${picking === 'avatar' ? html`<${CardAvatarPicker} current=${myAvatar} face=${myFace} list=${cardList} m=${data.get('assets')}
      onPick=${pickAvatar} onClose=${() => setPicking(null)} />` : null}
    ${picking === 'bg' ? html`<${NameCardPicker} current=${myBg} y=${myBgY} onPick=${pickBg} onAdjust=${pickBgY}
      onClose=${() => setPicking(null)} />` : null}
    ${offerShown ? html`<div class="rs-offer brackets" role="status">
      <div class="rs-offer__head"><${MicroLabel}>MATCH FOUND<//><h2>${t('队友已集结')}</h2></div>
      <${MatchmakingOffer} mm=${mm} online=${online} busy=${busy === 'accept-match'} onAccept=${acceptMatch} />
      ${facts.isHost ? html`<${Button} variant="ghost" disabled=${!!busy} onClick=${cancelMatch}>${t('停止搜寻')}<//>` : null}
    </div>` : null}
    ${searchShown && !offerShown ? html`<${SearchPanel} title=${matchmakingTitle(mm)} class=${`rs-searchpanel${searchLeaving ? ' is-leaving' : ''}`} elapsed=${searchElapsed}
      players=${mmView.matched} target=${mmView.target}
      onStop=${facts.isHost ? cancelMatch : null} stopping=${busy === 'cancel-match'}
      note=${facts.isHost ? t('搜寻期间可随时停止搜寻') : t('创建者正在搜寻队友')}
      tags=${[{ key: 'mode', label: t('精确搜寻'), icon: html`<${Icon} name="search" />` },
        { key: 'diff', label: t(DIFFICULTY_NAMES[room.difficulty]), color: DIFFICULTY_COLORS[room.difficulty], icon: html`<${DifficultyIcon} difficulty=${room.difficulty} />` }]}>
    <//>` : null}
    ${foundShown ? html`<${FoundPanel} class=${foundLeaving ? 'is-leaving' : ''} seats=${facts.seats.length} text=${t('同盟集结完毕')} />` : null}
    ${protoOpen ? facts.isHost
      ? html`<${ProtocolSelect} roomMode=${room.mode} difficulty=${protoPick || room.difficulty} onDifficulty=${setProtoPick} onClose=${closeProto}
          onCreate=${confirmDifficulty} busy=${busy === 'diff' ? 'create' : null} online=${online} action=${t('确认')} hint=${protoHint} difficulties=${protoDifficulties} />`
      : html`<${ProtocolSelect} roomMode=${room.mode} difficulty=${room.difficulty} onDifficulty=${() => {}} onClose=${closeProto}
          online=${online} readOnly=${true} difficulties=${protoDifficulties} />` : null}
    ${versionOpen && versionCtl ? html`<${VersionPicker} mode="room" versions=${versions || [{ id: curVersion, roomModes: [room.mode] }]} current=${curVersion}
      serverDefault=${serverDefault} roomMode=${room.mode} editable=${versionEditable && !versionWhy} busy=${busy === 'version'}
      note=${versionEditable ? versionWhy || (facts.humans.length > 1 ? t('其他博士同意后才会切换；切换后需要重新准备。') : null) : t('由创建者发起')}
      onPick=${proposeVersion} onClose=${() => setVersionOpen(false)} />` : null}
  </div>`;
}

// TrustedNotice is a persistent boot-time overlay (rendered above every route), so its implementation
// lives in screens/helpers.js — keeping it here would force the main chunk to import the whole room
// screen. Re-exported so any caller resolving it from the room module keeps working.
export { TrustedNotice } from './helpers.js';
