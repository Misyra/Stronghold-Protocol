// poc/vanhost/bench.mjs — PoC 台架：同一批真实 bot/联防场 spec（collect-specs.mjs 采集），三种形态对比。
//   1) 主线程逐场（现状 HeadlessJob/runToEnd 的等价路径）；
//   2) 池任务逐场（server/workers/simulation.js 的 'battle' 任务，真池真 worker）；
//   3) 开战风暴：N 场并发的 8ms 切片链（复刻 clientCombat._runOnServer 的主线程步进形态）vs 全量提交池。
// 度量：确定性（resultDigest 逐字节一致）、单场 CPU/墙钟、序列化字节、主线程 ELU（performance.eventLoopUtilization）
// 与 10ms 心跳最大漂移。独立目录，不接生产路径。
//
// 用法：node poc/vanhost/bench.mjs [--specimens poc/vanhost/specimens.json] [--workers 4] [--storm 200] [--json -]
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource } from '../../server/sim/simdata.js';
import { createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
import { runHeadless, HeadlessJob } from '../../server/match/fields.js';
import { SimulationPool } from '../../server/workers/pool.js';
import { getData, simWorkerData } from '../../server/data.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const specimenFile = opt('specimens', path.join(here, 'specimens.json'));
const WORKERS = Number(opt('workers', 4));
const STORM_N = Number(opt('storm', 200));
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

const specimens = JSON.parse(readFileSync(specimenFile, 'utf8'));
const data = getData({ log: quietLog });
const ds = new DataSource(data, null);

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
// Node 26 的 performance.eventLoopUtilization() 对同步忙段不再计数（实测 0）——本地台架口径改为
// 心跳漂移（10ms 心跳的逐次延迟：p50/p95/max = 最长主线程阻塞）+ 全进程 CPU%（process.cpuUsage 含所有线程）。
const cpuPct = (a, b, wallMs) => { const d = (b.user + b.system) - (a.user + a.system); return (d / 1000 / wallMs) * 100; };
const cpu = () => process.cpuUsage();
const rss = () => (process.memoryUsage().rss / 1048576).toFixed(0);

// ---- 1) 主线程逐场（每场等价于 _specBattle + runToEnd，即现状接管的同步形态）----------------------------
const mainRuns = [];
{
  let t0 = performance.now();
  for (const s of specimens) {
    const spec = JSON.parse(JSON.stringify(s.spec));
    const b0 = performance.now();
    let res = null, crashed = false;
    try {
      const battle = createBattleFromSpec(spec, ds, { recordEvents: false, quiet: true });
      res = runHeadless(battle, { players: s.players }).result;
    } catch { crashed = true; }
    const ms = performance.now() - b0;
    mainRuns.push({ id: s.battleId, kind: s.kind, round: s.round, difficulty: s.difficulty, ms, digest: res ? resultDigest(res).hash : null, bytes: res ? JSON.stringify(res).length : 0, crashed });
  }
  const wallMs = performance.now() - t0;
  const ok = mainRuns.filter((r) => r.digest);
  console.log(`[main] ${mainRuns.length} battles: wall=${(wallMs / 1000).toFixed(2)}s mean=${(mainRuns.reduce((n, r) => n + r.ms, 0) / mainRuns.length).toFixed(1)}ms p50=${pct(mainRuns.map((r) => r.ms), 50).toFixed(1)}ms p95=${pct(mainRuns.map((r) => r.ms), 95).toFixed(1)}ms max=${Math.max(...mainRuns.map((r) => r.ms)).toFixed(1)}ms crashed=${mainRuns.filter((r) => r.crashed).length}`);
  console.log(`[main] by-round mean ms: ${[1, 2, 3, 4, 5, 6, 7, 8].map((r) => { const a = mainRuns.filter((x) => x.round === r); return a.length ? `R${r}=${(a.reduce((n, x) => n + x.ms, 0) / a.length).toFixed(0)}` : null; }).filter(Boolean).join(' ')}`);
}

// ---- 2) 池任务逐场（真池真 worker；'battle' 任务契约）----------------------------------------------------
const poolRuns = [];
{
  const pool = new SimulationPool({ data: simWorkerData(data), size: WORKERS, maxQueue: 4096, timeoutMs: 300000 });
  const pass = async () => {
    const handles = specimens.map((s) => ({ s, h: pool.submit('battle', { spec: JSON.parse(JSON.stringify(s.spec)), players: s.players }) }));
    const out = [];
    for (const { s, h } of handles) {
      const b0 = performance.now();
      try {
        const o = await h.promise;
        out.push({ id: s.battleId, wallMs: performance.now() - b0, digest: o.result ? resultDigest(o.result).hash : null, crashed: !!o.crashed });
      } catch (e) {
        out.push({ id: s.battleId, wallMs: performance.now() - b0, digest: null, crashed: true, error: String(e?.message || e) });
      }
    }
    return out;
  };
  await pass(); // 冷 JIT/首启丢弃
  const c0 = cpu();
  const t0 = performance.now();
  poolRuns.push(...await pass());
  const wallMs = performance.now() - t0;
  const c1 = cpu();
  const stats = pool.stats();
  await pool.close();
  const mism = poolRuns.filter((r, i) => r.digest !== mainRuns[i].digest);
  console.log(`[pool x${WORKERS}] ${poolRuns.length} tasks (warm 2nd pass): wall=${(wallMs / 1000).toFixed(2)}s meanWall=${(poolRuns.reduce((n, r) => n + r.wallMs, 0) / poolRuns.length).toFixed(1)}ms computeMs/task=${stats.avgComputeMs.toFixed(1)} queuedMax=${stats.queued} procCpu(main)=${cpuPct(c0, c1, wallMs).toFixed(1)}%`);
  console.log(`[pool] determinism: ${mism.length === 0 ? 'ALL DIGESTS IDENTICAL' : `${mism.length} MISMATCH: ${mism.slice(0, 3).map((r) => r.id).join(', ')}`}`);
  const specBytes = specimens.reduce((n, s) => n + JSON.stringify(s.spec).length, 0) / specimens.length;
  const resBytes = mainRuns.reduce((n, r) => n + r.bytes, 0) / mainRuns.length;
  console.log(`[io] mean spec=${(specBytes / 1024).toFixed(1)}KB out, mean result=${(resBytes / 1024).toFixed(1)}KB back`);
}

// ---- 3) 开战风暴：STORM_N 场并发。A=主线程 8ms 切片链（_runOnServer 形态）；B=全量提交池。----------------
function pickStorm(n) {
  // 生产风暴=各房开战时刻的 bot 场；取 R≥2 的场（R1 场小，不构成墙），循环补齐到 n
  const late = mainRuns.map((r, i) => ({ r, i })).filter(({ r }) => r.round >= 2 && r.digest && !r.crashed);
  const out = [];
  for (let k = 0; out.length < n && late.length; k++) out.push(late[k % late.length].i);
  return out.slice(0, n);
}
const stormIdx = pickStorm(STORM_N);

// A: 主线程切片链。每场一个 HeadlessJob，run(8) 未完 → setTimeout(0) 续，与 _runOnServer 的 later(0) 链同构。
function sampler() {
  const gaps = [];
  let prev = performance.now();
  const hb = setInterval(() => { const now = performance.now(); gaps.push(now - prev); prev = now; }, 10);
  hb.unref?.();
  return { stop: () => clearInterval(hb), gaps };
}
const jitterStats = (gaps) => {
  const over = gaps.map((g) => Math.max(0, g - 10));
  return { p50: pct(over, 50), p95: pct(over, 95), max: over.length ? Math.max(...over) : 0 };
};

function stormMainJobs() {
  return stormIdx.map((i) => {
    const spec = JSON.parse(JSON.stringify(specimens[i].spec));
    const battle = createBattleFromSpec(spec, ds, { recordEvents: false, quiet: true });
    return { id: specimens[i].battleId, job: new HeadlessJob(battle, { players: specimens[i].players }), digest: null };
  });
}
async function stormMain() {
  const jobs = stormMainJobs();
  const s = sampler();
  const c0 = cpu();
  const rss0 = rss();
  const t0 = performance.now();
  let pending = jobs.length;
  const done = new Promise((yes) => {
    const step = (j) => {
      if (j.job.run(8)) {
        j.digest = resultDigest(j.job.output().result).hash;
        if (--pending === 0) yes();
        return;
      }
      setTimeout(() => step(j), 0);
    };
    for (const j of jobs) step(j);
  });
  await done;
  s.stop();
  const wallMs = performance.now() - t0;
  const c1 = cpu();
  return { wallMs, procCpuPct: cpuPct(c0, c1, wallMs), jitter: jitterStats(s.gaps), rss0, rss1: rss(), jobs };
}

async function stormPool({ warm = false } = {}) {
  const pool = new SimulationPool({ data: simWorkerData(data), size: WORKERS, maxQueue: 4096, timeoutMs: 300000 });
  const run = async () => {
    const handles = stormIdx.map((i) => pool.submit('battle', { spec: JSON.parse(JSON.stringify(specimens[i].spec)), players: specimens[i].players }));
    return Promise.all(handles.map((h) => h.promise.then((o) => (o.result ? resultDigest(o.result).hash : null), () => null)));
  };
  if (warm) await run(); // 冷 JIT/首启丢弃
  const s = sampler();
  const c0 = cpu();
  const t0 = performance.now();
  const digests = await run();
  s.stop();
  const wallMs = performance.now() - t0;
  const c1 = cpu();
  const stats = pool.stats();
  const workerMem = stats.memory.map((m) => m.sample?.rssMb).filter(Number.isFinite);
  await pool.close();
  return { wallMs, procCpuPct: cpuPct(c0, c1, wallMs), jitter: jitterStats(s.gaps), digests, computeMs: stats.computeMs, workerMem };
}

{
  await stormMain(); // 预热：JIT/分配器不进测量窗
  const A = await stormMain();
  const B = await stormPool({ warm: true });
  const stormMainOk = A.jobs.filter((j) => j.digest).length;
  const mism = B.digests.filter((d, i) => d !== A.jobs[i].digest).length;
  const fmt = (j) => `p50=${j.p50.toFixed(1)}/p95=${j.p95.toFixed(1)}/max=${j.max.toFixed(1)}ms`;
  console.log(`[storm A/main] n=${A.jobs.length} (R≥2): wall=${(A.wallMs / 1000).toFixed(2)}s procCpu=${A.procCpuPct.toFixed(0)}% (全在主线程) drift ${fmt(A.jitter)} digests=${stormMainOk}/${A.jobs.length}`);
  console.log(`[storm B/pool x${WORKERS}] n=${B.digests.length}: wall=${(B.wallMs / 1000).toFixed(2)}s procCpu=${B.procCpuPct.toFixed(0)}% (worker 侧为主) drift ${fmt(B.jitter)} computeSum=${(B.computeMs / 1000).toFixed(2)}s workerRss=[${B.workerMem.join(', ')}]MB`);
  console.log(`[storm] determinism=${mism === 0 ? 'IDENTICAL' : `${mism} MISMATCH`}; main-thread burst: drift max ${A.jitter.max.toFixed(0)}ms -> ${B.jitter.max.toFixed(0)}ms; wall ${A.wallMs.toFixed(0)}ms -> ${B.wallMs.toFixed(0)}ms`);
}

// ---- 4) 生产外推：主线程每场 CPU × 生产参数 → 占一核的百分比（参数化，不假装知道房内 bot 数）--------------
{
  const byRound = new Map();
  for (const r of mainRuns) if (r.digest && !r.crashed) byRound.set(r.round, (byRound.get(r.round) || []).concat(r.ms));
  const roundMean = (r) => { const a = byRound.get(r) || []; return a.reduce((n, x) => n + x, 0) / (a.length || 1); };
  const meanBattle = mainRuns.filter((r) => r.digest && !r.crashed).reduce((n, r) => n + r.ms, 0) / mainRuns.filter((r) => r.digest && !r.crashed).length;
  console.log(`[extrapolation] per-battle main-thread CPU: R1=${roundMean(1).toFixed(0)}ms R2=${roundMean(2).toFixed(0)}ms R4=${roundMean(4).toFixed(0)}ms R6=${roundMean(6).toFixed(0)}ms R8=${roundMean(8).toFixed(0)}ms all-mean=${meanBattle.toFixed(0)}ms`);
  console.log(`[extrapolation] main-thread ELU share = rooms × bots/room × meanMs / cycle/1000:`);
  for (const rooms of [100, 190]) for (const bots of [1, 2, 3]) for (const cycle of [90, 150]) {
    const share = (rooms * bots * meanBattle / 1000 / cycle) * 100;
    console.log(`  rooms=${rooms} bots/room=${bots} cycle=${cycle}s -> ${(share).toFixed(1)}% of one core`);
  }
}
