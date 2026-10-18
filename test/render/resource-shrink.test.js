import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localSpineEntry, loadSpineData, spinePages, forgetPendingSpine, unloadSpineData } from '../../public/js/assets.js';

test('Spine selects explicit WebP atlas; original PNG atlas remains the legacy default', async (t) => {
  const original = globalThis.PIXI;
  t.after(() => { globalThis.PIXI = original; });
  const loads = [];
  globalThis.PIXI = { spine: {}, Assets: { load: async (entry) => { loads.push(entry); return { spineData: { animations: [] } }; } } };
  await loadSpineData({ skel: '/assets/x.skel', atlas: '/assets/x.webp.atlas', textures: ['/assets/x.webp'] });
  await loadSpineData({ skel: '/assets/legacy.skel', atlas: '/assets/legacy.atlas' });
  assert.deepEqual(loads, [{ src: '/assets/x.skel', data: { spineAtlasFile: '/assets/x.webp.atlas' } }, '/assets/legacy.skel']);
});

test('local Spine variants, cleanup and retry all use new atlas/page identities', async (t) => {
  const local = { groups: { 'spine/token/x': Object.fromEntries(['x.skel', 'x.webp.atlas', 'x.webp'].map((name) =>
    [name, { path: '/assets/local/spine/token/x/' + name }])) } };
  const sl = { group: 'spine/token/x', skel: 'x.skel', atlas: 'x.webp.atlas', textures: ['x.webp'],
    anims: { idle: 'Idle' }, animations: { Idle: 1 } };
  const entry = localSpineEntry(sl, local, null);
  assert.ok(entry);
  assert.deepEqual(spinePages(entry), ['/assets/local/spine/token/x/x.webp']);
  const original = globalThis.PIXI;
  t.after(() => { globalThis.PIXI = original; });
  const unloaded = [];
  globalThis.PIXI = { Assets: { cache: { has: () => false }, loader: {
    promiseCache: Object.fromEntries([entry.skel, entry.atlas, ...entry.textures].map((url) => [url, {}])),
    unload: async (url) => { unloaded.push(url); },
  }, unload: async (url) => { unloaded.push(url); } } };
  assert.equal(forgetPendingSpine(entry), 3);
  await unloadSpineData(entry);
  assert.deepEqual(unloaded, [entry.skel, entry.atlas, ...entry.textures]);
  assert.equal(localSpineEntry({ ...sl, atlas: 'foreign.atlas' }, local, null), null);
});
