// Official absolute maxima for plugin blackboard values and the few non-blackboard fields that drive loops
// (DESIGN §32.5). Official data is immutable, so the table is cached by object identity. The battle reads the
// same cache; a direct kit built before getData() falls back to PLUGIN_BOUND_FLOOR, which still sits at or
// above every official input of the clamped loops. [ASSUMED] factor 10 and floor 64.

import { dataBound } from './limits.js';

/**
 * Tables walked for both the maximum and the check. choices, garrisons and tokens are included so a higher
 * official value is not missed; that only loosens a cap. [ASSUMED]
 */
export const BOUND_TABLES = Object.freeze([
  'chess', 'backups', 'enemies', 'bands', 'bonds', 'effects', 'items', 'waves', 'choices', 'garrisons', 'tokens',
]);

/** Skill fields that schedule charges or repeats. Durations and cooldowns are not in this list. */
const SKILL_FIELDS = Object.freeze(['spCost', 'initSp', 'maxChargeTime', 'increment']);
const ENEMY_SP_FIELDS = Object.freeze(['maxSp', 'initSp', 'increment']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @type {object|null} */
let cachedSource = null;
/** @type {{ bb: Map<string, number>, fields: Map<string, number> }|null} */
let cached = null;

function bump(map, key, abs) {
  const prev = map.get(key);
  if (prev == null || abs > prev) map.set(key, abs);
}

function emitBb(bb, path, fn) {
  if (Array.isArray(bb)) {
    bb.forEach((row, i) => {
      if (isPlain(row) && typeof row.key === 'string' && typeof row.value === 'number' && Number.isFinite(row.value)) {
        fn({ kind: 'bb', key: row.key, value: row.value, path: `${path}[${i}].value` });
      }
    });
    return;
  }
  if (!isPlain(bb)) return;
  for (const [k, v] of Object.entries(bb)) {
    if (typeof v === 'number' && Number.isFinite(v)) fn({ kind: 'bb', key: k, value: v, path: `${path}.${k}` });
    else if (v && typeof v === 'object') emitBb(v, `${path}.${k}`, fn);
  }
}

function isSkill(node) {
  return typeof node.skillId === 'string' || typeof node.prefabKey === 'string' || typeof node.skillType === 'string';
}

function isEnemySp(node, table) {
  return isPlain(node.sp) && (table === 'enemies' || table === 'waves') && (isPlain(node.stats) || table === 'waves');
}

function visit(node, table, path, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => visit(v, table, `${path}[${i}]`, fn));
    return;
  }
  if (node.bb && typeof node.bb === 'object') emitBb(node.bb, `${path}.bb`, fn);
  if (Array.isArray(node.blackboard)) emitBb(node.blackboard, `${path}.blackboard`, fn);
  if (isSkill(node)) {
    for (const k of SKILL_FIELDS) {
      const v = node[k];
      if (typeof v === 'number' && Number.isFinite(v)) fn({ kind: 'field', field: `skill.${k}`, value: v, path: `${path}.${k}` });
    }
  }
  if (isEnemySp(node, table)) {
    for (const k of ENEMY_SP_FIELDS) {
      const v = node.sp[k];
      if (typeof v === 'number' && Number.isFinite(v)) fn({ kind: 'field', field: `enemy.sp.${k}`, value: v, path: `${path}.sp.${k}` });
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'bb' || k === 'blackboard' || k === 'sp') continue;
    if (v && typeof v === 'object') visit(v, table, `${path}.${k}`, fn);
  }
}

function scan(data) {
  const bb = new Map();
  const fields = new Map();
  for (const table of BOUND_TABLES) {
    visit(data?.[table], table, table, (ev) => {
      if (ev.kind === 'bb') bump(bb, ev.key, Math.abs(ev.value));
      else bump(fields, ev.field, Math.abs(ev.value));
    });
  }
  return { bb, fields };
}

/**
 * Cache official maxima for `data`. The same object is not scanned again. A different object replaces the cache.
 * @param {object} data vanilla tables (getData() or the content set's base)
 */
export function rememberOfficialBounds(data) {
  if (!data || typeof data !== 'object') {
    cachedSource = null;
    cached = { bb: new Map(), fields: new Map() };
    return cached;
  }
  if (cachedSource === data && cached) return cached;
  cached = scan(data);
  cachedSource = data;
  return cached;
}

/** Drop the cache (server/data.js resetData). The next read uses the floor until remember runs again. */
export function forgetOfficialBounds() {
  cachedSource = null;
  cached = null;
}

function current() {
  return cached;
}

/** Official absolute maximum of a blackboard key, or null when the cached tables never use it. */
export function officialBbMax(key) {
  const map = current()?.bb;
  return map && map.has(key) ? map.get(key) : null;
}

/** Official absolute maximum of a loop field (`enemy.sp.maxSp`, `skill.spCost`, …), or null. */
export function officialFieldMax(name) {
  const map = current()?.fields;
  return map && map.has(name) ? map.get(name) : null;
}

/** Runtime cap for a blackboard key. Call at use time: the cache may be filled after import. */
export function bbCap(key) {
  return dataBound(officialBbMax(key));
}

/** Runtime cap for a documented loop field. */
export function fieldCap(name) {
  return dataBound(officialFieldMax(name));
}

function boundMessage(label, key, value, cap, known, officialMax) {
  const tail = known ? `原版最大 ${officialMax}` : '原版没有这个键';
  return `${label} ${key} 的值 ${value} 超过上限 ${cap}（${tail}）`;
}

function exceed(bad, ev, map, label, key) {
  const known = map.has(key);
  const officialMax = known ? map.get(key) : null;
  const cap = dataBound(known ? officialMax : null);
  if (Math.abs(ev.value) > cap) bad(ev.path, boundMessage(label, key, ev.value, cap, known, officialMax), 'PLUGIN_DATA_BOUND');
}

/**
 * Report PLUGIN_DATA_BOUND for numeric blackboard values and the documented loop fields.
 * Maxima come from `vanilla`, never from `data` (a bomb must not raise its own cap).
 * @param {object} data composed tables
 * @param {object} vanilla official tables
 * @param {(path: string, message: string, code?: string) => void} bad
 */
export function appendOfficialBounds(data, vanilla, bad) {
  const bounds = rememberOfficialBounds(vanilla);
  for (const table of BOUND_TABLES) {
    visit(data?.[table], table, table, (ev) => {
      if (ev.kind === 'bb') exceed(bad, ev, bounds.bb, '黑板', ev.key);
      else exceed(bad, ev, bounds.fields, '字段', ev.field);
    });
  }
}
