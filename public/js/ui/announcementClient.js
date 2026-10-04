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
      if (!stopped && body !== undefined) onChange(announcementSnapshot(body, now()));
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
