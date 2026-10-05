// public/js/screens/game/standInTags.js — 0.2.0 补位: the 「替补：X」 tag under the player's own prep pieces (hand,
// 临时整备区, board) of a chess they do not own (m.private.standIns). The hand keeps the chess's own model (the card shows
// the original operator); on the board the model is the stand-in's (render/app.js pieceInfo) — the tag says which
// chess it is either way. Anchored to each piece's drawn body (view.pieceScreenRect, followed every frame like the
// direction wheel follows its tile); never takes the pointer, so the pieces stay draggable.

import { useEffect, useRef, useState } from '../../../vendor/hooks.module.js';
import { html } from '../../ui/components.js';
import { fieldsStandIn, standInOf, standInLabel } from '../../ui/gameLogic.js';

const rawOf = (view) => (view && view.raw) || view || null;

/**
 * The player's own prep pieces that fight as stand-ins: [{ uid, label, name, area }] (hand, temp, board).
 * @param {any} priv m.private @param {(id: string) => any} getChess @param {any} backups data/backups.json
 */
export function standInPieces(priv, getChess, backups) {
  const out = [];
  if (!priv || !Array.isArray(priv.standIns) || !priv.standIns.length) return out;
  const add = (p, area) => {
    if (!p || p.kind !== 'chess' || !Number.isInteger(p.uid)) return;
    const c = getChess(p.id);
    if (!fieldsStandIn(priv, c)) return;
    const si = standInOf(c, backups);
    if (si) out.push({ uid: p.uid, label: standInLabel(si), name: si.name, area });
  };
  for (const p of Array.isArray(priv.hand) ? priv.hand : []) add(p, 'hand');
  for (const p of Array.isArray(priv.temp) ? priv.temp : []) add(p, 'temp');
  for (const p of Array.isArray(priv.board) ? priv.board : []) add(p, 'board');
  return out;
}

/** @param {{ view: any, priv: any, getChess: (id: string) => any, backups: any }} props */
export function StandInTags({ view, priv, getChess, backups }) {
  const items = standInPieces(priv, getChess, backups);
  const [pos, setPos] = useState({});
  const last = useRef('');
  const key = items.map((it) => it.uid).join(',');
  useEffect(() => {
    const raw = rawOf(view);
    if (!raw || typeof raw.pieceScreenRect !== 'function' || !key) { last.current = ''; setPos({}); return undefined; }
    const uids = key.split(',').map(Number);
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const next = {};
      let sig = '';
      for (const uid of uids) {
        let r;
        try { r = raw.pieceScreenRect(uid); } catch { r = null; }
        if (!r || !(r.width > 0)) continue;
        // under the feet: the bottom centre of the drawn body
        next[uid] = { x: (r.left + r.right) / 2, y: r.bottom };
        sig += `${uid}:${next[uid].x.toFixed(1)},${next[uid].y.toFixed(1)};`;
      }
      if (sig !== last.current) { last.current = sig; setPos(next); }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [view, key]);
  if (!items.length) return null;
  return html`<div class="sitags" aria-hidden="true" data-testid="standin-tags">
    ${items.map((it) => {
      const p = pos[it.uid];
      return p ? html`<span key=${it.uid} class=${`sitag sitag--${it.area}`} data-uid=${it.uid} title=${`未持有：由 ${it.name} 上场`}
        style=${`left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px`}>${it.label}</span>` : null;
    })}
  </div>`;
}
