// Read-only notice polling, independent of the game's WebSocket protocol.
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
export function startAnnouncementPolling({ onChange, fetchFn = globalThis.fetch,
  doc = globalThis.document, intervalMs = ANNOUNCEMENT_CHECK_MS, timeoutMs = 5000,
  now = () => performance.now() }) {
  let stopped = false;
  let busy = false;
  let controller = null;
  let timeout = null;
  let cancelWait = null;
  async function check() {
    if (stopped || busy || doc?.hidden) return;
    busy = true;
    controller = new AbortController();
    const signal = controller.signal;
    const timedOut = new Promise((resolve) => {
      cancelWait = resolve;
      timeout = setTimeout(() => { controller?.abort(); resolve(undefined); }, timeoutMs);
    });
    try {
      const request = (async () => {
        const res = await fetchFn('/api/announcement', { cache: 'no-store', signal });
        return res.ok ? await res.json() : undefined;
      })();
      const body = await Promise.race([request, timedOut]);
      if (!stopped && body !== undefined) onChange(announcementSnapshot(body, now()), popupSnapshot(body, now()));
    } catch { /* Network outages must not interfere with an ongoing match. */ }
    finally {
      clearTimeout(timeout);
      controller = null;
      cancelWait = null;
      busy = false;
    }
  }
  const timer = setInterval(check, intervalMs);
  doc?.addEventListener('visibilitychange', check);
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(timeout);
    controller?.abort();
    cancelWait?.(undefined);
    doc?.removeEventListener('visibilitychange', check);
  };
}
