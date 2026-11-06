// Client entry: boot (fonts, identity, socket), net → store wiring, router, global overlays.
//
// Router (derived from the store, no URL routes):
//   not entered            → Title
//   m.public.phase ≠ LOBBY → Game (screens/game.js: briefing / band draft / match / result by phase)
//   room.inMatch           → Game (match starting, m.public on its way)
//   in a room              → Room
//   otherwise              → Lobby
// Deep link `?room=CODE`: remembered at boot, auto-joined once the player has entered and the
// session is online (after a short grace period in case the server restores a room on resume).
// Reloading a tab that already passed the title re-enters automatically (sessionStorage flag) and
// resumes the server session with the saved token; stale room/match state is dropped if the
// server does not re-push it within RESTORE_GRACE_MS after `welcome`. Boot waits for
// `identity.init()` (which token this tab may use without stealing another live tab's session)
// before the first connect; a page restored from the back/forward cache reloads.
// A `welcome` with a NEW playerId (the server restarted / the session expired) while a room or match was on screen:
// toast 「服务器会话已重置，上一局模拟已结束」 (store.js sessionResetNotice) and return to the lobby with nothing stale.
//
// Shared modules are imported relatively ('../../shared/…' resolves to /shared/… in the browser).
// Multi-device support (ui/device.js + css/devices.css): feature classes on <html>, no page zoom, safe areas, rotation
// re-layout; ui/compat.js polyfills are imported before anything else.
// 干员调配 (DESIGN §16): an overlay over any route (<LoadoutHost/>, opened from lobby / room / briefing); its loadout is
// kept in sync with the server by installLoadoutSync (room.loadout after every welcome and edit), its 干员持有 tab's
// not-owned list (0.2.0 补位) by installOwnershipSync (room.ownership, likewise), the 自选编队 picks (0.2.0 DIY) by
// installDiySync (room.diy, likewise; it also keeps welcome.diyKitted for the picker).
// Game data: every text of the game is static data (/data/*.json) downloaded once per page; the in-match files are
// warmed in the background as soon as the player is in a room (warmGameData), before the match needs them.
// Language (ui/lang.js, docs/I18N.md): chosen before the first render (initLang); App re-renders on a switch (useLang).
// Server texts are translated on arrival: m.toast / m.ticker frames (msgid + params, or the text as a msgid; a
// config.broadcasts line from its id + args), error codes (ui/toasts.js describeError) and room.closed reasons.
// Cosmetic plugins (DESIGN §32 P1a): installContent (content.js) lays the room's visual set and the player's personal
// plugins over the art manifest every screen reads. Gameplay plugins (§32.6): installContentSet (content.js) downloads and
// checks a room's content set and makes it the data every screen and the battle runner read.
// Official versions (DESIGN §35.23, versions.js): welcome.versions turns the lobby's version switch on; installContentSet
// also loads and checks the version the page shows (the lobby's choice, a room's version). A room whose version changes
// while a result is on screen drops that result (the server dropped the room's replay: its chess ids are the old
// version's), and a result that arrives after the room is gone keeps the version its frames name (m.result / m.public
// `version`, versions.js matchFrameVersion), also on a freshly loaded page that never saw the room.

// Polyfills first (older Safari / Firefox ESR): every module evaluated after this one sees them.
import './ui/compat.js';
import { ReleaseNotesHost } from './ui/releaseNotes.js';
import { render } from '../vendor/preact.module.js';
import { useErrorBoundary, useEffect, useState } from '../vendor/hooks.module.js';
import { html, UiHosts, Button, MicroLabel, closeAllDialogs } from './ui/components.js';
import { ConnectionBanner } from './ui/connBanner.js';
import { AnnouncementBanner } from './ui/announcement.js';
import { ToastHost, toast, toastError, describeError } from './ui/toasts.js';
import { net, identity, NetError } from './net.js';
import { MAX_SEATS } from '../../shared/constants.js';
import { store, useStore, emptyMatch, selectRoute, sessionResetNotice, isSpectating } from './store.js';
import { data, getChess } from './data.js';
import { GAME_FILES } from './ui/gameComponents.js';
// The title screen is the first thing a cold visitor sees, so it stays static in the entry. The other
// three screens (and their UI dependencies) load on demand (SCREEN_LOADERS below). Boot-time helpers
// and the persistent TrustedNotice overlay stay in the entry via screens/helpers.js — a light module
// that imports no screen component. Splitting only the screens the title does not need keeps the first
// paint on one request chain: a dynamic title would add a round trip right before the LCP element.
import { TitleScreen } from './screens/title.js';
import { sanitizeName, parseRoomParam, rememberRoom, joinKnown, TrustedNotice } from './screens/helpers.js';
import { preloadBootArt } from './ui/protocolBoot.js';
import { audio, installAudio } from './audio.js';
import { installLobbyMedia, matchMusic } from './ui/lobbyMedia.js';
import { settingsStore, updateSettings, useSettings } from './ui/settings.js';
import { skinsStore } from './ui/skins.js';
import { bindResourceCombat } from './resources/combat.js';
import { matchResourceUrls } from './resources/schedule.js';
import { ResourceHost } from './ui/resourcePanel.js';
import { GuideHost } from './ui/guide.js';
import { installDeviceSupport, useFullscreen, useScreenWakeLock } from './ui/device.js';
import { isCombatPhase } from './ui/gameLogic/phases.js';
import { registerImportedAssetWorker } from './assetCache.js';
import { LoadoutHost } from './screens/loadout.js';
import { StatsHost, useStatsOpen } from './screens/stats.js';
import { CoveredVersionVote } from './ui/versionVote.js';
import { NameHost } from './ui/nickname.js';
import { installRehearsal } from './battle/rehearsal.js';
import { recordResult, recordQuit, installStatsRecorder } from './ui/stats.js';
import { installLoadoutSync, installOwnershipSync, installDiySync, installSkinsSync, installCardSync, installSettingsViews, loadoutStore } from './ui/loadoutSync.js';
import { startBuildGuard } from './ui/buildGuard.js';
import { initLang, useLang, tickerText } from './ui/lang.js';
import { t, N_, translateWire } from '../../shared/i18n.js';
import { recordError, installTrafficMeter } from './diag.js';
import { installContent, installContentSet } from './content.js';
import { cosmetics } from './cosmetics.js';
import { seedAssets } from './assets.js';
import { sanitizeVersions, roomVersion, isDefaultVersion, matchFrameVersion } from './versions.js';

