// server/sim/battle/economy.js — Battle methods: DP, IN_BATTLE bond layer gains (capped by layerGainRoom) and bounty
// coins.
// Installed on Battle.prototype by server/sim/Battle.js (a method container: never instantiated; `this` is the battle).

import { layerGainRoom } from '../../../shared/constants.js';

export class BattleEconomy {
  addDp(playerId, n) {
    const ps = this.getPlayer(playerId);
    if (!ps || !Number.isFinite(n)) return 0;
    ps.dp = Math.max(0, Math.min(this.flags.dpMax, ps.dp + n));
    return ps.dp;
  }

  /**
   * Record an IN_BATTLE layer gain (no-op when gains are disabled). Returns the layers added: at most the room left
   * under BOND_LAYER_CAP (999, shared/constants.js) on the live copy — the client's AddBondCount `min(L + n, 999)`; the
   * `layerGain` hook (魔王's +1 …) runs first, then the clamp; a bond already at the cap gains 0 (no hook, no event).
   * Without a live copy of the bond (a partial PlayerBattleInput) the battle's own gains count; the match's settle
   * clamps the persistent count the same way.
   */
  addLayers(playerId, bondId, n, reason = '', opts = {}) {
    if (!this.flags.layerGainsEnabled || !(n > 0) || !Number.isFinite(n) || playerId == null) return 0;
    const pp = this._pp(playerId);
    if (!pp) return 0;
    const ps = this.getPlayer(playerId);
    const live = ps && ps.bonds[bondId] ? (ps.bonds[bondId].layers ?? 0) : (pp.layerGains[bondId] ?? 0);
    if (!(layerGainRoom(live, Infinity) > 0)) return 0;
    const source = opts.source ?? null;
    const ctx = { playerId, bondId, n, reason, source, tile: Array.isArray(opts.tile) ? opts.tile : this._sourceTile(source) };
    if (this._hooks.layerGain) { this.emit('layerGain', ctx); if (!(ctx.n > 0) || !Number.isFinite(ctx.n)) return 0; }
    const add = layerGainRoom(live, ctx.n);
    if (!(add > 0)) return 0;
    pp.layerGains[bondId] = (pp.layerGains[bondId] ?? 0) + add;
    if (ps && ps.bonds[bondId]) ps.bonds[bondId].layers = (ps.bonds[bondId].layers ?? 0) + add;
    this._ev(['layer', playerId, bondId, add]);
    return add;
  }

  /**
   * Tile of a gain's source unit ([r, c]): where it stands, or where it stood when it left the field during this very
   * instant (a "被击倒时" gain fires from its `death`). null otherwise (no source, long gone, not a unit).
   */
  _sourceTile(u) {
    if (!u || typeof u !== 'object' || !Number.isFinite(u.x)) return null;
    const here = u.alive && u.deployed && !u.hidden;
    if (!here && !(u.deathAt === this.time && !u.alive)) return null;
    return u.side === 'ally' ? [u.tileR, u.tileC] : [Math.round(u.y), Math.round(u.x)];
  }

  addCoins(playerId, n) {
    const pp = this._pp(playerId);
    if (!pp || !(n > 0) || !Number.isFinite(n)) return 0;
    pp.coins += n;
    this._ev(['bounty', playerId, n]);
    return n;
  }
}
