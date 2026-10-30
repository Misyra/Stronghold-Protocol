// test/resources/pack-preload.test.js — 分包预载的分流决策与写入：只有「已选文件缺 25% 以上」的包才整个拉，
// 整包通过 SHA-1 后逐条交给 store.importEntries（store 用桩替代，字节与顺序都断言到）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preloadTransportPacks } from '../../public/js/resources/index.js';
import { fetchTransportPack, downloadTransportPack } from '../../public/js/resources/transport.js';
import { readTransportPack } from '../../public/js/resources/archive.js';

const encoder = new TextEncoder();
const sha1 = async (bytes) => {
  const d = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

async function storedZip(entries, doc) {
  const parts = []; const central = []; let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.byteLength; };
  const add = (name, body) => {
    const n = encoder.encode(name);
    const h = new Uint8Array(30 + n.byteLength); const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
    dv.setUint32(18, body.byteLength, true); dv.setUint32(22, body.byteLength, true);
    dv.setUint16(26, n.byteLength, true);
    h.set(n, 30);
    const at = offset; push(h); push(body);
    central.push({ n, size: body.byteLength, at });
  };
  for (const [name, body] of entries) add(name, body);
  add('stronghold-resources.json', encoder.encode(JSON.stringify(doc)));
  const cdStart = offset;
  for (const c of central) {
    const h = new Uint8Array(46 + c.n.byteLength); const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
    dv.setUint32(20, c.size, true); dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.n.byteLength, true); dv.setUint32(42, c.at, true);
    h.set(c.n, 46); push(h);
  }
  const cdSize = offset - cdStart;
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
  push(eocd);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at2 = 0; for (const p of parts) { out.set(p, at2); at2 += p.byteLength; }
  return out;
}

async function makePack(files) {
  const bodies = files.map((f) => encoder.encode('bytes:' + f.url));
  const rows = [];
  for (let i = 0; i < files.length; i++) rows.push({ url: files[i].url, hash: (await sha1(bodies[i])).slice(0, 12), size: bodies[i].byteLength });
  const doc = { format: 'stronghold-resource-zip', version: 2, files: rows.map((r, i) => ({ path: 'resources/' + i, ...r })) };
  const zip = await storedZip(rows.map((r, i) => ['resources/' + i, bodies[i]]), doc);
  return { pack: { id: 'p1', url: 'https://cdn.test/resource-packs/p1.zip', size: zip.byteLength, sha1: await sha1(zip), tier: 1, files: rows }, zip };
}

function stubStore(files, present = []) {
  const got = [];
  return {
    got,
    manifest: { version: 'v1' },
    files,
    selectedFiles: files,
    keyOf: (url) => url,
    status: async () => ({ present: new Set(present) }),
    importEntries: async (entries) => { let imported = 0; for await (const e of entries) { got.push({ file: e.files[0], size: e.size, bytes: [...e.read()] }); imported++; } return { imported }; },
  };
}

test('缺得够多才走分包：整包拉下来逐条写进 store', async () => {
  const files = [{ url: '/assets/a.png', tier: 1, hash: '', size: null }, { url: '/assets/b.png', tier: 1, hash: '', size: null }];
  const { pack, zip } = await makePack(files);
  for (let i = 0; i < files.length; i++) { files[i].hash = pack.files[i].hash; files[i].size = pack.files[i].size; }
  const store = stubStore(files);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(zip);
  try {
    const out = await preloadTransportPacks(store, [pack], [1], await store.status(), new AbortController().signal);
    assert.equal(out.imported, 2);
    assert.deepEqual(store.got.map((g) => g.file.url), ['/assets/a.png', '/assets/b.png'], '按包内顺序写入');
    assert.deepEqual(store.got[0].bytes, [...encoder.encode('bytes:/assets/a.png')], '字节原样');
  } finally { globalThis.fetch = realFetch; }
});

test('缺得少就不拉整包；档位不符也不拉', async () => {
  const files = [{ url: '/assets/a.png', tier: 1, hash: '', size: null }, { url: '/assets/b.png', tier: 1, hash: '', size: null }];
  const { pack } = await makePack(files);
  for (let i = 0; i < files.length; i++) { files[i].hash = pack.files[i].hash; files[i].size = pack.files[i].size; }
  const mostlyCached = stubStore(files, ['/assets/a.png', '/assets/b.png']);
  assert.equal((await preloadTransportPacks(mostlyCached, [pack], [1], await mostlyCached.status(), new AbortController().signal)).imported, 0);
  const wrongTier = stubStore(files);
  assert.equal((await preloadTransportPacks(wrongTier, [pack], [2], await wrongTier.status(), new AbortController().signal)).imported, 0);
});

