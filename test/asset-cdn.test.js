import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { assetCdnSettings, assetCdnUrl } from '../shared/assetCdn.js';
import { resourceUrl, resourceCache } from '../public/js/resourceUrl.js';
import { mediaUrl } from '../public/js/media.js';
import { validSpine } from '../public/js/assets.js';

test('CDN settings validate public bases and rewrite art without leaking the game version', () => {
  assert.deepEqual(assetCdnSettings(' https://game.misyra.com/ ', ''), { base: 'https://game.misyra.com', version: '' });
  for (const bad of ['javascript:alert(1)', '/cdn', 'https://u:p@cdn.example', 'https://cdn.example?v=1', 'https://cdn.example/#x']) {
    assert.throws(() => assetCdnSettings(bad));
  }
  assert.throws(() => assetCdnSettings('https://cdn.example', 'not-a-version'));
  assert.throws(() => assetCdnSettings('', '1234567890abcdef'));
  const cdn = assetCdnSettings('https://cdn.example/static', '1234567890abcdef');
  assert.equal(assetCdnUrl('/_v/aaaaaaaaaaaaaaaa/assets/x.skel', cdn), 'https://cdn.example/static/_v/1234567890abcdef/assets/x.skel');
  assert.equal(assetCdnUrl('/fonts/a.woff2?x=1#f', cdn), 'https://cdn.example/static/_v/1234567890abcdef/fonts/a.woff2?x=1#f');
  assert.equal(validSpine({ skel: 'https://cdn.example/a.skel', atlas: 'https://cdn.example/a.atlas', anims: {} }), true);
  for (const skel of ['javascript:alert(1).skel', 'data:application/octet-stream,x.skel', 'https://u:p@cdn.example/a.skel', 'https://cdn.example/a.png']) {
    assert.equal(validSpine({ skel, atlas: 'x', anims: {} }), false);
  }
  for (const url of ['/data/assets.json', '/js/main.js', '/vendor/pixi.min.js', '/api/rooms/ABCD/status', '/ws', 'https://third.example/assets/x.png']) {
    assert.equal(assetCdnUrl(url, cdn), url);
  }
});

test('browser helpers honor CDN configuration and preserve remote audio URLs', (t) => {
  const previous = globalThis.__spAssetCdn;
  t.after(() => { if (previous === undefined) delete globalThis.__spAssetCdn; else globalThis.__spAssetCdn = previous; });
  globalThis.__spAssetCdn = assetCdnSettings('https://cdn.example');
  assert.equal(resourceUrl('/_v/aaaaaaaaaaaaaaaa/assets/a.png'), 'https://cdn.example/assets/a.png');
  assert.equal(resourceCache(resourceUrl('/assets/a.png')), 'default');
  assert.equal(resourceUrl('/data/chess.json', 'aaaaaaaaaaaaaaaa'), '/_v/aaaaaaaaaaaaaaaa/data/chess.json');
  assert.equal(mediaUrl(resourceUrl('/assets/audio/bgm/a.mp3'), 'https://game.example'), 'https://cdn.example/assets/audio/bgm/a.mp3');
  globalThis.__spAssetCdn = assetCdnSettings('https://cdn.example', '1234567890abcdef');
  assert.equal(resourceCache(resourceUrl('/assets/local/tiles.json')), 'default');
});

