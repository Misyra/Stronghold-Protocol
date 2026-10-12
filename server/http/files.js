// server/http/files.js — one file on disk (serveFile) or one body in memory (serveBuffer, the served manifests of
// assetViews.js) → an HTTP response (static.js and media.js decide which file):
//     MIME types incl. .mjs/.js text/javascript, .skel application/octet-stream, .atlas text/plain;
//     gzip for text-like types, .skel and uncompressed fonts when the client accepts it (small files are
//     compressed once and cached in memory); strong ETag + Last-Modified with 304s — the ETag is the content hash
//     when the caller has one (assetIndex.js), else size + mtime; Cache-Control (html & code/data: no-cache +
//     revalidate; public/assets|fonts|vendor: 1 day; a URL whose content-hash segment matches the file (static.js,
//     media.js): immutable for a year; any `?v=` URL: immutable); single byte-range requests (206/416, used by <audio>).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

/** Extension → Content-Type. */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
});

/** Extensions worth gzipping (text-like, .skel, uncompressed fonts). */
export const COMPRESSIBLE = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.md', '.csv', '.xml',
  '.atlas', '.skel', '.bin', '.wasm', '.svg', '.ico', '.otf', '.ttf', '.wav',
]);

const GZIP_MIN_BYTES = 512;
const GZIP_CACHE_MAX_FILE = 8 << 20;      // larger files are gzip-streamed on the fly
const GZIP_CACHE_MAX_TOTAL = 96 << 20;
// Asset URLs carry no content hash yet, and tools/fetch-assets.mjs / tools/vendor.mjs can rewrite files in
// place (atlas + png + skel must stay consistent), so "long" is one day; revalidation after that is a cheap 304.
export const LONG_CACHE = 'public, max-age=86400';          // 1 day
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const LONG_CACHE_DIRS = ['assets', 'fonts', 'vendor']; // first path segment under public/

const gzipAsync = promisify(zlib.gzip);

// ---------------------------------------------------------------------------------------------------
// gzip cache (LRU by bytes)
// ---------------------------------------------------------------------------------------------------

export class GzipCache {
  constructor(maxTotal = GZIP_CACHE_MAX_TOTAL) {
    this.maxTotal = maxTotal;
    this.total = 0;
    /** @type {Map<string, Buffer>} */ this.map = new Map();
    /** @type {Map<string, Promise<Buffer>>} */ this.inflight = new Map();
  }

  /** @returns {Promise<Buffer>} gzip of the file identified by (path, size, mtime) */
  get(absPath, stat) {
    return this.compressed(`${absPath}\0${stat.size}\0${stat.mtimeMs}`, () => fsp.readFile(absPath));
  }

  /** @returns {Promise<Buffer>} gzip of the body `read()` returns, cached under `key` (one compression per key at a time) */
  compressed(key, read) {
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); return Promise.resolve(hit); }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const raw = await read();
      const gz = await gzipAsync(raw, { level: 6 });
      this.store(key, gz);
      return gz;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  store(key, buf) {
    if (buf.length > this.maxTotal) return;
    this.map.set(key, buf);
    this.total += buf.length;
    for (const [k, v] of this.map) {
      if (this.total <= this.maxTotal) break;
      this.map.delete(k);
      this.total -= v.length;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------

/** Does the Accept-Encoding header allow gzip (q > 0)? @param {string | undefined} header */
export function acceptsGzip(header) {
  if (!header || typeof header !== 'string') return false;
  let gzipQ = null;
  let starQ = null;
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    if (token === 'gzip' || token === 'x-gzip') gzipQ = q;
    else if (token === '*') starQ = q;
  }
  if (gzipQ != null) return gzipQ > 0;
  return starQ != null && starQ > 0;
}

/**
 * Parse a single `bytes=` range against a file size.
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null} null = ignore header (serve 200)
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // multi-range or malformed → ignore (RFC 9110 permits serving the full body)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (b !== '' && Number(b) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

const stripWeak = (tag) => tag.trim().replace(/^W\//, '');

/** Conditional GET check (If-None-Match wins over If-Modified-Since). */
export function isNotModified(req, etag, mtime) {
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string') {
    if (inm.trim() === '*') return true;
    return inm.split(',').some((t) => stripWeak(t) === etag);
  }
  const ims = req.headers['if-modified-since'];
  if (typeof ims === 'string') {
    const t = Date.parse(ims);
    if (Number.isFinite(t)) return Math.floor(mtime.getTime() / 1000) * 1000 <= t;
  }
  return false;
}

