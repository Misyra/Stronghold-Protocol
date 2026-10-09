// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// server/resources.js — the optional preload manifest (docs/development/ASSETS.md「Preload」).
//
// The client can preload every file a match may need into Cache Storage (Service Worker, public/js/resources/*), so
// cached art can be read locally and reduces download waits when entering a battle.
// That list needs no extra build step: it is derived from the asset manifests this server already serves, and it is
// rewritten exactly like /data/assets.json (SP_ASSETS_CDN, docs/development/ASSETS.md「CDN」) — so the client preloads from the
// CDN. Local file sizes are added when this install has the files on disk (a CDN-only install simply omits them).
//
// Every entry carries a `hash`: the client stores the files under ONE cache name and replaces a file when its hash
// changes, so an asset update only re-downloads what really changed (docs/development/ASSETS.md「Preload」) instead of the whole
// ~310 MiB. Hashes come from the manifests themselves — `local-assets.json` entries (written by extract.py) and
// `asset-hashes.json` (tools/asset-hashes.mjs over public/assets + public/fonts). A file without one keeps the old
// local files are hashed lazily on the first manifest request. Missing/CDN-only files fall back to the source stamp.
//
// /data/resource-manifest.json:
//   { format: 1, version: '<digest of every url|hash>', count, tier1, sized, totalBytes,
//     files: [ { url, tier, size?, hash } … ] }   // sorted: essential tier first, then by URL

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { canonicalResourceUrl, isBoardResourceJson } from '../shared/resourcePaths.js';

export const RESOURCE_MANIFEST_FILE = 'resource-manifest.json';
/** Per-file content hashes of the fetched assets, written by tools/asset-hashes.mjs (optional). */
export const ASSET_HASHES_FILE = 'asset-hashes.json';
export const RESOURCES_FORMAT = 1;
/** A hash as the client accepts it (hex digests, the `syn-` fallback, a plain `sha1-…` label). */
export const HASH_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Short digest of anything — 12 hex characters is plenty to notice a changed file, and keeps the manifest small. */
export function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
}
/** A single cached file may never exceed this (a broken manifest cannot make a browser store something huge). */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;
/** Required visuals: maps/meshes, portraits, Spine, fonts, UI and icons. */
export const TIER_ESSENTIAL = 1;
/** Optional: voices, sound effects, music and tutorial illustrations. */
export const TIER_REST = 2;

/** Extension → MIME type. Mirrored by the client (public/js/resources/common.js) for URL validation. */
export const RESOURCE_MIME = Object.freeze({
  json: 'application/json; charset=utf-8',
  aac: 'audio/aac',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css; charset=utf-8',
  atlas: 'text/plain; charset=utf-8',
  obj: 'text/plain; charset=utf-8',
  skel: 'application/octet-stream',
  bin: 'application/octet-stream',
});

/** MIME type of a resource URL, or null when the extension is not a resource type. */
export function resourceType(url) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(url || ''));
  return m ? RESOURCE_MIME[m[1].toLowerCase()] || null : null;
}

/** Whether a URL path is served from the asset trees the preload may cache. */
export function isResourcePath(pathname) {
  return /\/(?:assets|fonts)\//.test(String(pathname || ''));
}

/**
 * Whether a manifest string is a file the client may request: a site path (`/assets/…`, `/fonts/…`) or an absolute
 * http(s) URL (the CDN shape), with a known resource extension and no query/control characters — except the one
 * query manifest mode itself appends, the per-file `?v=<16 hex>` cache-bust.
 */
