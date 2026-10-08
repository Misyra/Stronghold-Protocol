// INFO_CHECK full setup reroll: unanimous human consent, keeping the room and player settings.
// Installed on Match.prototype like the other method containers. The lobby authorizes host-only actions.
import { PHASE, ERR } from '../../../shared/constants.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { setupMatchWaves } from '../waves.js';
import { drawDisabledBonds, SharedPool } from '../pool.js';
import { OK, fail } from './common.js';

export class MatchSetupVote {
	requestSetupReroll(playerId, revision) {
		if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
		const ps = this.players.get(playerId);
		if (!ps || ps.isBot || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
		if (revision !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup revision changed');
		if (this.setupVote) return fail(ERR.WRONG_PHASE, 'setup reroll vote in progress');
		const humans = this.humans();
		if (humans.some((p) => !p.connected)) return fail(ERR.NOT_READY, 'all humans must be connected to vote');
		const now = this.sched.now();
		if (now - this._lastSetupVoteAt < 300) return fail(ERR.RATE);
		this._lastSetupVoteAt = now;
		this.setupVote = {
			id: ++this._setupVoteSeq,
			proposerId: playerId,
			voters: humans.map((p) => p.playerId),
			agreed: new Set([playerId]),
			remainingMs: this.deadline > 0 ? Math.max(1, this.deadline - now) : 0,
		};
		this.cancel(this._infoAdvanceTimer);
		this._infoAdvanceTimer = null;
		this.setDeadline(0);
		if (humans.length === 1) return this.completeSetupReroll();
		this.markPublic();
		this.flush(true);
		return OK;
	}

	voteSetupReroll(ps, voteId, agree) {
		if (this.phase !== PHASE.INFO_CHECK || !this.setupVote) return fail(ERR.WRONG_PHASE);
		const vote = this.setupVote;
		if (vote.id !== voteId) return fail(ERR.BAD_TARGET, 'setup vote changed');
		if (!ps.connected || !vote.voters.includes(ps.playerId)) return fail(ERR.NOT_IN_ROOM);
		if (!agree) { this.cancelSetupVote(); return OK; }
		vote.agreed.add(ps.playerId);
		if (vote.voters.every((id) => vote.agreed.has(id))) return this.completeSetupReroll();
		this.markPublic();
		this.flush(true);
		return OK;
	}

	cancelSetupReroll(playerId, voteId) {
		if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK || !this.setupVote) return fail(ERR.WRONG_PHASE);
		if (this.setupVote.id !== voteId) return fail(ERR.BAD_TARGET, 'setup vote changed');
		const ps = this.players.get(playerId);
		if (!ps || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
		this.cancelSetupVote();
		return OK;
	}

	cancelSetupVote() {
		const vote = this.setupVote;
		if (!vote) return;
		this.setupVote = null;
		if (this.phase === PHASE.INFO_CHECK && !this.disposed && !this.ended) {
			if (vote.remainingMs > 0) {
				this.deadline = this.sched.now() + vote.remainingMs;
				this._phaseTimer = this.later(vote.remainingMs, () => {
					this._phaseTimer = null;
					this.enterBandDraft();
				});
			}
			this.maybeEndInfo();
			this.markPublic();
			this.flush(true);
		}
	}

	completeSetupReroll() {
		try {
			// Use a separate stream; initial seeds/golden runs and shop/draft randomness stay stable.
			const rng = createRng(deriveSeed(this.seed, `reroll-setup:${this.setupRevision + 1}`));
			const setup = setupMatchWaves(this.gd, rng);
			const bans = drawDisabledBonds(this.gd, rng);
			const pool = new SharedPool(this.gd, { banned: bans.banned });
			if (!pool.entries.size) throw new Error('rerolled chess pool is empty');
			this.stageId = setup.stageId;
			this.stage = this.stageId ? this.gd.stage(this.stageId) : null;
			this.factions = setup.factions; // includes the non-enumerable full wave schedule
			this.bossId = setup.bossId;
			this.hiddenBossId = setup.hiddenBossId;
			this.disabledBonds = bans.drawn;
			this.staticInactiveBonds = bans.staticOff;
			this.bannedChess = bans.banned;
			this.pool = pool;
			this._botPath = null;
			const off = new Set([...bans.drawn, ...bans.staticOff]);
			for (const ps of this.order) {
				ps.initDiyStock(off);
				ps.invalidateDeployMap();
				ps.infoReady = ps.botControlled;
			}
			this.setupRevision++;
			this.setupVote = null;
			this.enterInfoCheck();
			return OK;
		} catch (e) {
			this.reportError('reroll setup', e);
			this.cancelSetupVote();
			return fail(ERR.INTERNAL);
		}
	}
}
