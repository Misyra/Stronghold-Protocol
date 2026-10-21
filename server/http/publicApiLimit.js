// Shared admission budget for public HTTP APIs; separate from gameplay/WebSocket limits.
import { performance } from 'node:perf_hooks';
import { clientAddress, TokenBucket } from '../net.js';
import { createIpBanStore } from './ipBans.js';

export const PUBLIC_API_DEFAULTS = Object.freeze({
  ratePerSec: 0, burst: 0, globalRatePerSec: 0, globalBurst: 0,
  healthRatePerSec: 0, healthBurst: 0,
  banThreshold: 0, banWindowMs: 60000,
});

/**
 * Validate before allocating server resources. `0` means that dimension is off, and every dimension ships off:
 * a bare checkout answers public APIs without a budget or a ban. Give it numbers to turn protection on.
 */
export function publicApiLimitsFrom(options = {}, env = process.env) {
  const names = {
    ratePerSec: 'SP_HTTP_API_RATE', burst: 'SP_HTTP_API_BURST',
    globalRatePerSec: 'SP_HTTP_API_GLOBAL_RATE', globalBurst: 'SP_HTTP_API_GLOBAL_BURST',
    healthRatePerSec: 'SP_HTTP_HEALTH_RATE', healthBurst: 'SP_HTTP_HEALTH_BURST',
    banThreshold: 'SP_HTTP_BAN_THRESHOLD', banWindowMs: 'SP_HTTP_BAN_WINDOW_MS',
  };
  const limits = {};
  for (const [key, name] of Object.entries(names)) {
    const raw = options[key] ?? env[name];
    const value = Number(raw ?? PUBLIC_API_DEFAULTS[key]);
    const max = key === 'banWindowMs' ? 86400000 : key === 'banThreshold' ? 10000 : 100000;
    if (raw === '' || !Number.isSafeInteger(value) || value < 0 || value > max)
      throw new RangeError(`${name} must be an integer between 0 and ${max}`);
    limits[key] = value;
  }
  return limits;
}

export function apiMainlandOnlyFrom(value = 'off') {
  if (typeof value === 'boolean') return value;
  const flag = String(value).trim().toLowerCase();
  if (['on', 'true', '1'].includes(flag)) return true;
  if (['off', 'false', '0'].includes(flag)) return false;
  throw new RangeError('SP_HTTP_API_CN_ONLY must be on or off');
}

/**
 * Only addresses this database can actually place are judged: a 2-letter code decides, `undefined` (the database
 * cannot see this address family at all) passes, and an address it places nowhere is refused. A missing or failing
 * lookup is a 503, never a silent pass.
 */
export function publicApiCountryStatus(req, { enabled, countryLookup, trustProxy = 'auto' }) {
  if (!enabled) return 0;
  const { ip, key } = clientAddress(req, trustProxy);
  if (key === null) return 0;
  if (!countryLookup) return 503;
  let country;
  try { country = countryLookup(ip); } catch { return 503; }
  // `undefined` is not a verdict: it means the database cannot see this address family at all (cn-only mode with an
  // IPv4-only database, so every IPv6 client). Refusing those made the only domestic IPv6 players look overseas on
  // every public API and health probe. An address the database places nowhere (`null`, or the 'ZZ' marker cn-only
  // mode emits for a mainland-only IPv4 database) is still refused, per the 2026-10-17 decision.
  if (country === undefined) return 0;
  const code = typeof country === 'string' ? country.toUpperCase() : '';
  return code === 'CN' ? 0 : 403;
}

/** 显式要一个限流器、又没给预算时用的那套值。服务器启动不会落到这里，只有直接构造的地方才会。 */
export const PUBLIC_API_BUDGETS = Object.freeze({
  ratePerSec: 5, burst: 30, globalRatePerSec: 200, globalBurst: 400,
  healthRatePerSec: 20, healthBurst: 40,
  banThreshold: 600, banWindowMs: 60000,
});

