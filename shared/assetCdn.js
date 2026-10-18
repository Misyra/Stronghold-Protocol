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

/** The game host's own copy of an asset-CDN URL: the same art path, without the per-file `?v=` cache-buster
 *  (the host answers with its own release prefix). An asset host can sit behind a browser challenge a
 *  credentials-less fetch can never answer — Cloudflare "Under Attack" challenges every request and only hands
 *  `cf_clearance` to a navigation — so a failed CDN attempt falls back to this twin. Same three shapes as
 *  `assetCdnUrl`: `<base><path>`, `<base>/_v/<tag><path>` and, with no base configured, a foreign origin's art path.
 *  @returns {string} the game host's URL, or '' when `url` is not art on this CDN. */
export function assetSiteUrl(url, { base = '', siteOrigin = '' } = {}) {
  if (typeof url !== 'string' || !url) return '';
  let pathname;
  let search = '';
  let origin = '';
  if (base) {
    if (!url.startsWith(base + '/')) return '';
    pathname = url.slice(base.length);
  } else {
    // No configured CDN: only a foreign http(s) copy of an art path has a host twin to answer with.
    let parsed;
    try { parsed = new URL(url); } catch { return ''; }
    if (!siteOrigin || parsed.origin === siteOrigin) return '';
    pathname = parsed.pathname;
    search = parsed.search;
    origin = siteOrigin;
  }
  const cut = pathname.search(/[?#]/);
  if (cut >= 0) { if (!search) search = pathname.slice(cut); pathname = pathname.slice(0, cut); }
  const match = ART_PATH.exec(pathname);
  if (!match) return '';
  const params = new URLSearchParams(search.replace(/^[?#]/, ''));
  params.delete('v'); // the host's release prefix already busts its cache; keep a retry's own marker
  const query = params.toString();
  return `${origin}${match[1]}${query ? '?' + query : ''}`;
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
