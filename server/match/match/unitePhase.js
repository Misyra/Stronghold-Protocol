// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors, planUniteRelay } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { onStartUnite } from '../botEmotes.js';

export class MatchUnite {
  startUnite(plan) {
    this._applySpeedVote(); // 联防也是一场战斗：已全员赞成的换档在这里生效（match/speedVote.js）
    // 容量房间零存活不能开联防（移植自用户分支 startUnite）：直接按空场结算（settle 的 alive 循环为空，无伤亡）
    if (this.capacityExperiment && !this.alivePlayers().length) { this.settle(null, null); return; }
    // 联防接力（容量房间 ≥8 人，移植自用户分支 startUnite）：第一轮开档，第二轮沿用同一接力档案
    if (plan.uniteRound === 1) this._uniteRelay = { rounds: [] };
    else if (!plan.uniteRound) this._uniteRelay = null;
    if (plan.uniteRound && !this.clientCombat) plan.battleId = `${this.battlePrefix}.${this.round}.${++this._battleSeq}.relay${plan.uniteRound}`;
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.uniteTimeLimit();
    const opts = this._uniteOpts(plan, limit);
    const battle = this.newBattle(opts);
    this.fields = [{ fieldId: opts.fieldId, kind: 'unite', players: plan.helpers.map((p) => p.playerId), battle, live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    onStartUnite(this, plan); // an AI helper says "合作愉快" once on the open of a 联防 (enabled by default; SP_BOT_EMOTES=0 silences it)
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE || this.runner !== runner || this.unitePlan !== plan) return;
        const field = runner.fields[0];
        this._finishUniteField(plan, runner.resultOf(field), field);
      },
    });
    this.runner.start();
  }

  /** A 联防 field's game-second limit: the round's own, in every room size and both rounds of a relay. */
  uniteTimeLimit() {
    return this.wave ? this.wave.timeLimit : 60;
  }

  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   */
  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      // 接力第二轮用自己的种子与场地 id（u:2），第一轮沿用 u —— 普通房与原实现一致（移植自用户分支 _uniteOpts）
      seed: deriveSeed(this.seed, plan.uniteRound === 2 ? `u:${this.round}:2` : `u:${this.round}`),
      ...(plan.uniteRound ? { battleId: plan.battleId } : {}),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp, ...this._ruleFlags() },
      fieldId: plan.uniteRound === 2 ? 'u:2' : 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.uniteTimeLimit();
    const opts = this._uniteOpts(plan, limit);
    const f = this._ccField({ fieldId: opts.fieldId, kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this._viewers()) {
      this.watchers.set(ps.playerId, f.fieldId);
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const f = this.fields[0];
    const res = f.result;
    this._stopClientCombat();
    this._finishUniteField(this.unitePlan, res, f);
  }

  /**
   * Archive a natural terminal once（容量接力，移植自用户分支 _finishUniteField）; a distinct field/generation owns the
   * next relay. No LP is charged here — the round settles once, after the last round of the relay.
   */
  _finishUniteField(plan, res, field) {
    if (this.disposed || this.ended || this.phase !== PHASE.UNITE || this.unitePlan !== plan
      || !this.fields.includes(field) || field.uniteCompleted
      || this.capacityExperiment && (field.cc ? !field.done : !field.battle?.finished)) return;
    field.uniteCompleted = true;
    this._collectSimErrors(field, res);
    field.live = false;
    this.deadline = 0;
    if (this._uniteRelay && plan.uniteRound) {
      const survivors = res && !res.synthetic ? uniteSurvivors(plan, res) : new Map(plan.notReentered);
      if (!res || res.synthetic) for (const l of plan.leaked) {
        survivors.set(l.sourcePlayerId, (survivors.get(l.sourcePlayerId) || 0) + 1);
      }
      this._uniteRelay.rounds.push({ plan, result: res, survivors,
        view: { round: plan.uniteRound, fieldId: field.fieldId,
          battleId: field.battleId || field.spec?.battleId || field.battle?.opts?.battleId,
          helpers: plan.helpers.map((ps) => ps.playerId),
          through: plan.leakers.reduce((n, ps) => n + (survivors.get(ps.playerId) || 0), 0) } });
    }
    this.markPublic();
    this.later(this.scaled(DELAYS.COMBAT_END), () => {
      if (this.phase !== PHASE.UNITE || this.unitePlan !== plan || !this.fields.includes(field) || field.uniteReleased) return;
      field.uniteReleased = true;
      const next = planUniteRelay(this, plan, res, field.spec?.spawns || field.battle?.opts?.spawns);
      if (next) {
        this.runner?.stop();
        this.runner = null;
        this._stopClientCombat();
        this.startUnite(next);
      } else this.settle(plan, res);
    });
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down; a split or a summon raises nothing (a 联防 field tags its runtime spawns
   * `uniteRuntime`, spawns.js — they never crossed the leaker's own goal, so they are neither billed nor shown here).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what the escaped wave sent that leaker (fields.js uniteBillBounds:
   * keySourceCounts only — the same set settlement bills); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      // 容量接力：合成结果按本轮计划自己的漏怪计（不是普通战斗的 lastResults）
      if (plan.uniteRound) return plan.leaked.filter((l) => l.sourcePlayerId === pid).length + (plan.notReentered.get(pid) || 0);
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        // the sample is [gt, killed, total, resolved(, left)]: a 联防 sample's `left` is its 5th element
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[4] && typeof sample[4] === 'object' ? sample[4] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
