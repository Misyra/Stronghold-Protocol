// GitHub #839 鸭爵 「神秘顾客」 「每回合将有0~2名敌人被替换」 (PRTS 卫戍协议：盟约 下半/PRTS盟约记录; effect key
// round_start_all_player_change_enemy_2): one draw per round for every player — the same count, the same units — from the
// round's own wave, whatever bounties each player carries (they are inserted per player and re-time their host action's
// own units: waves.js withBounties); only lower-lane units; the swapped-in kind one per player and round (the reporter's
// recordings of 2026-10-23: 2鼠 / 2狗 / 2鼠 / 2鸭, all on the lower lane). server/sim/content/bands/meta.js duckPicks /
// applyDuckPicks. 「允许重复策略」 (bandDupes) can seat several holders: each held band then runs its own judgment —
// judgment 1 from `duck:<round>`, judgment n from `duck:<round>#n` — so n holders allow up to n·2 swaps per wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA } from './harness.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { applyDuckPicks, duckPicks, duckReplace } from '../../server/sim/content/bands/meta.js';
import { gateOf } from '../../shared/constants.js';

const REG = createRegistry({ log: { warn() {}, error() {}, info() {} } });
const BOUNTY = DATA.choices.cards.bounty.filter((c) => c.payout === 'kill' && c.enemyKey && DATA.enemies[c.enemyKey]?.stats?.motion !== 'FLY');

const swapsOf = (spawns) => spawns.filter((s) => s.tag === 'duck').map((s) => `${s.actionIndex}:${s.routeIndex}`).sort();
const kindsOf = (spawns) => [...new Set(spawns.filter((s) => s.tag === 'duck').map((s) => s.enemyKey))];
const ownCount = (spawns) => spawns.filter((s) => s.tag !== 'bounty').reduce((n, s) => n + (s.count || 1), 0);

test('#839 同盟: the four players get the same 鸭爵 swaps each round (count, units) on the lower lane, one kind each, with different bounties', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 839, registry: REG, fake: true }).start();
  h.toPrep(6);
  const m = h.m;
  const ps = m.alivePlayers();
  assert.equal(ps.length, 4);
  ps[0].bandId = 'band_ducklord'; // one holder: the swap reaches every teammate
  // different bounties per player: none, one, two, three walker cards
  ps.forEach((p, i) => { p.bounties = BOUNTY.slice(i, 2 * i).map((card, j) => ({ id: `t${i}${j}`, card, roundsLeft: 1, chooser: p.playerId })); });
  assert.deepEqual(ps.map((p) => p.bounties.length), [0, 1, 2, 3]);
  const seed0 = m.seed;
  let swapped = 0, retimed = 0, mixed = 0;
  const hist = [0, 0, 0];
  const routes = m.wave.routes;
  for (let k = 0; k < 60; k++) {
    m.seed = seed0 + k; // another match seed: another round draw
    const lists = ps.map((p) => m._normalOpts(p).spawns);
    const want = swapsOf(lists[0]);
    hist[want.length]++;
    swapped += want.length;
    for (let i = 1; i < 4; i++) assert.deepEqual(swapsOf(lists[i]), want, `player ${i} draw ${k}`);
    // one kind per player (two swaps are the same enemy); the players' kinds are drawn apart
    const kinds = lists.map(kindsOf);
    for (const ks of kinds) assert.ok(ks.length <= 1, `one kind per player: ${ks}`);
    if (want.length && new Set(kinds.map((ks) => ks[0])).size > 1) mixed++;
    for (const l of lists) for (const d of l.filter((s) => s.tag === 'duck')) assert.equal(gateOf(routes[d.routeIndex].start, false), 'lower', 'lower lane');
    for (const l of lists) assert.equal(ownCount(l), ownCount(lists[0]), 'same own enemy count');
    for (const l of lists) for (const d of l.filter((s) => s.tag === 'duck')) assert.deepEqual(d.bounty, { coins: 1, ownerPlayerId: l[0].ownerPlayerId });
    // the preview (stats preview / bot rehearsal path) sees the same swaps and consumes no match stream
    const meta = m.rngMeta.state();
    const pv = m._normalOpts(ps[2], { preview: true }).spawns;
    assert.deepEqual(swapsOf(pv), want, 'preview');
    assert.deepEqual(kindsOf(pv), kinds[2], 'preview: the same kind');
    assert.equal(m.rngMeta.state(), meta);
    const times = lists.map((l) => l.filter((s) => s.tag === 'duck').map((s) => s.time).sort().join());
    if (new Set(times).size > 1) retimed++;
  }
  m.seed = seed0;
  assert.ok(hist.every((n) => n > 0), `0, 1 and 2 swaps all occur: ${hist}`);
  assert.ok(swapped > 0);
  assert.ok(mixed > 0, 'players draw different kinds in some rounds');
  assert.ok(retimed > 0, 'some swapped unit sits in an action the bounties re-time (each player keeps its own time)');
  m.dispose();
});

