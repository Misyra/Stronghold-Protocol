import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restorePixiExtensions } from '../../public/js/render/app/pixi.js';

test('extensions are refreshed before Pixi rebuilds resources, and the listener is removable', () => {
  const listeners = [], order = [];
  const renderer = {
    view: {
      addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
      removeEventListener(type, fn, capture) {
        const i = listeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    context: { getExtensions() { order.push('extensions'); } },
  };
  renderer.view.addEventListener('webglcontextrestored', () => order.push('resources'), false);
  const dispose = restorePixiExtensions(renderer);
  const dispatch = () => {
    for (const capture of [true, false]) for (const l of listeners) if (l.capture === capture) l.fn();
  };
  dispatch();
  assert.deepEqual(order, ['extensions', 'resources']);
  dispose();
  order.length = 0;
  dispatch();
  assert.deepEqual(order, ['resources']);
});