// CDN 配置由服务端在请求时生成（/js/asset-cdn.js，取 SP_ASSETS_CDN / SP_DATA_CDN，移植自用户分支）。
// 这里把它挂到 globalThis.__spAssetCdn 上，resourceUrl / 资源预载 / 渲染层再读；没有该模块（静态托管）时
// 保持同源路径。
import('/js/asset-cdn.js').then((m) => {
  if (globalThis.__spAssetCdn) return;
  const base = String(m.ASSETS_CDN || '').replace(/\/+$/, '');
  const dataBase = String(m.DATA_CDN || '').replace(/\/+$/, '');
  // 每文件指纹清单（服务端给的 `?v=<tag>`）：落地后 resourceUrl 会给每个素材补 `?v=<哈希>`，
  // 内容不变 URL 不变，CDN 与浏览器都按文件缓存。取不到就一直用不带版本的同源地址。
  const manifest = String(m.ASSETS_MANIFEST || '');
  if (base || dataBase || manifest) globalThis.__spAssetCdn = { base, dataBase, version: globalThis.__spAssetVersion || '', manifest };
  if (manifest && !globalThis.__spManifestReady) {
    globalThis.__spManifestReady = fetch(manifest).then((r) => (r.ok ? r.json() : null), () => null);
  }
}).catch(() => { /* 没有该模块（静态托管）时保持同源路径 */ });

const RESTORE_GRACE_MS = 1500;
const JOIN_DELAY_MS = 350;
const TICKER_KEEP = 20;
const EMOTE_KEEP = 20;

// ---- lazy screens ------------------------------------------------------------------------------
// Statically importing all four screens used to put the whole UI (lobby, room, game and their
// transitive dependencies) into the entry chunk — ~1.27 MB / 332 KB brotli, most of it unused by a
// cold visitor on the title screen. The title screen (the first paint) stays in the entry; the other
// three are their own chunks, warmed during idle so a screen switch never waits on the network. One
// shared promise per route: the preloader and the renderer never import a chunk twice.
const SCREEN_LOADERS = {
  title: () => Promise.resolve({ TitleScreen }), // already in the entry: no request before the LCP element
  lobby: () => import('./screens/lobby.js'),
  room: () => import('./screens/room.js'),
  game: () => import('./screens/game.js'),
};
const SCREEN_EXPORTS = { title: 'TitleScreen', lobby: 'LobbyScreen', room: 'RoomScreen', game: 'GameScreen' };
const screenPromises = new Map();  // route -> Promise<Component>
const screenResolved = new Map([['title', TitleScreen]]); // route -> Component (synchronous render after a warm)

/** @returns {string} a known route (unknown routes fall back to the lobby screen) */
function screenKey(route) { return SCREEN_LOADERS[route] ? route : 'lobby'; }

function loadScreen(route) {
  const key = screenKey(route);
  let p = screenPromises.get(key);
  if (!p) {
    p = SCREEN_LOADERS[key]()
      .then((m) => {
        const C = m[SCREEN_EXPORTS[key]];
        if (typeof C !== 'function') throw new Error(`screen ${key} has no ${SCREEN_EXPORTS[key]}`);
        screenResolved.set(key, C);
        return C;
      })
      .catch((err) => { screenPromises.delete(key); throw err; }); // allow a retry after a transient failure
    screenPromises.set(key, p);
  }
  return p;
}

/** Warm a screen chunk in the background. Idempotent, safe before the screen is ever rendered. */
function preloadScreen(route) {
  if (SCREEN_LOADERS[route]) void loadScreen(route).catch(() => {});
}

/** Resolve when every screen's chunk is warm (test hook; the idle preloader is the production path). */
function whenScreensReady() {
  return Promise.all(Object.keys(SCREEN_LOADERS).map((r) => loadScreen(r).catch(() => null)));
}

/** A screen-sized placeholder that continues the boot hex while a chunk loads (no layout flash). */
function ScreenFallback() {
  return html`<div class="screen" aria-hidden="true">
    <div class="boot__inner" style="margin:auto"><div class="boot__hex"></div></div>
  </div>`;
}

/** Loads (or synchronously reuses) the component for `route`. keyed by route in App so a switch remounts. */
function LazyScreen({ route }) {
  const key = screenKey(route);
  const [Screen, setScreen] = useState(() => screenResolved.get(key) || null);
  useEffect(() => {
    if (Screen) return undefined;
    let alive = true;
    loadScreen(key).then((C) => { if (alive) setScreen(() => C); })
      .catch((err) => { console.error('[app] screen chunk failed', key, err); });
    return () => { alive = false; };
  }, [key, Screen]);
  return Screen ? html`<${Screen} />` : html`<${ScreenFallback} />`;
}

