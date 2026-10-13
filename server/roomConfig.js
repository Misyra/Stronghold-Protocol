import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** @type {Readonly<Record<string, readonly [string, number, number, number]>>} */
export const ROOM_LIMIT_OPTIONS = Object.freeze({
  roomCreateBurst: ['SP_ROOM_CREATE_BURST', 4, 1, 100],
  roomCreateRefillMs: ['SP_ROOM_CREATE_REFILL_MS', 15000, 100, 3600000],
  matchStartBurst: ['SP_MATCH_START_BURST', 4, 1, 100],
  matchStartRefillMs: ['SP_MATCH_START_REFILL_MS', 30000, 100, 3600000],
  maxBots: ['SP_BOT_MAX_TOTAL', 300, 1, 10000],
  maxForeignBots: ['SP_BOT_MAX_FOREIGN', 50, 1, 10000],
});
export const ROOM_PROTECTION_DEFAULTS = Object.freeze({
  limitForeignSessions: true,
  allowForeignConnections: true,
  roomCreateBurst: ROOM_LIMIT_OPTIONS.roomCreateBurst[1],
  roomCreateRefillMs: ROOM_LIMIT_OPTIONS.roomCreateRefillMs[1],
  matchStartBurst: ROOM_LIMIT_OPTIONS.matchStartBurst[1],
  matchStartRefillMs: ROOM_LIMIT_OPTIONS.matchStartRefillMs[1],
  maxBots: ROOM_LIMIT_OPTIONS.maxBots[1],
  maxForeignBots: ROOM_LIMIT_OPTIONS.maxForeignBots[1],
});

export function validateRoomConfig(config, { partial = false } = {}) {
  if (!config || Array.isArray(config) || typeof config !== 'object' || !Object.keys(config).length ||
    Object.keys(config).some((key) => !['maxRooms', 'allowBots', 'limitForeignSessions', 'allowForeignConnections'].includes(key))) return 'INVALID_ROOM_CONFIG';
  if ((!partial || Object.hasOwn(config, 'maxRooms')) &&
    (!Number.isSafeInteger(config.maxRooms) || config.maxRooms < 1 || config.maxRooms > 10000)) return 'INVALID_MAX_ROOMS';
  if (Object.hasOwn(config, 'allowBots') && typeof config.allowBots !== 'boolean') return 'INVALID_ALLOW_BOTS';
  if (Object.hasOwn(config, 'limitForeignSessions') && typeof config.limitForeignSessions !== 'boolean') return 'INVALID_FOREIGN_SESSION_LIMIT';
  if (Object.hasOwn(config, 'allowForeignConnections') && typeof config.allowForeignConnections !== 'boolean') return 'INVALID_ALLOW_FOREIGN_CONNECTIONS';
  return null;
}

export async function loadRoomConfig(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state?.schemaVersion !== 1) throw new Error('invalid room admin state');
    const { schemaVersion: _version, ...config } = state;
    const error = validateRoomConfig(config);
    if (error) throw new Error(error);
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read room admin state at ${file}: ${error.message}`, { cause: error });
  }
}

export async function saveRoomConfig(file, config) {
  const error = validateRoomConfig(config);
  if (error) throw new Error(error);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...config }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
