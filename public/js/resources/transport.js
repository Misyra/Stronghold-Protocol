// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
import { checkAbort } from './common.js';
import { readTransportPack } from './archive.js';
import { isResourcePackUrl } from '../../../shared/resourcePackRoutes.js';
import { waitForResource } from './network.js';

/** Bounded raw transfer: no hashing, ZIP parsing or cache writes in a network lane. */
async function readPackBytes(response, pack, signal, progress) {
  if (!response.body?.getReader || !Number.isSafeInteger(pack.size) || pack.size < 1 || pack.size > 16000000) {
    throw new Error('资源分包大小或响应流无效');
  }
  const bytes = new Uint8Array(pack.size), reader = response.body.getReader();
  let loaded = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const result = await reader.read();
      checkAbort(signal);
      if (result.done) break;
      if (loaded + result.value.byteLength > bytes.byteLength) throw new Error('资源分包超过索引声明大小');
      bytes.set(result.value, loaded); loaded += result.value.byteLength;
      progress(loaded);
    }
    if (loaded !== pack.size) throw new Error('资源分包下载不完整');
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

async function requestPack(pack, { signal, onProgress, onRoute,
  fetcher = globalThis.fetch, idleMs = 20000, headerMs = 20000, timeoutMs = 180000,
  retries = 1, retryDelayMs = 1000 } = {}, validate = null) {
  const key = (url) => new URL(url, globalThis.location?.origin || 'https://resources.invalid').href;
  const fallback = key(pack.url);
  const seen = new Set([fallback]);
  const urls = [...(Array.isArray(pack.urls) ? pack.urls : []).filter((url) => {
    if (!isResourcePackUrl(url)) return false;
    const canonical = key(url);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  }), pack.url];
  let lastError, retryable = false;
  for (const [route, url] of urls.entries()) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      checkAbort(signal);
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      let idleTimer;
      const touch = (ms = idleMs) => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error('资源分包线路响应超时')), ms);
      };
      const deadline = setTimeout(() => controller.abort(new Error('资源分包线路下载超时')), timeoutMs);
      try {
        onRoute?.({ route: route + 1, routes: urls.length, attempt: attempt + 1, attempts: retries + 1, retrying: false });
        onProgress?.(0);
        touch(headerMs);
        const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`资源分包 HTTP ${response.status}`), { status: response.status });
        }
        touch();
        let lastProgress = -Infinity;
        const bytes = await readPackBytes(response, pack, controller.signal, (loaded) => {
          touch();
          const now = performance.now();
          if (loaded === pack.size || now - lastProgress >= 250) { lastProgress = now; onProgress?.(loaded); }
        });
        // A local validation/import backlog is never a network idle timeout.
        clearTimeout(idleTimer); clearTimeout(deadline);
        checkAbort(signal);
        return validate ? await validate(bytes) : bytes;
      } catch (error) {
        // User/combat/scope cancellation stops the entire run; only route failures advance.
        checkAbort(signal);
        lastError = controller.signal.aborted ? controller.signal.reason : error;
        const transient = controller.signal.aborted || error instanceof TypeError
          || [408, 429, 500, 502, 503, 504].includes(error?.status);
        retryable ||= transient;
        if (!transient || attempt >= retries) break;
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        controller.abort();
      }
      onRoute?.({ route: route + 1, routes: urls.length, attempt: attempt + 2, attempts: retries + 1, retrying: true });
      await waitForResource(retryDelayMs * (attempt + 1), signal);
    }
  }
  if (lastError && typeof lastError === 'object') lastError.retryable = retryable;
  throw lastError;
}

export function downloadTransportPack(pack, options = {}) {
  return requestPack(pack, options);
}

/** Compatibility reader for callers needing an authenticated ZIP immediately. */
export function fetchTransportPack(pack, options = {}) {
  return requestPack(pack, options, (bytes) => readTransportPack(new Response(bytes), pack,
    { signal: options.signal, selectedPaths: options.selectedPaths }));
}
