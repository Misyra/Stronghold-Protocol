// Parser for retired JSON backups. It validates and rebuilds old rows; no recording/export API.
import { N_ } from '../../../shared/i18n.js';

const HISTORY_SCHEMA = 1;
export const LEGACY_IMPORT_BYTES = 16 * 1024 * 1024;

const pick = (value, keys) => Object.fromEntries(keys.filter((k) => value?.[k] != null &&
  ['string', 'number', 'boolean'].includes(typeof value[k])).map((k) => [k, value[k]]));
const RESULT_KEYS = ['matchId', 'startedAt', 'finishedAt', 'victory', 'roundsPassed', 'lastRound', 'hiddenReached',
  'hiddenCleared', 'reason', 'teamLp', 'modeId', 'difficulty', 'stageId', 'bossId', 'hiddenBossId', 'seed', 'durationMs'];
const PLAYER_KEYS = ['playerId', 'seat', 'name', 'isBot', 'left', 'alive', 'victory', 'roundsPassed', 'eliminatedRound',
  'lp', 'bandId', 'trophies', 'reward'];
const STATS = ['dmgDealt', 'kills', 'leaks', 'gold', 'refreshes', 'merges', 'itemsEquipped', 'bossDamage',
  'activatedLayers', 'lpLost', 'perfectRounds'];

/** Only a participating human's completed result is recorded; spectators never become a player's win/loss. */
function rebuildRecord(result, playerId, { now = Date.now(), origin = '', appVersion = '' } = {}) {
  if (!result || typeof result.victory !== 'boolean' || !Array.isArray(result.players) ||
      !result.players.some((p) => p?.playerId === playerId && !p.isBot)) return null;
  const snapshot = pick(result, RESULT_KEYS);
  snapshot.players = result.players.slice(0, 4).filter((p) => p && typeof p.playerId === 'string').map((p) => ({
    ...pick(p, PLAYER_KEYS),
    lineup: (Array.isArray(p.lineup) ? p.lineup : []).slice(0, 36).map((u) => ({
      ...pick(u, ['id', 'kind', 'golden', 'tier', 'row', 'col', 'standInFor']),
      ...(u?.diy ? { diy: pick(u.diy, ['charId', 'skillIndex', 'uniEquipId']) } : {}),
      items: (Array.isArray(u?.items) ? u.items : []).filter((id) => typeof id === 'string').slice(0, 16),
    })),
    bonds: (Array.isArray(p.bonds) ? p.bonds : []).slice(0, 64).map((b) => pick(b, ['bondId', 'layers', 'active', 'count'])),
    stats: pick(p.stats, STATS),
    title: typeof p.title === 'string' ? p.title : p.title ? pick(p.title, ['id', 'name', 'picId', 'text']) : null,
  }));
  // Older servers have no matchId. Their seed, duration and participants stay identical on result resends.
  const matchId = typeof snapshot.matchId === 'string' && snapshot.matchId ? snapshot.matchId : JSON.stringify([
    snapshot.seed, snapshot.modeId, snapshot.stageId, snapshot.durationMs,
    snapshot.players.map((p) => p.playerId).sort(),
  ]);
  const record = { schema: HISTORY_SCHEMA, id: JSON.stringify([origin, matchId, playerId]), playerId,
    recordedAt: now, endedAt: Number.isFinite(snapshot.finishedAt) ? snapshot.finishedAt : now,
    origin, appVersion, result: snapshot };
  if (new TextEncoder().encode(JSON.stringify(record)).length > 128 * 1024) throw new Error('对局记录过大，未保存');
  return record;
}

/** Validate the entire export before any storage write, rebuilding snapshots without unknown fields. */
export function parseLegacyBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > LEGACY_IMPORT_BYTES) throw new Error(N_('对局记录文件过大，请选择不超过 16 MB 的 JSON 文件。'));
  let doc;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error(N_('无法读取 JSON，请选择本游戏导出的对局记录文件。')); }
  if (!doc || doc.format !== 'stronghold-match-history' || !Array.isArray(doc.records) || doc.records.length > 1000) {
    throw new Error(N_('对局记录文件格式无效，请选择本游戏导出的 JSON 文件。'));
  }
  if (doc.schema !== HISTORY_SCHEMA) throw new Error(N_('对局记录版本不兼容，请使用当前版本导出的文件。'));
  return doc.records.map((raw) => {
    const invalid = () => new Error(N_('导入文件包含无效的对局记录，未做任何改动。'));
    if (!raw || raw.schema !== HISTORY_SCHEMA || raw.deleted || typeof raw.id !== 'string' ||
      typeof raw.playerId !== 'string' || !raw.playerId || typeof raw.origin !== 'string' ||
      typeof raw.appVersion !== 'string' || !Number.isFinite(raw.recordedAt) || raw.recordedAt < 0 ||
      !Number.isFinite(raw.endedAt) || raw.endedAt < 0 || !Array.isArray(raw.result?.players) ||
      raw.result.players.length < 1 || raw.result.players.length > 4 || new TextEncoder().encode(JSON.stringify(raw)).length > 128 * 1024 ||
      raw.result.players.some((p) => !p || typeof p.playerId !== 'string' || !p.playerId) ||
      new Set(raw.result.players.map((p) => p.playerId)).size !== raw.result.players.length) throw invalid();
    let record;
    try { record = rebuildRecord(raw.result, raw.playerId, { now: raw.recordedAt, origin: raw.origin, appVersion: raw.appVersion }); }
    catch { throw invalid(); }
    if (!record || record.id !== raw.id) throw invalid();
    record.endedAt = raw.endedAt;
    return record;
  });
}
