// The economy is declared once: data/items.json `set.contract` is what the match enforces against a card's display
// quote (server/match/match/offers.js _offerQuoteMismatch), and CONTRACTS in meta.js is what settlement charges.
// This test keeps the three copies (item spec, quote, settlement table) identical; it is plugin-local because
// plugins/ is not committed to the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTRACTS } from '../meta.js';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const items = read('../data/items.json');
const cards = read('../offers/cards.json');

test('every item contract spec matches the settlement table', () => {
  const tagged = items.entries.filter((e) => e.set?.contract).map((e) => [e.id, e.set.contract]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(tagged.map(([id]) => id), Object.keys(CONTRACTS).sort());
  for (const [id, spec] of tagged) {
    assert.equal(CONTRACTS[id].tier, spec.fraction, id);
    assert.equal(CONTRACTS[id].mult ?? 2, spec.multiplier, id);
  }
});

test('every offer quote matches the item contract spec it grants', () => {
  const byId = new Map(items.entries.map((e) => [e.id, e]));
  let checked = 0;
  for (const card of cards) {
    for (const entry of [card, ...Object.values(card.variants || {})]) {
      const item = entry.apply?.item;
      const quote = entry.quote;
      if (!item || !quote) continue;
      const spec = byId.get(item)?.set?.contract;
      assert.ok(spec, `${item}: item contract spec`);
      assert.equal(quote.fraction, spec.fraction, item);
      assert.equal(quote.multiplier, spec.multiplier, item);
      assert.equal(quote.stakeLimit, spec.stakeLimit, item);
      assert.equal(quote.multiplierLimitCounter, spec.multiplierLimitCounter, item);
      checked++;
    }
  }
  assert.equal(checked, 52, '2 base quotes + 25 variants per direction');
});
