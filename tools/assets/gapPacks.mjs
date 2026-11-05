// tools/assets/gapPacks.mjs — append-only "gap" helpers for tools/build-resource-packs.mjs.
//
// A gap build packages ONLY the manifest files the current data/resource-packs.json
// does not name yet, then appends the new pack entries to the index. It never
// rewrites, renumbers or removes an existing pack (AGENTS.md "ModelScope is
// append-only and incomplete"). Kept as pure functions so test/resources/pack-gap.test.js
// can guard the contract without standing up a full createResourceIndex install.
import { createHash } from 'node:crypto';
import { resourceIdentity } from '../../shared/resourcePaths.js';

/** Identity of every file already named by the index (decoded, origin/version-independent). */
export function coveredUrls(previous) {
  const covered = new Set();
  if (previous?.format !== 'stronghold-resource-pack-index' || !Array.isArray(previous.packs)) return covered;
  for (const pack of previous.packs) for (const f of pack.files || []) {
    const id = resourceIdentity(f.url);
    if (id) covered.add(id);
  }
  return covered;
}

/** The manifest files not named by any existing pack: the bytes a gap build packages. */
export function gapFilesOf(manifest, previous) {
  const covered = coveredUrls(previous);
  return (manifest?.files || []).filter((file) => {
    const id = resourceIdentity(file.url);
    return id && !covered.has(id);
  });
}

/**
 * Readable plan group for one manifest row. Mirrors tools/resource_packs.py group()
 * closely enough for the dry-run summary; the python script is authoritative.
 */
export function gapGroupOf(file) {
  const u = file?.url || '';
  if (file?.skin) return 'skin';
  if (file?.tier === 2) {
    if (file?.fx || u.includes('/assets/local/fx/')) return 'fx';
    const m = /\/audio\/(voice\/cn|voice\/jp|voice\/en|voice\/kr|voice|sfx|bgm)\//.exec(u);
    return m ? m[1].replace('/', '_') : 'other';
  }
  if (/\/spine\//.test(u) || /\.(skel|atlas|webp\.atlas)$/.test(u)) return 'spine';
  if (/\/local\/map\//.test(u) || /\/local\/scene\//.test(u) || u.endsWith('.obj')) return 'map';
  if (/\/(char|enemy|token)\//.test(u)) return 'character';
  return 'ui';
}

/** Group counts for the dry-run plan line. */
export function gapGroups(files) {
  const groups = {};
  for (const f of files || []) {
    const g = gapGroupOf(f);
    groups[g] = (groups[g] || 0) + 1;
  }
  return groups;
}

/**
 * Append the freshly generated packs to the previous index. Existing entries are
 * kept verbatim; new ids get a `gap-` prefix so a legacy `<group>-NN` id can never
 * collide. resourceVersion is recomputed from the full pack list, matching the
 * scoped-build convention in build-resource-packs.mjs.
 */
export function mergeAppendOnly(previous, generated) {
  const prevPacks = (previous?.format === 'stronghold-resource-pack-index' && Array.isArray(previous.packs))
    ? previous.packs : [];
  const fresh = (generated?.packs || []).map((pack) => ({ ...pack, id: `gap-${pack.id}` }));
  const packs = [...prevPacks, ...fresh];
  const version = createHash('sha1').update(JSON.stringify(packs.map((pack) => pack.sha1))).digest('hex').slice(0, 12);
  return {
    ...(previous?.format === 'stronghold-resource-pack-index' ? previous : {}),
    ...generated,
    packs,
    resourceVersion: version,
  };
}
