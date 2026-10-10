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
    if (!enabled || generation !== epoch || !cache) return { stored: false };
    const write = cache.put(key, response.clone());
    writes.add(write);
    try { await write; return { stored: true }; }
    catch (error) { return { stored: false, error }; } // the game can play; preload must see quota failures
    finally { writes.delete(write); }
  }

  async function load(file, key, generation) {
    let openError;
    const cache = await caches.open(CACHE_NAME).catch((error) => { openError = error; return null; });
    const cached = await cache?.match(key).catch(() => null);
    if (cached?.headers.get('X-SP-Resource-Hash') === file.hash) return { response: cached, stored: true, downloaded: false };
    if (cached) {
      try {
        const bytes = await cached.clone().arrayBuffer();
        if (bytes.byteLength <= MAX_FILE_BYTES && (await resourceDigests(bytes)).hash === file.hash) {
          const headers = new Headers(cached.headers); headers.set('X-SP-Resource-Hash', file.hash);
          const marked = new Response(bytes, { headers });
          return { response: marked, ...await persist(cache, key, marked, generation), downloaded: false };
        }
      } catch { /* unreadable cache entries must not prevent normal game loading */ }
    }
    const response = await fetchResource(key, { ...network, fetcher });
    const bytes = await response.arrayBuffer();
    let digest;
    try { digest = await resourceDigests(bytes); }
    catch { return { response: new Response(bytes, { headers: response.headers }), stored: false }; }
    // Return playable bytes even if a broken CDN serves the wrong revision, but never mark/cache them as current.
    if (digest.hash !== file.hash || (file.size != null && bytes.byteLength !== file.size)) return { response: new Response(bytes, { headers: response.headers }), stored: false };
    const headers = new Headers(response.headers);
    headers.set('X-SP-Resource', '1'); headers.set('X-SP-Resource-Hash', file.hash); headers.set('Accept-Ranges', 'bytes');
    const stored = new Response(bytes, { headers });
    return { response: stored, error: openError, ...await persist(cache, key, stored, generation), downloaded: true };
  }

  function sharedLoad(file, key) {
    let job = pending.get(key);
    if (!job || job.generation !== epoch) {
      job = { generation: epoch };
      job.promise = load(file, key, epoch).finally(() => { if (pending.get(key) === job) pending.delete(key); });
      pending.set(key, job);
    }
    return job.promise;
  }

  // A private MessagePort acknowledgement, never an HTTP header, authorizes the page to skip hashing/writing.
  async function ensureCached({ url, hash, size, cachedOnly = false }) {
    if (!enabled || typeof url !== 'string') return null;
    const generation = epoch;
    let file;
    try { file = await lookup(new URL(url)); } catch { return null; } // unavailable/stale worker manifest: let the page verify
    if (!file || absoluteUrl(file.url, origin) !== url || file.hash !== hash || (file.size ?? null) !== (size ?? null)) return null;
    if (!enabled || generation !== epoch) return null;
    let result;
    if (cachedOnly) {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      // Only local writers issue this marker after verification. Raw network headers cannot reach this branch.
      if (cached?.headers.get('X-SP-Resource-Hash') !== hash) return null;
      result = { stored: true, downloaded: false };
    } else result = await sharedLoad(file, url);
    if (!enabled || generation !== epoch) return null;
    if (result.error) throw result.error;
    return result.stored ? { cached: true, url, hash, size: file.size ?? null, downloaded: !!result.downloaded } : null;
  }

  async function respond(request) {
    const url = new URL(request.url);
    // The store's integrity retry must reach the network even when a previous request is in flight.
    if (url.searchParams.has('sp')) return fetcher(request);
    let file;
    try { file = await lookup(url); } catch { /* manifest unavailable: preserve normal game loading */ }
    if (!file || !enabled) return (await handleResourceRequest(request, { caches }).catch(() => null)) || fetcher(request);
    const key = absoluteUrl(file.url, origin);
    // Requests own independent bodies; cancelling a preload must not cancel a simultaneous game image/audio load.
    let response;
    try { response = (await sharedLoad(file, key)).response.clone(); }
    catch (err) {
      // Public images may work without CORS even when the CDN cannot support verified preloading.
      if (request.mode === 'no-cors' && err instanceof TypeError) return fetcher(request);
      throw err;
    }
    const range = request.headers.get('Range');
    return range ? rangeResponse(response, range) : response;
  }

  return { respond, mode, ensureCached };
}
