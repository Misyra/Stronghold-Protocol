// Room screen (同盟等待室): 4 seat cards (avatar frame, name, ready state, AI badge, host crown),
// host controls (difficulty picker, add/remove AI and the 「AI 队友最后选择」 switch in co-op, start), invite code with
// copy code / copy link, ready toggle and leave.
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.
// Spectator seats (community report #26, a remake feature): a co-op room with spectators shows the 观战席 strip under
// the seats — names, offline marks, the host's ✕ (room.removeSpectator) — and a spectator's own view swaps the ready
// button for 观战中 and offers 入座 (room.join of the room) while a player seat is free.
// Texts go through t() (docs/development/I18N.md).

import { AnnouncementButton } from '../ui/announcement.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, MAX_SPECTATORS } from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyTag, DifficultyIcon, Tooltip, confirmDialog, doctorNo,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { SettingsButton } from '../ui/settings.js';
import { LoadoutButton } from './loadout.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating } from '../store.js';
import { initialShare, shareAfterSubmit, shareAfterStatus, shareView, SHARE_POLL_MS, SHARE_POLL_TRIES } from '../ui/roomShare.js';
import { difficultyInfo } from './lobby.js';
import { t, tc } from '../../../shared/i18n.js';

/**
 * The room's 统计 / 设置 / 公告 / 玩法说明 entries. Icon-only squares on every device, in a co-op room and in
 * a solo simulation alike (xinhai ba744327: the compact layer scales one shape, not two), so the component no
 * longer branches on the room kind — title / aria-label carry the name and the action is unchanged.
 */
export function RoomTools() {
  return html`<div class="room-topbar__tools">
    <${Button} variant="secondary" size="sm" square=${true} icon="chart" class="stats-entry room-tools" onClick=${openStats}
      title=${t('统计数据')} aria-label=${t('统计数据')} />
    <${SettingsButton} class="room-settings room-tools" variant="secondary" square=${true} label=${t('设置')} />
    <${AnnouncementButton} variant="secondary" square=${true} class="room-tools" />
    <${GuideButton} class="room-guide room-tools" variant="secondary" square=${true} label=${t('玩法说明')} />
  </div>`;
}

