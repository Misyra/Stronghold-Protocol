// ui/gameLogic/camera.js — prep camera, boss-field tile mapping, owner band. Re-exported from ../gameLogic.js.

import { GEO } from '../../../../shared/constants.js';
import { BOSS_ROW_SHIFT, MAX_COL } from '../../render/prepfield.js';
import { int, isObj } from './shared.js';


/**
 * Camera of the own prep board (research 09 §1.2 "Final Assault, right side", DESIGN §15): in the prep of a boss round
 * (最终攻势 / 隐秘核心: `pub.round` is `bossRound` or `hiddenRound`) the pieces stand on the player's half of the shared
 * boss field — `{ kind: 'bossPrep', opts: { side } }`; the side follows the server's pairing (server/match/
 * finalAssault.js pairPlayers: the alive players in seat order, two by two; the second of a pair is on the mirrored
 * right half 'R', a lone player on 'L'). Any other prep: the own board `{ kind: 'prep', opts: { rect, side: 'L' } }`.
 * @param {any} pub m.public
 * @param {string|null} myId
 * @returns {{ kind: 'prep'|'bossPrep', opts: { rect?: { r0: number, r1: number, c0: number, c1: number }, side: 'L'|'R' } }}
 */
export function prepCamera(pub, myId) {
  const normal = { kind: 'prep', opts: { rect: { ...GEO.NORMAL_RECT }, side: 'L' } };
  const r = pub?.round;
  if (!Number.isInteger(r) || r <= 0 || !(r === pub.bossRound || r === pub.hiddenRound)) return normal;
  const alive = (Array.isArray(pub.players) ? pub.players : []).filter((p) => isObj(p) && p.alive !== false)
    .sort((a, b) => int(a.seat, 99) - int(b.seat, 99));
  const idx = alive.findIndex((p) => p.playerId === myId);
  if (idx < 0) return normal; // eliminated / unknown: no board of its own on the boss field
  return { kind: 'bossPrep', opts: { side: idx % 2 === 1 ? 'R' : 'L' } };
}

/**
 * The own prep board's camera request with the shop bar's state (public issue #5 "准备阶段，收起商店界面时，界面并不会进行
 * 缩放"): `prepCamera` plus `shop: !folded` — a folded shop (收起) takes the official shop-collapsed camera
 * (configBlackBoard left_prepare_camera_param / *_boss_prepare_*, render/projection.js presetCamera `shop: false`) and
 * the folded shop's HUD band (ui/fieldHost.js hudBands), an open one the shop camera. `folded` = the shop bar is shown
 * and folded (an eliminated player's board, which shows no bar, keeps the shop camera).
 * @returns {{ kind: 'prep'|'bossPrep', opts: { rect?: object, side: 'L'|'R', shop: boolean } }}
 */
export function prepCameraFor(pub, myId, folded = false) {
  const c = prepCamera(pub, myId);
  return { kind: c.kind, opts: { ...c.opts, shop: !folded } };
}

/**
 * The camera request a fold / unfold of the shop bar needs right now (public issue #5), or null: only while the own prep
 * board is on screen (`ownPrep`: prep, not a teammate's scouted board, not a battle), never over the enemy pen (`pen`: it
 * folds the shop itself and returns to the camera it left), deferred while a piece is dragged or its direction is chosen
 * (`busy`: the drop target and the wheel sit on tiles of the camera in use — the caller asks again once that ends), and
 * nothing when the current request (`current` { kind, opts }) already has that shop state.
 * @param {{ pub: any, myId: string|null, ownPrep: boolean, folded: boolean, pen?: boolean, busy?: boolean,
 *   current?: { kind: string, opts?: { shop?: boolean } }|null }} s
 * @returns {{ kind: 'prep'|'bossPrep', opts: object }|null}
 */
export function foldCamera(s) {
  if (!s || !s.ownPrep || s.pen || s.busy) return null;
  const want = prepCameraFor(s.pub, s.myId, !!s.folded);
  const cur = s.current;
  if (cur && cur.kind === want.kind && (cur.opts?.shop !== false) === want.opts.shop) return null;
  return want;
}

/**
 * The field the own pieces are deployed on (server/match/Match.js deployFieldOf): 'bossL' / 'bossR' in the prep of a
 * boss round (the same pairing as `prepCamera`), else 'normal'. Placement legality (`placementContext` → `deployMap`
 * with `field`) reads that field's tiles.
 * @returns {'normal'|'bossL'|'bossR'}
 */
export function deployFieldOf(pub, myId) {
  const cam = prepCamera(pub, myId);
  return cam.kind === 'bossPrep' ? (cam.opts.side === 'R' ? 'bossR' : 'bossL') : 'normal';
}

/**
 * The stage tile [row, col] of board tile (r, c) on deploy field `field` (server/match/board.js fieldTile): the boss
 * prep's display transform (render/prepfield.js bossPrepField: row − 7, the right half mirrored col c → 20 − c).
 */
export function fieldTile(field, r, c) {
  if (field !== 'bossL' && field !== 'bossR') return [r, c];
  return [r + BOSS_ROW_SHIFT, field === 'bossR' ? MAX_COL - c : c];
}

/** The board tile of stage tile (r, c) on deploy field `field` (server/match/board.js boardTileOf). */
export function boardTileOf(field, r, c) {
  if (field !== 'bossL' && field !== 'bossR') return [r, c];
  return [r - BOSS_ROW_SHIFT, field === 'bossR' ? MAX_COL - c : c];
}

/** The band (策略) a player picked, from m.public.players[].bandId (Match.js marksPublic) — the detail card shows it
 *   on a teammate's unit (user playtest #2 item 2: watching a teammate revealed nothing about their 策略). */
export function ownerBandId(pub, ownerId) {
  const p = Array.isArray(pub?.players) ? pub.players.find((x) => x && x.playerId === ownerId) : null;
  return typeof p?.bandId === 'string' && p.bandId ? p.bandId : null;
}
