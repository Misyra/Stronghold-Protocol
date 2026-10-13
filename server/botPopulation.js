import { normalizeIp, isLocalIp } from './net.js';
import { ERR } from '../shared/constants.js';
import { ROOM_PROTECTION_DEFAULTS } from './roomConfig.js';

export const botCountry = (value) => typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : null;
const isForeign = (country) => !!country && country !== 'CN';

/** Live seats, not hourly credits. Seat identity avoids collisions between rooms' bot IDs. */
export class BotPopulation {
  constructor({ countryLookup = null, maxTotal = ROOM_PROTECTION_DEFAULTS.maxBots,
    maxForeign = ROOM_PROTECTION_DEFAULTS.maxForeignBots } = {}) {
    if (countryLookup !== null && typeof countryLookup !== 'function') throw new TypeError('countryLookup must be a function');
    for (const value of [maxTotal, maxForeign])
      if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new RangeError('invalid AI population limit');
    this.countryLookup = countryLookup;
    this.maxTotal = maxTotal;
    this.maxForeign = maxForeign;
    this.seats = new Map();
    this.foreign = 0;
    this.counts = { totalDenied: 0, foreignDenied: 0, lookupMisses: 0, lookupErrors: 0 };
  }

  canAdd(ip) {
    if (this.seats.size >= this.maxTotal) {
      this.counts.totalDenied++;
      return { ok: false, code: ERR.AI_POPULATION_LIMIT, country: null };
    }
    let country = null;
    const address = normalizeIp(ip);
    if (this.countryLookup && address && !isLocalIp(address)) {
      try { country = botCountry(this.countryLookup(address)); }
      catch { this.counts.lookupErrors++; }
      if (!country) this.counts.lookupMisses++;
    }
    if (isForeign(country) && this.foreign >= this.maxForeign) {
      this.counts.foreignDenied++;
      return { ok: false, code: ERR.FOREIGN_AI_POPULATION_LIMIT, country };
    }
    return { ok: true, country };
  }

  track(seat) {
    if (!seat?.isBot || seat.left || this.seats.has(seat)) return;
    const country = botCountry(seat.botCountry);
    this.seats.set(seat, country);
    if (isForeign(country)) this.foreign++;
  }

  release(seat) {
    if (!this.seats.has(seat)) return;
    if (isForeign(this.seats.get(seat))) this.foreign--;
    this.seats.delete(seat);
  }

  stats() {
    return { total: this.seats.size, foreign: this.foreign, maxTotal: this.maxTotal,
      maxForeign: this.maxForeign, foreignEnabled: !!this.countryLookup, ...this.counts };
  }
}
