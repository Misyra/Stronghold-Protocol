// Declarative plugin windows, PLUGINS §10b. No plugin code, no shared RNG consumption.
// [ASSUMED] Uniform draws per seat; bots/auto/bot take the first grantable slot, skip grants nothing.
// Strict majority resolves the rest with that fallback. quorum:none never gates the phase.
// `when.bands` narrows the participants to players of these bands; a card's `when` ({ solo: true } / { seat: k })
// is a per-picker condition checked at open time and again at every pick — declarative data, never code.
import { ERR, PHASE } from '../../../shared/constants.js';
import { offerAt, offersAt, offerSelectors, offerVariantIds, offerDefaultVariant } from '../../../shared/plugins/offers.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { OK, fail } from './common.js';

export const OFFER_CLOSED = Object.freeze(['settled', 'timeout', 'none']);
/** Phases a `prep` window can no longer be answered in: the prep is over (the round's battle or its settlement). */
const PREP_OVER = Object.freeze([
  PHASE.COMBAT, PHASE.UNITE, PHASE.SETTLE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE, PHASE.RESULT,
]);

export class MatchOffers {
  /** Returns open only when the caller must install a continuation. Zero seconds creates nothing. */
  openOfferWindow(at, round) {
    const list = offersAt(this.offers, { at, round }).filter(({ offer }) => offer.windowSec > 0 && offer.cards?.length >= offer.slots);
    const alive = this.alivePlayers().filter(p => !p.left);
    if (!list.length || !alive.length) return 'none';
    for (const { pluginId, offer } of list) {
      // A card's display quote must agree with its item's contract spec; a disagreement is a data bug, so the window
      // is not loaded rather than showing one economy and settling another (PLUGINS §10b, cards `quote`).
      const mismatch = this._offerQuoteMismatch(offer);
      if (mismatch) {
        this.log?.error?.(`[match ${this.roomCode}] offer ${pluginId}/${offer.id} refused: ${mismatch}`);
        continue;
      }
      const participants = alive.filter(ps => this._offerBandOk(ps, offer));
      if (!participants.length) continue; // a window nobody may open creates nothing
      const w = {
        id: offer.id, pluginId, offer, at, round, seq: this.offerSeq++, slots: offer.slots,
        quorum: offer.quorum, onTimeout: offer.onTimeout, refresh: offer.refresh,
        deadline: this.sched.now() + this.scaled(offer.windowSec * 1000),
        options: new Map(), picks: new Map(), refreshUsed: new Map(), closed: false,
      };
      // `slots` is the window's *upper bound*, not a promise of that many cards: a picker whose `when` cards are
      // filtered out may see fewer (never zero — such a picker does not hold a seat in the window). The rest of the
      // window therefore always reads each picker's own `options.length`, never the declared count (a fallback that
      // ran over `slots` would reach a slot this seat does not have).
      for (const ps of participants) {
        const options = this._offerOptions(w, ps);
        if (!options.length) continue; // no card is eligible for this picker — the window does not open for them
        w.options.set(ps.playerId, options);
        w.refreshUsed.set(ps.playerId, Array(w.slots).fill(0));
      }
      if (!w.options.size) continue;
      this.offerWin.push(w);
      this._offerTimers.set(w, this.later(this.scaled(offer.windowSec * 1000), () => this._offerDeadline(w)));
      for (const ps of this._offerParticipants(w)) if (ps.botControlled) this._offerBot(ps, w);
      this._offerSettleIfDone(w);
    }
    this._offerProgress();
    this.markPublic();
    return this.offerBlocking() ? 'open' : 'settled';
  }

  _offerRng(w, ps, salt = 'initial') {
    return createRng(deriveSeed(this.seed, `offer:${w.pluginId}:${w.id}:${w.at}:${w.round}:${w.seq}:${ps.seat}:${salt}`));
  }

  /** `when.bands`: absent or empty opens for everyone; otherwise only players of these bands. */
  _offerBandOk(ps, offer) {
    const bands = offer.when?.bands;
    return !bands?.length || bands.includes(ps.bandId);
  }

