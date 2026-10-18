// INFO_CHECK full setup reroll (重刷本局): a ¾ human vote, keeping the room and player settings.
// [ASSUMED] Remake convenience: the vote rule below, pause/resume timer, independent reroll stream and a 300 ms request
// guard. These are not official mode rules; DESIGN §28.21 and the 0.3.0 history (owner's rules of 2026-10-17).
// Installed on Match.prototype like the other method containers. The lobby authorizes who may propose (the host of a
// private room, any seated human of a matchmade one) and the host's room.cancelReroll; the proposer withdraws with
// g.rerollVote agree:false.
//
// The vote: voters = the humans connected (not left, not bots, not spectators) when it is proposed; need =
// ceil(0.75 × voters), the proposer counts as yes. It passes as soon as `agreed` reaches need and fails as soon as
// voters − rejected < need. A voter that disconnects or leaves is dropped from voters / agreed / rejected and need is
// recomputed from the voters left — the vote goes on (and may pass or fail on that recount); a human connecting later
// does not join it. It times out after REROLL_VOTE_MS. Failure, timeout or cancellation restores the paused confirmation
// time. Limits: one proposal per player per setup revision, MAX_SETUP_REROLLS per match (setupRevision counts them).
// The vote and the proposal marks are transient: a checkpoint restore drops them (server/match/snapshot.js).
import { PHASE, ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { setupMatchWaves } from '../waves.js';
import { drawDisabledBonds, SharedPool } from '../pool.js';
import { OK, fail } from './common.js';

/** How long a reroll vote stays open (ms, × timerScale). */
export const REROLL_VOTE_MS = 20_000;
/** Successful rerolls per match. */
export const MAX_SETUP_REROLLS = 3;
/** Yes votes a reroll needs of `n` voters. */
export const rerollNeed = (n) => Math.ceil(0.75 * n);

export class MatchSetupVote {
  requestSetupReroll(playerId, revision) {
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    if (revision !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup revision changed');
    if (this.setupVote) return fail(ERR.WRONG_PHASE, 'setup reroll vote in progress');
    if (this.setupRevision >= MAX_SETUP_REROLLS) return fail(ERR.ALREADY, 'reroll-limit');
    if (this._setupProposals.get(playerId) === this.setupRevision) return fail(ERR.ALREADY, 'reroll-proposed');
    const now = this.sched.now();
    if (now - this._lastSetupVoteAt < 300) return fail(ERR.RATE);
    this._lastSetupVoteAt = now;
    this._setupProposals.set(playerId, this.setupRevision);
    // offline humans neither vote nor block
    const voters = this.humans().filter((p) => p.connected).map((p) => p.playerId);
    const ms = this.scaled(REROLL_VOTE_MS);
    const vote = this.setupVote = {
      id: ++this._setupVoteSeq,
      proposerId: playerId,
      voters,
      agreed: new Set([playerId]),
      rejected: new Set(),
      need: rerollNeed(voters.length),
      deadline: now + ms,
      remainingMs: this.deadline > 0 ? Math.max(1, this.deadline - now) : 0,
      timer: null,
    };
    this.cancel(this._infoAdvanceTimer);
    this._infoAdvanceTimer = null;
    this.setDeadline(0);
    if (vote.agreed.size >= vote.need) return this.completeSetupReroll();
    vote.timer = this.later(ms, () => {
      if (this.setupVote !== vote) return;
      vote.timer = null;
      this.cancelSetupVote('timeout');
    });
    this.markPublic();
    this.flush(true);
    return OK;
  }

  voteSetupReroll(ps, voteId, agree) {
    if (this.phase !== PHASE.INFO_CHECK || !this.setupVote) return fail(ERR.WRONG_PHASE);
    const vote = this.setupVote;
    if (vote.id !== voteId) return fail(ERR.BAD_TARGET, 'setup vote changed');
    if (!ps.connected || !vote.voters.includes(ps.playerId)) return fail(ERR.NOT_IN_ROOM);
    // the proposer saying no withdraws the proposal
    if (!agree && ps.playerId === vote.proposerId) { this.cancelSetupVote('cancelled', ps.playerId); return OK; }
    // a voter may change its mind until the vote ends
    if (agree) { vote.agreed.add(ps.playerId); vote.rejected.delete(ps.playerId); }
    else { vote.rejected.add(ps.playerId); vote.agreed.delete(ps.playerId); }
    return this._settleSetupVote();
  }

  /** room.cancelReroll: the lobby lets the host only through (the proposer withdraws with g.rerollVote). */
  cancelSetupReroll(playerId, voteId) {
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK || !this.setupVote) return fail(ERR.WRONG_PHASE);
    if (this.setupVote.id !== voteId) return fail(ERR.BAD_TARGET, 'setup vote changed');
    const ps = this.players.get(playerId);
    if (!ps || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    this.cancelSetupVote('cancelled', playerId);
    return OK;
  }

  /** A voter disconnected or left (MatchPlatform): it is dropped and the vote recounted, never cancelled by it. */
  _dropSetupVoter(playerId) {
    const vote = this.setupVote;
    if (!vote || !vote.voters.includes(playerId)) return;
    vote.voters = vote.voters.filter((id) => id !== playerId);
    vote.agreed.delete(playerId);
    vote.rejected.delete(playerId);
    if (!vote.voters.length) { this.cancelSetupVote('cancelled'); return; }
    vote.need = rerollNeed(vote.voters.length);
    this._settleSetupVote();
  }

  /** Pass once agreed reaches need; fail once it no longer can. */
  _settleSetupVote() {
    const vote = this.setupVote;
    if (!vote) return fail(ERR.WRONG_PHASE);
    if (vote.agreed.size >= vote.need) return this.completeSetupReroll();
    if (vote.voters.length - vote.rejected.size < vote.need) { this.cancelSetupVote('rejected'); return OK; }
    this.markPublic();
    this.flush(true);
    return OK;
  }

  /**
   * End a vote without a reroll and restore the paused confirmation time. `reason`: 'rejected' / 'timeout' / 'error',
   * or 'cancelled' (by = the host or the proposer; null when no voter is left). Client feedback is the restored
   * countdown and the disappearing vote (this fork has no m.notice channel).
   */
  cancelSetupVote(reason = 'cancelled', by = null) {
    const vote = this.setupVote;
    if (!vote) return;
    void by;
    this.setupVote = null;
    this.cancel(vote.timer);
    if (this.phase === PHASE.INFO_CHECK && !this.disposed && !this.ended) {
      if (vote.remainingMs > 0) {
        this.deadline = this.sched.now() + vote.remainingMs;
        this._phaseTimer = this.later(vote.remainingMs, () => {
          this._phaseTimer = null;
          this.enterBandDraft();
        });
      }
      const text = reason === 'error' ? msg('重刷失败：开局重新随机出错，已保留原开局')
        : reason === 'cancelled' ? msg('重刷投票已取消')
        : reason === 'timeout' ? msg('重刷投票超时，未通过') : msg('重刷投票未通过');
      for (const ps of this.humans()) if (ps.connected && !ps.left) this.toast(ps, reason === 'error' ? 'error' : 'info', text);
      this.maybeEndInfo();
      this.markPublic();
      this.flush(true);
    }
  }

  completeSetupReroll() {
    let prepared;
    try {
      const rng = createRng(deriveSeed(this.seed, `reroll-setup:${this.setupRevision + 1}`));
      const setup = setupMatchWaves(this.gd, rng);
      const stage = setup.stageId ? this.gd.stage(setup.stageId) : null;
      const bans = drawDisabledBonds(this.gd, rng);
      const pool = new SharedPool(this.gd, { banned: bans.banned });
      if (!pool.entries.size) throw new Error('rerolled chess pool is empty');
      const off = new Set([...bans.drawn, ...bans.staticOff]);
      const stocks = this.order.map((ps) => ps.buildDiyStock(off));
      prepared = { setup, stage, bans, pool, stocks };
    } catch (e) {
      this.reportError('reroll setup', e);
      this.cancelSetupVote();
      return fail(ERR.INTERNAL);
    }
    // All data-dependent work succeeds before any opening or player state changes.
    const { setup, stage, bans, pool, stocks } = prepared;
    this.stageId = setup.stageId;
    this.stage = stage;
    this.factions = setup.factions;
    this.bossId = setup.bossId;
    this.hiddenBossId = setup.hiddenBossId;
    this.disabledBonds = bans.drawn;
    this.staticInactiveBonds = bans.staticOff;
    this.bannedChess = bans.banned;
    this.pool = pool;
    this._botPath = null;
    for (const [i, ps] of this.order.entries()) {
      ps.diyStock = stocks[i].stock;
      ps.diyBanned = stocks[i].banned;
      ps.invalidateDeployMap();
      ps.infoReady = ps.botControlled;
    }
    this.setupRevision++;
    const vote = this.setupVote;
    this.setupVote = null;
    this.cancel(vote?.timer);
    if (vote) {
      const text = msg('重刷投票通过，开局信息已重新随机');
      for (const ps of this.humans()) if (ps.connected && !ps.left) this.toast(ps, 'success', text);
    }
    this.enterInfoCheck();
    return OK;
  }
}