test('#839 「允许重复策略」: every holder runs its own judgment — up to 8 swaps with four, the picks shared, the kind per player and judgment', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 839, registry: REG, fake: true }).start();
  h.toPrep(6);
  const m = h.m;
  const ps = m.alivePlayers();
  assert.equal(ps.length, 4);
  ps.forEach((p, i) => {
    p.bounties = BOUNTY.slice(i, 2 * i).map((card, j) => ({ id: `t${i}${j}`, card, roundsLeft: 1, chooser: p.playerId }));
    p.bandId = 'band_ducklord';
  });
  const seed0 = m.seed;
  // the position across players is the action and route (each player keeps its own bounty-re-timed time, #839); the
  // time joins the tuple only where the same player's lists are compared (the single-holder subset, the preview)
  const posOf = (spawns) => spawns.filter((s) => s.tag === 'duck').map((s) => `${s.actionIndex}:${s.routeIndex}`).sort();
  const tuplesOf = (spawns) => spawns.filter((s) => s.tag === 'duck').map((s) => `${s.actionIndex}:${s.routeIndex}:${s.time}`).sort();
  const kindsOf = (spawns) => [...new Set(spawns.filter((s) => s.tag === 'duck').map((s) => s.enemyKey))].sort().join();
  let max = 0, mixed = 0;
  for (let k = 0; k < 120; k++) {
    m.seed = seed0 + k;
    // four holders for the round (plus the preview, read with the same bands), then the same round with one
    // (ps[0]; the others hold 华法琳, whose only effect is prep-time)
    ps.forEach((p) => { p.bandId = 'band_ducklord'; });
    const four = ps.map((p) => m._normalOpts(p).spawns);
    const meta0 = m.rngMeta.state();
    const previews = ps.map((p) => m._normalOpts(p, { preview: true }).spawns);
    assert.equal(m.rngMeta.state(), meta0, 'the previews consume no match stream');
    ps.forEach((p, i) => { if (i) p.bandId = 'band_bldsk'; });
    const one = ps.map((p) => m._normalOpts(p).spawns);
    for (let i = 0; i < 4; i++) {
      const t4 = tuplesOf(four[i]);
      assert.ok(t4.length <= 8, `at most 2 per judgment: ${t4.length}`);
      max = Math.max(max, t4.length);
      if (i) assert.deepEqual(posOf(four[i]), posOf(four[0]), `player ${i} replays the same judgments, draw ${k}`);
      // judgment 1 is unchanged: the single holder's swaps are exactly some of the four holders' (no re-swapped unit)
      const left = new Map();
      for (const t of t4) left.set(t, (left.get(t) || 0) + 1);
      for (const t of tuplesOf(one[i])) {
        assert.ok((left.get(t) || 0) > 0, `judgment 1 kept: ${t} missing with four holders (draw ${k}, player ${i})`);
        left.set(t, left.get(t) - 1);
      }
      assert.ok(kindsOf(four[i]).split(',').length <= 4, `one kind per judgment: ${kindsOf(four[i])}`);
      for (const d of four[i].filter((s) => s.tag === 'duck')) assert.deepEqual(d.bounty, { coins: 1, ownerPlayerId: four[i][0].ownerPlayerId });
      assert.deepEqual(tuplesOf(previews[i]), t4, 'preview');
    }
    if (new Set(four.map((l) => kindsOf(l))).size > 1) mixed++;
  }
  m.seed = seed0;
  assert.ok(max >= 6, `four judgments stack (one gives at most 2): max ${max}`);
  assert.ok(mixed > 0, 'players draw different kinds in some rounds');
  m.dispose();
});

test('#839 applyDuckPicks finds the k-th own unit of an action across the runs a bounty split it into', () => {
  const key = Object.values(DATA.enemies).find((e) => e.rank === 'NORMAL' && e.stats.motion === 'WALK').key;
  const duck = 'enemy_2001_duckmi_2';
  // action 3: five own units, re-timed around a bounty unit into runs of 2 and 3
  const list = [
    { time: 0, enemyKey: key, routeIndex: 1, count: 2, interval: 2, actionIndex: 3 },
    { time: 5, enemyKey: 'b', routeIndex: 1, count: 1, interval: 0, actionIndex: 3, tag: 'bounty' },
    { time: 6, enemyKey: key, routeIndex: 1, count: 3, interval: 2, actionIndex: 3 },
  ];
  const out = applyDuckPicks(list, [{ action: 3, k: 3, enemyKey: duck }], 'p_1');
  assert.equal(out.length, 1);
  assert.deepEqual({ t: out[0].time, r: out[0].routeIndex, key: out[0].enemyKey, tag: out[0].tag }, { t: 8, r: 1, key: duck, tag: 'duck' });
  assert.equal(list.filter((s) => s.tag !== 'bounty').reduce((n, s) => n + (s.count || 1), 0), 5);
  const units = list.filter((s) => s.tag !== 'bounty' && s.tag !== 'duck').flatMap((s) => Array.from({ length: s.count || 1 }, (_, j) => s.time + j * (s.interval || 0)));
  assert.deepEqual(units.sort((a, b) => a - b), [0, 2, 6, 10], 'the other own units keep their times');
});

