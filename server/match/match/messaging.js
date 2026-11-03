// server/match/match/messaging.js — Match methods: messaging — unicast, broadcast, toasts, the ticker lines
// (config.broadcasts by type; the remake's CUSTOM lines), the dirty marks and flush: m.private per player only when it
// changed (plus the prep scouts of that player's board), m.public throttled (DELAYS.PUBLIC_THROTTLE) and deduplicated.
// i18n (docs/I18N.md): a toast / CUSTOM line is a string (its own msgid) or a shared/i18n.js msg(msgid, params); the frame
// carries `text` (the Chinese rendering, what older clients show) plus `msgid` / `params`; a broadcast line carries its
// `args` so the client can fill the localized config.broadcasts template.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { DELAYS } from './common.js';
import { wireMessage } from '../../../shared/i18n.js';

export class MatchMessaging {
  sendTo(playerId, msg, encoded = null) {
    if (this.disposed) return false;
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return false;
    try { return !!this.sendFn(playerId, msg, encoded); } catch (e) { this.reportError('send', e); return false; }
  }

  broadcast(msg, encoded = null) {
    if (this.disposed) return;
    try { this.broadcastFn(msg, encoded); } catch (e) { this.reportError('broadcast', e); }
  }

  /** @param {string|{ msgid: string, params?: object }} text a string or msg() (shared/i18n.js) */
  toast(ps, kind, text) {
    if (!ps || ps.isBot || ps.left || !ps.connected) return;
    this.sendTo(ps.playerId, { t: 'm.toast', kind, ...wireMessage(text) });
  }

