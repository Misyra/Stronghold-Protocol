import { REQUEST_DIAGNOSTICS, REQUEST_MINUTE_FIELDS } from './request-diagnostics.mjs';
import { LINUX_DIAGNOSTICS } from './linux-diagnostics.mjs';
import { GAME_DIAGNOSTICS, DIAGNOSTIC_SERIES } from './game-diagnostics.mjs';
const GAME = ['sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots', 'uptimeSec', 'healthzMs', ...GAME_DIAGNOSTICS];
const HOST = ['cpuStealPct', 'cpu', 'iowaitPct', 'psiCpuSome', 'psiCpuFull', 'psiIoSome', 'psiIoFull', 'psiMemSome', 'psiMemFull',
  'memPct', 'memUsedMB', 'memTotalMB', 'load1', 'load5', 'load15', 'diskPct', 'diskFreeGB',
  'diskReadKBS', 'diskWriteKBS', 'diskUtilPct', 'diskAwaitMs',
  'logBacklogBytes', 'logLagSec', 'rxKB', 'txKB', 'gameRssMB', 'nginxRssMB', 'conns', 'connsUniqueIps', 'hostUptimeSec', 'collectorLocalMs', ...LINUX_DIAGNOSTICS, ...REQUEST_DIAGNOSTICS];
const TRAFFIC = ['requests', 'pageViews', 'assetHits', 'wsConnects', 'aborts', 'errors', 'bytes', 'visitors',
  'peakSessions', 'peakSockets', 'peakHumans', 'peakBots', 'peakTxKB', 'peakEventLoopP99Ms', 'peakMainThreadCpuPct'];
export const numeric = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
// Capacity always measures live WebSocket connections, including snapshots from older probes.
export function onlineCapacity(current, capacity) {
  const online = numeric(current?.sockets), limit = numeric(capacity?.limit);
  const ratio = current?.game && online != null && limit > 0 ? online / limit * 100 : null;
  let level = ratio == null ? 'unknown' : ratio >= 100 ? 'full' : ratio >= (capacity.critPct ?? 90) ? 'crit' : ratio >= (capacity.warnPct ?? 70) ? 'warn' : 'ok';
  if (level === 'ok' && capacity.cores > 0 && numeric(current.load1) != null && current.load1 >= capacity.cores) level = 'warn';
  return { ...capacity, basis: 'sockets', level };
}
const pick = (obj, keys) => Object.fromEntries(keys.map((key) => [key, numeric(obj?.[key])]));
const text = (s, max = 100) => typeof s === 'string' ? s.slice(0, max) : null;
const dateKey = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) ? s : null;

const STATUSES = new Set(['ok', 'stale', 'missing', 'error', 'unknown', 'disabled']);
const ERROR_CODES = new Set(['TIMEOUT', 'AUTH_FAILED', 'INVALID_RESPONSE', 'UPSTREAM_ERROR', 'UNREACHABLE', 'NOT_CONFIGURED', 'NO_SAMPLE', 'CLOCK_SKEW',
  'LOG_ROTATION_GAP', 'LOG_MISSING', 'LOG_UNREADABLE', 'LOG_READ_FAILED', 'LOG_FORMAT_INVALID', 'LOG_LINE_TOO_LONG', 'STORAGE_WRITE_FAILED']);
export function sanitizeSection(section) {
  return { status: STATUSES.has(section?.status) ? section.status : 'unknown', error: ERROR_CODES.has(section?.error) ? section.error : null };
}

export function sanitizeMetrics(raw) {
  if (!raw || typeof raw !== 'object' || !raw.current || numeric(raw.current.t) === null ||
    typeof raw.current.game !== 'boolean' || !Array.isArray(raw.series) || !raw.today || !Array.isArray(raw.history)) {
    throw Object.assign(new Error('Invalid collector schema'), { code: 'INVALID_RESPONSE' });
  }
  const current = { t: numeric(raw.current.t), seq: numeric(raw.current.seq), sampleId: text(raw.current.sampleId, 80), game: raw.current.game, app: text(raw.current.app),
    ...pick(raw.current, GAME), ...pick(raw.current, HOST),
    requestMinuteWindows: (Array.isArray(raw.current.requestMinuteWindows) ? raw.current.requestMinuteWindows : []).slice(-180).filter(w => numeric(w?.httpMinuteStartedAt)!=null && w.httpMinuteStartedAt%60000===0 && w.httpMinuteEndedAt===w.httpMinuteStartedAt+60000 && w.httpMinuteEndedAt<=raw.current.t+10000).map(w=>pick(w,REQUEST_MINUTE_FIELDS)),
    gameThreadsCpuTop: Array.isArray(raw.current.gameThreadsCpuTop) ? raw.current.gameThreadsCpuTop.slice(0,3).filter(p=>typeof p?.name==='string' && numeric(p.cpuPct)!=null).map(p=>({name:p.name.replace(/[^a-zA-Z0-9 _.-]/g,'').slice(0,32),cpuPct:p.cpuPct})) : null };
  // Never forward connsTop, visitor IP lists, log offsets or arbitrary upstream fields.
  const diagnostics = Object.fromEntries(['nginx', 'storage'].map(key => [key, sanitizeSection(raw.diagnostics?.[key])]));
  const traffic = pick(raw.today, TRAFFIC);
  if (diagnostics.nginx.status === 'error') for (const key of TRAFFIC) if (!key.startsWith('peak')) traffic[key] = null;
  return { current, diagnostics, capacity: onlineCapacity(current, pick(raw.capacity, ['limit', 'warnPct', 'critPct', 'cores'])),
    intervalSec: numeric(raw.intervalSec), collectorUptimeSec: numeric(raw.collectorUptimeSec), samples: numeric(raw.samples),
    timeZone: text(raw.timeZone, 50),
    series: raw.series.slice(-600).filter((p) => numeric(p?.t) !== null).map((p) => ({ t: p.t,
      ...pick(p, ['sessions', 'sockets', 'humans', 'bots', 'cpu', 'psiIoSome', ...DIAGNOSTIC_SERIES]) })).sort((a, b) => a.t - b.t),
    today: { date: dateKey(raw.today.date), ...traffic },
    history: raw.history.slice(-366).filter((p) => dateKey(p?.date)).map((p) => ({ date: p.date, ...pick(p, TRAFFIC) })) };
}

