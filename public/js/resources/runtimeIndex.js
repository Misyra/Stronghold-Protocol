// Runtime metadata is separate from the preload hash index: a SW write must
// never replace a download/ZIP writer's fingerprint snapshot.
import { absoluteUrl } from './common.js';

export const RUNTIME_INDEX_PATH = '/__sp-runtime-resource-index__';
const INDEX_LOCK = 'stronghold-resources-runtime-index';
const pending = new Map();
export const RUNTIME_INDEX_FLUSH_MS = 250;
export const RUNTIME_INDEX_BATCH_SIZE = 64;

export const runtimeIndexUrl = (origin) => absoluteUrl(RUNTIME_INDEX_PATH, origin);

export async function readRuntimeIndex(cache, origin) {
  try {
    const hit = await cache.match(runtimeIndexUrl(origin));
    const doc = hit && await hit.json();
    if (doc?.version === 1 && doc.files && typeof doc.files === 'object' && !Array.isArray(doc.files)) {
      return { ...doc.files };
    }
  } catch { /* metadata loss is repaired by the next full check */ }
  return {};
}

/** Merge newly stored keys, or reconcile metadata against an authoritative scan.
 * Web Locks serialize tabs/workers; the local queue also supports older browsers.
 */
export function updateRuntimeIndex(cache, origin, { add = [], present } = {}) {
  // CacheStorage.open may return different Cache wrappers for the same cache.
  const queueKey = runtimeIndexUrl(origin);
  const previous = pending.get(queueKey) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const update = async () => {
      const files = await readRuntimeIndex(cache, origin);
      let changed = false;
      if (present) {
        for (const key of Object.keys(files)) {
          if (!present.has(key)) { delete files[key]; changed = true; }
        }
      }
      for (const key of add) {
        if (!Object.hasOwn(files, key)) { files[key] = null; changed = true; }
      }
      if (changed) await cache.put(runtimeIndexUrl(origin), new Response(JSON.stringify({ version: 1, files }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    };
    const locks = globalThis.navigator?.locks;
    return locks?.request ? locks.request(INDEX_LOCK, {}, update) : update();
  });
  pending.set(queueKey, work);
  void work.finally(() => { if (pending.get(queueKey) === work) pending.delete(queueKey); }).catch(() => {});
  return work;
}

/**
 * Coalesce successful runtime writes before reading/serializing the whole index.
 * The deadline starts at the first key, not the last: steady traffic cannot
 * postpone a small batch indefinitely. Each caller awaits its batch's disk
 * write so the fetch waitUntil and shared resource lock cover the entire flush.
 *
 * Repair/prune continue using updateRuntimeIndex immediately under an exclusive
 * resource lock; they must not join a delayed batch based on an older scan.
 * @param {{ delayMs?: number, maxEntries?: number, setTimer?: typeof setTimeout,
 *           clearTimer?: typeof clearTimeout }} [opts]
 */
export function createRuntimeIndexBatcher({
  delayMs = RUNTIME_INDEX_FLUSH_MS, maxEntries = RUNTIME_INDEX_BATCH_SIZE,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const batches = new Map();
  const flush = (queueKey, batch) => {
    if (batches.get(queueKey) !== batch) return;
    batches.delete(queueKey);
    if (batch.timer !== null) clearTimer(batch.timer);
    // Detach the batch before I/O; arrivals during this write belong to the next
    // batch and cannot be lost when this one's promise settles.
    void updateRuntimeIndex(batch.cache, batch.origin, { add: [...batch.keys] })
      .then(batch.resolve, batch.reject);
  };
  return (cache, origin, key) => {
    const queueKey = runtimeIndexUrl(origin);
    let batch = batches.get(queueKey);
    if (!batch) {
      batch = { cache, origin, keys: new Set(), timer: null, promise: null, resolve: null, reject: null };
      batch.promise = new Promise((resolve, reject) => { batch.resolve = resolve; batch.reject = reject; });
      batches.set(queueKey, batch);
    }
    batch.keys.add(key);
    if (batch.keys.size >= maxEntries) flush(queueKey, batch);
    else if (batch.timer === null) batch.timer = setTimer(() => flush(queueKey, batch), delayMs);
    return batch.promise;
  };
}

export const queueRuntimeIndexEntry = createRuntimeIndexBatcher();