  /**
   * The first card/variant whose display `quote` disagrees with the `contract` spec of the item it grants, or null.
   * The spec (`{ fraction, multiplier }` on the item record, data plugin side) is the settlement's own table, so a
   * quote can never promise an economy the handler does not pay. An item without a spec is not checked (the quote is
   * still display-only); a variant inherits the base quote when it declares none.
   */
  _offerQuoteMismatch(offer) {
    const check = (effect, quote, at) => {
      if (!quote) return null;
      const itemId = effect && typeof effect === 'object' && typeof effect.item === 'string' ? effect.item : null;
      const spec = itemId ? this.gd.item(itemId)?.contract : null;
      if (!spec) return null;
      if (quote.fraction === spec.fraction && quote.multiplier === spec.multiplier) return null;
      return `${at} quote ${quote.fraction}x${quote.multiplier} != ${itemId} contract ${spec.fraction}x${spec.multiplier}`;
    };
    for (const card of offer.cards || []) {
      const bad = check(card.effect, card.quote, card.id);
      if (bad) return bad;
      for (const [id, variant] of Object.entries(card.variants || {})) {
        const vbad = check(variant.effect, variant.quote, `${card.id}/${id}`);
        if (vbad) return vbad;
      }
    }
    return null;
  }

  /** A card's picker condition: solo = the picker is the room's last standing player; seat k = another player holds it. */
  _offerCardOk(ps, card) {
    const when = card.when;
    if (!when) return true;
    if (when.solo) {
      const alive = this.alivePlayers().filter(p => !p.left);
      return alive.length === 1 && alive[0] === ps;
    }
    if (when.seat !== undefined) return this.alivePlayers().some(p => p !== ps && !p.left && p.alive && p.seat === when.seat - 1);
    return true;
  }

  _offerOptions(w, ps) {
    const pool = w.offer.cards.filter(c => this._offerCardOk(ps, c));
    return this._offerRng(w, ps).shuffle(pool).slice(0, w.slots);
  }

  _offerParticipants(w) {
    return this.alivePlayers().filter(ps => !ps.left && w.options.has(ps.playerId));
  }

  _offerWaiting(w) {
    return this._offerParticipants(w).filter(ps => !w.picks.has(ps.playerId));
  }

  offerBlocking() {
    return this.offerWin.some(w => !w.closed && w.quorum !== 'none');
  }

  /** Snapshot (also used on reconnect and by spectators). Never includes executable effects. */
  offerViews() {
    return this.offerWin.filter(w => !w.closed).map(w => ({
      id: w.id, pluginId: w.pluginId, seq: w.seq, at: w.at, round: w.round,
      deadline: w.deadline, windowSec: w.offer.windowSec, quorum: w.quorum,
      ...(w.offer.selector ? { selector: w.offer.selector } : {}),
      ...(w.offer.selectors ? { selectors: w.offer.selectors } : {}),
      ...(w.offer.title ? { title: w.offer.title } : {}),
      waiting: this._offerWaiting(w).length, players: this._offerParticipants(w).length,
      seats: this._offerParticipants(w).map(ps => ({
        playerId: ps.playerId, picked: w.picks.has(ps.playerId),
        ...(offerSelectors(w.offer).length ? { variantId: w.picks.get(ps.playerId)?.variantId ?? offerDefaultVariant(w.offer) } : {}),
        slots: w.options.get(ps.playerId).map((c, idx) => ({
          idx, id: c.id, name: c.name, desc: c.desc, icon: c.icon,
          available: this._offerAvailable(ps, c),
          ...(c.quote ? { quote: c.quote } : {}),
          ...(c.variants ? { variants: Object.fromEntries(Object.entries(c.variants).map(([id, v]) => [id, {
            available: this._offerAvailable(ps, { ...c, ...v }), ...(v.quote ? { quote: v.quote } : {}),
          }])) } : {}),
          remaining: Math.max(0, (w.refresh?.perSlot || 0) - w.refreshUsed.get(ps.playerId)[idx]),
        })),
      })),
    }));
  }

