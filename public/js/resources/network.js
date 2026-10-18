// Bounded full-body downloads. The deadline includes response headers AND body; retries never include a 404 or quota error.
import { assetSiteUrl } from '../../../shared/assetCdn.js';
import { MAX_FILE_BYTES, abortError, checkAbort } from './common.js';

/** Shared by the page, worker handoff and run recovery; permanent failures never auto-retry. */
export function isTransientResourceError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'TypeError' || err?.transient === true
    || err?.status === 408 || err?.status === 429 || err?.status >= 500;
}

export function waitForResource(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Consecutive CDN failures that mean the asset host is challenging or failing this client outright. */
const CDN_TRIP = 2;
/** How long a tripped breaker keeps the CDN out of the loop before it is probed again (a page or worker
 *  lives far longer than a preload run, and an "Under Attack" window closes on its own). */
const CDN_COOL_OFF_MS = 5 * 60_000;
let cdnFails = 0;
let cdnBlockedUntil = 0;

/** The game host's copy of a CDN URL — '' for anything the host already owns. */
function siteCopy(url) {
  const base = globalThis.__spAssetCdn?.base || '';
  const siteOrigin = globalThis.location?.origin || globalThis.self?.location?.origin || '';
  if (!base && !siteOrigin) return '';
  return assetSiteUrl(url, { base, siteOrigin });
}

/**
 * Download a resource into a complete, bounded body. A URL on the assets CDN is tried first and, when that
 * fails for any reason the host could answer instead — a browser challenge (403), a body-less CORS answer, a
 * timeout, a cache that does not have the file — the game host's own copy answers instead. Two consecutive
 * CDN failures trip a breaker for {@link CDN_COOL_OFF_MS}: 27 000 assets must not each rediscover the same block.
 */
export async function fetchResource(url, options) {
  const signal = options?.signal;
  const twin = siteCopy(url);
  if (!twin) return attempt(url, options);
  if (cdnBlockedUntil && Date.now() < cdnBlockedUntil) { checkAbort(signal); return attempt(twin, options); }
  try {
    const response = await attempt(url, options);
    cdnFails = 0; cdnBlockedUntil = 0;
    return response;
  } catch (err) {
    checkAbort(signal); // an abort is the caller's, never the CDN's
    if (++cdnFails >= CDN_TRIP) { cdnFails = 0; cdnBlockedUntil = Date.now() + CDN_COOL_OFF_MS; }
    return attempt(twin, options);
  }
}

/** One URL, its retries and its deadline. */
async function attempt(url, { fetcher = globalThis.fetch?.bind(globalThis), signal,
  timeoutMs = 30000, retries = 2, retryDelayMs = 500, cache = /** @type {RequestCache} */ ('no-store') } = {}) {
  for (let i = 0; ; i++) {
    checkAbort(signal);
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const stop = (reason) => { controller.abort(reason); if (reader) void reader.cancel().catch(() => {}); rejectDeadline(reason); };
    const abort = () => stop(signal.reason || abortError());
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(Object.assign(new Error('资源下载超时'), { name: 'TimeoutError' })), timeoutMs);
    let reader;
    try {
      return await Promise.race([deadline, (async () => {
        // Keep the game host's browser/session gate cookie. Cross-origin CDN requests remain anonymous.
        const response = await fetcher(url, { mode: 'cors', credentials: 'same-origin', cache, signal: controller.signal });
        if (!response.ok) {
          const retryAfter = response.headers.get('Retry-After');
          void response.body?.cancel().catch(() => {});
          const seconds = retryAfter != null && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000
            : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
          throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, retryAfter: seconds });
        }
        if (response.type === 'opaque' || !response.body || response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw new Error('响应不可读取（缺少 CORS 头或非完整响应）');
        }
        reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_FILE_BYTES) throw new Error('单个资源超过 24 MiB 缓存上限');
            chunks.push(value);
          }
        } catch (cause) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (bytes > MAX_FILE_BYTES) throw cause;
          throw Object.assign(new Error('资源连接中断', { cause }), { transient: true });
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        // fetch has already decompressed bytes. Never carry transfer encoding/length into a synthesized response.
        const headers = new Headers(response.headers);
        if (headers.has('Content-Encoding')) headers.delete('Content-Length');
        else if (headers.has('Content-Length')) headers.set('Content-Length', String(bytes));
        headers.delete('Content-Encoding'); headers.delete('Transfer-Encoding');
        return new Response(body, { status: 200, headers });
      })()]);
    } catch (err) {
      checkAbort(signal);
      const transient = isTransientResourceError(err);
      if (!transient || i >= retries) throw err;
      // Retry-After is respected up to 30s; explicit pause also interrupts this backoff.
      clearTimeout(timer);
      await waitForResource(Math.min(30000, Math.max(0, err.retryAfter || 0, retryDelayMs * 2 ** i)), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (reader) void reader.cancel().catch(() => {});
    }
  }
}
