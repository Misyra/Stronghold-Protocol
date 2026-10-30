import { BackgroundClient } from '../workers/backgroundClient.js';
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
//                plugin (/p/…) are served
//     /cs/<cs16>/index.json → the manifest of the vanilla content set (server/plugins/identity.js contentIndexOf),
//                cached for good — for this server's vanilla `cs` (its first 16 hex digits) and, from P1c (DESIGN §32.6),
//                a content set with gameplay plugins a room uses or used lately (server/plugins/contentSets.js: the same
//                shape with `vanilla: false`, its plugins, settings and modes)
//     /cs/<cs16>/data/<file>.json, /cs/<cs16>/i18n/<lang>.json → a data or translation file that content set changed,
//                its served bytes from memory (cached for good; every other file of the set is named by its plain
//                /data/…?v=<8 hex> URL in the manifest)
//     /vs/<vs16>/overlay.json → a visual set of cosmetic plugins (server/plugins/visualSet.js): its composition and
//                its plugins' writes, which a page lays over the manifest it loaded itself (a room's set, a player's
//                personal plugin) — no-cache, the body's hash as ETag; 404 for a set this server does not know
//     /p/<id>/<hash8>/<path> → a file of a loaded cosmetic plugin — only one its overlay names — or a frame file of a
//                loaded ui plugin (html / js / css / png under entry.client). registry pluginFile is the whitelist
//                (no dot file, no `..`; only the very file the scan hashed — a symbolic link put in its place, or in place
//                of a folder on its way, is never followed, wherever it leads). A hash naming its current bytes (its own
//                first 8 hex digits, or its Spine model's) answers `immutable` for a year while the file keeps the size,
//                mtime, inode and ctime it was hashed with; any other hash, or a file changed since the scan, the current
//                file with `no-cache` — as for /assets/~<hash>/ below — and a changed file has the registry read the
//                folders again. An audio file is also served without its extension — /p/<id>/<hash8>/<path without
//                .mp3 / .ogg> — for the same download managers as /media/ below (public/js/media.js mediaUrl; when both
//                a .mp3 and a .ogg are listed, the one whose hash the URL names)
// Traversal and dotfile protection, directory redirects, and the empty optional local-art manifest.
// Files go out through files.js serveFile with brotli / gzip negotiation.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { rewriteAssetPaths } from '../../shared/cdn.js';
import { createResourceIndex, RESOURCE_MANIFEST_FILE, RESOURCE_PACK_MANIFEST_FILE } from '../resources.js';
import { createAssetVersion, VERSION_PREFIX } from '../assetVersion.js';
import { SIM_WORKER_CSP } from './csp.js';
import { UI_FRAME_CSP } from '../../shared/plugins/ui.js';
import { routeResourcePacks } from '../../shared/resourcePackRoutes.js';
import path from 'node:path';
import { MEDIA_PREFIX } from '../../shared/media.js';
import { ROOT, noopLog } from './config.js';
import { sendError, sendJson } from './common.js';
import { MIME, CompressCache, isNotModified, serveFile, acceptsGzip, IMMUTABLE_CACHE, serveBuffer as serveHashedBuffer } from './files.js';
import { serveMedia } from './media.js';
import { createPluginRegistry, sameIdentity, statIdentity } from '../plugins/registry.js';
import { computeVanillaContent } from '../plugins/identity.js';
import { createVisualSets } from '../plugins/visualSet.js';
import { isStudioPath } from '../studio/paths.js';
import { PACKS_URL, PACK_INDEX_FILE } from '../../shared/packs.js';
import { PLUGINS_URL, PLUGIN_INDEX_VERSION, buildPluginIndex, extOf, isPackPath, isPluginId } from '../../shared/plugins/manifest.js';
import { csUrlPart } from '../../shared/plugins/identity.js';
import { FILE_URL_DIGITS, PLUGIN_AUDIO_EXTS, PLUGIN_FILES_URL, VISUAL_DOC_FILE, VISUAL_SETS_URL, VS_URL_DIGITS } from '../../shared/plugins/visual.js';

