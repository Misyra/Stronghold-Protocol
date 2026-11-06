// test/ui/film-filter.test.js — the entry film's per-frame style.filter writes (ui/allianceScene.js): continuous
// filters are quantized to 24 bands and a layer's style.filter is written only when its value actually changes.
// Node drives createFilterWriter through a fake style object, so the write count is exact. transform / opacity are
// never touched by the writer; the film keeps writing them every frame (they do not force a re-composite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilterWriter, quantBrightness, FILTER_STEPS } from '../../public/js/ui/allianceScene.js';

/** A stand-in element: a fake style object that counts every property assignment. */
function fakeEl() {
  const writes = [];
  const style = new Proxy({}, { set(o, k, v) { o[k] = v; writes.push([k, v]); return true; } });
  return { el: { style }, writes };
}

test('quantBrightness: 24 bands, a value is snapped to the nearest 1/24 step', () => {
  assert.equal(FILTER_STEPS, 24);
  assert.equal(quantBrightness(0), 0);
  assert.equal(quantBrightness(1), 1);
  assert.equal(quantBrightness(0.5), 0.5);
  assert.equal(quantBrightness(1 / 48), 1 / 24, '0.0208 rounds up to the 0.0417 band');
  assert.equal(quantBrightness(1 / 48 - 1e-9), 0, 'just below half a band rounds down');
  for (const x of [0.1, 0.33, 0.67, 0.9, 1.2]) {
    const q = quantBrightness(x);
    assert.ok(Math.abs(q - x) <= 0.5 / FILTER_STEPS + 1e-12, `${x} within half a band`);
    assert.equal(q, Math.round(x * FILTER_STEPS) / FILTER_STEPS);
  }
});

test('createFilterWriter writes a value once, then skips identical values (a constant filter writes 1 time)', () => {
  const { el, writes } = fakeEl();
  const w = createFilterWriter();
  assert.equal(w.set(el, 'brightness(1) saturate(.9)'), true);
  assert.equal(el.style.filter, 'brightness(1) saturate(.9)');
  assert.equal(w.set(el, 'brightness(1) saturate(.9)'), false, 'the second frame does not write');
  assert.equal(w.set(el, 'brightness(1) saturate(.9)'), false);
  assert.equal(w.set(el, 'brightness(2) saturate(.9)'), true, 'a real change writes');
  assert.equal(w.set(el, 'brightness(1) saturate(.9)'), true, 'changing back writes again');
  assert.equal(w.writes, 3);
  assert.equal(writes.length, 3, 'exactly one style.filter assignment per real change');
  assert.ok(writes.every(([k]) => k === 'filter'), 'no other style property is written');
});

test('per-element: each layer has its own last value (a change on one does not re-write the others)', () => {
  const a = fakeEl(), b = fakeEl(), c = fakeEl();
  const w = createFilterWriter();
  w.set(a.el, 'x'); w.set(b.el, 'y'); w.set(c.el, 'z'); // 3 first writes
  for (let i = 0; i < 10; i++) { w.set(a.el, 'x'); w.set(b.el, 'y'); w.set(c.el, 'z'); }
  assert.equal(w.writes, 3, '30 calls to set, only the 3 first writes land');
  w.set(b.el, 'y2'); // only b changes
  assert.equal(w.writes, 4);
  assert.equal(a.writes.length, 1);
  assert.equal(b.writes.length, 2);
  assert.equal(c.writes.length, 1);
});

test('a quantized 24-band sweep writes once per band, not once per frame', () => {
  const { el, writes } = fakeEl();
  const w = createFilterWriter();
  // 120 samples of a brightness ramp 0→1: baseline would write 120 times; quantized 24 bands write ~25 times.
  for (let i = 0; i <= 120; i++) {
    const x = i / 120;
    w.set(el, `brightness(${quantBrightness(x).toFixed(3)})`);
  }
  assert.ok(w.writes <= FILTER_STEPS + 1, `at most one write per band (${w.writes})`);
  assert.ok(w.writes >= FILTER_STEPS, `every band is visited (${w.writes})`);
  assert.equal(writes.length, w.writes, 'the fake style saw exactly the real writes');
  assert.equal(el.style.filter, 'brightness(1.000)', 'the last value is on the element');
});

test('empty / none values are handled like any value (a layer is cleared once, not every frame)', () => {
  const { el } = fakeEl();
  const w = createFilterWriter();
  assert.equal(w.set(el, ''), true);
  assert.equal(w.set(el, ''), false);
  assert.equal(w.set(el, 'none'), true);
  assert.equal(w.set(el, 'none'), false);
  assert.equal(w.set(el, ''), true);
  assert.equal(w.writes, 3);
});
