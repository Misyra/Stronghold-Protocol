// Room-owned experimental rules are snapshotted at launch, never player votes.
import { MAX_SEATS } from './constants.js';
import { isPlayerCapacity, roomCapacity } from './playerCapacity.js';

export const EXPERIMENTAL_DEFAULTS = Object.freeze({ revivalEnabled: false, disableSharedPool: false });

export function isExperimental(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length < 2 || keys.length > 4) return false;
  for (const key of Object.keys(EXPERIMENTAL_DEFAULTS)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || typeof descriptor.value !== 'boolean') return false;
  }
  return keys.every(key => {
    if (Object.hasOwn(EXPERIMENTAL_DEFAULTS, key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true) return false;
    return key === 'playerCapacity' ? isPlayerCapacity(descriptor.value)
      : key === 'disableDuckLord' && typeof descriptor.value === 'boolean';
  });
}

/** @param {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean }} [value] */
export function experimentalOptions(value = EXPERIMENTAL_DEFAULTS) {
  if (!isExperimental(value)) throw new TypeError('invalid experimental options');
  const capacity = roomCapacity('coop', value);
  return Object.freeze({ revivalEnabled: value.revivalEnabled, disableSharedPool: value.disableSharedPool,
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }),
    // Optional and false by default: ordinary rooms and legacy DTOs keep their two-flag shape.
    ...(capacity > MAX_SEATS && value.disableDuckLord === true ? { disableDuckLord: true } : {}) });
}

const duckLordDisabled = value => roomCapacity('coop', value) > MAX_SEATS && value.disableDuckLord === true;
export const experimentalKey = value => {
  const key = `${value.revivalEnabled ? 1 : 0}${value.disableSharedPool ? 1 : 0}`;
  const capacity = roomCapacity('coop', value);
  const legacy = capacity === MAX_SEATS ? key : `${key}:${capacity}`;
  return duckLordDisabled(value) ? `${legacy}:duck` : legacy;
};
export const sameExperimental = (a, b) => !!a && !!b
  && a.revivalEnabled === b.revivalEnabled && a.disableSharedPool === b.disableSharedPool
  && roomCapacity('coop', a) === roomCapacity('coop', b)
  && duckLordDisabled(a) === duckLordDisabled(b);
