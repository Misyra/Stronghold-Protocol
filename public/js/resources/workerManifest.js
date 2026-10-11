import { resourceManifestUrl, validateManifest } from './common.js';
import { fetchResource } from './network.js';

/** One shared read per worker lifetime; errors cool down without poisoning future attempts. */
export function createWorkerManifestLoader({ scriptUrl, fetcher = globalThis.fetch?.bind(globalThis), now = Date.now,
  retryDelayMs = 10000, timeoutMs = 10000 }) {
  const script = new URL(scriptUrl);
  const plain = new URL(resourceManifestUrl(''), script.origin).href;
  let url = new URL(resourceManifestUrl(script.searchParams.get('v') || ''), script.origin).href;
  let pending = null, retryAt = 0;
  async function load() {
    let response;
    try { response = await fetchResource(url, { fetcher, timeoutMs, retries: 0, cache: 'no-cache' }); }
    catch (error) {
      // A surviving old worker can outlive its release. Only a version 404 permits fallback;
      // transient failures keep the original URL and must not fan out duplicate requests.
      if (error?.status !== 404 || url === plain) throw error;
      url = plain;
      response = await fetchResource(url, { fetcher, timeoutMs, retries: 0, cache: 'no-cache' });
    }
    return validateManifest(await response.json());
  }
  return () => {
    if (!pending && now() < retryAt) return Promise.resolve(null);
    pending ??= load().catch(error => { pending = null; retryAt = now() + retryDelayMs; throw error; });
    return pending;
  };
}
