import { performance } from 'node:perf_hooks';

/** One cached main-thread sample per second; AI decisions never collect OS metrics. */
export class RehearsalPressure {
  constructor({ now = () => performance.now(), cpuUsage = typeof process.threadCpuUsage === 'function'
    ? () => process.threadCpuUsage() : null, eluNow = () => performance.eventLoopUtilization(),
  autoStart = true } = {}) {
    this.now = now;
    this.cpuUsage = cpuUsage;
    this.eluNow = eluNow;
    this.previousAt = now();
    this.previousCpu = cpuUsage?.() || null;
    this.previousElu = eluNow();
    this.source = cpuUsage ? 'main-thread-cpu' : 'event-loop-utilization';
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
    return { source: this.source, percent: this.percent, sampledAt: this.sampledAt,
      sampleIntervalMs: 1000, maxCandidates: this.maxCandidates,
      state: this.maxCandidates === 0 ? 'disabled' : this.maxCandidates === 1 ? 'reduced' : 'normal',
      thresholds: { reduceAbovePercent: 60, disableAbovePercent: 70,
        recoverFromDisabledAtPercent: 65, recoverToNormalAtPercent: 55, recoverySamples: 5 } };
  }

  close() { clearInterval(this.timer); this.timer = null; }
}