test('two hosts keep independent release versions, serve public CORS and retain local code/data/socket routes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
  };
  write('public/index.html', '<html><head><link href="/fonts/fonts.css"><script type="importmap">{"imports":{"preact":"/vendor/preact.js"}}</script></head><script src="/js/main.js"></script></html>');
  write('public/js/main.js', 'export const ready = true;');
  write('public/css/a.css', "a{background:url('/assets/x.png')}");
  write('public/fonts/fonts.css', "@font-face{font-family:x;src:url('/fonts/a.woff2')}");
  write('public/fonts/a.woff2', 'font');
  write('public/assets/x.png', 'image');
  write('public/assets/x.skel', 'skeleton');
  write('public/assets/x.atlas', 'x.png\nsize: 1,1\n');
  write('public/assets/audio/a.mp3', '0123456789');
  write('public/assets/local/tiles.json', JSON.stringify({ source: { D: { path: '/assets/x.png' } } }));
  write('data/assets.json', JSON.stringify({ spine: { skel: '/assets/x.skel', atlas: '/assets/x.atlas', textures: ['/assets/x.png'], anims: {} }, audio: '/assets/audio/a.mp3', foreign: 'https://third.example/x.png' }));
  write('data/chess.json', '{}');
  const opts = { port: 0, host: '127.0.0.1', quiet: true, workers: 0, publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared') };
  const remote = await startServer(opts);
  t.after(() => remote.close());
  const remoteHealth = await (await fetch(remote.url + '/healthz')).json();
  const game = await startServer({ ...opts, assetsCdn: remote.url, assetsCdnVersion: remoteHealth.artVersion });
  t.after(() => game.close());
  const health = await (await fetch(game.url + '/healthz')).json();
  assert.notEqual(health.artVersion, remoteHealth.artVersion);
  assert.notEqual(health.build, remoteHealth.build);
  assert.equal(health.assetsCdnVersion, remoteHealth.artVersion);
  const localPrefix = `/_v/${health.build}`;
  const remotePrefix = `${remote.url}/_v/${remoteHealth.artVersion}`;
  const html = await (await fetch(game.url + '/')).text();
  assert.ok(html.includes(`href="${remotePrefix}/fonts/fonts.css"`));
  assert.ok(html.includes(`src="${localPrefix}/js/main.js"`));
  const imports = JSON.parse(html.match(/type="importmap">(.*?)<\/script>/)[1]).imports;
  assert.equal(imports.preact, localPrefix + '/vendor/preact.js');
  const manifest = await (await fetch(game.url + localPrefix + '/data/assets.json')).json();
  assert.ok(validSpine(manifest.spine));
  assert.equal(manifest.spine.skel, remotePrefix + '/assets/x.skel');
  assert.equal(manifest.foreign, 'https://third.example/x.png');
  assert.equal(new URL('x.png', manifest.spine.atlas).href, manifest.spine.textures[0]);
  const image = await fetch(manifest.spine.textures[0], { headers: { Origin: game.url } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('access-control-allow-origin'), '*');
  assert.match(image.headers.get('cache-control'), /immutable/);
  const conditional = await fetch(manifest.spine.textures[0], { headers: { 'If-None-Match': image.headers.get('etag'), Origin: game.url } });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get('access-control-allow-origin'), '*');
  const preflight = await fetch(manifest.audio, { method: 'OPTIONS', headers: { Origin: game.url, 'Access-Control-Request-Headers': 'Range' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Range');
  const audio = await fetch(manifest.audio, { headers: { Origin: game.url, Range: 'bytes=2-5' } });
  assert.equal(audio.status, 206);
  assert.equal(await audio.text(), '2345');
  assert.equal(audio.headers.get('access-control-allow-origin'), '*');
  for (const path of ['/healthz', localPrefix + '/data/assets.json', localPrefix + '/js/main.js']) {
    assert.equal((await fetch(game.url + path)).headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await fetch(game.url + '/api/rooms/ABCD/status', { method: 'OPTIONS' })).status, 405);
  const css = await (await fetch(game.url + localPrefix + '/css/a.css')).text();
  assert.ok(css.includes(remotePrefix + '/assets/x.png'));
  const board = await (await fetch(remotePrefix + '/assets/local/tiles.json')).json();
  assert.equal(board.source.D.path, `/_v/${remoteHealth.artVersion}/assets/x.png`);

  const legacy = await startServer({ ...opts, assetsCdn: remote.url });
  t.after(() => legacy.close());
  const legacyHealth = await (await fetch(legacy.url + '/healthz')).json();
  const legacyManifest = await (await fetch(legacy.url + `/_v/${legacyHealth.build}/data/assets.json`)).json();
  assert.equal(legacyManifest.spine.skel, remote.url + '/assets/x.skel', 'an older CDN has no release route');
});
