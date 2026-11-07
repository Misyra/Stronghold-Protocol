// Emotes as danmaku: on phones, under a folded roster and in rooms of more than four (ui/teamLayout.js teamEmoteMode)
// the emotes fly right to left across a band under the bond strip — sender avatar, name and the official emote art — instead
// of bubbles beside rows that are not on screen. One to three lanes; an emote the same as one shown in the last
// DANMAKU_MERGE_MS joins it (×N, its senders' avatars stacked); at most DANMAKU_QUEUE wait for a lane (the oldest of a
// teammate's are dropped first — the own emote, the sender's only confirmation, goes first). Reduced motion: the items stand
// still in their lane and fade out after the official bubble time. The band reads the store itself (no re-render of the
// match screen per emote) and wakes on a timer only while something is queued or on screen.
// 移植自 Stardust fork（tip cc948b65）的 ui/danmaku.js：调度模型原样；名字用本仓 players[].name（fork 的名字卡 ownerName
// 不在本仓），挂载点在 ui/teamPanel.js 的名单侧栏内（fork 挂在 game 屏——本仓 game.js 未动）。

import { useEffect, useReducer, useRef } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { useStore } from '../store.js';
import { PlayerAvatar } from './gameComponents.js';
import { EmoteArt, ensureEmoteCss } from './emotes.js';
import { EMOTE_BUBBLE_MS, emoteInfo } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

export const DANMAKU_MERGE_MS = 800;
export const DANMAKU_QUEUE = 8;
/** px an item is assumed to take along its lane (avatar + name + art), for spacing the next one in that lane */
export const DANMAKU_ITEM_PX = 200;
const LANE_GAP_PX = 32;

/** Fly speed (px/s) for a band `width` px wide: about six seconds across, within 140–260 px/s. */
export const danmakuSpeed = (width) => Math.max(140, Math.min(260, (Number(width) || 800) / 6));

/** Lanes for a band on a screen `height` px high: two on a short (landscape phone) screen, else three. */
export const danmakuLanes = (height) => ((Number(height) || 800) <= 500 ? 2 : 3);

/**
 * A fresh model. `seq`: the newest emote already taken (emotes at or below it are not replayed).
 * @returns {{ seq: number, items: any[], queue: any[], laneFree: number[], key: number }}
 */
export function danmakuModel(seq = 0) {
  return { seq, items: [], queue: [], laneFree: [], key: 0 };
}

/**
 * Take the new emotes (store.emotes: { seq, playerId, id, at }) into the model: merge into a recent same emote, else queue.
 * Emotes older than `ttl` are skipped (a band mounted late does not replay them). Mutates and returns the model.
 * @param {ReturnType<typeof danmakuModel>} m @param {any[]} emotes @param {number} now
 * @param {{ ttl?: number, myId?: string|null }} [o]
 */
export function danmakuIngest(m, emotes, now, { ttl = EMOTE_BUBBLE_MS, myId = null } = {}) {
  const fresh = (Array.isArray(emotes) ? emotes : []).filter((e) => e && Number.isFinite(e.seq) && e.seq > m.seq).sort((a, b) => a.seq - b.seq);
  for (const e of fresh) {
    m.seq = Math.max(m.seq, e.seq);
    if (!(now - (Number(e.at) || now) < ttl)) continue;
    const same = [...m.queue, ...m.items].find((x) => x.id === e.id && now - x.born < DANMAKU_MERGE_MS);
    if (same) {
      if (!same.pids.includes(e.playerId)) same.pids.push(e.playerId);
      continue;
    }
    const item = { key: ++m.key, id: e.id, pids: [e.playerId], born: now, self: e.playerId === myId, lane: -1, start: 0, end: 0 };
    if (item.self) m.queue.unshift(item); else m.queue.push(item);
    while (m.queue.length > DANMAKU_QUEUE) {
      const drop = m.queue.findIndex((x) => !x.self);
      m.queue.splice(drop >= 0 ? drop : m.queue.length - 1, 1);
    }
  }
  return m;
}