test('语种未全选时不拉混合分包，也不导入未勾选的资源', async () => {
  const files = ['cn', 'en'].map((lang) => ({ url: `/assets/audio/voice/${lang}/test.mp3`, tier: 2 }));
  const { pack } = await makePack(files);
  pack.tier = 2;
  const mapped = files.map((file, i) => ({ ...file, hash: pack.files[i].hash, size: pack.files[i].size }));
  const store = stubStore(mapped);
  store.selectedFiles = mapped.slice(0, 1);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('must not fetch a pack with unselected languages'); };
  try {
    assert.equal((await preloadTransportPacks(store, [pack], [2], await store.status(), new AbortController().signal)).imported, 0);
    assert.deepEqual(store.got, []);
  } finally { globalThis.fetch = realFetch; }
});

test('CDN 地址的分包与旧 ZIP 内的站内路径保持同一资源身份', async (t) => {
  const { pack, zip } = await makePack([{ url: '/assets/a.png' }]);
  pack.files = pack.files.map((f) => ({ ...f, url: 'https://cdn.test' + f.url }));
  const store = stubStore(pack.files.map((f) => ({ ...f, tier: 1 })));
  t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  assert.equal((await preloadTransportPacks(store, [pack], [1], null, new AbortController().signal)).imported, 1);
  assert.equal(store.got[0].file.url, 'https://cdn.test/assets/a.png');
});

test('可选资源缺省状态会先检查缓存，已导入的旧大包不触发 ZIP 网络下载', async (t) => {
  const { pack } = await makePack([{ url: '/assets/a.png' }]);
  pack.tier = 2;
  const store = stubStore(pack.files.map((f) => ({ ...f, tier: 2 })), ['/assets/a.png']);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('already cached'); });
  assert.equal((await preloadTransportPacks(store, [pack], [2], null, new AbortController().signal)).imported, 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test('分包中已下架或旧指纹条目不阻止其余当前资源整包导入', async (t) => {
  const { pack, zip } = await makePack([{ url: '/assets/bond/miraShip.png' }, { url: '/assets/retired.png' }, { url: '/assets/updated.png' }]);
  const current = [pack.files[0], { ...pack.files[2], hash: 'abcdef123456' }].map((file) => ({ ...file, tier: 1 }));
  const store = stubStore(current);
  const calls = t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  assert.equal((await preloadTransportPacks(store, [pack], [1], null, new AbortController().signal)).imported, 1);
  assert.equal(calls.mock.callCount(), 1);
  assert.deepEqual(store.got.map((entry) => entry.file.url), ['/assets/bond/miraShip.png']);
});

test('合并皮肤包只导入当前选择的皮肤，其他皮肤不写入缓存', async (t) => {
  const { pack, zip } = await makePack([{ url: '/assets/char/skin/a.png' }, { url: '/assets/char/skin/b.png' }]);
  pack.group = 'skin'; pack.tier = 2;
  const files = pack.files.map((file, index) => ({ ...file, tier: 2, skin: `char_${index}/outfit` }));
  const store = stubStore(files); store.selectedFiles = files.slice(0, 1);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  assert.equal((await preloadTransportPacks(store, [pack], [2], null, new AbortController().signal)).imported, 1);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(store.got.map((entry) => entry.file.url), [files[0].url]);
});

test('皮肤预载少量补缺仍使用合并包，全部缓存后不再下载', async (t) => {
  const { pack, zip } = await makePack(Array.from({ length: 10 }, (_, i) => ({ url: `/assets/char/skin/${i}.png` })));
  pack.group = 'skin'; pack.tier = 2;
  const files = pack.files.map((file, index) => ({ ...file, tier: 2, skin: `char_${index}/outfit` }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  const partial = stubStore(files, files.slice(1).map((file) => file.url));
  assert.equal((await preloadTransportPacks(partial, [pack], [2], null, new AbortController().signal)).imported, 10);
  assert.equal(fetch.mock.callCount(), 1);
  const complete = stubStore(files, files.map((file) => file.url));
  assert.equal((await preloadTransportPacks(complete, [pack], [2], null, new AbortController().signal)).imported, 0);
  assert.equal(fetch.mock.callCount(), 1);
});

test('ModelScope 失败后尝试 CDN，坏包不会阻止后续分包', async (t) => {
  const a = await makePack([{ url: '/assets/a.png' }]);
  const b = await makePack([{ url: '/assets/b.png' }]);
  a.pack.id = 'a'; a.pack.url = 'https://cdn.test/resource-packs/a.zip';
  b.pack.id = 'b'; b.pack.url = 'https://cdn.test/resource-packs/b.zip';
  b.pack.urls = ['https://modelscope.cn/datasets/Misyra/Arknight_Assets/resolve/master/b.zip'];
  const store = stubStore([...a.pack.files, ...b.pack.files].map((f) => ({ ...f, tier: 1 })));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return url === b.pack.url ? new Response(b.zip) : new Response('missing', { status: 404 });
  });
  assert.equal((await preloadTransportPacks(store, [a.pack, b.pack], [1], null, new AbortController().signal)).imported, 1);
  assert.deepEqual(store.got.map((f) => f.file.url), ['/assets/b.png']);
  assert.ok(calls.indexOf(b.pack.urls[0]) < calls.indexOf(b.pack.url));
});

test('分包最多两路网络并发，缓存导入串行且进度可见', async (t) => {
  const fixtures = await Promise.all(['a', 'b', 'c'].map((name) => makePack([{ url: `/assets/${name}.png` }])));
  fixtures.forEach(({ pack }, i) => { pack.id = `p${i}`; pack.url = `https://cdn.test/resource-packs/p${i}.zip`; });
  const store = stubStore(fixtures.flatMap(({ pack }) => pack.files.map((f) => ({ ...f, tier: 1 }))));
  let active = 0; let peak = 0; let imports = 0; let peakImports = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return new Response(fixtures.find(({ pack }) => pack.url === url).zip);
  });
  const original = store.importEntries;
  store.importEntries = async (...args) => {
    assert.equal(args[1].concurrency, 1, 'one cache import lane');
    peakImports = Math.max(peakImports, ++imports);
    try { await new Promise((resolve) => setTimeout(resolve, 10)); return await original(...args); }
    finally { imports--; }
  };
  const progress = [];
  const result = await preloadTransportPacks(store, fixtures.map((f) => f.pack), [1], null,
    new AbortController().signal, (p) => progress.push(p));
  assert.equal(result.imported, 3);
  assert.equal(peak, 2);
  assert.equal(peakImports, 1);
  assert.ok(progress.some((p) => p.loaded > 0));
});