  requestOffer(ps, offerId, idx, identity = null) {
    const w = this._openOffer(offerId, identity);
    const refusal = this._offerCanPick(ps, w, idx, identity?.cardId);
    if (refusal) return refusal;
    const variantId = identity?.variantId ?? offerDefaultVariant(w.offer);
    if (variantId !== undefined && !offerVariantIds(w.offer).includes(variantId)) return fail(ERR.BAD_TARGET);
    if (!this._offerApply(ps, w, idx, variantId)) return fail(ERR.BAD_TARGET);
    w.picks.set(ps.playerId, { idx, ...(variantId === undefined ? {} : { variantId }) });
    this._offerSettleIfDone(w);
    this._offerProgress();
    return OK;
  }

  _offerCanPick(ps, w, idx, cardId) {
    if (!w || this.disposed || this.ended || this.sched.now() >= w.deadline) return fail(ERR.WRONG_PHASE);
    // A prep window is live only while the prep is still ahead or running: once the round moved into its battle or
    // settled it (COMBAT/UNITE/SETTLE, the Final Assault / Hidden Core, RESULT), a stale window must not accept a pick
    // (P1: a pref window left open at endPrep accepted g.offer during COMBAT). The pre-prep holds (ROUND_START, the
    // 機变 draft, PREP itself) all answer for the same prep.
    if (w.at === 'prep' && PREP_OVER.includes(this.phase)) return fail(ERR.WRONG_PHASE);
    if (!ps || !ps.alive || ps.left || !w.options.has(ps.playerId)) return fail(ERR.ELIMINATED);
    if (!Number.isInteger(idx) || idx < 0 || idx >= w.slots || !w.options.get(ps.playerId)[idx]) return fail(ERR.BAD_TARGET);
    if (w.picks.has(ps.playerId)) return fail(ERR.ALREADY);
    if (cardId !== undefined && w.options.get(ps.playerId)[idx].id !== cardId) return fail(ERR.BAD_TARGET, 'slot changed');
    return null;
  }

  requestOfferRefresh(ps, offerId, idx, identity = null) {
    const w = this._openOffer(offerId, identity);
    const refusal = this._offerCanPick(ps, w, idx, identity?.cardId);
    if (refusal) return refusal;
    const used = w.refreshUsed.get(ps.playerId);
    if (used[idx] >= (w.refresh?.perSlot || 0)) return fail(ERR.RATE);
    const options = w.options.get(ps.playerId);
    // [ASSUMED] Prefer unseen cards, else allow another slot's card; never charge for the same card.
    let pool = w.offer.cards.filter(c => this._offerCardOk(ps, c) && !options.some(o => o.id === c.id));
    if (!pool.length) pool = w.offer.cards.filter(c => this._offerCardOk(ps, c) && c.id !== options[idx].id);
    if (!pool.length) return fail(ERR.BAD_TARGET);
    used[idx]++;
    options[idx] = this._offerRng(w, ps, `refresh:${idx}:${used[idx]}`).pick(pool);
    this.markPublic();
    return OK;
  }

  _offerAvailable(ps, card) {
    if (card.when && !this._offerCardOk(ps, card)) return false; // the room changed since the window opened
    const effect = card.effect;
    if (effect.item) return !!ps.gd.item(effect.item) && this.itemPool.canGain(effect.item);
    if (effect.chess) {
      const rec = ps.gd.chess(effect.chess);
      return !!rec && (!rec.isDiy || !!rec.diyFor);
    }
    return true;
  }

  _offerApply(ps, w, idx, variantId = offerDefaultVariant(w.offer)) {
    // A picker can hold fewer cards than the window declares (`when` filtering, see openOfferWindow); a fallback or a
    // stale pick that names an absent slot grants nothing rather than throwing inside the phase.
    const base = w.options.get(ps.playerId)?.[idx];
    if (!base) return false;
    // A card that declares variants must answer the requested one: a missing key is a stale/forged pick, never a
    // silent fallback to the base effect (a variant-free card — the shared Skip card — still uses its base effect).
    if (base.variants && !Object.hasOwn(base.variants, variantId)) return false;
    const card = { ...base, ...(base.variants?.[variantId] || {}) };
    if (!this._offerAvailable(ps, card)) return false;
    const effect = card.effect;
    const reason = `offer:${w.pluginId}:${w.id}`;
    if (effect.funds !== undefined) ps.addFunds(effect.funds, { reason });
    else if (effect.pendingFunds !== undefined) ps.pendingFunds += effect.pendingFunds;
    else if (effect.freeRefresh !== undefined) ps.shop.freeRefreshes += effect.freeRefresh;
    else if (effect.layers) ps.addLayers(effect.layers.bond, effect.layers.count, { reason });
    else if (effect.item && !ps.acquireItem(effect.item, { source: reason })) return false;
    else if (effect.chess && !ps.acquireChess(effect.chess, { source: reason })) return false;
    ps.dirty();
    return true;
  }