export function sampleFreshness(t, now = Date.now(), maxAgeMs = 45000) {
  if (numeric(t) === null) return 'missing';
  if (t > now + 10000) return 'clock-skew';
  return now - t > maxAgeMs ? 'stale' : 'fresh';
}

export function announcement(raw) {
  const notice = raw?.announcement;
  if (notice == null) return null;
  if (typeof notice.title !== 'string' || typeof notice.text !== 'string' || numeric(notice.expiresAt) === null) {
    throw Object.assign(new Error('Invalid announcement'), { code: 'INVALID_RESPONSE' });
  }
  return { title: notice.title.slice(0, 80), text: notice.text.slice(0, 2000), expiresAt: notice.expiresAt };
}

export function sanitizeSnapshot(raw) {
  if (raw?.schemaVersion !== 1 || !raw.sections || !Object.hasOwn(raw, 'metrics')) {
    throw Object.assign(new Error('Invalid Agent schema'), { code: 'INVALID_RESPONSE' });
  }
  const metrics = raw.metrics === null ? null : sanitizeMetrics(raw.metrics);
  const sections = Object.fromEntries(['collector', 'game', 'nginx', 'storage', 'announcement', 'cert']
    .map(key => [key, sanitizeSection(raw.sections[key])]));
  const cert = raw.cert && typeof raw.cert === 'object' ? {
    notAfter: Number.isFinite(Date.parse(raw.cert.notAfter)) ? text(raw.cert.notAfter) : null,
    daysLeft: typeof raw.cert.daysLeft === 'number' && Number.isFinite(raw.cert.daysLeft) ? raw.cert.daysLeft : null,
    scope: 'origin',
  } : null;
  return { schemaVersion: 1, opsVersion: text(raw.opsVersion, 40), staleAfterMs: numeric(raw.staleAfterMs), metrics, sections, announcement: announcement({ announcement: raw.announcement }), cert,
    announcementDelivery: { gameSource: ['agent', 'panel', 'file'].includes(raw.announcementDelivery?.gameSource) ? raw.announcementDelivery.gameSource : null,
      revision: Number.isSafeInteger(raw.announcementDelivery?.revision) && raw.announcementDelivery.revision >= 0 ? raw.announcementDelivery.revision : null },
    capabilities: { metrics: true, sampleHistory: raw.capabilities?.sampleHistory === true, announcementRead: raw.capabilities?.announcementRead === true, announcementWrite: raw.capabilities?.announcementWrite === true, sessions: false, rooms: false } };
}

export function seriesFor(metrics, range, now = Date.now()) {
  if (!['1h', '24h', '7d'].includes(range)) return null;
  if (range === '7d') {
    // Existing collector only exports 24h curves. Daily peaks are a different, explicitly labelled series.
    const history = [...metrics.history, metrics.today].filter((d) => d.date);
    const days = new Map(history.map((d) => [d.date, d]));
    return { range, resolution: '1d', kind: 'daily-peaks', timeZone: metrics.timeZone,
      points: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-7).map((d) => ({
        date: d.date, sessions: d.peakSessions, sockets: d.peakSockets, humans: d.peakHumans, bots: d.peakBots, cpu: null })) };
  }
  return { range, resolution: '5m', kind: 'sampled-mixed', aggregation: { sessions: 'mean', sockets: 'max', humans: 'max', bots: 'max', cpu: 'max', psiIoSome: 'max', ...Object.fromEntries(DIAGNOSTIC_SERIES.map(k => [k, 'max'])) }, timeZone: metrics.timeZone,
    points: metrics.series.filter((p) => p.t >= now - (range === '1h' ? 1 : 24) * 3600000 && p.t <= now + 10000) };
}

export function freshnessWindow(metrics, { override, intervalMs = 10000, timeoutMs = 5000 } = {}) {
  if (override != null) return override;
  const sampleMs = Math.min(300000, Math.max(0, (numeric(metrics?.intervalSec) || 15) * 1000));
  return Math.max(45000, sampleMs * 3 + intervalMs + timeoutMs);
}
