// Local match statistics: every finished match the local player took part in is appended as one record to
// localStorage (`sp.pref.stats`, the loadPref/savePref convention of store.js). Per-browser only — the server
// keeps matches in memory and has no identity, so there is nowhere else for cross-match numbers to live; the
// stats page labels itself 本机数据 and offers JSON export / import for moving between devices.
//
// The record keeps everything the settlement offers (m.result is free-form, server/match/results.js buildResult):
// the match frame (difficulty, mode, boss, seed, duration, hidden-core outcome, reason) plus one row per player
// — band, title (评语), lineup, bonds and the full stat block — even where today's page aggregates only a part.
// Whatever a future statistics view needs should already be in the record; display is the only thing that lags.
//
// Format evolution: the envelope carries a version (`STATS_VERSION`); `migrateStats` walks records through a
// chain of per-version steps and every loaded / imported record passes `normalizeRecord`, which fills defaults
// for missing fields and PRESERVES unknown ones — so data written by an older build reads fine after an
// upgrade, and fields added by a newer writer survive a round-trip through this one. An envelope from a newer
// version than this build is refused (never silently downgraded and written back).
//
// Pure logic, no Preact / DOM: Node-testable (test/ui/stats.test.js); localStorage is touched only through
// loadStats / saveStats.

import { loadPref } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** Current record-envelope version (bump + add a MIGRATIONS step when the record shape changes). */
export const STATS_VERSION = 1;
/** localStorage key under the app's `sp.pref.` prefix (store.js loadPref). */
export const STATS_PREF_KEY = 'stats';
/** Oldest records are dropped beyond this (rough sizing: ~1.5 kB/record ⇒ ~1.5 MB of a ~5 MB quota). */
export const MAX_RECORDS = 1000;
/** How many games the page's 最近对局 list shows. */
export const RECENT_SHOW = 20;

const FULL_KEY = `sp.pref.${STATS_PREF_KEY}`;

/** @returns {{ v: number, records: Array }} a fresh empty envelope */
export const emptyStats = () => ({ v: STATS_VERSION, records: [] });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v, d) => (Number.isFinite(v) ? Math.round(v) : d);
const num = (v) => (Number.isFinite(v) ? v : null);
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);
const str = (v) => (typeof v === 'string' && v.length ? v : null);

/**
 * Copy only the finite numeric keys of a stats block (the settlement's numbers; unknown numeric fields are
 * kept too — display can lag, data must not).
 * @param {any} raw
 * @returns {Record<string, number>}
 */
function normalizeStatBlock(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v)) out[k] = v;
  return out;
}

/**
 * FNV-1a 32-bit, hex — a content hash needs no crypto, only stability across sessions.
 * @param {string} s
 * @returns {string}
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The record's dedupe id, from match facts the server replays byte-identically on reconnect / reload
 * (server/lobby.js result replay): seed + duration + mode + rounds + outcome + who I was. Two distinct
 * matches colliding on all of these is not a real scenario; a replayed m.result hits the same id and is
 * dropped, which is the point (recording happens on every m.result arrival, replays included).
 * @param {any} res raw m.result payload
 * @param {string|null|undefined} myId the local player's id at that moment
 * @returns {string}
 */
export function recordId(res, myId) {
  const r = isObj(res) ? res : {};
  return `r1.${fnv1a([r.seed ?? '-', r.durationMs ?? '-', r.modeId ?? '-', r.roundsPassed ?? '-', r.victory ? 1 : 0, myId ?? '-'].join('|'))}`;
}

/**
 * Normalize ONE player row: known fields defaulted, unknown fields preserved (forward compat).
 * @param {any} raw
 * @returns {any}
 */
