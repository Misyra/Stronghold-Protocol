// server/http/static.js — the static file server (routes.js hands it every GET / HEAD that is not an API route):
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//     /        → public/      (index.html for directories)
//     /data/   → data/        (generated game data)
//     /shared/ → shared/      (ESM shared with the browser)
//     /sim/    → server/sim/  (the battle simulation, read-only, `.js` only — client-side
//                              combat, DESIGN §14; the Node-only loader nodeData.js is not served)
//     /studio/… → never: the plugin studio's page (public/studio/) is served by server/studio/index.js behind its gate (this
//                machine and the local network only) — a path here that is the studio's, in any spelling, is a 404
//     /data.js → a generated browser stand-in of server/data.js (the sim's content modules
//                import `../../../data.js`; in the browser it serves the data injected with
//                /sim/simdata.js setSimData). No other server file is ever served.
//     /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 — the same audio files, addressed
//                **without** an extension so download managers (IDM / 迅雷 …) stop popping a
//                "下载文件信息" dialog for every BGM track (media.js, shared/media.js, public/js/media.js)
//     /packs/index.json → the language packs of this server (server/plugins/registry.js: public/i18n/, the pack
//                folders of packs/ and the lang plugins of plugins/, re-read when they change; never cached)
//     /packs/<id>/<file> → a file of a pack or lang plugin folder — only one its manifest names (registry servable)
//     /plugins/index.json → the plugin catalogue: every plugin and pack found, by class and status, and the vanilla
//                content hash (DESIGN §32; never cached). Of plugins/ only the files a lang manifest names (through
//                /packs/<id>/<file>), the files a loaded cosmetic overlay names and the frame files of a loaded ui
//                plugin (/p/…; a ui file also sends the frame Content-Security-Policy) are served
//     /cs/<cs16>/index.json → the manifest of the vanilla content set (server/plugins/identity.js contentIndexOf),
//                cached for good — for this server's vanilla `cs` (its first 16 hex digits) and, from P1c (DESIGN §32.6),
//                a content set with gameplay plugins a room uses or used lately (server/plugins/contentSets.js: the same
//                shape with `vanilla: false`, its plugins, settings and modes)
//     /cs/<cs16>/data/<file>.json, /cs/<cs16>/i18n/<lang>.json → a data or translation file that content set changed,
//                its served bytes from memory (cached for good; every other file of the set is named by its plain
//                /data/…?v=<8 hex> URL in the manifest)
//     /data/<file>.json?v=<8 hex> → a gameplay data file named by its own content hash, exactly the URL of the
//                vanilla content manifest (server/plugins/identity.js): `immutable` while the file is still the size
//                the manifest hashed; any other query pins nothing — a client cannot mint an immutable URL
//                (files.js cacheControlFor; a per-release `?v=` is the CDN's, not a validator)
//     /vs/<vs16>/overlay.json → a visual set of cosmetic plugins (server/plugins/visualSet.js): its composition and
//                its plugins' writes, which a page lays over the manifest it loaded itself (a room's set, a player's
//                personal plugin) — no-cache, the body's hash as ETag; 404 for a set this server does not know
//     /p/<id>/<hash8>/<path> → a file of a loaded cosmetic plugin — only one its overlay names — or a frame file of a
//                loaded ui plugin (html / js / css / png under entry.client). registry pluginFile is the whitelist
//                (no dot file, no `..`; only the very file the scan hashed — a symbolic link put in its place, or in place
//                of a folder on its way, is never followed, wherever it leads). A ui file's response carries
//                UI_FRAME_CSP (shared/plugins/ui.js); a cosmetic file does not. A hash naming its current bytes (its own
//                first 8 hex digits, or its Spine model's) answers `immutable` for a year while the file keeps the size,
//                mtime, inode and ctime it was hashed with; any other hash, or a file changed since the scan, the current
//                file with `no-cache` and a changed file has the registry read the
//                folders again. An audio file is also served without its extension — /p/<id>/<hash8>/<path without
//                .mp3 / .ogg> — for the same download managers as /media/ below (public/js/media.js mediaUrl; when both
//                a .mp3 and a .ogg are listed, the one whose hash the URL names)
//
// This fork adds the release/CDN asset layer (assetVersion.js + tools/r2-sync.mjs):
//     /_v/<tag>/…        → validated immutable URLs: code uses runtimeVersion, art uses artVersion,
//                          and transformed data/CSS uses the release tag (/healthz.build).
//     /assets-manifest.json?v=<tag> → the per-file art hash manifest shipped by tools/r2-sync.mjs; the
//                          client's resourceUrl.js turns art URLs into per-file `?v=<hash>` CDN queries.
//     /data/resource-manifest.json → the offline preload manifest (server/resources.js, 设置 ▸ 离线资源).
//     HTML / CSS / (versioned) JSON responses have their URLs rewritten to the CDN / versioned forms;
//     public art answers CORS `*` so another game host may reuse it. The per-release tag also guards
//     media files (503 after a deploy that changed them).
//
// Files under public/assets/ and public/fonts/ answer with this release's validator as ETag when the URL names the release (a file whose
// size or mtime changed since is answered as changed), others size + mtime. Traversal & dotfile protection, a directory
// without its trailing slash → 301, 404 page; an absent data/local-assets.json or data/local-fx.json is answered with
// an empty manifest.
// Files go out through files.js serveFile.

