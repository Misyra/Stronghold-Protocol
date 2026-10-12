const refreshes = new Map();
const recoveries = new WeakMap();

/** Replace a browser HTTP-cache entry once, sharing concurrent repairs of the same URL. */
function refreshImage(url) {
  if (refreshes.has(url)) return refreshes.get(url);
  const pending = (async () => {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`image failed: ${url}`);
    await response.arrayBuffer();
  })().finally(() => { if (refreshes.get(url) === pending) refreshes.delete(url); });
  refreshes.set(url, pending);
  return pending;
}

/** Anonymous images can safely enter Canvas/WebGL; legacy non-CORS cache entries get one repair. */
export function loadImageElement(url, { refresh = false } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no Image in this environment')); return; }
    const fail = () => reject(new Error(`image failed: ${url}`));
    const repair = () => refreshImage(url).then(() => load(true), fail);
    const load = (fresh) => {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => { img.onload = img.onerror = null; resolve(img); };
      img.onerror = () => {
        img.onload = img.onerror = null;
        if (fresh || typeof fetch !== 'function') fail(); else void repair();
      };
      img.src = url;
    };
    if (refresh) void repair(); else load(false);
  });
}

/** DOM images follow the same policy; only report permanent failures to existing UI fallbacks. */
export function recoverImageError(event, fallback) {
  const img = event.currentTarget;
  const src = img?.getAttribute('src');
  if (!src) { fallback?.(event); return; }
  const previous = recoveries.get(img);
  if (previous?.src === src) {
    if (!previous.pending) fallback?.(event);
    return;
  }
  const state = { src, pending: true };
  recoveries.set(img, state);
  const current = () => img.isConnected && img.getAttribute('src') === src && recoveries.get(img) === state;
  void loadImageElement(src, { refresh: true }).then(() => {
    if (!current()) return;
    state.pending = false;
    img.src = src;
  }, () => {
    if (!current()) return;
    state.pending = false;
    fallback?.(event);
  });
}
