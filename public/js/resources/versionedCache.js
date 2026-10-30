import { cachedResourceHash } from './cacheMetadata.js';
import { CACHE_PREFIX, CONTENT_HASH_RE, MAX_FILE_BYTES, SHARD_CACHE_NAMES, fxCacheName, isResourcePath } from './common.js';

/** A per-file CDN SHA-256 prefix proves the requested revision without waiting
 * for the worker manifest. Never strip an arbitrary query or a release tag. */
export function createVersionedCacheReader(caches) {
  const verified = new Map();
  let active = 0;
  const queue = [];
  const read = async (job) => {
    if (active < 2) active++;
    else await new Promise((resolve) => queue.push(resolve));
    try { return await job(); }
    finally { const next = queue.shift(); if (next) next(); else active--; }
  };
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !isResourcePath(url.pathname)
      || !/^\?v=[a-f0-9]{16}$/.test(url.search) || url.pathname.startsWith('/_v/')) return null;
    const expected = url.search.slice(3);
    const bare = new URL(url); bare.search = '';
    const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
    const preferred = url.pathname.includes('/assets/local/fx/') ? fxCacheName(url.href) : '';
    const rank = (name) => name === preferred ? -1 : Number(!SHARD_CACHE_NAMES.includes(name));
    names.sort((a, b) => rank(a) - rank(b));
    for (const name of names) {
      const cache = await caches.open(name);
      for (const key of [bare.href, url.href]) {
        const response = await cache.match(key);
        const hash = cachedResourceHash(response);
        if (!response || !CONTENT_HASH_RE.test(hash || '')) continue;
        const size = response.headers.get('Content-Length');
        if (size == null || !/^\d+$/.test(size) || Number(size) > MAX_FILE_BYTES) continue;
        const proofKey = `${name}|${key}|${hash}|${size}|${expected}`;
        let proof = verified.get(proofKey);
        if (!proof) {
          proof = read(async () => {
            const bytes = await response.clone().arrayBuffer();
            if (bytes.byteLength !== Number(size) || bytes.byteLength > MAX_FILE_BYTES) return false;
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const prefix = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
            return prefix === expected;
          }).catch(() => false);
          if (verified.size >= 512) verified.delete(verified.keys().next().value);
          verified.set(proofKey, proof);
        }
        if (await proof) return response;
        verified.delete(proofKey);
      }
    }
    return null;
  };
}
