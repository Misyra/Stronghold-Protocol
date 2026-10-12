import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TileField } from '../../public/js/render/tiles.js';

test('late highlight updates after teardown do not access destroyed Graphics', () => {
  const field = Object.create(TileField.prototype);
  let destroyed = 0;
  const graphics = () => ({ destroy() { destroyed++; }, clear() { throw new Error('destroyed geometry'); } });
  Object.assign(field, { devices: [], animSprites: [], boxMeshes: new Set(), meshes: [],
    rowSurfaces: new Map(), rowMeshes: new Map(), boxes: [], highlights: new Map([['range', {}]]),
    hlGfx: graphics(), flowGfx: graphics(), animLayer: graphics() });
  field.destroy();
  assert.equal(field.highlights.size, 0);
  assert.doesNotThrow(() => field.setHighlights([[9, 3]], 'range'));
  assert.doesNotThrow(() => field.clearHighlights());
  assert.doesNotThrow(() => field._drawHighlights());
  assert.doesNotThrow(() => field.destroy());
  assert.equal(destroyed, 3);
  assert.equal(field.highlights.size, 0);
});
