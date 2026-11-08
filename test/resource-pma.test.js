// test/resource-pma.test.js — a premultiplied Spine page decodes as it is (feedback #48, #55): the manifest entry's
// `pma` rides loadSpineData's imageMetadata (cdnSpineSource on the per-file CDN) into the page loads, whose stock
// loadTextures parser would createImageBitmap with the default premultiplyAlpha — pixels already premultiplied in the
// file get a second pass and every semi-transparent pixel goes dark. installArtParsers decodes such pages itself with
// `premultiplyAlpha: 'none'`; straight pages keep the stock decode.
// Run: node --test test/resource-pma.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installArtParsers, artTransport } from '../public/js/resourceNetwork.js';
import { loadSpineData } from '../public/js/assets.js';

class FakeBaseTexture {
  constructor(image, data) { this.image = image; this.data = data; this.resource = { src: null }; }
  once() {}
}
class FakeTexture {
  constructor(base) { this.baseTexture = base; }
  once() {}
}

function fakeParser() {
  return {
    name: 'loadTextures', config: { preferCreateImageBitmap: true }, called: [],
    async load(url, options, _loader) { this.called.push({ url, options }); return `stock:${url}`; },
  };
}

test('a premultiplied page decodes with premultiplyAlpha none and carries the alpha mode (feedback #48, #55)', async (t) => {
  const previous = globalThis.createImageBitmap, decoded = [], bitmaps = [];
  globalThis.createImageBitmap = async (blob, o) => {
    decoded.push([blob, o]);
    const bitmap = { width: 1, height: 1, close() {} };
    bitmaps.push(bitmap);
    return bitmap;
  };
  t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
  const prevBlob = artTransport.blob;
  artTransport.blob = async () => new Blob(['x']);
  t.after(() => { artTransport.blob = prevBlob; });
  const parser = fakeParser();
  const pixi = {
    ALPHA_MODES: { PMA: 2 }, BaseTexture: FakeBaseTexture, Texture: FakeTexture,
    utils: { getResolutionOfUrl: () => 1 }, Assets: { loader: { parsers: [parser] }, cache: { has: () => false, remove() {} } },
  };
  installArtParsers(pixi);
  const url = '/assets/spine/op/char_x/front/char_x.png';
  const texture = await parser.load(url, { data: { alphaMode: 2 } }, {});
  assert.deepEqual(decoded[0][1], { premultiplyAlpha: 'none' }, 'the premultiplied page is not premultiplied again');
  assert.equal(texture.baseTexture.image, bitmaps[0], 'the bitmap is the decoded one');
  assert.equal(texture.baseTexture.data.alphaMode, 2, 'the alpha mode rides into the BaseTexture');
  assert.equal(texture.baseTexture.data.resolution, 1);
  assert.equal(texture.baseTexture.data.resourceOptions.ownsImageBitmap, true);
  assert.equal(texture.baseTexture.resource.src, url, 'the resource keeps the canonical URL, not a temporary');
  // a straight page keeps the stock decode (the temporary URL, no createImageBitmap options)
  const stock = await parser.load(url, { data: {} }, {});
  assert.equal(decoded.length, 1, 'no second decode happened');
  assert.ok(stock.startsWith('stock:blob:'), 'the stock parser got the temporary blob URL');
  assert.equal(parser.called[0].options.data.resolution, undefined, 'the stock parser sees the caller data as it was');
});

test('a non-loadTextures parser and a foreign URL keep out of the premultiplied branch', async (t) => {
  const previous = globalThis.createImageBitmap, decoded = [];
  globalThis.createImageBitmap = async (blob, o) => { decoded.push(o); return { width: 1, height: 1, close() {} }; };
  t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
  const prevBlob = artTransport.blob;
  artTransport.blob = async () => new Blob(['x']);
  t.after(() => { artTransport.blob = prevBlob; });
  // no alphaMode in the asset data: the stock decode runs
  const parser = fakeParser();
  const pixi = {
    ALPHA_MODES: { PMA: 2 }, BaseTexture: FakeBaseTexture, Texture: FakeTexture,
    utils: { getResolutionOfUrl: () => 1 }, Assets: { loader: { parsers: [parser] }, cache: { has: () => false, remove() {} } },
  };
  installArtParsers(pixi);
  await parser.load('/assets/spine/op/char_x/front/char_x.png', { data: {} }, {});
  assert.equal(decoded.length, 0);
  assert.equal(await parser.load('/vendor/image.png', { data: { alphaMode: 2 } }, {}), 'stock:/vendor/image.png', 'a foreign path goes straight to the stock parser');
  assert.equal(decoded.length, 0);
});

test('loadSpineData hands premultiplied pages their alpha mode, straight ones keep the plain load', async () => {
  const seen = [];
  const prev = globalThis.PIXI;
  globalThis.PIXI = {
    ALPHA_MODES: { PMA: 2 }, spine: {},
    Assets: {
      load: async (src) => { seen.push(src); return { spineData: { animations: [] } }; },
      loader: { parsers: [] },
    },
  };
  try {
    await loadSpineData({ skel: '/s/a.skel', atlas: '/s/a.atlas', pma: false });
    await loadSpineData({ skel: '/s/b.skel', atlas: '/s/b.atlas', pma: true });
    await loadSpineData({ skel: '/s/c.display.skel', atlas: '/s/c.atlas', pma: true });
    await loadSpineData({ skel: '/s/d.skel' });
  } finally { globalThis.PIXI = prev; }
  assert.equal(seen[0], '/s/a.skel', 'a straight page with an inferred atlas loads plain');
  assert.deepEqual(seen[1], { src: '/s/b.skel', data: { imageMetadata: { alphaMode: 2 } } });
  assert.deepEqual(seen[2], { src: '/s/c.display.skel', data: { spineAtlasFile: '/s/c.atlas', imageMetadata: { alphaMode: 2 } } });
  assert.equal(seen[3], '/s/d.skel');
});
