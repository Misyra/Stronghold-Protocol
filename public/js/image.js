import { assetSiteUrl } from '../../shared/assetCdn.js';
import { takeOriginBudget } from './resources/network.js';

const refreshes = new Map();
const recoveries = new WeakMap();
/** URLs the browser could only decode from the game host's own copy (a CDN that challenges every request). */
const copies = new Map();

/** The game host's copy of a CDN URL, or '' when `url` is already local / this origin owns it. */
function siteCopy(url) {
  const base = globalThis.__spAssetCdn?.base || '';
  const siteOrigin = globalThis.location?.origin || '';
  if (!base && !siteOrigin) return '';
  return assetSiteUrl(url, { base, siteOrigin });
}

/** Only a foreign origin needs CORS. Asking the game host for CORS would drop its session cookie — exactly
 *  the credential a challenge-protected host wants to see. */
function foreignOrigin(url) {
  const here = globalThis.location;
  if (!here) return true; // no document origin to compare against: keep the anonymous request
  try { return new URL(url, here.href).origin !== here.origin; } catch { return true; }
}

/** Replace a browser HTTP-cache entry once, sharing concurrent repairs of the same URL. */
function refreshImage(url) {
  if (refreshes.has(url)) return refreshes.get(url);
  const pending = (async () => {
    const response = await fetch(url, { mode: 'cors', credentials: 'same-origin', cache: 'reload', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`image failed: ${url}`);
    await response.arrayBuffer();
  })().finally(() => { if (refreshes.get(url) === pending) refreshes.delete(url); });
  refreshes.set(url, pending);
  return pending;
}

/**
 * Load an image for Canvas/WebGL/texture use. A legacy non-CORS cache entry gets one repair; a CDN that
 * refuses the page (`Under Attack` challenges an anonymous fetch) gets one switch to the host's own copy.
 */
export function loadImageElement(url, { refresh = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no Image in this environment')); return; }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new RangeError('invalid image timeout')); return; }
    let current = null, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (current) {
        current.onload = current.onerror = null;
        if (error?.name === 'TimeoutError') current.src = '';
      }
      if (error) reject(error); else resolve(value);
    };
    const fail = () => finish(new Error(`image failed: ${url}`));
    const timer = setTimeout(() => finish(Object.assign(new Error(`image timed out: ${url}`), { name: 'TimeoutError' })), timeoutMs);
    const source = () => copies.get(url) || url;
    const repair = () => refreshImage(source()).then(() => load(true), () => {
      const twin = siteCopy(url);
      // Same page-wide budget as the transport: a blocked CDN may only pull so much from the game host.
      if (!twin || copies.get(url) === twin || !takeOriginBudget(0)) { fail(); return; }
      copies.set(url, twin);
      refreshImage(twin).then(() => load(true), fail);
    });
    const load = (fresh) => {
      if (settled) return;
      const img = current = new Image();
      img.decoding = 'async';
      if (foreignOrigin(source())) img.crossOrigin = 'anonymous';
      img.onload = () => finish(null, img);
      img.onerror = () => {
        img.onload = img.onerror = null;
        if (fresh || typeof fetch !== 'function') fail(); else void repair();
      };
      img.src = source();
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
    const retry = copies.get(src) || src;
    // A same-origin image needs no CORS at all, and the anonymous request is what a challenged host refuses.
    if (!foreignOrigin(retry)) img.removeAttribute?.('crossorigin');
    img.src = retry;
  }, () => {
    if (!current()) return;
    state.pending = false;
    fallback?.(event);
  });
}
