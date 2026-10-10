// Manifest-whitelisted read-through cache. The worker owns in-flight sharing; the page remains the sole index writer.
import { CACHE_NAME, CONTENT_HASH_RE, MAX_FILE_BYTES, absoluteUrl, mediaCandidates, rangeResponse } from './common.js';
import { resourceDigests } from './integrity.js';
import { fetchResource } from './network.js';
import { handleResourceRequest } from './service.js';

export function createResourceResponder({ caches = globalThis.caches, fetcher = globalThis.fetch?.bind(globalThis),
  getManifest, origin = globalThis.location?.origin || 'http://localhost', network = {} }) {
  const pending = new Map();
  const writes = new Set();
  let enabled = true;
  let epoch = 0;
  let indexedManifest;
  let byUrl = new Map();
  let byPath = new Map();

  async function mode(value) {
    enabled = !!value; epoch++;
    // An acknowledgement means clear/import may safely mutate Cache Storage without a late worker write.
    await Promise.allSettled([...writes]);
  }

  async function lookup(url) {
    const manifest = await getManifest();
    if (manifest !== indexedManifest) {
      indexedManifest = manifest; byUrl = new Map(); byPath = new Map();
      for (const file of manifest?.files || []) {
        if (!CONTENT_HASH_RE.test(file.hash || '') || file.size > MAX_FILE_BYTES) continue;
        const key = absoluteUrl(file.url, origin);
        byUrl.set(key, file); byPath.set(new URL(key).pathname, file);
      }
    }
    const exact = byUrl.get(absoluteUrl(url.href, origin));
    if (exact) return exact;
    // A versioned or otherwise queried request must never be silently served another revision.
    if (url.search) return null;
    for (const path of mediaCandidates(url.pathname).length ? mediaCandidates(url.pathname) : [url.pathname]) {
      const candidate = byPath.get(path);
      if (candidate && (url.origin === origin || new URL(candidate.url, origin).origin === url.origin)) return candidate;
    }
    return null;
  }

  async function persist(cache, key, response, generation) {
    if (!enabled || generation !== epoch) return;
    if (!cache) return;
    const write = cache.put(key, response.clone());
    writes.add(write);
    try { await write; } catch { /* cache quota/errors must not interrupt the game */ }
    finally { writes.delete(write); }
  }

  async function load(file, key, generation) {
    const cache = await caches.open(CACHE_NAME).catch(() => null);
    const cached = await cache?.match(key).catch(() => null);
    if (cached?.headers.get('X-SP-Resource-Hash') === file.hash) return cached;
    if (cached) {
      try {
        const bytes = await cached.clone().arrayBuffer();
        if (bytes.byteLength <= MAX_FILE_BYTES && (await resourceDigests(bytes)).hash === file.hash) {
          const headers = new Headers(cached.headers); headers.set('X-SP-Resource-Hash', file.hash);
          const marked = new Response(bytes, { headers });
          await persist(cache, key, marked, generation);
          return marked;
        }
      } catch { /* unreadable cache entries must not prevent normal game loading */ }
    }
    const response = await fetchResource(key, { ...network, fetcher });
    const bytes = await response.arrayBuffer();
    let digest;
    try { digest = await resourceDigests(bytes); }
    catch { return new Response(bytes, { headers: response.headers }); }
    // Return playable bytes even if a broken CDN serves the wrong revision, but never mark/cache them as current.
    if (digest.hash !== file.hash || (file.size != null && bytes.byteLength !== file.size)) return new Response(bytes, { headers: response.headers });
    const headers = new Headers(response.headers);
    headers.set('X-SP-Resource', '1'); headers.set('X-SP-Resource-Hash', file.hash); headers.set('Accept-Ranges', 'bytes');
    const stored = new Response(bytes, { headers });
    await persist(cache, key, stored, generation);
    return stored;
  }

  async function respond(request) {
    const url = new URL(request.url);
    // The store's integrity retry must reach the network even when a previous request is in flight.
    if (url.searchParams.has('sp')) return fetcher(request);
    let file;
    try { file = await lookup(url); } catch { /* manifest unavailable: preserve normal game loading */ }
    if (!file || !enabled) return (await handleResourceRequest(request, { caches }).catch(() => null)) || fetcher(request);
    const key = absoluteUrl(file.url, origin);
    let job = pending.get(key);
    if (!job) {
      job = load(file, key, epoch).finally(() => { if (pending.get(key) === job) pending.delete(key); });
      pending.set(key, job);
    }
    // Requests own independent bodies; cancelling a preload must not cancel a simultaneous game image/audio load.
    let response;
    try { response = (await job).clone(); }
    catch (err) {
      // Public images may work without CORS even when the CDN cannot support verified preloading.
      if (request.mode === 'no-cors' && err instanceof TypeError) return fetcher(request);
      throw err;
    }
    const range = request.headers.get('Range');
    return range ? rangeResponse(response, range) : response;
  }

  return { respond, mode };
}
