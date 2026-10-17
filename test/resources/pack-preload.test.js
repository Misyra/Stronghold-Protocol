// test/resources/pack-preload.test.js — 分包预载的分流决策与写入：只有「已选文件缺 25% 以上」的包才整个拉，
// 整包通过 SHA-1 后逐条交给 store.importEntries（store 用桩替代，字节与顺序都断言到）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preloadTransportPacks } from '../../public/js/resources/index.js';

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
    keyOf: (url) => url,
    status: async () => ({ present: new Set(present) }),
    importEntries: async (entries) => { for await (const e of entries) got.push({ file: e.files[0], size: e.size, bytes: [...e.read()] }); return { imported: got.length }; },
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
