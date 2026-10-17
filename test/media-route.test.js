// /media/… 免扩展名音频路由穿过真实静态层（server/http/static.js → server/http/media.js）。
// 这条路由曾经整条静默 404：上游的 static.js 调 serveMedia 时多传了 query，本分支的 serveMedia 没有这个参数，
// publicDir 被当成查询字符串 —— 浏览器里表现为 BGM/语音全部无声，控制台只有 404。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createStaticHandler } from '../server/http/static.js';

function install() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-media-'));
  const write = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  write('public/index.html', '<html><head></head><body></body></html>');
  write('public/assets/audio/bgm/track.mp3', '0123456789');
  write('public/assets/audio/voice/cn/line.mp3', 'abcdefghij');
  write('shared/a.js', 'export const a = 1;');
  write('data/assets.json', '{}');
  const handler = createStaticHandler({
    publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'),
    sharedDir: path.join(root, 'shared'), simDir: path.join(root, 'sim'),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const srv = http.createServer((req, res) => { const [p, q] = (req.url || '/').split('?'); handler(req, res, p, q || ''); });
  return { root, handler, srv };
}

/** GET a path exactly as written (fetch would resolve ".." before sending). */
function rawStatus(base, raw) {
  const url = new URL(base);
  return new Promise((resolve) => {
    const req = http.request({ host: url.hostname, port: url.port, path: raw, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('ERR'));
    req.end();
  });
}

async function served(run) {
  const inst = install();
  await new Promise((r) => inst.srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + inst.srv.address().port;
  try { return await run(base, inst.handler); }
  finally {
    await new Promise((r) => inst.srv.close(r));
    fs.rmSync(inst.root, { recursive: true, force: true });
  }
}

describe('/media/… 音频路由', () => {
  test('免扩展名路径按扩展名顺序找到文件，并保留 Range', async () => {
    await served(async (base) => {
      const full = await fetch(base + '/media/bgm/track');
      assert.equal(full.status, 200);
      assert.match(full.headers.get('content-type'), /audio\/mpeg/);
      assert.equal(await full.text(), '0123456789');

      const range = await fetch(base + '/media/bgm/track', { headers: { Range: 'bytes=2-5' } });
      assert.equal(range.status, 206);
      assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
      assert.equal(await range.text(), '2345');

      const explicit = await fetch(base + '/media/voice/cn/line.mp3');
      assert.equal(explicit.status, 200, 'an explicit extension works too');
      assert.equal(await explicit.text(), 'abcdefghij');
    });
  });

  test('版本化地址（/_v/<artTag>/media/…）同样可用，并按发布缓存', async () => {
    await served(async (base, handler) => {
      const res = await fetch(base + '/_v/' + handler.artVersion + '/media/bgm/track', { headers: { Range: 'bytes=0-3' } });
      assert.equal(res.status, 206);
      assert.equal(await res.text(), '0123');
      assert.match(res.headers.get('cache-control') || '', /immutable/);
    });
  });

  test('不存在的文件、越界路径与外来的发布 tag 都不会变成 200', async () => {
    await served(async (base) => {
      assert.equal((await fetch(base + '/media/bgm/missing')).status, 404);
      assert.equal((await fetch(base + '/media/bgm/track.png')).status, 404, 'a non-audio extension is not searched');
      // fetch/undici normalises ".." (even encoded): a hostile client sends the raw request line instead
      const traversal = await rawStatus(base, '/media/%2e%2e/shared/a.js');
      assert.ok([403, 404].includes(traversal), 'no escape out of assets/audio');
      assert.ok([403, 404].includes(await rawStatus(base, '/media/../shared/a.js')));
      assert.equal((await fetch(base + '/_v/0123456789abcdef/media/bgm/track')).status, 404);
    });
  });
});
