import { open } from 'maxmind';
import { isIP } from 'node:net';

export function parseGeoipMode(value = 'country') {
  const mode = String(value).trim().toLowerCase();
  if (!['country', 'cn-only'].includes(mode)) throw new RangeError('SP_GEOIP_MODE must be country or cn-only');
  return mode;
}

/** A mainland-only IPv4 database uses absence as a classification, not as a failed country lookup. */
export function countryLookupFromReader(reader, mode = 'country') {
  mode = parseGeoipMode(mode);
  if (!/(Country|City)/.test(reader.metadata.databaseType))
    throw new Error('GeoLite database must contain country locations, not ASN records');
  if (mode === 'cn-only') {
    const hasMainland = ['114.114.114.114', '223.5.5.5'].some(ip => reader.get(ip)?.country?.iso_code === 'CN');
    if (!hasMainland || reader.get('8.8.8.8') !== null)
      throw new Error('cn-only mode requires a mainland-only Country database with mainland IPv4 records');
  }
  return (ip) => {
    const family = isIP(ip);
    if (!family) return null;
    const record = reader.get(ip);
    const code = record?.country?.iso_code;
    if (typeof code === 'string' && /^[A-Z]{2}$/.test(code)) return code;
    // This source has no mainland IPv6 coverage. An IPv6 address is therefore "this table cannot place
    // it", not "overseas": answer undefined — the established "no verdict" channel that callers fail open
    // on — so an IPv6 miss is never read as a foreign address (see foreignSessions.countryOf).
    if (mode === 'cn-only' && family === 6) return undefined;
    // ZZ is a private policy marker for non-mainland, not an assertion of the address's actual country.
    return mode === 'cn-only' && family === 4 && record === null ? 'ZZ' : null;
  };
}

/** Load once at startup; no network or disk access in the game message path. */
export async function openCountryLookup(file, { mode = 'country' } = {}) {
  mode = parseGeoipMode(mode);
  const reader = await open(file);
  return countryLookupFromReader(reader, mode);
}