import fsp from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { MEDIA_PREFIX } from '../../shared/media.js';
import { ROOT, noopLog } from './config.js';
import { sendError, sendJson } from './common.js';
import { MIME, CompressCache, IMMUTABLE_CACHE, acceptsGzip, isNotModified, serveFile, serveBuffer } from './files.js';
import { serveMedia } from './media.js';
import { createPluginRegistry, sameIdentity, statIdentity } from '../plugins/registry.js';
import { computeVanillaContent } from '../plugins/identity.js';
import { createVisualSets } from '../plugins/visualSet.js';
import { isStudioPath } from '../studio/paths.js';
import { PACKS_URL, PACK_INDEX_FILE } from '../../shared/packs.js';
import { createAssetVersion, VERSION_PREFIX } from '../assetVersion.js';
import { createResourceIndex, RESOURCE_MANIFEST_FILE } from '../resources.js';
import { isBoardResourceJson } from '../../shared/resourcePaths.js';
import { PLUGINS_URL, PLUGIN_INDEX_VERSION, buildPluginIndex, extOf, isPackPath, isPluginId } from '../../shared/plugins/manifest.js';
import { csUrlPart } from '../../shared/plugins/identity.js';
import { FILE_URL_DIGITS, PLUGIN_AUDIO_EXTS, PLUGIN_FILES_URL, VISUAL_DOC_FILE, VISUAL_SETS_URL, VS_URL_DIGITS } from '../../shared/plugins/visual.js';
import { SIM_WORKER_CSP } from './csp.js';
import { UI_FRAME_CSP } from '../../shared/plugins/ui.js';

/** Browser stand-in of server/data.js, served at /data.js (see the header). Served byte for byte: its first line names the entry, server/index.js. */
export const DATA_SHIM_JS = `// Generated by server/index.js — browser stand-in for server/data.js (DESIGN §14 client-side combat).
// The simulation's content modules (/sim/content/support/index.js) import getData() from here; it returns the game data
// the page injected with /sim/simdata.js setSimData(data).
import { getSimData } from './sim/simdata.js';
export function getData() { return getSimData() || {}; }
export function resetData() {}
`;
/** Files under server/sim that are never served (Node-only). */
const SIM_PRIVATE = new Set(['nodedata.js']); // lower-case (compared case-insensitively)

// ---------------------------------------------------------------------------------------------------
// Static file handler
// ---------------------------------------------------------------------------------------------------

/** Optional per-machine art manifests (tools/local-extract: the local art, the official effects' files — DESIGN §33)
 * and the empty stand-in served when one is absent. */
const LOCAL_ART_MANIFESTS = new Set(['local-assets.json', 'local-fx.json']);
const EMPTY_LOCAL_ART = Buffer.from(JSON.stringify({ version: 1, source: 'none', count: 0, groups: {} }));

