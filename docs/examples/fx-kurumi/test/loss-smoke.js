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
const set = buildContentSet({ registry, ids: [{ id: 'fx-kurumi', settings: { multMax: 3 } }] });
assert.ok(set.cs, JSON.stringify(set.problems));
assert.equal(set.scripts[0].execution, 'sandbox');
assert.equal(set.settings['fx-kurumi'].multMax, 3);
assert.equal(set.offers.length, 1);

const sandbox = await import('../../../shared/plugins/sandbox.js');
await sandbox.initializeSandbox({ loadSES: () => import('ses') });
const { setData } = await import('../../../server/data.js');
setData(set.data);
const { installOfficialBounds } = await import('../../../shared/plugins/officialBounds.js');
installOfficialBounds(set.bounds);
const { parse } = await import('acorn');
await sandbox.installSandboxScripts(set.scripts, { hashInput: set.index, parse });
const { makeMatch, giveItem } = await import('../../../test/match/harness.js');

for (const mult of [2, 3]) {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true, seed: 166, offers: set.offers,
    script: () => ({ leaks: { p_0: 1, p_1: 1 } }) }).start();
  try {
    h.toPrep(1);
    const p = h.ps('p_0');
    p.bandId = 'band_x_fx_kurumi_margin';
    p.funds = 5;
    const piece = giveItem(h.m, p, `item_x_fx_kurumi_call_s5_x${mult * 10}`);
    h.m.dispatch(p, 'onGain', { piece, kind: 'item', source: 'test' });
    assert.equal(p.funds, 0);
    assert.equal(p.counters['kurumi:stake'], 5);
    h.toPrep(2);
    const owed = Math.max(0, 5 * (mult - 1) - h.m.gd.income(2));
    assert.equal(p.funds, Math.max(0, h.m.gd.income(2) - 5 * (mult - 1)));
    assert.equal(p.counters['kurumi:unpaidLoss'], owed);
    h.toPrep(3);
    const next = Math.max(0, owed - h.m.gd.income(3));
    assert.equal(p.counters['kurumi:unpaidLoss'], next);
    assert.equal(p.funds, Math.max(0, h.m.gd.income(3) - owed));
    if (owed > 0) assert.ok(h.sent.some(([pid, msg]) => pid === p.playerId
      && msg.t === 'm.toast' && msg.text === `【保证金】补扣待补亏损 ${owed - next}（尚欠 ${next}）`));
    assert.deepEqual(h.logs.error, []);
    h.invariants();
  } finally {
    h.m.dispose();
  }
}
console.log('sandbox loss and future-income repayment: ok');
