import { REQUEST_DIAGNOSTICS } from './request-diagnostics.mjs';
import { LINUX_DIAGNOSTICS } from './linux-diagnostics.mjs';
// Public numeric diagnostics only; no arbitrary upstream fields.
export const GAME_DIAGNOSTICS = ["gameSocketBuffersTotal","gameSocketBuffersMax","gameWorkersQueued","gameWorkersBusy","gameWorkersQueueMs","gameWorkersAvgComputeMs","gamePersistFailures","gamePersistCheckpoints","gameHeapUsedMB","gameHeapTotalMB","gameEventLoopP99Ms","gameEventLoopMaxMs","gameGcCount","gameGcTotalMs","gameGcMaxMs","gameGcOver50","gameDiagWindowMs","gameDiagEndedAt","gamePersistSaveLastMs","gameMaintenance","gameEventLoopLatestP99Ms","gameEventLoopLatestMaxMs"];
export const DIAGNOSTIC_SERIES = ['cpuStealPct',...REQUEST_DIAGNOSTICS.filter(k => ['httpP99Ms','httpAborts','httpErrors','httpRateLimited','httpMinuteP99Ms','httpMinuteAborts','httpMinuteErrors','httpMinuteRateLimited'].includes(k)), 'gameEventLoopP99Ms', 'gameEventLoopMaxMs', 'gameGcTotalMs', ...LINUX_DIAGNOSTICS.filter(k => ['gameMainThreadCpuPct','gameNvcswPerSec'].includes(k))];
const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function gameDiagnostics(g, now = Date.now()) {
  const out = Object.fromEntries(GAME_DIAGNOSTICS.map(k => [k, null]));
  if (g?.ok !== true) return out;
  out.gameMaintenance = g.maintenance == null ? 0 : typeof g.maintenance === 'object' ? 1 : null;
  const get = (key, value) => { out[key] = numeric(value); };
  get('gameSocketBuffersTotal', g.socketBuffers?.total); get('gameSocketBuffersMax', g.socketBuffers?.max);
  get('gameWorkersQueued', g.workers?.queued); get('gameWorkersBusy', g.workers?.busy);
  get('gameWorkersQueueMs', g.workers?.queueMs); get('gameWorkersAvgComputeMs', g.workers?.avgComputeMs);
  get('gamePersistFailures', g.persist?.failures); get('gamePersistCheckpoints', g.persist?.checkpoints); get('gamePersistSaveLastMs', g.persist?.lastSaveMs);
  for (const [key, value] of [['gameHeapUsedMB', g.memory?.heapUsed], ['gameHeapTotalMB', g.memory?.heapTotal]]) {
    out[key] = numeric(value) == null ? null : value / 1024 ** 2;
  }
  const windows = g.processDiagnostics?.windows;
  // Conservative peak across retained completed windows prevents a poll boundary
  // from hiding freezes. These overlapping values are NOT additive counters.
  const recent = Array.isArray(windows) ? windows.slice(-8).filter(w =>
    numeric(w?.endedAt) != null && w.endedAt <= now + 10000 && now - w.endedAt <= 135000 && numeric(w.windowMs) > 0) : [];
  const latest = recent.at(-1);
  if (latest) {
    get('gameEventLoopLatestP99Ms', latest.eventLoop?.p99Ms); get('gameEventLoopLatestMaxMs', latest.eventLoop?.maxMs);
    get('gameDiagWindowMs', latest.windowMs); get('gameDiagEndedAt', latest.endedAt);
    get('gameEventLoopP99Ms', Math.max(...recent.map(w => numeric(w.eventLoop?.p99Ms) ?? -1)));
    get('gameEventLoopMaxMs', Math.max(...recent.map(w => numeric(w.eventLoop?.maxMs) ?? -1)));
    get('gameGcCount', latest.gc?.count); get('gameGcTotalMs', latest.gc?.totalMs);
    get('gameGcMaxMs', latest.gc?.maxMs); get('gameGcOver50', latest.gc?.over50);
  }
  return out;
}
