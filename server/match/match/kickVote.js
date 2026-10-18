// server/match/match/kickVote.js — Match methods: 投票移出 (GitHub feedback #12, the owner's rules of 2026-10-17), a
// vote of the connected humans to remove a teammate whose seat the AI plays because it stayed offline (掉线由 AI 接管,
// MatchPlatform._checkOffline). A passed vote removes the seat exactly like a g.leave (中途退出 = elimination: its cards
// go back to the pool, it leaves the Final Assault pairing, the Boss HP is rescaled) through the AFK rule's removal path
// (MatchPlatform._removeIdle, reason 'kicked'), so the lobby / cluster detach it like an AFK removal.
// [ASSUMED] A remake rule, not an official one (DESIGN, 0.3.0 history).
//
// The vote (g.kickVote { targetId } proposes, g.kickBallot { voteId, agree } answers): only in SP_DRAFT / PREP; the
// target is an alive human seat, offline, under the offline takeover (offlineAutoplay — not an AI 托管 of its own
// choice while connected); voters = the connected humans that have not left, the target excluded, at proposal time;
// need = ⌊voters / 2⌋ + 1, the proposer counts as yes. It passes once `agreed` reaches need and fails once voters −
// rejected < need. A voter that disconnects or leaves is dropped and need recomputed from the voters left. It times out
// after KICK_VOTE_MS and is cancelled at prep end, when the target reconnects or is gone, and when the proposer
// withdraws (g.kickBallot agree:false). One vote at a time per match; a failed (rejected / timed-out) vote blocks
// another against the same target for the rest of the round; a 300 ms burst guard per proposing player.
// Everything here is transient: a checkpoint restore drops it (server/match/snapshot.js MATCH_FIELDS).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { OK, fail } from './common.js';

/** How long a kick vote stays open (ms, × timerScale). */
export const KICK_VOTE_MS = 30_000;
/** Yes votes a kick needs of `n` voters: a strict majority. */
export const kickNeed = (n) => Math.floor(n / 2) + 1;

export class MatchKickVote {
  /** The seat a kick vote may name: offline, alive, its AI 托管 the offline takeover's. */
  kickTargetEligible(ps) {
    return !!ps && !ps.isBot && !ps.spectator && !ps.left && ps.alive && !ps.connected && ps.offlineAutoplay && ps.autoplay;
  }

