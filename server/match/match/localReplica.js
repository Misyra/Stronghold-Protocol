// server/match/match/localReplica.js — Match methods: local display replicas under server-run combat (DESIGN §14 "Local
// display replicas"). A Worker-run field is shown to a seated human whose browser declared it can simulate
// (g.sim { local: true }) as a b.start display replica instead of the b.snap / b.ev stream — its own field, a teammate's
// it watches, the one an eliminated player follows: the browser runs the BattleSpec the Worker runs, the Worker digests
// the field state every SYNC_TICKS (server/sim/syncHash.js) and the match forwards it as b.sync, and a browser whose
// digest differs, or that cannot keep up, asks for the stream again (g.sim { battleId, stream: true }) — from then on
// that player gets this field streamed like before. A boss / hidden field shares one pool with the other fields of its
// phase: its replica also replays the Worker's record of that pool (b.start `ext`, then b.ext; combat/runner.js extFor,
// sim/spec.js ReplayBossPool). The Worker battle stays the only authority: results, layers, LP, the boss pool, the damage
// board and settlement never read a browser. Spectator seats keep the stream.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated).

import { OK } from './common.js';

/** Field kinds a player's browser may run locally: their battles depend on nothing outside their spec. */
export const LOCAL_KINDS = new Set(['normal', 'unite']);
/** Field kinds whose replica also needs the Worker's record of the shared boss pool (combat/runner.js extFor). */
export const POOL_KINDS = new Set(['boss', 'hidden']);

export class MatchLocalReplica {
  /**
   * g.sim { local?, battleId?, stream?, tick? }: `local` — whether this browser runs its own fields from now on (sent when
   * it has the sim loaded, again after a reconnect); `battleId` + `stream` — its replica of that battle diverged (`tick`:
   * the first digest that differed) or cannot keep up: stream that field to it instead.
   */
  setLocalSim(ps, msg) {
    if (ps.spectator || ps.isBot) return OK;
    if (typeof msg.local === 'boolean') {
      ps.localSim = msg.local;
      if (!msg.local) {
        const v = this.localViews.get(ps.playerId);
        if (v && this.fields.includes(v.field)) this._streamInstead(ps, v.field, 'off');
      }
    }
    if (typeof msg.battleId === 'string' && msg.stream === true) {
      const v = this.localViews.get(ps.playerId);
      if (v && v.field.battleId === msg.battleId && this.fields.includes(v.field)) {
        this._streamInstead(ps, v.field, Number.isInteger(msg.tick) ? `diverged at tick ${msg.tick}` : 'requested');
      }
    }
    return OK;
  }

  /** Whether `pid` is shown `fieldId` by its own local replica (then it is not streamed it). */
  _localShows(pid, fieldId) {
    const v = this.localViews.get(pid);
    return !!v && v.field.fieldId === fieldId && this.watchers.get(pid) === fieldId && this.fields.includes(v.field);
  }

  /**
   * Whether `ps` may be shown `f` as a local replica. Which field a player may see at all is decided before (g.watch, the
   * default watch, a resync); this only adds the replica conditions. A finished field is offered only to a browser that
   * already ran it (it re-shows its own end).
   */
  _localOk(ps, f) {
    return !!(this.localReplica && !this.clientCombat && f && f.remote
      && (LOCAL_KINDS.has(f.kind) || (POOL_KINDS.has(f.kind) && typeof this.runner?.extFor === 'function'))
      && ps && !ps.isBot && !ps.left && !ps.spectator && ps.connected && ps.localSim === true
      && this.players.get(ps.playerId) === ps && !(f.streamOnly && f.streamOnly.has(ps.playerId))
      && (f.live || !!(f.localRuns && f.localRuns.has(ps.playerId))));
  }

  /**
   * Show a player a field as a local replica: b.start (once per field unless `resend`: a reconnect, a 返回战场, watching
   * it again — the browser keeps the Battle it already runs and only re-shows it). A boss / hidden field's b.start carries
   * the pool record so far (`ext`). False when the field is streamed to it instead.
   */
  _offerLocal(ps, f, { resend = false } = {}) {
    if (!this._localOk(ps, f)) return false;
    const v = this.localViews.get(ps.playerId);
    if (v && v.field === f && !resend) return true;
    let ext = null;
    if (POOL_KINDS.has(f.kind)) {
      ext = this.runner.extFor(f, ps.playerId);
      if (!ext) return false;
    }
    if (!f.battleId) {
      const seq = `${this.battlePrefix}.${this.round}.${++this._battleSeq}`;
      f.battleId = seq.length + 1 + String(f.fieldId).length <= 64 ? `${seq}.${f.fieldId}` : seq;
    }
    this.localViews.set(ps.playerId, { field: f });
    (f.localRuns || (f.localRuns = new Set())).add(ps.playerId);
    if (!f.startedAt) f.startedAt = this.sched.now();
    return this.sendTo(ps.playerId, {
      t: 'b.start', battleId: f.battleId, fieldId: f.fieldId, kind: f.kind, spec: f.spec, authoritative: false,
      startAt: f.startedAt, serverNow: this.sched.now(), elapsed: Math.round((Number(f.battle.time) || 0) * 1000) / 1000,
      speed: this.gameSpeed, watch: !f.players.includes(ps.playerId), done: !f.live, local: true, ...(ext ? { ext } : {}),
    }) !== false;
  }

  /** From now on stream `f` to `ps` (its replica diverged, is too slow, or local simulation was switched off). */
  _streamInstead(ps, f, reason) {
    this.localViews.delete(ps.playerId);
    f.localRuns?.delete(ps.playerId);
    if (!f.streamOnly) f.streamOnly = new Set();
    f.streamOnly.add(ps.playerId);
    this.localStats[reason === 'off' ? 'off' : reason === 'requested' ? 'requested' : 'diverged']++;
    this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} ${f.fieldId}: local replica → stream (${reason})`);
    this.sendTo(ps.playerId, { t: 'b.end', battleId: f.battleId, fieldId: f.fieldId, reason: 'stream' });
    if (this.watchers.get(ps.playerId) === f.fieldId && ps.connected) this._sendField(ps.playerId, f.fieldId);
  }
}