function normalizePlayerRow(raw) {
  const p = isObj(raw) ? raw : {};
  const title = isObj(p.title)
    ? { id: str(p.title.id) || '', name: str(p.title.name) || '', picId: str(p.title.picId) || '', text: str(p.title.text) || '' }
    : null;
  const lineup = (Array.isArray(p.lineup) ? p.lineup : []).filter(isObj).slice(0, 12).map((u) => ({
    // ids only — the tile position (row/col) is replay detail, not a statistic; items kept (配发装备统计)
    id: str(u.id) || '', golden: bool(u.golden), tier: int(u.tier, 0),
    items: (Array.isArray(u.items) ? u.items : []).filter((i) => typeof i === 'string' && i.length),
  })).filter((u) => u.id);
  const bonds = (Array.isArray(p.bonds) ? p.bonds : []).filter(isObj).map((b) => ({
    bondId: str(b.bondId) || str(b.id) || '', layers: int(b.layers, 0), active: bool(b.active),
  })).filter((b) => b.bondId);
  return {
    ...p, // unknown / future fields pass through untouched
    playerId: str(p.playerId) || '',
    seat: int(p.seat, 0),
    name: str(p.name) || t('博士'),
    isBot: bool(p.isBot),
    left: bool(p.left),
    alive: bool(p.alive, true),
    victory: bool(p.victory), // server semantics: team won AND this player was still in at the end
    roundsPassed: int(p.roundsPassed, 0),
    eliminatedRound: num(p.eliminatedRound),
    lp: num(p.lp),
    bandId: str(p.bandId),
    title,
    trophies: int(p.trophies, 0),
    reward: int(p.reward, 0),
    lineup,
    bonds,
    stats: normalizeStatBlock(p.stats),
  };
}

/**
 * Normalize ONE match record to the current shape. Missing fields get defaults; unknown fields (a newer
 * writer's additions) survive untouched, so import → export does not lose them.
 * @param {any} raw
 * @returns {any|null} null when the row is not salvageable (no players array at all)
 */
export function normalizeRecord(raw) {
  const r = isObj(raw) ? raw : {};
  // same rule as buildRecord: a record IS a played match — no usable players array, no record
  if (!Array.isArray(r.players) || !r.players.length) return null;
  const base = {
    id: str(r.id) || '',
    v: STATS_VERSION,
    t: int(r.t, 0),
    victory: bool(r.victory),
    roundsPassed: int(r.roundsPassed, 0),
    lastRound: num(r.lastRound),
    hiddenReached: bool(r.hiddenReached),
    hiddenCleared: bool(r.hiddenCleared),
    reason: str(r.reason),
    modeId: str(r.modeId),
    difficulty: str(r.difficulty),
    stageId: str(r.stageId),
    bossId: str(r.bossId),
    hiddenBossId: str(r.hiddenBossId),
    seed: num(r.seed),
    durationMs: num(r.durationMs),
    teamLp: num(r.teamLp),
    roomMode: r.roomMode === 'solo' || r.roomMode === 'coop' ? r.roomMode : null,
    selfId: str(r.selfId),
    players: r.players.filter(isObj).map(normalizePlayerRow),
  };
  return { ...r, ...base };
}

/**
 * The MIGRATIONS chain: `MIGRATIONS[v]` upgrades a v-envelope to v+1, for v = STATS_VERSION and down.
 * Empty at v1 — the steps exist so the next format change lands as one function here and every stored /
 * imported envelope walks the whole chain.
 * @type {Record<number, (stats: any) => any>}
 */
export const MIGRATIONS = {};

/**
 * Bring any stored / imported envelope to the current version.
 * @param {any} raw
 * @returns {{ stats: { v: number, records: any[] }, changed: boolean, newer: boolean }}
 *   `newer` = the data was written by a NEWER build: returned untouched, callers must not save over it.
 */
