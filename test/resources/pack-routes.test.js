// 资源分包的部署侧线路（SP_RESOURCE_PACK_ROUTES）—— 取自 xinhai-ai/Stronghold-Protocol 的
// shared/resourcePackRoutes.js：服务端把镜像地址写进清单的 pack.urls，客户端按顺序试（server/http/static.js、
// public/js/resources/transport.js 的 fetchTransportPack）。这里锁住「部署怎么写、写错了什么报错、清单里长什么样」。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isResourcePackUrl, parseResourcePackRoutes, resourcePackUrls, routeResourcePacks } from '../../shared/resourcePackRoutes.js';
import { fetchTransportPack } from '../../public/js/resources/transport.js';
import { createStaticHandler } from '../../server/http/static.js';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const pack = { id: 'ui-01', url: '/packs/ui-01-0123456789ab.zip', files: [{ url: '/assets/ui/a.png', hash: 'a'.repeat(16) }] };

describe('SP_RESOURCE_PACK_ROUTES 的解析', () => {
  test('不配就是不配', () => {
    assert.deepEqual(parseResourcePackRoutes(undefined), []);
    assert.deepEqual(parseResourcePackRoutes(''), []);
    assert.deepEqual(parseResourcePackRoutes('   '), []);
    assert.deepEqual(parseResourcePackRoutes('[]'), []);
  });

  test('目录、裸主机、模板和整包 ZIP 各自补成可用的地址', () => {
    assert.deepEqual(parseResourcePackRoutes('["https://mirror.example/packs"]'), ['https://mirror.example/packs/{file}']);
    assert.deepEqual(parseResourcePackRoutes('["mirror.example"]'), ['https://mirror.example/{file}'], 'a bare host is https');
    assert.deepEqual(parseResourcePackRoutes('["https://m.example/packs/"]'), ['https://m.example/packs/{file}'], 'a trailing slash does not double up');
    assert.deepEqual(parseResourcePackRoutes('["/local/packs"]'), ['/local/packs/{file}'], 'a same-origin directory works too');
    assert.deepEqual(parseResourcePackRoutes('["https://m.example/p/{id}.zip"]'), ['https://m.example/p/{id}.zip'], 'a template is kept as written');
    assert.deepEqual(parseResourcePackRoutes('["https://m.example/all.zip"]'), ['https://m.example/all.zip'], 'a whole-ZIP URL is kept as written');
    assert.deepEqual(parseResourcePackRoutes(['https://a.example/x', 'b.example/y']), ['https://a.example/x/{file}', 'https://b.example/y/{file}'], 'an array is accepted as well as JSON text');
  });

  test('写错的值在启动时就报错，而不是把坏地址发给客户端', () => {
    for (const bad of ['not json', '{"a":1}', '["   "]', '["ftp://m.example/packs"]', '["https://m.example/a.zip?x=1"]', '["https://m.example/{unknown}.zip"]']) {
      assert.throws(() => parseResourcePackRoutes(bad), /SP_RESOURCE_PACK_ROUTES/, `${bad} must be refused`);
    }
  });

  test('isResourcePackUrl: 只认 http(s) 的 .zip，且不带凭据、查询、空白', () => {
    assert.equal(isResourcePackUrl('/packs/a.zip'), true);
    assert.equal(isResourcePackUrl('https://m.example/a.zip'), true);
    assert.equal(isResourcePackUrl('https://m.example/a.ZIP'), false, 'their rule is a literal .zip');
    for (const bad of ['//m.example/a.zip', 'm.example/a.zip', '/packs/a.txt', 'https://u:p@m.example/a.zip', '/packs/a.zip?x=1', '/packs/a.zip#x', ' /packs/a.zip', 'javascript:alert(1)//a.zip']) {
      assert.equal(isResourcePackUrl(bad), false, bad);
    }
  });
});

describe('清单里的分包地址', () => {
  test('CDN 基址只改写站内地址，绝对地址与非素材文件不动', () => {
    const [routed] = routeResourcePacks([{ ...pack, files: [...pack.files, { url: '/packs/inner.json' }] }], 'https://cdn.example/');
    assert.equal(routed.url, 'https://cdn.example/packs/ui-01-0123456789ab.zip', 'the pack itself follows the CDN, without a double slash');
    assert.equal(routed.files[0].url, 'https://cdn.example/assets/ui/a.png', 'and its asset files');
    assert.equal(routed.files[1].url, '/packs/inner.json', 'anything else is left alone');

    const [absolute] = routeResourcePacks([{ ...pack, url: 'https://other.example/ui-01.zip' }], 'https://cdn.example');
    assert.equal(absolute.url, 'https://other.example/ui-01.zip', 'an absolute pack URL is already routed');
  });

  test('镜像排在前面，当前地址永远留一个在最后，重复的去掉', () => {
    const routes = parseResourcePackRoutes('["https://mirror.example/packs", "https://mirror.example/packs", "/local/packs"]');
    const [routed] = routeResourcePacks([pack], '', routes);
    const file = 'ui-01-0123456789ab.zip';
    assert.deepEqual(routed.urls, [
      `https://mirror.example/packs/${file}`,
      `/local/packs/${file}`,
      '/packs/ui-01-0123456789ab.zip',
    ], 'first the mirrors, last the address the pack came from');
    assert.equal(resourcePackUrls(pack, routes).at(-1), pack.url, 'the current address is never dropped');
  });

  test('模板里的 {id} 与 {file} 都展开；部署清单自带的 urls 被忽略', () => {
    const [routed] = routeResourcePacks([{ ...pack, urls: ['https://stale.example/x.zip'] }], '', parseResourcePackRoutes('["https://m.example/p/{id}/{file}"]'));
    assert.deepEqual(routed.urls, ['https://m.example/p/ui-01/ui-01-0123456789ab.zip', '/packs/ui-01-0123456789ab.zip']);
    assert.equal(routeResourcePacks([pack], '')[0].urls, undefined, 'no routes, no urls field');
  });

  test('空清单与老清单都不炸', () => {
    assert.deepEqual(routeResourcePacks([], 'https://cdn.example'), []);
    assert.deepEqual(routeResourcePacks(undefined), []);
    assert.deepEqual(routeResourcePacks([{ id: 'x', url: '/x.zip', files: null }], '')[0].files, null);
  });
});

