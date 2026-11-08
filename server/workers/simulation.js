import { parentPort, workerData } from 'node:worker_threads';
import { SIM_DATA_KEYS, setData } from '../data.js';
import { memorySample } from './memory.js';
import { GameData } from '../match/gamedata.js';
import { applyPlanTask } from '../match/botPlanTask.js';
import { createRngFromState } from '../sim/rng.js';

// The pool clones only the sim's data subset (server/index.js simWorkerData, server/data.js SIM_DATA_KEYS): fail fast
// when one of those keys is missing instead of simulating on half the data — a failed worker sends every task back to
// the main-thread fallback (match/rehearsal.js job.takeOver), never to a wrong result.
const data = workerData && workerData.data;
const missing = SIM_DATA_KEYS.filter((k) => !data || typeof data !== 'object' || !Object.hasOwn(data, k));
if (missing.length) throw new Error(`simulation worker: data is missing ${missing.map((k) => `${k}.json`).join(', ')}`);

// Content imports getData() too: never read a different on-disk version when this thread starts later.
setData(data);
const [{ DataSource }, { createBattleFromSpec }, { HeadlessJob }, { RehearsalRun }] = await Promise.all([
  import('../sim/simdata.js'), import('../sim/spec.js'),
  import('../match/fields.js'), import('../sim/rehearsal.js'),
]);
const ds = new DataSource(data, null);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
// 'botplan' 任务的记录解析（chess/token/baseIdOf——mode 无关的三个只查找；mode 子集缺失不影响它们）
const planGameData = new GameData(data, 'act2autochess');

parentPort.on('message', ({ id, type, payload, cancel }) => {
  const flag = new Int32Array(cancel);
  const cancelled = () => Atomics.load(flag, 0) !== 0;
  try {
    if (cancelled()) throw new Error('cancelled');
    let value;
    if (type === 'battle') {
      const battle = createBattleFromSpec(payload.spec, ds, { recordEvents: false, logger: quiet });
      const job = new HeadlessJob(battle, { players: payload.players });
      let sent = 0, lastProgress = performance.now();
      while (!job.run(4)) {
        if (cancelled()) throw new Error('cancelled');
        if (payload.progress && performance.now() - lastProgress >= 100) {
          parentPort.postMessage({ id, progress: { reset: sent === 0, samples: job.timeline.slice(sent) } });
          sent = job.timeline.length;
          lastProgress = performance.now();
        }
      }
      const out = job.output();
      value = { result: out.result, timeline: out.timeline, time: out.battle.time, errors: out.battle.errors,
        crashed: out.crashed };
    } else if (type === 'rehearsal') {
      // BattleSpecs remove live boss pools and construct candidates lazily, like local/adaptive rehearsals.
      const factories = payload.specs.map((spec) => () => createBattleFromSpec(spec, ds, { logger: quiet }));
      const run = new RehearsalRun(factories, payload.playerId, payload.cap, payload.limits || {});
      while (!run.run(cancelled)) if (cancelled()) throw new Error('cancelled');
      value = { bestIndex: run.score.index, stats: { totalTicks: run.totalTicks, completed: run.completed,
        considered: run.index, stopReason: run.stopReason, choice: run.score.index, candidates: factories.length } };
    } else if (type === 'botplan') {
      // Bot placement planning (SP_BOT_PLAN_POOL): the batch is one seat's consecutive planLayout calls over
      // snapshotted inputs, captured atomically before any of them ran — every task carries the same entry state
      // and the calls share one mulberry32 stream, each continuing where the previous stopped (exactly the draw
      // sequence the inline path produces). The plans and the final stream state come back byte-identical to the
      // main thread's own run (botPlanTask.applyPlanTask runs the real planLayoutSteps over a rebuilt fake m/ps).
      // A mixed entry state or an unknown record fails the task loudly — the consumer falls back inline, never to
      // a wrong plan.
      const tasks = payload.tasks;
      if (!Array.isArray(tasks) || !tasks.length) throw new Error('botplan: empty batch');
      const entry = tasks[0].rngState;
      const rng = createRngFromState(entry);
      const results = [];
      for (const c of tasks) {
        if (cancelled()) throw new Error('cancelled');
        if (c.rngState !== entry) throw new Error(`botplan: batch entry states differ at task ${c.seq}`);
        const r = applyPlanTask(planGameData, c, rng);
        results.push({ seq: c.seq, plan: r.plan, rngState: r.rngState });
      }
      value = { results, rngState: rng.state() };
    } else throw new Error(`unknown simulation task: ${type}`);
    parentPort.postMessage({ id, value, memory: memorySample() });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message, memory: memorySample() });
  }
});