/** If-Range: serve the range only when the validator still matches. */
function ifRangeMatches(req, etag, lastModified) {
  const v = req.headers['if-range'];
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (s.startsWith('"') || s.startsWith('W/')) return s === etag; // strong comparison
  return s === lastModified;
}

function cacheControlFor(ext, mountName, segments, query) {
  if (ext === '.html' || ext === '.htm') return 'no-cache';
  if (/(^|&)v=/.test(query)) return IMMUTABLE_CACHE;
  if (mountName === 'public' && segments.length > 1 && LONG_CACHE_DIRS.includes(segments[0])) return LONG_CACHE;
  return 'no-cache';
}

/**
 * One file → the response.
 * @param {{ contentHash?: string | null, cacheControl?: string | null }} [opts] contentHash: the file's content hash
 *   (assetIndex.js) — the ETag then; cacheControl: overrides the policy of its path (a content-hashed URL)
 */
export async function serveFile(req, res, absPath, stat, mountName, segments, query, gzipCache, log, opts = {}) {
  const ext = path.extname(absPath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const compressible = COMPRESSIBLE.has(ext);
  const rangeHeader = req.headers.range;
  const useGzip = compressible && stat.size >= GZIP_MIN_BYTES && !rangeHeader && acceptsGzip(req.headers['accept-encoding']);
  const baseTag = opts.contentHash || `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
  const etag = `"${baseTag}${useGzip ? '-gz' : ''}"`;
  const lastModified = stat.mtime.toUTCString();
  const isHead = req.method === 'HEAD';

  const headers = {
    'Content-Type': type,
    'Cache-Control': opts.cacheControl || cacheControlFor(ext, mountName, segments, query),
    ETag: etag,
    'Last-Modified': lastModified,
  };
  if (compressible) headers.Vary = 'Accept-Encoding';

  if (isNotModified(req, etag, stat.mtime)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (useGzip) {
    headers['Content-Encoding'] = 'gzip';
    if (stat.size <= GZIP_CACHE_MAX_FILE) {
      const gz = await gzipCache.get(absPath, stat);
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      res.end(isHead ? undefined : gz);
      return;
    }
    res.writeHead(200, headers);
    if (isHead) { res.end(); return; }
    await streamTo(fs.createReadStream(absPath), res, log, zlib.createGzip());
    return;
  }

  headers['Accept-Ranges'] = 'bytes';
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (rangeHeader && ifRangeMatches(req, etag, lastModified)) {
    const r = parseRange(rangeHeader, stat.size);
    if (r === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 0 });
      res.end();
      return;
    }
    if (r) {
      ({ start, end } = r);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (isHead || stat.size === 0) { res.end(); return; }
  await streamTo(fs.createReadStream(absPath, { start, end }), res, log);
}

/**
 * One body in memory → the response (the served manifests): its ETag from `hash`, gzip when accepted (cached under
 * `key`), 304 on a matching If-None-Match, no ranges.
 * @param {{ body: Buffer, hash: string, type: string, cacheControl: string, key: string, cache: GzipCache }} o
 */
export async function serveBuffer(req, res, { body, hash, type, cacheControl, key, cache }) {
  const useGzip = body.length >= GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding']);
  const etag = `"${hash}${useGzip ? '-gz' : ''}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: etag, Vary: 'Accept-Encoding' };
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && (inm.trim() === '*' || inm.split(',').some((t) => stripWeak(t) === etag))) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let out = body;
  if (useGzip) {
    out = await cache.compressed(`${key}\0${hash}`, async () => body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = out.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : out);
}

async function streamTo(src, res, log, transform) {
  try {
    if (transform) await pipeline(src, transform, res);
    else await pipeline(src, res);
  } catch (e) {
    if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.debug?.('[http] stream aborted', e.code || e.message);
    res.destroy();
  }
}