/**
 * Seats padded to the room's capacity (co-op 4, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
export function normalizeSeats(room) {
  const cap = room?.mode === 'solo' ? 1 : MAX_SEATS;
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
  const searching = !!room?.matchmaking;
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady, searching,
    emptySeats: seats.filter((s) => !s).length,
    canStart: isHost && othersReady && !!mine && !searching,
    canMatch: isHost && othersReady && !!mine && mine.connected !== false && !searching && room?.mode === 'coop' &&
      occupied.length < MAX_SEATS && occupied.every((s) => !s.isBot),
    othersReady,
    // spectator seats (never players: not in `humans`, never counted for ready / start)
    spectators: Array.isArray(room?.spectators) ? room.spectators.filter((s) => s && typeof s === 'object') : [],
    spectating: isSpectating(room, myId),
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

function SeatCard({ seat, index, room, facts, myId, busy, onAddBot, onRemoveBot, onKick }) {
  const coop = room.mode !== 'solo';
  if (!seat) {
    const canAdd = coop && facts.isHost;
    return html`<article class="seat seat--empty" style=${`--seat-i:${index}`}>
      <header class="seat__head"><span class="seat__no num">P${index + 1}</span><${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//></header>
      <div class="seat__art seat__art--empty">
        <div class="seat__radar" aria-hidden="true"></div>
        <span class="seat__wait">${t('等待博士加入')}</span>
        <${MicroLabel}>AWAITING DOCTOR<//>
      </div>
      <footer class="seat__foot">
        ${canAdd
          ? html`<${Button} variant="secondary" size="sm" icon="robot" block=${true} disabled=${facts.searching || room.allowBots === false} loading=${busy === `add`} onClick=${onAddBot}
              title=${room.allowBots === false ? t('当前服务器禁止添加 AI 队友') : undefined}>${room.allowBots === false ? t('AI 队友已禁用') : t('添加 AI 队友')}<//>`
          : html`<span class="seat__state t-dim">${t('空位')}</span>`}
      </footer>
    </article>`;
  }
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  // The host never needs to toggle ready: starting the match readies them (server rule).
  const state = offline ? 'offline' : seat.ready || seat.isBot ? 'ready' : isHostSeat ? 'host' : 'waiting';
  return html`<article class=${`seat brackets${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${seat.isBot ? ' is-bot' : ''} is-${state}`}
      style=${`--seat-i:${index}`}>
    <header class="seat__head">
      <span class="seat__no num">P${index + 1}</span>
      <${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//>
      ${isHostSeat ? html`<span class="seat__host"><${Icon} name="crown" />${t('创建者')}</span>` : null}
    </header>
    <div class="seat__art">
      <div class="seat__stripes" aria-hidden="true"></div>
      <${AvatarFrame} size="xl" name=${seat.name} seat=${index} bot=${seat.isBot} self=${isMe} ready=${state === 'ready'} offline=${offline} />
      ${seat.isBot ? html`<span class="seat__bot-label"><${Icon} name="robot" />${t('AI 队友')}</span>` : null}
    </div>
    <div class="seat__who">
      <span class="seat__name">${seat.name || t('博士')}</span>
      ${isMe ? html`<span class="seat__you">${t('你')}</span>` : null}
    </div>
    <${MicroLabel}>${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}<//>
    <footer class="seat__foot">
      <span class=${`seat__state seat__state--${state}`}>
        ${state === 'ready' ? html`<${Icon} name="check" />${t('已就绪')}`
          : state === 'offline' ? html`<${Icon} name="wifiOff" />${t('连接中断')}`
          : state === 'host' ? html`<${Icon} name="crown" />${t('待命中')}`
          : html`<${Icon} name="hourglass" />${t('准备中')}`}
      </span>
      ${seat.isBot && facts.isHost ? html`<${Tooltip} text=${t('移除该 AI 队友')}>
        <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rm${index}`} onClick=${() => onRemoveBot(index)} aria-label=${t('移除 AI 队友')} />
      <//>` : null}
      ${!seat.isBot && !isMe && facts.isHost ? html`<${Tooltip} text=${t('将该博士移出同盟')}>
        <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `kick${index}`} onClick=${() => onKick(index, seat.name, seat.playerId)} aria-label=${t('移出该博士')} />
      <//>` : null}
    </footer>
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

function InviteBox({ code, name, difficulty }) {
  const copy = async (what) => {
    // the copied link carries an invitation line (#103): 「{name}邀请你加入卫戍协议：盟约【{difficulty}】」
    const invite = t('{name}邀请你加入卫戍协议：盟约【{difficulty}】', { name: name ?? '', difficulty: DIFFICULTY_NAMES[difficulty] ? t(DIFFICULTY_NAMES[difficulty]) : '' });
    const ok = await copyText(what === 'code' ? code : `${inviteLink(code)} ${invite}`);
    if (ok) toast(what === 'code' ? t('已复制同盟密钥 {code}', { code }) : t('已复制邀请链接'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  return html`<div class="invite brackets">
    <div class="invite__label"><${Icon} name="key" /><span>${t('同盟密钥')}</span><${MicroLabel}>ALLIANCE KEY<//></div>
    <div class="invite__code num selectable" aria-label=${t('同盟密钥 {code}', { code })}>${[...String(code)].map((ch, i) => html`<span key=${i}>${ch}</span>`)}</div>
    <div class="invite__btns">
      <${Button} size="sm" icon="copy" onClick=${() => copy('code')}>${t('复制密钥')}<//>
      <${Button} size="sm" icon="link" onClick=${() => copy('link')}>${t('复制链接')}<//>
    </div>
  </div>`;
}

function DifficultyPicker({ room, isHost, busy, onPick }) {
  if (!isHost) {
    return html`<div class="dpick dpick--ro">
      <${DifficultyTag} difficulty=${room.difficulty} size="lg" code=${difficultyInfo(room.mode, room.difficulty).code} />
      <span class="t-dim">${t('由创建者选择')}</span>
    </div>`;
  }
  return html`<div class="dpick" role="radiogroup" aria-label=${t('模拟难度')}>
    ${DIFFICULTIES.map((d) => html`<button key=${d} type="button" role="radio" aria-checked=${room.difficulty === d ? 'true' : 'false'}
        class=${`dpick__opt${room.difficulty === d ? ' is-active' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[d]}`}
        disabled=${!!busy} onClick=${() => room.difficulty !== d && onPick(d)}>
      <${DifficultyIcon} difficulty=${d} />${t(DIFFICULTY_NAMES[d].replace('模拟', ''))}
    </button>`)}
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

/** Room screen component. */
export function RoomScreen() {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const matching = useStore((s) => s.matchmaking, shallowEqual);
  const [busy, setBusy] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [fillTeam, setFillTeam] = useState(false);
  // 分享（§12.5）：探测到的能力 + 本机登记状态 + 两个独立的计时（冷却 / 有效期）。判定全在 ui/roomShare.js 里。
  const [share, setShare] = useState(() => initialShare());
  const [, setClockTick] = useState(0);
  /** 本机状态里的一切时间都用「服务端时间」比较（store 的 clock.offset），玩家机器的时钟不参与。 */
  const serverNow = () => Date.now() + (store.get().clock?.offset || 0);
  const applyShare = (next) => setShare((current) => (typeof next === 'function' ? next(current) : next));
  const probeShare = async () => {
    try {
      const response = await fetch('/api/portal-room');
      const data = response.ok ? await response.json() : null;
      if (data) applyShare((current) => ({ ...current, enabled: data.enabled === true, mode: data.mode ?? 'off', available: data.available === true }));
      return data;
    } catch { return null; }
  };
  useEffect(() => { probeShare(); }, []);
  // 房间实例或房主变了：旧登记状态与在途结果都不再属于这个界面（§12.5）。实例号是唯一能区分
  // 「同一个码被新房间复用」的东西，所以它变了就一定要清。
  useEffect(() => {
    applyShare((current) => ({ ...initialShare(current), enabled: current.enabled, mode: current.mode, available: current.available }));
  }, [room?.roomId, room?.hostId]);
  // 一秒一跳：登记的剩余分钟与冷却的剩余秒数都要走。
  useEffect(() => {
    if (share.state !== 'registered' && !share.cooldownUntil) return;
    const timer = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [share.state, share.cooldownUntil]);
  /** 登记结果查询（§12.1「操作结果待确认时界面调用状态查询」）。 */
  const queryShare = async ({ silent = false } = {}) => {
    const current = store.get().room;
    if (!current?.code) return null;
    const boundRoomId = current.roomId ?? null;
    try {
      const response = await fetch(`/api/portal-room/status?code=${encodeURIComponent(current.code)}`, {
        headers: { Authorization: `Bearer ${identity.getToken()}` }, signal: AbortSignal.timeout(10000) });
      const data = await response.json().catch(() => null);
      // 晚回执不写进新房间：查询期间房间可能已经被换掉了。
      if (boundRoomId !== (store.get().room?.roomId ?? null)) return null;
      if (data?.state === 'registered') toast(t('本房间已收录到联机站，登记最长保留十分钟'), 'success');
      else if (data?.state === 'ended' || data?.state === 'absent') {
        toast(t(data.state === 'ended' ? '登记已结束或已过期' : '没有查到这条登记，可以重新提交'), 'warn');
      } else if (data?.state === 'pending' && !silent) toast(t('登记结果待确认，请稍后再查'), 'info');
      else toast(t('登记查询失败，请稍后重试'), 'warn');
      applyShare((now) => shareAfterStatus(data, { previous: now, serverNow: serverNow() }));
      return data;
    } catch {
      if (!silent) toast(t('登记查询失败，请稍后重试'), 'warn');
      return null;
    }
  };
  // 结果待确认：自动查询几次（约 48 秒），之后交给手动按钮 —— 界面不能停在「待确认」上什么都不做。
  useEffect(() => {
    if (share.state !== 'pending') return;
    let tries = 0, cancelled = false;
    const timer = setInterval(() => {
      if (cancelled || tries >= SHARE_POLL_TRIES) { clearInterval(timer); return; }
      tries += 1;
      queryShare({ silent: true });
    }, SHARE_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [share.state]);
  const fillAvailable = room?.mode === 'coop' && (room.seats || []).filter(Boolean).length < MAX_SEATS &&
    !(room.seats || []).some((s) => s?.isBot);
  useEffect(() => { setFillTeam(false); }, [room?.code, room?.hostId, fillAvailable]);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (!matching || !room?.matchmaking) { setElapsed(0); return; }
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() + (store.get().clock.offset || 0) - matching.joinedAt) / 1000)));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [matching?.joinedAt, !!room?.matchmaking]);

  if (!room) return null;
  const online = conn.status === 'online';
  const coop = room.mode !== 'solo';
  const facts = roomFacts(room, me.playerId);
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('连接中断，请稍候重试'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const toggleReady = () => run('ready', () => net.request('room.ready', { ready: !myReady }));
  // 提交（§12.1）：只有服务端明说 registered 才算收录；202 是「发出去了但不知道结果」，界面转待确认；
  // 其余按业务码给文案。晚回执（房间已经不是当时那间）一概不写进界面。
  const submitPortal = () => run('portal', async () => {
    const boundRoomId = room.roomId ?? null;
    applyShare((current) => ({ ...current, state: 'submitting', error: null }));
    let response, data = null;
    try {
      response = await fetch('/api/portal-room', { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.getToken()}` },
        body: JSON.stringify({ code: room.code }) });
      data = await response.json().catch(() => null);
    } catch {
      applyShare((current) => ({ ...current, state: 'idle', error: null }));
      toast(t('提交失败，请稍后重试'), 'warn');
      return;
    }
    if (boundRoomId !== (store.get().room?.roomId ?? null)) return;
    if (!response.ok && data?.status !== 'pending') {
      if (data?.error) toast(t(data.error), 'warn'); else toast(t('提交失败，请稍后重试'), 'warn');
      // 链路侧不可用：把按钮翻成「暂不可用」，房主可以手动重试探测（而不是按一次报一次错）。
      if (response.status === 503) applyShare((current) => ({ ...current, available: false }));
    }
    applyShare((current) => shareAfterSubmit({ data, previous: current, serverNow: serverNow() }));
    if (data?.status === 'pending') toast(t('登记结果待确认，正在查询…'), 'info');
    else if (data?.registered === true) toast(t('本房间已收录到联机站，登记最长保留十分钟'), 'success');
  });
  const start = () => run('start', () => net.request('room.start', {}));
  const search = () => run('search', () => net.request('room.matchmaking', {}));
  const cancel = () => run('cancel', () => net.request('matchmaking.cancel', {}));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat) => run(`rm${seat}`, () => net.request('room.removeBot', { seat }));
  // the host removes a human before the match (community report #17): asked first; the player may join again. The
  // confirmed player's id goes along: if they left and someone else took the seat meanwhile, the server refuses it.
  const kick = async (seat, name, playerId) => {
    if (inFlight.current) return;
    const ok = await confirmDialog({ utility: true, title: t('移出同盟'), text: t('确定将「{name}」移出同盟吗？对方可以凭同盟密钥重新加入。', { name: name || t('博士') }), okText: t('移出'), danger: true });
    if (ok) run(`kick${seat}`, () => net.request('room.kick', { seat, playerId }));
  };
  const setDifficulty = (difficulty) => run('diff', () => net.request('room.setDifficulty', { difficulty }));
  const setAiLast = (on) => run('ailast', () => net.request('room.setAiPicksLast', { on }));
  // spectator seats: the host frees one; a spectator takes a free player seat with room.join of this room
  const removeSpectator = (playerId) => run(`rs${playerId}`, () => net.request('room.removeSpectator', { playerId }));
  const sit = () => run('sit', () => net.request('room.join', { code: room.code }));
  const leave = async () => {
    if (inFlight.current) return;
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ utility: true, title: t('离开同盟'), text: t('你是同盟的创建者，离开后创建者身份将移交或同盟解散。确定离开吗？'), okText: t('离开'), danger: true });
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
      ? html`<span class="t-mint"><${Icon} name="hourglass" />${t('正在搜寻队友')} · ${matching?.players ?? facts.humans.length}/${MAX_SEATS} ${t('名博士')}</span>`
    : !coop
      ? html`<span class="t-mint">${t('*模拟协议已就绪，准许进入模拟')}</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">${t('*同盟人数达标，准许进入模拟')}</span>`
        : html`<span class="t-lo">${t('等待所有博士准备就绪')}</span>`
      : myReady
        ? html`<span class="t-mint">${t('已就绪 · 等待创建者开始模拟')}</span>`
        : html`<span class="t-lo">${t('准备就绪后，创建者即可开始模拟')}</span>`;

  // 分享那一行的六个分支（§12.5）：不可用 / 提交中 / 待确认 / 已登记（剩余分钟）/ 已过期 / 冷却。
  const shareStatus = shareView(share, { serverNow: serverNow(), online,
    canSubmit: !busy && !facts.searching && facts.emptySeats >= 1 });
  const shareLabels = {
    unavailable: t('联机站暂不可用'),
    submitting: t('正在提交…'),
    pending: t('登记结果待确认'),
    registered: t('已提交到联机站'),
    expired: t('登记已过期，可重新提交'),
    cooldown: t('提交本房间到联机站'),
    idle: t('提交本房间到联机站'),
  };
  const shareHints = {
    unavailable: t('联机站暂不可用，请稍后重试'),
    submitting: t('公开本房间密钥到联机站，方便其他博士加入；十分钟后自动过期'),
    pending: t('提交已发出，正在等待联机站确认；也可以手动查询'),
    registered: t('本房间已收录到联机站，剩余 {n} 分钟', { n: shareStatus.remainingMin ?? 0 }),
    expired: t('登记已过期，可以重新提交'),
    cooldown: t('一分钟内只能提交一次，{n} 秒后可再试', { n: shareStatus.cooldownSec }),
    idle: t('公开同盟密钥，方便组队 · 十分钟后自动过期'),
  };

  return html`<div class=${`screen room-screen${coop ? ' room-screen--coop' : ''}`}>
    <header class="topbar">
      <div class="topbar__left">
        <${Tooltip} text=${t('离开同盟')} placement="bottom">
          <${Button} variant="danger" size="lg" square=${true} icon="exit" loading=${busy === 'leave'} onClick=${leave} aria-label=${t('离开同盟')} />
        <//>
        <div class="room-ping">
          <${PingPill} ms=${conn.ping} online=${online} />
          <${MicroLabel}>${t('当前延迟')}<//>
        </div>
        <${RoomTools} />
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">${coop ? 'ALLIANCE LOBBY' : 'SOLO SIMULATION'}<//>
        <h1 class="topbar__title">${coop ? t('同盟模拟') : t('独立模拟')}<span class="topbar__sep"></span><${DifficultyTag} difficulty=${room.difficulty} size="lg" /></h1>
      </div>
      <div class="topbar__right">
        ${coop ? html`<${InviteBox} code=${room.code} name=${me.name} difficulty=${room.difficulty} />` : html`<div class="solo-note"><${MicroLabel}>SINGLE OPERATOR<//><span>${t('仅限 1 名博士')}</span></div>`}
      </div>
    </header>

    <main class=${`seats${coop ? '' : ' seats--solo'}`}>
      ${facts.seats.map((s, i) => html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
        myId=${me.playerId} busy=${busy} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick} />`)}
      ${coop ? null : html`<aside class="solo-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        <h2>${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''}<span class="num t-dim"> ${info.code}</span></h2>
        <p>${info.desc}</p>
        <ul>
          ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
          <li>${t('共')} <b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t('，满足条件时进入隐秘核心') : ''}</li>
          <li>${t('独立模拟中休整期与机变阶段不限时')}</li>
        </ul>
      </aside>`}
    </main>
    <${SpectatorBar} facts=${facts} myId=${me.playerId} busy=${busy} onRemove=${removeSpectator} onSit=${sit} />

    ${coop && facts.isHost && shareStatus.visible ? html`<div class="room-portal-entry">
      <${Button} size="sm" variant="secondary" icon="link" loading=${shareStatus.kind === 'submitting'}
        disabled=${shareStatus.kind === 'submitting' || shareStatus.disabled}
        title=${t('公开本房间密钥到联机站，方便其他博士加入；十分钟后自动过期')}
        onClick=${submitPortal}>${shareLabels[shareStatus.kind] ?? shareLabels.idle}<//>
      ${shareStatus.action === 'query' ? html`<${Button} size="sm" variant="ghost" loading=${busy === 'shareQuery'}
        title=${t('查询登记结果')} onClick=${() => run('shareQuery', () => queryShare())}>${t('查询登记结果')}<//>` : null}
      ${shareStatus.action === 'retry' ? html`<${Button} size="sm" variant="ghost" title=${t('重试')}
        onClick=${() => probeShare()}>${t('重试')}<//>` : null}
      <span>${shareHints[shareStatus.kind] ?? shareHints.idle}</span>
    </div>` : null}
    ${!share.enabled && facts.searching && elapsed >= 10 ? html`<p class="room-recruit-hint" role="status">
      ${t('迟迟匹配不到人？可前往')} <a href="https://game.rainya.me/" target="_blank" rel="noopener noreferrer">game.rainya.me</a>
      ${t('发布当前同盟的房间号，来人更快。')}
    </p>` : null}

    <footer class="room-bar">
      <div class="room-bar__left">
        <span class="room-bar__label">${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></span>
        <div class="room-bar__opts">
          <${DifficultyPicker} room=${room} isHost=${facts.isHost} busy=${busy || facts.searching} onPick=${setDifficulty} />
          <${AiLastToggle} option=${aiLastOption(room, me.playerId)} busy=${busy || facts.searching} onToggle=${setAiLast} />
        </div>
      </div>
      <div class="room-bar__center">
        <div class="ready-count" hidden=${!coop}>
          <span class="t-lo">${t('已就绪')}</span>
          <b class="num">${facts.readyHumans}</b><span class="num t-dim">/${facts.humans.length}</span>
          <span class="ready-count__icons" aria-hidden="true">
            ${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}
          </span>
        </div>
        <div class="room-bar__status">${statusLine}</div>
      </div>
      <div class="room-bar__right">
        <${LoadoutButton} from="room" size="lg" class="room-loadout" label=${t('干员调配')} />
        ${facts.isHost
          ? html`<div class="room-start-actions">
            ${coop && (facts.emptySeats > 0 || facts.searching) ? html`<label class=${`room-matchmaking${facts.searching || fillTeam ? ' is-checked' : ''}${busy || !online || facts.searching || !fillAvailable ? ' is-disabled' : ''}`} title=${t('队友准备后，可匹配真人补齐 4 人')}>
              <input type="checkbox" checked=${facts.searching || fillTeam} disabled=${!!busy || !online || facts.searching || !fillAvailable}
                onChange=${(e) => setFillTeam(e.currentTarget.checked)} />
              <span>${t('匹配补齐')}</span>
            </label>` : null}
            <${Tooltip} text=${facts.searching ? t('取消匹配后保留当前同盟') : !facts.canStart ? t('仍有博士未准备就绪') : null}>
              <${Button} class="room-start" variant=${facts.searching ? 'secondary' : 'primary'} size="xl" icon=${facts.searching ? 'hourglass' : 'play'}
                loading=${busy === 'start' || busy === 'search' || busy === 'cancel'}
                disabled=${!online || (!facts.searching && !(fillTeam && fillAvailable ? facts.canMatch : facts.canStart))}
                onClick=${facts.searching ? cancel : fillTeam && fillAvailable ? search : start}>${facts.searching ? t('取消搜寻') : t('开始模拟')}<//>
            <//>
          </div>`
          : facts.spectating
            ? html`<${Button} variant="secondary" size="xl" icon="eye" disabled=${true}>${t('观战中')}<//>`
          : html`<${Button} variant=${myReady ? 'primary' : 'secondary'} size="xl" icon=${myReady ? 'check' : 'hourglass'} active=${myReady}
              loading=${busy === 'ready'} disabled=${!online || !facts.mine || facts.searching} onClick=${toggleReady}>${myReady ? t('已就绪') : t('准备就绪')}<//>`}
      </div>
    </footer>
  </div>`;
}