export function validateResourceUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) return false;
  const bare = String(url).replace(/\?v=[0-9a-f]{16}$/, '');
  if (/[\s?#\\"'<>\u0000-\u001f]/.test(bare)) return false;
  let pathname = bare;
  if (!bare.startsWith('/') || bare.startsWith('//')) {
    if (!/^https?:\/\//i.test(bare)) return false;
    try { pathname = new URL(bare).pathname; } catch { return false; }
  }
  return isResourcePath(pathname) && !!resourceType(pathname);
}

const TIER_ESSENTIAL_SECTIONS = new Set(['ui', 'prof', 'bonds', 'items', 'bands', 'skills', 'fonts', 'chars', 'tokens', 'enemies', 'maps', 'spine']);

/**
 * Preload tier of a manifest entry, from its key path (`chars.char_002_amiya.spine.front.skel`). Operators, tokens and
 * images, Spine and map geometry are all required. Audio and tutorial illustrations are optional. Local groups use
 * slash-containing names (map/autochess, spine/enemy/…), so classification must handle both '/' and '.'.
 */
export function tierForPath(keyPath) {
  const p = String(keyPath || '');
  const segments = p.split(/[./]/);
  const head = segments[0];
  if (segments.some((s) => ['audio', 'voice', 'voices', 'sfx', 'bgm', 'guide'].includes(s))) return TIER_REST;
  if (head === 'local') return TIER_ESSENTIAL;
  return TIER_ESSENTIAL_SECTIONS.has(head) ? TIER_ESSENTIAL : TIER_REST;
}

/**
 * Every resource file of the asset manifests, deduplicated (a file keeps its lowest tier) and sorted essential-first.
 * `source` says which manifest listed it ('web' | 'local'): the fallback hash of an unhashed file depends on it, so a
 * regenerated local extraction cannot invalidate the fetched assets and vice versa.
 * @param {any} assets parsed data/assets.json (already CDN-rewritten)
 * @param {any} local parsed data/local-assets.json, optional
 * @returns {{ url: string, tier: number, source: 'web' | 'local' }[]}
 */
export function collectResourceFiles(assets, local) {
  /** @type {Map<string, { tier: number, source: 'web' | 'local' }>} */
  const byUrl = new Map();
  const walk = (node, keyPath, source) => {
    if (typeof node === 'string') {
      if (!validateResourceUrl(node)) return;
      // Audio is optional even when a new manifest nests it inside an otherwise required character/map section.
      const tier = resourceType(node)?.startsWith('audio/') ? TIER_REST : tierForPath(keyPath);
      const url = canonicalResourceUrl(node);
      const prev = byUrl.get(url);
      if (prev == null || tier < prev.tier) byUrl.set(url, { tier, source });
      // The crop table sits beside the atlas and is not listed in local-assets.json.
      if (source === 'local' && /\/assets\/local\/map\/autochess\/TX_autochessi_D\.(?:png|webp)(?:\?v=[0-9a-f]{16})?$/.test(url)) {
        byUrl.set(url.replace(/[^/]+$/, 'tiles.json'), { tier: TIER_ESSENTIAL, source });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${keyPath}.${i}`, source);
      return;
    }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, keyPath ? `${keyPath}.${k}` : k, source);
  };
  for (const [k, v] of Object.entries(assets && typeof assets === 'object' ? assets : {})) {
    if (k === 'stats' || k === 'skillsById') continue; // counters / id maps: no files
    walk(v, k, 'web');
  }
  if (local && typeof local === 'object') walk(local, 'local', 'local');
  return [...byUrl]
    .map(([url, e]) => ({ url, tier: e.tier, source: e.source }))
    .sort((a, b) => a.tier - b.tier || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** The per-file cache-bust query manifest mode appends (`?v=<16 hex>`): part of the URL, never of the file it names. */
const BUST_QUERY = /\?v=[0-9a-f]{16}$/;

/** Path part of a URL — the key real hashes are matched by (a CDN install rewrites the URLs, not the hash file). */
export function pathKey(url, cdnBase = '') {
  let s = canonicalResourceUrl(url || '').replace(BUST_QUERY, '');
  if (cdnBase && s.startsWith(cdnBase + '/')) s = s.slice(cdnBase.length);
  let p = s;
  if (!s.startsWith('/') || s.startsWith('//')) { try { p = new URL(s).pathname; } catch { return s; } }
  return p.replace(/\/_v\/[a-f0-9]{16}(?=\/)/, '');
}

/**
 * Content hashes known for this install, keyed by URL path: every `hash` of `data/local-assets.json`'s groups
 * (extract.py) plus `data/asset-hashes.json` (tools/asset-hashes.mjs over the fetched assets).
 * @param {any} localDoc parsed local-assets.json (may be CDN-rewritten)
 * @param {any} hashesDoc parsed asset-hashes.json, optional
 * @returns {Map<string, string>}
 */
export function collectRealHashes(localDoc, hashesDoc, cdnBase = '') {
  /** @type {Map<string, string>} */
  const map = new Map();
  const put = (url, hash) => {
    if (typeof url === 'string' && validateResourceUrl(url) && typeof hash === 'string' && HASH_RE.test(hash)) map.set(pathKey(url, cdnBase), hash);
  };
  const groups = localDoc && typeof localDoc === 'object' ? localDoc.groups : null;
  if (groups && typeof groups === 'object') {
    for (const group of Object.values(groups)) {
      if (!group || typeof group !== 'object') continue;
      for (const entry of Object.values(group)) if (entry && typeof entry === 'object') put(entry.path, entry.hash);
    }
  }
  const files = hashesDoc && typeof hashesDoc === 'object' ? hashesDoc.files : null;
  if (files && typeof files === 'object') for (const [url, hash] of Object.entries(files)) put(url, hash);
  return map;
}

/**
 * The hash of every collected file: the real one when known, otherwise a synthetic value that reproduces the old rule
 * (any change to the source manifest's own hash/mtime invalidates everything of that source).
 * @param {{ url: string, source: string }[]} files
 * @param {Map<string, string>} real
 * @param {{ web: string, local: string }} stamps
 * @returns {Map<string, string>}
 */
export function resolveHashes(files, real, stamps, cdnBase = '') {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const f of files) {
    const known = real.get(pathKey(f.url, cdnBase));
    out.set(f.url, typeof known === 'string' && known ? known : `syn-${shortHash(`${f.source}|${stamps[f.source] || ''}|${f.url}`)}`);
  }
  return out;
}

/**
 * The manifest body. `sizes` (URL → bytes) is optional: without it the client still preloads, it just reports progress
 * in files instead of bytes.
 */
export function buildResourceManifest({ files, sizes = null, version = 'none', hashes = null }) {
  let totalBytes = 0;
  let sized = 0;
  let tier1 = 0;
  const out = [];
  for (const f of files) {
    const size = sizes ? sizes.get(f.url) : undefined;
    const entry = { url: f.url, tier: f.tier };
    const hash = (hashes ? hashes.get(f.url) : f.hash) || null;
    if (hash) entry.hash = hash;
    if (Number.isSafeInteger(size) && size >= 0) {
      entry.size = size;
      totalBytes += size;
      sized++;
    }
    if (f.tier === TIER_ESSENTIAL) tier1++;
    out.push(entry);
  }
  return {
    format: RESOURCES_FORMAT,
    version: String(version),
    count: out.length,
    tier1,
    sized,
    totalBytes: sized ? totalBytes : null,
    files: out,
  };
}

/**
 * Absolute path of a resource URL inside this install, or null when the URL is not a site path / escapes publicDir.
 * A CDN URL maps back to the same tree (`https://cdn/assets/x.png` → `<publicDir>/assets/x.png`).
 */
export function localPathFor(url, publicDir, cdnBase = '') {
  let p = String(url || '').replace(/\?v=[0-9a-f]{16}$/, '');
  if (cdnBase && p.startsWith(cdnBase + '/')) p = p.slice(cdnBase.length) || '/';
  if (!p.startsWith('/') || p.startsWith('//')) return null;
  p = p.replace(/^\/_v\/[a-f0-9]{16}(?=\/)/, '');
  try { p = decodeURIComponent(p); } catch { return null; }
  if (/[\\\u0000-\u001f]/.test(p)) return null;
  const root = path.resolve(publicDir);
  const segments = p.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const abs = path.join(root, ...segments);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * The served resource manifest, built from the data directory and cached until one of its sources changes.
 * @param {{ dataDir: string, publicDir: string, cdnBase?: string, rewrite?: (v: any) => any,
 *           statFile?: (p: string) => Promise<{ isFile(): boolean, size: number }>, log?: any,
 *           assetsManifest?: { hashes: Record<string, string>, preload?: Record<string, { hash: string, size: number }> } | null }} opts
 */
export function createResourceIndex({ dataDir, publicDir, cdnBase = '', rewrite = (v) => v, statFile = (p) => fsp.stat(p), log = null, assetsManifest = null } = {}) {
  /** @type {{ key: string, body: Buffer, gzip: Buffer, mtimeMs: number, manifest: any } | null} */
  let cache = null;
  let pending = null;
  const contentHashes = new Map();

  async function readJson(name) {
    const file = path.join(dataDir, name);
    try {
      const stat = await statFile(file);
      if (!stat.isFile()) return null;
      return { doc: JSON.parse(await fsp.readFile(file, 'utf8')), mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
      throw e;
    }
  }

  /** File sizes of the files present on disk (bounded concurrency: ~4 000 stats of a real install). */
  async function measure(files, real, publishedSizes) {
    const sizes = new Map(publishedSizes);
    let next = 0;
    const lanes = Math.min(4, files.length);
    await Promise.all(Array.from({ length: lanes }, async () => {
      for (let i = next++; i < files.length; i = next++) {
        const abs = localPathFor(files[i].url, publicDir, cdnBase);
        if (!abs) continue;
        try {
          const stat = await statFile(abs);
          if (!stat.isFile()) continue;
          const f = files[i];
          if (!sizes.has(f.url)) sizes.set(f.url, stat.size);
          const canonical = pathKey(f.url, cdnBase);
          if (stat.size <= MAX_FILE_BYTES && !real.has(canonical)) {
            const signature = abs + ':' + stat.size + ':' + stat.mtimeMs;
            let hash = contentHashes.get(signature);
            if (!hash) {
              const digest = crypto.createHash('sha1');
              for await (const chunk of fs.createReadStream(abs)) digest.update(chunk);
              hash = digest.digest('hex').slice(0, 12);
              contentHashes.set(signature, hash);
            }
            real.set(canonical, hash);
          }
        } catch { /* not on disk (CDN-only install) — the client preloads it without a size */ }
      }
    }));
    return sizes;
  }

  async function build() {
    const assets = await readJson('assets.json');
    const local = await readJson('local-assets.json');
    const hashesDoc = await readJson(ASSET_HASHES_FILE);
    const assetsDoc = assets ? rewrite(assets.doc) : null;
    const localDoc = local ? rewrite(local.doc) : null;
    const collected = collectResourceFiles(assetsDoc, localDoc);
    const tileFiles = collected.filter((f) => /\/assets\/local\/map\/autochess\/tiles\.json$/.test(f.url));
    const tiles = await Promise.all(tileFiles.map(async (file) => {
      const abs = localPathFor(file.url, publicDir, cdnBase);
      try {
        const stat = abs && await statFile(abs);
        return stat?.isFile() ? { url: file.url, abs, stamp: `${stat.mtimeMs}:${stat.size}`, size: stat.size } : null;
      } catch { return null; }
    }));
    const key = [assets ? `${assets.mtimeMs}:${assets.size}` : '-', local ? `${local.mtimeMs}:${local.size}` : '-',
      hashesDoc ? `${hashesDoc.mtimeMs}:${hashesDoc.size}` : '-', cdnBase, ...tiles.map((f) => f?.stamp || '-')].join('|');
    if (cache && cache.key === key) return cache;
    const t0 = Date.now();
    const real = collectRealHashes(localDoc, hashesDoc ? hashesDoc.doc : null, cdnBase);
    const publishedSizes = new Map();
    if (cdnBase && assetsManifest?.preload) {
      const published = new Map(Object.entries(assetsManifest.preload).map(([p, entry]) =>
        [pathKey(p), { ...entry, version: assetsManifest.hashes[p] }]));
      for (const f of collected) {
        const entry = published.get(pathKey(f.url, cdnBase));
        // The URL must name exactly the bytes the publisher fingerprinted, including its per-file version.
        if (entry && f.url.startsWith(cdnBase + '/') && /^[a-f0-9]{12}$/.test(entry.hash)
          && /^[a-f0-9]{16}$/.test(entry.version) && f.url.endsWith('?v=' + entry.version)
          && Number.isSafeInteger(entry.size) && entry.size >= 0) {
          real.set(pathKey(f.url, cdnBase), entry.hash);
          publishedSizes.set(f.url, entry.size);
        }
      }
    }
    for (const tile of tiles) if (tile && tile.size <= MAX_FILE_BYTES && !publishedSizes.has(tile.url)) {
      real.set(pathKey(tile.url, cdnBase), crypto.createHash('sha1').update(await fsp.readFile(tile.abs)).digest('hex').slice(0, 12));
    }
    const files = collected.filter((f) => !tileFiles.includes(f) || real.has(pathKey(f.url, cdnBase)));
    const stamps = {
      web: assetsDoc && assetsDoc.hash ? assetsDoc.hash : assets ? `m${Math.floor(assets.mtimeMs)}` : 'none',
      local: localDoc && localDoc.hash ? localDoc.hash : local ? `l${Math.floor(local.mtimeMs)}` : 'none',
    };
    const sizes = await measure(files, real, publishedSizes);
    const fileHashes = resolveHashes(files, real, stamps, cdnBase);
    // CSS/JSON can be rewritten by the serving host. Their index fingerprint includes the URL namespace, but is
    // deliberately not a raw-byte digest: a CDN host may rewrite these small files differently from this game host.
    for (const f of files) if (/\.(?:css|json)(?:\?v=[0-9a-f]{16})?$/.test(f.url) && !isBoardResourceJson(f.url)) {
      fileHashes.set(f.url, 'syn-' + shortHash(fileHashes.get(f.url) + '|' + f.url));
    }
    // The version is informational now (the client keys its cache per file), but it must still change whenever the set
    // or any hash does — the settings panel and the /healthz-style diagnostics read it.
    const version = shortHash([cdnBase, ...files.map((f) => `${f.url}|${fileHashes.get(f.url)}|${f.tier}`)].join('\n'));
    const manifest = buildResourceManifest({ files, sizes, version, hashes: fileHashes });
    const body = Buffer.from(JSON.stringify(manifest));
    // Strong validator over the complete response: an unchanged rebuild or restart keeps it (the client revalidates
    // with cache: 'no-cache'), while any content change — sizes included — produces a fresh one.
    const etag = `"resources-${crypto.createHash('sha256').update(body).digest('hex')}"`;
    cache = { key, body, gzip: zlib.gzipSync(body), etag, mtimeMs: Date.now(), manifest };
    log?.info?.(`[resources] ${manifest.count} file(s), ${manifest.tier1} essential, ${manifest.sized} sized`
      + `${manifest.totalBytes ? `, ${(manifest.totalBytes / 1048576).toFixed(1)} MiB` : ''}, `
      + `${fileHashes.size ? [...fileHashes.values()].filter((h) => !h.startsWith('syn-')).length : 0} hashed`
      + `, version ${version} (${Date.now() - t0} ms)`);
    return cache;
  }

  return {
    /** @returns {Promise<{ body: Buffer, gzip: Buffer, etag: string, mtimeMs: number, manifest: any }>} */
    get() { pending ??= build().finally(() => { pending = null; }); return pending; },
    /** Drop the cache (tests). */
    reset() { cache = null; },
  };
}
