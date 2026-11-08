// ui/prediction.js — client-side prediction of the prep intents (移植自 Stardust-minus rel26 2d3ec08e; the owner's
// request of 2026-11-02: 商店购买、出售、部署干员、刷新 must not wait for the server under a high RTT or packet loss).
//
// Every g.* intent of ui/gameActions.js goes through `submit`. While the own seat is in its prep, a predictable intent
// (ui/gameLogic/predict.js) is applied to the shown m.private at once and stays pending:
//   - every authoritative m.private (main.js → `authoritative`) is shown with the still-pending intents replayed over
//     it, and a pending intent is dropped the moment a state already reflects its effect (`absorb`,
//     ui/gameLogic/predict.js absorbedView) — this port's replacement for the fork's m.private `ack`, which echoed
//     the handled intents' rids (this repo's server/ and shared/ stay untouched, so there is no ack to read);
//   - an intent also leaves the pending list when its request fails (refused, timed out, the socket dropped — the
//     reply of a sent request is never resent, so a dropped intent can never be applied twice), or SETTLE_MS after
//     its ok reply without such a state;
//   - the server stays the only authority: a refused or different outcome is replaced by the next state.
// The ok reply may overtake the state that contains the effect (server/match/match/platform.js _handleSeatIntent
// coalesces the non-structural views through flushSoon, ≤ 50 ms): the prediction stays shown until the state lands,
// so the bought card never blinks out and back.
//
// A piece bought by prediction has a negative placeholder uid. An intent that names it (dragged onto the board, sold,
// equipped) is shown at once but sent only when the purchase is absorbed and the real uid is known
// (gameLogic/predict.js resolveBought); intents are always sent in the order they were made, so every intent made
// after a waiting one waits too — the server applies them in the order the prediction did.

import { absorbedView, isPredictable, replayIntents, resolveBought, pieceUids } from './gameLogic/predict.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { data } from '../data.js';
import { PHASE } from '../../../shared/constants.js';

/** An acknowledged-but-unseen intent is dropped from the replay this long after its reply. [ASSUMED] */
export const SETTLE_MS = 3000;
const UID_FIELDS = ['uid', 'itemUid', 'targetUid', 'replaceUid'];

/** An error like net.js NetError (ui/toasts.js toastError reads `code`). */
const refusal = (code) => Object.assign(new Error(code), { code });

/**
 * @param {{
 *   request: (t: string, fields: object, opts?: object) => Promise<any>,
 *   lookups: { getChess: (id: string) => any, getItem: (id: string) => any, sellPrice?: (id: string, golden: boolean) => number, shopConfig?: () => any },
 *   publish: (view: any) => void,
 *   canPredict?: () => boolean,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 * }} deps
 */
