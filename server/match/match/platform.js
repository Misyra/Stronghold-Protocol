// server/match/match/platform.js — Match methods: the platform interface of the server/match/Match.js header
// (server/lobby.js ⇄ Match) — start, handle (validation, error isolation, flush; the intents themselves: intents.js
// _handle), setLoadout (INFO_CHECK; rule-enabled PREP), onDisconnect / onReconnect and the full resync of one human, onLeave and 中途退出
// = elimination (_quit), the AFK rule (挂机移出: _checkIdle at each prep end, _removeIdle), dispose.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { C2S } from '../../../shared/protocol.js';
import { PHASE, ERR } from '../../../shared/constants.js';
import { syntheticResult } from '../fields.js';
import { FLOW_TICKER_PRIORITY, OFFLINE_TAKEOVER_ROUNDS, OK, fail, AFK_ACTIONS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { ruleOption } from '../../../shared/plugins/rules.js';

const GAME_TYPES = new Set(Object.keys(C2S).filter((t) => Object.hasOwn(C2S, t) && (t.startsWith('g.') || t.startsWith('b.'))));

export class MatchPlatform {
  start() {
    if (this.disposed || this.ended || this.phase !== PHASE.LOBBY) return;
    this.guard(() => {
      if (!this.gd.visibleChess.length || this.pool.entries.size === 0) {
        this.log.error?.(`[match ${this.roomCode}] game data unusable (no chess pool) — ending the match`);
        this.phase = PHASE.INFO_CHECK;
        this.markPublic();
        this.flush(true);
        this.finish({ victory: false, reason: 'error' });
        return;
      }
      this.enterInfoCheck();
    });
  }

  /**
   * @param {string} playerId
   * @param {{ t: string }} msg validated intent
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  handle(playerId, msg) {
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    return this._handleSeatIntent(ps, msg);
  }

  /** Shared human / external-AI semantic validation and dispatch. C2S schema: net.js / the adapter. */
  _handleSeatIntent(ps, msg) {
    // a spectator seat only watches (the platform routes nothing else of it)
    if (ps.spectator && (!msg || msg.t !== 'g.watch')) {
      // g.test shares the host's rate bucket (applyTestCommand audits SPECTATOR after the stamp).
      if (this.test && msg?.t === 'g.test') {
        let res;
        try { res = this.applyTestCommand(ps, msg); }
        catch (e) { this.reportError('handle g.test', e); res = fail(ERR.INTERNAL); }
        try { this.flush(); } catch (e) { this.reportError('flush', e); }
        return res && res.error ? res : OK;
      }
      return fail(ERR.SPECTATOR);
    }
    if (this.disposed || this.ended) {
      // A report that crossed the match end (the last b.progress of a field, a delegated rehearsal's answer) is stale:
      // ignored, never an error (DESIGN §14 — an error frame without a rid would surface as a toast in the browser).
      if (msg && msg.t === 'b.rehearsalResult') return OK;
      return this.clientCombat && msg && (msg.t === 'b.progress' || msg.t === 'b.result') ? OK : fail(ERR.WRONG_PHASE);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !GAME_TYPES.has(msg.t)) return fail(ERR.BAD_MSG);
    const phase = this.phase, round = this.round, ended = this.ended;
    let res;
    try {
      res = this._handle(ps, msg);
    } catch (e) {
      this.reportError(`handle ${msg.t}`, e);
      res = fail(ERR.INTERNAL);
    }
    // the AFK rule counts accepted substantive intents only (a spectator's g.watch never is one)
    if (!ps.spectator && !(res && res.error) && AFK_ACTIONS.has(msg.t)) ps.afkActed = true;
    // A phase / round / ended change in the handler is a structural event: the new views go out now. b.result too
    // (the force list: the field's final progress and, once the last field closes, the next phase's views). Every
    // other intent — the g.* prep churn and b.progress — coalesces (flushSoon): under a 4-human prep each intent
    // paid a privateView rebuild, and a boss fight's b.progress storm paid one per report; with the coalescing the
    // views land within the 50 ms window (an isolated intent still sends at once — the window is only closed after
    // a send). m.public keeps its own ≤ 10/s throttle and dedupe in every branch.
    const structural = this.phase !== phase || this.round !== round || this.ended !== ended;
    try {
      if (structural || msg.t === 'b.result') this.flush();
      else this.flushSoon();
    } catch (e) { this.reportError('flush', e); }
    if (res && typeof res === 'object' && res.error) return res;
    return OK;
  }

  /** Host-only asynchronous input, journalled by testTrace; never a C2S message. */
  externalReply(id, reply, failed) {
    this.guard(() => this.externalAI?.receive(id, reply, failed));
  }

  /**
   * room.loadout during the match (DESIGN §16): only while INFO_CHECK runs (the briefing's 干员调配 entry); the lobby
   * already checked it against the data (PlayerState.setLoadout re-checks it). `ops` (0.2.2): the per-operator 潜能 /
   * 练度 that come with it (undefined = unchanged). A room whose prepLoadout rule is prep also accepts one merge
   * during PREP while that seat has not pressed 准备 (DESIGN §34.15). INFO_CHECK stays a full replace.
   * @param {string} playerId
   * @param {Record<string, { skill: number, module: string|null }> | null} loadout
   * @param {Record<string, { potential: number, cultivate: number }> | null} [ops]
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setLoadout(playerId, loadout, ops = undefined) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    const prep = this.phase === PHASE.PREP && ruleOption(this.rules, 'prepLoadout') === 'prep';
    if (this.disposed || this.ended || (this.phase !== PHASE.INFO_CHECK && !prep)) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    if (prep && ps.ready) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    let res = OK;
    this.guard(() => {
      const before = prep ? ps.allChess().map((owner) => ({ owner, loadout: ps.loadoutFor(ps.gd.chess(owner.id)) })) : [];
      if (!ps.setLoadout(loadout, ops, prep ? { merge: true } : undefined)) { res = fail(ERR.BAD_TARGET, 'loadout does not match the game data'); return; }
      if (prep) {
        for (const { owner, loadout: previous } of before) {
          const next = ps.loadoutFor(ps.gd.chess(owner.id));
          if (['skillIndex', 'moduleId', 'potential', 'cultivate'].some((key) => previous[key] !== next[key])) ps._reconcileTokensFor(owner);
        }
        ps.recompute();
      } else this.markPrivate(ps);
    });
    return res;
  }

  /**
   * room.skins during the match (docs/SKINS.md): accepted in ANY phase, unlike the loadout just above. The loadout is
   * locked at INFO_CHECK because it changes what a unit does; a skin changes only what it looks like, and it is public —
   * a teammate picking a different model mid-match is harmless, so `markPublic` carries it to everyone on the next
   * broadcast. The lobby already filtered the shape (freezeSkins); PlayerState.setSkins re-checks it and refuses a
   * bad map without clearing the choice already stored.
   * @param {string} playerId
   * @param {Record<string, string> | null} skins
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setSkins(playerId, skins) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    let res = OK;
    this.guard(() => {
      // an empty selection is a valid one: it clears every skin. A bad map leaves the stored choice alone.
      if (!ps.setSkins(skins)) { res = fail(ERR.BAD_MSG, 'bad skin selection'); return; }
      // [ASSUMED] Live cosmetic changes refresh every existing prep view, using the same dirty path as a move.
      // The public choice also reaches current battle renderers; no running sim or BattleSpec is changed.
      this.markPrivate(ps);
      this.markPublic();
    });
    return res;
  }

  onDisconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || this.disposed) return;
    this.guard(() => {
      ps.connected = false;
      // A disconnected human's silence is never consent to a new setup.
      this.cancelSetupVote();
      // 投票移出(移植自用户分支): a voter goes, a target stays a target (kickVote.js)
      this._kickVoteMemberGone(playerId);
      // a paused solo battle resumes (the server takes the field over; nobody is left to resume it)
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'disconnect');
      // a rehearsal this host was running falls back to the server (DESIGN §14; a no-op without tasks)
      this._rehearsalHostChanged();
      this.markPublic();
    });
    // the disconnect is on the record at once (private views flush now; m.public keeps its ≤ 10/s throttle)
    this.flush();
  }

  onReconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      const was = ps.connected;
      ps.connected = true;
      // 掉线由 AI 接管(移植自用户分支): back in the match, the player plays the seat again (an AI 托管 of its own
      // choice stays on)
      ps.offlineRounds = 0;
      const released = ps.offlineAutoplay && ps.autoplay && !this.ended;
      ps.offlineAutoplay = false;
      // 投票移出: a vote against this seat ends with the takeover (kickVote.js)
      this._kickVoteMemberGone(playerId, true);
      if (released) {
        this.setAutoplay(ps, false);
        this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} back online: AI takeover released (R${this.round})`);
        this.tickerText(msg('{name}博士已重新连接，收回了 AI 托管的席位', { name: ps.name }), FLOW_TICKER_PRIORITY);
      }
      this._resync(ps);
      if (released) this.toast(ps, 'info', msg('你已重新连接，AI 托管已解除'));
      if (!was) this.markPublic();
    });
    this.flush();
  }

  /**
   * 掉线由 AI 接管(移植自用户分支): a seat that spends OFFLINE_TAKEOVER_ROUNDS prep ends offline is the AI's from the
   * next phase on (autoplay on, offlineAutoplay marking why). Called at every prep end; onReconnect takes the seat back
   * and setAutoplay by the player himself never sets the mark (that 托管 is his own choice).
   */
  _checkOffline() {
    if (this.soloUntimed) return;
    for (const ps of this.order) {
      if (ps.isBot || ps.left || !ps.alive) continue;
      ps.offlineRounds = ps.connected ? 0 : ps.offlineRounds + 1;
      if (ps.connected || ps.autoplay || ps.offlineRounds < OFFLINE_TAKEOVER_ROUNDS) continue;
      ps.autoplay = true;
      ps.offlineAutoplay = true;
      this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} offline for ${ps.offlineRounds} rounds: AI takes over (R${this.round})`);
      this.tickerText(msg('{name}博士掉线超过 {rounds} 回合，由 AI 托管其席位，重新连接后可收回', { name: ps.name, rounds: OFFLINE_TAKEOVER_ROUNDS }), FLOW_TICKER_PRIORITY);
      this.markPublic();
    }
  }

  /**
   * 挂机移出 (afkRemoveRounds, the header's leave policy, 移植自用户分支): called as a PREP ends, before its battle / boss
   * fight is built (MatchPrep.endPrep). Every alive human of a match that started with ≥ 2 humans (never solo or
   * soloUntimed) is counted: an accepted AFK_ACTIONS intent since the previous check — or the AI playing the seat now
   * (AI 托管) — resets its idle rounds, else they grow by one. A seat reaching afkRemoveRounds is removed (_removeIdle);
   * may end the match. One round short of it, the seat is warned: a toast now and m.private afkWarn through its next
   * prep (PlayerViews.afkWarned).
   */
  _checkIdle() {
    const limit = this.afkRemoveRounds;
    if (!(limit > 0) || this.soloUntimed) return;
    const humans = this.order.filter((p) => !p.isBot && !p.left && p.alive);
    for (const ps of humans) {
      ps.afkRounds = ps.afkActed || ps.botControlled ? 0 : ps.afkRounds + 1;
      ps.afkActed = false;
    }
    for (const ps of humans) {
      if (this.ended || this.disposed) return;
      if (!ps.left && ps.afkRounds >= limit) {
        this._removeIdle(ps, { frame: { t: 'm.notice', kind: 'afkRemoved', playerId: ps.playerId, name: ps.name, rounds: limit } });
      } else if (limit > 1 && ps.afkRounds === limit - 1) {
        this.toast(ps, 'warn', msg('你本回合没有任何操作，下回合备战仍无操作将被移出对局'));
        this.markPrivate(ps);
      }
    }
  }

  /**
   * Remove a human exactly like a g.leave: the player is told first (m.removed — its client shows it and returns to the
   * lobby), everyone else still in the match gets `how` (the AFK rule's m.notice afkRemoved, spectator seats included),
   * then the platform detaches the seat (opts.onRemove: the lobby's removeMember, whose onLeave quits it here). A platform
   * without the hook leaves the quit to onLeave below. Also the shared removal path of a passed 投票移出 (reason
   * 'kicked', kickVote.js), which tells the others with a toast instead.
   * @param {any} ps
   * @param {{ reason?: string, rounds?: number, frame?: object|null, text?: any|null }} [how]
   *   reason: 'afk' (the idle rule) or 'kicked' (a passed vote); rounds: m.removed's count (default: the idle limit for
   *   'afk', else the seat's offline rounds); frame: the m.notice for the others; text: the toast for them instead
   */
  _removeIdle(ps, how = {}) {
    const reason = typeof how.reason === 'string' ? how.reason : 'afk';
    const fallback = reason === 'afk' ? Math.max(1, this.afkRemoveRounds | 0) : Math.min(100, Math.max(1, ps.offlineRounds | 0));
    const rounds = Number.isInteger(how.rounds) && how.rounds > 0 ? how.rounds : fallback;
    this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} removed (${reason}) after ${rounds} rounds (R${this.round})`);
    this.sendTo(ps.playerId, { t: 'm.removed', reason, rounds });
    const others = this.order.filter((p) => p !== ps && !p.isBot && !p.left);
    if (how.frame && typeof how.frame === 'object') {
      for (const p of others) this.sendTo(p.playerId, how.frame);
      for (const id of this.spectators.keys()) this.sendTo(id, how.frame);
    }
    if (how.text || !how.frame) {
      const text = how.text || msg('{name} 掉线期间被队友投票移出了对局', { name: ps.name });
      for (const p of others) this.toast(p, 'info', text);
      for (const id of this.spectators.keys()) this.toast({ playerId: id }, 'info', text);
    }
    if (typeof this.opts.onRemove === 'function') {
      try { this.opts.onRemove(ps.playerId, { reason, rounds }); } catch (e) { this.reportError('onRemove', e); }
    }
    if (!ps.left) this.onLeave(ps.playerId);
  }

  /**
   * The full state of one human (a reconnect, a resync, a spectator seat): m.public, its m.private (players only), the
   * field it is on / watches — a spectator, like an eliminated player, the field of the player it follows (item 56),
   * else the first; in a prep phase that player's board — or the result once ended.
   */
  _resync(ps) {
    const playerId = ps.playerId;
    this.sendTo(playerId, this.publicView());
    if (!this.ended) {
      if (!ps.spectator) {
        ps._lastPriv = null;
        this._sendPrivate(ps, true);
      }
      if (this.clientCombat) this._resendBattle(ps);
      else if (!this.fields.length && this._follows(ps)) this._followScout(ps, { keep: true });
      else {
        let fid = this.watchers.get(playerId);
        if (!fid && ps.spectator && this.fields.length) { fid = (this._watchTargetField(ps, this.fields) || this.fields[0]).fieldId; this.watchers.set(playerId, fid); }
        if (fid) this._sendField(playerId, fid);
      }
    } else if (this.lastResultMsg) {
      this.sendTo(playerId, { ...this.lastResultMsg, playerId });
    }
  }

  onLeave(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      ps.left = true;
      this.cancelSetupVote();
      // 投票移出(移植自用户分支): a voter goes, a target's vote ends with its seat (kickVote.js)
      this._kickVoteMemberGone(playerId);
      // A seat that is gone for good takes its reroll cooldown with it (it cannot ask again in this match anyway).
      this._rerollStartAt.delete(playerId);
      ps.connected = false;
      ps.autoplay = false;
      this.watchers.delete(playerId);
      if (this.ended) return;
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'left');
      // a rehearsal the departed seat was running falls back to the server (DESIGN §14; a no-op without tasks)
      this._rehearsalHostChanged();
      this.markPublic();
      if (!this.order.some((p) => !p.isBot && !p.left)) {
        this.finish({ victory: false, reason: 'abandoned' });
        return;
      }
      this._quit(ps);
    });
    // the departure (status left, the eliminated seat's offers / pairing) is on the record at once
    this.flush();
  }

  /**
   * 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3): every copy the player holds goes back
   * to the shared pool at once, and the seat has no place in later rounds, the Final Assault pairing or the boss pool
   * (bloodPoint per player alive at the fight's start, DESIGN §25.13.4). Rounds passed = the rounds the player had
   * survived when leaving.
   */
  _quit(ps) {
    this.maybeEndInfo();
    if (!ps.alive) return;
    const phase = this.phase;
    const passedRound = phase === PHASE.SETTLE ? this.round + 1 : Math.max(1, this.round);
    // its own normal battle has nobody left to fight for
    for (const f of this.fields) {
      if (f.live && f.kind === 'normal' && f.players.length === 1 && f.players[0] === ps.playerId) {
        if (this.clientCombat && f.cc) {
          if (!f.result) f.result = syntheticResult(f.players);
          this._fieldDone(f);
          continue;
        }
        try { f.battle.forceEnd('left'); } catch (e) { this.reportError('quit forceEnd', e); }
      }
    }
    ps.lp = 0;
    ps.eliminate(passedRound);
    this.offersChanged();
    this.tickerText(msg('{name}博士中途退出了模拟', { name: ps.name }), FLOW_TICKER_PRIORITY);
    if (this.bossWaves && (phase === PHASE.ROUND_START || phase === PHASE.SP_DRAFT || phase === PHASE.PREP)) {
      // before the boss fight: pair the players left again (the prep preview shows the new partner / template); a
      // player moved to the other half re-checks its board there at once (recompute → deployMap, marks it private)
      this._planBossWaves();
      for (const p of this.alivePlayers()) p.recompute();
    }
    // whoever scouted the departed player's board follows the next player still in (item 56)
    for (const v of this._viewers()) if (this.watchers.get(v.playerId) === `n:${ps.playerId}`) this._followScout(v);
    this.markPublic();
    if (this.teamLp != null) this._syncTeamLp();
    if (!this.alivePlayers().length) {
      // only eliminated spectators are left
      this.finish({ victory: false, reason: 'eliminated' });
      return;
    }
    if (phase === PHASE.SP_DRAFT && this.sp && this.spTurn() === ps.playerId) this.startSpTurn();
    // a seat leaving during the strategy draft keeps its place in the order, like one gone before it: at its turn the AI
    // drafts for it (botControlled → scheduleBandBot; botPickBand's departedWeight: Touch while nobody else holds it,
    // never 歌利亚) and it keeps the 0 LP it left with (_applyBand; stardust 6dc796d1)
    else if (phase === PHASE.BAND_DRAFT && this.draft && this.draftTurn() === ps.playerId) this.startDraftTurn();
    else if (phase === PHASE.PREP) this.maybeEndPrep();
  }

  dispose() {
    if (this.disposed) return;
    // drain the coalesced views first (force flush): a room destroyed or a process exiting must not leave
    // marked-but-unsent state behind. A finished match already flushed through finish() — a second forced public
    // after m.result would only repeat the frame.
    if (!this.ended) { try { this.flush(true); } catch { /* ignore */ } }
    this.disposed = true;
    this._flushTimer = null;
    this.externalAI?.close();
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } }
    this._stopClientCombat();
    this._cancelRehearsal();
    // a plugin interaction window's own deadline timer (MatchOffers); the tracked timers below cover the rest
    if (typeof this.offersDispose === 'function') { try { this.offersDispose(); } catch { /* ignore */ } }
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    if (this._pubTimer) { try { this.sched.clearTimeout(this._pubTimer); } catch { /* ignore */ } this._pubTimer = null; }
    if (this.ownsScheduler) this.sched.dispose();
  }
}
