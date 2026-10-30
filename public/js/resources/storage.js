// Estimates are advisory: browser quotas can change, and Cache Storage adds overhead.
export async function storageEstimate({ requiredBytes = 0, unknownFiles = 0, storage = globalThis.navigator?.storage } = {}) {
  let estimate;
  try { estimate = await storage?.estimate?.(); } catch { /* quota errors remain authoritative */ }
  const usage = Number.isFinite(estimate?.usage) && estimate.usage >= 0 ? estimate.usage : null;
  const quota = Number.isFinite(estimate?.quota) && estimate.quota >= 0 ? estimate.quota : null;
  const available = usage != null && quota != null ? Math.max(0, quota - usage) : null;
  return { usage, quota, available, requiredBytes, unknownFiles,
    low: available != null && requiredBytes > available };
}

/** Whether this origin's storage is persistent (`navigator.storage.persist()`): without it a preload of hundreds of
 * MiB is the first thing the browser throws away when the disk fills up. Memoized per storage object, never throws. */
const persistence = new WeakMap();

/** @returns {Promise<{granted: boolean, supported: boolean}>} */
export function ensurePersistence({ storage = globalThis.navigator?.storage } = {}) {
  if (!storage) return Promise.resolve({ granted: false, supported: false });
  let pending = persistence.get(storage);
  if (!pending) {
    pending = (async () => {
      try {
        if (typeof storage.persisted !== 'function' || typeof storage.persist !== 'function') return { granted: false, supported: false };
        if (await storage.persisted()) return { granted: true, supported: true };
        return { granted: !!(await storage.persist()), supported: true };
      } catch {
        return { granted: false, supported: false };
      }
    })();
    persistence.set(storage, pending);
  }
  return pending;
}

export function missingStorage(store, status, includeOptional) {
  let requiredBytes = 0, unknownFiles = 0;
  for (const file of store.selectedFiles) {
    if (!store.eligible(file) || (!includeOptional && file.tier !== 1) || status.present.has(store.keyOf(file.url))) continue;
    if (Number.isSafeInteger(file.size)) requiredBytes += file.size;
    else unknownFiles++;
  }
  return { requiredBytes, unknownFiles };
}
