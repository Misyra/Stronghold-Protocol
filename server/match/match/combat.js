// server/match/match/combat.js — Match methods: the battles of a normal round — Battle construction (newBattle, the
// spawn list sanitised, a player's normal field after the onBattleStart handlers), the COMBAT phase in both modes
// (server-run streaming, client-side combat), the per-field results and the sim-error log, then 联防 or SETTLE.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { withBounties } from '../waves.js';
import { planUnite } from '../unite.js';
import { FieldRunner, DeadBattle } from '../fields.js';
import { DELAYS } from './common.js';
import { previewPlayer } from '../preview.js';
import { morphBattleOpt } from '../../../shared/plugins/rules.js';

export class MatchCombat {
  /** Construct a battle; a constructor failure yields a finished stand-in (clean result) and is logged. */
  newBattle(opts, { preview = false } = {}) {
    const full = { resourceNumbers: !preview, data: this.ds, content: this.battleContent, logger: this.log, ...opts, ...morphBattleOpt(this.rules),
      ...(preview ? { logger: {}, quiet: true } : {}) };
    try {
      return new this.BattleClass(full);
    } catch (e) {
      if (!preview) this.reportError(`battle ${opts.fieldId} construct`, e);
      return new DeadBattle(full, 'forced');
    }
  }

