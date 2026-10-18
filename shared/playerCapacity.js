import { MAX_SEATS } from './constants.js';

// Larger rooms and same-capacity party matchmaking are explicit opt-in experiments.
export const PLAYER_CAPACITIES = Object.freeze([MAX_SEATS, 8, 12, 16, 20]);
export const MAX_PLAYER_CAPACITY = 20;
export const PLAYER_CAPACITY_VERSION = 'capacity-3';
export const MAX_DRAFT_CARDS = MAX_PLAYER_CAPACITY + 2;
export const isPlayerCapacity = value => Number.isInteger(value) && PLAYER_CAPACITIES.includes(value);

export function roomCapacity(mode, experimental) {
  if (mode === 'solo') return 1;
  const capacity = experimental && typeof experimental === 'object'
    ? Object.getOwnPropertyDescriptor(experimental, 'playerCapacity')?.value : undefined;
  return isPlayerCapacity(capacity) ? capacity : MAX_SEATS;
}
