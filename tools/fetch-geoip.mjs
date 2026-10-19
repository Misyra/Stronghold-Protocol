#!/usr/bin/env node
/**
 * 下载 GeoLite2-Country.mmdb 到 geoip/。
 *
 * 仓库不再跟踪这份 3.25 MB 的二进制库（它每月更新，没必要跟着每个提交走）。ASN 库本来就是这个
 * 待遇：`SP_GEOLITE_ASN_DB` 指向外部文件，缺了就降级并警告。国家库现在一致了 ——
 * 部署时跑一次这个脚本，或者把 `SP_GEOLITE_COUNTRY_DB` 指到机器上已有的库。
 *
 * 缺库不是致命的：server/index.js 在库不存在时打印
 *   `[geoip] no country database configured; foreign AI limit is disabled, total AI limit remains active`
 * 然后继续启动，海外 AI 席位上限一项失效，其余规则照旧。
 *
 * 镜像（都不需要 MaxMind 账号）：
 *   1. raw.githubusercontent.com/P3TERX/GeoLite.mmdb
 *   2. cdn.jsdelivr.net/gh/P3TERX/GeoLite.mmdb
 * 下载后校验：体积 > 1 MB，且尾部的 MaxMind 元数据标记存在。
 *
 * 用法：
 *   node tools/fetch-geoip.mjs [--db <path>] [--force] [--quiet]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const target = args.includes('--db')
  ? path.resolve(args[args.indexOf('--db') + 1])
  : path.join(ROOT, 'geoip', 'GeoLite2-Country.mmdb');
const force = args.includes('--force');
const quiet = args.includes('--quiet');
const say = (...a) => { if (!quiet) console.log(...a); };

const SOURCES = [
  'https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-Country.mmdb',
  'https://cdn.jsdelivr.net/gh/P3TERX/GeoLite.mmdb@download/GeoLite2-Country.mmdb',
];
const MIN_BYTES = 1_000_000;

if (fs.existsSync(target) && !force) {
  const size = fs.statSync(target).size;
  if (size >= MIN_BYTES) {
    say(`[geoip] ${path.relative(ROOT, target)} 已存在（${(size / 1048576).toFixed(2)} MB），跳过。--force 强制重下`);
    process.exit(0);
  }
  say(`[geoip] 现有文件只有 ${size} 字节，当作损坏，重新下载`);
}

function looksLikeMmdb(buf) {
  if (buf.length < MIN_BYTES) return false;
  // MMDB 以 "\xab\xcd\xefMaxMind.com" 元数据标记结尾（最多偏移 128 KB 内）
  return buf.subarray(-131072).includes(Buffer.from('MaxMind.com', 'latin1'));
}

let lastError = null;
for (const url of SOURCES) {
  try {
    say(`[geoip] 下载 ${url}`);
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!looksLikeMmdb(buf)) throw new Error(`内容不像 MMDB（${buf.length} 字节）`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    const sha = createHash('sha256').update(buf).digest('hex');
    say(`[geoip] 写入 ${path.relative(ROOT, target)}：${buf.length} 字节，sha256 ${sha}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    say(`[geoip] 失败：${error?.message || error}`);
  }
}

console.error(`[geoip] 所有镜像都失败：${lastError?.message || lastError}`);
console.error('[geoip] 从 https://github.com/P3TERX/GeoLite.mmdb/releases 手动下载，放到 geoip/GeoLite2-Country.mmdb');
console.error('[geoip] 或者把 SP_GEOLITE_COUNTRY_DB 指向机器上已有的库');
process.exit(1);
