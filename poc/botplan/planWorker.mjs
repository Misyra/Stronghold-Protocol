// poc/botplan/planWorker.mjs — PoC worker 入口：实现 'botplan' 任务（SimulationPool 的 workerUrl 可替换）。
// 与 server/workers/simulation.js 同样的数据装载（SIM_DATA_KEYS → setData），再构造真 GameData，
// 对每个任务用「假 m / 假 ps + 真 planLayoutSteps」复现主线程的布防规划（复建层见 replay.mjs）：
//   payload: { tasks: [taskSnapshot...] }  （一个席位一段 rng 链上的 planLayout 调用，顺序执行）
//   value:   { results: [{ seq, plan, rngState, ms }...] }
// plan = [[uid, key, dir]...]（uid 升序）；rngState = 该任务结束后 mulberry32 的 uint32 状态。
import { parentPort, workerData } from 'node:worker_threads';
import { SIM_DATA_KEYS, setData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';
import { runSegment } from './replay.mjs';

const data = workerData && workerData.data;
const missing = SIM_DATA_KEYS.filter((k) => !data || typeof data !== 'object' || !Object.hasOwn(data, k));
if (missing.length) throw new Error(`plan worker: data is missing ${missing.map((k) => `${k}.json`).join(', ')}`);
setData(data);
const gd = new GameData(data, 'act2autochess'); // 只用 chess/token/baseIdOf——mode 子集缺失仅影响 mode 级全局，规划不用

parentPort.on('message', ({ id, type, payload }) => {
  try {
    if (type !== 'botplan') throw new Error(`unknown plan task: ${type}`);
    const results = runSegment(gd, payload.tasks);
    parentPort.postMessage({ id, value: { results } });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
