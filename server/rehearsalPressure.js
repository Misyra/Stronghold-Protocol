import { performance } from 'node:perf_hooks';

/**
 * 压力压档的开关（\`SP_REHEARSAL_PRESSURE\`）。默认开：CPU 高时自动少预演几个候选。
 * 值 off / 0 / false / no 时只关**压档**——采样照旧（/metrics 的负载百分比还在），候选数完全按配置走。
 * 关它的场合：这台机器不是瓶颈（比如 AI 布阵试算已经交给房主浏览器，见 SP_BOT_REHEARSAL=host），
 * 而你不希望服务器再因为自己的负载偷偷降低预演质量。
 */
export function rehearsalPressureCapEnabled(env = process.env) {
  const value = String(env?.SP_REHEARSAL_PRESSURE ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(value);
}

/** One cached main-thread sample per second; AI decisions never collect OS metrics. */
export class RehearsalPressure {
  constructor({ now = () => performance.now(), cpuUsage = typeof process.threadCpuUsage === 'function'
    ? () => process.threadCpuUsage() : null, eluNow = () => performance.eventLoopUtilization(),
  autoStart = true, capEnabled = true } = {}) {
    this.now = now;
    this.cpuUsage = cpuUsage;
    this.eluNow = eluNow;
    this.previousAt = now();
    this.previousCpu = cpuUsage?.() || null;
    this.previousElu = eluNow();
    this.source = cpuUsage ? 'main-thread-cpu' : 'event-loop-utilization';
    this.capEnabled = capEnabled !== false;
    this.percent = null;
    this.sampledAt = null;
    this.maxCandidates = null;
    this.recoverySamples = 0;
    this.timer = autoStart ? setInterval(() => this.sample(), 1000) : null;
    this.timer?.unref();
  }

  sample() {
    const at = this.now(), cpu = this.cpuUsage?.() || null, elu = this.eluNow();
    const elapsedMs = at - this.previousAt;
    const active = Math.max(0, elu.active - this.previousElu.active);
    const idle = Math.max(0, elu.idle - this.previousElu.idle);
    const cpuMicros = cpu && this.previousCpu
      ? Math.max(0, cpu.user - this.previousCpu.user) + Math.max(0, cpu.system - this.previousCpu.system) : null;
    if (!(elapsedMs > 0)) return;
    this.previousAt = at;
    this.previousCpu = cpu;
    this.previousElu = elu;
    this.percent = Math.min(100, cpuMicros === null
      ? (active + idle > 0 ? 100 * active / (active + idle) : 0)
      : cpuMicros / (elapsedMs * 10));
    this.sampledAt = Date.now();
    // 压档关掉时只留采样：/metrics 上的负载数字照旧，候选数按配置走，不在这里偷偷降级。
    if (!this.capEnabled) { this.maxCandidates = null; this.recoverySamples = 0; return; }
    const limit = this.percent > 70 ? 0 : this.percent > 60 ? 1 : null;
    const rank = (value) => value ?? Infinity;
    if (rank(limit) < rank(this.maxCandidates)) {
      this.maxCandidates = limit;
      this.recoverySamples = 0;
    } else {
      // Recover only after five samples below the lower release threshold (5 percentage points of hysteresis).
      const release = this.maxCandidates === 0 ? 65 : 55;
      if (this.maxCandidates !== null && this.percent <= release) {
        if (++this.recoverySamples >= 5) {
          this.maxCandidates = this.percent > 55 ? 1 : null;
          this.recoverySamples = 0;
        }
      } else this.recoverySamples = 0;
    }
  }

  cap(configured) { return Math.min(configured, this.maxCandidates ?? configured); }

  stats() {
    return { source: this.source, enabled: this.capEnabled, percent: this.percent, sampledAt: this.sampledAt,
      sampleIntervalMs: 1000, maxCandidates: this.maxCandidates,
      state: !this.capEnabled ? 'off' : this.maxCandidates === 0 ? 'disabled' : this.maxCandidates === 1 ? 'reduced' : 'normal',
      thresholds: { reduceAbovePercent: 60, disableAbovePercent: 70,
        recoverFromDisabledAtPercent: 65, recoverToNormalAtPercent: 55, recoverySamples: 5 } };
  }

  close() { clearInterval(this.timer); this.timer = null; }
}
