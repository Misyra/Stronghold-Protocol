// R2 URL versions and preload fingerprints must describe the same published bytes.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export async function fingerprintPublishedAsset(abs) {
  const sha256 = createHash('sha256'), sha1 = createHash('sha1');
  let size = 0;
  for await (const chunk of fs.createReadStream(abs)) {
    sha256.update(chunk); sha1.update(chunk); size += chunk.length;
  }
  return { hash: sha256.digest('hex').slice(0, 16), contentHash: sha1.digest('hex').slice(0, 12), size };
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