test('配额错误停止分包，保留原始错误并等待所有并发任务结束', async (t) => {
  const { pack, zip } = await makePack([{ url: '/assets/a.png' }]);
  const store = stubStore(pack.files.map((f) => ({ ...f, tier: 1 })));
  const error = new DOMException('quota', 'QuotaExceededError');
  store.importEntries = async () => { throw error; };
  t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  await assert.rejects(preloadTransportPacks(store, [pack], [1], null, new AbortController().signal), (err) => err === error);
});

test('必备慢包不阻止后续可选包，且必备包优先占用下载通道', async (t) => {
  const fixtures = await Promise.all(['slow', 'fast', 'next'].map((name) => makePack([{ url: `/assets/${name}.png` }])));
  fixtures.forEach(({ pack }, i) => { pack.id = `p${i}`; pack.url = `https://cdn.test/resource-packs/p${i}.zip`; });
  fixtures[2].pack.tier = 2;
  const store = stubStore(fixtures.flatMap(({ pack }) => pack.files.map((f) => ({ ...f, tier: pack.tier }))));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    if (url === fixtures[0].pack.url) await gate;
    return new Response(fixtures.find(({ pack }) => pack.url === url).zip);
  });
  let continued;
  const importedNext = new Promise((resolve) => { continued = resolve; });
  store.importEntries = async (entries) => {
    let imported = 0;
    for await (const entry of entries) {
      store.got.push(entry.files[0].url); imported++;
      if (entry.files[0].url === '/assets/next.png') continued();
    }
    return { imported };
  };
  const pending = preloadTransportPacks(store, [fixtures[2].pack, fixtures[0].pack, fixtures[1].pack], [1, 2], null, new AbortController().signal);
  t.after(() => pending);
  await Promise.race([importedNext, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('slow pack blocked later imports')), 2000);
    importedNext.then(() => clearTimeout(timer));
  })]);
  assert.deepEqual(store.got, ['/assets/fast.png', '/assets/next.png']);
  assert.deepEqual(calls.slice(0, 2), [fixtures[0].pack.url, fixtures[1].pack.url]);
  release();
  assert.equal((await pending).imported, 3);
});

