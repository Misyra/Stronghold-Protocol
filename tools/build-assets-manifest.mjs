#!/usr/bin/env node
/**
 * 构建期生成 `.assets-manifest.json`。
 *
 * 这份文件原先由 `tools/r2-sync.mjs` 上传到 R2 之后顺带写进仓库，因此每发一次美术就要多一个
 * 6 MB 的提交。现在仓库不再跟踪它：谁有美术，谁在本地生成。
 *
 * 内容与 r2-sync 写出的完全一致：`{ tag, hashes, preload }` ——
 *   `hashes`  每条已发布美术路径 → 内容哈希（服务器把它变成 `?v=<hash>`）
 *   `preload` 同一批字节的 SHA-1 与大小（CDN-only 安装时校验资源导入用）
 *   `tag`     所有 path+hash 的 sha256 前 16 位，只随美术变化
 *
 * 覆盖目录：public/assets、public/fonts、public/media（与 r2-sync 的白名单一致）。
 * 没有美术的检出（CDN-only 部署）不会生成文件，服务器把清单当作缺失处理，只跳过逐文件版本号。
 *
 * 用法：
 *   node tools/build-assets-manifest.mjs [--out <file>] [--quiet]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintPublishedAsset, publishedAssetsManifest } from './published-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PUBLISHED_DIRS = ['assets', 'fonts', 'media'];

const args = process.argv.slice(2);
const outFile = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.join(ROOT, '.assets-manifest.json');
const quiet = args.includes('--quiet');
const say = (...a) => { if (!quiet) console.log(...a); };

function walk(dir, prefix, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (e.name.startsWith('.') || e.name.endsWith('~') || e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name), key = prefix + e.name.replace(/\\/g, '/');
    if (e.isDirectory()) { walk(abs, key + '/', out); continue; }
    if (e.isFile()) out.push({ abs, key });
  }
}

const files = [];
for (const d of PUBLISHED_DIRS) {
  const abs = path.join(PUBLIC, d);
  if (fs.existsSync(abs)) walk(abs, `${d}/`, files);
}

if (!files.length) {
  say('[manifest] public/{assets,fonts,media} 都是空的：这份检出没有美术，不生成 .assets-manifest.json');
  say('[manifest] CDN 部署把美术放在 SP_ASSETS_CDN 上，服务器按缺失处理即可');
  process.exit(0);
}

const rows = [];
let done = 0, lastTick = Date.now();
for (const f of files) {
  const { hash, contentHash, size } = await fingerprintPublishedAsset(f.abs);
  rows.push({ key: f.key, hash, contentHash, size });
  if (!quiet && ++done % 250 === 0) {
    lastTick = Date.now();
    process.stderr.write(`\r[manifest] ${done}/${files.length}`);
  }
}
if (!quiet && done >= 250) process.stderr.write('\r\x1b[K');

const manifest = publishedAssetsManifest(rows);
const body = JSON.stringify(manifest) + '\n';

let previous = null;
try { previous = fs.readFileSync(outFile, 'utf8'); } catch {}
if (previous === body) {
  say(`[manifest] 未变化，tag ${manifest.tag}（${rows.length} 个文件）`);
  process.exit(0);
}

fs.writeFileSync(outFile, body);
say(`[manifest] ${path.relative(ROOT, outFile)} 已生成：tag ${manifest.tag}，${rows.length} 个文件，${(body.length / 1048576).toFixed(1)} MB`);
