import { cachedResourceHash, markResourceHeaders } from './cacheMetadata.js';
import { resourceIdentity } from '../../../shared/resourcePaths.js';
// Manifest-whitelisted read-through cache. The worker owns in-flight sharing; the page remains the sole index writer.
import { CACHE_PREFIX, CONTENT_HASH_RE, MAX_FILE_BYTES, absoluteUrl, cacheNameForFile, mediaCandidates, rangeResponse } from './common.js';
import { resourceDigests } from './integrity.js';
import { fetchResource } from './network.js';
import { queueRuntimeIndexEntry } from './runtimeIndex.js';
import { handleResourceRequest } from './service.js';
import { createVersionedCacheReader } from './versionedCache.js';

export function createResourceResponder({ caches = globalThis.caches, fetcher = globalThis.fetch?.bind(globalThis),
  getManifest, origin = globalThis.location?.origin || 'http://localhost', network = {} }) {
  const pending = new Map();
  const writes = new Set();
  const readVersionedCache = createVersionedCacheReader(caches);
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
        byUrl.set(key, file); byPath.set(resourceIdentity(key), file);
      }
    }
    const exact = byUrl.get(absoluteUrl(url.href, origin));
    if (exact) return exact;
    // A versioned or otherwise queried request must never be silently served another revision.
    if (url.search) return null;
    for (const path of mediaCandidates(url.pathname).length ? mediaCandidates(url.pathname) : [url.pathname]) {
      const candidate = byPath.get(resourceIdentity(path));
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

  /** Store a verified body and record it as a runtime entry: the next status() then knows it exists without a body
   *  read, and a sweep of the cache cannot mistake that record for a stale asset (resources/runtimeIndex.js). */
  async function keep(cache, key, response, generation) {
    const result = await persist(cache, key, response, generation);
    if (result.stored) void queueRuntimeIndexEntry(cache, origin, key).catch(() => {});
    return result;
  }

  async function load(file, key, generation, allowOrigin = true) {
    let openError;
    const own = cacheNameForFile(file);
    const cache = await caches.open(own).catch((error) => { openError = error; return null; });
    // The file's own card first, then any other cache this app owns: an install from before the cards were split still
    // holds these bytes in the catch-all cache (the page's tidy pass moves them), and they must not be fetched again.
    let owner = cache;
    let cached = await cache?.match(key).catch(() => null);
    if (!cached) {
      for (const name of (await caches.keys().catch(() => [])) || []) {
        if (name === own || !name.startsWith(CACHE_PREFIX)) continue;
        const other = await caches.open(name).catch(() => null);
        const hit = await other?.match(key).catch(() => null);
        if (hit) { owner = other; cached = hit; break; }
      }
    }
    if (cachedResourceHash(cached) === file.hash) return { response: cached, stored: true, downloaded: false };
    if (cached) {
      try {
        const bytes = await cached.clone().arrayBuffer();
        if (bytes.byteLength <= MAX_FILE_BYTES && (await resourceDigests(bytes)).hash === file.hash) {
          const headers = new Headers(cached.headers); markResourceHeaders(headers, file.hash);
          const marked = new Response(bytes, { headers });
          return { response: marked, ...await keep(cache, key, marked, generation), downloaded: false };
        }
      } catch { /* unreadable cache entries must not prevent normal game loading */ }
      // A stale copy in another card must not shadow the fresh bytes stored below.
      if (owner !== cache) await owner.delete(key).catch(() => {});
    }
    // The page's preload handoff is bulk work; a game request on screen is one picture and may use the host copy.
    const response = await fetchResource(key, { ...network, fetcher, allowOrigin });
    const bytes = await response.arrayBuffer();
    let digest;
    try { digest = await resourceDigests(bytes); }
    catch { return { response: new Response(bytes, { headers: response.headers }), stored: false }; }
    // Return playable bytes even if a broken CDN serves the wrong revision, but never mark/cache them as current.
    if (digest.hash !== file.hash || (file.size != null && bytes.byteLength !== file.size)) return { response: new Response(bytes, { headers: response.headers }), stored: false };
    const headers = new Headers(response.headers);
    markResourceHeaders(headers, file.hash);
    const stored = new Response(bytes, { headers });
    return { response: stored, error: openError, ...await keep(cache, key, stored, generation), downloaded: true };
  }

  function sharedLoad(file, key, allowOrigin = true) {
    let job = pending.get(key);
    if (!job || job.generation !== epoch) {
      job = { generation: epoch };
      job.promise = load(file, key, epoch, allowOrigin).finally(() => { if (pending.get(key) === job) pending.delete(key); });
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
      const cache = await caches.open(cacheNameForFile(file));
      const cached = await cache.match(url);
      // Only local writers issue this marker after verification. Raw network headers cannot reach this branch.
      if (cachedResourceHash(cached) !== hash) return null;
      result = { stored: true, downloaded: false };
    } else result = await sharedLoad(file, url, false); // a preload handoff never drains the game server
    if (!enabled || generation !== epoch) return null;
    if (result.error) throw result.error;
    return result.stored ? { cached: true, url, hash, size: file.size ?? null, downloaded: !!result.downloaded } : null;
  }

  async function respond(request) {
    const url = new URL(request.url);
    // The store's integrity retry must reach the network even when a previous request is in flight.
    if (url.searchParams.has('sp')) return fetcher(request);
    // Preload keys are canonical bare URLs, while renderers request ?v=<SHA-256>.
    // Authenticate that exact revision locally, even during a cold worker start.
    const local = await readVersionedCache(request).catch(() => null);
    if (local) {
      const range = request.headers.get('Range');
      return range ? rangeResponse(local, range) : local;
    }
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
