// server/match/match/poolGroups.js — Match methods: the seat groups of this match's chess pools (容量实验，移植自
// 用户分支 match/extensions.js 的容量 hunks；手动指定卡池编组 poolPlan 同面，fork Match.js 的 buildPoolGroups/
// routePools hunks；fork 的 Worker 传输/伤害板/救援 hunks 不在本仓范围) — the constructor、a setup reroll 与一个恢复
// 各自经 buildPoolGroups 重建分组，routePools 把席位指到本组的池，poolFor / itemPoolFor 是任何一笔交易的取数点
// （`pool` / `itemPool` 仍是普通对局的诊断/单一视图）。
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { createPoolGroups } from '../pool.js';

export class MatchPoolGroups {
  /**
   * The seat groups of this match's chess pools (pool.js createPoolGroups): 开局抽完禁用后由构造器调用，实验房按
   * 容量规则切组（20 人房固定连续 4 人块），普通房一组、原份数；房主的手动卡池编组（this.poolPlan）优先于自动
   * 规则。分组在开局定型，之后不因淘汰/离开重排。
   * @param {string[]} banned banned base chess ids (drawDisabledBonds)
   * @returns {{ id: number, playerIds: string[], scale: number, pool: import('../pool.js').SharedPool }[]}
   */
  buildPoolGroups(banned) {
    return createPoolGroups(this.gd, this.order, { banned, experimental: this.capacityExperiment, independent: this.disableSharedPool, fixedChunks: this.twentyPlayerMode, plan: this.poolPlan });
  }

  /** seat → its group's pool, whenever a seat cannot simply read `pool`（普通对局为 null，交易走 `pool`）。 */
  routePools(poolGroups) {
    return this.disableSharedPool || this.capacityExperiment || this.poolPlan
      ? new Map(poolGroups.flatMap((g) => g.playerIds.map((id) => [id, g.pool]))) : null;
  }

  /**
   * The chess pool a seat draws from: its group's under the capacity experiment（或独立池），else the shared one.
   * @param {string | { playerId: string }} player
   * @returns {import('../pool.js').SharedPool}
   */
  poolFor(player) {
    const id = typeof player === 'string' ? player : player?.playerId;
    if (this.capacityExperiment && !this.players.has(id)) throw new TypeError('player card pool required');
    if (!this.playerPools) return this.pool;
    const pool = this.playerPools.get(id);
    if (!pool) throw new TypeError('player card pool required');
    return pool;
  }

  /** The equipment stock a seat draws from: its chess-pool group's（pool.js createItemPools）。 */
  itemPoolFor(player) {
    const id = typeof player === 'string' ? player : player?.playerId;
    const pool = this.playerItemPools.get(id);
    if (pool) return pool;
    if (this.poolGroups.length > 1) throw new TypeError('player item stock required');
    return this.itemPool;
  }
}