/**
 * Warm the non-first screens once the title screen is stable, so the switch waterfall is masked.
 * Chained requestIdleCallbacks: one chunk request at a time, started only after `load` + a grace
 * window — the cold-load LCP must not compete with preload traffic. Also warms on hover / focus of
 * any element marked `data-preload-screen="room"` (and exposes __SP__.preloadScreen for explicit use).
 */
function installScreenPreload() {
  const order = ['lobby', 'room', 'game']; // title is static in the entry
  const idle = globalThis.requestIdleCallback
    ? (fn) => globalThis.requestIdleCallback(fn, { timeout: 4000 })
    : (fn) => setTimeout(fn, 200);
  const warmNext = (i) => {
    if (i >= order.length) return;
    idle(() => { preloadScreen(order[i]); warmNext(i + 1); });
  };
  const start = () => setTimeout(() => warmNext(0), 1500);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });

  const onIntent = (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest('[data-preload-screen]') : null;
    if (el) preloadScreen(el.getAttribute('data-preload-screen'));
  };
  document.addEventListener('pointerover', onIntent, { passive: true });
  document.addEventListener('focusin', onIntent, { passive: true });
  document.addEventListener('pointerdown', onIntent, { passive: true });
}

/** Copy of a server message without transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg; // eslint-disable-line no-unused-vars
  return rest;
}

function clearRoomParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

// ---- net → store wiring ---------------------------------------------------------------------------

let seq = 0;
let welcomeAt = 0;
let roomStateAt = 0;
let matchAt = 0;
let restoreTimer = null;
let joinTimer = null;
let joinInFlight = false;
/** The rehearsal installer (battle/rehearsal.js): its tasks follow the match on screen (see wireNet's store hook). */
let rehearsal = null;

function clearPendingJoin() {
  store.patch('ui', { pendingJoin: null });
  clearRoomParam();
}

/** Auto-join the deep-linked room once entered + online (idempotent). */
function schedulePendingJoin() {
  clearTimeout(joinTimer);
  joinTimer = setTimeout(async () => {
    const s = store.get();
    const code = s.ui.pendingJoin;
    if (!code || joinInFlight || !s.session.entered || net.status !== 'online') return;
    if (s.room) {
      if (s.room.code !== code) toast(t('你已在其他同盟中，请先离开当前同盟'), 'warn');
      clearPendingJoin();
      return;
    }
    joinInFlight = true;
    try {
      await joinKnown('room.join', code);
    } catch (err) {
      toastError(err);
    } finally {
      joinInFlight = false;
      clearPendingJoin();
    }
  }, JOIN_DELAY_MS);
}

/** End the post-resume "syncing" state early once the server re-pushed what we were showing. */
function maybeFinishRestore() {
  const s = store.get();
  if (!s.ui.restoring) return;
  const roomOk = !s.room || roomStateAt >= welcomeAt;
  const matchOk = !s.match.public || matchAt >= welcomeAt || !s.room?.inMatch;
  if (roomOk && matchOk) {
    clearTimeout(restoreTimer);
    store.patch('ui', { restoring: false });
  }
}

/**
 * Leave whatever room / match was on screen for the lobby with nothing stale left behind: open imperative dialogs,
 * the post-resume restore timer, ticker lines and emote bubbles of the old match (the battle runner and the 暂离 flag
 * follow the store themselves).
 */
function backToLobby() {
  identity.rememberMatch(null);
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  store.set({ room: null, match: emptyMatch(), ticker: [], emotes: [], chat: { ...store.get().chat, messages: [] } });
  store.patch('ui', { restoring: false });
}

/** The unofficial plugins a server counts in welcome / /healthz `content.plugins` (absent: none — DESIGN §32 P1a). */
const pluginCount = (content) => (content && Number.isInteger(content.plugins) && content.plugins > 0 ? content.plugins : 0);

function onWelcome(msg) {
  identity.saveToken(msg.token);
  identity.rememberMatch(null);
  const prev = store.get();
  const prevId = prev.me.playerId;
  const name = typeof msg.name === 'string' && msg.name ? msg.name : prev.me.name;
  identity.saveName(name);
  store.set({
    me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null },
    // the server's content identity (DESIGN §32): the diagnostics name it (diag.js contentLine)
    content: msg.content && typeof msg.content.vanilla === 'string' ? { vanilla: msg.content.vanilla } : null,
    // how many unofficial plugins it has (P1a — absent: none; content.js fetches the catalogue only when there are some)
    installedPlugins: pluginCount(msg.content),
    installedNotices: msg.content?.notices === true,
    testMode: msg.testMode === true,
    // the official versions the server enables (protocol §2; absent: the switch is off — versions.js)
    versions: sanitizeVersions(msg.versions),
  });
  welcomeAt = Date.now();

  if (msg.takeoverFrom === prevId && prevId != null) {
    toast(t('你已接管AI席位，资金、阵容与席位已保留'), 'info');
  } else if (prevId != null && prevId !== msg.playerId) {
    // A brand-new server session (the server restarted — crashed / killed, so no room.closed arrived — or this session
    // expired on it): whatever we showed before is gone — back to the lobby cleanly and say why.
    const notice = sessionResetNotice(prev, msg.playerId);
    backToLobby();
    if (notice) toast(t(notice), 'warn', { ttl: 7000 });
  } else if (prev.room || prev.match.public) {
    // Resumed session: the server re-pushes room/match state; drop whatever it doesn't.
    store.patch('ui', { restoring: true });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const s = store.get();
      const patch = {};
      if (s.room && roomStateAt < welcomeAt) patch.room = null;
      if (s.match.public && matchAt < welcomeAt) patch.match = emptyMatch();
      store.set(patch);
      store.patch('ui', { restoring: false });
    }, RESTORE_GRACE_MS);
  }
  schedulePendingJoin();
}

