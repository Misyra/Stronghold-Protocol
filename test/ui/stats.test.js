// Unit tests (Node) for the 本机对局统计 record store (public/js/ui/stats.js):
//   record building from a raw m.result (spectator copies and player-less error results build nothing),
//   replay dedupe by content id (the lobby re-pushes m.result on reconnect / reload),
//   the MAX_RECORDS cap, migration / normalization (old + partial + unknown fields preserved, newer refused),
//   import merge semantics and the aggregate the stats page renders.
// localStorage is faked per test (Node has none); recordResult / loadStats / saveStats go through it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATS_VERSION, MAX_RECORDS, emptyStats, buildRecord, recordId, appendRecord, recordResult,
  loadStats, saveStats, migrateStats, normalizeRecord, mergeStats, importStats, exportStats,
  aggregateStats, selfRowOf, roomModeOf, recordToResult, MIGRATIONS,
} from '../../public/js/ui/stats.js';
import { normalizeResult } from '../../public/js/ui/gameLogic.js';

/** A realistic m.result in the shape server/match/results.js buildResult emits (replayed byte-identically). */
function baseResult(over = {}) {
  return {
    t: 'm.result',
    victory: true, roundsPassed: 15, hiddenReached: true, hiddenCleared: true, reason: 'hidden_cleared',
    teamLp: 24, modeId: 'mode_single_hard', difficulty: 'HARD', stageId: 'stage_hard', bossId: 'enemy_boss', hiddenBossId: 'enemy_hidden',
    seed: 123456789, durationMs: 952123,
    players: [
      {
        playerId: 'p1', seat: 0, name: '罗宾', isBot: false, left: false, alive: true, victory: true,
        roundsPassed: 16, eliminatedRound: null, lp: 24, bandId: 'band_amiya',
        title: { id: 'comment_1', name: '卫戍之星', picId: 'comment_icon_1', text: '对敌方领袖造成伤害最高（仅胜利时）' },
        trophies: 30, reward: 88,
        lineup: [{ id: 'char_290_vigna', golden: false, tier: 2, row: 10, col: 5, items: ['item_eq_1'] }],
        bonds: [{ bondId: 'steadShip', layers: 12, active: true }],
        stats: { dmgDealt: 15234.7, kills: 41, leaks: 2, gold: 880, refreshes: 5, merges: 6, itemsEquipped: 4, bossDamage: 5000.5, activatedLayers: 99, lpLost: 3, perfectRounds: 7 },
      },
      {
        playerId: 'p2', seat: 1, name: '队友B', isBot: false, left: false, alive: false, victory: false,
        roundsPassed: 9, eliminatedRound: 10, lp: 0, bandId: 'band_fang', title: null, trophies: 0, reward: 40,
        lineup: [], bonds: [], stats: { kills: 3 },
      },
    ],
    ...over,
  };
}

