// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
import { checkAbort } from './common.js';
import { readTransportPack } from './archive.js';
import { isResourcePackUrl } from '../../../shared/resourcePackRoutes.js';

/** Try each mirror once, authenticate the complete ZIP, then allow cache import. */
export async function fetchTransportPack(pack, { signal, onProgress, selectedPaths,
  fetcher = globalThis.fetch, idleMs = 30000, timeoutMs = 180000 } = {}) {
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
  let lastError;
  for (const url of urls) {
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let idleTimer;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('资源分包线路响应超时')), idleMs);
    };
    const deadline = setTimeout(() => controller.abort(new Error('资源分包线路下载超时')), timeoutMs);
    try {
      onProgress?.(0);
      touch();
      const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`资源分包 HTTP ${response.status}`);
      }
      touch();
      return await readTransportPack(response, pack, { signal: controller.signal, selectedPaths,
        onProgress: (loaded) => { touch(); onProgress?.(loaded); } });
    } catch (error) {
      // User/combat/scope cancellation stops the entire run; only route failures advance.
      checkAbort(signal);
      lastError = controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  throw lastError;
}
