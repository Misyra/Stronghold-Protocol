// Count upgrade attempts before path/origin/admission checks. Successful short-lived sockets count too.
import { clientAddress } from '../net.js';
import { createIpBanStore } from './ipBans.js';

// The application sees admitted/rejected upgrade attempts, unlike the ingress jail's 444-only counter.
// Allow shared-NAT reconnect bursts; deployments may still explicitly choose a stricter threshold.
export const WS_UPGRADE_DEFAULTS = Object.freeze({ threshold: 100, windowMs: 60000, banMs: 3600000 });

// One client must not be able to ban itself. The browser backs off 500ms → ×2 → 10s
// (public/js/net.js BACKOFF), which is about ten upgrade attempts per minute before any jitter:
// a threshold under 20/min is reachable by a single stuck tab, and a ban longer than an hour then
// turns one bad reconnect into an outage for that network. 2026-10-18 ran 10/min with a 24h ban and
// refused 78% of all /ws upgrades (16,442 429s against 4,604 accepted) until it was walked back.
const MIN_THRESHOLD_PER_MINUTE = 20;
const LONG_BAN_MS = 3600000;
const LONG_BAN_MIN_THRESHOLD = 100;

export function wsUpgradeLimitsFrom(options = {}, env = process.env) {
  const names = { threshold: 'SP_WS_UPGRADE_THRESHOLD', windowMs: 'SP_WS_UPGRADE_WINDOW_MS', banMs: 'SP_WS_UPGRADE_BAN_MS' };
  const limits = {};
  for (const [key, name] of Object.entries(names)) {
    const value = Number(options[key] ?? env[name] ?? WS_UPGRADE_DEFAULTS[key]);
    const max = key === 'threshold' ? 10000 : key === 'windowMs' ? 86400000 : 30 * 86400000;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
    limits[key] = value;
  }
  const minThreshold = Math.ceil(MIN_THRESHOLD_PER_MINUTE * limits.windowMs / 60000);
  if (limits.threshold < minThreshold) {
    throw new RangeError(`${names.threshold} must be at least ${minThreshold} per ${limits.windowMs}ms window: one client's own reconnect ladder attempts ~10 upgrades per minute, so a lower threshold bans players for retrying`);
  }
  if (limits.banMs > LONG_BAN_MS && limits.threshold < LONG_BAN_MIN_THRESHOLD) {
    throw new RangeError(`${names.banMs} above one hour requires ${names.threshold} >= ${LONG_BAN_MIN_THRESHOLD}: a shorter threshold lets a single stuck client earn a day-long ban`);
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