export function createPrediction({ request, lookups, publish, canPredict = () => true, timers = globalThis }) {
  let auth = null;              // the last authoritative m.private
  let before = new Set();       // piece uids of `auth`
  let made = new Map();         // op id → the placeholder its purchase made (the last replay)
  let resolved = new Map();     // placeholder uid → the real uid, once known (a drag begun on the placeholder may end later)
  let ops = [];                 // pending, in order: { id, t, fields, absorb, dep, predict, sent, replied, ok, timer, resolve, reject }
  let nextId = 1;

  const replay = () => {
    if (!auth || !ops.some((o) => o.predict)) return { priv: auth, made: new Map(), applied: new Set(), absorb: new Map() };
    return replayIntents(auth, ops.filter((o) => o.predict), lookups);
  };
  const view = () => { const r = replay(); made = r.made; return r.priv; };
  const show = () => publish(view());

  function drop(op) {
    const i = ops.indexOf(op);
    if (i < 0) return false;
    ops.splice(i, 1);
    if (op.timer != null) { try { timers.clearTimeout(op.timer); } catch { /* ignore */ } op.timer = null; }
    return true;
  }

  /** The intents waiting on `op`'s placeholder fail with it. */
  function failDependents(op, err) {
    for (const d of ops.filter((o) => o.dep === op.id)) {
      drop(d);
      failDependents(d, err);
      d.reject(err);
    }
  }

  function send(op) {
    op.sent = true;
    let p;
    try { p = Promise.resolve(request(op.t, op.fields, {})); }
    catch (err) { p = Promise.reject(err); }
    p.then((reply) => {
      op.replied = true; op.ok = true;
      // nothing to protect visually: not predicted, or already absorbed by a state that beat the reply here
      if (!op.predict || !ops.includes(op)) { if (drop(op) && op.predict) show(); }
      else if (op.timer == null) op.timer = timers.setTimeout(() => { op.timer = null; if (drop(op)) { show(); pump(); } }, SETTLE_MS);
      pump();
      op.resolve(reply);
    }, (err) => {
      const was = drop(op);
      failDependents(op, err);
      if (was) show();
      pump();
      op.reject(err);
    });
  }

  /** Send what may go now: in order, up to the first intent still waiting for a purchase's uid. */
  function pump() {
    for (const op of ops) {
      if (op.sent) continue;
      if (op.dep != null) break;
      send(op);
    }
  }

  return {
    /**
     * An authoritative m.private arrived: drop what it already reflects, resolve placeholders, send what can go;
     * returns the view to show (the server's own object when nothing is pending).
     * @param {any} priv
     */
    authoritative(priv) {
      if (!priv || (auth && priv.playerId !== auth.playerId)) this.reset();
      if (!priv) return priv;
      const lastMade = made;
      for (const op of [...ops]) {
        if (!op.sent || !absorbedView(priv, op.absorb)) continue;
        if (op.t === 'g.buy') {
          // the placeholder the last replay showed, else (that replay could not apply the purchase) its card's id
          const m = lastMade.get(op.id) || (op.buyId ? { uid: -op.id, idx: -1, id: op.buyId, kind: op.buyKind } : null);
          if (m) {
            const real = resolveBought(priv, before, m);
            if (real != null) resolved.set(m.uid, real);
            for (const d of ops.filter((o) => o.dep === op.id)) {
              if (real == null) { drop(d); failDependents(d, refusal('BAD_TARGET')); d.reject(refusal('BAD_TARGET')); continue; }
              for (const k of UID_FIELDS) if (d.fields[k] === m.uid) d.fields[k] = real;
              if (d.absorb && d.absorb.uid === m.uid) d.absorb = { ...d.absorb, uid: real };
              d.dep = null;
            }
          } else {
            // a purchase that made no placeholder (a merge, an item): nothing can name it
            for (const d of ops.filter((o) => o.dep === op.id)) { drop(d); failDependents(d, refusal('BAD_TARGET')); d.reject(refusal('BAD_TARGET')); }
          }
        }
        drop(op);
      }
      auth = priv;
      before = pieceUids(priv);
      pump();
      return view();
    },

    /**
     * Send an intent (predicting it when it can). `predicted`: the shown view changed at once (the caller plays its
     * sound now instead of on the reply).
     * @param {string} t
     * @param {object} [fields]
     * @returns {{ promise: Promise<any>, predicted: boolean }}
     */
    submit(t, fields = {}) {
      const f = { ...(fields && typeof fields === 'object' ? fields : {}) };
      // a placeholder uid: the purchase that made it
      let dep = null;
      for (const k of UID_FIELDS) {
        if (!(Number.isInteger(f[k]) && f[k] < 0)) continue;
        if (resolved.has(f[k])) { f[k] = resolved.get(f[k]); continue; }
        const owner = ops.find((o) => o.id === -f[k] && o.t === 'g.buy');
        if (!owner) return { promise: Promise.reject(refusal('BAD_TARGET')), predicted: false };
        dep = owner.id;
      }
      const waiting = ops.some((o) => !o.sent);
      // the server's gate (player/prep.js _gate): alive, its prep, not Ready — the own seat only (a spectator has no
      // m.private at all, so `auth` never fills for one)
      const active = !!auth && auth.alive !== false && auth.ready !== true && canPredict() && isPredictable(t);
      // nothing pending to keep in order and nothing to predict: the plain request, as before the prediction
      if (!active && !waiting && dep == null) {
        let promise;
        try { promise = Promise.resolve(request(t, f, {})); } catch (err) { promise = Promise.reject(err); }
        return { promise, predicted: false };
      }
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const op = { id: nextId++, t, fields: f, absorb: null, dep, predict: active, sent: false, replied: false, ok: false, timer: null, resolve, reject };
      // the card a purchase takes: its absorb (a sold slot is base-independent) and the id its placeholder is found by
      if (t === 'g.buy') {
        const slot = Number.isInteger(f.slot) ? f.slot : -1;
        if (slot >= 0) op.absorb = { kind: 'buy', slot };
        const s = slot >= 0 ? (view() || auth)?.shop?.slots?.[slot] : null;
        if (s && typeof s.id === 'string') { op.buyId = s.id; op.buyKind = s.kind === 'item' ? 'item' : 'chess'; }
      }
      ops.push(op);
      let predicted = false, shown = null;
      if (active) {
        const r = replay();
        made = r.made;
        predicted = r.applied.has(op.id);
        shown = r.priv;
        const a = r.absorb.get(op.id);
        if (a) op.absorb = a;
        // not predictable after all (a merge, a full hand…): it waits for the server like before, but stays in order
        if (!predicted) op.predict = false;
      }
      if (!waiting && dep == null) send(op);
      if (predicted) publish(shown);
      return { promise, predicted };
    },

    /** The match is gone (or another seat's state arrived): forget everything; intents not sent yet fail. */
    reset() {
      for (const op of ops) { if (op.timer != null) { try { timers.clearTimeout(op.timer); } catch { /* ignore */ } } if (!op.sent) op.reject(refusal('CLOSED')); }
      ops = []; auth = null; before = new Set(); made = new Map(); resolved = new Map();
    },

    /** Diagnostics / tests: the pending intents. */
    pending() { return ops.map((o) => ({ id: o.id, t: o.t, fields: { ...o.fields }, absorb: o.absorb && JSON.parse(JSON.stringify(o.absorb)), sent: o.sent, replied: o.replied, dep: o.dep })); },
    /** A live seat's state has flowed through here (false for a spectator, between matches, after a reset). */
    get enabled() { return !!auth; },
  };
}

