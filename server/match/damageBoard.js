// Match lifecycle ledger: replace absolute field scores, retain normal + unite, freeze before fields are cleared.
// No players/board references survive capture, and no per-hit or per-tick aggregation is required on main.
const amount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
// Healing (fork 2026-10-16, the upstream 作战统计 merged into this board): optional on input — a row without it heals 0.
const healAmount = (n) => n === undefined ? 0 : amount(n);
const PHASES = new Set(['normal', 'unite', 'boss', 'hidden']);
const clone = (value) => value == null ? value : structuredClone(value);
const ownerMeta = (owner) => typeof owner === 'string' ? { playerId: owner } : {
  playerId: owner.playerId,
  ...(typeof owner.name === 'string' ? { name: owner.name } : {}),
  ...(Number.isInteger(owner.seat) ? { seat: owner.seat } : {}),
};

export class DamageBoard {
  constructor(matchId) {
    this.matchId = matchId;
    this.round = null;
    this.phase = null;
    this.status = 'frozen';
    this.owners = new Map();
    this.fields = new Map();
    this.previousRound = null;
    this._frozen = null;
  }

  /** Call on actual battle start, NOT startRound/PREP. Same-round unite preserves normal finals. */
  startCombat(round, phase, owners = []) {
    if (!Number.isInteger(round) || round < 1 || !PHASES.has(phase)) throw new TypeError('damage board round/phase required');
    if (this.round != null && round < this.round) return false;
    if (this.round === round && this.status === 'frozen' && this.phase === phase) return false;
    // Final Assault/hidden are separate combat scopes, not another contribution to a normal round.
    const reset = this.round !== round || (this.phase !== phase && (phase === 'boss' || phase === 'hidden'));
    if (reset) { this.fields.clear(); this.owners.clear(); }
    for (const owner of owners) {
      const meta = ownerMeta(owner);
      if (typeof meta.playerId === 'string' && !this.owners.has(meta.playerId)) this.owners.set(meta.playerId, meta);
    }
    this.round = round;
    this.phase = phase;
    this.status = 'live';
    this._frozen = null;
    return true;
  }

  /**
   * Only a current stream may replace its field. Late normal replies cannot overwrite unite,
   * earlier gt/seq cannot overwrite a resync, and a duplicate terminal reply never adds damage.
   */
  replaceField({ matchId, round, phase, fieldId, kind = phase, gt = 0, seq = null, owners, final = false }) {
    if (matchId !== this.matchId || round !== this.round || phase !== this.phase || this.status !== 'live'
      || typeof fieldId !== 'string' || kind !== phase || !Number.isFinite(gt) || gt < 0 || !Array.isArray(owners)) return false;
    if (seq != null && (!Number.isSafeInteger(seq) || seq < 0)) return false;
    const key = JSON.stringify([phase, fieldId]);
    const previous = this.fields.get(key);
    if (previous && (gt < previous.gt || (seq != null && previous.seq != null && seq < previous.seq)
      || (previous.final && !final))) return false;
    const rows = [];
    const seen = new Set();
    for (const owner of owners) {
      if (!this.owners.has(owner?.playerId) || seen.has(owner.playerId) || amount(owner.total) == null
        || amount(owner.otherDamage) == null || healAmount(owner.healing) == null || healAmount(owner.otherHealing) == null
        || !Array.isArray(owner.operators)) return false;
      seen.add(owner.playerId);
      const operators = [];
      const opKeys = new Set();
      for (const op of owner.operators) {
        if (typeof op?.key !== 'string' || opKeys.has(op.key) || amount(op.damage) == null || healAmount(op.healing) == null
          || (op.uid != null && !Number.isSafeInteger(op.uid)) || (op.defId != null && typeof op.defId !== 'string')) return false;
        opKeys.add(op.key);
        operators.push({ key: op.key, uid: op.uid ?? null, defId: op.defId ?? null, damage: op.damage, healing: healAmount(op.healing) });
      }
      rows.push({ playerId: owner.playerId, total: owner.total, healing: healAmount(owner.healing), operators,
        otherDamage: owner.otherDamage, otherHealing: healAmount(owner.otherHealing) });
    }
    this.fields.set(key, { gt, seq, final: final === true, owners: rows });
    return true;
  }

  _packet() {
    // seconds: the battle time of every field the owner fought on this round (the board's DPS / HPS divisor)
    const rows = new Map([...this.owners].map(([id, meta]) => [id, { ...meta, total: 0, healing: 0, seconds: 0, operators: new Map(),
      otherDamage: 0, otherHealing: 0 }]));
    for (const field of this.fields.values()) for (const owner of field.owners) {
      const row = rows.get(owner.playerId);
      row.total += owner.total;
      row.healing += owner.healing || 0;
      row.seconds += field.gt;
      row.otherDamage += owner.otherDamage;
      row.otherHealing += owner.otherHealing || 0;
      for (const op of owner.operators) {
        const existing = row.operators.get(op.key);
        if (existing) { existing.damage += op.damage; existing.healing = (existing.healing || 0) + (op.healing || 0); }
        else row.operators.set(op.key, { ...op, healing: op.healing || 0 });
      }
    }
    return { t: 'm.damage', matchId: this.matchId, round: this.round, phase: this.phase, status: this.status,
      owners: [...rows.values()].map((row) => ({ ...row, operators: [...row.operators.values()] })) };
  }

  /** Capture all owners (including eliminated ones) before settle/final clears their fields. */
  freeze() {
    if (this.round == null) return null;
    if (!this._frozen) {
      this.status = 'frozen';
      this._frozen = this._packet();
      this.previousRound = clone(this._frozen);
    }
    return clone(this._frozen);
  }

  /** Complete server-side state for view switching/reconnect, including PREP without previous observations. */
  packet() { return this.round == null ? null : clone(this._frozen || this._packet()); }
}

export const createDamageBoard = (matchId) => new DamageBoard(matchId);
