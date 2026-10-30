import { CONTENT_HASH_RE } from './common.js';

const MARKER = 'X-SP-Resource';
const HASH = 'X-SP-Resource-Hash';

export function cachedResourceHash(response) { return response?.headers.get(HASH) ?? null; }
export function markResourceHeaders(headers, hash) {
  headers.set(MARKER, '1');
  if (CONTENT_HASH_RE.test(hash || '')) headers.set(HASH, hash);
  else headers.delete(HASH);
  headers.set('Accept-Ranges', 'bytes');
  return headers;
}

export function cacheIndex(files, manifest) {
  return { version: 1, manifest: String(manifest || ''), files };
}
export function readCacheIndex(doc) {
  const supported = doc && typeof doc === 'object' && (doc.version == null || doc.version === 1);
  const files = supported && doc.files && typeof doc.files === 'object' && !Array.isArray(doc.files) ? doc.files : {};
  return { manifest: supported && typeof doc.manifest === 'string' ? doc.manifest : '', files: { ...files } };
}
