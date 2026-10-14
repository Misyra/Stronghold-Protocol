import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { activeChatStrikes } from './moderation/chatState.js';
import { ROOM_PROTECTION_DEFAULTS } from './roomConfig.js';

export const foreignSessionKey = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;

/** A live-configured gameplay identity cap per foreign IP; Lobby retains ownership of cleanup. */
export class ForeignSessions {
  constructor({ registry, countryLookup = null, now = Date.now, isEnabled = () => true, allowConnections = () => true,
    maxPerIp = () => ROOM_PROTECTION_DEFAULTS.maxForeignSessionsPerIp }) {
    this.registry = registry;
    this.countryLookup = countryLookup;
    this.now = now;
    this.isEnabled = isEnabled;
    this.maxPerIp = maxPerIp;
    this.allowConnections = allowConnections;
    this.connectionLog = { at: -Infinity, suppressed: 0 };
    this.byIp = new Map();
    this.initialized = false;
    this.counts = { denied: 0, reclaimed: 0, connectionDenied: 0, lookupMisses: 0, lookupErrors: 0 };
  }

  countryOf(ip) {
    if (!this.countryLookup || !isIP(ip)) return null;
    let country;
    try { country = this.countryLookup(ip); }
    catch { this.counts.lookupErrors++; return null; }
    if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) { this.counts.lookupMisses++; return null; }
    return country;
  }

  connectionAdmission(ip) {
    const result = { ok: true, country: null, suppressed: null };
    if (this.allowConnections()) return result;
    const country = this.countryOf(ip);
    if (!country || country === 'CN') return result;
    this.counts.connectionDenied++;
    result.ok = false; result.country = country;
    if (this.now() - this.connectionLog.at >= 10000) {
      result.suppressed = this.connectionLog.suppressed;
      this.connectionLog = { at: this.now(), suppressed: 0 };
    } else this.connectionLog.suppressed++;
    return result;
  }

  entry(key) {
    let entry = this.byIp.get(key);
    if (!entry) {
      entry = { sessions: new Set(), logAt: -Infinity, suppressed: 0 };
      this.byIp.set(key, entry);
    }
    return entry;
  }

  forget(session) {
    const key = foreignSessionKey(session.foreignSessionKey), entry = this.byIp.get(key);
    if (!entry) return;
    entry.sessions.delete(session);
    if (!entry.sessions.size) this.byIp.delete(key);
  }

  prune() {
    for (const entry of this.byIp.values()) for (const session of entry.sessions)
      if (this.registry.byId(session.playerId) !== session) this.forget(session);
  }

  /** `ip` is normalized by the existing trusted-proxy resolver; private addresses are passed as empty. */
  prepare(ip, current = null) {
    const plan = { ok: true, key: null, country: null, stale: [], penalties: [], suppressed: null };
    const country = this.countryOf(ip);
    if (!country || country === 'CN') return plan;
    // Canonicalize equivalent IPv6 spellings, but do not merge distinct IPs into a /64 here.
    const address = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
    plan.key = createHash('sha256').update(address).digest('hex');
    plan.country = country;
    // Keep quota keys while disabled, so switching on can see identities created during that period.
    // Existing same-IP token resumes remain valid; enabling never forcibly evicts legacy players.
    if (!this.isEnabled() || current?.foreignSessionKey === plan.key) return plan;
    if (!this.initialized) {
      for (const session of this.registry.all()) {
        const key = foreignSessionKey(session.foreignSessionKey);
        if (key) this.entry(key).sessions.add(session);
      }
      this.initialized = true;
    }
    const entry = this.byIp.get(plan.key);
    if (!entry) return plan;
    let online = 0;
    for (const session of entry.sessions) {
      if (this.registry.byId(session.playerId) !== session) { this.forget(session); continue; }
      if (session === current) continue;
      if (session.connected) online++;
      else plan.stale.push(session);
    }
    plan.ok = online < this.maxPerIp();
    if (!plan.ok) {
      this.counts.denied++;
      if (this.now() - entry.logAt >= 10000) {
        plan.suppressed = entry.suppressed;
        entry.logAt = this.now();
        entry.suppressed = 0;
      } else entry.suppressed++;
    }
    return plan;
  }

  reclaim(plan, retire) {
    if (!plan.ok) throw new Error('cannot reclaim a refused admission');
    for (const session of plan.stale) {
      if (session.connected) throw new Error('cannot reclaim an online session');
      plan.penalties.push({ chatStrikes: activeChatStrikes(session.chatStrikes, session.chatLastHitAt,
        this.now(), session.chatMutedUntil), chatLastHitAt: session.chatLastHitAt, chatMutedUntil: session.chatMutedUntil });
      retire(session);
      this.registry.remove(session);
      this.forget(session);
      this.counts.reclaimed++;
    }
  }

  bind(session, plan) {
    this.forget(session);
    session.foreignSessionKey = plan.key;
    if (plan.key) this.entry(plan.key).sessions.add(session);
    // A new token must not erase the IP's still-active moderation penalties.
    for (const penalty of plan.penalties) {
      session.chatStrikes = Math.max(session.chatStrikes, penalty.chatStrikes);
      session.chatLastHitAt = Math.max(session.chatLastHitAt, penalty.chatLastHitAt);
      session.chatMutedUntil = Math.max(session.chatMutedUntil, penalty.chatMutedUntil);
    }
  }

  stats() {
    const configured = this.isEnabled(), allowForeignConnections = this.allowConnections();
    return { configured, geoipAvailable: !!this.countryLookup, enabled: configured && !!this.countryLookup,
      allowForeignConnections, foreignConnectionsBlocked: !allowForeignConnections && !!this.countryLookup,
      maxPerIp: this.maxPerIp(), ...this.counts };
  }
}
