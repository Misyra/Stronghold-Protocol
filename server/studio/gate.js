// server/studio/gate.js — who may use the studio (DESIGN §32.9, docs/PLUGINS.md §15): /studio/ and /studio/api/* answer a
// request from this machine or the local network only; any other gets the same 404 as a page that does not exist.
//
//   1. the client address (server/net.js clientAddress — the socket peer, or the address a local proxy forwards, honouring
//      TRUST_PROXY like the WebSocket limits and /healthz?traffic=1) is a loopback or private-network one (isLocalIp); a
//      tunnel or proxy on this machine that forwards a public visitor names that visitor, who is refused
//      (SP_STUDIO=local narrows it to loopback; SP_STUDIO=off switches the studio off) [ASSUMED: on for the local network
//      by default, as the 0.3.0 plan asks];
//   2. the Host the browser asked for is an address or a local name — an IP literal, localhost / *.localhost, a name
//      without a dot (a machine name), *.local, *.lan, *.home.arpa, *.internal, or a name SP_STUDIO_HOSTS lists — so a
//      web page whose own name was made to point at this machine (DNS rebinding) cannot reach it [ASSUMED];
//   3. a change (POST, PUT, DELETE) also carries the header `X-SP-Studio: 1` — a page of another site cannot send it
//      without the browser asking first, and the studio never answers that question — and, when the browser names it,
//      comes from the studio's own origin (Origin, Sec-Fetch-Site).

import { isIP } from 'node:net';
import { clientAddress, isLocalIp, normalizeIp } from '../net.js';

/** The studio's mode from the environment: 'lan' (default), 'local' (loopback only) or 'off'. */
export function studioMode(env = process.env) {
  const v = String(env.SP_STUDIO ?? '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(v)) return 'off';
  if (['local', 'loopback'].includes(v)) return 'local';
  return 'lan';
}

/** Extra Host names the owner allows (SP_STUDIO_HOSTS, comma separated, lower case). */
export const extraHosts = (env = process.env) => String(env.SP_STUDIO_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Is `ip` (normalized) a loopback address? */
export function isLoopback(ip) {
  if (isIP(ip) === 4) return ip.startsWith('127.');
  return ip === '::1';
}

/**
 * The host name of a Host header (no port, no brackets, lower case), or null when it is none.
 * @param {unknown} host
 */
export function hostName(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h || h.length > 255) return null;
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end > 0 ? h.slice(1, end) : null; }
  const colon = h.lastIndexOf(':');
  const name = colon > 0 && /^\d+$/.test(h.slice(colon + 1)) ? h.slice(0, colon) : h;
  return /^[a-z0-9._-]+$/.test(name) ? name : null;
}

/**
 * Is a Host header a local one (see the header, rule 2)?
 * @param {unknown} host @param {string[]} [extra] more allowed names
 */
export function isLocalHost(host, extra = []) {
  const name = hostName(host);
  if (!name) return false;
  if (isIP(name)) return true;
  if (extra.includes(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (!name.includes('.')) return true;
  return /\.(local|lan|home\.arpa|internal)$/.test(name);
}

/**
 * May this request use the studio? `{ ok: true }` or `{ ok: false, why }` (why: for the log, never for the client).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ trustProxy?: 'auto' | boolean, mode?: 'lan' | 'local' | 'off', hosts?: string[] }} [opts]
 */
export function studioAllowed(req, { trustProxy = 'auto', mode = studioMode(), hosts = extraHosts() } = {}) {
  if (mode === 'off') return { ok: false, why: 'the studio is off (SP_STUDIO=off)' };
  const { ip } = clientAddress(req, trustProxy);
  const peer = normalizeIp(ip) || ip;
  if (!isLocalIp(peer)) return { ok: false, why: `${peer} is not a local or private-network address` };
  if (mode === 'local' && !isLoopback(peer)) return { ok: false, why: `${peer} is not this machine (SP_STUDIO=local)` };
  if (!isLocalHost(req.headers?.host, hosts)) return { ok: false, why: `Host ${String(req.headers?.host ?? '').slice(0, 80)} is not a local name` };
  return { ok: true };
}

/**
 * Is a change request the studio's own (see the header, rule 3)? Its Origin, when given, has the request's Host.
 * @param {import('node:http').IncomingMessage} req
 */
export function isStudioChange(req) {
  const h = req.headers || {};
  if (h['x-sp-studio'] !== '1') return false;
  const site = h['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = h.origin;
  if (origin === undefined) return true;
  try { return new URL(String(origin)).host.toLowerCase() === String(h.host || '').toLowerCase(); } catch { return false; }
}
