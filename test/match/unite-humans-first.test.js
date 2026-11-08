// test/match/unite-humans-first.test.js — AI 联防置后（移植自 Stardust fork rel29 test/match/unite-humans-first.test.js，
// 按本仓的 experimental 选项面与 harness 适配）: the room's experimental `uniteHumansFirst` ranks every human before any
// seat the engine plays (an AI teammate, AI 托管) when the 联防 helpers are chosen and ordered (server/match/unite.js
// helperOrder); the usual order applies within each side. Off, the order is the old one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperOrder } from '../../server/match/unite.js';
import { isExperimental, experimentalOptions, experimentalKey, sameExperimental, experimentalRuleChanged, isUniteHumansFirst } from '../../shared/experimental.js';
import { uniteHumansOption, uniteHumansExperimental } from '../../public/js/screens/room.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { makeMatch } from './harness.js';

const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
/** A perfect player as helperStats reads it: `units` operators on the board, no bond. */
const seat = (playerId, s, units, engine = false) => {
  const board = new Map();
  for (let i = 0; i < units; i++) board.set(`${i},0`, { kind: 'chess', uid: i + 1 });
  return { playerId, seat: s, board, deployCount: units, bonds: {}, layers: {}, pendingLayerGains: null, botControlled: engine };
};
const M = (on) => ({ gd: { unite: { maxHelpers: 2 } }, uniteHumansFirst: on });
const ids = (list) => list.map((p) => p.playerId);

test('helpers: off, the usual order picks the AI with more units; on, every human comes first', () => {
  const ai = seat('ai_0', 0, 9, true), takeover = seat('p_away', 1, 8, true), a = seat('p_a', 2, 6), b = seat('p_b', 3, 5);
  const perfects = [ai, takeover, a, b];
  assert.deepEqual(ids(helperOrder(M(false), perfects, new Map())), ['ai_0', 'p_away']);
  assert.deepEqual(ids(helperOrder(M(true), perfects, new Map())), ['p_a', 'p_b'], 'two humans: both, by units');
  // one human: the human, then the best of the engine's seats; the human meets the enemies first (the pair's order too)
  assert.deepEqual(ids(helperOrder(M(true), [ai, takeover, b], new Map())), ['p_b', 'ai_0']);
  assert.deepEqual(ids(helperOrder(M(true), [ai, takeover], new Map())), ['ai_0', 'p_away'], 'no human: the usual order');
  assert.deepEqual(ids(helperOrder(M(false), [ai, b], new Map())), ['ai_0', 'p_b']);
});

test('the option: optional key, absent when off; its own matchmaking key; a rule change', () => {
  assert.equal(isExperimental(rules({ uniteHumansFirst: true })), true);
  for (const bad of ['true', 1, null]) assert.equal(isExperimental(rules({ uniteHumansFirst: bad })), false, String(bad));
  assert.deepEqual(experimentalOptions(rules({ uniteHumansFirst: true })), rules({ uniteHumansFirst: true }));
  assert.deepEqual(experimentalOptions(rules({ uniteHumansFirst: false })), rules());
  assert.notEqual(experimentalKey(rules({ uniteHumansFirst: true })), experimentalKey(rules()));
  assert.equal(sameExperimental(rules({ uniteHumansFirst: true }), rules()), false);
  assert.equal(experimentalRuleChanged(experimentalOptions(rules({ uniteHumansFirst: true }))), true);
  assert.equal(isUniteHumansFirst(rules({ uniteHumansFirst: true })), true);
  assert.equal(isUniteHumansFirst(rules()), false);
  // every option at once still fits the key bound
  assert.equal(isExperimental(rules({ playerCapacity: 8, disableDuckLord: true, uniteHumansFirst: true })), true);
});

test('client: the ⚙ 同盟设置 switch (private co-op rooms, the host only) and its option set', () => {
  const roomOf = (exp, extra = {}) => ({ mode: 'coop', hostId: 'p0', code: 'ABCD12', source: 'private', inMatch: false, seats: [], experimental: exp, ...extra });
  assert.deepEqual(uniteHumansOption(roomOf(rules()), 'p0'), { on: false, editable: true });
  assert.deepEqual(uniteHumansOption(roomOf(rules({ uniteHumansFirst: true })), 'p0'), { on: true, editable: true });
  assert.deepEqual(uniteHumansOption(roomOf(rules()), 'p1'), { on: false, editable: false }, 'not the host: read-only');
  assert.equal(uniteHumansOption({ ...roomOf(rules()), mode: 'solo' }, 'p0'), null, 'no 联防 in a solo room');
  assert.equal(uniteHumansOption({ ...roomOf(rules()), source: 'matchmaking' }, 'p0'), null, 'a matchmade room keeps its rules');
  assert.equal(uniteHumansOption({ ...roomOf(rules()), inMatch: true }, 'p0').editable, false, 'no change mid-match');
  // the sender keeps the other options and the shared shape
  assert.deepEqual(uniteHumansExperimental(true, rules()), { ...rules(), uniteHumansFirst: true });
  assert.deepEqual(uniteHumansExperimental(false, rules({ uniteHumansFirst: true })), rules());
  const cap8 = { ...rules(), playerCapacity: 8, disableDuckLord: true };
  assert.deepEqual(uniteHumansExperimental(true, cap8), { ...cap8, uniteHumansFirst: true });
  assert.deepEqual(uniteHumansExperimental(false, { ...cap8, uniteHumansFirst: true }), cap8);
  assert.equal(isExperimental(uniteHumansExperimental(true, cap8)), true);
  assert.equal(isExperimental(uniteHumansExperimental(false, rules({ uniteHumansFirst: true }))), true);
});

test('the match reads it, and a checkpoint restore keeps it', (t) => {
  // humans only: a checkpoint waits in prep for AI seats to be ready (snapshot.js canSnapshot)
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 91, fake: true, experimental: rules({ uniteHumansFirst: true }) }).start();
  t.after(() => h.m.dispose());
  assert.equal(h.m.uniteHumansFirst, true);
  h.toPrep(1);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.ok(doc, 'checkpoint taken');
  // the checkpoint does not carry experimental (a transient: the room re-supplies it at the restore's construction,
  // server/lobby.js startMatchWith) — the restored instance reads the same rules from its own options
  const r = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: doc.seed, experimental: rules({ uniteHumansFirst: true }) });
  t.after(() => r.m.dispose());
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: { warn() {} } }), true);
  assert.equal(r.m.uniteHumansFirst, true);
  const off = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 91, fake: true }).start();
  t.after(() => off.m.dispose());
  assert.equal(off.m.uniteHumansFirst, false);
});
