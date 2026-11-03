// Path of one preload-manifest URL inside an install's public directory, shared by the pack builder
// (tools/build-resource-packs.mjs). The URL comes from data, so it is checked after decoding: `%2F`/`%5C` are refused
// outright and `server/resources.js#localPathFor` rejects `.`/`..` segments and anything that resolves outside the root.
import { localPathFor } from '../server/resources.js';

/**
 * @param {string} publicDir the install's `public/` directory
 * @param {string} url a site resource URL (`/assets/…`, brackets still `%5B`-escaped)
 * @returns {string|null} the file to hash/build from, or null when the URL would escape `publicDir`
 */
export function resourcePackPath(publicDir, url) {
  if (typeof url !== 'string' || /%2f|%5c/i.test(url)) return null;
  return localPathFor(url, publicDir);
}
