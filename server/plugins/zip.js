// server/plugins/zip.js — a small ZIP writer for packed plugins (DESIGN §32.9, docs/PLUGINS.md §15: the studio's 打包 and
// node tools/plugin.mjs pack --zip). Deterministic: the same files give the same bytes — entries sorted by name, one fixed
// timestamp (1980-01-01 00:00, the first DOS date), no extra fields — so a zip can be pinned by its SHA-256 (the catalogue
// and install-by-address of the 0.3.0 plan). Already-compressed media (images, audio, fonts) are stored, everything else
// deflated. Names are UTF-8 (general purpose flag bit 11). No ZIP64: a plugin is at most 200 MB in 5000 files
// (shared/plugins/manifest.js PLUGIN_LIMITS), well inside the 4 GB / 65 535-entry format.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the ZIP / PNG one) of a buffer. @param {Uint8Array} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Extensions whose bytes are already compressed: stored as they are. */
const STORED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.ogg', '.woff2', '.zip']);
/** 1980-01-01 00:00 in DOS form (date: (year − 1980) << 9 | month << 5 | day; time 0). */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/**
 * A ZIP archive of `entries` (sorted by name; a name is a '/'-separated relative path).
 * @param {{ name: string, data: Uint8Array }[]} entries
 * @returns {Buffer}
 */
export function zipFiles(entries) {
  const list = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of list) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const ext = (/\.[^./]+$/.exec(e.name)?.[0] || '').toLowerCase();
    const deflate = !STORED.has(ext) && data.length > 0;
    const body = deflate ? zlib.deflateRawSync(data, { level: 9 }) : data;
    // a deflated body that came out larger than the bytes is stored instead
    const method = deflate && body.length < data.length ? 8 : 0;
    const stored = method === 8 ? body : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed: 2.0
    local.writeUInt16LE(0x0800, 6);          // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);        // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);            // extra
    central.writeUInt16LE(0, 32);            // comment
    central.writeUInt16LE(0, 34);            // disk
    central.writeUInt16LE(0, 36);            // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external: a plain file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * The entries of a ZIP archive written by zipFiles (or any plain one without ZIP64): `[{ name, data }]` — for the tests
 * and the studio's own check of what it packed.
 * @param {Buffer} zip
 * @returns {{ name: string, data: Buffer }[]}
 */
export function unzipFiles(zip) {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('broken central directory');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    const lName = zip.readUInt16LE(local + 26);
    const lExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + lName + lExtra;
    const raw = zip.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`${name}: compression method ${method} is not supported`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