function onRoomState(msg) {
  const room = payload(msg);
  roomStateAt = Date.now();
  const myId = store.get().me.playerId;
  const seats = Array.isArray(room.seats) ? room.seats : [];
  if (myId != null && seats.length && !seats.some((s) => s && s.playerId === myId) && !isSpectating(room, myId)) {
    // We are no longer seated (kicked / left elsewhere) — neither in a player seat nor a spectator seat.
    if (store.get().room) toast(t('你已不在该同盟中'), 'warn');
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) store.set({ match: emptyMatch(), chat: { ...store.get().chat, messages: [] } });
  // The room switched its version (DESIGN §35.23): a result still on screen (a settlement, a spectator's view) names the old
  // version's chess ids, and the server dropped the room's replay — it closes, back to the room.
  else if (prevRoom && prevRoom.code === room.code && !room.inMatch && roomVersion(prevRoom) !== roomVersion(room) && store.get().match.public) store.set({ match: emptyMatch() });
  store.set({ room });
  identity.rememberMatch(room.inMatch && seats.some((seat) => seat?.playerId === myId)
    ? { name: store.get().me.name, code: room.code || '' } : null);
  if (room.mode === 'coop' && typeof room.code === 'string') rememberRoom(room.code, room.test === true);
  maybeFinishRestore();
}

const CLOSE_REASON = {
  // 'timeout' = this player was removed after staying disconnected past the lobby grace (server/lobby.js)
  host_left: N_('创建者已离开，同盟已解散'), timeout: N_('由于长时间断开连接，你已离开同盟'), empty: N_('同盟已解散'),
  kicked: N_('你已被移出同盟'), ended: N_('模拟已结束'), expired: N_('同盟已过期'), shutdown: N_('服务器维护中，同盟已关闭'),
  matchmaking_failed: N_('匹配未能启动，已返回大厅'),
  // 挂机移出 while offline (server/lobby.js matchRemoved): the next connection hears it here instead of m.removed
  afk: N_('连续多个回合没有任何操作，你已被移出对局'),
};