/** The content-set manifest's cache policy: its URL names its content (the `cs`), so it never changes. */
const IMMUTABLE_JSON = 'public, max-age=31536000, immutable';
/** /vs/<vs16>/overlay.json */
const VISUAL_DOC = new RegExp(`^${VISUAL_SETS_URL}([0-9a-f]{${VS_URL_DIGITS}})/${VISUAL_DOC_FILE.replace('.', '\\.')}$`);
/** A plugin file URL's hash segment. */
const FILE_HASH = new RegExp(`^[0-9a-f]{${FILE_URL_DIGITS}}$`);
/** /cs/<cs16>/<path> of a content set with gameplay plugins (DESIGN §32.6). */
const CS_FILE = /^\/cs\/([0-9a-f]{16})\/([A-Za-z0-9._\/-]{1,200})$/;

/**
 * Create the static request handler.
 * @param {{ publicDir: string, dataDir: string, sharedDir: string, simDir?: string, packsDir?: string, pluginsDir?: string,
 *   packs?: ReturnType<typeof createPluginRegistry>, content?: import('../plugins/identity.js').VanillaContent | null,
 *   log?: object, clientBuild?: boolean,
 *   assetsCdn?: string, assetsCdnVersion?: string,
 *   visual?: ReturnType<typeof createVisualSets> | null,
 *   contents?: ReturnType<typeof import('../plugins/contentSets.js').createContentSets> | null,
 *   assetsManifest?: { tag: string, hashes: Record<string, string>, preload?: Record<string, { hash: string, size: number }> } | null }} dirs
 *   packs: the server's plugin registry (default: one over publicDir, dataDir, packsDir and pluginsDir — ROOT/packs, and
 *   the plugins/ folder beside packsDir); content: the vanilla content (default: computed from simDir, sharedDir and
 *   dataDir on first use);
 *   visual: the visual sets (default: one over the registry — a registry of 0.2.0's shape has none:
 *   /vs/ and /p/ answer 404); contents: the content sets with gameplay plugins (DESIGN §32.6; none: only the vanilla
 *   set's /cs/ manifest)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, rawPath: string, query: string) => Promise<void>}
 */
