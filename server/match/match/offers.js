// Declarative plugin windows, PLUGINS §10b. No plugin code, no shared RNG consumption.
// [ASSUMED] Uniform draws per seat; bots/auto/bot take the first grantable slot, skip grants nothing.
// Strict majority resolves the rest with that fallback. quorum:none never gates the phase.
// `when.bands` narrows the participants to players of these bands; a card's `when` ({ solo: true } / { seat: k })
// is a per-picker condition checked at open time and again at every pick — declarative data, never code.
import { ERR } from '../../../shared/constants.js';
import { offerAt, offersAt, offerSelectors, offerVariantIds, offerDefaultVariant } from '../../../shared/plugins/offers.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { OK, fail } from './common.js';

export const OFFER_CLOSED = Object.freeze(['settled', 'timeout', 'none']);

export class MatchOffers {
  /** Returns open only when the caller must install a continuation. Zero seconds creates nothing. */
  openOfferWindow(at, round) {
    const list = offersAt(this.offers, { at, round }).filter(({ offer }) => offer.windowSec > 0 && offer.cards?.length >= offer.slots);
    const alive = this.alivePlayers().filter(p => !p.left);
    if (!list.length || !alive.length) return 'none';
    for (const { pluginId, offer } of list) {
      const participants = alive.filter(ps => this._offerBandOk(ps, offer));
      if (!participants.length) continue; // a window nobody may open creates nothing
      const w = {
        id: offer.id, pluginId, offer, at, round, seq: this.offerSeq++, slots: offer.slots,
        quorum: offer.quorum, onTimeout: offer.onTimeout, refresh: offer.refresh,
        deadline: this.sched.now() + this.scaled(offer.windowSec * 1000),
        options: new Map(), picks: new Map(), refreshUsed: new Map(), closed: false,
      };
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
    const base = w.options.get(ps.playerId)[idx];
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
    // [ASSUMED] Try current slots in order; if none can grant, close with an explicit skipped pick.
    let idx = null;
    if (w.onTimeout !== 'skip') for (let i = 0; i < w.slots; i++) {
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