function wireNet() {
  net.on('status', (snap) => {
    if (snap.status !== 'online') store.set({ matchmaking: null });
    const cur = store.get().connection;
    store.set({
      connection: {
        status: snap.status, ping: snap.ping, attempt: snap.attempt, retryAt: snap.retryAt,
        lastError: snap.lastError, everOnline: cur.everOnline || snap.status === 'online',
      },
    });
  });
  net.on('clock', (c) => store.set({ clock: { offset: c.offset, rtt: c.rtt, synced: c.synced } }));
  net.on('welcome', onWelcome);
  net.on('helloError', (err) => {
    if (err.code === 'SESSION_IN_USE') identity.rejectToken();
    toastError(err);
  });
  net.on('replaced', () => toast(t('该身份已在其他页面登录，本页已断开'), 'warn', { ttl: 6000 }));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  // 匹配队列 (server/matchmaking.js, 移植自用户分支): `queue.state` 是一张票据的完整快照,从不是增量。
  // Hub 屏读同一形状 — { status: 'searching', players, target, joinedAt } — 映射在这里: waitingCount 是票据
  // 所在池子里真正能与本队合并的等待人数(含本队,已按队伍大小与 experimental 兼容桶过滤),required 是该池子的容量。报价帧多带 { offerId, accepted }: 确认入场答 queue.accept。
  net.on('queue.state', (msg) => {
    const previous = store.get().matchmaking;
    if (previous && msg.reason && (previous.offerId || previous.reason !== msg.reason)) {
      const continuing = msg.state === 'queued';
      if (msg.reason === 'confirmation_timeout' || msg.reason === 'unconfirmed') {
        toast(continuing ? t('有队友未确认，已继续搜寻') : t('入场确认未完成，已退出搜寻，请重新发起匹配'), 'warn');
      } else if (msg.reason === 'peer_cancelled' || msg.reason === 'peer_disconnected') {
        toast(t('有队友离开，已继续搜寻'), 'warn');
      } else if (msg.reason === 'allocation_failed' || msg.reason === 'allocation_timeout') {
        toast(continuing ? t('对局准备失败，已继续搜寻') : t('匹配未能启动，已返回大厅'), 'warn');
      } else if (msg.reason === 'expired') {
        toast(continuing ? t('排队等待超时，已继续搜寻') : t('排队等待超时，已退出搜寻，请重新发起匹配'), 'warn');
      } else if (msg.reason === 'unavailable') {
        toast(continuing ? t('有队友状态变化，已继续搜寻') : t('匹配状态已失效，请重新发起匹配'), 'warn');
      }
    }
    // 出价时池里已经没有等待人数(waitingCount 只在 queued 帧上),用 required 报「一组已凑满」。
    const queue = { ...payload(msg), status: 'searching',
      players: msg.waitingCount ?? (msg.state === 'offered' ? msg.required : null) ?? msg.partySize ?? 1,
      target: msg.required || MAX_SEATS };
    if (msg.state === 'queued' || msg.state === 'offered') { store.set({ matchmaking: queue }); return; }
    store.set({ matchmaking: null });
  });
  net.on('room.closed', (msg) => {
    backToLobby();
    const known = Object.hasOwn(CLOSE_REASON, String(msg.reason)) ? CLOSE_REASON[msg.reason] : null;
    toast(known ? t(known) : typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭'), 'warn');
  });
  net.on('m.public', (msg) => { matchAt = Date.now(); store.patch('match', { public: payload(msg) }); maybeFinishRestore(); });
  net.on('m.private', (msg) => { matchAt = Date.now(); store.patch('match', { private: payload(msg) }); });
  net.on('m.layer', (msg) => {
    const s = store.get();
    if (selectRoute(s) === 'game' && msg.playerId === s.me?.playerId) audio.layerGain(msg.bondId, msg.add);
  });
  net.on('m.field', (msg) => store.patch('match', { field: payload(msg) }));
  net.on('m.result', (msg) => {
    const res = payload(msg);
    store.patch('match', { result: res });
    // 本机统计 (PR #323): every arrival, including the lobby's result replay after a reconnect / reload —
    // replays dedupe by content id inside recordResult (spectator seats' copies build no record at all)
    // (`vs`: the room's cosmetic plugins, recorded — such a match still counts as the original game: ui/stats.js)
    // (`content`: the room's content set when it played gameplay plugins — such a match is unofficial: ui/stats.js)
    // (`version`: the official version the match played, DESIGN §35.23 — the room's, or the result's own `version` when
    // it arrives after the room is gone, also to a freshly loaded page; only a non-default one is written)
    const s = store.get();
    const version = s.room ? roomVersion(s.room) : matchFrameVersion({ result: res, public: s.match.public });
    if (s.room?.test !== true && s.match.public?.test !== true) recordResult(res, { myId: s.me.playerId, roomMode: s.room?.mode ?? null, vs: s.room?.content?.vs ?? null, content: s.room?.content ?? null, version: isDefaultVersion(version) ? null : version, now: Date.now() });
  });
  // 投票移出 / 挂机移出 (server/match/match/kickVote.js, 移植自用户分支): this seat left the match for good — the server
  // already detached it (no room.leave to grant), so the page records the run as a quit and returns to the lobby.
  net.on('m.removed', async (msg) => {
    const rounds = Number.isInteger(msg.rounds) && msg.rounds > 0 ? msg.rounds : 2;
    const before = store.get();
    try { await net.request('room.leave', {}); } catch { /* already out of the room */ }
    if (!store.get().match.result) {
      try { recordQuit(before); } catch (err) { console.warn('[stats] quit record failed', err); }
    }
    backToLobby();
    toast(msg.reason === 'kicked' ? t('你掉线期间被队友投票移出了对局') : t('连续 {n} 回合没有任何操作，你已被移出对局', { n: rounds }), 'warn', { ttl: 10000 });
  });
  // 挂机移出: everyone still in the match hears who the rule removed (server MatchPlatform._removeIdle)
  net.on('m.notice', (msg) => {
    if (msg.kind !== 'afkRemoved') return;
    const rounds = Number.isInteger(msg.rounds) && msg.rounds > 0 ? msg.rounds : 2;
    toast(t('{name} 连续 {n} 回合没有任何操作，已被移出对局', { name: typeof msg.name === 'string' && msg.name ? msg.name : t('博士'), n: rounds }), 'info', { ttl: 6000 });
  });
  net.on('m.toast', (msg) => {
    const kind = ['info', 'success', 'warn', 'error'].includes(msg.kind) ? msg.kind : 'info';
    // msgid + params (server ≥ 0.2.0) or the text itself as a msgid, in the current language
    toast(translateWire(msg), kind);
  });
  net.on('m.ticker', (msg) => {
    if (typeof msg.text !== 'string') return;
    const text = tickerText(msg);
    // type, player + the round it came in: a BOSS_HIT line is dropped once its boss round is over and superseded by the
    // same player's next one (ui/ticker.js tickerLineLive / tickerSupersedes)
    const type = typeof msg.type === 'string' ? msg.type : null;
    const playerId = typeof msg.playerId === 'string' ? msg.playerId : null;
    // its broadcast priority: the strip plays the highest first (ui/ticker.js enqueueTickerLines)
    const priority = Number.isFinite(msg.priority) ? msg.priority : 0;
    store.set((s) => ({ ticker: [...s.ticker.slice(-(TICKER_KEEP - 1)), { id: ++seq, text, at: Date.now(), type, playerId, round: s.match?.public?.round ?? null, priority }] }));
  });
  net.on('m.emote', (msg) => {
    store.set((s) => ({ emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, id: msg.id, at: Date.now() }] }));
  });
  // 局内聊天 (合并自用户分支): the panel keeps the full history; only a live broadcast pops an avatar bubble —
  // resynced history (m.chatState.messages) must never bubble again.
  net.on('m.chatState', (msg) => {
    const remaining = Math.max(0, Number(msg.mutedUntil) - Number(msg.serverTime));
    store.patch('chat', { enabled: msg.enabled === true, mutedUntil: Number(msg.mutedUntil) || 0,
      deadline: performance.now() + (Number.isFinite(remaining) ? remaining : 0),
      ...(Array.isArray(msg.messages) ? { messages: msg.messages.slice(-50) } : {}) });
  });
  net.on('m.chat', (msg) => {
    if (typeof msg.text !== 'string' || typeof msg.name !== 'string') return;
    store.set((s) => ({
      chat: { ...s.chat, messages: [...s.chat.messages.filter(m => m.id !== msg.id).slice(-49), payload(msg)] },
      ...(!s.chat.messages.some(m => m.id === msg.id) ? {
        emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, text: msg.text, at: Date.now() }],
      } : {}),
    }));
  });

  // Entering (title → lobby) while already online also needs the deep-link join.
  store.subscribe((s, prev) => {
    if (s.session.entered && !prev.session.entered) schedulePendingJoin();
    // in a room (co-op or solo, also a resumed one) a match is near: its data starts downloading
    if (s.room && !prev.room) warmGameData();
    // the match on screen is over (left, closed, kicked, a new session): a rehearsal task of it is dead, and the frame
    // that cancels it may never arrive (a disposed match sends nothing) — the page stops what it is running itself
    if (selectRoute(prev) === 'game' && selectRoute(s) !== 'game') rehearsal?.clear();
  });
}

