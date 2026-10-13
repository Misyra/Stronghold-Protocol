import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

/** Stream once, optionally compute the publication hash alongside the preload fingerprint. */
export async function hashFile(abs, { publication = false } = {}) {
  const sha1 = createHash('sha1'), sha256 = publication ? createHash('sha256') : null;
  let bytes = 0;
  for await (const chunk of createReadStream(abs, { highWaterMark: 1 << 20 })) {
    bytes += chunk.length; sha1.update(chunk); sha256?.update(chunk);
  }
  return { hash: sha1.digest('hex').slice(0, 12), bytes, ...(sha256 ? { version: sha256.digest('hex').slice(0, 16) } : {}) };
}
