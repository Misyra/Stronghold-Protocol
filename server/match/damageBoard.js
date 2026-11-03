// server/match/damageBoard.js — the match-lifecycle 伤害/治疗结算板 (fork feature, rewritten after the reference design
// of the source repo's server/match/damageBoard.js on this 0.3.4 architecture): every finished field's result is folded
// in once, cumulative across fields / rounds / phases (normal rounds, 联防, 最终攻势 / 隐秘核心) for the whole match.
//
// Where the numbers come from — both combat modes deliver the SAME perPlayer shape with a finished field's result, so
// the match needs no sim-side extraction at all (the reference design read the live battle's stats.dmg / stats.heal
// through server/sim/damageBoard.js damageRows; here the read points are the result the match already holds):
//   * server-run fields (SP_COMBAT=server, bots, takeovers): Battle._buildResult (server/sim/battle/lifecycle.js) —
//     perPlayer.damageDealt / .healingDone (the counters of server/sim/attack/health.js / heal.js) and perPlayer.unitStats
//     (the full unit list: per unit dmg / heal from unit.stats).
//   * client-run fields (the default, DESIGN §14): the authority's b.result, validated by validateClientResult
//     (server/match/fields.js) — the same damageDealt / healingDone / unitStats fields (dmg / heal / uid / defId / kind).
// An implausible client result is replaced by the server's own simulation before it is recorded, so the board never
// carries a rejected report.
//
// Recording points (server/match/match/): combat.js _finishCombat (normal fields, both modes), settle.js (the 联防
// field's result, both modes — the one place the UNITE result exists), bossRounds.js _finishFinal (boss / hidden
// fields, which pass the scope 'boss' / 'hidden' along). The board is pure additional metadata: nothing in the sim,
// the settlement or the golden results reads it; views.js exposes it as `m.public.damage`, which reconnects and
// spectator seats receive like any public view. The settlement (results.js buildResult) additionally reads
// `bossRounds()` — the boss scopes' own per-player / per-operator ledgers — as `m.result.bossDamage` for the local
// match records (0.3.4 §37.77, ported from the Stardust fork's PR5: there the whole board was per-round packets; here
// the m.public board stays match-cumulative and only the record's breakdown is scoped).
//
// Design decisions against the fork's live implementation (Stardust-minus review), which sampled live battles at 1 Hz
// and refused client-derived rows in clientCombat (`available: false`):
//   * Client-run fields feed this board. Deliberate: in this architecture the validated b.result is already the basis
//     of the settlement's own stats (ps.stats.dmgDealt / healing, m.result) — an implausible report is replaced by the
//     server's simulation before it is ever recorded, so the board cannot carry more trust than the settlement does.
//   * No per-viewer restriction of the other boss pair's rows: m.public is one shared frame, and the board only gains
//     rows at a field's completion — during a boss fight nothing about it is recorded yet, and the client renders the
//     board on the settlement screen (public/js/screens/result.js), where no fight is running.
//   * Match-cumulative rows (the fork's ledger is per round, frozen before settle): the feature this fork asks for is
//     一局对局内跨场地的累计, and the settlement screen reads the whole match. Per-round views can be derived later.
//   * Not persisted in match checkpoints (snapshot.js TRANSIENT_MATCH_FIELDS): a restored match rebuilds it empty.
//
// Identity across fields: a board operator keeps its uid for the whole match, so the same operator redeployed in a
// later round accumulates into one row (`u:<uid>`); a unit created in battle (a summon, no uid) accumulates by its
// defId (`d:<defId>`) — two distinct summons of the same kind share a row, which is the finest identity a result
// carries ([ASSUMED], the same keying settle.js _charDamageTickers uses).

/** A reported number kept only when it is a usable non-negative one; anything else counts 0 (never fabricate). */
const amount = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
/** Per-operator rows kept in the view (largest damage first). A long fight can field many summons; the player totals
 * stay exact regardless. [ASSUMED] 32 is far above any real lineup plus its summons. */
const OPS_CAP = 32;

export class DamageBoard {
  constructor() {
    /** @type {Map<string, { playerId: string, damage: number, healing: number, operators: Map<string, object> }>} */
    this.players = new Map();
    /** The last round a field was recorded for (informational, m.public.damage.round). */
    this.round = 0;
    /**
     * The boss scopes' own cumulative ledgers (最终攻势 'boss' / 隐秘核心 'hidden'), kept beside the match-cumulative
     * board for the settlement record (`bossRounds()` → m.result.bossDamage): the m.public board deliberately stays
     * match-cumulative (header), so the per-round breakdown is a second fold of the same results, not a view of it.
     * A scope ledger is only appended to and never cleared: each boss phase is fought once, and a later normal round
     * must not disturb the record. Not persisted in match checkpoints (like the board itself).
     * @type {Map<string, { round: number, phase: string, players: Map<string, object> }>}
     */
    this.scopes = new Map();
  }

