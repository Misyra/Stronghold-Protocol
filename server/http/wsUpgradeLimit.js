// Count upgrade attempts before path/origin/admission checks. Successful short-lived sockets count too.
import { clientAddress } from '../net.js';
import { createIpBanStore } from './ipBans.js';

// The application sees admitted/rejected upgrade attempts, unlike the ingress jail's 444-only counter.
// Allow shared-NAT reconnect bursts; deployments may still explicitly choose a stricter threshold.
export const WS_UPGRADE_DEFAULTS = Object.freeze({ threshold: 100, windowMs: 60000, banMs: 3600000 });

export function wsUpgradeLimitsFrom(options = {}, env = process.env) {
  const names = { threshold: 'SP_WS_UPGRADE_THRESHOLD', windowMs: 'SP_WS_UPGRADE_WINDOW_MS', banMs: 'SP_WS_UPGRADE_BAN_MS' };
  const limits = {};
  for (const [key, name] of Object.entries(names)) {
    const value = Number(options[key] ?? env[name] ?? WS_UPGRADE_DEFAULTS[key]);
    const max = key === 'threshold' ? 10000 : key === 'windowMs' ? 86400000 : 30 * 86400000;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
    limits[key] = value;
  }
  return limits;
}

/** Exact sliding window, bounded queues, no timers. Trusted clientAddress owns proxy and IPv6 /64 policy. */
export function createWsUpgradeLimiter({ trustProxy = 'auto', now = Date.now, banStore = createIpBanStore(),
  threshold = WS_UPGRADE_DEFAULTS.threshold, windowMs = WS_UPGRADE_DEFAULTS.windowMs,
  banMs = WS_UPGRADE_DEFAULTS.banMs, maxKeys = 4096 } = {}) {
  const sources = new Map();
  let sweptAt = now();
  const sweep = (at) => {
    for (const [key, source] of sources) if ((source.refusedUntil || source.last + windowMs) <= at) sources.delete(key);
    sweptAt = at;
  };
  return (req) => {
    const { key } = clientAddress(req, trustProxy);
    if (key === null) return true;
    if (banStore.has(key)) return false;
    const at = now();
    if (at - sweptAt >= windowMs) sweep(at);
    let source = sources.get(key);
    if (!source) {
      if (sources.size >= maxKeys) sweep(at);
      if (sources.size >= maxKeys) {
        // A botnet must not fill the counter table and lock every new visitor out. Retain actual local bans.
        const oldest = [...sources].find(([, source]) => !source.refusedUntil);
        if (!oldest) return false;
        sources.delete(oldest[0]);
      }
      source = { requests: [], last: at, refusedUntil: 0 };
      sources.set(key, source);
    }
    if (source.refusedUntil > at) return false;
    if (source.refusedUntil) { source.requests = []; source.refusedUntil = 0; }
    sources.delete(key); sources.set(key, source); // refresh LRU order without allocating another counter
    source.last = at;
    while (source.requests.length && source.requests[0] <= at - windowMs) source.requests.shift();
    if (source.requests.length < threshold) { source.requests.push(at); return true; }
    // Keep the configured local refusal if a full/broken store cannot accept the persistent ban.
    source.refusedUntil = at + banMs;
    try { if (banStore.ban(key, { durationMs: banMs, reason: 'WS_UPGRADE_FLOOD' }) !== false) sources.delete(key); }
    catch { /* local refusal still applies */ }
    return false;
  };
}