describe('客户端的镜像回退', () => {
  test('逐条试，坏的跳过，当前地址永远最后试', async () => {
    const seen = [];
    const fetcher = async (url) => { seen.push(url); return { ok: false, status: 503, body: { cancel: async () => {} } }; };
    const pack = {
      id: 'ui-01', url: '/packs/ui-01-0123456789ab.zip', files: [],
      urls: [
        'https://mirror.example/packs/ui-01-0123456789ab.zip',
        'https://backup.example/packs/ui-01-0123456789ab.zip',
        '/packs/ui-01-0123456789ab.zip',            // the same as pack.url: tried once, at the end
        'not a url.zip',                            // dropped by isResourcePackUrl
      ],
    };
    await assert.rejects(fetchTransportPack(pack, { fetcher, idleMs: 0, timeoutMs: 10_000 }), /资源分包 HTTP 503/);
    assert.deepEqual(seen, [
      'https://mirror.example/packs/ui-01-0123456789ab.zip',
      'https://backup.example/packs/ui-01-0123456789ab.zip',
      // the pack's own address is fetched as written: in a browser it resolves against the page
      '/packs/ui-01-0123456789ab.zip',
    ], 'mirrors first, the pack\'s own address last, no duplicates, no invalid entries');
  });

  test('没有镜像时只试一次', async () => {
    const seen = [];
    const fetcher = async (url) => { seen.push(url); return { ok: false, status: 404, body: { cancel: async () => {} } }; };
    await assert.rejects(fetchTransportPack({ id: 'x', url: '/packs/x.zip', files: [] }, { fetcher, idleMs: 0, timeoutMs: 10_000 }));
    assert.equal(seen.length, 1);
  });
});

describe('/data/resource-packs.json 的部署侧改写', () => {
  /** A temp install with a resource-pack index on disk, served by the real static handler. */
  async function served({ index, cdnBase = '', routes = [] }) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pack-data-'));
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pack-pub-'));
    fs.writeFileSync(path.join(dataDir, 'resource-packs.json'), JSON.stringify(index));
    const handler = createStaticHandler({
      publicDir, dataDir, sharedDir: path.join(process.cwd(), 'shared'), cdnBase,
      resourcePackRoutes: routes, log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const srv = http.createServer((req, res) => {
      const [p, q] = (req.url || '/').split('?');
      handler(req, res, p, q || '');
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address();
    return {
      url: 'http://127.0.0.1:' + port + '/data/resource-packs.json',
      close: () => new Promise((resolve) => srv.close(resolve)),
      cleanup: () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(publicDir, { recursive: true, force: true }); },
    };
  }

  const index = {
    format: 'stronghold-resource-pack-index',
    version: 1,
    packs: [
      { id: 'ui-01', url: '/packs/ui-01-0123456789ab.zip', files: [{ url: '/assets/ui/a.png', hash: 'a'.repeat(12) }], urls: ['https://stale.example/x.zip'] },
      { id: 'voice-01', url: 'https://other.example/voice.zip', files: [] },
    ],
  };

  test('镜像线路与 CDN 基址真的出现在客户端读的那份清单里', async () => {
    const routes = parseResourcePackRoutes('["https://mirror.example/packs"]');
    const server = await served({ index, cdnBase: 'https://assets.example', routes });
    try {
      const doc = await (await fetch(server.url)).json();
      assert.equal(doc.format, 'stronghold-resource-pack-index');
      assert.equal(doc.packs[0].url, 'https://assets.example/packs/ui-01-0123456789ab.zip', 'the pack follows the CDN');
      assert.equal(doc.packs[0].files[0].url, 'https://assets.example/assets/ui/a.png', 'and its assets');
      assert.deepEqual(doc.packs[0].urls, [
        'https://mirror.example/packs/ui-01-0123456789ab.zip',
        'https://assets.example/packs/ui-01-0123456789ab.zip',
      ], 'the mirror first, the routed address last');
      assert.equal(doc.packs[1].url, 'https://other.example/voice.zip', 'an absolute pack URL is left alone');
      assert.deepEqual(doc.packs[1].urls, [
        'https://mirror.example/packs/voice.zip',
        'https://other.example/voice.zip',
      ], 'but it still gets the mirror routes — a mirror may hold the same file name');
    } finally { await server.close(); server.cleanup(); }
  });

  test('不配线路时清单原样送出（没有 urls 字段）', async () => {
    const server = await served({ index });
    try {
      const doc = await (await fetch(server.url)).json();
      assert.equal(doc.packs[0].urls, undefined);
      assert.equal(doc.packs[0].url, '/packs/ui-01-0123456789ab.zip');
      assert.equal(doc.packs[0].files[0].url, '/assets/ui/a.png');
    } finally { await server.close(); server.cleanup(); }
  });
});