export function migrateStats(raw) {
  if (!isObj(raw) || !Array.isArray(raw.records)) return { stats: emptyStats(), changed: false, newer: false };
  if ((raw.v ?? 0) > STATS_VERSION) {
    return { stats: { v: raw.v, records: raw.records }, changed: false, newer: true };
  }
  let v = raw.v ?? 0;
  let records = raw.records;
  let changed = v !== STATS_VERSION;
  while (v < STATS_VERSION) {
    const step = MIGRATIONS[v];
    if (typeof step === 'function') records = step({ v, records }).records;
    v++;
  }
  const normalized = [];
  for (const r of records) {
    const rec = normalizeRecord(r);
    if (rec) normalized.push(rec);
  }
  changed ||= normalized.length !== records.length;
  return { stats: { v: STATS_VERSION, records: normalized }, changed, newer: false };
}

/**
 * Read + migrate the persisted envelope; self-heals older shapes back to storage.
 * @returns {{ v: number, records: any[], newer: boolean }}
 */
export function loadStats() {
  const { stats, changed, newer } = migrateStats(loadPref(STATS_PREF_KEY, null));
  if (!newer && changed) saveStats(stats);
  return { ...stats, newer };
}

/**
 * Persist the envelope. savePref swallows quota errors — here losing a record silently would do exactly
 * that, so the write reports failure and shrinks the history (oldest quarter) before retrying.
 * @param {{ v: number, records: any[] }} stats
 * @returns {boolean} whether a write stuck
 */
export function saveStats(stats) {
  const env = { v: STATS_VERSION, records: stats.records };
  try {
    globalThis.localStorage?.setItem(FULL_KEY, JSON.stringify(env));
    return true;
  } catch { /* quota — fall through to shrinking */ }
  let recs = stats.records;
  // two quarter-shrinks at most; records are newest first, so the tail (oldest) is what goes;
  // a small history that still does not fit is foreign quota pressure — giving up beats gradually erasing it
  for (let i = 0; i < 2 && recs.length > 8; i++) {
    recs = recs.slice(0, recs.length - Math.ceil(recs.length / 4));
    try {
      globalThis.localStorage?.setItem(FULL_KEY, JSON.stringify({ v: STATS_VERSION, records: recs }));
      return true;
    } catch { /* keep shrinking */ }
  }
  return false;
}

/**
 * Derive the room shape ('solo' | 'coop') the way constants.js modeIdFor builds modeIds.
 * @param {string|null|undefined} modeId
 * @param {string|null|undefined} roomMode room.state `mode` when known
 * @returns {'solo'|'coop'|null}
 */
export function roomModeOf(modeId, roomMode) {
  if (roomMode === 'solo' || roomMode === 'coop') return roomMode;
  if (typeof modeId !== 'string') return null;
  if (modeId.includes('_single_')) return 'solo';
  if (modeId.includes('_multi_')) return 'coop';
  return null;
}

/**
 * Build one record from a raw m.result payload (+ context). Null when there is nothing to store: payloads
 * without players (the error-path settlement) or matches the local player did not take part in (spectator
 * seats get every result pushed too — eliminated players, who ARE in players[], keep recording).
 * @param {any} res raw m.result payload
 * @param {{ myId?: string|null, roomMode?: string|null, now?: number }} ctx
 * @returns {any|null}
 */
export function buildRecord(res, ctx = {}) {
  const r = isObj(res) ? res : {};
  if (!Array.isArray(r.players) || !r.players.length) return null;
  const myId = str(ctx.myId);
  const selfRow = r.players.find((p) => isObj(p) && p.playerId === myId);
  if (!selfRow) return null; // spectator / observer: not my match
  const rec = normalizeRecord({
    v: STATS_VERSION,
    t: int(ctx.now, 0),
    id: recordId(r, myId),
    victory: bool(r.victory),
    roundsPassed: int(r.roundsPassed, 0),
    lastRound: num(r.lastRound),
    hiddenReached: bool(r.hiddenReached),
    hiddenCleared: bool(r.hiddenCleared),
    reason: str(r.reason),
    modeId: str(r.modeId),
    difficulty: str(r.difficulty),
    stageId: str(r.stageId),
    bossId: str(r.bossId),
    hiddenBossId: str(r.hiddenBossId),
    seed: num(r.seed),
    durationMs: num(r.durationMs),
    teamLp: num(r.teamLp),
    roomMode: roomModeOf(str(r.modeId), ctx.roomMode),
    selfId: myId,
    players: r.players,
  });
  return rec;
}

