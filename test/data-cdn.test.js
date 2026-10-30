// 数据 CDN（SP_DATA_CDN）在客户端这条线：服务端把 DATA_CDN 写进 /js/asset-cdn.js，main.js 挂到
// __spAssetCdn.dataBase，游戏的 JSON 加载器与浏览器模拟都从它取根路径。此前本仓库只导出、不消费 ——
// 配了数据 CDN 也还是回源站取 /data/，等于没配。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dataBasePath, i18nUrlFor } from '../public/js/resourceUrl.js';
import { createDataStore } from '../public/js/data.js';

const withCdn = async (value, run) => {
  const saved = globalThis.__spAssetCdn;
  try {
    if (value === undefined) delete globalThis.__spAssetCdn; else globalThis.__spAssetCdn = value;
    return await run();
  } finally {
    if (saved === undefined) delete globalThis.__spAssetCdn; else globalThis.__spAssetCdn = saved;
  }
};

test('dataBasePath: 配了数据 CDN 就走它，否则本站 /data/', async () => {
  await withCdn(undefined, () => assert.equal(dataBasePath(), '/data/'));
  await withCdn({ dataBase: 'https://data.example/game/' }, () => assert.equal(dataBasePath(), 'https://data.example/game/data/'));
  await withCdn({ dataBase: 'https://data.example/game' }, () => assert.equal(dataBasePath(), 'https://data.example/game/data/'));
  await withCdn({ dataBase: '/cdn' }, () => assert.equal(dataBasePath(), '/cdn/data/'), 'a same-origin prefix works too');
  await withCdn({ dataBase: '' }, () => assert.equal(dataBasePath(), '/data/'));
});

test('createDataStore 从数据 CDN 取 JSON，显式 base 仍然优先', async () => {
  await withCdn({ dataBase: 'https://data.example' }, async () => {
    const urls = [];
    const store = createDataStore({ fetch: async (url) => { urls.push(url); return { ok: true, json: async () => ({}) }; }, retryDelays: [], timeoutMs: 0 });
    await store.loadAll('chess');
    assert.ok(urls.length > 0, 'it fetched something');
    assert.ok(urls.every((u) => String(u).startsWith('https://data.example/data/')), JSON.stringify(urls));
  });
  await withCdn({ dataBase: 'https://data.example' }, async () => {
    const urls = [];
    const store = createDataStore({ base: '/custom-data/', fetch: async (url) => { urls.push(url); return { ok: true, json: async () => ({}) }; }, retryDelays: [], timeoutMs: 0 });
    await store.loadAll('chess');
    assert.ok(urls.every((u) => String(u).startsWith('/custom-data/')), JSON.stringify(urls));
  });
});

test('没配数据 CDN 时仍然同源', async () => {
  await withCdn(undefined, async () => {
    const urls = [];
    const store = createDataStore({ fetch: async (url) => { urls.push(url); return { ok: true, json: async () => ({}) }; }, retryDelays: [], timeoutMs: 0 });
    await store.loadAll('chess');
    assert.ok(urls.every((u) => String(u).startsWith('/data/')), JSON.stringify(urls));
  });
});

test('界面语言 JSON 跟着素材 CDN 走，语言包目录留在源站', async () => {
  await withCdn(undefined, () => assert.equal(i18nUrlFor('/i18n/en.json'), '/i18n/en.json'));
  await withCdn({ base: 'https://art.example/game/' }, () => {
    assert.equal(i18nUrlFor('/i18n/en.json'), 'https://art.example/game/i18n/en.json');
    assert.equal(i18nUrlFor('/i18n/zh-TW.json?v=2'), 'https://art.example/game/i18n/zh-TW.json?v=2');
    assert.equal(i18nUrlFor('/packs/qaa/ui.json'), '/packs/qaa/ui.json', 'a pack folder is served by this server');
    assert.equal(i18nUrlFor('https://other.example/i18n/en.json'), 'https://other.example/i18n/en.json');
  });
  await withCdn({ base: 'https://art.example' }, () => assert.equal(i18nUrlFor('/data/i18n/en.json'), '/data/i18n/en.json', 'the data loader owns that one'));
});
