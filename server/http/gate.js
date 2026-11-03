// server/http/gate.js — the access gate (门禁, the owner's decision of 2026-11-03): one shared password in front of
// everything a remote visitor could read or join, for a server published straight from a public IP or an FRP tunnel
// (no Cloudflare Access, no reverse proxy). Modelled on the Stardust fork's /entry page.
//
//   GET  /entry?next=/          the password page (its own HTML, no game assets; inline CSS only — the site CSP allows
//                               inline styles, never inline scripts)
//   POST /_gate/login           form-encoded { csrf, next, password } → a signed cookie and 303 to next, or the page
//                               again with an error; throttled per client address
//   POST /_gate/logout          clears the cookie → 303 to /entry
//   GET  /healthz               always open (a tunnel / uptime probe)
//   GET  /api/online            always open (the title screen's 当前在线人数 — a public count, no state)
//   GET  /api/announcement      always open (the maintenance notice — a public schedule)
//
// Every other request from a client that is neither local nor on the private network needs the cookie:
//   * an HTML navigation is redirected to /entry?next=<path+query>;
//   * anything else (assets, /data/*.json, the WebSocket upgrade) is refused with 401.
// Loopback and private-network clients bypass the gate (SP_GATE_LOCAL=0 turns that off). That shortcut uses the real
// socket peer only (req.socket.remoteAddress) and is off whenever a trusted proxy forwarded a client at all — the
// forwarded value (CF-Connecting-IP, X-Real-IP, X-Forwarded-For) is for per-network limits and statistics, and never
// grants a bypass. Otherwise a tunnel on this machine (peer 127.0.0.1) would skip the gate for the whole internet it
// forwards. The WebSocket upgrade is checked too (http/websocket.js): gating only HTTP would leave ws://host/ws open.
//
// The cookie is `sp_gate=<expires ms>.<HMAC-SHA256(secret, "gate:" + expires + ":" + sha256(password))>` — HttpOnly,
// SameSite=Lax, Secure when the request arrived over HTTPS (behind an FRP that terminates TLS, X-Forwarded-Proto says
// so, and only when the peer is a trusted proxy). Binding the password into the signature means changing the password
// invalidates every old cookie. The secret is SP_GATE_SECRET, else a generated `.cache/gate-secret` (0600) so sessions
// survive a restart; without either it is per-process and every restart logs everyone out.
//
// No dependency: node:crypto and node:fs only. (i18n-ignore-file: the gate page is bilingual by design, 中文 · English.)

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalIp, normalizeIp } from '../net.js';

export const GATE_COOKIE = 'sp_gate';
export const GATE_CSRF_COOKIE = 'sp_gate_csrf';
/** Paths that stay open without the cookie: the probe and the two public read-only APIs (the title screen's 当前在线人数
 * and the maintenance notice). Nothing else is exempt — the game pages, data, assets and the WebSocket are not. */
