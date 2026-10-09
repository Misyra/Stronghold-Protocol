// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later), commit a94c720.
// Board descriptions can retain their original bytes across local and CDN hosts.
export function isBoardResourceJson(url) {
  let pathname;
  try { pathname = new URL(String(url), 'https://resources.invalid').pathname; } catch { return false; }
  if (pathname.startsWith('/build/')) return false;
  return /\/assets\/local\/map\/(?:fx\/(?:materials|prefab)|autochess\/(?:materials|tiles))\.json$/.test(pathname);
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
