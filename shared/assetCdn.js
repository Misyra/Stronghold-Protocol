/** Public art only: game data, scripts, APIs and sockets stay on the game host. */
const ART_PATH = /^(?:\/_v\/[a-f0-9]{16})?(\/(?:assets|fonts|media)\/.*)$/;

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

/** Strip the game host's version: only the CDN's own version can address its immutable resources. */
export function assetCdnUrl(url, { base = '', version = '' } = {}) {
  if (!base || typeof url !== 'string') return url;
  const match = ART_PATH.exec(url);
  return match ? `${base}${version ? '/_v/' + version : ''}${match[1]}` : url;
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
