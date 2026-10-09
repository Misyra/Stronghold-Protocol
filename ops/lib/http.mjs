import http from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export function equalSecret(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Temp file in the target directory + rename, so readers never observe a half-written config.
export async function atomicWriteFile(file, text) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}

export function sendJson(req, res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Public GET responses carry an ETag over the stable fields (caller strips volatile ones via fingerprint)
// and revalidate with If-None-Match, so unchanged polls answer 304 without a body.
export function sendCacheableJson(req, res, status, data, fingerprint = data) {
  const etag = `"${createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 24)}"`;
  if (req.method === 'GET' && status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
    ETag: etag, 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function loopback(host) { return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host); }

export function safeUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))) {
    throw new Error('Use HTTPS for remote services; credentials must be supplied through environment variables');
  }
  return url;
}

export function integer(value, fallback, min, max) {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return n;
}

// Reject promptly even when an operation is still waiting in a serialized upstream queue.
export function withAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => { signal.removeEventListener('abort', abort); settle(value); };
    const abort = () => finish(reject, signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

// Fixed destinations only. Limit body bytes while reading, including chunked responses.
export async function fetchJson(url, { token, authorization, signal, timeoutMs = 5000, maxBytes = 1024 * 1024 } = {}) {
  const response = await fetch(url, { headers: token || authorization ? { Authorization: token ? `Bearer ${token}` : authorization } : {},
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error('Upstream HTTP error');
    error.httpStatus = response.status;
    error.code = [401, 403].includes(response.status) ? 'AUTH_FAILED' : 'UPSTREAM_ERROR';
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw Object.assign(new Error('Response too large'), { code: 'INVALID_RESPONSE' }); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) error.code = 'INVALID_RESPONSE';
    throw error;
  } finally { reader.releaseLock(); }
}

export function errorCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  return ['AUTH_FAILED', 'UPSTREAM_ERROR', 'INVALID_RESPONSE'].includes(error?.code) ? error.code : 'UNREACHABLE';
}

export function periodic(task, intervalMs, onError = () => {}) {
  let timer, stopped = false, pending;
  const run = () => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(task).catch(onError).finally(() => {
      pending = null;
      if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref(); }
    });
    return pending;
  };
  void run();
  return { refresh: () => { clearTimeout(timer); return run(); }, stop: async () => {
    stopped = true; clearTimeout(timer); await pending;
  } };
}

export async function listen(handler, { host = '127.0.0.1', port = 0 } = {}) {
  if (!loopback(host)) throw new Error('Management services must bind to loopback; use an HTTPS reverse proxy');
  const server = http.createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Promise.resolve().then(() => handler(req, res)).catch(() => {
      if (!res.headersSent) sendJson(req, res, 500, { error: { code: 'INTERNAL_ERROR' } });
      else res.destroy();
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port;
  return { server, port: actualPort, url: `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections();
    }) };
}

export function isEntry(metaUrl) {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

export function onShutdown(service) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    service.close().then(() => process.exit(0), () => process.exit(1));
  });
}
