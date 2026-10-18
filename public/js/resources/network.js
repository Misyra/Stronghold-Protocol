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
/**
 * How much a single page may pull from the game host when the CDN refuses it. The fallback exists so a challenged CDN
 * does not turn into "no art at all"; it must never turn into "every player re-downloads 310 MiB from the game server".
 * Bulk preload does not fall back at all (public/js/resources/store.js passes allowOrigin:false).
 */
const ORIGIN_LIMIT_FILES = 400;
const ORIGIN_LIMIT_BYTES = 48 << 20;
let originFiles = 0;
let originBytes = 0;
let originRefused = 0;
/** How long a tripped breaker keeps the CDN out of the loop before it is probed again (a page or worker
 *  lives far longer than a preload run, and an "Under Attack" window closes on its own). */
const CDN_COOL_OFF_MS = 5 * 60_000;
let cdnFails = 0;
let cdnBlockedUntil = 0;

/**
 * Reserve `bytes` of this page's game-host fallback budget (a page may only lean on the game server so much while the
 * CDN refuses it). Returns the reserved amount, or 0 when the budget is spent. Every caller of the host copy — bulk
 * preload is refused outright — goes through here: public/js/resourceNetwork.js and public/js/image.js share it.
 */
export function takeOriginBudget(bytes = 0) {
  if (originFiles >= ORIGIN_LIMIT_FILES || originBytes >= ORIGIN_LIMIT_BYTES) { originRefused++; return 0; }
  originFiles++;
  originBytes += Math.max(0, Number(bytes) || 0);
  return Math.max(1, Math.max(0, Number(bytes) || 0));
}

/** Test seam: forget the breaker and the fallback budget (a page load starts with a fresh module anyway). */
export function __resetOriginFallback() {
  cdnFails = 0; cdnBlockedUntil = 0; originFiles = 0; originBytes = 0; originRefused = 0;
}

/** The game host's copy of a CDN URL — '' for anything the host already owns. */
function siteCopy(url) {
  const base = globalThis.__spAssetCdn?.base || '';
  const siteOrigin = globalThis.location?.origin || globalThis.self?.location?.origin || '';
  if (!base && !siteOrigin) return '';
  return assetSiteUrl(url, { base, siteOrigin });
}

/**
 * Download a resource into a complete, bounded body. A URL on the assets CDN is tried first; when it fails for a
 * reason the host could answer instead (403 challenge, body-less CORS answer, timeout, a cache without the file) the
 * game host's own copy answers — but only for callers that asked for it (`allowOrigin`, the runtime art path) and only
 * within this page's budget. Bulk preload passes `allowOrigin: false`: 27 000 files must never re-download 310 MiB from
 * the game server because a CDN host is challenging, so it stops with one clear, retryable error instead. Two
 * consecutive CDN failures trip a breaker for {@link CDN_COOL_OFF_MS} either way.
 */
export async function fetchResource(url, options) {
  const signal = options?.signal;
  const allowOrigin = options?.allowOrigin !== false;
  const twin = siteCopy(url);
  const blocked = () => cdnBlockedUntil > 0 && Date.now() < cdnBlockedUntil;
  const unavailable = (err, fatal) => Object.assign(
    new Error('素材 CDN 暂时不可用（被浏览器挑战或连不上）；确认素材域名没有拦住浏览器后再重试预载'),
    { status: err?.status ?? null, transient: true, fatal });
  if (!twin) return attempt(url, options);
  // The CDN is asked first, always. The breaker only keeps bulk work (allowOrigin:false) from re-discovering the
  // same refusal 27 000 times; a runtime image is one request and keeps probing it, so a recovered CDN is used again.
  if (blocked() && !allowOrigin) { checkAbort(signal); throw unavailable(null, true); }
  try {
    const response = await attempt(url, options);
    cdnFails = 0; cdnBlockedUntil = 0;
    return response;
  } catch (err) {
    checkAbort(signal); // an abort is the caller's, never the CDN's
    const tripped = ++cdnFails >= CDN_TRIP;
    if (tripped) { cdnFails = 0; cdnBlockedUntil = Date.now() + CDN_COOL_OFF_MS; }
    // Bulk preload stops here: one clear failure beats 27 000 origin downloads (and the owner's bandwidth).
    if (!allowOrigin) throw unavailable(err, tripped);
    return fromOrigin(twin, options, signal, tripped);
  }
}

/** The game host's copy within this page's fallback budget; a fatal error stops a bulk run instead of draining it. */
async function fromOrigin(twin, options, signal, tripped = false) {
  if (!takeOriginBudget(0)) {
    throw Object.assign(new Error('素材 CDN 不可用，源站回退已达本次会话上限；稍后再试'), { transient: true, fatal: true });
  }
  const response = await attempt(twin, options);
  originBytes += Number(response.headers.get('Content-Length')) || 0;
  checkAbort(signal);
  if (tripped) void 0;
  return response;
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
