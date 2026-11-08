// Room-owned experimental rules are snapshotted at launch, never player votes.
import { MAX_SEATS } from './constants.js';
import { isPlayerCapacity, roomCapacity } from './playerCapacity.js';

export const EXPERIMENTAL_DEFAULTS = Object.freeze({ revivalEnabled: false, disableSharedPool: false });

export function isExperimental(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length < 2 || keys.length > 5) return false;
  for (const key of Object.keys(EXPERIMENTAL_DEFAULTS)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || typeof descriptor.value !== 'boolean') return false;
  }
  return keys.every(key => {
    if (Object.hasOwn(EXPERIMENTAL_DEFAULTS, key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true) return false;
    return key === 'playerCapacity' ? isPlayerCapacity(descriptor.value)
      : (key === 'disableDuckLord' || key === 'uniteHumansFirst') && typeof descriptor.value === 'boolean';
  });
}

/**
 * @param {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean,
 *   uniteHumansFirst?: boolean }} [value] `uniteHumansFirst`: AI 联防置后 (server/match/unite.js helperOrder).
 */
export function experimentalOptions(value = EXPERIMENTAL_DEFAULTS) {
  if (!isExperimental(value)) throw new TypeError('invalid experimental options');
  const capacity = roomCapacity('coop', value);
  return Object.freeze({ revivalEnabled: value.revivalEnabled, disableSharedPool: value.disableSharedPool,
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }),
    // Optional and false by default: ordinary rooms and legacy DTOs keep their two-flag shape.
    ...(capacity > MAX_SEATS && value.disableDuckLord === true ? { disableDuckLord: true } : {}),
    // Any mode, any capacity: it reorders the 联防 helpers, nothing else.
    ...(value.uniteHumansFirst === true ? { uniteHumansFirst: true } : {}) });
}

/**
 * Whether a room's options change a rule of the game, whatever the seat count: any key but playerCapacity that is set
 * (an option that is off is false or absent, experimentalOptions). 多人匹配's rules axis reads it (server/matchmaking.js):
 * the seat count is the other axis of a ticket.
 */
export const experimentalRuleChanged = value => !!value && Object.entries(value).some(([key, set]) => key !== 'playerCapacity' && !!set);

const duckLordDisabled = value => roomCapacity('coop', value) > MAX_SEATS && value.disableDuckLord === true;
export const experimentalKey = value => {
  const key = `${value.revivalEnabled ? 1 : 0}${value.disableSharedPool ? 1 : 0}`;
  const capacity = roomCapacity('coop', value);
  const legacy = capacity === MAX_SEATS ? key : `${key}:${capacity}`;
  return `${duckLordDisabled(value) ? `${legacy}:duck` : legacy}${value.uniteHumansFirst === true ? ':humans' : ''}`;
};
export const sameExperimental = (a, b) => !!a && !!b
  && a.revivalEnabled === b.revivalEnabled && a.disableSharedPool === b.disableSharedPool
  && roomCapacity('coop', a) === roomCapacity('coop', b)
  && duckLordDisabled(a) === duckLordDisabled(b)
  && (a.uniteHumansFirst === true) === (b.uniteHumansFirst === true);

/**
 * AI 联防置后 (the fork's request, rel29 7de8f2fe): with `uniteHumansFirst` on, the 联防 helpers are chosen among the
 * humans first — the usual order (server/match/unite.js helperOrder) within them — and the seats the engine plays (an
 * AI teammate, a human under AI 托管) only after every human; the pair's order (who meets the enemies first) puts the
 * human first too [ASSUMED]. A rule of the room, any room; it changes nothing outside 联防.
 * @param {any} value a room's / match's experimental options
 */
export const isUniteHumansFirst = value => !!value && typeof value === 'object' && value.uniteHumansFirst === true;