/**
 * Download every data file of the match UI (gameComponents GAME_FILES: operators, skills, bonds, items, enemies, 特质 …)
 * and the pre-game sprites in the background once the player is in a room — a match is near (the lobby alone never
 * downloads them). The game's
 * texts are static data loaded once per page — never fetched during a match — and the match screen waits for these
 * files, so with them warmed it opens at once and no text ever appears late (user playtest #3 item 9). Idempotent (the
 * data store shares each file's promise).
 */
function warmGameData() {
  // a room with gameplay plugins: content.js downloads its content set's files instead (DESIGN §32.6). With the art list
  // in, the pre-game sprites (协议启动！ and the 请选择策略 band, ui/protocolBoot.js) start too: a solo player who starts
  // at once and skips through the briefing meets the band draft's first turn with them at hand (§35.18's leftover)
  // Another official version's room (DESIGN §35.23): its version set brings those files (content.js) — the server's
  // default ones would race it; only the art list the sprites need is fetched.
  const go = () => {
    const room = store.get().room;
    if (room?.content?.vanilla === false) return;
    if (typeof room?.version === 'string') { data.load('assets').then(() => preloadBootArt(), () => {}); return; }
    data.loadAll(GAME_FILES).then(() => preloadBootArt(), () => {});
  };
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(go, { timeout: 2500 });
  else setTimeout(go, 600);
}

// ---- UI chrome (the connection banner lives in ui/connBanner.js) -----------------------------------

function ScreenCrashed({ error, reset }) {
  return html`<div class="screen crash">
    <div class="crash__box brackets">
      <${MicroLabel} tone="mint">SYSTEM FAULT<//>
      <h2>${t('界面发生错误')}</h2>
      <p class="t-lo">${String(error?.message || error).slice(0, 200)}</p>
      <${Button} variant="primary" icon="refresh" onClick=${reset}>${t('重新加载界面')}<//>
    </div>
  </div>`;
}

function App() {
  const route = useStore(selectRoute);
  const combatActive = useStore((s) => selectRoute(s) === 'game' && s.room?.inMatch === true
    && !s.match?.result && isCombatPhase(s.match?.public?.phase));
  const fullscreenWakeLock = useStore((s) => s.fullscreenWakeLock, Object.is, settingsStore);
  const fullscreenActive = useFullscreen();
  useScreenWakeLock(combatActive || (fullscreenWakeLock && fullscreenActive));
  useLang(); // a language switch re-renders the whole tree in place
  const [error, resetError] = useErrorBoundary((err) => console.error('[ui] screen crashed', err));
  return html`<div class="app-root">
    <div class="app-bg" aria-hidden="true"></div>
    ${error ? html`<${ScreenCrashed} error=${error} reset=${resetError} />` : html`<${LazyScreen} key=${route} route=${route} />`}
    <${TrustedNotice} />
    <${ConnectionBanner} />
    <${AnnouncementBanner} />
    <${ToastHost} />
    <${UiHosts} />
    <${GuideHost} />
    <${ReleaseNotesHost} />
    <${NameHost} />
    <${LoadoutHost} />
    <${StatsHost} />
    <${ResourceManagerHost} />
    <${VoteOverOverlays} />
  </div>`;
}

/** 资源管理面板（移植自用户分支,ui/resourcePanel.js):设置 → 预载资源的宿主,渲染 resourceState()。 */
function ResourceManagerHost() {
  const settings = useSettings();
  // 干员皮肤 is two switches: the master follows whatever 干员调配 has equipped — the choice list lives
  // there, not here — and 「全部皮肤」 widens that to every outfit the manifest offers. 官方特效 has one switch of its
  // own (docs/ASSETS.md): ~185 MiB of effect prefabs, textures and meshes, never implied by 额外资源.
  return html`<${ResourceHost} enabled=${settings.preload} optional=${settings.preloadOptional} voices=${settings.preloadVoices} allVoices=${settings.preloadAllVoices}
    voiceLang=${settings.voiceLang} voicePreloadLanguages=${settings.preloadVoiceLanguages}
    onVoiceLanguages=${(v) => updateSettings({ preloadVoiceLanguages: v, preloadAllVoices: false })} skinPreload=${settings.preloadSkins}
    skinPreloadAll=${settings.preloadSkinsAll}
    fxPreload=${settings.preloadFx}
    onChange=${(v) => updateSettings({ preload: v })} onOptional=${(v) => updateSettings({ preloadOptional: v })}
    onFxPreload=${(v) => updateSettings({ preloadFx: v })}
    onVoices=${(v) => updateSettings({ preloadVoices: v })} onPreset=${updateSettings}
    onAllVoices=${(v) => updateSettings({ preloadAllVoices: v })}
    onSkinPreload=${(v) => updateSettings({ preloadSkins: v })}
    onSkinPreloadAll=${(v) => updateSettings({ preloadSkinsAll: v })} />`;
}