  /**
   * Spawn list of a field after the onBattleStart handlers (which may edit `ev.spawns`): malformed entries are dropped
   * and a kill bounty is copied into `mods.bountyCoins`, so a leaked bounty enemy keeps paying its killer in 联防.
   */
  _sanitizeSpawns(list, ownerPlayerId = null) {
    const out = [];
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || typeof s !== 'object' || typeof s.enemyKey !== 'string' || !this.gd.enemy(s.enemyKey)) continue;
      const spec = { ...s, mods: s.mods && typeof s.mods === 'object' ? { ...s.mods } : {} };
      if (ownerPlayerId && spec.ownerPlayerId == null) spec.ownerPlayerId = ownerPlayerId;
      const coins = spec.bounty && typeof spec.bounty === 'object' ? Math.trunc(Number(spec.bounty.coins) || 0) : 0;
      if (coins > 0 && spec.mods.bountyId == null && spec.mods.bountyCoins == null) spec.mods.bountyCoins = coins;
      out.push(spec);
    }
    return out;
  }

  _normalBattle(ps) { return this.newBattle(this._normalOpts(ps)); }

  /**
   * The room's experimental battle rules as spec flags (移植自 Stardust fork). A rule a battle reads rides on its spec,
   * so the Worker, a browser's local replica, a client-run field and the server's check of it all fight the same battle.
   * Nothing when off.
   */
  _ruleFlags() {
    return { ...(this.disableLayerCap ? { layerCapOff: true } : {}), ...(this.disableHitLimit ? { hitLimitOff: true } : {}) };
  }

  /** Battle options of a player's normal field (after the onBattleStart handlers). */
  _normalOpts(ps, { preview = false, board = ps.board } = {}) {
    const wave = preview ? structuredClone(this.wave) : this.wave;
    if (preview) ps = previewPlayer(ps, board);
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    // the client's list: bounty units inserted among their host action's own units, which are re-timed around them
    const spawns = withBounties(this.gd, this.round, wave, ps.bounties, ps.playerId).map((s) => ({ ...s, ownerPlayerId: ps.playerId }));
    // `waveSpawns`: the round's own wave before this player's bounties (a copy), so a draw every player shares picks the
    // same units; `routes`: their lanes (鸭爵, GitHub #839)
    const waveSpawns = (wave.spawns || []).map((s) => ({ ...s, mods: s.mods ? { ...s.mods } : undefined }));
    const ev = { input, kind: 'normal', round: this.round, spawns, waveSpawns, routes: wave.routes, ...(preview ? { preview: true } : {}) };
    // Preview construction failures go to the rehearsal's discard path, never Match.dispatch's live error sink.
    if (preview) this.dispatcher.dispatch(ps, 'onBattleStart', ev);
    else this.dispatch(ps, 'onBattleStart', ev);
    return {
      seed: deriveSeed(this.seed, `n:${this.round}:${ps.seat}`),
      kind: 'normal',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.NORMAL_RECT },
      timeLimit: wave.timeLimit,
      players: [ev.input && typeof ev.input === 'object' ? ev.input : input],
      spawns: this._sanitizeSpawns(Array.isArray(ev.spawns) ? ev.spawns : spawns, ps.playerId),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: true, ...this.gd.dp, ...this._ruleFlags() },
      fieldId: `n:${ps.playerId}`,
      enemyOverrides: wave.overrides,
      waveId: wave.templateId,
    };
  }

  startCombat() {
    this._applySpeedVote(); // 已全员赞成的 2 倍速投票在这场战斗建立前生效（match/speedVote.js）
    if (this.clientCombat) { this._startCombatClient(); return; }
    this.phase = PHASE.COMBAT;
    const alive = this.alivePlayers();
    this.lastResults = new Map();
    this.lastResultTimes = new Map();
    // 容量联防（移植自用户分支 startCombat）：联防的存活门槛精确到战斗开始时刻；接力档案随新战斗作废
    this._normalAliveCount = alive.length;
    this._uniteRelay = null;
    this.fields = alive.map((ps) => ({ fieldId: `n:${ps.playerId}`, kind: 'normal', players: [ps.playerId], battle: this._normalBattle(ps), live: true }));
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.runner = new FieldRunner(this, this.fields, { onDone: (runner) => this.combatDone(runner) });
    this.runner.start();
  }

  _startCombatClient() {
    this.phase = PHASE.COMBAT;
    const alive = this.alivePlayers();
    this.lastResults = new Map();
    this.lastResultTimes = new Map();
    // 容量联防（移植自用户分支 _startCombatClient）：同 startCombat——门槛取战斗开始时刻的存活数，接力档案作废
    this._normalAliveCount = alive.length;
    this._uniteRelay = null;
    this.watchers.clear();
    const fields = alive.map((ps) => this._ccField({ fieldId: `n:${ps.playerId}`, kind: 'normal', players: [ps.playerId], opts: this._normalOpts(ps) }));
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._launch(fields);
    // every fighting human runs its own field; eliminated humans (and spectator seats) keep watching (research 09 §3.1
    // "Keep-watching auto-observes the first available field", switching freely with 前往查看): a replica of the field
    // of the player they follow — the one they last watched, else the first player still in (item 56) — else the first
    for (const f of fields) for (const pid of f.players) {
      const ps = this.players.get(pid);
      if (!ps || ps.isBot || ps.left) continue;
      this.watchers.set(pid, f.fieldId);
      this._sendStart(pid, f);
    }
    const first = fields.find((f) => f.mode === 'client') || fields[0] || null;
    if (first) {
      for (const ps of this._viewers()) {
        if (ps.alive || this.watchers.has(ps.playerId)) continue;
        const f = this._watchTargetField(ps, fields) || first;
        this.watchers.set(ps.playerId, f.fieldId);
        this._sendStart(ps.playerId, f, { watch: true });
      }
    }
    this.markPublic();
  }

  /** Aggregate a finished field's content/engine errors (battle.errors: unique records) for diagnostics. */
  _collectSimErrors(f, res) {
    this.simErrors += Number(res && res.errors) || 0;
    // SP_BATTLE_POOL: a pool-run field holds no battle object — its battle's error records travelled on f.errors
    // (the worker's return), the same unique records the local run keeps on f.battle.errors.
    const list = (f && f.battle && Array.isArray(f.battle.errors)) ? f.battle.errors : (f && Array.isArray(f.errors)) ? f.errors : [];
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const key = `${e.label}|${e.who || ''}|${e.message}`;
      let rec = this.simErrorLog.get(key);
      if (!rec) {
        if (this.simErrorLog.size >= 500) continue;
        rec = { label: String(e.label), who: String(e.who || ''), message: String(e.message), stack: e.stack ? String(e.stack) : null, battles: 0, count: 0 };
        this.simErrorLog.set(key, rec);
      }
      rec.battles++;
      rec.count++;
    }
  }

  combatDone(runner) { this._finishCombat((f) => runner.resultOf(f)); }

  /** Every normal field has its result: record them, then 联防 or SETTLE. */
  _finishCombat(resultOf) {
    if (this.phase !== PHASE.COMBAT) return;
    this._stopClientCombat();
    for (const f of this.fields) {
      const res = resultOf(f);
      this._collectSimErrors(f, res);
      // 伤害/治疗结算板 (server/match/damageBoard.js): fold the field's final result in (both combat modes deliver the
      // same perPlayer shape — a validated client b.result or the server battle's own result)
      this.damageBoard.record(this.round, res);
      for (const pid of f.players) {
        const pp = res.perPlayer && res.perPlayer[pid];
        this.lastResults.set(pid, pp || { killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0, damageDealt: 0, unitsEnd: [], unitStats: [] });
        // the battle's own game-time seconds (the full result's top-level `time`) — the onBattleResult ev's `time`
        this.lastResultTimes.set(pid, Number(res.time) || 0);
        // the views show the layers the battle reached until settle() makes them persistent (DESIGN §20.15)
        const ps = this.players.get(pid);
        const gains = pp && pp.layerGains && typeof pp.layerGains === 'object' ? pp.layerGains : null;
        if (ps && gains && Object.keys(gains).length) { ps.pendingLayerGains = { ...gains }; ps.dirty(); }
      }
    }
    for (const f of this.fields) f.live = false;
    this.deadline = 0;
    this.markPublic();
    this.later(this.scaled(DELAYS.COMBAT_END), () => this._afterCombat());
  }

  /**
   * After the COMBAT_END pause: 联防 or SETTLE. The plan is made now, from the players still in — a player who quit
   * during the last field or the pause (中途退出 = eliminated, board cleared) is neither a helper nor a leaker whose
   * enemies re-enter.
   */
  _afterCombat() {
    if (this.phase !== PHASE.COMBAT) return;
    const plan = planUnite(this, this.lastResults);
    if (plan) this.startUnite(plan);
    else this.settle(null, null);
  }
}
