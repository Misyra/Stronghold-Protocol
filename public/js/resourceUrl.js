import { assetCdnUrl } from '../../shared/assetCdn.js';

/** The per-file art manifest (`/assets-manifest.json?v=<tag>`, fetched from <head> so it races the
 *  module graph): once its hashes land, every CDN URL gains a per-file `?v=<hash>` query and a
 *  release only re-busts the files it actually changed. Until then — or when the fetch fails —
 *  assetCdnUrl's bare/prefix fallback answers, which the bucket always serves. */
const manifestWaits = new WeakMap();
/** Wait for hashes before generating dynamic URLs, with a bounded availability fallback. */
export function resourceReady(timeoutMs = 3000) {
  const cdn = globalThis.__spAssetCdn;
  if (!cdn?.manifest || cdn.hashes) return Promise.resolve();
  if (manifestWaits.has(cdn)) return manifestWaits.get(cdn);
  const ready = Promise.resolve(globalThis.__spManifestReady).then((doc) => {
    if (doc && typeof doc === 'object' && doc.hashes && typeof doc.hashes === 'object') cdn.hashes = doc.hashes;
  }).catch(() => {});
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  const wait = Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
  manifestWaits.set(cdn, wait);
  return wait;
}
void resourceReady();

/**
 * 游戏数据 JSON 的根路径：配了数据 CDN（SP_DATA_CDN）就走它，否则留在本站 /data/。
 * 取自 xinhai 的 asset-cdn.js / simLoader.js 默认值 —— 本仓库此前只导出了 DATA_CDN，没人消费它。
 * @returns {string}
 */
export function dataBasePath() {
  const base = globalThis.__spAssetCdn?.dataBase;
  return base ? String(base).replace(/\/+$/, '') + '/data/' : '/data/';
}

/** Code roots carry per-root group tags (server/assetVersion.js)：同源版本化 URL 按所在根取组 tag，
 *  未变的组跨发版复用同一 URL。旧全局没有 __spCodeVersion 时退回整树 runtime tag（URL 照样可取，
 *  只是退化为旧的整树失效语义）。 */
const codeGroupOf = (url) => /^\/(js|vendor|shared|sim)\//.exec(url)?.[1] ?? null;

// /i18n/ 语句包与 data 一样落整版 release tag（服务端 expectedTag 同分支，语言包喂 runtimeHash）。
export function resourceUrl(url, version = /^\/(?:assets|fonts|media)\//.test(url) ? globalThis.__spArtVersion :
  codeGroupOf(url) ? (globalThis.__spCodeVersion?.[codeGroupOf(url)] || globalThis.__spRuntimeVersion || globalThis.__spAssetVersion)
  : globalThis.__spAssetVersion) {
  const remote = assetCdnUrl(url, globalThis.__spAssetCdn);
  if (remote !== url) return remote;
  if (!version || typeof url !== 'string' || !/^\/(?:assets|data|vendor|fonts|js|shared|sim|media|i18n)\//.test(url)) return url;
  return `/_v/${version}${url}`;
}

/** A plain static host has no injected version: keep its previous revalidation behavior. */
export function resourceCache(url) {
  if (typeof url !== 'string') return 'no-cache';
  if (url.startsWith('/_v/')) return 'default';
  try {
    const parsed = new URL(url);
    if (/^\/_v\/[a-f0-9]{16}\//.test(parsed.pathname)) return 'default';
    const base = globalThis.__spAssetCdn?.base;
    if (base && url.startsWith(base + '/') && /^\/(?:assets|fonts|media)\//.test(url.slice(base.length))) return 'default';
  } catch { /* relative static-host paths keep the old revalidation behavior */ }
  return 'no-cache';
}
