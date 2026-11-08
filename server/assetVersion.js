import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assetCdnUrl } from '../shared/assetCdn.js';

const ROOTS = /^\/(?:js|css|fonts|vendor|assets|data|shared|sim|media)\/|^\/data\.js(?:[?#]|$)/;
export const VERSION_PREFIX = '/_v/';
/** Executable roots that carry their own content group tag: a release which does not touch a root
 *  keeps its /_v/<tag>/ URLs, so clients retain that group's immutable cache across deploys. */
const CODE_GROUP = /^\/(js|vendor|shared|sim)\//;

/** The four executable roots, in the order their rows enter the tree tag (codeContentTags). */
export const CODE_ROOTS = ['js', 'vendor', 'shared', 'sim'];

const CACHE_VERSION = 1;
const CACHE_DIR = fileURLToPath(new URL('../.cache/asset-version/', import.meta.url));
const fileIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function defaultCacheFile(mounts) {
  const scope = mounts.map((m) => [path.resolve(m.dir), m.prefix, [...(m.only || [])].sort(), [...(m.deny || [])].sort()]);
  return path.join(CACHE_DIR, createHash('sha256').update(JSON.stringify(scope)).digest('hex') + '.json');
}

function readDigestCache(file) {
  if (!file) return {};
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc?.version === CACHE_VERSION && doc.files && typeof doc.files === 'object' && !Array.isArray(doc.files) ? doc.files : {};
  } catch { return {}; }
}

function writeDigestCache(file, files) {
  if (!file) return;
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch {
    // Read-only deployments still start correctly; a partial cache is never published.
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/** The rewriting-pipeline bytes every code tag salts with: assetVersion.js itself, the shared CDN URL
 *  helpers and server/http/static.js — the modules whose output the served bytes actually depend on
 *  (the comment at createAssetVersion below has the full reasoning). tools/studio-publish.mjs imports
 *  this so the Studio's published tags and the origin's importmap agree byte for byte: both sides must
 *  salt with the same rewriter state, i.e. publish from the same commit that is deployed. */
export function codeTransformer() {
  return Buffer.concat([
    fs.readFileSync(new URL(import.meta.url)),
    fs.readFileSync(new URL('../shared/assetCdn.js', import.meta.url)),
    fs.readFileSync(new URL('./http/static.js', import.meta.url)),
  ]);
}

/** The content tags of the executable code tree, from `[{ rel, hash }]` entries: `rel` is the served URL
 *  path (`/js/main.js`), `hash` the file's sha256 hex. Entries are consumed per group in the given order —
 *  the deterministic walk order (per-directory `localeCompare(…, 'en')`, depth-first) that both this module
 *  and tools/studio-publish.mjs walk in; across groups the order does not matter. Files outside the four
 *  code roots are ignored. A group tag digests the transformer bytes plus that group's `rel\0hash\0` rows;
 *  the tree tag digests the transformer plus every group's rows in CODE_ROOTS order — the tag of the
 *  single-tree layout the Studio publishes (`code/<treeTag>/<root>/…`), where cross-root relative imports
 *  resolve inside the tree. Group tags feed the origin's `/_v/<组tag>/` namespaces, the tree tag the
 *  optional code CDN (SP_CODE_CDN). */
export function codeContentTags(entries, transformer) {
  const rows = new Map(CODE_ROOTS.map((root) => [root, []]));
  for (const { rel, hash } of entries) {
    const group = CODE_GROUP.exec(rel);
    if (group) rows.get(group[1]).push(`${rel}\0${hash}\0`);
  }
  const groupTags = {};
  const treeHasher = createHash('sha256').update(transformer);
  for (const root of CODE_ROOTS) {
    const groupHasher = createHash('sha256').update(transformer);
    for (const row of rows.get(root)) {
      groupHasher.update(row);
      treeHasher.update(row);
    }
    groupTags[root] = groupHasher.digest('hex').slice(0, 16);
  }
  return { groupTags, treeTag: treeHasher.digest('hex').slice(0, 16) };
}

/** Content-based namespaces, computed at startup. Transformed data and page
 * releases retain art dependencies; executable roots carry per-root group tags, so a release that
 * does not touch a root keeps that root's URLs (and every client's immutable cache for it).
 * Local file identities only validate the optional digest cache; public tags contain content, never mtimes.
 * `codeBase` (SP_CODE_CDN, via server/http/static.js) additionally addresses the four code roots at a
 * content-addressed mirror of the whole tree — `${codeBase}/code/<treeTag>/…`; `/data.js` and every
 * data/css/art path stay on this origin. */
export function createAssetVersion(mounts, shim, cdn = { base: '', version: '' }, { cacheFile = defaultCacheFile(mounts), codeBase = '' } = {}) {
  // Tolerate a trailing slash: index.js normalizes SP_CODE_CDN, but a direct caller may not.
  const codeCdn = String(codeBase).replace(/\/+$/, '');
  // A change to URL/response rewriting must also invalidate the bytes it previously generated.
  // server/http/static.js 是真正改写响应字节的地方（相对说明符、垫片的 import、版本前缀），
  // 它变了而 serve 出去的字节变了、URL 却不变时，缓存和浏览器会一直拿着旧字节 —— 所以它也算进 tag。
  const transformer = codeTransformer();
  const runtimeHash = createHash('sha256').update(shim).update(transformer).update(fs.readFileSync(new URL('./index.js', import.meta.url)));
  const artHash = createHash('sha256').update(transformer).update(JSON.stringify(cdn));
  // 每个可执行根一个组 tag：只吃改写器字节 + 本组自己的文件摘要（不吃 index.js/shim，发版必变的
  // 东西不进组）——组没变，/_v/<组tag>/ 的 URL 就原样有效，客户端的 immutable 缓存跨发版续命
  // （REVIEW-2026-11-09 §7 发版热点专项）。改写器参与每一个组：改写行为变了，旧 URL 的字节语义就变了。
  // 组/树 tag 的公式提炼在 codeContentTags（上方），tools/studio-publish.mjs 用同一函数发布同一 tag。
  const codeEntries = [];
  const isArt = (url) => /^\/(?:assets|fonts|media)\//.test(url);
  const isCode = (url) => /^\/(?:js|vendor|shared|sim)\//.test(url) || /^\/data\.js(?:[?#]|$)/.test(url);
  const signatures = new Map();
  const cached = readDigestCache(cacheFile), digests = {};
  let cacheChanged = false;
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  function walk(dir, prefix, mount) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (e.name.startsWith('.') || e.name.endsWith('~') || e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name), url = prefix + e.name;
      if (e.isDirectory()) { walk(abs, url + '/', mount); continue; }
      if (!e.isFile() || mount.deny?.has(e.name.toLowerCase()) || (mount.only && !mount.only.has(path.extname(e.name).toLowerCase()))) continue;
      const stat = fs.statSync(abs);
      const identity = fileIdentity(stat);
      signatures.set(abs, identity);
      const hash = isArt(url) ? artHash : runtimeHash;
      const entry = cached[abs];
      let digest = Array.isArray(entry) && entry[0] === identity && /^[a-f0-9]{64}$/.test(entry[1]) ? entry[1] : null;
      if (!digest) {
        // Hash new/changed files once, streaming large art in bounded chunks. ctime/ino also invalidate
        // an equal-size replacement or an edit whose old mtime was restored.
        const content = createHash('sha256'), fd = fs.openSync(abs, 'r');
        try {
          let bytes;
          while ((bytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) content.update(chunk.subarray(0, bytes));
          if (fileIdentity(fs.fstatSync(fd)) !== identity) throw new Error(`Asset changed while hashing: ${abs}`);
          digest = content.digest('hex');
        } finally { fs.closeSync(fd); }
        cacheChanged = true;
      }
      digests[abs] = [identity, digest];
      hash.update(url + '\0' + digest + '\0');
      const group = CODE_GROUP.exec(url);
      if (group) codeEntries.push({ rel: url, hash: digest });
    }
  }
  for (const m of mounts) walk(m.dir, m.prefix, m);
  if (cacheChanged || Object.keys(cached).length !== Object.keys(digests).length) writeDigestCache(cacheFile, digests);
  const artTag = artHash.digest('hex').slice(0, 16);
  const runtimeTag = runtimeHash.digest('hex').slice(0, 16);
  const { groupTags, treeTag } = codeContentTags(codeEntries, transformer);
  // JSON/CSS and preload manifests embed art addresses, so their release MUST
  // change with art/CDN inputs. Only untransformed module URLs are independent.
  const tag = createHash('sha256').update(runtimeTag).update(artTag).digest('hex').slice(0, 16);
  const prefix = `${VERSION_PREFIX}${runtimeTag}`;
  const expectedTag = (s) => {
    const group = CODE_GROUP.exec(s);
    if (group) return groupTags[group[1]];
    return isArt(s) ? artTag : isCode(s) ? runtimeTag : tag;
  };
  const url = (s) => {
    const remote = assetCdnUrl(s, cdn);
    if (remote !== s) return remote;
    // 配了代码 CDN（SP_CODE_CDN → static.js 的 codeCdnBase）：四个代码根整树搬到创空间的单树发布
    // `code/<树tag>/<root>/…`（跨组相对 import 树内自洽）；/data.js 与 data/css/art 一律留在源站。
    if (codeCdn && typeof s === 'string' && CODE_GROUP.test(s)) return `${codeCdn}/code/${treeTag}${s}`;
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
      for (const root of ['/js/', '/vendor/', '/shared/', '/sim/']) {
        // 每根挂自己的命名空间：未配代码 CDN 时是源站的组 tag（跨根 import 由 importmap 落到目标组，
        // 未变的组 URL 不动）；配了则整树指向创空间的 code/<树tag>/。
        const target = codeCdn ? `${codeCdn}/code/${treeTag}${root}` : `${VERSION_PREFIX}${groupTags[root.slice(1, -1)]}${root}`;
        map.imports[root] = target;
        // Some source imports climb past the original URL root (public/ exists on disk, not in the served URL).
        // With a namespace that extra '..' resolves to /_v/shared/... rather than /shared/....
        map.imports[VERSION_PREFIX.slice(0, -1) + root] = target;
        if (codeCdn) {
          // 树内原始字节由浏览器自行解析相对 import：爬出树根的落点（https://<base>/code/<root>/…，
          // 运行时 import 的实测逃逸只有爬向 shared 的深层模块）没有树 tag，importmap 把它们接回树内。
          map.imports[`${codeCdn}/code${root}`] = target;
        }
      }
      // `/data.js` is generated, not a walked file: it stays on the whole-tree runtime tag.
      map.imports['/data.js'] = prefix + '/data.js';
      map.imports[VERSION_PREFIX.slice(0, -1) + '/data.js'] = prefix + '/data.js';
      if (codeCdn) {
        // 树内对 /data.js 的爬行（sim/content/support/* 的 '../../../data.js'）落在 code/<树tag>/data.js ——
        // 那里没有发布物（data.js 是生成的），接回源站的版本化垫片。
        map.imports[`${codeCdn}/code/${treeTag}/data.js`] = prefix + '/data.js';
      }
      return open + JSON.stringify(map).replace(/</g, '\\u003c') + close;
    });
  // 页面只带版本标签；CDN 基址与每文件指纹清单由 /js/asset-cdn.js 这个模块提供（public/js/main.js 读它），
  // 页面里不再重复一份 __spAssetCdn / __spManifestReady。
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<script>globalThis.__spAssetVersion=${JSON.stringify(tag)};globalThis.__spRuntimeVersion=${JSON.stringify(runtimeTag)};globalThis.__spCodeVersion=${JSON.stringify(groupTags)};globalThis.__spArtVersion=${JSON.stringify(artTag)};</script>`);
  }
  return { tag, artTag, runtimeTag, groupTags, treeTag, expectedTag, url, transform, matchesFile: (abs, stat) => signatures.get(abs) === fileIdentity(stat) };
}

/** The legacy CDN release tag (`.assets-cdn-version`): the `_v/<tag>/` snapshot layout this fork used
 *  before per-file `?v=` hashes. `tools/r2-sync.mjs` no longer writes it; the file stays tracked so an
 *  older server that cannot reach the CDN still resolves its `_v/` keys. Returns '' when the file is
 *  missing or does not hold a valid tag. */
export function readAssetsCdnVersionFile(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.assets-cdn-version')) {
  try {
    const tag = fs.readFileSync(file, 'utf8').trim();
    return /^[a-f0-9]{16}$/.test(tag) ? tag : '';
  } catch {
    return '';
  }
}

/** The per-file art manifest (`.assets-manifest.json`) from the project root — generated there by
 *  tools/r2-sync.mjs on the publishing machine or by tools/build-assets-manifest.mjs from local art; not
 *  a tracked file:
 *  `{ tag, hashes, preload? }` — `hashes` maps every published art path (`/assets/…`) to its content hash.
 *  Servers pass it into every CDN URL as a per-file `?v=<hash>` query, so a release only re-busts
 *  the files it changed; the tag doubles as the manifest's own immutable-cache key. Returns null
 *  when the file is missing or does not hold a valid manifest. Optional `preload` supplies server-side
 *  SHA-1/size metadata for resource import validation on CDN-only installs. */
export function readAssetsManifestFile(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.assets-manifest.json')) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || !/^[a-f0-9]{16}$/.test(doc.tag) || !doc.hashes || typeof doc.hashes !== 'object') return null;
    const entries = Object.entries(doc.hashes);
    if (entries.length > 50000) return null;
    const hashes = {};
    for (const [p, h] of entries) {
      if (!/^\/(?:assets|fonts|media)\/[^\s?#]+$/.test(p) || !/^[a-f0-9]{16}$/.test(h)) return null;
      hashes[p] = h;
    }
    // Optional server-side SHA-1/size metadata for CDN-only installs. Ignore malformed rows;
    // an unlisted path cannot authorize a cache import.
    const preload = {};
    if (doc.preload && typeof doc.preload === 'object' && !Array.isArray(doc.preload)) {
      for (const [p, entry] of Object.entries(doc.preload).slice(0, 50000)) {
        if (Object.hasOwn(hashes, p) && entry && /^[a-f0-9]{12}$/.test(entry.hash)
          && Number.isSafeInteger(entry.size) && entry.size >= 0) preload[p] = { hash: entry.hash, size: entry.size };
      }
    }
    return Object.keys(preload).length ? { tag: doc.tag, hashes, preload } : { tag: doc.tag, hashes };
  } catch {
    return null;
  }
}
