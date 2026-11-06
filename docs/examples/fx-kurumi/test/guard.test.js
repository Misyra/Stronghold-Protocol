import { test } from 'node:test';
import assert from 'node:assert/strict';

// Run with `node tools/plugin.mjs test fx-kurumi`: it installs this plugin's content and SDK registrations before this
// module (SP_PLUGIN_TEST_SET). Anywhere else — a plain `node --test` of the repository finds this file too — it skips.
const run = process.env.SP_PLUGIN_TEST_SET ? {} : { skip: 'run with node tools/plugin.mjs test <id>' };

test('fx-kurumi composes the margin band, contract items and registers its meta handler', run, async () => {
  const { getData } = await import('../../../server/data.js');
  const d = getData();
  const band = d.bands['band_x_fx_kurumi_margin'];
  assert.ok(band, 'band record present');
  assert.equal(band.totalHp, 20, 'band LP');
  assert.equal(band.effectRef, 'band_cannot', 'funds retention via band_cannot effectRef');
  assert.deepEqual(band.buffs, [], 'no interest passive of its own');
  for (const id of ['item_x_fx_kurumi_call', 'item_x_fx_kurumi_call_m',
    'item_x_fx_kurumi_put', 'item_x_fx_kurumi_put_m']) {
    const item = d.items[id];
    assert.ok(item, `${id} present`);
    assert.equal(item.shopExcluded, true, `${id} never rolls in the shop`);
    assert.equal(item.effectRef, 'chess_item_1_03_e_a', `${id} references the official base item`);
  }
});

test('composed sandbox hooks change the actual target field consistently with rehearsals', run, async (t) => {
  const { makeMatch, giveItem } = await import('../../../test/match/harness.js');
  const h = makeMatch({ mode: 'coop', humans: 3, fake: true, seed: 159 }).start();
  t.after(() => h.m.dispose());
  h.toPrep(4);
  const m = h.m;
  const bettor = h.ps('p_2');
  bettor.bandId = 'band_x_fx_kurumi_margin';
  bettor.funds = 10;
  const piece = giveItem(m, bettor, 'item_x_fx_kurumi_call');
  m.dispatch(bettor, 'onGain', { piece, kind: 'item', source: 'test' });
  assert.equal(bettor.counters['kurumi:pos'], 1);
  const target = [...m.players.values()].find((p) => p.seat === bettor.counters['kurumi:pick']);
  assert.ok(target);
  for (const p of m.players.values()) m.dispatch(p, 'onPrepEnd', { round: 4 });
  const challenges = target.bounties.filter((b) => b.card.effectId?.startsWith('fx-kurumi:challenge:'));
  assert.equal(challenges.length, 1);
  const challengeId = challenges[0].id;
  const preview = m._normalOpts(target, { preview: true });
  const live = m._normalOpts(target);
  assert.deepEqual(live.spawns, preview.spawns);
  assert.equal(live.spawns.filter((s) => s.mods?.bountyId === challengeId).reduce((n, s) => n + s.count, 0), 1);
  assert.equal(live.spawns.find((s) => s.mods?.bountyId === challengeId).bounty, undefined, 'no added coin payout');
  for (const p of m.players.values()) if (p !== target) {
    assert.equal(m._normalOpts(p).spawns.some((s) => s.mods?.bountyId === challengeId), false);
  }
  assert.equal(m.wave.spawns.some((s) => s.mods?.bountyId === challengeId), false);
  assert.deepEqual(h.logs.error, []);
});

test('all candidate bounty enemies run deterministically on an actual normal field', run, async () => {
  const { makeBattle } = await import('../../../test/helpers/battleHarness.js');
  const { getData } = await import('../../../server/data.js');
  const { resultDigest } = await import('../../../server/sim/spec.js');
  const d = getData();
  const keys = [...new Set(d.choices.cards.bounty.filter((c) => c.payout === 'kill' && c.rounds === 1
    && !c.multiRound && c.coin >= 1 && c.coin <= 5).map((c) => c.enemyKey))];
  assert.equal(keys.length, 56);
  for (const key of keys) {
    let previous;
    for (let pass = 0; pass < 2; pass++) {
      const h = makeBattle({ seed: 77, timeLimit: 45, enemies: [{ key, time: 0 }], recordEvents: false });
      h.runToEnd(50);
      assert.deepEqual(h.b.errors, [], key);
      const digest = resultDigest(h.result());
      if (previous) assert.deepEqual(digest, previous, key);
      previous = digest;
    }
  }
});

