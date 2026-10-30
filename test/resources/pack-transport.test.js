// test/resources/pack-transport.test.js — 部署端分包（取自 xinhai 的 resources/transport.js 与 archive.js 的
// readTransportPack）在本仓库里的可验证部分：分包索引校验 + 逐条流式读取 + 整包 SHA-1 校验。
//
// 分包文件由 tools/resource_packs.py 在部署端生成（stored ZIP：条目顺序与包的 files[] 一致，最后一个条目是
// stronghold-resources.json）。这里用 vendor 的 zip.js 按同样规则现造一个，喂给读取器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTransportPack } from '../../public/js/resources/archive.js';
import { validateResourcePacks } from '../../public/js/resources/common.js';

const encoder = new TextEncoder();

async function sha1Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 造一个 stored 分包（部署端 tools/resource_packs.py 的产物形状）：局部头 flags=0 / method=0 / 无额外字段，
 * 条目按 files[] 顺序排列，最后一个条目是整包清单，后面才是中央目录与 EOCD —— 读取器只顺序读局部条目。
 */
async function buildPack(urls) {
  const parts = [];
  const central = [];
  const files = [];
  const bodies = new Map();
  let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.byteLength; };
  const addEntry = (name, body) => {
    const nameBytes = encoder.encode(name);
    const header = new Uint8Array(30 + nameBytes.byteLength);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
    dv.setUint32(14, 0, true);
    dv.setUint32(18, body.byteLength, true); dv.setUint32(22, body.byteLength, true);
    dv.setUint16(26, nameBytes.byteLength, true); dv.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    const at = offset;
    push(header); push(body);
    central.push({ name: nameBytes, size: body.byteLength, at });
  };
  for (let i = 0; i < urls.length; i++) {
    const body = encoder.encode('body-' + i);
    bodies.set(urls[i], body);
    files.push({ url: urls[i], hash: (await sha1Hex(body)).slice(0, 12), size: body.byteLength });
    addEntry('resources/' + i, body);
  }
  const doc = { format: 'stronghold-resource-zip', version: 2, files: files.map((f, i) => ({ path: 'resources/' + i, url: f.url, hash: f.hash, size: f.size })) };
  addEntry('stronghold-resources.json', encoder.encode(JSON.stringify(doc)));
  const cdStart = offset;
  for (const c of central) {
    const h = new Uint8Array(46 + c.name.byteLength);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0, true); dv.setUint16(10, 0, true);
    dv.setUint32(16, 0, true); dv.setUint32(20, c.size, true); dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.name.byteLength, true);
    dv.setUint32(42, c.at, true);
    h.set(c.name, 46);
    push(h);
  }
  const cdSize = offset - cdStart;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
  push(eocd);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  return { bytes, files, bodies };
}

test('validateResourcePacks: 只收合法分包，订单/协议/大小不合法都拒', () => {
  const good = { id: 'p1', url: 'https://cdn.test/resource-packs/p1.zip', size: 1000, sha1: 'a'.repeat(40),
    files: [{ url: '/assets/x.png', hash: 'b'.repeat(12), size: 10 }], tier: 1 };
  assert.equal(validateResourcePacks([good]).length, 1, '清单里的 packs 数组直接可用');
  assert.equal(validateResourcePacks({ format: 'stronghold-resource-pack-index', version: 1, maxBytes: 16000000, packs: [good] }).length, 1, '独立索引的外形也认');
  assert.equal(validateResourcePacks([{ ...good, url: 'https://cdn.test/other/p1.zip' }]).length, 0, '只认 /resource-packs/*.zip');
  assert.equal(validateResourcePacks([{ ...good, sha1: 'xyz' }]).length, 0, '整包指纹必须是 SHA-1');
  assert.equal(validateResourcePacks([{ ...good, size: 0 }]).length, 0);
  assert.equal(validateResourcePacks('nope').length, 0);
});

test('readTransportPack: 顺序读取每个条目、校验整包 SHA-1 后交出字节', async () => {
  const urls = ['/assets/a.png', '/assets/b.png', '/assets/c.png'];
  const { bytes, files, bodies } = await buildPack(urls);
  const pack = { id: 'p1', url: 'https://cdn.test/resource-packs/p1.zip', size: bytes.byteLength, sha1: await sha1Hex(bytes), tier: 1, files };
  const entries = await readTransportPack(new Response(bytes), pack);
  assert.equal(entries.length, 3);
  for (const { row, bytes: body } of entries) {
    assert.deepEqual(new Uint8Array(body), new Uint8Array(bodies.get(row.url)), row.url);
  }
});

test('readTransportPack: 整包 SHA-1 不符就拒绝（不写任何缓存）', async () => {
  const urls = ['/assets/a.png'];
  const { bytes, files } = await buildPack(urls);
  const pack = { id: 'p1', url: 'https://cdn.test/resource-packs/p1.zip', size: bytes.byteLength, sha1: 'f'.repeat(40), tier: 1, files };
  await assert.rejects(() => readTransportPack(new Response(bytes), pack), /整包校验失败/);
});