/** IPv4 / IPv6 /64 share tokens across paths, queries and methods. Bounded memory, no timers. */
export function createPublicApiLimiter({ trustProxy = 'auto', now = () => performance.now(),
  ratePerSec = PUBLIC_API_BUDGETS.ratePerSec, burst = PUBLIC_API_BUDGETS.burst,
  globalRatePerSec = PUBLIC_API_BUDGETS.globalRatePerSec, globalBurst = PUBLIC_API_BUDGETS.globalBurst,
  healthRatePerSec = PUBLIC_API_BUDGETS.healthRatePerSec, healthBurst = PUBLIC_API_BUDGETS.healthBurst,
  banThreshold = PUBLIC_API_BUDGETS.banThreshold, banWindowMs = PUBLIC_API_BUDGETS.banWindowMs,
  banStore = createIpBanStore(), maxKeys = 4096, idleMs = Math.max(60000, banWindowMs) } = {}) {
  // 每个维度单独看 0：0 就是那一维不设预算。全部为 0 就是这个限流器根本没开——不建桶、不计数、不封禁，
  // 但仍然把调用方给的准入结论原样传回去：国别判定是 routes 算好之后经 admit 送进来的，不是这一层的职责。
  const banOn = banThreshold > 0;
  if (!(ratePerSec > 0) && !banOn && !(globalRatePerSec > 0) && !(healthRatePerSec > 0))
    return (_req, _rawPath, admit = true) => admit;
  const buckets = new Map();
  /** Networks refused locally because the ban store could not take them (see the ban branch below). */
  const overThreshold = new Map();
  const global = globalRatePerSec > 0 ? new TokenBucket(globalRatePerSec, globalBurst, now()) : null;
  const health = healthRatePerSec > 0 ? new TokenBucket(healthRatePerSec, healthBurst, now()) : null;
  let sweptAt = now();
  return (req, rawPath = '', admit = true) => {
    const { key } = clientAddress(req, trustProxy);
    // Direct local monitoring survives public saturation. Forwarded internet clients have a key.
    if (key === null) return true;
    const at = now();
    if (at - sweptAt >= idleMs) {
      for (const [key, bucket] of buckets) if (at - bucket.lastRequestAt >= idleMs) buckets.delete(key);
      // A locally refused network is released when the same sliding window that would have banned it passes.
      for (const [key, refusedAt] of overThreshold) if (at - refusedAt >= banWindowMs) overThreshold.delete(key);
      sweptAt = at;
    }
    if (overThreshold.has(key)) return false;
    if (banOn && banStore.has(key)) return false;
    let bucket = buckets.get(key);
    if (!bucket) {
      // Full table: evict the least recently active network instead of refusing every new source. Refusing them
      // turned a big botnet into a blanket outage — real players and monitors were locked out while the bots,
      // who never got a bucket, were neither counted nor banned. A flooder that is evicted and comes back is
      // counted again from scratch and banned on its own threshold+1-th request like any other network.
      if (buckets.size >= maxKeys) {
        let oldestKey = null, oldestAt = Infinity;
        for (const [otherKey, other] of buckets) if (other.lastRequestAt < oldestAt) { oldestAt = other.lastRequestAt; oldestKey = otherKey; }
        if (oldestKey === null) return false;
        buckets.delete(oldestKey);
      }
      bucket = new TokenBucket(ratePerSec, burst, at);
      bucket.requests = [];
      bucket.head = 0;
      buckets.set(key, bucket);
    }
    bucket.lastRequestAt = at;
    // Exact sliding window; rejected requests count too. Compact the bounded queue amortized.
    while (bucket.head < bucket.requests.length && bucket.requests[bucket.head] <= at - banWindowMs) bucket.head++;
    if (bucket.head > 256) { bucket.requests.splice(0, bucket.head); bucket.head = 0; }
    bucket.requests.push(at);
    if (banOn && bucket.requests.length - bucket.head > banThreshold) {
      // Dropping the counter hands the source a fresh burst, and a throwing ban store (full list, unwritable
      // disk) used to escape as a 500 while the counter was lost. Only a ban that really took hold retires the
      // bucket; otherwise this network stays refused until its window passes, counted in overThreshold above.
      let banned;
      try { banned = banStore.ban(key) !== false; } catch { banned = false; }
      if (banned) buckets.delete(key);
      else if (overThreshold.size < maxKeys) overThreshold.set(key, at);
      return false;
    }
    // Rejected overseas requests still count towards bans, but cannot drain domestic visitors' tokens.
    if (!admit) return false;
    // A single exhausted source must not consume the budget reserved for other sources.
    // Health flooding cannot drain the budget for nickname validation, announcements or room queries.
    return (ratePerSec > 0 ? bucket.take(at) : true)
      && (rawPath !== '/healthz' || health === null || health.take(at))
      && (global === null || global.take(at));
  };
}

export function isPublicApiPath(path) {
  return path === '/healthz' || path === '/metrics' || path === '/api' || path.startsWith('/api/');
}
