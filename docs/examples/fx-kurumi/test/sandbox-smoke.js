// A fresh process is necessary: SES lockdown must precede simulation/SDK imports.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { createPluginRegistry } = await import('../../../server/plugins/registry.js');
const { buildContentSet } = await import('../../../server/plugins/contentSet.js');
const registry = createPluginRegistry({
  publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'),
  packsDir: path.join(root, 'packs'), pluginsDir: path.join(root, 'plugins'),
}, { scriptMode: 'sandbox', scriptHost: '127.0.0.1' });
assert.equal(registry.plugin('fx-kurumi')?.status, 'loaded');
const set = buildContentSet({ registry, ids: [{ id: 'fx-kurumi', settings: {} }] });
assert.ok(set.cs, JSON.stringify(set.problems));
assert.equal(set.scripts[0].execution, 'sandbox');
assert.equal(set.settings['fx-kurumi'].multMax, 2);
assert.equal(set.offers.length, 1);

const sandbox = await import('../../../shared/plugins/sandbox.js');
await sandbox.initializeSandbox({ loadSES: () => import('ses') });
const { setData } = await import('../../../server/data.js');
setData(set.data);
const { installOfficialBounds } = await import('../../../shared/plugins/officialBounds.js');
installOfficialBounds(set.bounds);
const { parse } = await import('acorn');
await sandbox.installSandboxScripts(set.scripts, { hashInput: set.index, parse });
const { makeMatch } = await import('../../../test/match/harness.js');

const h = makeMatch({ mode: 'coop', humans: 2, fake: true, seed: 160, offers: set.offers }).start();
try {
  h.toPrep(1);
  const bettor = h.ps('p_0');
  bettor.bandId = 'band_x_fx_kurumi_margin';
  h.m.dispatch(bettor, 'onRoundStart', { round: 1 });
  // Reopen after assigning only this seat the band: visibility must not leak to the other strategy.
  h.m.openOfferWindow('prep', 1);
  const pick = (windowId, cardId, variantId) => {
    const w = h.m.offerViews().find((w) => w.id === windowId);
    assert.ok(w, windowId);
    assert.deepEqual(w.seats.map((s) => s.playerId), ['p_0']);
    const slot = w.seats[0].slots.find((s) => s.id === cardId);
    assert.ok(slot?.available, cardId);
    const msg = { t: 'g.offer', pluginId: 'fx-kurumi', offerId: w.id, seq: w.seq, idx: slot.idx, cardId,
      ...(variantId ? { variantId } : {}) };
    assert.deepEqual(h.m.handle(bettor.playerId, msg), { ok: true });
    return msg;
  };
  assert.equal(h.m.offerViews().some(w => w.id === 'guarantor'), false);
  assert.ok(h.m.offerViews().some(w => w.id === 'market'), 'market opens on round 1');
  pick('market', 'skip');
  h.toPrep(2);
  assert.ok(h.m.offerViews().some(w => w.id === 'market'), 'market opens on round 2');
  pick('market', 'skip');
  h.toPrep(4);
  bettor.funds = 10;
  const market = h.m.offerViews().find(w => w.id === 'market');
  const callSlot = market.seats[0].slots.find(s => s.id === 'call');
  for (const variantId of ['x30', 'x30:s3', 'x30:s9', 'x50:s1']) {
    assert.ok(h.m.handle(bettor.playerId, { t: 'g.offer', offerId: market.id, pluginId: market.pluginId,
      seq: market.seq, idx: callSlot.idx, cardId: callSlot.id, variantId }).error);
    assert.equal(bettor.funds, 10);
  }
  const msg = pick('market', 'call', 'x20:s5');
  assert.equal(bettor.funds, 5);
  assert.equal(bettor.counters['kurumi:stake'], 5);
  assert.equal(bettor.counters['kurumi:mult'], 200);
  assert.equal(bettor.counters['kurumi:pos'], 1);
  assert.notEqual(h.m.handle(bettor.playerId, msg).ok, true, 'repeat click cannot create a second position');
  assert.equal(bettor.counters['kurumi:stake'], 5);
  assert.ok(![...bettor.hand, ...bettor.temp].filter(Boolean).some((p) => p.id === 'item_x_fx_kurumi_call_s5_x20'));
  const target = [...h.m.players.values()].find((p) => p.seat === bettor.counters['kurumi:pick']);
  h.toPrep(5);
  assert.equal(target.counters['kurumi:challengeRound'], 4);
  assert.ok(target.counters['kurumi:challengeLevel'] >= 1);
  assert.equal(bettor.counters['kurumi:pos'], 0);
  assert.equal(bettor.counters['kurumi:void'], 0);
  assert.ok(bettor.funds <= 30, 'R4 payout cannot skip straight to the old 40-fund balance');
  assert.equal(target.bounties.filter((b) => b.card.effectId?.startsWith('fx-kurumi:challenge:')).length, 0);

  h.toPrep(8);
  const beforeSkip = bettor.funds;
  pick('market', 'skip');
  assert.equal(bettor.funds, beforeSkip);
  assert.equal(bettor.counters['kurumi:pos'], 0);
  h.toPrep(9);
  assert.equal([...h.m.players.values()].some(p => p.counters['kurumi:challengeRound'] === 8), false, 'Skip creates no round-8 challenge');

  h.toPrep(12);
  bettor.funds = 10;
  pick('market', 'put', 'x15:s2');
  assert.equal(bettor.counters['kurumi:stake'], 2);
  assert.equal(bettor.counters['kurumi:mult'], 150);
  h.toPrep(13);
  assert.equal(bettor.counters['kurumi:pos'], 0);
  assert.equal(bettor.counters['kurumi:void'], 0);
  assert.deepEqual(h.logs.error, []);
  h.toPrep(h.m.gd.bossRound);
  assert.equal(h.m.offerViews().some(w => w.id === 'market'), false, 'Boss market stays closed');
  h.invariants();
  console.log('sandbox offers and settlement: ok');
} finally {
  h.m.dispose();
}