/** The room's version vote above 干员调配 / 统计数据 while one covers the room (ui/versionVote.js CoveredVersionVote). */
function VoteOverOverlays() {
  const lo = useStore((s) => !!s.open, Object.is, loadoutStore);
  const st = useStatsOpen();
  return html`<${CoveredVersionVote} covered=${lo || st} />`;
}

// ---- boot -----------------------------------------------------------------------------------------

async function waitForFonts(ms) {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const loads = [
    fonts.load('900 1em "Noto Sans SC"', '卫戍协议盟约'), // i18n-ignore (font sample)
    fonts.load('700 1em "Noto Sans SC"', '开始'), // i18n-ignore (font sample)
    fonts.load('700 1em Bender', '0123456789'),
    fonts.load('700 1em Rajdhani', '0123456789'),
  ].map((p) => p.catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))]);
}

/** 本浏览器当前装备的皮肤键(ui/skins.js 的 charId→skinId 映射;用户分支的 equippedSkinKeys 适配版):
 * 预载跟随这些皮肤,换皮肤自动补拉。 */
const equippedSkinKeys = () => {
  const skins = skinsStore.get().skins;
  return skins && typeof skins === 'object' ? Object.values(skins).filter((v) => typeof v === 'string' && v) : [];
};

function installResourcePreload() {
  // Resume only when the player enabled preload; a saved pause survives page reloads.
  import('./resources/index.js').then((r) => {
    // 干员皮肤: with `preloadSkins` on, the preload follows the outfits equipped in this browser — picking one in
    // 干员调配 is what starts its download — and `preloadSkinsAll` replaces that scope with every outfit
    // in the manifest. The chess table resolves chessId → charId, so an equipped choice has no manifest key to follow
    // until it is in; that one load re-applies the scope below.
    const apply = (s) => {
      const keys = s.preloadSkins ? equippedSkinKeys() : [];
      const all = !!(s.preloadSkins && s.preloadSkinsAll);
      // 官方特效 rides its own switch: it is not part of `preloadOptional` in either direction.
      r.syncResources(s.preload, s.preloadOptional, s.voiceLang, s.preloadAllVoices, { keys, all, fx: s.preloadFx, voices: s.preloadVoices, voiceLanguages: s.preloadVoiceLanguages })
        .catch((err) => console.warn('[resources] sync failed', err));
    };
    // Installed before the enabled settings sync: a page restored straight into a fight must not briefly
    // start bulk downloads (public/js/resources/combat.js).
    bindResourceCombat(store, r, (err) => console.warn('[resources] combat gate failed', err));
    apply(settingsStore.get());
    settingsStore.subscribe(apply);
    // Equipping a different skin changes what the preload wants, with no settings change to announce it.
    skinsStore.subscribe(() => apply(settingsStore.get()));
    let timer;
    const priority = () => {
      const s = store.get();
      r.updateResourcePriority({ active: selectRoute(s) === 'game',
        urls: matchResourceUrls(s.match, data.get('assets'), getChess, data.get('local')) });
    };
    const schedule = () => { timer ??= setTimeout(() => { timer = null; priority(); }, 300); };
    store.subscribe((s, prev) => {
      if (s.match.public !== prev.match.public || s.match.private !== prev.match.private || s.match.field !== prev.match.field) schedule();
    });
    data.subscribe((name) => { if (['assets', 'local', 'chess'].includes(name)) schedule(); });
    priority();
  }).catch((err) => console.warn('[resources] unavailable', err));
}

function installGlobalErrorHandlers() {  window.addEventListener('unhandledrejection', (ev) => {
    const err = ev.reason;
    // Media autoplay/abort rejections (audio.play() before a user gesture, interrupted loads) are
    // expected browser behaviour, not app errors: log quietly, never toast.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) { console.warn('[app] ignored rejection', err.name); return; }
    console.error('[app] unhandled rejection', err);
    recordError('rejection', err);
    if (err instanceof NetError) toastError(err);
    else toast(t('发生意外错误：{error}', { error: describeError(err) }).slice(0, 120), 'error');
  });
  window.addEventListener('error', (ev) => {
    if (!(ev instanceof ErrorEvent)) return; // resource load errors are not script errors
    console.error('[app] uncaught error', ev.error || ev.message);
    recordError('error', ev.error || ev.message, ev.error ? null : `${ev.filename || '?'}:${ev.lineno || 0}:${ev.colno || 0}`);
  });
}

