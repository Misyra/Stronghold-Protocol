// ui/gameLogic/standIn.js — 补位 stand-ins in the match UI (0.2.0, the approved plan — owner's decision 2026-10-05).
// Re-exported from ../gameLogic.js.
//
// A chess the player marked as not owned (干员持有) keeps its card — name, bonds, price, the shop / reward / hand art —
// with a 「替补：<stand-in>」 badge, and is deployed as its official stand-in: the board model, the battle unit and the
// detail card's body (portrait, class, 特性, stats, range, skill, talents, module) are the stand-in's, its identity
// (name, tier, bonds, 特质) the chess's. Whose pieces: the player's own come from m.private.standIns (the list the seat
// had when the match started — the server's, not this browser's current setting, which applies from the next match);
// another player's units say it themselves (UnitInfo `standInFor`: the sim's, and Match.prepFieldMeta's for scouting).
// The composed record is shared/standIn.js standInRecord over data/backups.json — the one the sim fields.

import { standInRecord } from '../../../../shared/standIn.js';
import { resolveLoadout } from '../../../../shared/protocol.js';
import { chessLoadout } from './loadout.js';
import { isObj } from './shared.js';

/** Base chess ids the player fields as stand-ins in this match (m.private.standIns; [] when absent). */
export function standInIds(priv) {
  const list = isObj(priv) && Array.isArray(priv.standIns) ? priv.standIns : [];
  return list.filter((x) => typeof x === 'string');
}

/** Whether the player's own piece / card of chess record `chess` (normal or elite) fields its stand-in. */
export function fieldsStandIn(priv, chess) {
  if (!isObj(chess) || typeof chess.chessId !== 'string') return false;
  const ids = standInIds(priv);
  return ids.length > 0 && ids.includes(chess.baseId || chess.chessId);
}

/** Per backups object: chess record → composed stand-in record (or null). */
const CACHE = new WeakMap();

/**
 * The composed 补位 record of a chess record (shared/standIn.js standInRecord: the chess's identity, the stand-in's
 * body; `standInFor` = the replaced charId), cached per data object; null for a PRESET / 自选 chess or missing data.
 * @param {any} chess data/chess.json record @param {any} backups data/backups.json
 */
export function standInOf(chess, backups) {
  if (!isObj(chess) || !isObj(backups)) return null;
  let m = CACHE.get(backups);
  if (!m) { m = new WeakMap(); CACHE.set(backups, m); }
  if (m.has(chess)) return m.get(chess);
  let rec;
  try { rec = standInRecord(chess, backups); } catch { rec = null; }
  m.set(chess, rec);
  return rec;
}

/**
 * The stand-in record the card of a chess shows for this viewer, or null: the player's own piece / card (m.private
 * standIns), or a unit that carries `standInFor` (another player's — the sim's UnitInfo, prep scouting).
 * @param {any} chess @param {{ priv?: any, unit?: any, backups?: any }} o
 */
export function cardStandIn(chess, { priv = null, unit = null, backups = null } = {}) {
  if (!isObj(chess)) return null;
  const mine = unit ? typeof unit.standInFor === 'string' && !!unit.standInFor : fieldsStandIn(priv, chess);
  return mine ? standInOf(chess, backups) : null;
}

/** id → stand-in record (else the chess record): the lookup a stand-in's loadout / options resolve against. */
export function standInGetter(getChess, backups) {
  return (id) => {
    const c = getChess(id);
    return standInOf(c, backups) || c;
  };
}

/**
 * The skill / module / record a stand-in fights with (chessLoadout of the composed record, no player loadout —
 * "对于补位干员其技能不可更改"): its backup skill, the elite's backup module (or none).
 * @param {any} rec standInOf(...) @param {(id: string) => any} getChess @param {any} backups
 */
export function standInLoadout(rec, getChess, backups) {
  return rec ? chessLoadout(rec, null, standInGetter(getChess, backups)) : null;
}

/**
 * The record the player's own piece of `chess` is deployed with — the stand-in record when the player fields its
 * stand-in, else the chess as the player's loadout makes it (chessLoadout `.record`): its range (board overlay, deploy
 * wheel), its position (legal tiles), the board model.
 * @param {any} chess @param {any} priv m.private @param {(id: string) => any} getChess @param {any} backups
 */
export function deployedRecord(chess, priv, getChess, backups) {
  if (!isObj(chess)) return chess;
  if (fieldsStandIn(priv, chess)) {
    const si = standInOf(chess, backups);
    if (si) return standInLoadout(si, getChess, backups)?.record || si;
  }
  return chessLoadout(chess, priv?.loadout ?? null, getChess)?.record || chess;
}

/**
 * The module id a deployed piece carries: a stand-in's backup module, else the player's loadout. (The 高台 rule no
 * longer reads it: since the owner's decision of 2026-10-05 it is the trait, whatever the module — shared/highGround.js.)
 */
export function deployedModuleId(chess, priv, getChess, backups) {
  if (!isObj(chess)) return null;
  try {
    if (fieldsStandIn(priv, chess)) {
      const si = standInOf(chess, backups);
      if (si) return resolveLoadout(null, si, standInGetter(getChess, backups))?.moduleId ?? null;
    }
    return resolveLoadout(priv?.loadout ?? null, chess, getChess)?.moduleId ?? null;
  } catch { return null; }
}

/** The 「替补：X」 badge text of a stand-in record (null without one). */
export function standInLabel(rec) {
  return isObj(rec) && rec.standInFor && rec.name ? `替补：${rec.name}` : null;
}
