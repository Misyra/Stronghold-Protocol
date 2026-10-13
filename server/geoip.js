import { open } from 'maxmind';

/** Load once at startup; no network or disk access in the game message path. */
export async function openCountryLookup(file) {
  const reader = await open(file);
  if (!/(Country|City)/.test(reader.metadata.databaseType))
    throw new Error('GeoLite database must contain country locations, not ASN records');
  return (ip) => {
    const code = reader.get(ip)?.country?.iso_code;
    return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : null;
  };
}
