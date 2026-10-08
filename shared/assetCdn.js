/** Public art only: game data, scripts, APIs and sockets stay on the game host. The suffix group
 *  keeps a caller's own query/fragment (the release-prefix shape re-emits it verbatim). */
const ART_PATH = /^(?:\/_v\/[a-f0-9]{16})?(\/(?:assets|fonts|media)\/[^?#]*)([?#].*)?$/;

export function assetCdnSettings(base, version) {
  const value = String(base ?? '').trim();
  let normalized = '';
  if (value) {
    let url;
    try { url = new URL(value); } catch { throw new TypeError('SP_ASSETS_CDN must be an http(s) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('SP_ASSETS_CDN must be an http(s) base URL without credentials, query or fragment');
    }
    normalized = url.href.replace(/\/+$/, '');
  }
  const tag = String(version ?? '').trim();
  if (tag && !/^[a-f0-9]{16}$/.test(tag)) throw new TypeError('SP_ASSETS_CDN_VERSION must be the CDN server\'s 16-character artVersion');
  if (tag && !normalized) throw new TypeError('SP_ASSETS_CDN_VERSION requires SP_ASSETS_CDN');
  return { base: normalized, version: tag };
}

/** Strip the game host's version and address the CDN copy. Three shapes, first match wins:
 *  - per-file manifest mode (`hashes`): `<base><path>?v=<file hash>` — a query the CDN's cache keys
 *    on, so a release re-busts only the files it changed and every URL is immutable;
 *  - release-prefix mode (`version`): `<base>/_v/<tag><path>` — the whole-tree snapshot layout of
 *    pre-manifest buckets;
 *  - bare: `<base><path>` — a CDN without any release route (or a manifest-mode URL whose file the
 *    manifest does not list). */
export function assetCdnUrl(url, { base = '', version = '', manifest = '', hashes = null } = {}) {
  if (!base || typeof url !== 'string') return url;
  const own = url.startsWith(base + '/');
  // Keep published URLs (including a preload retry's &sp=) intact. Derived, bare URLs on
  // this CDN still need their own file hash; other origins never enter this rewrite.
  if (own && /[?&]v=[a-f0-9]{16}(?:[&#]|$)/.test(url)) return url;
  const local = own ? url.slice(base.length) : url;
  const match = ART_PATH.exec(local);
  if (!match) return url;
  const path = match[1];
  // R2 serves CSS verbatim. Keep stylesheets on the game host so its CSS transformer
  // can attach each font/image's hash instead of leaving their nested URLs unversioned.
  if (manifest && path.endsWith('.css')) return local;
  let key = path;
  try { key = decodeURI(path); } catch { /* malformed escaping keeps the ordinary fallback */ }
  const hash = hashes?.[key];
  if (hash) return `${base}${path}?v=${hash}`;
  if (manifest) return `${base}${path}`;
  return `${base}${version ? '/_v/' + version : ''}${path}${match[2] || ''}`;
}

/** The CDN's published current-release tag (tools/r2-sync.mjs writes it). A timestamp query keeps the
 *  request out of every cache: the free plan's cache keys include the query string, so this always reads R2. */
export function cdnLatestUrl(base, { now = Date.now } = {}) {
  const value = String(base ?? '').trim().replace(/\/+$/, '');
  return value ? `${value}/_v/latest?t=${now()}` : null;
}

/** Resolve the CDN's current release tag from `<base>/_v/latest` so deployments need not set
 *  SP_ASSETS_CDN_VERSION by hand. Any failure (no base, unreachable CDN, non-OK, junk body)
 *  returns '' — the unversioned mode the server already speaks — never an error. */
export async function resolveAssetsCdnVersion(base, { fetcher = globalThis.fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  const url = cdnLatestUrl(base, { now });
  if (!url || typeof fetcher !== 'function') return '';
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return '';
    const tag = (await res.text()).trim();
    return /^[a-f0-9]{16}$/.test(tag) ? tag : '';
  } catch {
    return '';
  }
}
