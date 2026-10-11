// Bounded full-body downloads. The deadline includes response headers AND body; retries never include a 404 or quota error.
import { MAX_FILE_BYTES, abortError, checkAbort } from './common.js';

export function waitForResource(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Read a complete, bounded response so a stalled body cannot hold a download lane forever. */
export async function fetchResource(url, { fetcher = globalThis.fetch?.bind(globalThis), signal,
  timeoutMs = 30000, retries = 2, retryDelayMs = 500, cache = /** @type {RequestCache} */ ('no-store') } = {}) {
  for (let attempt = 0; ; attempt++) {
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
        const response = await fetcher(url, { mode: 'cors', credentials: 'omit', cache, signal: controller.signal });
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
      const transient = err?.name === 'TimeoutError' || err instanceof TypeError || err?.transient
        || err?.status === 408 || err?.status === 429 || err?.status >= 500;
      if (!transient || attempt >= retries) throw err;
      // Retry-After is respected up to 30s; explicit pause also interrupts this backoff.
      clearTimeout(timer);
      await waitForResource(Math.min(30000, Math.max(0, err.retryAfter || 0, retryDelayMs * 2 ** attempt)), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (reader) void reader.cancel().catch(() => {});
    }
  }
}
