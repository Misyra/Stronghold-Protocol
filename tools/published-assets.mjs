// R2 URL versions and preload fingerprints must describe the same published bytes.
import { hashFile } from '../server/fileHash.js';
import { createHash } from 'node:crypto';

export async function fingerprintPublishedAsset(abs) {
  const { hash, version, bytes } = await hashFile(abs, { publication: true });
  return { hash: version, contentHash: hash, size: bytes };
}

export function publishedAssetsManifest(files) {
  const sorted = [...files].sort((a, b) => a.key.localeCompare(b.key, 'en'));
  const tag = createHash('sha256'), hashes = {}, preload = {};
  for (const f of sorted) {
    tag.update(f.key + '\0' + f.hash + '\0');
    hashes['/' + f.key] = f.hash;
    preload['/' + f.key] = { hash: f.contentHash, size: f.size };
  }
  return { tag: tag.digest('hex').slice(0, 16), hashes, preload };
}