  /** g.kickVote { targetId } */
  requestKickVote(ps, targetId) {
    if (this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    if (this.kickVote) return fail(ERR.WRONG_PHASE, 'kick vote in progress');
    const target = this.players.get(targetId);
    if (target === ps || !this.kickTargetEligible(target)) return fail(ERR.BAD_TARGET, 'not an offline seat under AI takeover');
    if (this._kickFailed.get(targetId) === this.round) return fail(ERR.ALREADY, 'kick-failed-this-round');
    const now = this.sched.now();
    if (now - (this._kickVoteAt.get(ps.playerId) ?? -Infinity) < 300) return fail(ERR.RATE);
    this._kickVoteAt.set(ps.playerId, now);
    const voters = this.humans().filter((p) => p.connected && p !== target).map((p) => p.playerId);
    const ms = this.scaled(KICK_VOTE_MS);
    const vote = this.kickVote = {
      id: ++this._kickVoteSeq,
      proposerId: ps.playerId,
      targetId,
      voters,
      agreed: new Set([ps.playerId]),
      rejected: new Set(),
      need: kickNeed(voters.length),
      deadline: now + ms,
      timer: null,
    };
    this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} proposes removing seat ${target.seat} (R${this.round})`);
    vote.timer = this.later(ms, () => {
      if (this.kickVote !== vote) return;
      vote.timer = null;
      this._failKickVote('timeout');
    });
    return this._settleKickVote();
  }

  /** g.kickBallot { voteId, agree } */
  answerKickVote(ps, voteId, agree) {
    const vote = this.kickVote;
    if (!vote) return fail(ERR.WRONG_PHASE);
    if (vote.id !== voteId) return fail(ERR.BAD_TARGET, 'kick vote changed');
    if (!ps.connected || ps.left || !vote.voters.includes(ps.playerId)) return fail(ERR.NOT_IN_ROOM);
    // the proposer saying no withdraws the proposal
    if (!agree && ps.playerId === vote.proposerId) { this.cancelKickVote('withdrawn'); return OK; }
    if (agree) { vote.agreed.add(ps.playerId); vote.rejected.delete(ps.playerId); }
    else { vote.rejected.add(ps.playerId); vote.agreed.delete(ps.playerId); }
    return this._settleKickVote();
  }

  /** A voter disconnected or left: dropped and recounted. The target reconnecting or leaving cancels the vote. */
  _kickVoteMemberGone(playerId, reconnected = false) {
    const vote = this.kickVote;
    if (!vote) return;
    if (playerId === vote.targetId) {
      // a reconnect hands the seat back (MatchPlatform.onReconnect); a leave already removes it
      if (reconnected || !this.kickTargetEligible(this.players.get(playerId))) this.cancelKickVote(reconnected ? 'reconnected' : 'targetGone');
      return;
    }
    if (reconnected || !vote.voters.includes(playerId)) return;
    vote.voters = vote.voters.filter((id) => id !== playerId);
    vote.agreed.delete(playerId);
    vote.rejected.delete(playerId);
    if (!vote.voters.length) { this.cancelKickVote('empty'); return; }
    vote.need = kickNeed(vote.voters.length);
    this._settleKickVote();
  }

  _settleKickVote() {
    const vote = this.kickVote;
    const target = this.players.get(vote.targetId);
    if (!this.kickTargetEligible(target) || (this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP)) {
      this.cancelKickVote('targetGone');
      return OK;
    }
    if (vote.agreed.size >= vote.need) {
      this._endKickVote();
      this.log.info?.(`[match ${this.roomCode}] seat ${target.seat} removed by a vote ${vote.agreed.size}/${vote.voters.length} (R${this.round})`);
      // exactly a 中途退出: m.removed to the seat, the lobby detaches it (reason 'kicked'), onLeave quits it
      this._removeIdle(target, 'kicked', { t: 'm.notice', kind: 'kickPassed', voteId: vote.id, targetId: vote.targetId,
        name: target.name, agreed: vote.agreed.size, need: vote.need });
      return OK;
    }
    if (vote.voters.length - vote.rejected.size < vote.need) { this._failKickVote('rejected'); return OK; }
    this.markPublic();
    this.flush(true);
    return OK;
  }

  /** Rejected or timed out: no other vote on this target for the rest of the round. */
  _failKickVote(reason) {
    const vote = this._endKickVote();
    if (!vote) return;
    this._kickFailed.set(vote.targetId, this.round);
    this.broadcast({ t: 'm.notice', kind: 'kickFailed', voteId: vote.id, targetId: vote.targetId, reason });
    this.markPublic();
    this.flush(true);
  }

  /**
   * `reason` (m.notice kickCancelled): 'withdrawn' (the proposer), 'reconnected' (the target is back), 'targetGone'
   * (left / no longer under the offline takeover), 'empty' (no voter left), 'prepEnd' (MatchPrep.endPrep).
   */
  cancelKickVote(reason) {
    const vote = this._endKickVote();
    if (!vote || this.disposed) return;
    this.broadcast({ t: 'm.notice', kind: 'kickCancelled', voteId: vote.id, targetId: vote.targetId, reason });
    this.markPublic();
    this.flush(true);
  }

  _endKickVote() {
    const vote = this.kickVote;
    if (!vote) return null;
    this.kickVote = null;
    this.cancel(vote.timer);
    return vote;
  }

  kickVoteView() {
    const v = this.kickVote;
    if (!v || this.ended) return null;
    return { id: v.id, proposerId: v.proposerId, targetId: v.targetId, voters: v.voters.slice(), agreed: [...v.agreed],
      rejected: [...v.rejected], need: v.need, deadline: v.deadline };
  }
}