async function boot() {
  installGlobalErrorHandlers();
  // what this page downloads, by category, for the 问题反馈 report's traffic line (diag.js; nothing is sent anywhere)
  installTrafficMeter();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  // 卫戍协议：盟约 的开场动画（ui/entryFilm.js），标题页之前；恢复进房间 / 对局的页面不播。
  // 这里就启动导入：模块一求值就 warmEntryFilm，把 8 张 sprite 的请求发出去；boot 后面还要等字体 / 连接 / 语言，
  // 这段时间正好下载。过去等到标题页渲染后才导入，播放前那次 1.2s 的预载总是撞上标题页的素材高峰而跳过，film
  // 一直不播（移植后在本机的实测修复，维护者 2026-11-05）。
  const entryFilm = import('./ui/entryFilm.js')
    .catch((err) => { console.warn('[app] entry film unavailable', err); return null; });
  // Hashed art a player imported. HTTPS or localhost only; a failure here must not stop boot.
  void registerImportedAssetWorker();
  // A page restored from the back/forward cache has a dead socket and a stale token choice: start over.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  // Pick this tab's reconnect token (asks other live tabs; ≤150 ms) while fonts load.
  const identityReady = identity.init();

  const pendingJoin = parseRoomParam(location.search);
  const savedName = sanitizeName(identity.loadName());
  const entered = identity.wasEntered() && !!savedName;
  store.set((s) => ({
    me: { ...s.me, name: savedName },
    session: { entered },
    ui: { ...s.ui, pendingJoin },
  }));

  wireNet();
  installStatsRecorder(store); // follows the match on screen, so a 放弃模拟 can be recorded (ui/stats.js)
  // the loadout / 干员持有 / 自选 settings by operator, shown for the data on screen (DESIGN §35.23; a v1 store migrates)
  installSettingsViews();
  installLoadoutSync({ net });
  installOwnershipSync({ net });
  installDiySync({ net });
  // 干员皮肤 (docs/SKINS.md): keeps the server's copy of this browser's chosen appearances current (room.skins), from
  // ui/skins.js' own store — its 皮肤 section is rendered by screens/loadout.js.
  installSkinsSync({ net });
  // 名片干员 (PR #643 split 6): the operator on this browser's seat card (room.card, ui/seatArt.js cardStore) — after every
  // welcome, pick and content change, with the engine's retries (the room screen only reads and sets the pick)
  installCardSync({ net });
  // the room's cosmetic plugins and the player's own over the art manifest (content.js; nothing is fetched without them)
  installContent({ toast });
  // a room with gameplay plugins: its content set downloaded, checked and shown (content.js — DESIGN §32.6)
  installContentSet({ toast });
  // A bot prep's layout rehearsal the server offers this host's browser (DESIGN §14, SP_BOT_REHEARSAL=host on the
  // server): a same-origin module Worker simulates the candidates off the main thread and answers with its pick; a
  // browser that cannot run one answers `error` and the server rehearses itself. Nothing happens while the server
  // does not delegate. A gameplay-plugin room is never offered (the server keeps that rehearsal).
  rehearsal = installRehearsal({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM follows the route / match phase (js/audio.js).
  // a cosmetic plugin's sound that will not load falls back like its art (content.js, DESIGN §32 P1a)
  installAudio({ getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute, settings: settingsStore.get(),
    onFailed: (url) => cosmetics.fail(url) });
  // …and the music follows the art: the screen's track again when the cosmetic layers change its URLs
  cosmetics.subscribe(() => audio.refreshBgm());
  // 自定义大厅背景与音乐 (ui/lobbyMedia.js): the player's own files of this browser, the music from the title on
  installLobbyMedia();
  // 对局自选曲 (js/bgmChoice.js): read at boot, so a page that resumes a match never waits for the settings modal
  matchMusic.load();
  // 资源预载(移植自用户分支,public/js/resources/index.js):按设置的分包/语音/皮肤/特效范围
  // 下载并进 Cache Storage;战斗期自动暂停。从不阻塞进入或进行一场对局。
  installResourcePreload();
  // Adopt the manifest data.js already parsed (2.6 MiB) for the browser art store instead of downloading it a second
  // time on the first battle; getRaw skips the cosmetic layers content.js lays over it.
  data.load('assets').then(() => seedAssets(data.getRaw('assets')))
    .catch((err) => console.warn('[app] could not seed the art manifest', err));
  // Warm the data cache in the background (missing files are tolerated).
  data.loadAll('config').catch(() => {});
  // Optional local-client art manifest (emotes, tutorial pages, official UI sprites; DESIGN §13).
  data.load('local').catch(() => {});

  const connectWhenReady = identityReady.then(() => {
    if (entered) net.setName(savedName);
    else net.connect();
  });
  // the language (and its UI translations) before the first render: no Chinese flash for an English player
  const langReady = initLang().catch((err) => console.warn('[app] language setup failed', err));
  await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);
  const root = document.getElementById('app');
  render(html`<${App} />`, root);
  // Warm the other screen chunks once this first paint is stable; the preloader deliberately waits
  // for `load` + a grace window so its requests never compete with the cold-load LCP.
  installScreenPreload();

  const splash = document.getElementById('boot');
  if (splash) {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 300);
  }
  // 卫戍协议：盟约 的开场动画（ui/entryFilm.js），标题页之前；恢复进房间 / 对局的页面不播
  entryFilm
    .then((m) => m?.playEntryFilm({ skip: () => selectRoute(store.get()) === 'game' }))
    .catch((err) => console.warn('[app] entry film unavailable', err));
  globalThis.__SP__ = { store, net, data, version: 1,
    preloadScreen, whenScreensReady, screensWarm: () => [...screenResolved.keys()] };
  // A page keeps the modules it imported at load time for its whole lifetime, so a deploy cannot reach an open tab
  // (ui/buildGuard.js): watch `/healthz.build`. Outside a match the page reloads itself; during a match the guard says
  // so instead (the connection banner offers 刷新页面) and reloads once the match — settlement screen included — is over,
  // so a running game is never thrown away.
  try {
    startBuildGuard({
      inMatch: () => selectRoute(store.get()) === 'game',
      onStale: ({ waiting }) => { if (waiting) store.patch('ui', { buildStale: true }); },
      // the same /healthz names how many plugins the server has: the title screen shows it before any hello
      onHealth: (h) => {
        const n = pluginCount(h.content), notices = h.content?.notices === true;
        if (n !== store.get().installedPlugins || notices !== store.get().installedNotices) store.set({ installedPlugins: n, installedNotices: notices });
      },
    });
  } catch (err) {
    console.warn('[app] build guard failed to start', err);
  }
}

boot().catch((err) => {
  console.error('[app] boot failed', err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = t('启动失败，请刷新页面重试');
});