/**
 * The m.result-shaped payload behind a record — the inverse of buildRecord. The stats page's 最近对局
 * rows hand this to the settlement screen (screens/result.js reads store.match.result through
 * normalizeResult): a finished match can be RE-VIEWED because the record kept every field the payload
 * had. Whatever a record never stored (older / hand-made rows) is simply absent and normalizeResult
 * defaults it, exactly like a tolerant live payload.
 * @param {any} rec
 * @returns {any|null} null when the row is not a usable record
 */
export function recordToResult(rec) {
  const r = normalizeRecord(rec);
  if (!r) return null;
  const res = {
    victory: r.victory,
    roundsPassed: r.roundsPassed,
    hiddenReached: r.hiddenReached,
    hiddenCleared: r.hiddenCleared,
    reason: r.reason,
    modeId: r.modeId,
    difficulty: r.difficulty,
    bossId: r.bossId,
    hiddenBossId: r.hiddenBossId,
    seed: r.seed,
    durationMs: r.durationMs,
    teamLp: r.teamLp,
    players: r.players,
  };
  if (Number.isFinite(r.lastRound)) res.lastRound = r.lastRound;
  return res;
}

/**
 * Append one record: replays (same content id) are dropped, newest first, capped at MAX_RECORDS.
 * @param {{ v: number, records: any[] }} stats
 * @param {any} record
 * @returns {{ stats: { v: number, records: any[] }, added: boolean }}
 */
export function appendRecord(stats, record) {
  if (!record || !record.id) return { stats, added: false };
  if (stats.records.some((r) => r.id === record.id)) return { stats, added: false };
  const records = [record, ...stats.records].slice(0, MAX_RECORDS);
  return { stats: { v: STATS_VERSION, records }, added: true };
}

/**
 * Record a finished match end-to-end (load → append → save). Returns the built record, or null when
 * nothing was stored (no players / not my match / replay).
 * @param {any} res raw m.result payload
 * @param {{ myId?: string|null, roomMode?: string|null, now?: number }} [ctx]
 * @returns {any|null}
 */
export function recordResult(res, ctx = {}) {
  const rec = buildRecord(res, ctx);
  if (!rec) return null;
  const stats = loadStats();
  const { stats: next, added } = appendRecord(stats, rec);
  if (added && !saveStats(next)) console.warn('[stats] localStorage write failed (quota?), record not persisted');
  return added ? rec : null;
}

/**
 * Merge two envelopes (import into existing): union by record id, chronological, capped.
 * @param {{ records: any[] }} a current (wins ties)
 * @param {{ records: any[] }} b incoming
 * @returns {{ v: number, records: any[] }}
 */
export function mergeStats(a, b) {
  const byId = new Map();
  for (const r of [...(Array.isArray(b?.records) ? b.records : []), ...(Array.isArray(a?.records) ? a.records : [])]) {
    const rec = normalizeRecord(r);
    // id-less (hand-made) rows fall back to a CONTENT hash so both copies land on the same key
    if (rec) byId.set(rec.id || `c.${fnv1a(JSON.stringify(rec))}`, rec);
  }
  const records = [...byId.values()].sort((x, y) => (x.t - y.t) || (x.id < y.id ? -1 : 1)).slice(-MAX_RECORDS);
  return { v: STATS_VERSION, records };
}

/**
 * Parse + migrate + merge an exported / pasted payload into the current data.
 * @param {any} raw parsed JSON of the imported file
 * @param {{ records: any[] }} current current envelope
 * @returns {{ stats: { v: number, records: any[] }, added: number, skipped: number }}
 */
