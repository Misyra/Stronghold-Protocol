import { assetCdnUrl } from '../../shared/assetCdn.js';

/** Release paths keep Spine's relative atlas/page references in the same cache namespace. */
export function resourceUrl(url, version = /^\/(?:assets|fonts|media)\//.test(url) ? globalThis.__spArtVersion : globalThis.__spAssetVersion) {
  const remote = assetCdnUrl(url, globalThis.__spAssetCdn);
  if (remote !== url) return remote;
  if (!version || typeof url !== 'string' || !/^\/(?:assets|data|vendor|fonts|js|shared|sim|media)\//.test(url)) return url;
  return `/_v/${version}${url}`;
}

/** A plain static host has no injected version: keep its previous revalidation behavior. */
export function resourceCache(url) {
  if (typeof url !== 'string') return 'no-cache';
  if (url.startsWith('/_v/')) return 'default';
  try {
    const parsed = new URL(url);
    if (/^\/_v\/[a-f0-9]{16}\//.test(parsed.pathname)) return 'default';
    const base = globalThis.__spAssetCdn?.base;
    if (base && url.startsWith(base + '/') && /^\/(?:assets|fonts|media)\//.test(url.slice(base.length))) return 'default';
  } catch { /* relative static-host paths keep the old revalidation behavior */ }
  return 'no-cache';
}
