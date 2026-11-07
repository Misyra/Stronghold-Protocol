// The team panel's layout model (ui/teamPanel.js, css/screens/team.css): pure helpers, no DOM.
// 移植自 Stardust fork（tip cc948b65）的 ui/teamLayout.js：只取布局模型与行为，界面观感沿用本仓组件。

/** Phones: a short touch screen in landscape or a narrow one (css/devices.css uses the same query). */
export const PHONE_QUERY = '(max-height: 600px) and (pointer: coarse), (max-width: 767px)';

/**
 * 'classic' — the official left column (desktop, at most four seats): big avatars, emote bubbles beside the rows.
 * 'list' — compact one-line rows in a bounded scroller (phones, rooms of more than four): emotes fly as danmaku.
 * @param {{ count: number, phone: boolean }} o
 * @returns {'classic'|'list'}
 */
export function teamDensity({ count, phone }) {
  return !phone && (Number(count) || 0) <= 4 ? 'classic' : 'list';
}

/** A classic roster starts open; a list starts folded (it would cover the field). */
export const rosterStartsOpen = (density) => density === 'classic';

/**
 * Where emotes show: beside the rows of an open classic roster, else as danmaku over the field (a folded roster has no
 * rows; a list has no room beside its rows).
 * @param {{ density: 'classic'|'list', open: boolean }} o
 * @returns {'bubble'|'danmaku'}
 */
export function teamEmoteMode({ density, open }) {
  return density === 'classic' && open ? 'bubble' : 'danmaku';
}

/**
 * The experimental room's chess pools (m.public poolGroups: seat chunks fixed at the match's start, server/match/pool.js
 * createPoolGroups) with their seats in roster order, so teammates can check who draws from the same pool. Null when
 * there is nothing to tell: no groups, one shared pool, or every seat its own pool (共享卡池 off).
 * @param {any} pub m.public
 * @param {any[]} players sortedPlayers(pub)
 * @param {string|null} [myId]
 * @returns {Array<{ id: number|null, scale: number, mine: boolean, players: any[] }>|null}
 */
export function rosterPools(pub, players, myId = null) {
  const groups = Array.isArray(pub?.poolGroups) ? pub.poolGroups.filter((g) => g && Array.isArray(g.playerIds)) : [];
  if (groups.length < 2 || groups.every((g) => g.playerIds.length <= 1)) return null;
  const order = new Map((players || []).map((p, i) => [p?.playerId, i]));
  const seen = new Set();
  const out = groups.map((g, i) => {
    const seats = g.playerIds.filter((id) => order.has(id) && !seen.has(id));
    seats.forEach((id) => seen.add(id));
    seats.sort((a, b) => order.get(a) - order.get(b));
    return { id: Number.isFinite(g.id) ? g.id : i + 1, scale: Number(g.scale) || 1, mine: !!myId && seats.includes(myId), players: seats.map((id) => players[order.get(id)]) };
  });
  // a seat the groups do not list (not expected: the groups are fixed at the start and seats are never added)
  const rest = (players || []).filter((p) => !seen.has(p?.playerId));
  if (rest.length) out.push({ id: null, scale: 1, mine: !!myId && rest.some((p) => p.playerId === myId), players: rest });
  return out.filter((g) => g.players.length);
}

/**
 * Columns of an open list on a wide screen: one, or two when the seats (plus `extra` px of pool headers) would not fit
 * the height and the width takes two readable columns. Keep readable rows; a short/narrow roster scrolls rather than
 * shrinking its final seats.
 */
export function teamPanelLayout(count, height, rootSize = 40, width = 240, coarse = false, extra = 0) {
  const seats = Math.max(1, Math.trunc(Number(count) || 1));
  const gap = 4;
  const rowHeight = Math.max(48, Math.min(64, rootSize * .48));
  const available = Math.max(1, Number(height) || seats * (rowHeight + gap));
  const maxColumns = coarse ? 1 : Math.min(2, Math.max(1, Math.floor((Math.max(1, width) + gap) / (204 + gap))));
  const columns = seats * (rowHeight + gap) - gap + Math.max(0, Number(extra) || 0) > available ? maxColumns : 1;
  const rows = Math.ceil(seats / columns);
  return { columns, rows, rowHeight, avatar: Math.min(40, rowHeight - 12), gap };
}