export function importStats(raw, current) {
  const { stats: incoming, newer } = migrateStats(raw);
  if (newer) {
    const err = new Error('该文件由更新版本的客户端导出，请先升级后再导入');
    err.code = 'stats-newer-version';
    throw err;
  }
  const merged = mergeStats(current, incoming);
  const added = merged.records.length - (Array.isArray(current?.records) ? current.records.length : 0);
  return { stats: merged, added: Math.max(0, added), skipped: incoming.records.length - Math.max(0, added) };
}

/**
 * The payload the export button downloads (envelope + a little provenance).
 * @param {{ records: any[] }} stats
 * @returns {{ app: string, kind: string, v: number, exportedAt: string, records: any[] }}
 */
export function exportStats(stats) {
  return {
    app: 'stronghold-protocol',
    kind: 'local-stats',
    v: STATS_VERSION,
    exportedAt: new Date().toISOString(),
    records: Array.isArray(stats?.records) ? stats.records : [],
  };
}

// ---- aggregation (what the page shows; records may hold more than any view uses) ------------------------

const SELF_STATS = ['dmgDealt', 'kills', 'bossDamage', 'activatedLayers', 'merges', 'itemsEquipped', 'gold', 'perfectRounds', 'refreshes', 'leaks', 'lpLost'];

/**
 * The row that "is me" in a record: selfId, else the only human, else seat 0 — records written by
 * recordResult always have selfId; the fallbacks only serve imported / hand-made data.
 * @param {any} rec
 * @returns {any|null}
 */
export function selfRowOf(rec) {
  const ps = Array.isArray(rec?.players) ? rec.players : [];
  return ps.find((p) => p.playerId && p.playerId === rec.selfId)
    || ps.find((p) => !p.isBot)
    || ps[0]
    || null;
}

/** Whether this record counts as a win for its self player (per-row victory = team won AND still in). */
const selfWon = (rec, self) => (self ? !!self.victory : !!rec.victory);

/**
 * Aggregate records for the stats page. Everything is keyed by ids (bandId / titleId / difficulty); the
 * page maps them to names and icons through the game data.
 * @param {any[]} records
 * @returns {any}
 */
export function aggregateStats(records) {
  const rs = Array.isArray(records) ? records : [];
  const out = {
    count: rs.length, wins: 0,
    rounds: { total: 0, max: 0 },
    duration: { totalMs: 0 },
    hidden: { reached: 0, cleared: 0 },
    byDifficulty: {}, byMode: { solo: 0, coop: 0 },
    titles: {}, bands: {}, sums: {},
  };
  for (const rec of rs) {
    const self = selfRowOf(rec);
    const won = selfWon(rec, self);
    if (won) out.wins++;
    out.rounds.total += int(rec.roundsPassed, 0);
    out.rounds.max = Math.max(out.rounds.max, int(rec.roundsPassed, 0));
    out.duration.totalMs += num(rec.durationMs) || 0;
    if (rec.hiddenReached) out.hidden.reached++;
    if (rec.hiddenCleared) out.hidden.cleared++;

    const d = rec.difficulty || t('未知');
    const bd = (out.byDifficulty[d] ||= { games: 0, wins: 0, hiddenCleared: 0 });
    bd.games++;
    if (won) bd.wins++;
    if (rec.hiddenCleared) bd.hiddenCleared++;

    if (rec.roomMode === 'solo' || rec.roomMode === 'coop') out.byMode[rec.roomMode]++;

    const titleId = self?.title?.id;
    if (titleId) {
      const t = (out.titles[titleId] ||= { count: 0 });
      t.count++;
    }

    const bandId = self?.bandId;
    if (bandId) {
      const b = (out.bands[bandId] ||= { games: 0, wins: 0 });
      b.games++;
      if (won) b.wins++;
    }

    if (self && isObj(self.stats)) {
      for (const k of SELF_STATS) {
        const v = self.stats[k];
        if (Number.isFinite(v)) out.sums[k] = (out.sums[k] || 0) + v;
      }
    }
  }
  return out;
}
