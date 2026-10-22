// Only publish ZIPs named by the current index; old content-addressed packs stay
// available for older clients, but must not all be uploaded on every release.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function prepareResourcePackUpload(root) {
  const stateFile = path.join(root, '.resource-packs-published.json');
  let index;
  try { index = JSON.parse(await fs.readFile(path.join(root, 'data', 'resource-packs.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!index) return { jobs: [], commit: async () => {} };
  if (index.format !== 'stronghold-resource-pack-index' || index.version !== 1 || !Array.isArray(index.packs)) {
    throw new Error('Invalid data/resource-packs.json; rebuild with npm run resources:packs');
  }
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const hashes = {};
  const jobs = [];
  for (const pack of index.packs) {
    if (!/^\/resource-packs\/[A-Za-z0-9._-]+\.zip$/.test(pack.url || '') || !/^[a-f0-9]{40}$/.test(pack.sha1 || '')) {
      throw new Error('Invalid local resource pack URL/digest');
    }
    const key = pack.url.slice(1);
    if (hashes[key]) throw new Error(`Duplicate resource pack: ${key}`);
    const abs = path.join(root, 'public', key);
    const bytes = await fs.readFile(abs);
    const digest = createHash('sha1').update(bytes).digest('hex');
    if (bytes.length !== pack.size || digest !== pack.sha1) throw new Error(`Resource pack size/digest mismatch: ${key}`);
    hashes[key] = digest;
    if (previous[key] !== digest) jobs.push({ key, abs, cc: 'public, max-age=31536000, immutable' });
  }
  return { jobs, commit: async () => {
    const temporary = stateFile + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(hashes) + '\n');
    await fs.rename(temporary, stateFile);
  } };
}