test('线路响应超时先重试同一压缩包，成功后不回退逐文件或备用线路', async () => {
  const { pack, zip } = await makePack([{ url: '/assets/a.png' }]);
  const primary = 'https://modelscope.cn/datasets/Misyra/Arknight_Assets/resolve/master/a.zip';
  pack.urls = [primary];
  const calls = [], routes = [], progress = [];
  const entries = await fetchTransportPack(pack, { headerMs: 10, timeoutMs: 1000, retryDelayMs: 1,
    onRoute: (route) => routes.push(route), onProgress: (loaded) => progress.push(loaded),
    fetcher: async (url, { signal }) => {
      calls.push(url);
      if (calls.length === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return new Response(zip);
    } });
  assert.deepEqual(calls, [primary, primary]);
  assert.equal(entries.length, 1);
  assert.ok(routes.some((route) => route.retrying && route.attempt === 2));
  assert.equal(progress.at(-1), zip.byteLength);
});

test('线路重试等待期间暂停，不再请求其他包或备用线路', async () => {
  const { pack } = await makePack([{ url: '/assets/a.png' }]);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchTransportPack(pack, { signal: controller.signal, retryDelayMs: 1,
    onRoute: ({ retrying }) => { if (retrying) controller.abort(); },
    fetcher: async () => { calls++; throw new TypeError('network offline'); } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('raw ZIP download finishes independently; corrupt bytes fail only in the validation stage', async () => {
  const { pack, zip } = await makePack([{ url: '/assets/a.png' }]);
  const corrupt = zip.slice(); corrupt[corrupt.length - 1] ^= 1;
  const bytes = await downloadTransportPack(pack, { fetcher: async () => new Response(corrupt) });
  assert.deepEqual(bytes, corrupt);
  await assert.rejects(readTransportPack(new Response(bytes), pack), /整包校验失败/);
});

test('a stalled response body is cancelled and retried without waiting for the overall deadline', async () => {
  const { pack, zip } = await makePack([{ url: '/assets/a.png' }]);
  let calls = 0, cancelled = 0;
  const bytes = await downloadTransportPack(pack, { idleMs: 10, headerMs: 1000, timeoutMs: 1000, retryDelayMs: 1,
    fetcher: async () => ++calls === 1 ? new Response(new ReadableStream({
      start(stream) { stream.enqueue(zip.subarray(0, 1)); }, cancel() { cancelled++; },
    })) : new Response(zip) });
  assert.deepEqual(bytes, zip); assert.equal(calls, 2); assert.equal(cancelled, 1);
});

test('a continuously progressing transfer may exceed the idle timeout without being restarted', async () => {
  const { pack, zip } = await makePack([{ url: '/assets/a.png' }]);
  let offset = 0, calls = 0;
  const start = performance.now();
  const bytes = await downloadTransportPack(pack, { idleMs: 50, headerMs: 50, timeoutMs: 2000,
    fetcher: async () => {
      calls++;
      return new Response(new ReadableStream({ async pull(stream) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (offset === zip.length) { stream.close(); return; }
        const end = Math.min(offset + 16, zip.length); stream.enqueue(zip.subarray(offset, end)); offset = end;
      } }));
    } });
  assert.deepEqual(bytes, zip); assert.equal(calls, 1); assert.ok(performance.now() - start > 50);
});

test('transiently failed packs retry after healthy packs, without downloading healthy packs twice', async (t) => {
  const a = await makePack([{ url: '/assets/slow.png' }]);
  const b = await makePack([{ url: '/assets/healthy.png' }]);
  a.pack.id = 'slow'; b.pack.id = 'healthy';
  a.pack.url = 'https://cdn.test/resource-packs/slow.zip'; b.pack.url = 'https://cdn.test/resource-packs/healthy.zip';
  const store = stubStore([...a.pack.files, ...b.pack.files].map((file) => ({ ...file, tier: 1 })));
  let slow = 0, healthy = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === b.pack.url) { healthy++; return new Response(b.zip); }
    if (++slow <= 2) return new Response('temporarily unavailable', { status: 503 });
    return new Response(a.zip);
  });
  const progress = [];
  const result = await preloadTransportPacks(store, [a.pack, b.pack], [1], null, new AbortController().signal, (p) => progress.push(p));
  assert.equal(result.imported, 2); assert.equal(slow, 3); assert.equal(healthy, 1);
  assert.deepEqual(store.got.map((entry) => entry.file.url), ['/assets/healthy.png', '/assets/slow.png']);
  assert.ok(progress.some((p) => p.deferred && p.packNumber === 1));
});
