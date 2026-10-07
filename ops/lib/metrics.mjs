const GAME = ['sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots', 'uptimeSec', 'healthzMs'];
const HOST = ['cpu', 'iowaitPct', 'psiCpuSome', 'psiCpuFull', 'psiIoSome', 'psiIoFull', 'psiMemSome', 'psiMemFull',
  'memPct', 'memUsedMB', 'memTotalMB', 'load1', 'load5', 'load15', 'diskPct', 'diskFreeGB',
  'diskReadKBS', 'diskWriteKBS', 'diskUtilPct', 'diskAwaitMs',
  'rxKB', 'txKB', 'gameRssMB', 'nginxRssMB', 'conns', 'connsUniqueIps', 'hostUptimeSec'];
const TRAFFIC = ['requests', 'pageViews', 'assetHits', 'wsConnects', 'aborts', 'errors', 'bytes', 'visitors',
  'peakSessions', 'peakSockets', 'peakHumans', 'peakBots', 'peakTxKB'];
export const numeric = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const pick = (obj, keys) => Object.fromEntries(keys.map((key) => [key, numeric(obj?.[key])]));
const text = (s, max = 100) => typeof s === 'string' ? s.slice(0, max) : null;
const dateKey = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) ? s : null;

const STATUSES = new Set(['ok', 'stale', 'missing', 'error', 'unknown', 'disabled']);
const ERROR_CODES = new Set(['TIMEOUT', 'AUTH_FAILED', 'INVALID_RESPONSE', 'UPSTREAM_ERROR', 'UNREACHABLE', 'NOT_CONFIGURED', 'NO_SAMPLE', 'CLOCK_SKEW',
  'LOG_MISSING', 'LOG_UNREADABLE', 'LOG_READ_FAILED', 'LOG_FORMAT_INVALID', 'LOG_LINE_TOO_LONG', 'STORAGE_WRITE_FAILED']);
export function sanitizeSection(section) {
  return { status: STATUSES.has(section?.status) ? section.status : 'unknown', error: ERROR_CODES.has(section?.error) ? section.error : null };
}

export function sanitizeMetrics(raw) {
  if (!raw || typeof raw !== 'object' || !raw.current || numeric(raw.current.t) === null ||
    typeof raw.current.game !== 'boolean' || !Array.isArray(raw.series) || !raw.today || !Array.isArray(raw.history)) {
    throw Object.assign(new Error('Invalid collector schema'), { code: 'INVALID_RESPONSE' });
  }
  const current = { t: numeric(raw.current.t), game: raw.current.game, app: text(raw.current.app),
    ...pick(raw.current, GAME), ...pick(raw.current, HOST) };
  // Never forward connsTop, visitor IP lists, log offsets or arbitrary upstream fields.
  const diagnostics = Object.fromEntries(['nginx', 'storage'].map(key => [key, sanitizeSection(raw.diagnostics?.[key])]));
  const traffic = pick(raw.today, TRAFFIC);
  if (diagnostics.nginx.status === 'error') for (const key of TRAFFIC) if (!key.startsWith('peak')) traffic[key] = null;
  return { current, diagnostics, capacity: { ...pick(raw.capacity, ['limit', 'warnPct', 'critPct', 'cores']), basis: 'sessions',
    level: ['ok', 'warn', 'crit', 'full'].includes(raw.capacity?.level) ? raw.capacity.level : 'unknown' },
    intervalSec: numeric(raw.intervalSec), collectorUptimeSec: numeric(raw.collectorUptimeSec), samples: numeric(raw.samples),
    timeZone: text(raw.timeZone, 50),
    series: raw.series.slice(-600).filter((p) => numeric(p?.t) !== null).map((p) => ({ t: p.t,
      ...pick(p, ['sessions', 'sockets', 'humans', 'bots', 'cpu', 'psiIoSome']) })).sort((a, b) => a.t - b.t),
    today: { date: dateKey(raw.today.date), ...traffic },
    history: raw.history.slice(-30).filter((p) => dateKey(p?.date)).map((p) => ({ date: p.date, ...pick(p, TRAFFIC) })) };
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
  return { schemaVersion: 1, opsVersion: text(raw.opsVersion, 40), metrics, sections, announcement: announcement({ announcement: raw.announcement }), cert,
    capabilities: { metrics: true, announcementRead: raw.capabilities?.announcementRead === true, announcementWrite: false, sessions: false, rooms: false } };
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
  return { range, resolution: '5m', kind: 'sampled-averages', timeZone: metrics.timeZone,
    points: metrics.series.filter((p) => p.t >= now - (range === '1h' ? 1 : 24) * 3600000 && p.t <= now + 10000) };
}
