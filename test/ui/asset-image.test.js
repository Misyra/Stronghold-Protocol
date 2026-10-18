import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetImageSource } from '../../public/js/ui/useAssetImage.js';

test('missing image props do not dereference a null recovery record', () => {
  for (const source of [undefined, null, '', false, 0]) {
    assert.equal(assetImageSource(source, null, null), null);
    assert.equal(assetImageSource(source, source, null), null);
  }
});

test('image fallback and recovery retain per-source identity', () => {
  assert.equal(assetImageSource('/a.png', null, null), '/a.png');
  assert.equal(assetImageSource('/a.png', '/a.png', null), null);
  assert.equal(assetImageSource('/b.png', '/a.png', null), '/b.png');
  const recovered = { source: '/a.png', url: 'blob:recovered' };
  assert.equal(assetImageSource('/a.png', '/a.png', recovered), 'blob:recovered');
  assert.equal(assetImageSource('/b.png', '/a.png', recovered), '/b.png');
  assert.equal(assetImageSource(undefined, null, recovered), null);
});
