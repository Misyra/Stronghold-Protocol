// HTTP remains the content source; optional WS revision hints suppress unchanged polling.
export const ANNOUNCEMENT_CHECK_MS = 30_000;

/** Use a monotonic deadline based on server time, even when the player's wall clock is wrong. */
export function announcementSnapshot(body, now = performance.now()) {
  const a = body?.announcement;
  if (!a) return null;
  if (typeof a.id !== 'string' || !a.id || typeof a.title !== 'string' || typeof a.text !== 'string'
      || !Number.isFinite(a.expiresAt) || !Number.isFinite(body.serverTime)) return null;
  const remaining = a.expiresAt - body.serverTime;
  if (remaining <= 0) return null;
  return { ...a, deadline: now + remaining };
}

/**
 * The popup snapshot of the same read (shared/announcements.js): its expiry is absolute too, and a popup may legitimately
 * have none (withdrawn by the owner instead) — that one has an `Infinity` deadline.
 */
export function popupSnapshot(body, now = performance.now()) {
  const p = body?.popupAnnouncement;
  if (!p || typeof p.id !== 'string' || !p.id || typeof p.text !== 'string' || !Number.isFinite(body.serverTime)) return null;
  const end = Number.isFinite(p.endAt) ? p.endAt : null;
  if (end !== null && end - body.serverTime <= 0) return null;
  return { ...p, deadline: end === null ? Infinity : now + (end - body.serverTime) };
}

/** One in-flight request, bounded wait, immediate check on return to the tab; failures retain the previous notice. */
export function startAnnouncementPolling({ onChange, fetchFn = globalThis.fetch, net = null,
  doc = globalThis.document, intervalMs = ANNOUNCEMENT_CHECK_MS, timeoutMs = 5000,
  now = () => performance.now() }) {
  let stopped = false;
  let busy = false;
  let controller = null;
  let timeout = null;
  let cancelWait = null;
  let hint = null, hintedAt = -Infinity, appliedHint = null, lastReadAt = -Infinity, nextHintRetry = -Infinity;
  async function check(force = false, bypassCache = false) {
    if (stopped || busy || doc?.hidden) return;
    if (!force && hint && hint === appliedHint && now() - hintedAt < 12000 && now() - lastReadAt < 180000) return;
    busy = true;
    const requestedHint = hint;
    controller = new AbortController();
    const signal = controller.signal;
    const timedOut = new Promise((resolve) => {
      cancelWait = resolve;
      timeout = setTimeout(() => { controller?.abort(); resolve(undefined); }, timeoutMs);
    });
    try {
      const request = (async () => {
        const res = await fetchFn(`/api/announcement${bypassCache ? '?nocache=1' : ''}`, { cache: 'no-store', signal });
        if (!res.ok) return undefined;
        const body = await res.json();
        // Nginx caches the public projection for up to 5s. Age is added on cache HITs;
        // advance serverTime so announcement expiry remains tied to wall time, not cache age.
        const ageSeconds = Number.parseInt(res.headers?.get?.('age') || '0', 10);
        if (Number.isFinite(ageSeconds) && ageSeconds > 0 && Number.isFinite(body?.serverTime)) {
          body.serverTime += ageSeconds * 1000;
        }
        return body;
      })();
      const body = await Promise.race([request, timedOut]);
      if (!stopped && body !== undefined) {
        lastReadAt = now(); appliedHint = requestedHint;
        nextHintRetry = -Infinity;
        onChange(announcementSnapshot(body, now()), popupSnapshot(body, now()));
      }
    } catch { /* Network outages must not interfere with an ongoing match. */ }
    finally {
      clearTimeout(timeout);
      controller = null;
      cancelWait = null;
      busy = false;
    }
  }
  const unsubscribe = net?.on('pong', (msg) => {
    if (typeof msg.announcementRevision !== 'string' || !/^[a-f0-9]{24}$/.test(msg.announcementRevision)) return;
    const changed = hint !== msg.announcementRevision;
    hint = msg.announcementRevision; hintedAt = now();
    if (!busy && (changed || hint !== appliedHint) && now() >= nextHintRetry) {
      nextHintRetry = now() + intervalMs;
      void check(false, true);
    }
  });
  const timer = setInterval(check, intervalMs);
  const onVisible = () => { void check(true, true); };
  doc?.addEventListener('visibilitychange', onVisible);
  void check();
  return () => {
    stopped = true;
    unsubscribe?.();
    clearInterval(timer);
    clearTimeout(timeout);
    controller?.abort();
    cancelWait?.(undefined);
    doc?.removeEventListener('visibilitychange', onVisible);
  };
}