  _offerDefault(ps, w) {
    if (w.picks.has(ps.playerId)) return;
    // [ASSUMED] Try this picker's actual slots in order (it may hold fewer than the declared `slots`); if none can
    // grant, close with an explicit skipped pick.
    let idx = null;
    const options = w.options.get(ps.playerId) || [];
    if (w.onTimeout !== 'skip') for (let i = 0; i < options.length; i++) {
      if (this._offerApply(ps, w, i)) { idx = i; break; }
    }
    w.picks.set(ps.playerId, { idx, timeout: true });
  }

  _offerBot(ps, w) {
    const fallback = () => {
      this._offerDefault(ps, w);
      this._offerSettleIfDone(w);
      this._offerProgress();
    };
    if (this.botFor(ps).decide?.(this, ps, { kind: 'offer', key: `offer:${w.seq}`, deadline: w.deadline,
      valid: () => !w.closed && !w.picks.has(ps.playerId), complete: () => w.picks.has(ps.playerId), fallback })) return;
    this._offerDefault(ps, w);
  }

  _offerSettleIfDone(w) {
    if (w.closed) return;
    const total = this._offerParticipants(w).length;
    const waiting = this._offerWaiting(w);
    if (!waiting.length || w.quorum === 'majority' && total - waiting.length > total / 2) this._closeOffer(w);
    this.markPublic();
  }

  _offerDeadline(w) {
    this._closeOffer(w);
    this._offerProgress();
  }

  _closeOffer(w) {
    if (w.closed) return;
    for (const ps of this._offerWaiting(w)) this._offerDefault(ps, w);
    w.closed = true;
    this.cancel(this._offerTimers.get(w));
    this._offerTimers.delete(w);
    this.markPublic();
  }

  /** Autoplay and departed seats cannot leave a window stalled. */
  offersChanged() {
    for (const w of this.offerWin) {
      for (const ps of this._offerWaiting(w)) if (ps.botControlled) this._offerBot(ps, w);
      this._offerSettleIfDone(w);
    }
    this._offerProgress();
  }

  _offerProgress() {
    this.offerWin = this.offerWin.filter(w => !w.closed);
    if (this.offerBlocking() || !this._offerResume) return;
    const resume = this._offerResume;
    this._offerResume = null;
    this._offerResumeTimer = this.later(0, () => { this._offerResumeTimer = null; resume(); });
  }

  _openOffer(offerId, identity) {
    const found = this.offerWin.filter(w => !w.closed && w.id === offerId
      && (!identity || w.pluginId === identity.pluginId && w.seq === identity.seq));
    return found.length === 1 ? found[0] : null;
  }

  /**
   * A prep boundary: settle every window still open for the seats that did not pick, then drop all of them (and any
   * continuation they held). Called by MatchPrep.endPrep — a window declared at `prep` must not survive into the
   * battle where a stale g.offer could still grant (P1: COMBAT accepted picks because only the next startRound
   * closed them).
   */
  offersEndPrep() {
    for (const w of this.offerWin) this._closeOffer(w);
    this.offersDispose();
  }

  offersDispose() {
    this.cancel(this._offerResumeTimer);
    this._offerResumeTimer = null;
    for (const timer of this._offerTimers.values()) this.cancel(timer);
    this._offerTimers.clear();
    this.offerWin = [];
    this._offerResume = null;
  }

  offersDeclared(at, round) {
    return this.offers.some(o => offerAt(o, { at, round }));
  }
}
