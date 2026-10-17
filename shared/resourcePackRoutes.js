// ZIP transport locations never change the identities of resources inside a pack.
export function isResourcePackUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048
    || /[\s\\?#\u0000-\u001f]/.test(value)
    || !(value.startsWith('/') && !value.startsWith('//') || /^https?:\/\//i.test(value))) return false;
  try {
    const url = new URL(value, 'https://resources.invalid');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && /\/[A-Za-z0-9._-]+\.zip$/.test(url.pathname);
  } catch { return false; }
}

/** Deployment setting: ordered directory URLs, ZIP URLs or templates. Bare hosts use HTTPS. */
export function parseResourcePackRoutes(value) {
  if (value == null || value === '') return [];
  let routes = value;
  if (typeof routes === 'string') {
    if (!routes.trim()) return [];
    try { routes = JSON.parse(routes); }
    catch { throw new Error('SP_RESOURCE_PACK_ROUTES must be a JSON array of URLs'); }
  }
  if (!Array.isArray(routes) || routes.some((route) => typeof route !== 'string' || !route.trim())) {
    throw new Error('SP_RESOURCE_PACK_ROUTES must be a JSON array of URLs');
  }
  return routes.map((route) => {
    let template = route.trim();
    if (!template.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(template)) template = `https://${template}`;
    if (!template.includes('{') && !/\.zip$/i.test(template)) template = template.replace(/\/+$/, '') + '/{file}';
    const sample = template.replaceAll('{file}', 'ui-01-0123456789ab.zip').replaceAll('{id}', 'ui-01');
    if (/[{}]/.test(sample) || !isResourcePackUrl(sample)) throw new Error('SP_RESOURCE_PACK_ROUTES contains an invalid ZIP URL/template');
    return template;
  });
}

/** Keep the current CDN/origin URL last, even if explicitly listed among the mirrors. */
export function resourcePackUrls(pack, routes = []) {
  const file = pack.url.slice(pack.url.lastIndexOf('/') + 1);
  const urls = routes.map((route) => route.replaceAll('{file}', file).replaceAll('{id}', encodeURIComponent(pack.id)));
  const key = (url) => new URL(url, 'https://resources.invalid').href;
  const fallbackKey = key(pack.url);
  const seen = new Set([fallbackKey]);
  return [...urls.filter((url) => {
    if (!isResourcePackUrl(url)) return false;
    const canonical = key(url);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  }), pack.url];
}

/** Both served index shapes use the same runtime routing and asset identities. */
export function routeResourcePacks(packs, cdnBase = '', routes = []) {
  const base = String(cdnBase || '').replace(/\/+$/, '');
  return (Array.isArray(packs) ? packs : []).map((pack) => {
    const result = {
      ...pack,
      url: base && typeof pack.url === 'string' && pack.url.startsWith('/') && !pack.url.startsWith('//')
        ? `${base}${pack.url}` : pack.url,
      files: Array.isArray(pack.files) ? pack.files.map((file) => ({
        ...file,
        url: base && typeof file.url === 'string' && file.url.startsWith('/assets/') ? `${base}${file.url}` : file.url,
      })) : pack.files,
    };
    // Ignore deployment-index `urls`: the server setting is the authority for mirrors.
    delete result.urls;
    if (routes.length && isResourcePackUrl(result.url)) result.urls = resourcePackUrls(result, routes);
    return result;
  });
}
