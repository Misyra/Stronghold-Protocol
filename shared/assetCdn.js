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