/** Fake localStorage: Map-backed, with an optional byte budget that makes setItem throw like a full quota. */
function fakeStorage({ budget = Infinity } = {}) {
  const m = new Map();
  const calls = [];
  return {
    calls,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { calls.push(v.length); if (v.length > budget) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
    get raw() { return m.get('sp.pref.stats') ?? null; },
  };
}

describe('local stats: record building', () => {
  test('builds one full record from a raw m.result (frame + players + self marking)', () => {
    const rec = buildRecord(baseResult(), { myId: 'p1', roomMode: 'solo', now: 1700000000000 });
    assert.ok(rec);
    assert.equal(rec.v, STATS_VERSION);
    assert.equal(rec.t, 1700000000000);
    assert.equal(rec.selfId, 'p1');
    assert.equal(rec.victory, true);
    assert.equal(rec.difficulty, 'HARD');
    assert.equal(rec.seed, 123456789);
    assert.equal(rec.durationMs, 952123);
    assert.equal(rec.roomMode, 'solo');
    assert.equal(rec.id, recordId(baseResult(), 'p1'));
    assert.equal(rec.players.length, 2);
    const self = rec.players[0];
    assert.equal(self.bandId, 'band_amiya');
    assert.equal(self.title.id, 'comment_1');
    assert.equal(self.stats.bossDamage, 5000.5);
    assert.deepEqual(self.lineup, [{ id: 'char_290_vigna', golden: false, tier: 2, items: ['item_eq_1'] }]);
    assert.deepEqual(self.bonds, [{ bondId: 'steadShip', layers: 12, active: true }]);
  });

  test('a spectator seat copy (my id not among players) records nothing; so do player-less error results', () => {
    assert.equal(buildRecord(baseResult(), { myId: 'spec9', now: 1 }), null);
    assert.equal(buildRecord(baseResult({ players: [] }), { myId: 'p1', now: 1 }), null);
    assert.equal(buildRecord(null, { myId: 'p1' }), null);
  });

  test('roomMode falls back to the modeId (single → solo, multi → coop, else null)', () => {
    assert.equal(roomModeOf('mode_multi_funny', null), 'coop');
    assert.equal(roomModeOf('mode_single_normal', 'coop'), 'coop'); // explicit room mode wins
    assert.equal(roomModeOf('mode_training_1', null), null);
    assert.equal(buildRecord(baseResult({ modeId: 'mode_multi_hard' }), { myId: 'p1', now: 1 }).roomMode, 'coop');
  });
});

describe('local stats: replay dedupe + cap', () => {
  test('the replayed m.result (same content) appends once; a different seed is a new game', () => {
    let stats = emptyStats();
    const res = baseResult();
    const first = appendRecord(stats, buildRecord(res, { myId: 'p1', now: 1000 }));
    assert.equal(first.added, true);
    const replay = appendRecord(first.stats, buildRecord(res, { myId: 'p1', now: 999000 }));
    assert.equal(replay.added, false); // the reload / reconnect replay
    assert.equal(replay.stats.records.length, 1);
    assert.equal(replay.stats.records[0].t, 1000); // the FIRST arrival's timestamp is kept
    const other = appendRecord(replay.stats, buildRecord(baseResult({ seed: 42, durationMs: 55555 }), { myId: 'p1', now: 2000 }));
    assert.equal(other.added, true);
    assert.equal(other.stats.records.length, 2);
    assert.equal(other.stats.records[0].id, recordId(baseResult({ seed: 42, durationMs: 55555 }), 'p1'));
  });

  test('recordResult end-to-end over faked localStorage: replay arrives, nothing is written twice', () => {
    globalThis.localStorage = fakeStorage();
    try {
      const res = baseResult();
      const rec = recordResult(res, { myId: 'p1', roomMode: 'solo', now: 1000 });
      assert.ok(rec);
      assert.equal(recordResult(res, { myId: 'p1', roomMode: 'solo', now: 2000 }), null); // replay dropped
      const loaded = loadStats();
      assert.equal(loaded.records.length, 1);
      assert.equal(loaded.records[0].id, rec.id);
    } finally { delete globalThis.localStorage; }
  });

  test(`the store caps at MAX_RECORDS (${MAX_RECORDS}), dropping the oldest`, () => {
    let stats = emptyStats();
    for (let i = 0; i < MAX_RECORDS + 30; i++) {
      stats = appendRecord(stats, buildRecord(baseResult({ seed: i }), { myId: 'p1', now: i })).stats;
    }
    assert.equal(stats.records.length, MAX_RECORDS);
    assert.equal(stats.records[0].t, MAX_RECORDS + 29); // newest first
    assert.equal(stats.records.at(-1).t, 30); // oldest 30 dropped
  });
});

describe('local stats: migration / normalization', () => {
  test('an unversioned envelope (older shape) normalizes with defaults and self-heals on load', () => {
    globalThis.localStorage = fakeStorage();
    try {
      const old = { records: [{ players: [{ playerId: 'p1', stats: { kills: 2 }, futureField: { x: 1 } }] }] };
      globalThis.localStorage.setItem('sp.pref.stats', JSON.stringify(old));
      const loaded = loadStats();
      assert.equal(loaded.v, STATS_VERSION);
      assert.equal(loaded.records.length, 1);
      const rec = loaded.records[0];
      assert.equal(rec.victory, false);
      assert.equal(rec.roundsPassed, 0);
      assert.equal(rec.selfId, null);
      assert.equal(rec.players[0].roundsPassed, 0);
      assert.equal(rec.players[0].alive, true);
      assert.deepEqual(rec.players[0].stats, { kills: 2 });
      assert.deepEqual(rec.players[0].futureField, { x: 1 }); // unknown fields survive for a newer reader
      const rewritten = JSON.parse(globalThis.localStorage.getItem('sp.pref.stats'));
      assert.ok(rewritten);
      assert.equal(rewritten.v, STATS_VERSION); // self-healed back to storage
    } finally { delete globalThis.localStorage; }
  });

  test('broken records are dropped; a NEWER envelope is returned untouched and flagged (never saved over)', () => {
    globalThis.localStorage = fakeStorage();
    try {
      globalThis.localStorage.setItem('sp.pref.stats', JSON.stringify({ v: STATS_VERSION, records: [null, { nope: 1 }, { players: [] }, baseResult()] }));
      // baseResult is an m.result (players present) → normalizes into a record; the rest are dropped
      const loaded = loadStats();
      assert.equal(loaded.records.length, 1);

      const newer = { v: STATS_VERSION + 5, records: [{ players: [], brandNew: true }] };
      const mig = migrateStats(newer);
      assert.equal(mig.newer, true);
      assert.equal(mig.changed, false);
      assert.deepEqual(mig.stats, { v: STATS_VERSION + 5, records: newer.records });
      assert.equal(loadStats().newer, false);
    } finally { delete globalThis.localStorage; }
  });

  test('the MIGRATIONS hook runs: v → v+1 steps apply in order (dry-run with a temporary step)', () => {
    const original = MIGRATIONS[0];
    MIGRATIONS[0] = ({ records }) => ({ v: 1, records: records.map((r) => ({ ...r, migrated: true })) });
    try {
      const { stats, changed } = migrateStats({ v: 0, records: [{ players: [{ playerId: 'p1' }] }] });
      assert.equal(changed, true);
      assert.equal(stats.records[0].migrated, true);
      assert.equal(stats.v, STATS_VERSION);
    } finally {
      if (original === undefined) delete MIGRATIONS[0]; else MIGRATIONS[0] = original;
    }
  });

  test('saveStats shrinks the history when the quota rejects the full write', () => {
    // budget fits ~35 records but not 60: the full write throws, two quarter-shrinks land at 33
    const probe = JSON.stringify({ v: STATS_VERSION, records: [baseResult()] });
    globalThis.localStorage = fakeStorage({ budget: probe.length * 35 });
    try {
      let stats = emptyStats();
      for (let i = 0; i < 60; i++) stats = appendRecord(stats, buildRecord(baseResult({ seed: i }), { myId: 'p1', now: i })).stats;
      assert.equal(saveStats(stats), true);
      const back = JSON.parse(globalThis.localStorage.getItem('sp.pref.stats'));
      assert.ok(back.records.length < 60 && back.records.length > 8); // shrank instead of failing
      assert.equal(back.records[0].t, 59); // newest kept, oldest dropped
    } finally { delete globalThis.localStorage; }
  });
});

describe('local stats: export / import merge', () => {
  test('export → import round-trips; merge unions by id and counts added / skipped', () => {
    globalThis.localStorage = fakeStorage();
    try {
      const rec = recordResult(baseResult(), { myId: 'p1', now: 1000 });
      const exported = exportStats(loadStats());
      assert.equal(exported.kind, 'local-stats');
      assert.equal(exported.records.length, 1);
      assert.equal(exported.records[0].id, rec.id);

      // importing into the SAME store: everything is a duplicate
      const same = importStats(exported, loadStats());
      assert.equal(same.added, 0);
      assert.equal(same.skipped, 1);
      assert.equal(same.stats.records.length, 1);

      // a second device's store (one shared + one new record) merges by id
      const theirs = exportStats({ records: [rec, buildRecord(baseResult({ seed: 777 }), { myId: 'p1', now: 5000 })] });
      const merged = importStats(theirs, loadStats());
      assert.equal(merged.added, 1);
      assert.equal(merged.stats.records.length, 2);
      assert.equal(merged.stats.records[0].t, 1000); // chronological
      saveStats(merged.stats);
      assert.equal(loadStats().records.length, 2);
    } finally { delete globalThis.localStorage; }
  });

  test('importing a NEWER export refuses with a clear error instead of downgrading', () => {
    assert.throws(() => importStats({ v: STATS_VERSION + 1, records: [] }, emptyStats()), (e) => e.code === 'stats-newer-version');
  });

  test('garbage import is an ordinary empty envelope, not a crash in merge', () => {
    const out = importStats({ hello: 'world' }, emptyStats());
    assert.equal(out.added, 0);
    assert.equal(out.stats.records.length, 0);
  });
});

describe('local stats: aggregation (what the page renders)', () => {
  const records = [
    buildRecord(baseResult(), { myId: 'p1', roomMode: 'solo', now: 1000 }),
    buildRecord(baseResult({ victory: false, roundsPassed: 8, hiddenReached: false, hiddenCleared: false, difficulty: 'NORMAL', modeId: 'mode_multi_normal', durationMs: 300000, seed: 2,
      players: [
        { ...baseResult().players[0], alive: true, victory: false, roundsPassed: 8, title: null, stats: { kills: 10, gold: 200 } },
        baseResult().players[1],
      ] }), { myId: 'p1', roomMode: 'coop', now: 2000 }),
  ];
  const agg = aggregateStats(records);

  test('totals, wins (per-row victory), rounds and duration', () => {
    assert.equal(agg.count, 2);
    assert.equal(agg.wins, 1); // game 2 was a loss
    assert.equal(agg.rounds.max, 15);
    assert.equal(agg.rounds.total, 23);
    assert.equal(agg.duration.totalMs, 952123 + 300000);
    assert.equal(agg.hidden.reached, 1);
    assert.equal(agg.hidden.cleared, 1);
    assert.equal(agg.byMode.solo, 1);
    assert.equal(agg.byMode.coop, 1);
  });

  test('per-difficulty rows', () => {
    assert.deepEqual(agg.byDifficulty.HARD, { games: 1, wins: 1, hiddenCleared: 1 });
    assert.deepEqual(agg.byDifficulty.NORMAL, { games: 1, wins: 0, hiddenCleared: 0 });
  });

  test('per-band games / passed and self titles', () => {
    assert.deepEqual(agg.bands.band_amiya, { games: 2, wins: 1 });
    assert.equal(agg.titles.comment_1.count, 1); // only the win granted 卫戍之星
  });

  test('combat sums over the self player only', () => {
    assert.equal(agg.sums.kills, 41 + 10);
    assert.equal(agg.sums.gold, 880 + 200);
    assert.equal(agg.sums.leaks, 2); // game 2's self row has no leaks → skipped, not NaN
  });

  test('selfRowOf fallbacks: selfId, else first human, else first row; anonymous record → null', () => {
    assert.equal(selfRowOf(records[0]).playerId, 'p1');
    const noSelf = normalizeRecord({ players: [{ playerId: 'a', isBot: true }, { playerId: 'b', isBot: false }] });
    assert.equal(selfRowOf(noSelf).playerId, 'b');
    assert.equal(selfRowOf({ players: [] }), null);
  });
});

describe('local stats: recordToResult (最近对局行 → 结算页回看)', () => {
  test('record → m.result payload → normalizeResult renders the same settlement the live push did', () => {
    const rec = buildRecord(baseResult(), { myId: 'p1', roomMode: 'solo', now: 1000 });
    const res = recordToResult(rec);
    assert.ok(res);
    const view = normalizeResult(res, null);
    assert.equal(view.victory, true);
    assert.equal(view.difficulty, 'HARD');
    assert.equal(view.modeId, 'mode_single_hard');
    assert.equal(view.roundsPassed, 15);
    assert.equal(view.hiddenReached, true);
    assert.equal(view.hiddenCleared, true);
    assert.equal(view.durationMs, 952123);
    assert.equal(view.players.length, 2);
    const self = view.players.find((p) => p.playerId === 'p1');
    assert.equal(self.bandId, 'band_amiya');
    assert.equal(self.title.id, 'comment_1');
    assert.equal(self.stats.kills, 41);
    assert.equal(self.stats.bossDamage, 5000.5);
    assert.equal(self.lineup[0].id, 'char_290_vigna');
    assert.equal(self.lineup[0].golden, false);
    const mate = view.players.find((p) => p.playerId === 'p2');
    assert.equal(mate.alive, false);
    assert.equal(mate.roundsPassed, 9);
  });

  test('a null lastRound is passed through as absent (normalizeResult defaults it); garbage → null', () => {
    const rec = buildRecord(baseResult({ lastRound: undefined }), { myId: 'p1', now: 1 });
    assert.equal('lastRound' in recordToResult(rec), false);
    assert.equal(recordToResult(null), null);
    assert.equal(recordToResult({ players: [] }), null);
  });
});
