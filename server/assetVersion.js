import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assetCdnUrl } from '../shared/assetCdn.js';

const ROOTS = /^\/(?:js|css|fonts|vendor|assets|data|shared|sim|media)\/|^\/data\.js(?:[?#]|$)/;
export const VERSION_PREFIX = '/_v/';

/** One release namespace, computed at startup. Code/data use content hashes; large binary assets use size/mtime. */
export function createAssetVersion(mounts, shim, cdn = { base: '', version: '' }) {
  // A change to URL/response rewriting must also invalidate the bytes it previously generated.
  const transformer = Buffer.concat([fs.readFileSync(new URL(import.meta.url)), fs.readFileSync(new URL('../shared/assetCdn.js', import.meta.url))]);
  const runtimeHash = createHash('sha256').update(shim).update(transformer).update(fs.readFileSync(new URL('./index.js', import.meta.url)));
  const artHash = createHash('sha256').update(transformer).update(JSON.stringify(cdn));
  const isArt = (url) => /^\/(?:assets|fonts|media)\//.test(url);
  const signatures = new Map();
  function walk(dir, prefix, mount) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (e.name.startsWith('.') || e.name.endsWith('~') || e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name), url = prefix + e.name;
      if (e.isDirectory()) { walk(abs, url + '/', mount); continue; }
      if (!e.isFile() || mount.deny?.has(e.name.toLowerCase()) || (mount.only && !mount.only.has(path.extname(e.name).toLowerCase()))) continue;
      const stat = fs.statSync(abs);
      signatures.set(abs, `${stat.size}:${stat.mtimeMs}`);
      const hash = isArt(url) ? artHash : runtimeHash;
      hash.update(url + '\0');
      // Don't read hundreds of MB of art/audio just to start a LAN server.
      if (/\.(?:html?|css|m?js|json)$/.test(e.name)) hash.update(fs.readFileSync(abs));
      else hash.update(`${stat.size}:${stat.mtimeMs}`);
      hash.update('\0');
    }
  }
  for (const m of mounts) walk(m.dir, m.prefix, m);
  const artTag = artHash.digest('hex').slice(0, 16);
  const tag = runtimeHash.update(artTag).digest('hex').slice(0, 16);
  const prefix = `${VERSION_PREFIX}${tag}`;
  const expectedTag = (s) => isArt(s) ? artTag : tag;
  const url = (s) => {
    const remote = assetCdnUrl(s, cdn);
    if (remote !== s) return remote;
    return typeof s === 'string' && ROOTS.test(s) ? `${VERSION_PREFIX}${expectedTag(s)}${s}` : s;
  };
  function json(value) {
    if (typeof value === 'string') return url(value);
    if (Array.isArray(value)) return value.map(json);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]));
    return value;
  }
  function transform(source, ext) {
    if (ext === '.json') return JSON.stringify(json(JSON.parse(source)));
    if (ext === '.css') return source.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (match, quote, s) => `url(${quote}${url(s)}${quote})`);
    if (ext !== '.html' && ext !== '.htm') return source;
    let html = source.replace(/\b(src|href)=(['"])([^'"]+)\2/g, (match, attr, quote, s) => `${attr}=${quote}${url(s)}${quote}`);
    html = html.replace(/(<script\s+type=['"]importmap['"]\s*>)([\s\S]*?)(<\/script>)/g, (match, open, body, close) => {
      const map = JSON.parse(body);
      map.imports = Object.fromEntries(Object.entries(map.imports || {}).map(([k, v]) => [k, url(v)]));
      for (const root of ['/js/', '/vendor/', '/shared/', '/sim/', '/data.js']) {
        map.imports[root] = prefix + root;
        // Some source imports climb past the original URL root (public/ exists on disk, not in the served URL).
        // With a namespace that extra '..' resolves to /_v/shared/... rather than /shared/....
        map.imports[VERSION_PREFIX.slice(0, -1) + root] = prefix + root;
      }
      return open + JSON.stringify(map).replace(/</g, '\\u003c') + close;
    });
    const settings = JSON.stringify(cdn).replace(/</g, '\\u003c');
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<script>globalThis.__spAssetVersion=${JSON.stringify(tag)};globalThis.__spArtVersion=${JSON.stringify(artTag)};globalThis.__spAssetCdn=${settings};</script>`);
  }
  return { tag, artTag, expectedTag, url, transform, matchesFile: (abs, stat) => signatures.get(abs) === `${stat.size}:${stat.mtimeMs}` };
}

/** The CDN release tag shipped with the repo (`.assets-cdn-version`, written by tools/r2-sync.mjs and
 *  committed with the release): a `git pull` then restart syncs a server that cannot reach the CDN.
 *  Returns '' when the file is missing or does not hold a valid tag. */
export function readAssetsCdnVersionFile(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.assets-cdn-version')) {
  try {
    const tag = fs.readFileSync(file, 'utf8').trim();
    return /^[a-f0-9]{16}$/.test(tag) ? tag : '';
  } catch {
    return '';
  }
}
