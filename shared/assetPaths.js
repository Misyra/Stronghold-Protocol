// shared/assetPaths.js — the request-path knowledge the traffic counters share (server/http/traffic.js,
// `/healthz?traffic=1`; public/js/diag.js for the browser's own totals).
//
// This fork serves release-versioned URLs — /_v/<tag>/assets/… (server/assetVersion.js) — keeps per-file cache
// busting on the CDN (<base>/assets/…?v=<file hash>, shared/assetCdn.js, .assets-manifest.json) and serves a
// cosmetic plugin is written as a plain sentence: its /p/<id>/<hash8>/… files (DESIGN §32) sit beside the release
// prefix. Upstream content-hash *segment* (/assets/~<hash>/…, a server-side index) is deliberately not served here:
// the reason and the seam list are in docs/development/MERGE_0.2.6.md.

/** The release prefix of a versioned URL: `/_v/` + 16 hex digits (server/assetVersion.js VERSION_PREFIX). */
const VERSION_PREFIX_RE = /^\/_v\/[a-f0-9]{16}/;

/** Traffic categories, in report order. */
export const TRAFFIC_CATEGORIES = Object.freeze(['assets', 'audio', 'code', 'data', 'other']);

/**
 * The traffic category of a request path: `audio` (/media/, /assets/audio/, a cosmetic plugin `.mp3` / `.ogg` at
 * /p/ — also without the extension), `assets` (/assets/, /fonts/, /icons/, the art of a content pack, a cosmetic
 * plugin other files at /p/), `data` (/data/*.json, the UI language packs /i18n/, the pack index, a visual set
 * /vs/…json, other JSON), `code` (the page, scripts, styles: /, *.js, *.css, *.html, /vendor/, /sim/, /shared/),
 * `other` (/healthz, error pages, anything else). The /_v/<tag>/ release prefix is stripped first, so a versioned
 * request counts under the same category as the plain one.
 * @param {string} path a URL path (no query)
 * @returns {'assets'|'audio'|'code'|'data'|'other'}
 */
export function trafficCategory(path) {
  const p = String(path ?? '').replace(VERSION_PREFIX_RE, '');
  if (p.startsWith('/media/') || p.startsWith('/assets/audio/')) return 'audio';
  // a plugin's audio, with its extension or without (public/js/media.js: only audio is asked for without one)
  if (p.startsWith('/p/')) return /\.(?:mp3|ogg)$/i.test(p) || !/\.[A-Za-z0-9]+$/.test(p) ? 'audio' : 'assets';
  if (p.startsWith('/assets/') || p.startsWith('/fonts/') || p.startsWith('/icons/')) return 'assets';
  if (p.startsWith('/packs/')) return /\.json$/i.test(p) ? 'data' : 'assets';
  if (p.startsWith('/data/') || p.startsWith('/i18n/') || /\.json$/i.test(p)) return 'data';
  if (p === '/' || p.endsWith('/') || /\.(?:m?js|css|html?|map|webmanifest)$/i.test(p)
    || p.startsWith('/vendor/') || p.startsWith('/sim/') || p.startsWith('/shared/')) return 'code';
  return 'other';
}
