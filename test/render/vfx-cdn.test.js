// The official battle effects load from the assets CDN like any other art: the file list, its prefabs, textures and
// meshes all go through public/js/resourceUrl.js (per-file ?v=<hash> when the CDN serves a hash manifest), while a
// third-party, plugin or relative path is left exactly as it is. Ported from xinhai's
// test/render/vfx-cdn.test.js, re-pointed at this fork's seam (resourceUrl instead of an injected assetsCdn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxLibrary } from '../../public/js/render/vfx/library.js';
import { resetFxList } from '../../public/js/render/vfx/available.js';

const CDN = 'https://cdn.example/stronghold';

function manifest() {
  return { groups: {
    fx: {
      index: { path: '/assets/local/fx/index.json' },
      textures: { path: '/assets/local/fx/textures.json' },
    },
    'fx/prefabs': {
      effect: { path: '/assets/local/fx/prefabs/effect.json' },
      external: { path: 'https://plugins.example/fx.json' },
      plugin: { path: '/packs/example/effect.json' },
      relative: { path: 'prefabs/relative.json' },
    },
    'fx/mesh': { mesh: { path: '/assets/local/fx/mesh/mesh.json' } },
    'fx/tex': { texture: { path: '/assets/local/fx/tex/full.png', half: '/assets/local/fx/tex/half.png' } },
  } };
}

function withCdn(t, hashes = null) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__spAssetCdn');
  globalThis.__spAssetCdn = { base: CDN, ...(hashes ? { hashes } : {}) };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, '__spAssetCdn', previous); else delete globalThis.__spAssetCdn;
    resetFxList();
  });
}

/** The URL the effects layer must use for an entry: only /assets/ art moves to the CDN. */
const expectUrl = (path, hashes) => (path.startsWith('/assets/') ? (hashes?.[path] ? `${CDN}${path}?v=${hashes[path]}` : `${CDN}${path}`) : path);

for (const source of ['shared', 'fetched', 'injected', 'fallback-empty', 'fallback-failed']) {
  test(`official effects reach the assets CDN whichever way the file list arrives (${source})`, async (t) => {
    withCdn(t);
    const list = manifest();
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      if (url === '/data/local-fx.json') {
        if (source === 'fallback-failed') return { ok: false, status: 404 };
        return { ok: true, json: async () => (source === 'fallback-empty' ? { groups: {} } : list) };
      }
      const body = url.endsWith('/index.json') ? { version: 2 }
        : url.endsWith('/textures.json') ? { textures: {} }
          : url.includes('/mesh/') ? { positions: [0, 0, 0] } : { format: 'fx-prefab' };
      return { ok: true, json: async () => body };
    };
    const opts = { fetch, list: source === 'injected' ? list : undefined, assets: { local: async () => list } };
    if (source === 'shared') {
      // the data store's own copy: /data/local-fx.json is fetched from the CDN too
      resetFxList();
      const previous = globalThis.fetch;
      globalThis.fetch = fetch;
      t.after(() => { globalThis.fetch = previous; });
      delete opts.fetch;
    }
    const lib = new FxLibrary(opts);
    assert.equal(await lib.init(), true);
    for (const [group, entries] of Object.entries(list.groups)) {
      for (const [key, entry] of Object.entries(entries)) {
        assert.equal(lib.url(group, key), expectUrl(entry.path), `${group}/${key}`);
      }
    }
    assert.equal((await lib.index()).version, 2);
    const atlases = calls.filter((u) => u.includes('/fx/'));
    assert.ok(atlases.length, 'the library asked for its files');
    for (const url of atlases) {
      assert.ok(url === '/data/local-fx.json' || url.startsWith(CDN) || url.startsWith('https://plugins.example/') || url.startsWith('/packs/'),
        `${url} did not go through the CDN seam`);
    }
  });
}

test('a per-file hash manifest puts every effect file on its own immutable URL', async (t) => {
  const hashes = { '/assets/local/fx/prefabs/effect.json': '0123456789abcdef', '/assets/local/fx/tex/full.png': 'fedcba9876543210' };
  withCdn(t, hashes);
  const list = manifest();
  const lib = new FxLibrary({ fetch: async () => ({ ok: true, json: async () => list }), list, assets: { local: async () => list } });
  assert.equal(await lib.init(), true);
  assert.equal(lib.url('fx/prefabs', 'effect'), `${CDN}/assets/local/fx/prefabs/effect.json?v=0123456789abcdef`);
  assert.equal(lib.url('fx/tex', 'texture'), `${CDN}/assets/local/fx/tex/full.png?v=fedcba9876543210`);
  // a second page of the same entry is not a key of its own: it keeps the bare CDN URL (no hash to append)
  assert.equal(lib.url('fx/mesh', 'mesh'), `${CDN}/assets/local/fx/mesh/mesh.json`, 'an unlisted file keeps the bare CDN URL');
  assert.equal(lib.url('fx/prefabs', 'plugin'), '/packs/example/effect.json', 'a plugin path stays on the game host');
});
