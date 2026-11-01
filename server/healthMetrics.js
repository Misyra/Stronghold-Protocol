// server/healthMetrics.js — 只读的 /healthz 性能缓存(移植自 Stardust fork 的 server/healthMetrics.js)。
// 每个监听服务器一个采样器;不与 Worker 通信、不查询对局进程:主线程自己的 CPU / ELU / 内存 / 事件循环延迟,
// 每 10 s 采一次(monitorEventLoopDelay,20 ms 分辨率),/healthz 读到的是缓存的摘要而不是每次现算。
// 可选的 phase 记录器(server/phaseMetrics.js,createPhaseMetrics)在每次采样时轮转出 `phases` 块。
// B 的接线差异:performance 块只随 ?traffic=1 给回环/私网客户端(routes.js),不进公开的 /healthz。
// 另见 server/health/eventLoop.js(SP_LOOP_SAMPLE=1 的本地日志采样器,刻意不进 /healthz)。
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const SAMPLE_MS = 10_000;
const RESOLUTION_MS = 20;
const nonnegative = (n) => Number.isFinite(n) && n >= 0 ? n : null;
const delta = (current, previous) => nonnegative(current) !== null && nonnegative(previous) !== null
  ? nonnegative(current - previous) : null;

function emptySnapshot(status) {
  return {
    status, sampledAt: null, windowMs: null,
    mainThread: {
      eventLoopDelayMs: { p50: null, p95: null, p99: null, max: null },
      eventLoopUtilization: null,
      memory: { heapUsedBytes: null, heapTotalBytes: null, externalBytes: null, arrayBuffersBytes: null },
    },
    process: { cpu: { userMs: null, systemMs: null, totalMs: null, percent: null }, rssBytes: null },
  };
}

export const PERFORMANCE_UNAVAILABLE = emptySnapshot('unavailable');

/** 主线程压力提示(缓存的 10 s 窗口),不是整机 CPU,也不代表 Worker 容量。 */
export function serverLoadState(snapshot, now = Date.now()) {
  const elu = snapshot?.mainThread?.eventLoopUtilization;
  const p95 = snapshot?.mainThread?.eventLoopDelayMs?.p95;
  const at = snapshot?.sampledAt;
  if (snapshot?.status !== 'ready' || !Number.isFinite(snapshot.windowMs) || snapshot.windowMs <= 0
      || !Number.isFinite(at) || !Number.isFinite(now) || now < at || now - at > SAMPLE_MS * 3
      || !Number.isFinite(elu) || elu < 0 || elu > 1 || !Number.isFinite(p95) || p95 < 0) return 'unknown';
  if (p95 >= 100 || (elu >= .95 && p95 >= 50)) return 'overloaded';
  if (elu >= .85 || p95 >= 40) return 'busy';
  return 'normal';
}

/** 可注入的内建读数与定时器,窗口与生命周期的测试因此确定性的。 */
export function createHealthMetrics({
  log = console,
  now = () => performance.now(), wallNow = () => Date.now(),
  cpuUsage = () => process.cpuUsage(), memoryUsage = () => process.memoryUsage(),
  eventLoopUtilization = () => performance.eventLoopUtilization(),
  createHistogram = monitorEventLoopDelay,
  setInterval: schedule = globalThis.setInterval, clearInterval: unschedule = globalThis.clearInterval,
  phases = null,
} = {}) {
  // 没有记录器时快照保持原形(没有 `phases` 键)。
  const withPhases = (snapshot) => (phases ? { ...snapshot, phases: null } : snapshot);
  let cached = withPhases(emptySnapshot('warming'));
  let histogram = null, timer = null, baseline = null;
  let started = false, disposed = false, warned = false;

  function warn(error) {
    if (warned) return;
    warned = true;
    // 坏掉的诊断读数/日志绝不能妨碍游戏继续服务或关停。
    try { log.warn?.(`[health] performance metrics unavailable: ${error.message}`); } catch { /* diagnostic only */ }
  }

  function stopResources() {
    if (timer !== null) {
      const old = timer; timer = null;
      try { unschedule(old); } catch (e) { warn(e); }
    }
    if (histogram !== null) {
      const old = histogram; histogram = null;
      try { old.disable(); } catch (e) { warn(e); }
    }
  }

  function unavailable(error) {
    stopResources();
    cached = withPhases(emptySnapshot('unavailable'));
    warn(error);
  }

  function sample() {
    if (disposed || !histogram) return;
    try {
      const current = { at: now(), cpu: cpuUsage(), elu: eventLoopUtilization() };
      const elapsed = delta(current.at, baseline.at);
      const windowMs = elapsed > 0 ? elapsed : null;
      const next = withPhases(emptySnapshot(windowMs === null ? 'warming' : 'ready'));
      if (windowMs !== null) {
        const memory = memoryUsage();
        next.sampledAt = nonnegative(wallNow()); // Unix epoch ms,独立于单调时钟的窗口。
        next.windowMs = windowMs;
        next.process.rssBytes = nonnegative(memory.rss);
        next.mainThread.memory = {
          heapUsedBytes: nonnegative(memory.heapUsed), heapTotalBytes: nonnegative(memory.heapTotal),
          externalBytes: nonnegative(memory.external), arrayBuffersBytes: nonnegative(memory.arrayBuffers),
        };
        const user = delta(current.cpu.user, baseline.cpu.user), system = delta(current.cpu.system, baseline.cpu.system);
        const userMs = user === null ? null : user / 1000;
        const systemMs = system === null ? null : system / 1000;
        const totalMs = userMs !== null && systemMs !== null ? nonnegative(userMs + systemMs) : null;
        next.process.cpu = {
          userMs, systemMs, totalMs,
          percent: totalMs === null ? null : nonnegative(totalMs / windowMs * 100),
        };
        const active = delta(current.elu.active, baseline.elu.active);
        const idle = delta(current.elu.idle, baseline.elu.idle);
        const total = active !== null && idle !== null ? nonnegative(active + idle) : null;
        next.mainThread.eventLoopUtilization = total > 0 ? nonnegative(active / total) : null;
        if (phases) {
          try { next.phases = phases.rotate(); } catch { next.phases = null; } // diagnostics only
        }
        // 空的原生直方图的 percentile/min 是哨兵值、max=0:没有一个是测量值。
        const count = histogram.count;
        if (Number.isFinite(count) && count > 0) {
          const ms = (ns) => Number.isFinite(ns) && ns >= 0 && ns < 2 ** 63 ? ns / 1e6 : null;
          next.mainThread.eventLoopDelayMs = {
            p50: ms(histogram.percentile(50)), p95: ms(histogram.percentile(95)),
            p99: ms(histogram.percentile(99)), max: ms(histogram.max),
          };
        }
      }
      // 只有这个采样器重置直方图并推进累积 CPU/ELU 基线。
      histogram.reset();
      baseline = current;
      cached = next;
    } catch (e) { unavailable(e); }
  }

  function start() {
    if (started || disposed) return;
    started = true;
    try {
      histogram = createHistogram({ resolution: RESOLUTION_MS });
      histogram.enable();
      baseline = { at: now(), cpu: cpuUsage(), elu: eventLoopUtilization() };
      timer = schedule(sample, SAMPLE_MS);
      timer.unref?.();
    } catch (e) { unavailable(e); }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopResources();
    cached = withPhases(emptySnapshot('stopped'));
  }

  return { start, snapshot: () => cached, dispose };
}
