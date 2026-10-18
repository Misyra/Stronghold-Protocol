// server/match/layerForecast.js — 预计叠层: the bond layers a player's own <休整期结束时> effects will add (feedback #25,
// the owner's decisions of 2026-10-17; META §5.4).
//
// During PREP the player's m.private carries `layerForecast` — what this player's own onPrepEnd dispatch would add at
// the prep deadline right now: the SERVER_PREP_FIN 特质, the bonds' prep-end effects (助力 deputShip: +2 / +4 to every
// active bond), the strategy's, the items' and the persistent effects' onPrepEnd handlers (never a plugin's, below), in
// the dispatcher's own order (global → band → bonds → garrisons → items → effects).
//
// How: a recording preview of that dispatch (EffectDispatcher.forecastLayers). It is the isolated preview of
// effectsMeta.js / preview.js — every write is a no-op, the RNG is a clone of rngMeta, reads see detached copies —
// with four context functions of the forecast player replaced:
//   addLayers           writes this ledger instead of the player: `requireActive` honoured, clamped by layerGainRoom
//                       over the stored layers plus what the ledger already holds (as PlayerState.addLayers);
//   layers / bond / bonds  read the stored layers plus the ledger, so the order effects come out as the deadline runs
//                       them (助力 first, then a 特质 that feeds the active bond with the most layers);
//   triggerGarrisons    runs the copied / re-triggered 特质 (塞雷娅 / 白面鸮 "特质与其相同") through the same preview.
// Not run: onLayers (layer milestones) and recompute — a gain's own follow-ups are not part of the forecast.
//
// Random sources are not counted (the owner's decision of 2026-10-17): a handler call that draws the preview RNG and adds
// layers has its additions rolled back and sets `random: true` (策略 prep_finish_char_bond_add_layer picks an operator
// per 阶级 with ctx.rng.pick — bands/meta.js). Known limits: gains caused by teammates' prep-end effects and cascades at
// the deadline (onLayers / onGain of something gained then) are not counted.
//
// Plugins are never called (the coordinator's decision of 2026-10-17): only the engine's own handlers run
// (MetaRegistry.isOfficial — built-ins and content, marked by createRegistry before any plugin, DSL spec or later
// registration); a skipped handler of the hook sets `partial: true` (the client notes 「插件效果未计入」), since a
// third-party handler may keep state outside ctx and would be disarmed by a call that is not the real deadline.
// Never part of m.public, a teammate's view or a checkpoint: computed for the player's own m.private only, for connected
// humans (Match.flush sends no m.private to the others), memoized per player on the inputs a prep-end handler reads.

import { PHASE, layerGainRoom } from '../../shared/constants.js';

/** The ledger of one forecast. */
export class LayerLedger {
  constructor(playerId) {
    this.playerId = playerId;
    /** journal of { bondId, n, src } in order; a random call's entries are removed */
    this.entries = [];
    this.random = false;
    /** a plugin handler of the hook was skipped (EffectDispatcher._call): its layers are not in the forecast */
    this.partial = false;
    /** `${kind}:${id}` of the random sources (each once) */
    this.randomSources = new Map();
  }

  gain(bondId) {
    let n = 0;
    for (const e of this.entries) if (e.bondId === bondId) n += e.n;
    return n;
  }

  /** Before a handler call: the RNG position and the journal length. */
  mark(rng) { return { s: typeof rng?.state === 'function' ? rng.state() : null, len: this.entries.length }; }

  /** After it: a call that drew the RNG and added layers is a random source — its additions are rolled back. */
  settle(mark, rng, source) {
    const s = typeof rng?.state === 'function' ? rng.state() : null;
    if (s === mark.s || this.entries.length <= mark.len) return;
    this.entries.length = mark.len;
    this.random = true;
    const src = sourceOf(source);
    this.randomSources.set(`${src.kind}:${src.id}`, src);
  }

