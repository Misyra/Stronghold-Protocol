// The battlefield mini map of the strategy draft (Stardust fork 2254875e, #65): the field a player deploys on, drawn from
// the stage's own tiles (data/stages.json) so every battlefield of every official version has one, with no art to fetch.
// Rows go bottom-up as on the board: the enemy gates (red) and the protected point (blue) stand where the match will have
// them. Styles: css/screens/draft.css (.stagemap).

import { html } from './components.js';
import { fallbackTileClass } from './fallbackField.js';

/** The stage tiles of the field: GEO.FIELD's rows, from the protected point's column to the last gate's. */
const RECT = Object.freeze({ r0: 9, r1: 12, c0: 2, c1: 12 });

/**
 * The look of one tile: 'gate', 'goal', 'void', 'high' (a ranged platform) or a special ground as on the fallback board,
 * else 'road' (enemies walk it) or 'fence' (low ground they do not).
 * @param {any} stage @param {number} r @param {number} c
 */
export function miniTile(stage, r, c) {
  const cls = fallbackTileClass(stage, r, c);
  if (cls !== 'floor' && cls !== 'lane') return cls;
  return stage.tiles?.[stage.rows[r][c]]?.groundPassable === false ? 'fence' : 'road';
}

/**
 * The drawn tiles (void left out), x / y in tiles from the top left.
 * @param {any} stage a data/stages.json record
 * @returns {{ w: number, h: number, tiles: Array<{ x: number, y: number, kind: string }> } | null} null without tile data
 */
export function stagePreview(stage) {
  if (!Array.isArray(stage?.rows) || !stage.rows[RECT.r1]) return null;
  const tiles = [];
  for (let r = RECT.r0; r <= RECT.r1; r++) {
    for (let c = RECT.c0; c <= RECT.c1; c++) {
      const kind = miniTile(stage, r, c);
      if (kind !== 'void') tiles.push({ x: c - RECT.c0, y: RECT.r1 - r, kind });
    }
  }
  return { w: RECT.c1 - RECT.c0 + 1, h: RECT.r1 - RECT.r0 + 1, tiles };
}

/**
 * @param {{ stage: any, class?: string }} props nothing without tile data
 */
export function StageMiniMap({ stage, class: cls }) {
  const map = stagePreview(stage);
  if (!map) return null;
  return html`<svg class=${cls ? `stagemap ${cls}` : 'stagemap'} viewBox=${`0 0 ${map.w} ${map.h}`} aria-hidden="true" data-testid="stage-minimap">
    ${map.tiles.map((t) => html`<rect key=${`${t.x},${t.y}`} class=${`stagemap__t stagemap__t--${t.kind}`} x=${t.x + 0.04} y=${t.y + 0.04} width="0.92" height="0.92" />`)}
  </svg>`;
}
