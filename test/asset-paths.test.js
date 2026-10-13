// shared/assetPaths.js: the traffic categories the server's counters (GET /healthz?traffic=1) and the browser's
// diagnostics share (host bandwidth, layer 0.4), including this fork's /_v/<tag>/ release prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trafficCategory, TRAFFIC_CATEGORIES } from '../shared/assetPaths.js';

const V = '0123456789abcdef';

test('traffic categories: audio, assets, code, data, other', () => {
  assert.deepEqual([...TRAFFIC_CATEGORIES], ['assets', 'audio', 'code', 'data', 'other']);
  const cases = {
    '/media/bgm/act1': 'audio', '/assets/audio/bgm/a.mp3': 'audio',
    '/assets/char/avatar/a.png': 'assets', '/assets/spine/op/x/front/x.skel': 'assets', '/fonts/f.woff2': 'assets', '/icons/app.svg': 'assets',
    '/packs/foo/art/a.png': 'assets', '/packs/index.json': 'data', '/data/assets.json': 'data', '/data/i18n/en.json': 'data', '/i18n/en.json': 'data',
    '/manifest.json': 'data', '/': 'code', '/index.html': 'code', '/js/main.js': 'code', '/css/theme.css': 'code', '/vendor/pixi.min.js': 'code',
    '/sim/Battle.js': 'code', '/shared/protocol.js': 'code', '/data.js': 'code', '/healthz': 'other', '/favicon.ico': 'other',
  };
  for (const [p, cat] of Object.entries(cases)) assert.equal(trafficCategory(p), cat, p);
});

test('the /_v/<tag>/ release prefix does not change the category', () => {
  const cases = {
    [`/_v/${V}/assets/char/avatar/a.png`]: 'assets',
    [`/_v/${V}/assets/audio/bgm/a.mp3`]: 'audio',
    [`/_v/${V}/media/bgm/act1`]: 'audio',
    [`/_v/${V}/fonts/f.woff2`]: 'assets',
    [`/_v/${V}/data/assets.json`]: 'data',
    [`/_v/${V}/js/main.js`]: 'code',
    [`/_v/${V}/shared/protocol.js`]: 'code',
  };
  for (const [p, cat] of Object.entries(cases)) assert.equal(trafficCategory(p), cat, p);
  // A prefix that is not a release tag (wrong length, upper case, another route) is not stripped.
  assert.equal(trafficCategory('/_v/abc/assets/a.png'), 'other');
  assert.equal(trafficCategory(`/_v/${V.toUpperCase()}/assets/a.png`), 'other');
  assert.equal(trafficCategory(`/api/_v/${V}/assets/a.png`), 'other');
});