  /**
   * Replace the forecast player's layer functions of a preview context (makeCtx, preview.ledger).
   * @param {object} ctx the restricted preview context
   * @param {object} ps the player (read only)
   * @param {object} source the dispatch source
   * @param {object} preview the dispatcher's preview state (`dispatcher` = the isolated dispatcher)
   */
  bind(ctx, ps, source, preview) {
    const gd = ps.gd || ps.m.gd;
    const layersOf = (id) => (Number(ps.layers && ps.layers[id]) || 0) + this.gain(id);
    const bondOf = (id, b) => ({ ...structuredClone(b), layers: layersOf(id) });
    ctx.layers = (id) => layersOf(id);
    ctx.bond = (id) => (ps.bonds[id] ? bondOf(id, ps.bonds[id]) : null);
    ctx.bonds = () => Object.fromEntries(Object.entries(ps.bonds).map(([k, v]) => [k, bondOf(k, v)]));
    ctx.addLayers = (bondId, n, opts = {}) => {
      if (!gd.bond(bondId) || !Number.isFinite(n) || n <= 0) return 0;
      if (opts && opts.requireActive && !(ps.bonds[bondId] && ps.bonds[bondId].active)) return 0;
      const add = layerGainRoom(layersOf(bondId), Math.floor(n));
      if (add <= 0) return 0;
      this.entries.push({ bondId, n: add, src: sourceOf(source) });
      return add;
    };
    ctx.triggerGarrisons = (uid, eventType, opts = {}) => {
      const l = ps.find(uid);
      if (!l || l.piece.kind !== 'chess' || typeof eventType !== 'string') return 0;
      const as = opts && opts.asUid != null ? ps.find(opts.asUid) : null;
      if (opts && opts.asUid != null && (!as || as.piece.kind !== 'chess')) return 0;
      return preview.dispatcher.triggerGarrisons(ps, l.piece, eventType, { asPiece: as ? as.piece : null, triggeredBy: source.key || null });
    };
  }

  /** `{ bonds: { [bondId]: { n, sources: [{ kind, id, n }] } }, random, randomSources: [{ kind, id }], partial }` */
  result() {
    const bonds = {};
    for (const { bondId, n, src } of this.entries) {
      const b = (bonds[bondId] ??= { n: 0, sources: [] });
      b.n += n;
      const same = b.sources.find((x) => x.kind === src.kind && x.id === src.id);
      if (same) same.n += n;
      else b.sources.push({ kind: src.kind, id: src.id, n });
    }
    return { bonds, random: this.random, randomSources: [...this.randomSources.values()], partial: this.partial };
  }
}

/** What a source is called in the forecast: the strategy, the bond, the 特质's operator, the item, the effect, the global. */
function sourceOf(source) {
  const s = source || {};
  switch (s.kind) {
    case 'band': return { kind: 'band', id: String(s.bandId ?? s.key) };
    case 'bond': return { kind: 'bond', id: String(s.bondId ?? s.key) };
    case 'garrison': return { kind: 'garrison', id: String((s.piece && s.piece.id) ?? s.key) };
    case 'item': return { kind: 'item', id: String((s.piece && s.piece.id) ?? s.key) };
    case 'effect': return { kind: 'effect', id: String((s.ref && s.ref.id) ?? s.key) };
    default: return { kind: String(s.kind || 'global'), id: String(s.key || '') };
  }
}

/** player → { key, value }: the last forecast and the inputs it was computed from (never saved: no Match field). */
const memo = new WeakMap();

/** The inputs a prep-end handler reads: the player's pieces, layers, bonds, strategy, effects, counters, round stats. */
function inputsKey(m, ps) {
  const mates = m.alivePlayers().filter((p) => p !== ps).map((p) => [p.playerId, p.layers, [...p.board.values()].map((x) => x && x.id)]);
  return JSON.stringify([m.round, ps.bandId, [...ps.board], ps.hand, ps.temp, ps.layers, ps.bondCountBonus, ps.bonds,
    ps.effects, ps.counters, ps.round, ps.shop.level, ps.funds, ps.lp, mates]);
}

/**
 * m.private `layerForecast` (see the header), or null outside PREP / for an eliminated seat. Memoized per player on the
 * inputs; never consumes the match RNG or changes the match.
 * @param {import('./Match.js').Match} m
 * @param {import('./PlayerState.js').PlayerState} ps
 */
export function layerForecast(m, ps) {
  if (!m || !ps || m.phase !== PHASE.PREP || !ps.alive || ps.isBot || ps.left || ps.connected === false) return null;
  if (!m.dispatcher || typeof m.dispatcher.forecastLayers !== 'function') return null;
  let key;
  try { key = inputsKey(m, ps); } catch { key = null; }
  const hit = memo.get(ps);
  if (key && hit && hit.key === key) return hit.value;
  let value;
  try { value = m.dispatcher.forecastLayers(ps); } catch (e) { m.reportError?.('layerForecast', e); value = null; }
  if (key) memo.set(ps, { key, value });
  return value;
}