test('#839 「允许重复策略」: a later judgment\'s colliding pick lands one later, an exhausted action skips', () => {
  const key = Object.values(DATA.enemies).find((e) => e.rank === 'NORMAL' && e.stats.motion === 'WALK').key;
  const duck = 'enemy_2001_duckmi_2';
  const bear = 'enemy_2002_bearmi_2';
  // action 3: own units at 0, 2, 6, 8, 10 (the bounty at 5 never counts)
  const list = [
    { time: 0, enemyKey: key, routeIndex: 1, count: 2, interval: 2, actionIndex: 3 },
    { time: 5, enemyKey: 'b', routeIndex: 1, count: 1, interval: 0, actionIndex: 3, tag: 'bounty' },
    { time: 6, enemyKey: key, routeIndex: 1, count: 3, interval: 2, actionIndex: 3 },
  ];
  applyDuckPicks(list, [{ action: 3, k: 2, enemyKey: duck }], 'p_1'); // t6
  const out = applyDuckPicks(list, [{ action: 3, k: 2, enemyKey: bear }], 'p_1'); // the same k: t8, the next still-own unit
  assert.equal(out.length, 1);
  assert.deepEqual({ t: out[0].time, key: out[0].enemyKey }, { t: 8, key: bear });
  assert.equal(applyDuckPicks(list, [{ action: 3, k: 3, enemyKey: duck }], 'p_1').length, 0, 'only t0 / t2 / t10 own units are left: no k=3');
  assert.deepEqual(list.filter((s) => s.tag === 'duck').map((s) => s.time), [6, 8], 'both swaps stand, nothing re-swapped');
});

// The WIP four-holder path promised up to n·max swaps but silently dropped picks: applyDuckPicks renumbers k over the
// own units left after a middle unit is replaced, while judgment 2..n still drew k's from the un-compacted wave. With
// the swapped mapping a later judgment draws only from the survivors and every promised pick lands on a still-own unit.
test('#839 「允许重复策略」: a middle-unit swap no longer costs the later judgment its pick (promised == applied)', () => {
  const key = Object.values(DATA.enemies).find((e) => e.rank === 'NORMAL' && e.stats?.motion === 'WALK').key;
  const duck = 'enemy_2001_duckmi_2';
  const gd = { enemy: (k) => DATA.enemies[k] };
  const p = { ...DATA.bands.band_ducklord.buffs[0].bb, ...DATA.bands.band_ducklord.buffs[0].bbStr };
  const routes = [{ start: [9, 10], end: [1, 3] }]; // lower gate
  // action 3: six own units, k = 0..5 (the band's 0.6–0.99 weight share leaves original k=3,4 eligible). Judgment 1
  // takes the middle k=3, which leaves applyDuckPicks compacting original k=4 → compact k=3. A later judgment that
  // draws the ORIGINAL k=4 (still own, but renumbered) must still land, not silently drop.
  const wave = () => [{ time: 0, enemyKey: key, routeIndex: 1, count: 6, interval: 1, actionIndex: 3 }];
  // stateless forced draw: exactly `n` swaps, preferring the candidate with the wave's original k === `k`
  const forced = (n, k) => {
    const rng = () => 0;
    rng.int = () => n;
    rng.shuffle = (a) => { const hit = a.find((f) => f.k === k); return hit ? [hit, ...a.filter((f) => f !== hit)] : a; };
    rng.pick = () => duck;
    return { rng, typeRng: { pick: () => duck } };
  };
  const spawns = wave();
  const swapped = new Map();
  // judgment 1: 1 pick at the middle k=3 — the empty-map (first-judgment) path, unchanged. Its original k is recorded.
  const r1 = forced(1, 3);
  const out1 = duckReplace({ gd, rng: r1.rng }, spawns, p, 'p_1', { base: wave(), routes, ...r1, swapped });
  assert.equal(out1.length, 1, 'judgment 1 lands its pick');
  assert.deepEqual([...swapped.get(3)], [3], 'the middle unit is recorded by its original k');
  // judgment 2: draw the ORIGINAL k=4 (compacted to 3 by judgment 1). The swapped map drops k=3 from the pool and
  // renumbers the survivor to the compact k=3 — one promised pick, one applied pick, no loss, no double swap.
  const r2 = forced(1, 4);
  const promised = duckPicks(gd, forced(1, 4).rng, wave(), p, { routes, typeRng: r2.typeRng, swapped });
  assert.equal(promised.length, 1, 'one promised pick in judgment 2');
  assert.equal(promised[0].k, 3, 'the original k=4 renumbered to the surviving compact k=3');
  const applied = duckReplace({ gd, rng: r2.rng }, spawns, p, 'p_1', { base: wave(), routes, ...r2, swapped });
  assert.equal(applied.length, promised.length, 'promised == applied: no pick lost to the renumbering');
  assert.equal(spawns.filter((s) => s.tag === 'duck').length, 2, 'both judgments stand, no unit swapped twice');
});