/** localStorage key that switches the prediction off in this browser ('1'), e.g. to compare or to rule it out. */
export const NO_PREDICT_KEY = 'sp.noPredict';
const switchedOff = () => { try { return globalThis.localStorage?.getItem(NO_PREDICT_KEY) === '1'; } catch { return false; } };

/**
 * The level-up / sell-price data the client resolves from its own config, mirroring server/match/gamedata.js
 * upgradeBase / shopSlots / sellPrice for the match's mode (m.public `modeId`; the room's content set — data.js reads
 * it — is what the server's GameData read too). Null fields leave the level-up's layout and price to the server.
 */
function shopConfig() {
  const cfg = data.get('config');
  if (!cfg || typeof cfg !== 'object') return null;
  const pub = store.get().match?.public;
  const modes = cfg.modes && typeof cfg.modes === 'object' ? cfg.modes : null;
  const mode = modes && pub && typeof pub.modeId === 'string'
    ? (Array.isArray(modes) ? modes.find((x) => x && (x.modeId === pub.modeId || x.id === pub.modeId)) : modes[pub.modeId]) : null;
  // GameData merges the mode's config-key overrides over the config (its constructor); maxShopLevel reads the mode itself
  const merged = { ...cfg };
  if (mode && typeof mode === 'object') for (const k of Object.keys(cfg)) if (k !== 'modes' && Object.hasOwn(mode, k)) merged[k] = mode[k];
  const economy = merged.economy && typeof merged.economy === 'object' ? merged.economy : {};
  const slots = mode && typeof mode === 'object' && mode.shopSlots && typeof mode.shopSlots === 'object' ? mode.shopSlots : null;
  const prices = mode && typeof mode === 'object' && Array.isArray(mode.upgradePrices) ? mode.upgradePrices : null;
  const max = mode && typeof mode === 'object' && Number.isInteger(mode.maxShopLevel) ? mode.maxShopLevel : 6;
  return {
    upgradeBase(level) {
      if (!prices || level >= max) return null;
      const v = prices[level - 1];
      return Number.isFinite(v) ? v : null;
    },
    shopSlots(level) {
      const s = slots ? slots[String(level)] : null;
      if (!s || typeof s !== 'object') return null;
      const chess = Number.isInteger(s.chess) && s.chess >= 0 ? s.chess : 3;
      const item = Number.isInteger(s.item) && s.item >= 0 ? s.item : 0;
      return { chess: Math.min(chess, 8), item: Math.min(item, 4) };
    },
    sellPrice(id, golden) {
      const row = economy.chessPrice && typeof economy.chessPrice === 'object' ? economy.chessPrice[id] : null;
      if (row && typeof row === 'object') { const v = golden ? row.golden : row.normal; return Number.isFinite(v) ? v : 1; }
      return 1;
    },
  };
}

/** The page's prediction: net.request looked up at call time (the dev mock harness and tests stub it). */
export const prediction = createPrediction({
  request: (t, fields, opts) => net.request(t, fields, opts),
  lookups: {
    getChess: (id) => data.lookup('chess', id),
    getItem: (id) => data.lookup('items', id),
    sellPrice: (id, golden) => shopConfig()?.sellPrice(id, golden),
    shopConfig,
  },
  publish: (view) => store.patch('match', { private: view }),
  // the own seat's prep only (a spectator has no m.private at all)
  canPredict: () => !switchedOff() && store.get().match?.public?.phase === PHASE.PREP,
});
// the match left the screen (store.js emptyMatch): nothing of it may be replayed onto the next one
store.subscribe((s, prev) => { if (prev?.match?.private && !s.match?.private) prediction.reset(); });
