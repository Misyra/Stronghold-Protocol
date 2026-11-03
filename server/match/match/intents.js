// server/match/match/intents.js — Match methods: the g.* / b.* intent router (_handle: the prep intents go to
// PlayerState, the drafts, watching, the pause and the battle reports to the match), emotes, AI 托管 (setAutoplay,
// kickBot) and g.unitStats (the stats the board's units start their next battle with: a preview battle, started, read
// and dropped).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { unitStatsEntry } from '../../../shared/protocol.js';
import { PHASE, ERR, EMOTES, EMOTE_COOLDOWN_MS, GEO, CONSOLE_ROUND_LIMIT, CONSOLE_TOTAL_LIMIT } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { deriveSeed } from '../../sim/rng.js';
import { OK, fail } from './common.js';
import { onHumanEmote } from '../botEmotes.js';

export class MatchIntents {
  _handle(ps, msg) {
    switch (msg.t) {
      case 'g.infoReady':
        if (this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
        if (this.setupVote) return fail(ERR.WRONG_PHASE, 'setup reroll vote in progress');
        if ((msg.setupRevision ?? 0) !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup changed; confirm the current revision');
        if (!ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
        return OK;
      case 'g.rerollVote': return this.voteSetupReroll(ps, msg.voteId, msg.agree);
      // 投票移出(移植自用户分支): an offline seat under AI takeover (kickVote.js)
      case 'g.kickVote': return this.requestKickVote(ps, msg.targetId);
      case 'g.kickBallot': return this.answerKickVote(ps, msg.voteId, msg.agree);
      // 战斗 2 倍速投票（speedVote.js，右上角 ×2 按钮）: 全员赞成 → 下一场战斗开始时生效
      case 'g.speedVote': return this.speedVote(ps, msg.on === true);
      case 'g.band': return this.pickBand(ps, msg.bandId);
      case 'g.bandSkip': return this.skipBand(ps);
      // the strategy highlighted in the draft screen (what a timed-out turn takes, timeoutBand)
      case 'g.bandFocus': return this.bandFocus(ps, msg.bandId ?? null);
      // 预选盟约(移植自用户分支): the core bond the player means to build (display only; the opening phases)
      case 'g.bondPlan': return this.planBond(ps, msg.bondId ?? null);
      case 'g.buy': return ps.buy(msg.slot);
      case 'g.refresh': return ps.refresh();
      case 'g.freeze': return ps.freeze();
      case 'g.levelUp': return ps.levelUp();
      case 'g.sell': return ps.sell(msg.uid);
      // dir: the deploy wheel's facing (DESIGN §3; absent ⇒ PlayerState reads to.dir, then RIGHT)
      case 'g.move': return ps.move(msg.uid, msg.to, msg.dir);
      case 'g.equip': return ps.equip(msg.itemUid, msg.targetUid, msg.replaceUid ?? null);
      case 'g.art': return ps.useArt(msg.itemUid, msg.row, msg.col, msg.dir);
      case 'g.destroy': return ps.destroy(msg.uid);
      case 'g.unequip': return ps.unequip(msg.itemUid);
      case 'g.reward': return ps.pickReward(msg.idx);
      case 'g.choice': return msg.choiceId !== undefined
        ? this.pickPersonalChoice(ps, msg.idx, msg.choiceId)
        : this.pickCard(ps, msg.idx);
      // a plugin interaction window (PLUGIN API v2, docs/PLUGINS.md §10b): the window's own id, not a draft card —
      // the host applies the declared primitive, a plugin never reaches the match state itself
      case 'g.offer': return this.requestOffer(ps, msg.offerId, msg.idx, msg);
      case 'g.offerRefresh': return this.requestOfferRefresh(ps, msg.offerId, msg.idx, msg);
      case 'g.ready': return ps.setReady(!!msg.ready);
      case 'g.emote': return this.emote(ps, msg.id);
      // playerId: the player tapped (a shared field names two) — the watch preference (item 56)
      case 'g.watch': return this.watch(ps, msg.fieldId, msg.playerId ?? null);
      case 'g.autoplay': return this.setAutoplay(ps, !!msg.on);
      case 'g.pause': return this.setPause(ps, !!msg.on);
      // the stats the board's units start their next battle with (the detail card in prep, user playtest #4 item 7)
      case 'g.unitStats': return this.unitStats(ps, msg.seq ?? null);
      // 开发者控制台 (room.console.enable, 移植自用户分支): one grant intent at a time (consoleGrant)
      case 'g.console': return this.consoleGrant(ps, msg.kind, msg.id, msg.amount);
      case 'g.leave': this.onLeave(ps.playerId); return OK;
      case 'g.test': return this.applyTestCommand(ps, msg);
      case 'b.progress': return this._onProgress(ps, msg);
      case 'b.result': return this._onResult(ps, msg);
      // the host's answer to a delegated bot layout rehearsal (DESIGN §14): a report, never an error — an unknown,
      // expired or foreign task is ignored (MatchRehearsal._onRehearsalResult)
      case 'b.rehearsalResult': this._onRehearsalResult(ps, msg); return OK;
      default: return fail(ERR.BAD_MSG);
    }
  }

  emote(ps, id) {
    if (!EMOTES.includes(id)) return fail(ERR.BAD_MSG, 'unknown emote');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.emote', playerId: ps.playerId, id });
    // an AI teammate can react to a human's emote (enabled by default: server/match/botEmotes.js, SP_BOT_EMOTES=0 silences it)
    onHumanEmote(this, ps.playerId, id);
    return OK;
  }

  setAutoplay(ps, on) {
    if (ps.autoplay === on) return OK;
    ps.autoplay = on;
    this.markPublic();
    if (on) this.kickBot(ps);
    return OK;
  }

  /**
   * g.bondPlan { bondId? } (预选盟约, 移植自用户分支; a remake feature, display only): the core bond (盟约) the player
   * announces it means to build — m.public players[].bondPlan, seen by every teammate and spectator for the rest of
   * the match. Changeable from INFO_CHECK until round 1's battle starts (bondPlanOpen), else WRONG_PHASE; `bondId`
   * one of GameData.plannableBondIds() (BAD_TARGET otherwise — the mode's switched-off bonds stay plannable), absent /
   * null clears it; the same plan again changes nothing. No rule, bot, timer or idle check reads it. AI seats and
   * spectator seats cannot send it (handle refuses them).
   * @param {PlayerState} ps @param {string|null} bondId
   */
  planBond(ps, bondId) {
    if (!this.bondPlanOpen()) return fail(ERR.WRONG_PHASE);
    if (bondId !== null && !this.gd.bondPlannable(bondId)) return fail(ERR.BAD_TARGET);
    if (ps.bondPlan === bondId) return OK;
    ps.bondPlan = bondId;
    this.markPublic();
    return OK;
  }

  /** 预选盟约可变更的时间窗(移植自用户分支): the opening — INFO_CHECK, the strategy draft, BATTLE_CHECK — and round 1 up to its battle. */
  bondPlanOpen() {
    switch (this.phase) {
      case PHASE.INFO_CHECK: case PHASE.BAND_DRAFT: case PHASE.BATTLE_CHECK: return true;
      case PHASE.ROUND_START: case PHASE.SP_DRAFT: case PHASE.PREP: return this.round <= 1;
      default: return false;
    }
  }

  /** Let the bot act for a (newly) bot-controlled seat in the current phase. */
  kickBot(ps) {
    if (!ps.botControlled || this.ended) return;
    this.offersChanged();
    if (this.phase === PHASE.INFO_CHECK && !ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
    else if (this.phase === PHASE.BAND_DRAFT && this.draftTurn() === ps.playerId) this.scheduleBandBot();
    else if (this.phase === PHASE.SP_DRAFT && this.spTurn() === ps.playerId) this.scheduleSpBot();
    else if (this.phase === PHASE.PREP && ps.alive && !ps.ready) this.scheduleBotPrep(ps, 0);
  }

  /**
   * g.unitStats { seq? } (user playtest #4 item 7: the detail card showed fixed record stats): the stats every unit of
   * the player's board will fight with at the start of its next battle — equipment, bonds and their layers, 特质, the
   * band and 机变 effects — computed exactly by the shared sim. The player's battle input after the onBattleStart meta
   * handlers (`ev.preview: true`, no enemies — those handlers must not change the match for a preview) builds a Battle
   * of the battle's options that is started (initial deployment + battleStart hooks), read and dropped: it is never
   * stepped: deployment skills contribute their initial stats but their timers do not advance. No SP / skill timer is
   * sent, and the real battle gets fresh units. Pushed to the player as `m.unitStats { seq, round, units }`
   * (units: shared/protocol.js unitStatsEntry, board operators and summons by uid); cached per input (a build costs
   * ≈ 0.3–0.7 ms). Prep phases only (ROUND_START, 机变, PREP); a battle's live stats come from the browser's own sim.
   * @param {PlayerState} ps @param {number|null} seq echoed (the client keeps the newest answer)
   */
  unitStats(ps, seq = null) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.ROUND_START && this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const units = this._unitStatsOf(ps);
    this.sendTo(ps.playerId, { t: 'm.unitStats', seq: Number.isInteger(seq) ? seq : null, round: this.round, units });
    return OK;
  }

  /** The start-of-battle stats of a player's board units (see unitStats); [] when the preview battle cannot be built. */
  _unitStatsOf(ps) {
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    const ev = { input, kind: 'normal', round: this.round, preview: true };
    this.dispatch(ps, 'onBattleStart', ev);
    const players = [ev.input && typeof ev.input === 'object' ? ev.input : input];
    let key = null;
    try { key = JSON.stringify([this.round, this.stageId, this.battleContent, players]); } catch { key = null; }
    if (!this._unitStatsCache) this._unitStatsCache = new WeakMap(); // PlayerState → { key, units } (the last preview)
    const cached = this._unitStatsCache.get(ps);
    if (key && cached && cached.key === key) return cached.units;
    const units = [];
    // the flags of the battle it previews: a normal round gains IN_BATTLE layers from its start (a <战斗开始时> layer gain
    // raises bond stats at t = 0 there too); the Final Assault / Hidden Core fight without (previewed as a normal field)
    const bossRound = this.round === this.gd.bossRound || this.round === this.gd.hiddenRound;
    const b = this.newBattle({
      seed: deriveSeed(this.seed, `preview:${this.round}:${ps.seat}`), kind: 'normal', modeId: this.modeId, round: this.round,
      stageId: this.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players, spawns: [], routes: this.wave ? this.wave.routes : [],
      sharedBoss: null, flags: { layerGainsEnabled: !bossRound, ...this.gd.dp }, fieldId: `n:${ps.playerId}`, recordEvents: false,
    });
    try {
      if (typeof b.start === 'function') b.start();
      for (const u of Array.isArray(b.allyUnits) ? b.allyUnits : []) {
        if (u && Number.isInteger(u.uid) && (u.kind === 'op' || u.kind === 'token')) units.push(unitStatsEntry(u, u.s));
      }
    } catch (e) { this.reportError('unitStats', e); }
    this._unitStatsCache.set(ps, { key, units });
    return units;
  }

  /**
   * 开发者控制台 (room.console.enable, 移植自用户分支): one grant intent at a time. The server stays authoritative —
   * a disabled match, a refused id, the quota and the preparation area's room all decide here, and the components only
   * search the data the client already has. Quota: CONSOLE_ROUND_LIMIT per round, CONSOLE_TOTAL_LIMIT for the match.
   */
  consoleGrant(ps, kind, id, amount) {
    if (!this.consoleEnabled) return fail(ERR.BAD_MSG, 'console is disabled for this match');
    if (!ps || ps.isBot || ps.left || !ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase === PHASE.LOBBY || this.phase === PHASE.RESULT || this.ended || this.disposed) return fail(ERR.WRONG_PHASE);
    if (ps.consoleTotalUses >= CONSOLE_TOTAL_LIMIT) return fail(ERR.RATE, 'console total limit reached');
    if (ps.consoleRoundUses >= CONSOLE_ROUND_LIMIT) return fail(ERR.RATE, 'console round limit reached');
    let piece = null;
    let grantedName = id;
    let grantedAmount = null;
    let granted = false;
    if (kind === 'bond') {
      if (!this.gd.bond(id) || !Number.isInteger(amount) || amount <= 0) return fail(ERR.BAD_TARGET, 'bond amount must be a positive integer');
      const added = ps.addLayers(id, amount, { reason: 'console' });
      if (!(added > 0)) return fail(ERR.BAD_TARGET, 'bond is already at the layer limit');
      grantedName = this.gd.bond(id).name || id;
      grantedAmount = added;
      granted = true;
    } else if (kind === 'chess') {
      const rec = ps.gd.chess(id);
      // A filled DIY slot resolves through this player's view; empty slots have no body to grant.
      const base = rec && ps.gd.chess(ps.gd.baseIdOf(id));
      if (!rec || rec.isHidden || !base || base.isHidden
        || (rec.isDiy ? !rec.diyFor || !base.diyFor : !(rec.visible || rec.isGolden) || base.isDiy || !base.visible)) {
        return fail(ERR.BAD_TARGET, 'unknown operator');
      }
      grantedName = rec.name || id;
      piece = ps.acquireChess(id, { source: 'console', fromPool: false });
      granted = !!piece;
    } else if (kind === 'item') {
      const rec = this.gd.item(id);
      if (!rec || rec.isDiy || rec.isHidden) return fail(ERR.BAD_TARGET, 'unknown equipment');
      grantedName = rec.name || id;
      if (!ps.hand.some((p) => !p) && !ps.temp.some((p) => !p)) return fail(ERR.HAND_FULL);
      piece = ps.acquireItem(id, { source: 'console', fromPool: false });
      granted = !!piece;
    } else return fail(ERR.BAD_MSG);
    if (!granted) return fail(ERR.HAND_FULL, 'console grant could not fit in the preparation area');
    ps.consoleRoundUses++;
    ps.consoleTotalUses++;
    // The in-match ticker, explicitly: every teammate and spectator sees that a console grant happened.
    this.tickerText(grantedAmount == null
      ? msg('{name}博士通过控制台获得了{item}', { name: ps.name, item: grantedName })
      : msg('{name}博士通过控制台获得了{item} {n} 层', { name: ps.name, item: grantedName, n: grantedAmount }), 2);
    ps.dirty();
    this.markPublic();
    return OK;
  }
}