  /** Broadcast ticker from config.broadcasts by type; `param` picks the variant (SHOP_LEVEL level, BOSS_HIT share…). */
  tickerFor(type, args = [], { playerId = null, to = null, param = null } = {}) {
    const list = Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts.filter((b) => b && b.type === type) : [];
    let b = list[0];
    if (param != null) b = list.find((x) => Array.isArray(x.params) && x.params.includes(String(param))) || b;
    const tpl = b && typeof b.text === 'string' ? b.text : null;
    if (!tpl) return;
    const text = tpl.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] != null ? String(args[Number(i)]) : ''));
    const msg = { t: 'm.ticker', text, id: b.id, type, priority: Number(b.priority) || 0, playerId, args: args.map((a) => String(a ?? '')) };
    if (to) this.sendTo(to, msg);
    else this.broadcast(msg);
  }

  /**
   * A ticker line of the remake's own (type CUSTOM). `priority`: the match-flow notices (隐秘核心已解锁, 联防阶段, a player out
   * or gone) take FLOW_TICKER_PRIORITY so the strip does not hold them behind shop-level lines; other lines 0.
   */
  tickerText(text, priority = 0) {
    if (!text) return;
    const w = wireMessage(text);
    this.broadcast({ t: 'm.ticker', ...w, text: w.text.slice(0, 200), id: null, type: 'CUSTOM', priority: Number(priority) || 0, playerId: null });
  }

  markPublic() { this._pubDirty = true; this._persistRev = (this._persistRev | 0) + 1; }
  /**
   * A player's state changed: its m.private and (throttled, deduplicated) m.public (level, board, bonds…) — in a boss
   * round's prep also its pair partner's m.private, which shows this board on its other half (bossMate, item 51).
   * `_persistRev` (移植自用户分支) rides along: every player-level mutation reports through here, so the match
   * checkpoints' cheap dirty check (snapshot.js persistVersion) sees nested state move without a deep compare.
   */
  markPrivate(ps) {
    if (!ps) return;
    this._privDirty.add(ps);
    this._pubDirty = true;
    this._persistRev = (this._persistRev | 0) + 1;
    // the priceOf cache epoch (player/economy.js): every player-level mutation reported through the standard
    // path invalidates the memo — counters ride their own exact fingerprint inside priceOf
    ps._priceRev = (ps._priceRev | 0) + 1;
    const m = this._bossMateOf(ps);
    if (m) this._privDirty.add(m.mate);
  }

  /** Send pending m.private (per player, only when changed) and m.public (throttled ≤ 10/s). */
  flush(forcePublic = false) {
    if (this.disposed) return;
    if (this._privDirty.size) {
      const list = [...this._privDirty];
      this._privDirty.clear();
      for (const ps of list) {
        if (!(ps.isBot || ps.left || !ps.connected)) this._sendPrivate(ps, false);
        this._notifyPrepScouts(ps);
      }
      this._lastPrivFlushAt = this.sched.now();
    }
    if (this._pubDirty || forcePublic) this._maybeSendPublic(forcePublic);
  }

  /**
   * A coalescing flush (perf, msg path): the pending views go out at once while the match has not flushed for
   * DELAYS.PRIVATE_FLUSH (50 real ms — an isolated intent keeps its synchronous view), otherwise a single tracked
   * timer sends them within the window. Callers are the paths whose per-call flush is pure repetition under load:
   * every non-structural intent (platform._handleSeatIntent) and every bot / timer callback (infra.guard). The
   * force events — phase / round / ended changes, b.result, disconnect / reconnect / leave, dispose — call
   * flush() (or flush(true)) directly and never wait. On a virtual scheduler (tests) coalescing is bypassed: the
   * suites keep the synchronous "view right after the intent" contract; the deferral itself is covered by
   * test/match/flush-coalesce.test.js on a real scheduler.
   */
  flushSoon() {
    if (this.disposed) return;
    const now = this.sched.now();
    if (this.sched.virtual || now - this._lastPrivFlushAt >= DELAYS.PRIVATE_FLUSH) { this.flush(); return; }
    if (this._flushTimer) return;
    this._flushTimer = this.later(DELAYS.PRIVATE_FLUSH - (now - this._lastPrivFlushAt), () => {
      this._flushTimer = null;
      try { this.flush(); } catch (e) { this.reportError('flush', e); }
    });
  }

  _sendPrivate(ps, force) {
    let view;
    try { view = ps.privateView(); } catch (e) { this.reportError('privateView', e); return; }
    // One stringify for both uses: `json` is the dedup baseline and, passed on as `encoded`, the wire bytes the
    // transport would otherwise produce again with encode(view) (server/lobby.js sendToPlayer).
    const json = JSON.stringify(view);
    if (!force && json === ps._lastPriv) return;
    ps._lastPriv = json;
    this.sendTo(ps.playerId, view, json);
  }

  _maybeSendPublic(force) {
    const now = this.sched.now();
    if (!force && now - this._lastPubAt < DELAYS.PUBLIC_THROTTLE) {
      if (!this._pubTimer) {
        const wait = Math.max(1, DELAYS.PUBLIC_THROTTLE - (now - this._lastPubAt));
        this._pubTimer = this.sched.setTimeout(() => {
          this._pubTimer = null;
          if (this.disposed) return;
          try { this._maybeSendPublic(false); } catch (e) { this.reportError('public', e); }
        }, wait);
      }
      return;
    }
    this._pubDirty = false;
    let view;
    try { view = this.publicView(); } catch (e) { this.reportError('publicView', e); return; }
    // One stringify for both uses: `bytes` is the wire frame (serverNow included) passed on as `encoded`, and the
    // dedup baseline is the same text with `"serverNow":…,` spliced out — what JSON.stringify of the view minus
    // serverNow produces. serverNow is the only per-frame field; publicView puts the key right after deadline, and
    // everything before it is fixed (t / phase / round / lastRound / deadline), so the first `"serverNow":` in the
    // text is the key and the first `,` after it closes the number.
    const bytes = JSON.stringify(view);
    const i = bytes.indexOf('"serverNow":');
    const cut = i < 0 ? -1 : bytes.indexOf(',', i);
    const json = cut < 0 ? bytes : bytes.slice(0, i) + bytes.slice(cut + 1);
    if (!force && json === this._lastPubJson) return;
    this._lastPubJson = json;
    // Snapshot building / serialization can take time; throttle from the actual broadcast, not its start.
    this._lastPubAt = this.sched.now();
    this.broadcast(view, bytes);
  }
}
