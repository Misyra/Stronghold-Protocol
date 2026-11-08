// poc/botplan/bench.mjs — PoC 台架：同一批真实布防规划快照（collect.mjs 采集），主线程 vs 池三种形态对比。
//   0) 保真：主线程复建（假 m/假 ps + 真 planLayoutSteps）vs 采集时真实结果 —— plan 与 rng 末态逐字节核对；
//      再池复建 vs 主线程复建 —— 同口径核对。任何缺口响亮失败。
//   1) 成本表：单次调用/单席位任务的耗时分布（按回合段），规划占整局主线程份额（采集口径）。
//   2) 波次漂移：一个 (局, 回合) 的全部 bot 席位同时规划（生产「规划波次」形态）：
//      A 主线程一次性串跑（尾部上界） / B 主线程 8ms 切片链（生产 scheduleBotPrep 形态） / C 全量提交池。
//      度量 5ms 心跳逐次延迟（p50/p95/max = 最长主线程阻塞）+ 波次墙钟。偶数波 A→B→C、奇数波 C→B→A 交替抵消顺序偏差。
//   3) 600 房参考（容量外推，不计入判定闸）：600 房 × 4 席的开战规划波次——主线程串跑 vs 池排空的漂移与墙钟。
// Node 26 的 eventLoopUtilization() 对同步忙段计 0 —— 口径用 5ms 心跳漂移 + process.cpuUsage。
//
// 用法：node poc/botplan/bench.mjs [--specimens poc/botplan/specimens.json] [--workers 4] [--rooms 600]
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulationPool } from '../../server/workers/pool.js';
import { getData, simWorkerData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';
import { runSegment, runTask, startTaskGen } from './replay.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const specimenFile = opt('specimens', path.join(here, 'specimens.json'));
const WORKERS = Number(opt('workers', 4));
const ROOMS = Number(opt('rooms', 600));
const SLICE_MS = 8; // 生产 botSliceMs 默认（真调度器）
const HEARTBEAT_MS = 5;

const specimens = JSON.parse(readFileSync(specimenFile, 'utf8'));
const data = getData({ log: { info() {}, warn() {}, error() {}, debug() {} } });
const gd = new GameData(simWorkerData(data), 'act2autochess');

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

// ---- 心跳漂移 ----------------------------------------------------------------------------------
let beats = [];
let hbTimer = null;
function hbStart() { beats = []; let last = performance.now(); hbTimer = setInterval(() => { const now = performance.now(); beats.push(now - last); last = now; }, HEARTBEAT_MS); }
function hbStop() { clearInterval(hbTimer); hbTimer = null; return { beats: beats.length, p50: pct(beats, 50), p95: pct(beats, 95), max: Math.max(0, ...beats) }; }
const cpu = () => process.cpuUsage();
const cpuPct = (a, b, wallMs) => { const d = (b.user + b.system) - (a.user + a.system); return (d / 1000 / wallMs) * 100; };

// ---- 波次分组：cfg+round → 席位 → rng 链段 ------------------------------------------------------
const seatCalls = new Map(); // cfg|round|seat → tasks[]
for (const t of specimens) {
  const wk = `${t.cfg.seed}|${t.cfg.bots}|${t.cfg.hosted ? 'h' : 'b'}|${t.cfg.difficulty}`;
  const sk = `${wk}|${t.round}|${t.seat}`;
  if (!seatCalls.has(sk)) seatCalls.set(sk, []);
  seatCalls.get(sk).push(t);
}
const waves = new Map();
for (const [sk, tasks] of seatCalls) {
  const parts = sk.split('|');
  const wk = parts.slice(0, 4).join('|'), round = Number(parts[4]), seat = parts[5];
  tasks.sort((a, b) => a.seq - b.seq);
  const wkFull = `${wk}|${round}`;
  if (!waves.has(wkFull)) waves.set(wkFull, { key: wkFull, cfg: tasks[0].cfg, round, seats: new Map() });
  const w = waves.get(wkFull);
  // rng 链断点切段（同席位相邻调用 entry != prev end ⇒ 中间有别的 rngBots 抽取）
  const segments = [];
  for (const t of tasks) {
    if (!segments.length) { segments.push([t]); continue; }
    const seg = segments[segments.length - 1];
    if (t.rngState === seg[seg.length - 1].rngEnd) seg.push(t);
    else segments.push([t]);
  }
  if (!w.seats.has(seat)) w.seats.set(seat, []);
  w.seats.get(seat).push(...segments);
}
const waveList = [...waves.values()];
const segmentCount = waveList.reduce((n, w) => n + [...w.seats.values()].reduce((n2, segs) => n2 + segs.length, 0), 0);
console.log(`[waves] ${waveList.length} waves, ${seatCalls.size} seat-preps, ${specimens.length} planLayout calls, ${segmentCount} rng-chained segments (段=池化任务的自然边界)`);

function planTask(t) {
  const { seq, round, stageId, waveFlag, waveTid, bossTid, bossSide, bodyUsed, key, model, map, pieces, bodies, occupied, params, placements, rngState } = t;
  return JSON.parse(JSON.stringify({ seq, round, stageId, waveFlag, waveTid, bossTid, bossSide, bodyUsed, key, model, map, pieces, bodies, occupied, params, placements, rngState }));
}

// ---- 0) 保真：主线程复建 vs 采集真实 -------------------------------------------------------------
{
  let mismPlan = 0, mismRng = 0, firstBad = null;
  const t0 = performance.now();
  for (const t of specimens) {
    const r = runTask(gd, t);
    const planOk = JSON.stringify(r.plan) === JSON.stringify(t.real);
    const rngOk = r.rngState === t.rngEnd;
    if (!planOk || !rngOk) {
      mismPlan += planOk ? 0 : 1; mismRng += rngOk ? 0 : 1;
      if (!firstBad) firstBad = { seq: t.seq, planOk, rngOk, real: t.real, got: r.plan };
    }
  }
  const wall = performance.now() - t0;
  console.log(`[fidelity] main-replay vs real: ${specimens.length} calls in ${(wall / 1000).toFixed(2)}s, plan mismatch=${mismPlan}, rng mismatch=${mismRng}${firstBad ? ` FIRST-BAD=${JSON.stringify(firstBad).slice(0, 500)}` : ' — 全部逐字节一致'}`);
}

const pool = new SimulationPool({ data: simWorkerData(data), size: WORKERS, maxQueue: 4096, timeoutMs: 600000,
  workerUrl: new URL('./planWorker.mjs', import.meta.url) });

// ---- 0b) 保真：池复建 vs 主线程复建（全部席位段）-------------------------------------------------
{
  // 预热：首轮测量不含 worker 冷启动（spawn + 数据克隆的一次性 ~50ms 主线程 hitch）
  try { await pool.submit('botplan', { tasks: [specimens[0]].map((t) => planTask(t)) }).promise; } catch { /* 预热失败交给正式段暴露 */ }
  hbStart();
  const handles = [];
  for (const w of waveList) for (const [, segs] of w.seats) for (const seg of segs) {
    handles.push({ seg, h: pool.submit('botplan', { tasks: seg.map((t) => planTask(t)) }) });
  }
  const t0 = performance.now();
  let poolPlanMismatch = 0, poolRngMismatch = 0, poolFail = 0, firstPoolBad = null;
  for (const { seg, h } of handles) {
    let value = null, err = null;
    try { value = await h.promise; } catch (e) { err = e; }
    if (err || !value || !value.results) { poolFail++; if (!firstPoolBad) firstPoolBad = { seq: seg[0].seq, error: String(err && err.message || 'no value') }; continue; }
    const main = seg.map((t) => runTask(gd, t));
    for (let i = 0; i < seg.length; i++) {
      const planOk = JSON.stringify(value.results[i].plan) === JSON.stringify(main[i].plan);
      const rngOk = value.results[i].rngState === main[i].rngState;
      if (!planOk || !rngOk) {
        poolPlanMismatch += planOk ? 0 : 1; poolRngMismatch += rngOk ? 0 : 1;
        if (!firstPoolBad) firstPoolBad = { seq: seg[i].seq, planOk, rngOk };
      }
    }
  }
  const hb = hbStop();
  const wall = performance.now() - t0;
  console.log(`[fidelity] pool-replay vs main-replay: ${handles.length} segments, plan mismatch=${poolPlanMismatch}, rng mismatch=${poolRngMismatch}, failed=${poolFail}${firstPoolBad ? ` FIRST-BAD=${JSON.stringify(firstPoolBad).slice(0, 500)}` : ' — 全部逐字节一致'}`);
  console.log(`[fidelity] drain wall=${(wall / 1000).toFixed(2)}s, heartbeat p50=${hb.p50.toFixed(1)}ms p95=${hb.p95.toFixed(1)}ms max=${hb.max.toFixed(1)}ms`);
}

// ---- 1) 成本表 ----------------------------------------------------------------------------------
{
  const byBucket = new Map();
  for (const t of specimens) {
    const r = t.round <= 3 ? 'R1-3' : t.round <= 6 ? 'R4-6' : t.round <= 8 ? 'R7-8' : 'R9+';
    if (!byBucket.has(r)) byBucket.set(r, []);
    byBucket.get(r).push(t.ms);
  }
  console.log('[cost] per-call main-thread ms by round bucket:');
  for (const [r, arr] of [...byBucket].sort()) {
    console.log(`  ${r}: n=${arr.length} mean=${(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2)} p95=${pct(arr, 95).toFixed(2)} max=${Math.max(...arr).toFixed(1)}`);
  }
  const seatMs = [...seatCalls.values()].map((tasks) => tasks.reduce((s, t) => s + t.ms, 0));
  console.log(`[cost] per-seat-prep (该席位本回合全部 planLayout 求和): n=${seatMs.length} mean=${(seatMs.reduce((s, x) => s + x, 0) / seatMs.length).toFixed(2)}ms p95=${pct(seatMs, 95).toFixed(2)}ms max=${Math.max(...seatMs).toFixed(1)}ms`);
  const totalPlan = specimens.reduce((s, t) => s + t.ms, 0);
  console.log(`[cost] plan main-thread total (采集口径, 虚拟时间整局): ${totalPlan.toFixed(0)}ms / ${specimens.length} calls`);
}

// ---- 2) 波次漂移 A/B/C ---------------------------------------------------------------------------
{
  const rows = [];
  let idx = 0;
  const heavy = waveList.filter((w) => w.seats.size >= 2);
  // 合成波：8/16 席同波形态压力——把同难度同回合的多个真实 coop4 波的席位段拼成一波
  //（席位相互独立、rng 链按席位切分，拼接不改变每席的规划内容）。
  const byDiffRound = new Map();
  for (const w of heavy) {
    if (w.cfg.hosted) continue;
    const k = `${w.cfg.difficulty}|${w.round}`;
    if (!byDiffRound.has(k)) byDiffRound.set(k, []);
    byDiffRound.get(k).push(w);
  }
  const synth = [];
  for (const n of [8, 16]) {
    for (const [k, ws] of byDiffRound) {
      if (ws.reduce((s, w) => s + w.seats.size, 0) < n) continue;
      const seats = new Map();
      for (const w of ws) for (const [seat, segs] of w.seats) {
        if (seats.size >= n) break;
        seats.set(`${w.key}:${seat}`, segs);
      }
      if (seats.size >= n) { synth.push({ key: `SYNTH${n}@${k}`, cfg: { difficulty: ws[0].cfg.difficulty }, round: ws[0].round, seats }); break; }
    }
  }
  for (const w of [...heavy, ...synth]) {
    const seats = [...w.seats.entries()];
    const order = idx++ % 2 === 0 ? ['A', 'B', 'C'] : ['C', 'B', 'A'];
    const row = { wave: w.key, seats: seats.length, round: w.round, diff: w.cfg.difficulty, synth: w.key.startsWith('SYNTH'), late: w.cfg.late };
    for (const which of order) {
      row[which] = which === 'A' ? runWaveBurst(w, seats) : which === 'B' ? await runWaveSliced(w, seats) : await runWavePool(pool, w, seats);
    }
    rows.push(row);
  }
  console.log('[drift] wave | seats | A=burst p95/max | B=sliced p95/max | C=pool p95/max | wall A/B/C ms | bytes/seat C');
  for (const r of rows) {
    const bytesC = r.C.bytes && r.seats ? Math.round(r.C.bytes / r.seats) : 0;
    console.log(`  ${r.wave} seats=${r.seats} R${r.round} ${r.diff}${r.synth ? ' SYNTH' : ''}${r.late ? ' LATE' : ''} | ${r.A.hb.p95.toFixed(1)}/${r.A.hb.max.toFixed(1)} | ${r.B.hb.p95.toFixed(1)}/${r.B.hb.max.toFixed(1)} | ${r.C.hb.p95.toFixed(1)}/${r.C.hb.max.toFixed(1)} | ${r.A.wall.toFixed(0)}/${r.B.wall.toFixed(0)}/${r.C.wall.toFixed(0)} | ${bytesC / 1024 | 0}KB`);
  }
  for (const k of ['A', 'B', 'C']) {
    const p95s = rows.map((r) => r[k].hb.p95), maxs = rows.map((r) => r[k].hb.max), walls = rows.map((r) => r[k].wall);
    console.log(`[drift] ${k === 'A' ? 'A burst ' : k === 'B' ? 'B sliced' : 'C pool  '} (${rows.length} waves): heartbeat p95 med=${pct(p95s, 50).toFixed(1)} max=${Math.max(...maxs).toFixed(1)}ms; wall med=${pct(walls, 50).toFixed(1)}ms max=${Math.max(...walls).toFixed(0)}ms`);
  }
}

function runWaveBurst(w, seats) {
  hbStart();
  const t0 = performance.now();
  for (const [, segs] of seats) for (const seg of segs) runSegment(gd, seg);
  const wall = performance.now() - t0;
  const hb = hbStop();
  return { hb, wall };
}

/** 生产 scheduleBotPrep 形态：每席位一条 setTimeout(0) 切片链，每片 ≤ SLICE_MS 墙钟，生成体逐片推进。 */
async function runWaveSliced(w, seats) {
  hbStart();
  const t0 = performance.now();
  await Promise.all(seats.map(([, segs]) => driveSliced(segs.flat())));
  const wall = performance.now() - t0;
  const hb = hbStop();
  return { hb, wall };
}

function driveSliced(tasks) {
  return new Promise((done) => {
    let i = 0, ctx = null, t0 = 0;
    const step = () => {
      t0 = performance.now();
      while (performance.now() - t0 < SLICE_MS) {
        if (!ctx) {
          if (i >= tasks.length) { done(); return; }
          ctx = startTaskGen(gd, tasks[i]);
        }
        const r = ctx.gen.next();
        if (r.done) ctx = null, i++;
      }
      setTimeout(step, 0);
    };
    step();
  });
}

async function runWavePool(pool2, w, seats) {
  const handles = [];
  let bytes = 0;
  hbStart();
  const t0 = performance.now();
  for (const [, segs] of seats) for (const seg of segs) {
    const payload = { tasks: seg.map((t) => planTask(t)) };
    bytes += JSON.stringify(payload).length;
    handles.push(pool2.submit('botplan', payload));
  }
  await Promise.all(handles.map((h) => h.promise));
  const wall = performance.now() - t0;
  const hb = hbStop();
  return { hb, wall, bytes };
}

// ---- 3) 600 房参考（容量外推，不计入判定闸）--------------------------------------------------------
{
  console.log(`[rooms] 参考（不计闸）: ${ROOMS} 房 × 4 席 = ${ROOMS * 4} 席位段同时规划（生产 SP_WORKERS=${WORKERS}）`);
  const pool2 = new SimulationPool({ data: simWorkerData(data), size: WORKERS, maxQueue: 10000, timeoutMs: 600000,
    workerUrl: new URL('./planWorker.mjs', import.meta.url) });
  try { await pool2.submit('botplan', { tasks: [specimens[0]].map((t) => planTask(t)) }).promise; } catch { /* 预热失败交给正式段暴露 */ }
  const src = waveList.filter((w) => w.seats.size >= 4).sort((a, b) => (b.round - a.round) || b.seats.size - a.seats.size);
  const seatSegs = [];
  for (let k = 0; seatSegs.length < ROOMS * 4; k++) {
    const w = src[k % src.length];
    for (const [, ss] of w.seats) seatSegs.push(ss);
  }
  seatSegs.length = Math.min(seatSegs.length, ROOMS * 4);
  // A: 主线程串跑（该形态下的主线程占用上界）
  hbStart();
  const cA0 = cpu();
  const tA = performance.now();
  for (const ss of seatSegs) for (const seg of ss) runSegment(gd, seg);
  const wallA = performance.now() - tA;
  const cA1 = cpu();
  const hbA = hbStop();
  // C: 全量提交池、主线程只做提交/等待/解码
  hbStart();
  const cC0 = cpu();
  const tC = performance.now();
  const hs = seatSegs.map((ss) => ss.map((seg) => pool2.submit('botplan', { tasks: seg.map((t) => planTask(t)) })));
  await Promise.all(hs.flat().map((h) => h.promise));
  const wallC = performance.now() - tC;
  const cC1 = cpu();
  const hbC = hbStop();
  const st = pool2.stats();
  await pool2.close();
  console.log(`[rooms] main-burst: wall=${(wallA / 1000).toFixed(2)}s cpu=${cpuPct(cA0, cA1, wallA).toFixed(0)}% heartbeat p95=${hbA.p95.toFixed(1)}ms max=${hbA.max.toFixed(1)}ms`);
  console.log(`[rooms] pool x${WORKERS}: wall=${(wallC / 1000).toFixed(2)}s cpu(main proc)=${cpuPct(cC0, cC1, wallC).toFixed(0)}% heartbeat p95=${hbC.p95.toFixed(1)}ms max=${hbC.max.toFixed(1)}ms avgCompute=${st.avgComputeMs.toFixed(1)}ms`);
  console.log(`[rooms] 加速比≈${(wallA / wallC).toFixed(1)}×；池化形态下主线程只剩提交/解码/等待（心跳 p95 即其阻塞上界的读数）`);
}

await pool.close();
console.log('[bench] done');
