// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later), commit a94c720.
// Extracted render descriptions use asset names/relative paths resolved by the renderer, not host URLs.
// Preserve their bytes across local/CDN hosts so ZIP imports can verify their content hashes.
export function isRawResourceJson(url) {
  let pathname;
  try { pathname = new URL(String(url), 'https://resources.invalid').pathname; } catch { return false; }
  if (pathname.startsWith('/build/')) return false;
  return /\/assets\/local\/(?:fx|map|mesh|scene)\/[^?#]+\.json$/.test(pathname);
}

/** Match renderer paths without encoding CDN hosts or existing escapes again. */
export function canonicalResourceUrl(url) {
  const value = String(url);
  if (!value.startsWith('/') && !/^https?:\/\//i.test(value)) return value.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  try {
    const parsed = new URL(value, 'https://resources.invalid');
    parsed.pathname = parsed.pathname.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    return value.startsWith('/') && !value.startsWith('//') ? parsed.pathname + parsed.search + parsed.hash : parsed.href;
  } catch { return value; }
}

/** Origin/query-independent identity for manifest resources; null for invalid paths. */
export function resourceIdentity(value) {
  try {
    const pathname = new URL(String(value), 'https://resources.invalid').pathname;
    if (/%2f|%5c/i.test(pathname)) return null;
    const decoded = decodeURIComponent(pathname).replace(/^\/_v\/[a-f0-9]{16}(?=\/)/, '');
    if (/[\\\u0000-\u001f?#]/.test(decoded) || decoded.split('/').some((s) => s === '.' || s === '..')) return null;
    const match = /\/(?:assets|fonts|media)\//.exec(decoded);
    return match ? decoded.slice(match.index) : decoded;
  } catch { return null; }
}

// 取自 xinhai 的 shared/resourcePaths.js：他们的清单生成（server/resources.js）按这个名字判断「棋盘/特效描述 JSON」。
// 本仓库另有更宽的 isRawResourceJson（assets/local 下任意 JSON），两者并存，互不替代。
export function isBoardResourceJson(url) {
  let pathname;
  try { pathname = new URL(String(url), 'https://resources.invalid').pathname; } catch { return false; }
  if (pathname.startsWith('/build/')) return false;
  return /\/assets\/local\/map\/(?:fx\/(?:materials|prefab)|autochess\/(?:materials|tiles))\.json$/.test(pathname)
    || /\/assets\/local\/fx\/(?:(?:index|textures)|prefabs\/[A-Za-z0-9_.-]+|mesh\/[A-Za-z0-9_.-]+)\.json$/.test(pathname)
    || /\/assets\/local\/scene\/(?:act1autochess_m0[1-7]|act2autochess_m0[1-4])\/scene\.json$/.test(pathname);
}
