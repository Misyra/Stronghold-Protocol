// server/match/player/basics.js — PlayerState methods: the basics — seat flags and counts (isHumanActive,
// botControlled, deployCap, deployCount, tempEmpty), the prep that resolves a temp piece (tempDue, _putTemp: every
// write into a temp slot), the operator loadout (DESIGN §16: setLoadout, loadoutFor), the deploy map on the field the
// player deploys on (Match.deployFieldOf) and the withdrawal of pieces a terrain / deploy-field change left on tiles
// they may no longer occupy (_evictIllegal), dirty.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { PHASE } from '../../../shared/constants.js';
import { msg, dn } from '../../../shared/i18n.js';
import { checkLoadout, resolveLoadout } from '../../../shared/protocol.js';
import { tileKey, boardOrder } from '../board.js';

export class PlayerBasics {
  get isHumanActive() { return !this.isBot && !this.left; }
  /** The engine acts for this seat (AI teammate or "AI 托管"; a departed human is eliminated, so nothing is left to do). */
  get botControlled() { return this.isBot || this.left || this.autoplay; }

  get deployCap() { return Math.max(1, this.gd.deployCap + this.deployCapBonus, this.deployCapMin); }
  get deployCount() { let n = 0; for (const p of this.board.values()) if (p.kind === 'chess') n++; return n; }
  get tempEmpty() { return this.temp.every((x) => x == null); }

  /**
   * Index of the prep whose deadline resolves a temp piece (compare with `prepsEnded`): recorded when the piece entered
   * temp (_putTemp); a piece put there by other means counts as due at the current (or next) prep.
   */
  tempDue(piece) {
    const due = piece ? this._tempDue.get(piece.uid) : undefined;
    return Number.isInteger(due) ? due : this.prepsEnded;
  }

  /**
   * Due prep of a piece entering temp now: the current prep while the player can still act on it (PREP, not ready);
   * after Ready or at the prep end (onPrepEnd grants) the next one; outside PREP (COMBAT, SETTLE, ROUND_START, 机变)
   * the next prep to end — `prepsEnded` then already names it.
   */
  _tempDueNow() {
    return this.prepsEnded + (this.m.phase === PHASE.PREP && this.ready ? 1 : 0);
  }

  /** Every write of a piece into a temp slot goes through here (records its due prep). */
  _putTemp(i, piece) {
    this.temp[i] = piece;
    this._tempDue.set(piece.uid, this._tempDueNow());
  }

  /**
   * Replace the operator loadout (DESIGN §16) after re-checking it against this match's data. Accepts the checked
   * form `{ id: { skill, module|null } }` or raw `room.loadout` entries. Returns false (loadout unchanged) when it does
   * not fit the data; bots keep the defaults.
   * @param {any} loadout
   * @returns {boolean}
   */
  setLoadout(loadout) {
    if (this.isBot) return false;
    const entries = {};
    if (loadout && typeof loadout === 'object' && !Array.isArray(loadout)) {
      for (const [id, e] of Object.entries(loadout)) {
        if (!e || typeof e !== 'object') continue;
        const x = {};
        if (Number.isInteger(e.skill)) x.skill = e.skill;
        if (typeof e.module === 'string') x.module = e.module;
        if (Object.keys(x).length) entries[id] = x;
      }
    }
    const res = checkLoadout(entries, (id) => this.gd.chess(id));
    if (!res || !res.ok) {
      this.m.log?.warn?.(`[match ${this.m.roomCode}] loadout of ${this.playerId} ignored: ${res && res.detail}`);
      return false;
    }
    const out = {};
    for (const [id, e] of Object.entries(res.loadout)) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
    this.loadout = Object.freeze(out);
    return true;
  }

  /** The skill index / module a chess record fights with under this player's loadout (DESIGN §16). */
  loadoutFor(chessRecord) {
    return resolveLoadout(this.loadout, chessRecord, (id) => this.gd.chess(id));
  }

  /**
   * Deploy classes of the board tiles (server/match/board.js buildDeployMap) on the field the player deploys on now
   * (Match.deployFieldOf: the own board, or its half of the boss field in a boss round — user playtest #5 item 7).
   * A change of that field (the boss round begins, a re-pairing) re-checks the board's legality like a terrain change.
   */
  deployMap() {
    const field = typeof this.m.deployFieldOf === 'function' ? this.m.deployFieldOf(this) : 'normal';
    if (this._deployMap && this._deployField !== undefined && this._deployField !== field) {
      this._deployMap = null;
      this._legalityStale = true;
    }
    if (!this._deployMap) this._deployMap = this.m.deployMapFor(this, field);
    this._deployField = field;
    return this._deployMap;
  }
  /**
   * The board's terrain changed (terrain 机变 cards, content device / tile overrides): legality is re-checked at the
   * next recompute() / battleInput() — after the whole change, so an intermediate state of a card that toggles several
   * devices never moves a piece.
   */
  invalidateDeployMap() { this._deployMap = null; this._legalityStale = true; }

  /**
   * After a terrain change, pieces standing on tiles they may no longer occupy (a melee operator on a tile that became
   * a 射击台, anything on a tile that became undeployable) are withdrawn like 撤退: an operator goes to the hand
   * (overflow temp — a passive move; the player re-places it during the prep), its summons leave the board with it; a
   * summon returns to its owner's stack. Nothing is lost: with the hand and temp both full a piece stays put.
   * @returns {number} pieces moved
   */
  _evictIllegal() {
    this._legalityStale = false;
    const names = [];
    let moved = 0;
    for (const kind of ['chess', 'token']) {
      for (const { r, c, piece } of boardOrder(this.board)) {
        if (piece.kind !== kind || this._legal(piece, r, c)) continue;
        const key = tileKey(r, c);
        this.board.delete(key);
        const ok = kind === 'chess' ? !!this.stow(piece, { allowTemp: true }) : this._returnToken(piece);
        if (!ok) { this.board.set(key, piece); continue; }
        moved++;
        if (kind === 'chess') {
          this.removeTokensOf(piece.uid);
          const rec = this.gd.chess(piece.id);
          names.push(rec && rec.name ? rec.name : piece.id);
        }
      }
    }
    if (names.length) this.m.toast(this, 'warn', msg('地形变化：{names}无法停留在原位置，已撤回整备区', { names: names.map(dn) }));
    return moved;
  }

  dirty() { this.m.markPrivate(this); }
}
