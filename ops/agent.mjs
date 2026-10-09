import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { decodeSampleCursor } from './lib/sample-history.mjs';
import { X509Certificate } from 'node:crypto';
import { equalSecret, sendJson, fetchJson, safeUrl, errorCode, periodic, listen, integer, isEntry, onShutdown } from './lib/http.mjs';
import { sanitizeMetrics, sampleFreshness, announcement, seriesFor, freshnessWindow } from './lib/metrics.mjs';

// 探针版本（VERSION 是探针文件的内容哈希，由 sp-portal 的 deploy/sync-agent.mjs 生成）；
// 面板用它核对各服务器是否更新到位。文件缺失（如手工部署旧包）显示 unknown。
const OPS_VERSION = (() => { try { return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim().slice(0, 40) || 'unknown'; } catch { return 'unknown'; } })();

export async function startAgent(options = {}) {
  const collectorUrl = safeUrl(options.collectorUrl || 'http://127.0.0.1:3999/api/data');
  const announcementUrl = options.announcementUrl ? safeUrl(options.announcementUrl) : null;
  const token = options.token || '';
  if (token && Buffer.byteLength(token) < 32) throw new Error('Agent read token must contain at least 32 bytes');
  const intervalMs = integer(options.intervalMs, 10000, 100, 300000);
  const timeoutMs = integer(options.timeoutMs, 5000, 10, 30000);
  const staleMs = options.staleMs == null || options.staleMs === '' ? undefined : integer(options.staleMs, 45000, 100, 3600000);
  const now = options.now || Date.now;
  let metrics = null, notice = null, cert = null, sampleHistoryEnabled = false;
  const sections = { nginx: { status: 'unknown', error: null }, storage: { status: 'unknown', error: null }, collector: { status: 'missing', error: 'NO_SAMPLE' }, game: { status: 'unknown' },
    announcement: { status: announcementUrl ? 'missing' : 'disabled', error: announcementUrl ? null : 'NOT_CONFIGURED' },
    cert: { status: options.certFile ? 'missing' : 'disabled', error: options.certFile ? null : 'NOT_CONFIGURED' } };
  let certCheckedAt = 0;
  async function refresh() {
    await Promise.allSettled([
      (async () => {
        try {
          const raw = await fetchJson(collectorUrl, { timeoutMs });
          if (raw?.current === null && Array.isArray(raw.series) && raw.today && Array.isArray(raw.history)) {
            sections.collector = { status: 'missing', error: 'NO_SAMPLE' };
            sections.game = { status: 'unknown', error: 'NO_SAMPLE' };
            return;
          }
          metrics = sanitizeMetrics(raw); sampleHistoryEnabled = raw.capabilities?.sampleHistory === true;
          sections.nginx = metrics.diagnostics.nginx; sections.storage = metrics.diagnostics.storage;
          sections.collector = { status: 'ok', error: null };
          sections.game = { status: metrics.current.game ? 'ok' : 'error', error: metrics.current.game ? null : 'UPSTREAM_ERROR' };
        } catch (error) { sections.collector = { status: 'error', error: errorCode(error) }; }
      })(),
      (async () => {
        if (!announcementUrl) return;
        try { notice = announcement(await fetchJson(announcementUrl, { timeoutMs, maxBytes: 32 * 1024 }));
          sections.announcement = { status: 'ok', error: null };
        } catch (error) { sections.announcement = { status: 'error', error: errorCode(error) }; }
      })(),
      (async () => {
        if (!options.certFile || (cert && now() - certCheckedAt < 3600000)) return;
        try {
          const contents = await readFile(options.certFile);
          if (contents.length > 128 * 1024) throw new Error('Certificate too large');
          const certificate = new X509Certificate(contents);
          cert = { notAfter: new Date(certificate.validTo).toISOString(), scope: 'origin' };
          certCheckedAt = now(); sections.cert = { status: 'ok', error: null };
        } catch { sections.cert = { status: 'error', error: 'NOT_CONFIGURED' }; }
      })(),
    ]);
  }
  function snapshot() {
    const currentSections = structuredClone(sections);
    const freshness = sampleFreshness(metrics?.current?.t, now(), freshnessWindow(metrics, { override: staleMs, intervalMs, timeoutMs }));
    if (currentSections.collector.status === 'ok' && freshness !== 'fresh') {
      currentSections.collector = { status: freshness === 'missing' ? 'missing' : 'stale',
        error: freshness === 'clock-skew' ? 'CLOCK_SKEW' : null };
    }
    for (const key of ['nginx', 'storage']) if (currentSections[key].status === 'ok' &&
      (freshness !== 'fresh' || currentSections.collector.status !== 'ok')) currentSections[key].status = 'stale';
    if (currentSections.game.status === 'ok' && (freshness !== 'fresh' || currentSections.collector.status !== 'ok')) {
      currentSections.game.status = 'stale';
    }
    return { schemaVersion: 1, generatedAt: now(), opsVersion: OPS_VERSION, staleAfterMs: freshnessWindow(metrics, { override: staleMs, intervalMs, timeoutMs }), metrics, sections: currentSections,
      announcement: notice && now() < notice.expiresAt ? notice : null,
      cert: cert ? { ...cert, daysLeft: Math.floor((Date.parse(cert.notAfter) - now()) / 86400000) } : null,
      capabilities: { metrics: true, sampleHistory: sampleHistoryEnabled, announcementRead: !!announcementUrl, announcementWrite: false, sessions: false, rooms: false } };
  }
  const poll = periodic(refresh, intervalMs);
  let service;
  try { service = await listen(async (req, res) => {
    if (!equalSecret(req.headers.authorization, `Bearer ${token}`) || !token) {
      // Slow down online token guessing reached through the site's nginx route.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return sendJson(req, res, 403, { error: { code: 'FORBIDDEN' } });
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD'); return sendJson(req, res, 405, { error: { code: 'READ_ONLY' } });
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.has('token')) return sendJson(req, res, 400, { error: { code: 'QUERY_TOKEN_FORBIDDEN' } });
    if (url.pathname === '/api/admin/v1/overview') return sendJson(req, res, 200, snapshot());
    if (url.pathname === '/api/admin/v1/capabilities') return sendJson(req, res, 200, snapshot().capabilities);
    if (url.pathname === '/api/admin/v1/samples') {
      if (!sampleHistoryEnabled) return sendJson(req, res, 404, { error: { code: 'HISTORY_UNAVAILABLE' } });
      try {
        const cursor = url.searchParams.get('cursor'); decodeSampleCursor(cursor);
        const limit = integer(url.searchParams.get('limit'), 200, 1, 200);
        const target = new URL('samples', collectorUrl); if (cursor) target.searchParams.set('cursor', cursor);
        target.searchParams.set('limit', String(limit));
        const raw = await fetchJson(target, { timeoutMs, maxBytes: 2 * 1024 * 1024 });
        if (raw?.schemaVersion !== 1 || !Array.isArray(raw.records) || raw.records.length > limit || typeof raw.hasMore !== 'boolean')
          throw Object.assign(new Error('Invalid history response'), { code: 'INVALID_RESPONSE' });
        decodeSampleCursor(raw.nextCursor);
          if (raw.records.length && !raw.nextCursor) throw Object.assign(new Error('Missing history cursor'), { code: 'INVALID_RESPONSE' });
        if (raw.hasMore && (!raw.nextCursor || raw.nextCursor === cursor)) throw Object.assign(new Error('History cursor did not advance'), { code: 'INVALID_RESPONSE' });
        return sendJson(req, res, 200, { schemaVersion: 1, records: raw.records.map(sanitizeMetrics), nextCursor: raw.nextCursor,
          hasMore: raw.hasMore, gap: raw.gap === true, oldestDate: typeof raw.oldestDate === 'string' && /^\d{4}-\d\d-\d\d$/.test(raw.oldestDate) ? raw.oldestDate : null });
      } catch (error) { return sendJson(req, res, error.code === 'INVALID_CURSOR' || error.message.startsWith('Expected an integer') ? 400 : 503, { error: { code: errorCode(error) } }); }
    }
    if (url.pathname === '/api/admin/v1/metrics') {
      const range = url.searchParams.get('range') || '24h';
      if (!['1h', '24h', '7d'].includes(range)) return sendJson(req, res, 400, { error: { code: 'INVALID_RANGE' } });
      if (!metrics) return sendJson(req, res, 503, { error: { code: 'NO_SAMPLE' } });
      return sendJson(req, res, 200, { ...seriesFor(metrics, range, now()), sections: snapshot().sections });
    }
    if (url.pathname === '/api/admin/v1/health') { const snap = snapshot(); return sendJson(req, res, 200, { ok: true, ready: !!metrics && snap.sections.collector.status === 'ok', degraded: Object.values(snap.sections).some(s => ['error', 'stale', 'missing'].includes(s.status)) }); }
    return sendJson(req, res, 404, { error: { code: 'NOT_FOUND' } });
  }, options); } catch (error) { await poll.stop(); throw error; }
  const closeServer = service.close;
  return { ...service, refresh: poll.refresh, snapshot, close: async () => { await poll.stop(); await closeServer(); } };
}

if (isEntry(import.meta.url)) {
  try {
    const token = process.env.SP_ADMIN_TOKEN_RO || '';
    if (!token) console.warn('[agent] SP_ADMIN_TOKEN_RO is missing; all requests will be rejected');
    const service = await startAgent({ host: process.env.SP_ADMIN_BIND || '127.0.0.1',
      port: integer(process.env.SP_ADMIN_PORT, 3900, 1, 65535), token,
      collectorUrl: process.env.MON_COLLECTOR_URL || 'http://127.0.0.1:3999/api/data',
      announcementUrl: process.env.MON_ANNOUNCEMENT_URL || 'http://127.0.0.1:3000/api/announcement',
      certFile: process.env.MON_CERT_FILE,
      intervalMs: process.env.MON_AGENT_INTERVAL_MS, timeoutMs: process.env.MON_TIMEOUT_MS, staleMs: process.env.MON_STALE_MS });
    console.log(`[agent] ${service.url} · read-only API`); onShutdown(service);
  } catch (error) { console.error('[agent]', error.message); process.exitCode = 1; }
}