  /**
   * Fold one finished field's result into the ledger. `result` is a BattleResult / validated client result (its
   * perPlayer as built by lifecycle._buildResult / validateClientResult); bad shapes are ignored, never thrown —
   * a bookkeeping failure must not touch the match flow. `phase`: the boss rounds' scope ('boss' | 'hidden'), passed
   * by bossRounds.js _finishFinal — the same result additionally folds into that scope's ledger (bossRounds()).
   * @param {number} round @param {any} result @param {string} [phase]
   */
  record(round, result, phase = null) {
    const per = result && typeof result === 'object' ? result.perPlayer : null;
    if (!per || typeof per !== 'object') return;
    if (Number.isInteger(round) && round > this.round) this.round = round;
    this._fold(this.players, per);
    if (phase === 'boss' || phase === 'hidden') {
      let scope = this.scopes.get(phase);
      if (!scope) { scope = { round: 0, phase, players: new Map() }; this.scopes.set(phase, scope); }
      if (Number.isInteger(round) && round > scope.round) scope.round = round;
      this._fold(scope.players, per);
    }
  }

  /** Fold one result's perPlayer block into a ledger's player rows (the main board's or a boss scope's). */
  _fold(players, per) {
    for (const [playerId, pp] of Object.entries(per)) {
      if (!pp || typeof pp !== 'object') continue;
      let row = players.get(playerId);
      if (!row) {
        row = { playerId, damage: 0, healing: 0, operators: new Map() };
        players.set(playerId, row);
      }
      row.damage += amount(pp.damageDealt);
      row.healing += amount(pp.healingDone);
      for (const u of Array.isArray(pp.unitStats) ? pp.unitStats : []) {
        if (!u || typeof u !== 'object') continue;
        const uid = Number.isInteger(u.uid) && u.uid > 0 ? u.uid : null;
        const defId = typeof u.defId === 'string' && u.defId ? u.defId : null;
        if (uid == null && defId == null) continue;
        const key = uid != null ? `u:${uid}` : `d:${defId}`;
        let op = row.operators.get(key);
        if (!op) {
          op = { key, uid, defId,
            kind: u.kind === 'token' ? 'token' : 'op', name: typeof u.name === 'string' && u.name ? u.name : null, damage: 0, healing: 0 };
          row.operators.set(key, op);
        }
        op.damage += amount(u.dmg);
        op.healing += amount(u.heal);
        if (!op.name && typeof u.name === 'string' && u.name) op.name = u.name;
      }
    }
  }

  /** True until the first field result arrived: the view stays OFF m.public entirely before that (no empty noise). */
  get empty() { return this.players.size === 0; }

  /**
   * The public view (views.js `m.public.damage`): { round, players } — rows in first-seen order (seat order of the
   * fields; the client sorts for display), each with its per-operator rows by damage. A fresh plain object every call,
   * safe to hand to a broadcast / a reconnect resync.
   */
  view() {
    return { round: this.round, players: this._rows(this.players) };
  }

  /**
   * The boss scopes' per-player / per-operator damage for the settlement record (results.js buildResult →
   * `m.result.bossDamage`): `{ boss, hidden }`, each `{ round, phase, players }` in the same row shape as the
   * m.public board, or null when neither boss scope was fought (a match that never reached round 14, or an abandoned
   * one whose boss fields never finished). The match is over when this is read, so no live-view fence applies.
   * @returns {{ boss: any, hidden: any }|null}
   */
  bossRounds() {
    if (!this.scopes.size) return null;
    const pick = (phase) => {
      const scope = this.scopes.get(phase);
      return scope ? { round: scope.round, phase: scope.phase, players: this._rows(scope.players) } : null;
    };
    const boss = pick('boss');
    const hidden = pick('hidden');
    return boss || hidden ? { boss, hidden } : null;
  }

  /** Plain player rows of a ledger map (fresh objects, operators by damage then healing, capped at OPS_CAP). */
  _rows(players) {
    return [...players.values()].map((row) => ({
      playerId: row.playerId,
      damage: row.damage,
      healing: row.healing,
      operators: [...row.operators.values()]
        .sort((a, b) => b.damage - a.damage || b.healing - a.healing || (a.key < b.key ? -1 : 1))
        .slice(0, OPS_CAP)
        .map((op) => ({ key: op.key, uid: op.uid, defId: op.defId, kind: op.kind, ...(op.name ? { name: op.name } : {}), damage: op.damage, healing: op.healing })),
    }));
  }
}