export const GATE_PUBLIC_PATHS = Object.freeze(['/healthz', '/api/online', '/api/announcement']);
/** Login failures allowed per client address inside GATE_WINDOW_MS. */
export const GATE_MAX_FAILURES = 5;
export const GATE_WINDOW_MS = 10 * 60 * 1000;
/** The login form's body limit (bytes). */
const MAX_BODY = 4096;
/** The password file is a single short line; never read more than this (bytes) and never trim it. */
const MAX_PASSWORD_FILE = 1024;
/** The hard cap of the login-throttle table (insertion-ordered LRU, oldest entry evicted first). */
const MAX_TRACKED_CLIENTS = 8192;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** TRUST_PROXY / trustProxy → net.js convention ('auto' unless explicitly on/off). */
function trustProxySetting(value) {
  if (value === true || value === false) return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

/**
 * The gate's settings from startServer() options and the environment (an option wins):
 * `gatePassword` / SP_GATE_PASSWORD / SP_GATE_PASSWORD_FILE (a UTF-8 file: first line, at most 1 KB, not trimmed;
 * unreadable = the boot fails; empty or absent = no gate), `gateSecret` / SP_GATE_SECRET, `gateTtlDays` /
 * SP_GATE_TTL_DAYS (default 7), `gateLocal` / SP_GATE_LOCAL (default on: loopback and LAN skip it). The file form keeps
 * a non-ASCII password out of a shell whose code page would mangle it (`set SP_GATE_PASSWORD=…` in cmd turns
 * 阿米娅不是驴 into mojibake).
 * @param {{ gatePassword?: string | null, gateSecret?: string | null, gateTtlDays?: number, gateLocal?: boolean,
 *           trustProxy?: 'auto' | boolean }} [opts]
 * @param {Record<string, string | undefined>} [env]
 * @param {{ warn?: Function } | null} [log]
 */
export function gateOptionsFrom(opts = {}, env = process.env, log = null) {
  const pick = (option, name) => (opts[option] !== undefined ? opts[option] : env[name]);
  let password = String(pick('gatePassword', 'SP_GATE_PASSWORD') ?? '').trim();
  if (!password && env.SP_GATE_PASSWORD_FILE) {
    const file = resolve(ROOT, env.SP_GATE_PASSWORD_FILE);
    let raw;
    try {
      raw = readFileSync(file);
    } catch (error) {
      // A configured password file that cannot be read must fail the boot: leaving the password empty would silently
      // turn the gate off for the whole server.
      throw new Error(`[gate] cannot read SP_GATE_PASSWORD_FILE ${file}: ${error.message}`, { cause: error });
    }
    // First line only, at most 1 KB, no trim: a password may legitimately contain (or end in) spaces.
    password = raw.subarray(0, MAX_PASSWORD_FILE).toString('utf8').split(/\r?\n/, 1)[0];
  }
  const secret = String(pick('gateSecret', 'SP_GATE_SECRET') ?? '').trim() || null;
  const daysRaw = pick('gateTtlDays', 'SP_GATE_TTL_DAYS');
  const days = daysRaw === undefined || daysRaw === '' ? 7 : Number(daysRaw);
  const ttlDays = Number.isFinite(days) ? Math.min(365, Math.max(1, Math.floor(days))) : 7;
  if (daysRaw !== undefined && daysRaw !== '' && !Number.isFinite(days)) log?.warn?.(`[gate] invalid SP_GATE_TTL_DAYS ${daysRaw}, using 7`);
  const localRaw = pick('gateLocal', 'SP_GATE_LOCAL');
  const localBypass = localRaw === undefined ? true : !/^(0|false|off|no)$/i.test(String(localRaw));
  const trustProxy = trustProxySetting(pick('trustProxy', 'TRUST_PROXY'));
  return { password, secret, ttlDays, localBypass, trustProxy };
}

/** The HMAC secret: the configured one, `.cache/gate-secret`, or a per-process random value. */
function loadSecret(configured, log) {
  if (configured) return configured;
  const file = resolve(ROOT, '.cache', 'gate-secret');
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim();
      if (saved) return saved;
    }
    const fresh = randomBytes(32).toString('hex');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
    return fresh;
  } catch (error) {
    log?.warn?.(`[gate] no secret file (${error.message}); sessions end with this process — set SP_GATE_SECRET`);
    return randomBytes(32).toString('hex');
  }
}

/** Cookie header of every `a=b; c=d` pair in `header`. */
export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    if (!key) continue;
    out.set(key, part.slice(at + 1).trim());
  }
  return out;
}

/** The password binding inside the cookie signature: changing the password invalidates every old cookie. */
const passwordBinding = (password) => createHash('sha256').update(String(password ?? ''), 'utf8').digest('base64url');

/** HMAC of one cookie expiry, bound to the current password. */
function gateSignature(secret, exp, password) {
  return createHmac('sha256', secret).update(`gate:${exp}:${passwordBinding(password)}`).digest('base64url');
}

/**
 * Does the request carry a valid, unexpired gate cookie? `password` defaults to '' so a standalone call (tests,
 * tooling) still works; the gate itself always passes its configured password.
 */