/** Browser stand-in of server/data.js, served at /data.js (see the header). Served byte for byte: its first line names the entry, server/index.js. */
export const DATA_SHIM_JS = `// Generated by server/index.js — browser stand-in for server/data.js (DESIGN §14 client-side combat).
// The simulation's content modules (/sim/content/support/index.js) import getData() from here; it returns the game data
// the page injected with /sim/simdata.js setSimData(data).
// 取自 xinhai-ai/Stronghold-Protocol 的 static.js；它原来的 import 路径 './sim/simdata.js' 在该仓库里并不存在，
// 本仓库的模拟数据模块在 server/sim/simdata.js，因此这里改成 '../sim/simdata.js'（同一个模块，仅路径修正）。
import { getSimData } from '../sim/simdata.js';
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
 * The body of a pack or plugin index, taken from a scan that includes the folders as they are now. Both are served
 * "never cached" and both are how a freshly installed pack or plugin is found (docs/PACKS.md, docs/PLUGINS.md). The
 * registry of server/index.js scans in a worker (background: true): there a read only kicks the scan and answers with
 * the previous snapshot, so an index route waits for the one its own request started instead of showing a pack that
 * was installed a second ago as absent. A rescan that fails keeps the last good index — a broken folder must not
 * take the catalogue down with it.
 * @param {{ pending?: () => Promise<unknown> | null }} registry the pack registry, when it scans in the background
 * @param {() => unknown} body
 */
async function settledIndex(registry, body) {
  const last = body();
  const pending = typeof registry.pending === 'function' ? registry.pending() : null;
  if (!pending) return last;
  try { await pending; } catch { return last; }
  return body();
}

/**
 * Create the static request handler.
 * @param {{ publicDir: string, dataDir: string, sharedDir: string, simDir?: string, packsDir?: string,
 *   packs?: ReturnType<typeof createPluginRegistry>, log?: object }} dirs
 *   packs: the server pack registry; runtime CDN and Vite behavior remain branch-owned.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, rawPath: string, query: string) => Promise<void>}
 */
export function createStaticHandler({ publicDir, dataDir, sharedDir, simDir = path.join(ROOT, 'server', 'sim'), packsDir = path.join(ROOT, 'packs'), pluginsDir = path.join(path.dirname(path.resolve(packsDir)), 'plugins'), packs = null, content = null, visual = null, contents = null, log = noopLog, cdnBase = '', dataCdnBase = '', resourcePackRoutes = [], assetsManifest = null, clientBuild = true }) {
  const registry = packs || createPluginRegistry({ publicDir, dataDir, packsDir, pluginsDir }, { log: /** @type {any} */ (log) });
  const cdn = typeof cdnBase === 'string' ? cdnBase : '';
  const builtIndex = path.join(publicDir, 'build', 'index.html');
  const useBuiltClient = clientBuild && fs.existsSync(builtIndex);
  // the preload manifest (docs/ASSETS.md「Preload」): built on first request, cached until the manifests change
  const resources = createResourceIndex({ dataDir, publicDir, cdnBase: cdn, resourcePackRoutes, rewrite: (v) => (cdn ? rewriteAssetPaths(v, cdn) : v), log });
  /** @type {Map<string, { mtimeMs: number, size: number, ctimeMs: number, ino: number, body: Buffer, hash: string }>} rewritten manifests */
  const cdnCache = new Map();
  const cdnPending = new Map();
  const manifestEncoder = new BackgroundClient(new URL('../workers/manifestEncode.js', import.meta.url));
  const sets = visual || (typeof registry.pluginFile === 'function' ? createVisualSets({ registry, log }) : null);
  let vanilla = content;
  const vanillaContent = () => (vanilla ||= computeVanillaContent({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log: /** @type {any} */ (log) }));
  const mounts = [
    { prefix: '/data/', name: 'data', dir: path.resolve(dataDir) },
    { prefix: '/shared/', name: 'shared', dir: path.resolve(sharedDir) },
    // the simulation: ES modules only (no directory listings, no other file types, no Node-only loader)
    { prefix: '/sim/', name: 'sim', dir: path.resolve(simDir), only: new Set(['.js']), deny: SIM_PRIVATE },
    { prefix: '/', name: 'public', dir: path.resolve(publicDir) },
  ];
  // the real path of public/studio/ (the plugin studio's page — never a static file, in whatever spelling the disk folds:
  // /ſtudio/ on a case-insensitive macOS disk, /studio./ on Windows)
  let studioReal;
  const studioRealPath = async () => {
    if (studioReal === undefined) studioReal = await fsp.realpath(path.join(path.resolve(publicDir), 'studio')).catch(() => null);
    return studioReal;
  };
  const shimBody = Buffer.from(DATA_SHIM_JS);
  const shimTag = `"shim-${shimBody.length.toString(16)}"`;
  // 版本化 /data.js（/_v/<tag>/data.js）：同一条垫片，但它引的 '../sim/simdata.js' 在那个地址下会
  // 爬出命名空间变成 /_v/sim/simdata.js —— 那里没有 tag，静态层一律 404，整条战斗数据链断在第一步。
  // 所以要先把垫片过一遍相对说明符改写，再按发布 tag 给 immutable（字节只由这次发布决定）。
  let shimVersioned = null;
  const shimVersionedBody = () => {
    if (!shimVersioned) {
      const body = Buffer.from(rewriteRelativeImports(DATA_SHIM_JS, '/data.js'));
      shimVersioned = { body, tag: `"shim-v-${release.runtimeTag}-${body.length.toString(16)}"` };
    }
    return shimVersioned;
  };
  const gzipCache = new CompressCache(); // brotli and gzip bodies (files.js)
  /** 每文件指纹清单的响应体（一次构建，按 tag 重建时随进程重启） */
  let manifestBody = null;

  // 本仓库追加：发布版本层（server/assetVersion.js）—— 代码走 /_v/<runtimeTag>/（immutable），
  // 素材走 CDN 的每文件 ?v=<哈希>；两者都由下面同一个 release 决定，所以一次发布只 re-bust 变了的文件。
  const release = createAssetVersion(mounts, DATA_SHIM_JS, { base: cdn, version: '', manifest: assetsManifest?.tag && cdn ? `/assets-manifest.json?v=${assetsManifest.tag}` : '', hashes: assetsManifest?.hashes || null });
  /**
   * 哪些响应要就地改写：HTML 与 CSS 一律（页面要拿到版本前缀与 __sp* 全局，CSS 要改写 url()），
   * JSON 只在版本化地址下改写（/_v/<tag>/data/assets.json）—— 普通 /data/*.json 必须原样送出，
   * 它们已经被 CDN 改写层（rewriteAssetPaths / manifestEncode）处理过，游戏数据也不该带版本前缀。
   * JS 不改写：release.transform 对 .js 本来就不动手，但相对说明符必须改（见下）。
   */
  // 相对说明符在 /_v/<tag>/ 下会爬出命名空间：/_v/<tag>/sim/simdata.js 里的 '../../shared/x.js'
  // 被浏览器解析成 /_v/shared/x.js —— 少了 tag，服务器不认，整条模拟线程全 404。所以按模块自身的
  // 逻辑路径把「以 . 开头」的说明符解析成绝对地址，再交给 release.url 挂上本次发布的 tag。其余字节不动。
  const RELATIVE_SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*)\2/g;
  const rewriteRelativeImports = (source, modulePath) => source.replace(RELATIVE_SPEC, (whole, head, quote, spec) => {
    const cut = spec.search(/[?#]/);
    const clean = cut === -1 ? spec : spec.slice(0, cut);
    const suffix = cut === -1 ? '' : spec.slice(cut);
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(modulePath), clean));
    if (!abs.startsWith('/') || abs.includes('../')) return whole;
    return `${head}${quote}${release.url(abs)}${suffix}${quote}`;
  });
  const transformFor = (ext, versioned, modulePath) => {
    if (ext === '.html' || ext === '.htm' || ext === '.css') return (source, e) => release.transform(source, e);
    if (ext === '.json' && versioned) return (source, e) => release.transform(source, e);
    if (ext === '.js' && versioned && modulePath) return (source) => rewriteRelativeImports(source, modulePath);
    return null;
  };

  // 本仓库追加：每文件指纹清单（.assets-manifest.json，tools/r2-sync.mjs 产出）。它把艺术素材的 URL 变成
  // `<cdn>/assets/x.png?v=<文件哈希>`：内容不变 URL 不变，CDN 缓存键天然带版本。只有配了 CDN 基址时才有意义。
  const assetsManifestPath = assetsManifest?.tag && cdn ? `/assets-manifest.json?v=${assetsManifest.tag}` : '';
  // A small runtime module supplies the base before client data/asset loaders run; no separate config fetch needed.
  const cdnConfigBody = Buffer.from(`export const ASSETS_CDN = ${JSON.stringify(cdn)};\nexport const DATA_CDN = ${JSON.stringify(dataCdnBase)};\nexport const ASSETS_MANIFEST = ${JSON.stringify(assetsManifestPath)};\n`);
  const cdnConfigTag = `"asset-cdn-${createHash('sha256').update(cdnConfigBody).digest('hex')}"`;

  const serveStatic = async function (req, res, rawPath, query) {
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) {
      sendError(req, res, 400, '请求地址无效 · Bad request');
      return;
    }
    // 版本化地址（server/assetVersion.js）：/_v/<tag>/js/… 之类只认本次发布算出来的 tag，
    // 旧页面的 URL 在发版后一律 404（宁可让页面重载，也不能把新字节挂在旧 URL 上被永久缓存）。
    let versioned = false;
    if (decoded.startsWith(VERSION_PREFIX)) {
      const match = /^\/_v\/([a-f0-9]{16})(\/.*)$/.exec(decoded);
      // `/data.js` is the one versioned URL that is not under a directory: the importmap names it (assetVersion
      // rewrites the `/data.js` entry to `/_v/<runtimeTag>/data.js`), and the shim below answers it.
      if (!match || !/^\/(?:(?:js|css|fonts|vendor|assets|data|shared|sim|media)\/|data\.js$)/.test(match[2])) {
        sendError(req, res, 404, '页面不存在 · Not found');
        return;
      }
      const legacyCode = /^\/(?:js|vendor|shared|sim)\//.test(match[2]);
      if (match[1] !== release.expectedTag(match[2]) && !(legacyCode && match[1] === release.tag)) {
        sendError(req, res, 404, '资源版本已更新 · Reload required');
        return;
      }
      decoded = match[2];
      versioned = true;
    }
    // 客户端把发布 tag 挂在 `?v=` 上（public/js/resourceUrl.js:49-56）：/data/… 用 asset tag，
    // js/vendor/shared/sim 用 runtime tag，assets/fonts/media 用 art tag。这些 tag 是**内容摘要**
    // （server/assetVersion.js:85-91）：runtime tag 吃进 js/vendor/shared/sim/data/packs 的字节，
    // art tag 吃进 assets/fonts/media 的字节，所以「URL 上的 tag 等于本次发布算出来的 tag」等价于
    // 「这份字节以后不会再变」——可以直接 immutable 缓存，连 304 往返都省掉。
    // 不等于的一律照旧 no-cache：旧页面手里的旧 tag 必须重新验证，不能把新字节挂在旧 URL 上长期缓存
    // （和 /_v/ 是同一条规则：宁可让页面重新验证，也不给错字节贴一张永不过期的 URL）。
    const queryTag = typeof query === 'string' && /^v=[a-f0-9]{16}$/.test(query) ? query.slice(2) : '';
    const tagVerified = !versioned && queryTag !== '' && queryTag === release.expectedTag(decoded);
    if (useBuiltClient && (decoded === '/' || decoded === '/index.html')) {
      // 打包页同样要带上发布标签（内联脚本、importmap 的 CDN 改写），CSP 会把这段内联脚本算进 script-src
      await serveFile(req, res, builtIndex, await fsp.stat(builtIndex), 'public', ['build', 'index.html'], query, gzipCache, log,
        { transform: transformFor('.html', versioned) });
      return;
    }
    // 每文件指纹清单：只有本次发布的 `?v=<tag>` 能取到，别的 tag 一律 404 —— 一份清单的指纹不能被挂到另一次发布的
    // URL 上长期缓存。内容只由 tag 决定，所以可以直接 immutable。
    if (decoded === '/assets-manifest.json') {
      if (!assetsManifest || query !== `v=${assetsManifest.tag}`) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
      if (!manifestBody) manifestBody = Buffer.from(JSON.stringify({ tag: assetsManifest.tag, hashes: assetsManifest.hashes }));
      const gz = acceptsGzip(req.headers['accept-encoding']);
      const body = gz ? await gzipCache.compressed('/__assets-manifest__' + assetsManifest.tag, () => Promise.resolve(manifestBody), 'gzip', '.json') : manifestBody;
      const etag = `"assets-${assetsManifest.tag}${gz ? '-gz' : ''}"`;
      const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': IMMUTABLE_CACHE, Vary: 'Accept-Encoding', ETag: etag };
      if (gz) headers['Content-Encoding'] = 'gzip';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    // The runtime CDN setting is served by the game origin, independent of the data CDN.
    if (decoded === '/js/asset-cdn.js') {
      const headers = { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', ETag: cdnConfigTag };
      if (isNotModified(req, cdnConfigTag, new Date(0))) { res.writeHead(304, headers); res.end(); return; }
      headers['Content-Length'] = cdnConfigBody.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : cdnConfigBody);
      return;
    }
    // The offline-resource manifest is generated, never read from disk, before the mount handling below.
    if (decoded.toLowerCase() === `/data/${RESOURCE_MANIFEST_FILE}`) {
      let idx;
      try {
        idx = await resources.get();
      } catch (e) {
        log.error('[http] cannot build the resource manifest', e);
        sendError(req, res, 500, '服务器内部错误 · Internal error');
        return;
      }
      const gz = acceptsGzip(req.headers['accept-encoding']) ? idx.gzip : null;
      const body = gz || idx.body;
      const stat = { size: idx.body.length, mtimeMs: idx.mtimeMs, mtime: new Date(idx.mtimeMs) };
      const etag = gz ? `${idx.etag.slice(0, -1)}-gz"` : idx.etag;
      const headers = {
        'Content-Type': MIME['.json'],
        // `?v=<tag>` 就是这张清单内容的摘要（tag 同时吃进 runtime 与 art 字节），所以发布了新素材
        // 这个 URL 必然变；带上发布 tag 的请求可以直接 immutable，不带 tag 的仍旧每次验证。
        'Cache-Control': tagVerified ? IMMUTABLE_CACHE : 'no-cache',
        ETag: etag,
        'Last-Modified': stat.mtime.toUTCString(),
        Vary: 'Accept-Encoding',
      };
      if (gz) headers['Content-Encoding'] = 'gzip';
      if (isNotModified(req, etag, stat.mtime)) { res.writeHead(304, headers); res.end(); return; }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (decoded.toLowerCase() === `/data/${RESOURCE_PACK_MANIFEST_FILE}`) {
      const file = path.join(dataDir, RESOURCE_PACK_MANIFEST_FILE);
      try {
        const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (doc.format === 'stronghold-resource-pack-index' && doc.version === 1) {
          doc.packs = routeResourcePacks(doc.packs, cdn, resourcePackRoutes);
        }
        const body = Buffer.from(JSON.stringify(doc));
        const st = await fsp.stat(file);
        const etag = `"resource-packs-${createHash('sha256').update(body).digest('hex')}"`;
        const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': tagVerified ? IMMUTABLE_CACHE : 'no-cache',
          ETag: etag, 'Last-Modified': st.mtime.toUTCString(), 'Content-Length': body.length };
        if (isNotModified(req, etag, st.mtime)) { res.writeHead(304, headers); res.end(); return; }
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch (error) {
        if (error?.code === 'ENOENT') sendError(req, res, 404, '页面不存在 · Not found');
        else { log.error('[resources] cannot read resource pack index', error); sendError(req, res, 500, '服务器内部错误 · Internal error'); }
      }
      return;
    }
    // the plugin studio's page is never a static file (server/studio/index.js isStudioPath: any spelling of /studio/)
    if (isStudioPath(decoded)) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
    if (decoded === '/data.js') {
      const shim = versioned ? shimVersionedBody() : { body: shimBody, tag: shimTag };
      const headers = {
        'Content-Type': MIME['.js'],
        'Cache-Control': versioned ? IMMUTABLE_CACHE : 'no-cache',
        ETag: shim.tag,
        'Content-Length': shim.body.length,
      };
      if (isNotModified(req, shim.tag, new Date(0))) { delete headers['Content-Length']; res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : shim.body);
      return;
    }
    // The plugin catalogue (server/plugins/registry.js; never cached) and the vanilla content set's manifest
    if (decoded === `${PLUGINS_URL}index.json`) {
      const vanilla = vanillaContent().cs;
      // a registry of 0.2.0's shape (a caller's own `packs`) has no catalogue: an empty one
      sendJson(req, res, 200, await settledIndex(registry,
        () => (typeof registry.pluginIndex === 'function' ? registry.pluginIndex({ vanilla }) : buildPluginIndex([], { vanilla }))));
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
        await serveHashedBuffer(req, res, { body: f.body, hash: `cs-${m[1]}-${(f.sha256 || 'index').slice(0, 8)}`, type: f.type || MIME['.json'], cacheControl: IMMUTABLE_JSON, key: `cs:${decoded}`, cache: gzipCache });
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
      await serveHashedBuffer(req, res, { body: doc.body, hash: doc.hash, type: MIME['.json'], cacheControl: 'no-cache', key: `vs:${decoded}`, cache: gzipCache });
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
      await serveFile(req, res, f.abs, st, 'plugins', segments, query, gzipCache, log, {
        // ui 插件的 frame 文件带自己的策略（shared/plugins/ui.js UI_FRAME_CSP），装饰性素材不带
        ...(f.frame ? { headers: { 'Content-Security-Policy': UI_FRAME_CSP } } : {}),
        // the ETag: the content hash of the bytes the scan hashed — of a changed file, its stat identity (size and mtime
        // alone would revalidate a rewrite that kept them: a 304 for other bytes)
        contentHash: same ? f.sha256.slice(0, 16) : `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${st.ino.toString(16)}-${Math.floor(st.ctimeMs * 1000).toString(16)}`,
        cacheControl: same && f.urlHashes.has(hash) ? IMMUTABLE_CACHE : 'no-cache',
      });
      return;
    }
    // Language packs (server/plugins/registry.js): the live index, and only the files a lang manifest names
    if (decoded.startsWith(PACKS_URL)) {
      const parts = decoded.slice(PACKS_URL.length).split('/');
      if (parts.length === 1 && parts[0] === PACK_INDEX_FILE) {
        sendJson(req, res, 200, await settledIndex(registry, () => registry.index()));
        return;
      }
      const abs = parts.length >= 2 && !parts.some((s) => s === '' || s === '.' || s === '..') ? registry.servable(parts[0], parts.slice(1).join('/')) : null;
      const st = abs ? await fsp.stat(abs).catch(() => null) : null;
      if (!st || !st.isFile()) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
      await serveFile(req, res, abs, st, 'packs', parts, query, gzipCache, log);
      return;
    }
    // Extension-less audio (download-manager avoidance): /media/bgm/act1 → /assets/audio/bgm/act1.mp3
    if (decoded.startsWith(MEDIA_PREFIX)) {
      // 本仓库的 serveMedia 签名没有 query（上游的 static.js 传了）：第 4 个参数就是 publicDir，错位会让整条
      // /media/… 音频路由去找 <cwd>/assets/audio —— 浏览器里表现为 BGM/语音静默 404。
      await serveMedia(req, res, decoded.slice(MEDIA_PREFIX.length), publicDir, gzipCache, log, release, versioned, query);
      return;
    }
    // Bare mount paths (e.g. "/data") → treat as the mount directory.
    const mount = mounts.find((m) => decoded.startsWith(m.prefix) || decoded === m.prefix.slice(0, -1)) || mounts[mounts.length - 1];
    const rest = decoded.length > mount.prefix.length ? decoded.slice(mount.prefix.length) : '';
    const segments = rest.split('/').filter((s) => s.length > 0);
    const contentFile = mount.name === 'data' && segments.length === 1 && typeof query === 'string'
      && /^v=[a-f0-9]{8}$/.test(query)
      ? Object.values(vanillaContent().data).find((entry) => entry.file === segments[0]) : null;
    const contentTagVerified = !versioned && contentFile && typeof query === 'string'
      && query === `v=${contentFile.sha256.slice(0, 8)}`;
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
          const loc = (mount.prefix + segments.map(encodeURIComponent).join('/') + '/').replace(/\/{2,}/g, '/');
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
    // 模拟 worker 要 eval 编译 DSL，策略和页面不同（server/http/csp.js SIM_WORKER_CSP）。按真实路径判定，
    // 编码/大小写别名指到同一个文件时也算 —— 上游的 static.js 在这里 setHeader，新静态层没有这段。
    const workerHeaders = {};
    if (mount.name === 'public' && /^\/build\/assets\/resource-sw-[A-Za-z0-9_-]+\.js$/.test(decoded)) {
      // The content-hashed worker lives below /build/assets but controls resource requests at the site root.
      workerHeaders['Service-Worker-Allowed'] = '/';
    }
    if (mount.name === 'public' && path.basename(absPath).toLowerCase() === 'simworker.js') {
      const [real, worker] = await Promise.all([
        fsp.realpath(absPath).catch(() => null),
        fsp.realpath(path.join(publicDir, 'js', 'battle', 'simWorker.js')).catch(() => null),
      ]);
      if (real && worker && real === worker) workerHeaders['Content-Security-Policy'] = SIM_WORKER_CSP;
    }
    // 一次发布的 URL 下必须是那一次发布的字节：文件在进程启动后被改过，就不能再按旧 tag 发出去
    // （否则浏览器/代理会把新字节永久缓存成旧 URL）。宁可 503 让运维重启。
    if ((versioned || tagVerified || contentTagVerified) && !release.matchesFile(absPath, stat)) {
      sendError(req, res, 503, '资源文件已变更，请重启服务器 · Restart required');
      return;
    }
    const first = segments[0] || '';
    if (mount.name === 'public' && (first.toLowerCase().startsWith('studio') || /[^\x00-\x7f]/.test(first))) {
      const studio = await studioRealPath();
      const real = studio ? await fsp.realpath(absPath).catch(() => null) : null;
      if (studio && (!real || real === studio || real.startsWith(studio + path.sep))) { sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : ''); return; }
    }
    // assets CDN: the manifests are rewritten on the way out, so every client keeps requesting /data/assets.json
    if (cdn && mount.name === 'data' && segments.length === 1 && CDN_MANIFESTS.has(segments[0].toLowerCase())) {
      const cached = cdnCache.get(absPath);
      let body = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
        && cached.ctimeMs === stat.ctimeMs && cached.ino === stat.ino ? cached.body : null;
      let hash = body ? cached.hash : null;
      if (!body) {
        try {
          const identity = `${absPath}:${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}:${stat.ino}`;
          let pending = cdnPending.get(identity);
          if (!pending) {
            pending = manifestEncoder.request({ file: absPath, cdn }).then((bytes) => {
              const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
              return { body, hash: createHash('sha256').update(body).digest('hex') };
            })
              .finally(() => cdnPending.delete(identity));
            cdnPending.set(identity, pending);
          }
          ({ body, hash } = await pending);
          cdnCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs, ino: stat.ino, body,
            hash });
        } catch (e) {
          log.error(`[http] cannot rewrite ${segments[0]} for the CDN`, e);
          sendError(req, res, 500, '服务器内部错误 · Internal error');
          return;
        }
      }
      await serveHashedBuffer(req, res, { body, hash, type: MIME['.json'],
      cacheControl: versioned || tagVerified || contentTagVerified ? IMMUTABLE_CACHE : 'no-cache',
      key: `cdn-json:${absPath}`, cache: gzipCache });
      return;
    }
    const ext = path.extname(absPath).toLowerCase();
    await serveFile(req, res, absPath, stat, mount.name, segments, query, gzipCache, log, {
      ...(Object.keys(workerHeaders).length ? { headers: workerHeaders } : {}),
      transform: transformFor(ext, versioned, decoded),
      ...(versioned || tagVerified || contentTagVerified ? { cacheControl: IMMUTABLE_CACHE } : {}),
    });
  };
  // 发布版本（server/assetVersion.js）：调试与测试读它判断「这个 URL 属于哪次发布」
  /** 页面改写入口（server/http/csp.js 用它把「本服务写入的内联脚本」逐个算进 script-src 的哈希里）。 */
  serveStatic.transformPage = (text, ext) => release.transform(text, ext);
  serveStatic.version = release.tag;
  serveStatic.artVersion = release.artTag;
  serveStatic.runtimeVersion = release.runtimeTag;
  serveStatic.close = () => manifestEncoder.close();
  serveStatic.cacheStats = () => ({ gzipBytes: gzipCache.total, gzipEntries: gzipCache.map.size, gzipLimitBytes: gzipCache.maxTotal, gzipInflight: gzipCache.inflight.size });
  return serveStatic;
}

const CDN_MANIFESTS = new Set(['assets.json', 'local-assets.json', 'local-fx.json']);
