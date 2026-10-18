import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../public/js/', import.meta.url));
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith('.js') ? [file] : [];
  });
}

test('DOM game images use CORS before src and recover legacy cache entries before fallback', () => {
  let count = 0;
  for (const file of sources(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<img\s[\s\S]*?\/>/g)) {
      // Ignore documentation prose; actual htm images always have src=.
      if (!match[0].includes('src=')) continue;
      const image = match[0];
      assert.ok(image.indexOf('crossorigin="anonymous"') >= 0, file);
      assert.ok(image.indexOf('crossorigin=') < image.indexOf('src='), file);
      assert.ok(image.includes('onError=') && image.includes('recoverImageError'), file);
      count++;
    }
    // Only the two image loaders may construct an <img> themselves: the per-URL repair loader and the runtime art
    // transport that decodes a downloaded blob (public/js/resourceNetwork.js).
    if (source.includes('new Image()')) {
      assert.ok(['image.js', 'resourceNetwork.js'].includes(path.relative(root, file)), path.relative(root, file));
    }
  }
  assert.ok(count >= 16, `only ${count} image templates checked`);
});
