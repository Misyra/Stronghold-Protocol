// tools/resourcePackPath.mjs — where the pack builder reads one manifest URL from. The URL is data, so encoded
// separators and decoded `..` segments must never reach the filesystem reader (tools/build-resource-packs.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resourcePackPath } from '../../tools/resourcePackPath.mjs';

const PUBLIC = path.resolve('/srv/install/public');

test('a manifest URL resolves to its file inside the public directory', () => {
  assert.equal(resourcePackPath(PUBLIC, '/assets/ui/a.png'), path.join(PUBLIC, 'assets', 'ui', 'a.png'));
  assert.equal(resourcePackPath(PUBLIC, '/assets/local/map/fx/%5Bopt%5Dmerged_textures.png'),
    path.join(PUBLIC, 'assets', 'local', 'map', 'fx', '[opt]merged_textures.png'), 'brackets are decoded, as on disk');
});

test('encoded separators and decoded traversal are refused', () => {
  for (const url of [
    '/assets/..%2F..%2Fsecret.png',
    '/assets/..%5C..%5Csecret.png',
    '/assets/%2e%2e/%2e%2e/secret.png',
    '/assets/../../secret.png',
    '/assets/a%2Fb.png',
    '/%2fetc/passwd.png',
    '/assets/%00.png',
    '/assets/%ZZ.png',
    'https://cdn.example.com/assets/x.png',
    null, 7,
  ]) assert.equal(resourcePackPath(PUBLIC, url), null, String(url));
});
