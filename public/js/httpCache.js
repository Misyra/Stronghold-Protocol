// public/js/httpCache.js — a memory-only cache for the few endpoints a page polls.
//
// Those endpoints (`/healthz?build=1`) answer differently over time without changing their URL, so the
// browser must never keep them: the requests still go out with `cache: 'no-store'`. What is pure waste is one page
// asking twice inside a few seconds — a tab restored from the background, a visibility resume right after a tick,
// two components reading the same counter. Each call site owns its TTL; a body is never older than that TTL.
//
// Entries are keyed by the fetcher as well as the URL: two different fetchers (a test stub, a wrapped fetch that
// adds headers) are two different sources of truth and must not share a cache line.
const stores = new WeakMap();

const storeOf = (fetchFn) => {
  let store = stores.get(fetchFn);
  if (!store) { store = new Map(); stores.set(fetchFn, store); }
  return store;
};

/** Drop one URL's cached body for this fetcher, or the whole store when called without a URL. */
export function forgetCachedJson(fetchFn, url) {
  if (typeof fetchFn !== 'function') return;
  if (url === undefined) stores.delete(fetchFn); else stores.get(fetchFn)?.delete(url);
}

/**
 * `fetchFn(url, init)` → parse → remember the body. A later call within `ttlMs` reuses it; a call after `ttlMs`, or a
 * call with `ttlMs: 0`, reads the server and REPLACES the entry — the cache always holds the newest body this page has
 * seen, so a fresh read can never be undone by a stale reuse. Never throws.
 * @param {Function} fetchFn
 * @param {string} url
 * @param {{ ttlMs?: number, init?: object, now?: () => number, parse?: (res: any) => Promise<any> }} [o]
 * @returns {Promise<{ ok: boolean, value?: any, status?: number, error?: any, cached: boolean }>}
 */
export async function cachedJson(fetchFn, url, o = {}) {
  const ttlMs = Number.isFinite(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : 0;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  if (ttlMs > 0) {
    const hit = stores.get(fetchFn)?.get(url);
    if (hit && now() - hit.at < ttlMs) return { ok: true, value: hit.value, cached: true };
  }
  let res;
  try { res = await fetchFn(url, o.init); }
  catch (error) { return { ok: false, error, cached: false }; }
  if (!res || !res.ok) return { ok: false, status: res ? res.status : 0, cached: false };
  let value;
  try { value = o.parse ? await o.parse(res) : await res.json(); }
  catch (error) { return { ok: false, error, cached: false }; }
  storeOf(fetchFn).set(url, { at: now(), value });
  return { ok: true, value, cached: false };
}