test('restored enemies each produce one counted leak and cost exactly one LP in normal settlement', run, async () => {
  const { makeBattle } = await import('../../../test/helpers/battleHarness.js');
  const { makeMatch } = await import('../../../test/match/harness.js');
  const { getData } = await import('../../../server/data.js');
  const data = getData();
  for (const key of ['enemy_2001_duckmi', 'enemy_2002_bearmi', 'enemy_2034_sythef', 'enemy_2085_skzjxd', 'enemy_2008_flking']) {
    const sim = makeBattle({ enemies: [], recordEvents: false });
    const enemy = sim.spawn(key);
    assert.equal(enemy.counted, true, key);
    sim.b.leak(enemy);
    const result = sim.result().perPlayer.p1;
    assert.equal(result.leaked.length, 1, key);
    assert.equal(result.leaked[0].counted, true, key);
    assert.equal(result.leaked[0].lpr, data.enemies[key].stats.lpr, 'raw metadata survives unchanged');
    const h = makeMatch({ mode: 'solo', humans: 1, fake: true, seed: 161 }).start();
    try {
      h.toPrep(4);
      const ps = h.ps('p_0');
      ps.lp = 20;
      h.m.lastResults.set(ps.playerId, { ...result, leaked: result.leaked.map((l) => ({ ...l, sourcePlayerId: ps.playerId })) });
      h.m.settle(null, null);
      assert.equal(ps.lp, 19, key + ' costs one LP, even when raw lpr is 0 or 30');
      assert.deepEqual(h.logs.error, [], key);
    } finally {
      h.m.dispose();
    }
  }
});

test('real prep-to-settlement lifecycle adds the challenge once and expires it after one battle', run, async (t) => {
  const { makeMatch, giveItem } = await import('../../../test/match/harness.js');
  const h = makeMatch({ mode: 'coop', humans: 3, fake: true, seed: 160 }).start();
  t.after(() => h.m.dispose());
  h.toPrep(4);
  const bettor = h.ps('p_0');
  bettor.bandId = 'band_x_fx_kurumi_margin';
  bettor.funds = 10;
  const piece = giveItem(h.m, bettor, 'item_x_fx_kurumi_call');
  h.m.dispatch(bettor, 'onGain', { piece, kind: 'item', source: 'test' });
  const target = [...h.m.players.values()].find((p) => p.seat === bettor.counters['kurumi:pick']);
  h.toPrep(5);
  assert.equal(target.counters['kurumi:challengeRound'], 4);
  assert.ok(target.counters['kurumi:challengeLevel'] >= 1);
  assert.equal(target.bounties.filter((b) => b.card.effectId?.startsWith('fx-kurumi:challenge:')).length, 0);
  assert.equal(bettor.counters['kurumi:pos'], 0);
  assert.equal(bettor.counters['kurumi:void'], 0);
  assert.ok(bettor.funds >= 10 && bettor.funds <= 30, 'winning contract settles through the real round-start dispatcher');
  assert.deepEqual(h.logs.error, []);
});


test('real round income charges only prior carried cash, excluding income and pending funds', run, async t => {
  const { makeMatch } = await import('../../../test/match/harness.js');
  const h = makeMatch({ mode:'coop', humans:2, fake:true, seed:162 }).start(); t.after(() => h.m.dispose());
  h.toPrep(1); const ps = h.ps('p_0'), other = h.ps('p_1');
  ps.bandId='band_x_fx_kurumi_margin'; ps.funds=10; ps.pendingFunds=7;
  const untouched=other.funds;
  h.m.round=2; ps.startRound(2);
  assert.equal(ps.funds,10-2+h.m.gd.income(2)+7);
  assert.equal(other.funds,untouched);
  assert.equal(ps.pendingFunds,0);
  assert.deepEqual(h.logs.error,[]);
});