export function createStaticHandler({ publicDir, dataDir, sharedDir, simDir = path.join(ROOT, 'server', 'sim'), packsDir = path.join(ROOT, 'packs'),
  pluginsDir = path.join(path.dirname(path.resolve(packsDir)), 'plugins'), packs = null, content = null, log = noopLog,
  visual = null, contents = null, assetsCdn = '', assetsCdnVersion = '', assetsManifest = null, clientBuild = true }) {
  const builtIndex = path.join(publicDir, 'build', 'index.html');
  const useBuiltClient = clientBuild && existsSync(builtIndex);
  const registry = packs || createPluginRegistry({ publicDir, dataDir, packsDir, pluginsDir }, { log: /** @type {any} */ (log) });
  const sets = visual || (typeof registry.pluginFile === 'function' ? createVisualSets({ registry, log }) : null);
  let vanilla = content;
  const vanillaContent = () => (vanilla ||= computeVanillaContent({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log: /** @type {any} */ (log) }));
  // The URL → content hash of every gameplay data file of the vanilla manifest
  // (`/data/<file>.json?v=<sha8>`, server/plugins/identity.js contentIndexOf): the map the `?v=` rule in the
  // file branch below validates against. Built once, from the same bytes the manifest hashed.
  let dataUrls = null;
  const contentDataUrls = () => {
    if (dataUrls) return dataUrls;
    dataUrls = new Map();
    for (const f of Object.values(vanillaContent().index.data || {})) {
      const [url, v] = String(f.url).split('?v=');
      if (url && v) dataUrls.set(url, { sha8: v, sha256: f.sha256, bytes: f.bytes });
    }
    return dataUrls;
  };
  const mounts = [
    { prefix: '/data/', name: 'data', dir: path.resolve(dataDir) },
    { prefix: '/shared/', name: 'shared', dir: path.resolve(sharedDir) },
    // the simulation: ES modules only (no directory listings, no other file types, no Node-only loader)
    { prefix: '/sim/', name: 'sim', dir: path.resolve(simDir), only: new Set(['.js']), deny: SIM_PRIVATE },
    { prefix: '/', name: 'public', dir: path.resolve(publicDir) },
  ];
  const settings = { base: assetsCdn || '', version: assetsCdnVersion || '' };
  const cdn = {
    ...settings,
    // Per-file manifest mode (tools/r2-sync.mjs): art URLs gain a per-file `?v=<hash>` query instead
    // of the whole-tree `_v/<tag>/` prefix, so a release only re-busts the files it changed.
    manifest: assetsManifest && settings.base ? `/assets-manifest.json?v=${assetsManifest.tag}` : '',
    hashes: assetsManifest ? assetsManifest.hashes : null,
    // Metadata and generator changes can leave the art publication tag unchanged. They must
    // still rotate the page release before it keys a long-lived preload manifest.
    preloadVersion: createHash('sha256').update(JSON.stringify(assetsManifest?.preload || {}))
      .update(readFileSync(new URL('../resources.js', import.meta.url)))
      .update(readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 16),
  };
  // the real path of public/studio/ (the plugin studio's page — never a static file, in whatever spelling the disk folds:
  // /ſtudio/ on a case-insensitive macOS disk, /studio./ on Windows)
  let studioReal;
  const studioRealPath = async () => {
    if (studioReal === undefined) studioReal = await fsp.realpath(path.join(path.resolve(publicDir), 'studio')).catch(() => null);
    return studioReal;
  };
  const shimBody = Buffer.from(DATA_SHIM_JS);
  const shimTag = `"shim-${shimBody.length.toString(16)}"`;
  const gzipCache = new CompressCache();
  const release = createAssetVersion(mounts, DATA_SHIM_JS, cdn);
  const resources = createResourceIndex({ dataDir, publicDir, cdnBase: cdn.base, assetsManifest,
    rewrite: (v) => JSON.parse(release.transform(JSON.stringify(v), '.json')), log });
  let assetsManifestBody;
  // Small transformed responses share both the read and the result; bounded independently of the gzip cache.
  const transformed = new Map();
  let transformedBytes = 0;
  const bodyFor = async (absPath, stat, ext) => {
    const key = `${absPath}\0${stat.size}\0${stat.mtimeMs}`;
    if (transformed.has(key)) return transformed.get(key);
    const pending = fsp.readFile(absPath, 'utf8').then((source) => {
      const body = Buffer.from(release.transform(source, ext));
      transformedBytes += body.length;
      if (transformedBytes > (16 << 20)) { transformed.clear(); transformedBytes = 0; }
      return body;
    }).catch((err) => { transformed.delete(key); throw err; });
    transformed.set(key, pending);
    return pending;
  };

  const handler = async function serveStatic(req, res, rawPath, query) {
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) {
      sendError(req, res, 400, '请求地址无效 · Bad request');
      return;
    }
    // the plugin studio's page is never a static file (server/studio/index.js isStudioPath: any spelling of /studio/)
    if (isStudioPath(decoded)) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
    if (useBuiltClient && (decoded === '/' || decoded === '/index.html')) decoded = '/build/index.html';
    // The offline preload manifest (server/resources.js): ETag-hashed, `no-cache`, generated on demand.
    if (decoded.toLowerCase() === '/data/' + RESOURCE_MANIFEST_FILE) {
      const versionedManifest = query === `v=${release.tag}`;
      if (query && !versionedManifest) {
        sendError(req, res, 404, '资源版本已更新 · Reload required'); return;
      }
      try {
        const idx = await resources.get();
        const gz = acceptsGzip(req.headers['accept-encoding']);
        const body = gz ? idx.gzip : idx.body;
        // The ETag hashes the complete response, so unchanged rebuilds and restarts keep the validator and the
        // browser can revalidate (cache: 'no-cache') instead of re-downloading; each encoding gets its own tag.
        const etag = gz ? `${idx.etag.slice(0, -1)}-gz"` : idx.etag;
        const mtime = new Date(idx.mtimeMs);
        const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', ETag: etag,
          'Last-Modified': mtime.toUTCString(), Vary: 'Accept-Encoding',
          // Only the current release URL may be shared for 12h. Legacy clients and the worker's
          // unversioned fallback retain a 15s proxy TTL. Browsers continue to revalidate.
          'X-Accel-Expires': versionedManifest ? '43200' : '15' };
        if (gz) headers['Content-Encoding'] = 'gzip';
        if (isNotModified(req, etag, mtime)) { res.writeHead(304, headers); res.end(); return; }
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body);
      } catch (err) { log.error('[resources] manifest failed', err); sendError(req, res, 500, '无法生成资源清单'); }
      return;
    }
    // The per-file art manifest (`.assets-manifest.json`, tools/r2-sync.mjs). Its body is a pure
    // function of the `?v=<tag>` in the URL, so immutable cache headers are safe — and a tag that
    // is not this boot's release (an older page, a newer server) gets a hard 404, mirroring the
    // /_v/ rule: no release's hashes may be cached under another release's URL.
    if (decoded === '/assets-manifest.json') {
      if (!cdn.manifest || query !== `v=${assetsManifest.tag}`) {
        sendError(req, res, 404, '页面不存在 · Not found');
        return;
      }
      // Keep the immutable client manifest byte-for-byte compatible when only server metadata is added.
      const body = assetsManifestBody ??= Buffer.from(JSON.stringify({ tag: assetsManifest.tag, hashes: assetsManifest.hashes }));
      const gz = acceptsGzip(req.headers['accept-encoding']);
      const etag = `"assets-${assetsManifest.tag}${gz ? '-gz' : ''}"`;
      const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': IMMUTABLE_CACHE, Vary: 'Accept-Encoding', ETag: etag };
      if (gz) headers['Content-Encoding'] = 'gzip';
      if (req.headers['if-none-match'] && isNotModified(req, etag, new Date(0))) { res.writeHead(304, headers); res.end(); return; }
      if (gz) {
        const gzip = await gzipCache.get('/__assets-manifest__', { size: body.length, mtimeMs: 0 }, body, assetsManifest.tag);
        headers['Content-Length'] = gzip.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : gzip);
        return;
      }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    let versioned = false;
    if (decoded.startsWith(VERSION_PREFIX)) {
      const match = /^\/_v\/([a-f0-9]{16})(\/.*)$/.exec(decoded);
      if (!match || !/^\/(?:js|css|fonts|vendor|assets|data|shared|sim|media)\/|^\/data\.js$/.test(match[2])) {
        sendError(req, res, 404, '页面不存在 · Not found'); return;
      }
      // Never serve this release's bytes under an old immutable URL after deployment.
      const legacyCode = /^\/(?:js|vendor|shared|sim)\//.test(match[2]) || match[2] === '/data.js';
      if (match[1] !== release.expectedTag(match[2]) && !(legacyCode && match[1] === release.tag)) { sendError(req, res, 404, '资源版本已更新 · Reload required'); return; }
      decoded = match[2];
      versioned = true;
    }
    // Public art is reusable by other game hosts. Never grant CORS to game state, APIs or private modules.
    if (/^\/(?:assets|fonts|media)\//.test(decoded)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Accept-Ranges');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Max-Age': '86400' }); res.end(); return;
      }
    }
    if (decoded === '/data.js') {
      const headers = { 'Content-Type': MIME['.js'], 'Cache-Control': versioned ? IMMUTABLE_CACHE : 'no-cache', ETag: shimTag, 'Content-Length': shimBody.length };
      if (isNotModified(req, shimTag, new Date(0))) { delete headers['Content-Length']; res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : shimBody);
      return;
    }
    // The plugin catalogue (server/plugins/registry.js; never cached) and the vanilla content set's manifest
    if (decoded === `${PLUGINS_URL}index.json`) {
      const vanilla = vanillaContent().cs;
      // a registry of 0.2.0's shape (a caller's own `packs`) has no catalogue: an empty one
      sendJson(req, res, 200, typeof registry.pluginIndex === 'function' ? registry.pluginIndex({ vanilla }) : buildPluginIndex([], { vanilla }));
      return;
    }
    if (decoded.startsWith('/cs/')) {
      const c = vanillaContent();
      if (decoded !== `/cs/${csUrlPart(c.cs)}/index.json`) {
        // a content set with gameplay plugins (DESIGN §32.6, server/plugins/contentSets.js): its manifest and its patched
        // data files — a URL naming its content, so cached for good; 404 for a set this server does not keep
        const m = CS_FILE.exec(decoded);
        const f = m && contents && !m[2].split('/').some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.')) ? contents.file(m[1], m[2]) : null;
        if (!f) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
        await serveBuffer(req, res, { body: f.body, hash: `cs-${m[1]}-${(f.sha256 || 'index').slice(0, 8)}`, type: f.type || MIME['.json'], cacheControl: IMMUTABLE_JSON, key: `cs:${decoded}`, cache: gzipCache });
        return;
      }
      const body = Buffer.from(JSON.stringify(c.index));
      const tag = `"cs-${csUrlPart(c.cs)}-v${PLUGIN_INDEX_VERSION}"`;
      const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': IMMUTABLE_JSON, ETag: tag, 'Content-Length': body.length };
      if (isNotModified(req, tag, new Date(0))) { delete headers['Content-Length']; res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    // Visual sets (server/plugins/visualSet.js): a set's composition and writes
    if (decoded.startsWith(VISUAL_SETS_URL)) {
      const m = VISUAL_DOC.exec(decoded);
      const doc = m && sets ? await sets.doc(m[1]) : null;
      if (!doc) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
      await serveBuffer(req, res, { body: doc.body, hash: doc.hash, type: MIME['.json'], cacheControl: 'no-cache', key: `vs:${decoded}`, cache: gzipCache });
      return;
    }
    // A cosmetic plugin's files, or a ui plugin's frame files, at the hash of their bytes (see the header)
    if (decoded.startsWith(PLUGIN_FILES_URL)) {
      const [id, hash, ...segments] = decoded.slice(PLUGIN_FILES_URL.length).split('/');
      const rel = segments.join('/');
      const ok = isPluginId(id) && FILE_HASH.test(hash || '') && segments.length > 0 && isPackPath(rel)
        && !segments.some((x) => x === '' || x === '.' || x === '..' || x.startsWith('.'));
      let f = ok && sets ? sets.file(id, rel) : null;
      // extension-less audio (download managers: shared/media.js): the listed audio file of that name — the one whose
      // hash the URL names when there are two
      if (!f && ok && sets && !extOf(rel)) {
        const found = PLUGIN_AUDIO_EXTS.map((e) => sets.file(id, rel + e)).filter(Boolean);
        f = found.find((x) => x.urlHashes.has(hash)) || found[0] || null;
      }
      // the very file the scan hashed: a symbolic link put in its place is never followed (wherever it leads — another
      // file of the folder, a dot file, outside), nor is one put in place of a folder on its way (its real path changed)
      const st = f ? await fsp.lstat(f.abs).catch(() => null) : null;
      const real = st && st.isFile() ? await fsp.realpath(f.abs).catch(() => null) : null;
      if (!st || !st.isFile() || !real || real !== f.real) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
      // still the bytes that were hashed: the same size, mtime, inode and ctime (registry.js statIdentity) — else the
      // current file goes out with no-cache and the folders are read again
      const same = sameIdentity(statIdentity(st), f);
      if (!same) sets.noteChanged();
      await serveFile(req, res, f.abs, st, 'plugins', segments, gzipCache, log, {
        // the ETag: the content hash of the bytes the scan hashed — of a changed file, its stat identity (size and mtime
        // alone would revalidate a rewrite that kept them: a 304 for other bytes)
        contentHash: same ? f.sha256.slice(0, 16) : `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${st.ino.toString(16)}-${Math.floor(st.ctimeMs * 1000).toString(16)}`,
        cacheControl: same && f.urlHashes.has(hash) ? IMMUTABLE_CACHE : 'no-cache',
        // [ASSUMED] the frame CSP is only on a ui plugin's /p/ files (f.frame), including its sandbox
        // allow-scripts (no allow-same-origin). serveFile puts it on 200, 206 and 304. 'self' may not match
        // the opaque origin.
        headers: f.frame ? { 'Content-Security-Policy': UI_FRAME_CSP } : null,
      });
      return;
    }
    // Language packs (server/plugins/registry.js): the live index, and only the files a lang manifest names
    if (decoded.startsWith(PACKS_URL)) {
      const parts = decoded.slice(PACKS_URL.length).split('/');
      if (parts.length === 1 && parts[0] === PACK_INDEX_FILE) { sendJson(req, res, 200, registry.index()); return; }
      const abs = parts.length >= 2 && !parts.some((s) => s === '' || s === '.' || s === '..') ? registry.servable(parts[0], parts.slice(1).join('/')) : null;
      const st = abs ? await fsp.stat(abs).catch(() => null) : null;
      if (!st || !st.isFile()) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
      await serveFile(req, res, abs, st, 'packs', parts, gzipCache, log);
      return;
    }
    // Extension-less audio (download-manager avoidance): /media/bgm/act1 → /assets/audio/bgm/act1.mp3
    if (decoded.startsWith(MEDIA_PREFIX)) {
      await serveMedia(req, res, decoded.slice(MEDIA_PREFIX.length), publicDir, gzipCache, log, release, versioned);
      return;
    }
    // Bare mount paths (e.g. "/data") → treat as the mount directory.
    const mount = mounts.find((m) => decoded.startsWith(m.prefix) || decoded === m.prefix.slice(0, -1)) || mounts[mounts.length - 1];
    const rest = decoded.length > mount.prefix.length ? decoded.slice(mount.prefix.length) : '';
    const segments = rest.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.')) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }
    if (segments.some((s) => s.startsWith('.'))) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
    if (mount.only && (!segments.length || !mount.only.has(path.extname(segments[segments.length - 1]).toLowerCase())
      // (case-insensitive: the host may be Windows / macOS, where NODEDATA.JS opens nodeData.js)
      || (mount.deny && mount.deny.has(segments[segments.length - 1].toLowerCase())))) {
      sendError(req, res, 404, '页面不存在 · Not found');
      return;
    }
    let absPath = path.join(mount.dir, ...segments);
    if (absPath !== mount.dir && !absPath.startsWith(mount.dir + path.sep)) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }

    let stat;
    let viaDirectory = false;
    try {
      stat = await fsp.stat(absPath);
      if (stat.isDirectory()) {
        if (!decoded.endsWith('/')) {
          // Built from normalized segments (never from the raw path) so "//host" can't become an open redirect.
          const canonical = (mount.prefix + segments.map(encodeURIComponent).join('/') + '/').replace(/\/{2,}/g, '/');
          const loc = versioned ? release.url(canonical) : canonical;
          res.writeHead(301, { Location: loc + (query ? `?${query}` : ''), 'Cache-Control': 'no-cache', 'Content-Length': 0 });
          res.end();
          return;
        }
        absPath = path.join(absPath, 'index.html');
        segments.push('index.html');
        viaDirectory = true;
        stat = await fsp.stat(absPath);
      }
      // Not a regular file, or a file addressed like a directory ("/app.js/") → 404.
      if (!stat.isFile() || (decoded.endsWith('/') && !viaDirectory)) {
        throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      }
      if (mount.deny) {
        // the on-disk name decides (case-insensitive file systems, Windows 8.3 short names like NODEDA~1.JS)
        const real = await fsp.realpath(absPath);
        if (mount.deny.has(path.basename(real).toLowerCase())) throw Object.assign(new Error('private'), { code: 'ENOENT' });
      }
    } catch (e) {
      if (e && e.code === 'ENOENT' && mount.name === 'data' && segments.length === 1 && LOCAL_ART_MANIFESTS.has(segments[0])) {
        // Optional local-client art (DESIGN §13): an install without it gets an empty manifest instead of a 404,
        // so browsers don't log an error on every page load. Clients treat empty groups as "no local art".
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Content-Length': EMPTY_LOCAL_ART.length });
        res.end(req.method === 'HEAD' ? undefined : EMPTY_LOCAL_ART);
      } else if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR' || e.code === 'ENAMETOOLONG')) {
        sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : '');
      } else if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
        sendError(req, res, 403, '禁止访问 · Forbidden');
      } else {
        log.error('[http] stat failed', e);
        sendError(req, res, 500, '服务器内部错误 · Internal error');
      }
      return;
    }
    const first = segments[0] || '';
    if (mount.name === 'public' && (first.toLowerCase().startsWith('studio') || /[^\x00-\x7f]/.test(first))) {
      const studio = await studioRealPath();
      const real = studio ? await fsp.realpath(absPath).catch(() => null) : null;
      if (studio && (!real || real === studio || real.startsWith(studio + path.sep))) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
    }
    // Compare the actual file, including case-insensitive / encoded aliases, before every 200/206/304.
    if (mount.name === 'public' && path.basename(absPath).toLowerCase() === 'simworker.js') {
      const real = await fsp.realpath(absPath);
      const worker = await fsp.realpath(path.join(publicDir, 'js/battle/simWorker.js')).catch(() => null);
      if (real === worker) res.setHeader('Content-Security-Policy', SIM_WORKER_CSP);
    }
    if (versioned && !release.matchesFile(absPath, stat)) {
      sendError(req, res, 503, '资源文件已变更，请重启服务器 · Restart required'); return;
    }
    const ext = path.extname(absPath).toLowerCase();
    // Board sidecars use asset names/relative paths, resolved through the local-art manifest by the renderer.
    // Keep their bytes identical to the CDN and hash tooling so verified ZIP imports work across hosts.
    const rewrite = ['.html', '.htm'].includes(ext) || (versioned && (ext === '.css' || (ext === '.json'
      && !isBoardResourceJson(decoded) && (mount.name === 'data' || segments[0] === 'assets'))));
    const body = rewrite ? await bodyFor(absPath, stat, ext) : null;
    const builtAsset = /^\/build\/assets\/[\w.-]+-[\w-]{8,}\.[a-z0-9]+$/.test(decoded);
    // A gameplay data file named by its own content hash (?v=<sha8>, the URL of the vanilla content manifest):
    // the server made that URL out of those bytes, so the response is immutable — but only while the file is still
    // the size the manifest hashed. Any other query pins nothing and stays no-cache (files.js cacheControlFor).
    let dataTag = '';
    if (query && mount.name === 'data') {
      const m = /^v=([a-f0-9]{8})$/.exec(query);
      const entry = m ? contentDataUrls().get(decoded) : null;
      if (entry && entry.sha256.startsWith(m[1]) && entry.bytes === stat.size) dataTag = m[1];
    }
    await serveFile(req, res, absPath, stat, mount.name, segments, gzipCache, log, { body,
      variant: rewrite ? release.tag : (dataTag ? 'cs-' + dataTag : ''),
      versioned: versioned || builtAsset, cacheControl: dataTag ? IMMUTABLE_JSON : null });
  };
  handler.version = release.tag;
  handler.runtimeVersion = release.runtimeTag;
  handler.artVersion = release.artTag;
  // The request handler builds the site CSP from the bytes this server actually serves (http/csp.js):
  // the transformed page carries a rewritten import map and the injected release tag.
  handler.transformPage = (text, ext) => release.transform(text, ext);
  /** Cache usage for /healthz: the gzip LRU and the small transformed-response cache. */
  handler.cacheStats = () => ({ gzipBytes: gzipCache.total, gzipEntries: gzipCache.map.size,
    gzipLimitBytes: gzipCache.maxTotal, gzipInflight: gzipCache.inflight.size,
    transformedBytes, transformedEntries: transformed.size });
  return handler;
}
