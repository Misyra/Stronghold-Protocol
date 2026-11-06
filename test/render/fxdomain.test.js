// test/render/fxdomain.test.js — 国度's darkened tile field (render/fx/zones.js domainField, Stardust fork b3f13f31):
// the sim sends a keyed 'domain' fx every 0.5 s with the whole tile set (render/fx/simfx.js 'domain'), the renderer keeps
// one record per key — updated in place when the field moves or its tiles change — and fades it out over DOMAIN_FADE s
// once the refreshes stop (the unit left / the boss died).
// Run: node --test test/render/fxdomain.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxSystem } from '../../public/js/render/fx.js';
import { DOMAIN_FADE, DOMAIN_FILL } from '../../public/js/render/fx/zones.js';
import { presetCamera } from '../../public/js/render/projection.js';

/** A Graphics that records the polygons of a frame: their points, fill and line colours. */
class RecGraphics {
  constructor() { this.polys = []; this.line = null; this.fill = null; }
  clear() { this.polys.length = 0; return this; }
  lineStyle(width, colour, alpha) { this.line = { width, colour, alpha }; return this; }
  beginFill(colour, alpha) { this.fill = { colour, alpha }; return this; }
  endFill() { return this; }
  drawPolygon(points) { this.polys.push({ points: points.slice(), line: this.line, fill: this.fill }); return this; }
}

/** An FxSystem shell with the domain field's state: enough for domainField() / _updateDomains() / simFx('domain'). */
function fxShell() {
  const cam = presetCamera('normal', { width: 1280, height: 720 });
  const fx = Object.create(FxSystem.prototype);
  Object.assign(fx, {
    P: { Graphics: RecGraphics },
    domainGfx: new RecGraphics(),
    domains: new Map(),
    domainSeq: 0,
    ctx: { cam: () => cam, heightAt: () => 0, timeScale: () => 2, view: () => null },
    _p: { x: 0, y: 0, s: 0, depth: 0 },
    _groundZ: () => 0,
  });
  return fx;
}

const TILES = [[10, 6], [10, 7], [10, 8], [9, 7], [11, 7]];

test('a field re-sent under the same key is one record, updated in place (tiles, tint, its end)', () => {
  const fx = fxShell();
  fx.domainField('domain:7', TILES, 0x8a5cd0, 0.75);
  const first = fx.domains.get('domain:7');
  assert.equal(fx.domains.size, 1);
  fx._updateDomains(0.1);
  assert.equal(fx.domainGfx.polys.length, TILES.length, 'one polygon per tile');

  const moved = [[11, 7], [11, 8], [11, 9]];
  fx.domainField('domain:7', moved, 0x8a5cd0, 0.75);
  assert.equal(fx.domains.size, 1, 'a second pulse under the key does not stack a second field');
  assert.equal(fx.domains.get('domain:7'), first, 'the same record is reused');
  assert.deepEqual(first.tiles, moved, 'the tile set is the one last sent');
  assert.ok(first.left >= 0.75 - 1e-9, 'the end extends from the last pulse');
  fx._updateDomains(0.1);
  assert.equal(fx.domainGfx.polys.length, moved.length, 'the frame draws the new tiles only');
  assert.equal(fx.domainGfx.polys[0].fill.colour, DOMAIN_FILL, 'the dark fill under a violet edge');
  assert.equal(fx.domainGfx.polys[0].line.colour, 0x8a5cd0);
});

test('a changed tile set redraws at the new tiles (the same key, no stale polygons)', () => {
  const fx = fxShell();
  fx.domainField('domain:9', [[10, 6]], 0x8a5cd0, 0.75);
  fx._updateDomains(0.1);
  const before = fx.domainGfx.polys[0].points.slice();

  fx.domainField('domain:9', [[12, 2], [12, 3]], 0x8a5cd0, 0.75);
  fx._updateDomains(0.1);
  assert.equal(fx.domainGfx.polys.length, 2, 'two tiles now');
  assert.notDeepEqual(fx.domainGfx.polys[0].points, before, 'the polygons follow the new tiles');
  assert.deepEqual(fx.domains.get('domain:9').tiles, [[12, 2], [12, 3]]);
});

test('once the pulses stop the field fades out and is dropped', () => {
  const fx = fxShell();
  fx.domainField('domain:3', TILES, 0x8a5cd0, 0.5);
  fx._updateDomains(0.1);   // fading in
  fx._updateDomains(0.3);   // full strength, still refreshed
  const bright = fx.domainGfx.polys[0].fill.alpha;
  fx._updateDomains(0.15);  // left < 0: the fade-out starts
  const dimmer = fx.domainGfx.polys[0].fill.alpha;
  assert.ok(dimmer > 0 && dimmer < bright, `fading: ${bright} → ${dimmer}`);
  assert.equal(fx.domains.size, 1, 'still drawn while it fades');
  fx._updateDomains(DOMAIN_FADE + 0.01);
  assert.equal(fx.domains.size, 0, 'gone after DOMAIN_FADE s');
  assert.equal(fx.domainGfx.polys.length, 0, 'nothing left to draw');
});

test('simFx: a keyed \'domain\' event reaches the field with its tiles, its colour and its game-second duration', () => {
  const fx = fxShell();
  fx.simFx('domain', 7, 10, { id: 7, key: 'domain:7', tiles: TILES, dur: 0.75 });
  const d = fx.domains.get('domain:7');
  assert.ok(d, 'one field under the event key');
  assert.deepEqual(d.tiles, TILES);
  assert.equal(d.tint, 0x8a5cd0, 'FX_KINDS.domain colour');
  assert.ok(Math.abs(d.left - 0.75 / 2) < 1e-9, 'dur is game seconds (÷ timeScale 2)');
  fx.simFx('domain', 7, 10, { id: 7, key: 'domain:7', tiles: [[9, 9]] });
  assert.equal(fx.domains.size, 1, 're-sent: still one field');
  fx.simFx('domain', 7, 10, { id: 7, key: 'domain:7', tiles: [] });
  assert.deepEqual(fx.domains.get('domain:7').tiles, [[9, 9]], 'an empty set changes nothing');
});

test('a field without a key gets a fresh sequence number: a faded field\'s slot is never reused onto a live one', () => {
  const fx = fxShell();
  fx.domainField(null, [[10, 6]], 0x8a5cd0, 0.3);
  fx.domainField(null, [[12, 2]], 0x8a5cd0, 30);
  assert.equal(fx.domains.size, 2, 'two keyless fields are two records');
  fx._updateDomains(0.3 + DOMAIN_FADE + 0.01); // the first field fades out and is dropped
  assert.equal(fx.domains.size, 1);
  fx.domainField(null, [[14, 4]], 0x8a5cd0, 0.75);
  assert.equal(fx.domains.size, 2, 'the new field is its own record, not an update to the surviving one');
  const singles = [...fx.domains.values()].map((d) => d.tiles[0][0]).sort((a, b) => a - b);
  assert.deepEqual(singles, [12, 14], 'the long-lived field keeps its tiles beside the new one');
});
