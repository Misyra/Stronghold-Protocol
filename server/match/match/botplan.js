// server/match/match/botplan.js — Match methods: bot 布防规划的池化（SP_BOT_PLAN_POOL，默认关）。
//
// 整备期 final arrange 的第一批候选规划（REHEARSAL_VARIANTS + Final Assault 的 body plans——彼此独立、
// 同一条 rngBots 链）作为一次 'botplan' 池任务交 worker（server/workers/simulation.js；载荷由 bot.js
// capturePlanTask 采集），主线程只做提交/解码/校验。job 契约与 poolRehearsal 同形（pending / onSettled /
// run(budget) / done / best / plans / chosen / takeOver），Match.scheduleBotPrep 的驱动零改动：
//   1. 'plan'   池任务在飞（pending=true，驱动装 onSettled 等它）；
//   2. 解析：核验 m.rngBots 仍停在采集时的状态（整备错峰 350ms 下几乎恒成立；被别的席位的 rngBots 消费
//      推进过则核验失败）→ 用 worker 末态接续 rng 流，按内联顺序拼回 plans（v0, body…, chain, v1…），
//      驱动 rest 生成器（arrangePlanSteps 的后半段，8ms 切片）→ 它返回 rehearsal job（或 null）；
//   3. 'rehearsal' 委托给 rehearsal job 的 run/done/best（其 pending 由驱动的轮询切片吸收）。
// 任何失败形态（POOL_FULL / 任务失败 / 状态核验不过 / 匹配已结束）都回退主线程内联路径——costs latency,
// never a different layout：回退即 arrangePlanSteps 的 stage1=null 全内联形态，与开关关闭逐字节同轨。
import { DEFAULT_VERSION } from '../../../shared/versions.js';
import { createRngFromState } from '../../sim/rng.js';
import { LayoutPlan, leaderChainPlan } from '../bot.js';
import { planFromResult } from '../botPlanTask.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class MatchBotPlan {
  /**
   * Submit one stage-1 plan batch to the simulation pool. Null when the pool cannot take it (the caller runs
   * inline). The task registers in _rehearsalTasks (kind 'plan') so the prep end cancels it like a rehearsal.
   * @param {{ ps: any, tasks: object[] }} o
   */
  poolPlan({ ps, tasks }) {
    const pool = this.simPool;
    if (!pool || this.disposed || this.ended) return null;
    // a gameplay-plugin / other-version room's content set does not reach a worker thread (same rule as poolRehearsal)
    if (this.requireCs || (this.version && this.version !== DEFAULT_VERSION)) return null;
    if (!Array.isArray(tasks) || !tasks.length) return null;
    const payload = tasks.map((t, i) => ({ ...t, seq: i }));
    let handle;
    try {
      // 规划任务很小（均值 ~8.5ms 计算量），优先级压过整秒级的 rehearsal，整备错峰窗口内几乎必然落定
      handle = pool.submit('botplan', { tasks: payload }, { priority: 10 });
    } catch {
      return null;
    }
    if (!handle || !handle.promise) return null;
    const task = {
      id: `${this.battlePrefix}.${this.round}.${ps.seat}.plan.${++this._rehearsalSeq}`,
      playerId: ps.playerId, job: null, executor: null, timer: null, kind: 'plan',
      cancel: () => { try { handle.cancel(); } catch { /* already settled */ } },
    };
    this._rehearsalTasks.set(task.id, task);
    pool.assign?.(this.roomCode);
    this.botPlanPoolStats.pooled++;
    return { handle, task };
  }

  /**
   * The composite bot-plan job: stage-1 pool task → plans → rest generator → rehearsal job.
   * `rest(plans)` is bot.js arrangePlanSteps with the stage-1 plans already resolved (null triggers the
   * full-inline fallback); it returns the rehearsal job (createRehearsalSteps with defer) or null.
   * @returns {object | null} the job, or null when the pool refused (caller falls back inline)
   */
  createBotPlanJob({ ps, chosen, tasks, rest, nVariants }) {
    const submitted = this.poolPlan({ ps, tasks });
    if (!submitted) return null;
    const m = this;
    const job = {
      tasks, nVariants, rest,
      // once the inner rehearsal job exists it owns the prepEnd contract (chosen may have widened to rehChosen,
      // best follows its picks) — the composite delegates those reads
      get chosen() { return job._reh ? job._reh.chosen : chosen; },
      get plans() { return job._reh ? job._reh.plans : (job._plans || []); },
      get best() { return job._reh ? job._reh.best : (job._plans ? job._plans[0] : null); },
      get stats() { return job._reh ? job._reh.stats : null; },
      get inputs() { return job._reh ? job._reh.inputs : null; },
      get cap() { return job._reh ? job._reh.cap : null; },
      get limits() { return job._reh ? job._reh.limits : null; },
      done: false, pending: true, onSettled: null,
      _plans: null, _reh: null, _phase: 'plan',
      // the driver's delegated-rehearsal protocol calls takeOver when onSettled fires with !done — for the
      // composite the plan has already settled by then: a no-op (a failed plan took the inline path internally)
      takeOver() {},
      run(budgetMs = Infinity, control = null) {
        if (job.done) return true;
        if (job._phase === 'plan') return false; // pool task in flight: the driver waits via onSettled
        if (job._phase === 'rest') return job._runRest(budgetMs, control);
        if (job._reh) {
          const done = job._reh.run(budgetMs, control);
          job.done = job._reh.done;
          return done;
        }
        return job.done;
      },
      _runRest(budgetMs, control) {
        // 与 scheduleBotPrep.drive 同一片循环形态：test replay 按 journalled 步数停，否则按墙钟切片
        const replaying = !!(control && control.replaying);
        const t0 = now();
        const over = () => (replaying ? control.stop() : (control
          ? control.wall(now() - t0, budgetMs)
          : Number.isFinite(budgetMs) && now() - t0 >= budgetMs));
        try {
          let r = null;
          // loop-cap: generator (the rest generator, sliced by the driver's budget like scheduleBotPrep.drive)
          do {
            r = job._restGen.next();
            if (!r || typeof r.done !== 'boolean') throw new TypeError('Bot prep hooks must return a synchronous iterator');
            if (control) control.note(1);
          } while (!r.done && !over());
          if (!r.done) return false;
          const reh = r.value;
          job._phase = 'rehearsal';
          if (!reh) { job.done = true; return true; }
          job._reh = reh;
          job.done = reh.done;
          return job.done;
        } catch (e) {
          m.reportError(`bot ${ps.playerId} plan-pool rest`, e);
          job.done = true;
          return true;
        }
      },
      /** The pool answered (or the task failed): verify, apply, and move to the rest phase — or fall back inline. */
      _settle(value, error) {
        // the prep ended (or the seat re-scheduled) while the task was in flight: a late answer changes nothing
        if (submitted.task.dropped) return;
        m._dropRehearsalTask(submitted.task);
        if (m.disposed || m.ended) return;
        if (!error && value && Array.isArray(value.results) && m.rngBots.state() === tasks[0].rngState) {
          try {
            const variantPlans = value.results.slice(0, nVariants).map((r) => planFromResult(LayoutPlan, r.plan));
            const bodyPlans = value.results.slice(nVariants).map((r) => planFromResult(LayoutPlan, r.plan));
            // rng 接续：worker 消耗的抽取以末态写回（核验已确保主线程流仍停在采集态，期间无人动过这条流）
            m.rngBots = createRngFromState(value.rngState);
            const chain = leaderChainPlan(m, ps, chosen, variantPlans[0]);
            job._plans = [variantPlans[0], ...bodyPlans, ...(chain ? [chain] : []), ...variantPlans.slice(1)];
            job.botPlanApplied = true;
            m.botPlanPoolStats.accepted++;
          } catch (e) {
            m.reportError(`bot ${ps.playerId} plan-pool apply`, e);
            job._plans = null;
          }
        } else {
          m.botPlanPoolStats.fallbacks++;
        }
        job.pending = false;
        job._phase = 'rest';
        // 核验不过 / 失败：plans=null → rest 走全内联（含第一批规划），与开关关闭同轨
        job._restGen = rest(job._plans);
        if (job.onSettled) job.onSettled();
      },
    };
    submitted.handle.promise.then(
      (value) => job._settle(value, null),
      () => job._settle(null, new Error('botplan task failed')),
    );
    return job;
  }
}