export function validGateCookie(req, secret, now = Date.now(), password = '') {
  const raw = parseCookies(req?.headers?.cookie).get(GATE_COOKIE);
  if (!raw) return false;
  const at = raw.indexOf('.');
  if (at <= 0) return false;
  const exp = Number(raw.slice(0, at));
  if (!Number.isSafeInteger(exp) || exp <= now) return false;
  const want = Buffer.from(gateSignature(secret, exp, password), 'utf8');
  const got = Buffer.from(raw.slice(at + 1), 'utf8');
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/**
 * The `Set-Cookie` value of a successful login (`secure`: the request was HTTPS). The signature covers the password
 * digest, so a cookie minted under one password stops validating as soon as the password changes.
 */
export function gateCookie(secret, ttlMs, secure = false, password = '') {
  const exp = Date.now() + ttlMs;
  const sig = gateSignature(secret, exp, password);
  return `${GATE_COOKIE}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`;
}

function csrfCookie(token, secure = false) {
  return `${GATE_CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure ? '; Secure' : ''}`;
}

/** A same-origin path only: one leading slash, no `//`, no backslash, no control characters. */
export function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/';
  return value.length > 1500 ? '/' : value;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The password page (`message` is shown under the field; `next` is already sanitised). */
export function entryPage({ next = '/', message = '' } = {}, csrf = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex,nofollow">
<title>卫戍协议：盟约 · 访问终端</title>
<link rel="icon" href="data:,">
<style>
  :root { --bg: #0b0f0e; --panel: #121a17; --line: #2b3a34; --mint: #6fe3a8; --gold: #d9a441; --text: #d8e3de; --dim: #7d8f88; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background:
    radial-gradient(1200px 600px at 50% -10%, #163026 0%, transparent 60%), var(--bg); color: var(--text);
    font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; padding: 24px; }
  .frame { width: min(440px, 100%); border: 1px solid var(--line); background: linear-gradient(180deg, #131d19, #0e1512); }
  .bar { display: flex; justify-content: space-between; gap: 12px; padding: 8px 14px; font-size: 11px; letter-spacing: .08em;
    color: var(--dim); border-bottom: 1px solid var(--line); text-transform: uppercase; }
  .bar b { color: var(--mint); font-weight: 600; }
  main { padding: 26px 22px 22px; }
  h1 { margin: 0 0 4px; font-size: 19px; letter-spacing: .04em; }
  h1 em { color: var(--mint); font-style: normal; }
  .sub { margin: 0 0 22px; color: var(--dim); font-size: 12px; }
  label { display: block; font-size: 11px; letter-spacing: .1em; color: var(--gold); text-transform: uppercase; margin-bottom: 6px; }
  input#password { width: 100%; padding: 11px 12px; border: 1px solid var(--line); background: #0a100d; color: var(--text);
    font: inherit; letter-spacing: .12em; }
  input#password:focus { outline: 2px solid var(--mint); outline-offset: 1px; border-color: transparent; }
  button { margin-top: 14px; width: 100%; padding: 12px; border: 1px solid var(--mint); background: var(--mint); color: #06110b;
    font: inherit; font-weight: 700; letter-spacing: .08em; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  .msg { min-height: 20px; margin: 12px 0 0; font-size: 12px; color: #ffb4a9; }
  .foot { padding: 10px 14px; border-top: 1px solid var(--line); color: var(--dim); font-size: 10px; letter-spacing: .08em;
    display: flex; justify-content: space-between; gap: 8px; text-transform: uppercase; }
</style>
</head>
<body>
<div class="frame">
  <div class="bar"><span>PRTS // PRIVATE TERMINAL</span><b>ACCESS CONTROL</b></div>
  <main>
    <h1>卫戍协议：盟约 <em>·</em> 访问终端</h1>
    <p class="sub">本服务器仅向持有访问口令的博士开放。输入口令后进入模拟终端。<br>This server is private. Enter the access password to continue.</p>
    <form method="post" action="/_gate/login">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <label for="password">访问口令 · PASSWORD</label>
      <input id="password" name="password" type="text" required maxlength="256" autocomplete="off"
             autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text" autofocus>
      <button type="submit">连接终端 · ENTER</button>
      <p class="msg" role="status" aria-live="polite">${escapeHtml(message)}</p>
    </form>
  </main>
  <div class="foot"><span>STRONGHOLD PROTOCOL</span><span>ACL · ${new Date().getUTCFullYear()}</span></div>
</div>
</body>
</html>`;
}

/** Read a small form body (url-encoded). Never throws; longer bodies are truncated and refused by the caller. */
async function readBody(req, limit = MAX_BODY) {
  return new Promise((resolveBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolveBody(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolveBody(null));
  });
}

const isHtmlRequest = (req) => /\btext\/html\b/i.test(String(req.headers.accept || ''));

/**
 * The gate. `handle` serves the entry page and the login / logout endpoints; `check` answers whether a request may
 * pass; `deny` answers one that may not.
 * @param {{ password: string, secret: string, ttlDays?: number, localBypass?: boolean,
 *           trustProxy?: 'auto' | boolean, now?: () => number, log?: { warn?: Function } }} options
 */
export function createGate({ password, secret, ttlDays = 7, localBypass = true, trustProxy = 'auto', now = Date.now, log = null }) {
  const passwordDigest = createHash('sha256').update(password, 'utf8').digest();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  /** @type {Map<string, { fails: number, until: number }>} insertion-ordered: the oldest is evicted first */
  const attempts = new Map();

  /** The real socket peer, canonicalised. Never a forwarding header: those are only for limits and statistics. */
  const peerOf = (req) => normalizeIp(req?.socket?.remoteAddress);

  /** Is this request's peer a proxy we may believe? (net.js convention: any peer when `trustProxy` is true, only a
   * loopback / private one for 'auto', never when false.) */
  const proxyTrusted = (req) => trustProxy === true || (trustProxy !== false && isLocalIp(peerOf(req)));

  const secureOf = (req) => req?.socket?.encrypted === true
    || (proxyTrusted(req) && /^https$/i.test(String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()));

  const writeHtml = (req, res, status, html, cookies = []) => {
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
    // HEAD carries the headers (including Content-Length) but no body.
    res.end(req?.method === 'HEAD' ? undefined : html);
  };

  const redirect = (res, status, location) => {
    res.writeHead(status, { Location: location, 'Content-Length': 0, 'Cache-Control': 'no-store' });
    res.end();
  };

  /** Did a trusted proxy forward a client address? Only the fact is used — never the value. A request that carries
   * one did not arrive directly, so the loopback/LAN shortcut does not apply: otherwise a tunnel on this machine
   * (peer 127.0.0.1) would skip the gate for every internet client it forwards. */
  const forwardedClient = (req) => {
    if (!proxyTrusted(req)) return false;
    const h = req?.headers;
    return !!(h && (h['cf-connecting-ip'] || h['x-real-ip'] || h['x-forwarded-for']));
  };

  /** Loopback / private-network clients skip the gate (unless disabled). The bypass is decided by the real socket
   * peer; a forwarded address (CF-Connecting-IP, X-Real-IP, X-Forwarded-For) never grants one. */
  const bypass = (req) => localBypass && !forwardedClient(req) && isLocalIp(peerOf(req));

  /** A path that never needs the cookie (GATE_PUBLIC_PATHS: the probe and the public read-only APIs). */
  const isPublic = (rawPath) => GATE_PUBLIC_PATHS.includes(rawPath);

  /** May this request pass? (no cookie needed when the gate bypasses its client) */
  const check = (req) => bypass(req) || validGateCookie(req, secret, now(), password);

  /** The throttled state of one client key (`clientAddress(...).key`, an IPv6 /64 already collapsed); expired windows
   * reset. A Map keeps insertion order, so touching an entry moves it to the end and an overflow evicts the oldest. */
  const attemptOf = (key) => {
    const at = now();
    const entry = attempts.get(key);
    if (entry && entry.until > at) {
      attempts.delete(key);
      attempts.set(key, entry);
      return entry;
    }
    const fresh = { fails: 0, until: at + GATE_WINDOW_MS };
    attempts.delete(key);
    attempts.set(key, fresh);
    while (attempts.size > MAX_TRACKED_CLIENTS) attempts.delete(attempts.keys().next().value);
    return fresh;
  };

  /** Render the entry page with a fresh CSRF token. Every error page goes through here too: the browser keeps the old
   * CSRF cookie, so a page carrying a new token (and its Set-Cookie) is what lets the user retry. */
  const writeEntry = (req, res, status, next, message = '') => {
    const csrf = randomBytes(18).toString('base64url');
    writeHtml(req, res, status, entryPage({ next, message }, csrf), [csrfCookie(csrf, secureOf(req))]);
  };

  const showEntry = (req, res, next, message = '') => writeEntry(req, res, message ? 401 : 200, next, message);

  /**
   * Serve /entry, /_gate/login and /_gate/logout. Returns false for every other path (the caller keeps routing).
   * @returns {Promise<boolean>}
   */
  async function handle(req, res, { method, rawPath, query, ip, key }) {
    if (rawPath === '/entry' && (method === 'GET' || method === 'HEAD')) {
      const next = safeNext(new URLSearchParams(query || '').get('next') || '/');
      showEntry(req, res, next);
      return true;
    }
    if (rawPath === '/entry' && method === 'POST') {
      redirect(res, 303, '/entry');
      return true;
    }
    if (rawPath === '/_gate/login' && method === 'POST') {
      const body = await readBody(req);
      if (body == null) { writeEntry(req, res, 413, '/', '请求过大 · Request too large'); return true; }
      const form = new URLSearchParams(body);
      const next = safeNext(form.get('next'));
      const csrf = parseCookies(req.headers.cookie).get(GATE_CSRF_COOKIE) || '';
      const givenCsrf = form.get('csrf') || '';
      const csrfOk = csrf.length > 0 && csrf.length === givenCsrf.length
        && timingSafeEqual(Buffer.from(csrf, 'utf8'), Buffer.from(givenCsrf, 'utf8'));
      if (!csrfOk) { writeEntry(req, res, 400, next, '页面已过期，请重新输入 · Page expired, try again'); return true; }
      const state = attemptOf(key || ip || '?');
      if (state.fails >= GATE_MAX_FAILURES) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((state.until - now()) / 1000))));
        writeEntry(req, res, 429, next, '尝试次数过多，请稍后再试 · Too many attempts, wait and retry');
        return true;
      }
      const digest = createHash('sha256').update(form.get('password') || '', 'utf8').digest();
      if (timingSafeEqual(digest, passwordDigest)) {
        state.fails = 0;
        const cookies = [gateCookie(secret, ttlMs, secureOf(req), password), `${GATE_CSRF_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
        res.setHeader('Set-Cookie', cookies);
        redirect(res, 303, next);
        return true;
      }
      state.fails++;
      log?.warn?.(`[gate] wrong password from ${ip}`);
      writeEntry(req, res, 401, next, '口令不正确 · Wrong password');
      return true;
    }
    if (rawPath === '/_gate/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', [`${GATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        `${GATE_CSRF_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
      redirect(res, 303, '/entry');
      return true;
    }
    return false;
  }

  /** Answer a request that needs the cookie: HTML navigations go to /entry, everything else gets 401. */
  function deny(req, res, { rawPath, query, method }) {
    if ((method === 'GET' || method === 'HEAD') && isHtmlRequest(req)) {
      const target = rawPath + (query ? `?${query}` : '');
      redirect(res, 302, `/entry?next=${encodeURIComponent(target)}`);
      return;
    }
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Gate' });
    res.end('需要访问口令 · Access password required\n');
  }

  return { enabled: true, ttlMs, localBypass, bypass, check, isPublic, handle, deny, entryPage };
}

/**
 * Create the gate of startServer() options / environment. null when no password is configured.
 * @param {{ gatePassword?: string | null, gateSecret?: string | null, gateTtlDays?: number, gateLocal?: boolean,
 *           trustProxy?: 'auto' | boolean }} [opts]
 * @param {Record<string, string | undefined>} [env]
 * @param {{ warn?: Function, info?: Function } | null} [log]
 */
export function gateFrom(opts = {}, env = process.env, log = null) {
  const settings = gateOptionsFrom(opts, env, log);
  if (!settings.password) return null;
  const gate = createGate({ ...settings, secret: loadSecret(settings.secret, log) });
  log?.info?.(`[gate] access password on (${settings.localBypass ? 'loopback/LAN bypass' : 'every client'}), ${settings.ttlDays} days`);
  return gate;
}
