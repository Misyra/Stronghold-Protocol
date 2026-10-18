// server/match/match/platform.js — Match methods: the platform interface of the server/match/Match.js header
// (server/lobby.js ⇄ Match) — start, handle (validation, error isolation, flush; the intents themselves: intents.js
// _handle), setLoadout (INFO_CHECK only), onDisconnect / onReconnect and the full resync of one human, onLeave and 中途退出
// = elimination (_quit), dispose.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { C2S } from '../../../shared/protocol.js';
import { PHASE, ERR } from '../../../shared/constants.js';
import { syntheticResult } from '../fields.js';
import { FLOW_TICKER_PRIORITY, OFFLINE_TAKEOVER_ROUNDS, OK, fail } from './common.js';
import { msg } from '../../../shared/i18n.js';

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
    // a spectator seat only watches (the platform routes nothing else of it)
    if (ps.spectator && (!msg || msg.t !== 'g.watch')) return fail(ERR.SPECTATOR);
    if (this.disposed || this.ended) {
      // A report that crossed the match end (the last b.progress of a field, a delegated rehearsal's answer) is stale:
      // ignored, never an error (DESIGN §14 — an error frame without a rid would surface as a toast in the browser).
      if (msg && msg.t === 'b.rehearsalResult') return OK;
      return this.clientCombat && msg && (msg.t === 'b.progress' || msg.t === 'b.result') ? OK : fail(ERR.WRONG_PHASE);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !GAME_TYPES.has(msg.t)) return fail(ERR.BAD_MSG);
    let res;
    try {
      res = this._handle(ps, msg);
    } catch (e) {
      this.reportError(`handle ${msg.t}`, e);
      res = fail(ERR.INTERNAL);
    }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
    if (res && typeof res === 'object' && res.error) return res;
    return OK;
  }

  /**
   * room.loadout during the match (DESIGN §16): only while INFO_CHECK runs (the briefing's 干员调配 entry); the lobby
   * already checked it against the data (PlayerState.setLoadout re-checks it). `ops` (0.2.2): the per-operator 潜能 /
   * 练度 that come with it (undefined = unchanged).
   * @param {string} playerId
   * @param {Record<string, { skill: number, module: string|null }> | null} loadout
   * @param {Record<string, { potential: number, cultivate: number }> | null} [ops]
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setLoadout(playerId, loadout, ops = undefined) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    let res = OK;
    this.guard(() => {
      if (!ps.setLoadout(loadout, ops)) { res = fail(ERR.BAD_TARGET, 'loadout does not match the game data'); return; }
      this.markPrivate(ps);
    });
    return res;
  }

  /**
   * room.skins during the match (docs/SKINS.md): replace a player's appearance choices, in the briefing only.
   *
   * Display preferences follow the loadout's INFO_CHECK contract, not ownership / DIY's start-time lock: a match that has
   * left the briefing keeps the choices it started with, and the lobby stores the new ones for the next match.
   * 来源: Stardust-minus/Stronghold-Protocol @ fab1b97 server/match/match/platform.js.
   * @param {string} playerId
   * @param {Record<string, string> | null} choices `{ [charId]: skinId }`
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setSkins(playerId, choices) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE, 'skins locked for this match; stored for the next match');
    let res = OK;
    this.guard(() => {
      if (!ps.setSkins(choices)) { res = fail(ERR.BAD_MSG, 'invalid skin choices'); return; }
      this.markPrivate(ps);
    });
    return res;
  }

  onDisconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || this.disposed) return;
    this.guard(() => {
      ps.connected = false;
      // A disconnected human's silence is never consent to a new setup: it is dropped from the vote, need recounted.
      this._dropSetupVoter(playerId);
      // 投票移出: a voter goes, a target stays a target (kickVote.js)
      this._kickVoteMemberGone(playerId);
      this.syncOfflinePause();
      if (!this.offlinePaused) {
        // a paused solo battle resumes (the server takes the field over; nobody is left to resume it)
        this._resume();
        if (this.clientCombat) this._authorityLost(ps, 'disconnect');
      }
      // a rehearsal this host was running falls back to the server (DESIGN §14; a no-op without tasks)
      this._rehearsalHostChanged();
      this.markPublic();
    });
  }

  onReconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      const was = ps.connected;
      ps.connected = true;
      ps.offlineRounds = 0;
      // 掉线由 AI 接管: back in the match, the player plays the seat again (an AI 托管 of its own choice stays on)
      const released = ps.offlineAutoplay && ps.autoplay && !this.ended;
      ps.offlineAutoplay = false;
      // 投票移出: a vote against this seat ends with the takeover (kickVote.js)
      this._kickVoteMemberGone(playerId, true);
      if (released) {
        this.setAutoplay(ps, false);
        this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} back online: AI takeover released (R${this.round})`);
        this.tickerText(msg('{name}博士已重新连接，收回了 AI 托管的席位', { name: ps.name }), FLOW_TICKER_PRIORITY);
      }
      this.syncOfflinePause();
      this._resync(ps);
      if (released) this.toast(ps, 'info', msg('你已重新连接，AI 托管已解除'));
      if (!was) this.markPublic();
    });
  }

  /**
   * 掉线由 AI 接管: a seat that spends OFFLINE_TAKEOVER_ROUNDS prep ends offline is the AI's from the next phase on
   * (autoplay on, offlineAutoplay marking why). Called at every prep end; onReconnect takes the seat back and
   * setAutoplay by the player himself never sets the mark (that 托管 is his own choice).
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
      this._dropSetupVoter(playerId);
      this._kickVoteMemberGone(playerId);
      ps.connected = false;
      ps.autoplay = false;
      this.syncOfflinePause();
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
  }

  /**
   * Remove a human exactly like a g.leave — one voted out (reason 'kicked', kickVote.js). The player is told first
   * (m.removed: its client leaves the room), everyone else still in the match gets the outcome as an m.toast, then
   * onLeave quits the seat here (中途退出 = elimination).
   * @param {any} ps @param {string} reason @param {{ text: any } | null} [notice]
   */
  _removeIdle(ps, reason = 'afk', notice = null) {
    const rounds = Math.min(100, Math.max(1, ps.offlineRounds | 0));
    this.sendTo(ps.playerId, { t: 'm.removed', reason, rounds });
    const text = notice?.text || msg('{name} 掉线期间被队友投票移出了对局', { name: ps.name });
    for (const p of this.order) if (p !== ps && !p.isBot && !p.left) this.toast(p, 'info', text);
    for (const id of this.spectators.keys()) this.toast({ playerId: id }, 'info', text);
    this.onLeave(ps.playerId);
  }

  /**
   * 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3): every copy the player holds goes back
   * to the shared pool at once, and the seat has no place in later rounds, the Final Assault pairing or the boss pool
   * (bloodPoint per player alive at the fight's start, DESIGN §25.13.4). Rounds passed = the rounds the player had
   * survived when leaving.
   */
  _quit(ps) {
    ps._botWorker?.cancel();
    ps._botWorker = null;
    this.maybeEndInfo();
    if (!ps.alive) return;
    const phase = this.phase;
    const d = this.draft;
    if (phase === PHASE.BAND_DRAFT && d && !d.picks[ps.playerId]) {
      // the departed seat passes its turn with the default band (never one a teammate holds — defaultBand)
      const turn = this.draftTurn() === ps.playerId;
      d.picks[ps.playerId] = this.defaultBand(ps.playerId);
      ps.bandId = d.picks[ps.playerId];
      if (turn) this.startDraftTurn();
    }
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
    else if (phase === PHASE.PREP) this.maybeEndPrep();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._cancelWorkerTasks();
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } }
    this._stopClientCombat();
    this._cancelRehearsal();
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    if (this._pubTimer) { try { this.sched.clearTimeout(this._pubTimer); } catch { /* ignore */ } this._pubTimer = null; }
    this.sched.dispose();
  }
}
