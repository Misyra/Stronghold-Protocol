// Read the retired local-history database once; all new records use the upstream statistics model.
import { readLegacyHistory } from './legacyStorage.js';
import { loadStats, saveStats, buildRecord, mergeStats, STATS_VERSION } from '../ui/stats.js';
const MIGRATED = 'sp.pref.historyMigrated';
let pending;
export async function migrateLegacyHistory({ readRecords = readLegacyHistory, localStorage = globalThis.localStorage } = {}) {
  if (localStorage?.getItem(MIGRATED)) return 0;
  const rows = await readRecords();
  if (!rows.length) { localStorage.setItem(MIGRATED, '1'); return 0; }
  const current = loadStats();
  if (current.newer) throw new Error('请升级客户端后迁移本地记录');
  const incoming = { v: STATS_VERSION, records: rows.map((r) => buildRecord(r.result, { myId: r.playerId, now: r.endedAt })).filter(Boolean) };
  const merged = mergeStats(current, incoming);
  const added = merged.records.filter((r) => !current.records.some((old) => old.id === r.id)).length;
  if (rows.length && !saveStats(merged)) throw new Error('本地记录迁移失败，旧数据库已保留');
  localStorage.setItem(MIGRATED, '1');
  return added;
}
export function migrateHistory() {
  if (!globalThis.indexedDB) return Promise.resolve(0);
  if (!pending) pending = migrateLegacyHistory().catch((error) => { pending = null; throw error; });
  return pending;
}
