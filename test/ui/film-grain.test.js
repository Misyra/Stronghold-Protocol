// test/ui/film-grain.test.js — the entry film's grain (ui/allianceScene.js): the 30 fps recording's noise is a
// pre-generated bank rotated at 30 Hz, off the per-rAF hot path. Node drives it through a stand-in 2D context
// (createImageData/putImageData only), so the numbers are exact: N frames pre-generated, a put only on every Nth
// call, the frames rotated in order, and an empty context is a safe no-op (no art pack / jsdom).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrain, GRAIN_FRAMES, GRAIN_EVERY, GRAIN_W, GRAIN_H } from '../../public/js/ui/allianceScene.js';

/** A stand-in 2D context: counts createImageData / putImageData, keeps the last bytes uploaded. */
function fakeContext() {
  const ctx = { created: 0, puts: 0, last: null };
  ctx.createImageData = (w, h) => { ctx.created++; return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; };
  ctx.putImageData = (img, x, y) => { assert.equal(x, 0); assert.equal(y, 0); ctx.puts++; ctx.last = img; };
  return ctx;
}

test('grain is a pre-generated bank, not a per-frame fill: 8 frames of 426×240 built once at mount', () => {
  const ctx = fakeContext();
  const g = createGrain(ctx);
  assert.equal(g.frameCount, GRAIN_FRAMES, 'the bank size');
  assert.equal(g.everyN, GRAIN_EVERY, '30 Hz = every 2nd rAF');
  assert.equal(g.bank.length, GRAIN_FRAMES);
  assert.equal(ctx.created, GRAIN_FRAMES, 'one createImageData per pre-generated frame, at construction');
  assert.equal(ctx.puts, 0, 'nothing drawn at construction');
  for (const img of g.bank) {
    assert.equal(img.width, GRAIN_W);
    assert.equal(img.height, GRAIN_H);
    assert.equal(img.data.length, GRAIN_W * GRAIN_H * 4);
    assert.equal(img.data[3], 255, 'alpha is opaque');
  }
  // distinct noise per frame (compare a few pixels, not a deep-equal of 102k bytes)
  const head = (d) => Array.from(d.subarray(0, 64));
  assert.notDeepEqual(head(g.bank[0].data), head(g.bank[1].data), 'the frames are different noise');
  // the pre-generation happens once: driving the film does not create more ImageData
  for (let i = 0; i < 200; i++) g.grain();
  assert.equal(ctx.created, GRAIN_FRAMES, 'no ImageData created per frame');
});

test('grain updates at 30 Hz: one put on every 2nd call, frames rotated in order', () => {
  const ctx = fakeContext();
  const g = createGrain(ctx);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const before = ctx.puts;
    g.grain();
    if (ctx.puts > before) seen.push(ctx.last); // only the frames that actually drew
  }
  assert.equal(ctx.puts, 20, 'half of 40 rAF calls draw (30 Hz)');
  assert.equal(g.puts, 20);
  for (let k = 0; k < seen.length; k++) {
    // identity, not assert.equal: a mismatch would make node:assert diff two 102k-byte ImageData objects
    assert.ok(seen[k] === g.bank[k % GRAIN_FRAMES], `frame ${k} is bank[${k % GRAIN_FRAMES}]`);
  }
  // a 60 Hz clock over the grain window (3.2 s) draws 96 frames, not 192
  assert.equal(Math.floor(3.2 * 60 / GRAIN_EVERY), 96);
});

test('a missing / empty 2D context is a safe no-op (no art pack, no canvas support)', () => {
  for (const ctx of [null, undefined, {}]) {
    const g = createGrain(ctx);
    assert.equal(g.bank.length, 0);
    assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) g.grain(); });
    assert.equal(g.puts, 0);
  }
});

test('the stand-in is injectable: everyN / frameCount / size can be overridden without touching the film', () => {
  const ctx = fakeContext();
  const g = createGrain(ctx, { width: 8, height: 4, frameCount: 3, everyN: 1 });
  assert.equal(g.frameCount, 3);
  assert.equal(g.everyN, 1);
  assert.equal(ctx.created, 3);
  for (let i = 0; i < 6; i++) g.grain();
  assert.equal(ctx.puts, 6, 'everyN=1 draws every call');
  assert.equal(g.bank[0].data.length, 8 * 4 * 4);
});