/**
 * Release queued items into free lanes and drop finished ones. `dur`: ms an item takes to cross; `spacing`: ms before the
 * next item may enter the same lane. Mutates and returns the model.
 * @param {ReturnType<typeof danmakuModel>} m @param {number} now
 * @param {{ lanes: number, dur: number, spacing: number }} o
 */
export function danmakuPump(m, now, { lanes, dur, spacing }) {
  m.items = m.items.filter((x) => x.end > now);
  for (let lane = 0; lane < lanes && m.queue.length; lane++) {
    if ((m.laneFree[lane] || 0) > now) continue;
    const item = m.queue.shift();
    Object.assign(item, { lane, start: now, end: now + dur });
    m.laneFree[lane] = now + spacing;
    m.items.push(item);
  }
  return m;
}

/** The next time (ms) the model needs a pump: an item ending, or a lane freeing while something waits; null = idle. */
export function danmakuWake(m) {
  const times = m.items.map((x) => x.end);
  if (m.queue.length) times.push(...m.laneFree.filter((x) => x > 0));
  return times.length ? Math.min(...times) : null;
}

function reducedMotion() {
  const root = globalThis.document?.documentElement;
  return !!root?.classList?.contains('sp-reduced-motion') || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

/**
 * @param {{ players: any[], myId: string|null, ttl?: number }} props players: sortedPlayers(pub)
 */
export function Danmaku({ players, myId, ttl = EMOTE_BUBBLE_MS }) {
  const emotes = useStore((s) => s.emotes);
  const [, wake] = useReducer((c) => c + 1, 0);
  const model = useRef(/** @type {ReturnType<typeof danmakuModel>|null} */ (null));
  const bandRef = useRef(null);
  useEffect(() => { ensureEmoteCss(); }, []);
  if (!model.current) model.current = danmakuModel(0);
  const m = model.current;
  const width = bandRef.current?.clientWidth || globalThis.innerWidth || 800;
  const still = reducedMotion();
  const speed = danmakuSpeed(width);
  const opts = still
    ? { lanes: danmakuLanes(globalThis.innerHeight), dur: ttl, spacing: ttl }
    : { lanes: danmakuLanes(globalThis.innerHeight), dur: Math.round(((width + DANMAKU_ITEM_PX) / speed) * 1000), spacing: Math.round(((DANMAKU_ITEM_PX + LANE_GAP_PX) / speed) * 1000) };
  const now = Date.now();
  danmakuIngest(m, emotes, now, { ttl, myId });
  danmakuPump(m, now, opts);
  const next = danmakuWake(m);
  useEffect(() => {
    if (next == null) return undefined;
    const id = setTimeout(wake, Math.max(16, next - Date.now() + 8));
    return () => clearTimeout(id);
  });
  const byId = new Map((players || []).map((p) => [p.playerId, p]));
  return html`<div ref=${bandRef} class=${cx('danmaku', still && 'danmaku--still')} aria-hidden="true" style=${`--dm-lanes:${opts.lanes}`}>
    ${m.items.map((x) => {
      const first = byId.get(x.pids[0]);
      const e = emoteInfo(x.id);
      return html`<div key=${x.key} class=${cx('danmaku__item', x.self && 'is-self')} data-emote=${x.id}
        style=${`--dm-lane:${x.lane};--dm-dur:${x.end - x.start}ms`} title=${e ? t(e.label) : ''}>
        <span class="danmaku__who">${x.pids.slice(0, 3).map((pid) => html`<${PlayerAvatar} key=${pid} player=${byId.get(pid) || { playerId: pid }} size="sm" self=${pid === myId} />`)}</span>
        <span class="danmaku__name">${first?.name || t('博士')}</span>
        ${x.pids.length > 1 ? html`<b class="danmaku__n num">×${x.pids.length}</b>` : null}
        <span class="danmaku__art"><${EmoteArt} id=${x.id} /></span>
      </div>`;
    })}
  </div>`;
}
