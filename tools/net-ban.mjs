#!/usr/bin/env node
// tools/net-ban.mjs — 把仓库里的名单（server/netBlock.js 的 BLOCK_IPS）渲染成内核 nft 能吃的两份地址表。
//
//   node tools/net-ban.mjs            # 重写 ops/blocked-ipv4.txt 与 ops/blocked-ipv6.txt
//   node tools/net-ban.mjs --check    # 只校验：文件缺失或与名单不一致就退出 1（部署前 / CI 用）
//   node tools/net-ban.mjs --print    # 打到 stdout，不落盘
//
// 为什么是两份文件：ops/sp-syn-ban-load 的 perm4 是 type ipv4_addr、perm6 是 type ipv6_addr，
// nft 不会替你分族，混在一起整份表都会校验失败。生成器负责分族、去重、排序、丢垃圾条目。
//
// **只渲染逐条 IP**。ASN 和地区不在内核层：nft 没有 ASN 概念，地区要靠
// scripts/hardening/render-country-firewall.py 那套从 MMDB 走前缀遍历，是另一条链。
// 把上百个 ASN 展开成 CIDR 再塞进 perm4（size 65536）会把表撑爆，而且归属一变就全是死规则。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_IPS, BLOCK_COUNTRIES, BLOCK_ASNS } from '../server/netBlock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V4_FILE = path.join(ROOT, 'ops', 'blocked-ipv4.txt');
const V6_FILE = path.join(ROOT, 'ops', 'blocked-ipv6.txt');

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const print = args.has('--print');
for (const a of args) if (!['--check', '--print'].includes(a)) { console.error('unknown flag ' + a); process.exit(2); }

/** IPv4 的数字序，IPv6 按 16 位分组比较；只为让文件稳定、diff 干净。 */
function compare(a, b) {
  const av = a.split(':').length === 1 ? a.split('.').map(Number) : a.split(':');
  const bv = b.split(':').length === 1 ? b.split('.').map(Number) : b.split(':');
  if (av.length !== bv.length) return av.length - bv.length;
  for (let i = 0; i < av.length; i++) {
    const d = av.length === 4 ? av[i] - bv[i] : (parseInt(av[i], 16) || 0) - (parseInt(bv[i], 16) || 0);
    if (d) return d;
  }
  return a.localeCompare(b);
}

const v4 = new Set(), v6 = new Set(), rejected = [];
for (const raw of BLOCK_IPS) {
  const ip = String(raw).trim();
  if (!ip || ip.startsWith('#')) continue;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    const ok = ip.split('.').every((o) => Number(o) <= 255);
    if (ok) v4.add(ip); else rejected.push(ip);
    continue;
  }
  if (ip.includes(':')) { v6.add(ip); continue; }
  rejected.push(ip);
}

// 头部**不带时间戳**：--check 靠逐字比较，带时间戳的文件永远"不一致"。生成时间进 console 就够了。
const header = (family, count) => `# 由 tools/net-ban.mjs 生成，不要手改（改 server/netBlock.js 的 BLOCK_IPS 后重跑）
# 源名单 ${BLOCK_IPS.size} 条 · ${family} ${count} 条
# 同名单的 ASN ${BLOCK_ASNS.size} 个、地区 [${[...BLOCK_COUNTRIES].join(' ')}] 不在这里：内核层没有 ASN，
# 地区走 scripts/hardening/render-country-firewall.py 那条链。应用层由 server/netBlock.js 实时判定。
`;
const body = (set) => [...set].sort(compare).join('\n');
const v4Text = header('IPv4', v4.size) + (v4.size ? body(v4) + '\n' : '');
const v6Text = header('IPv6', v6.size) + (v6.size ? body(v6) + '\n' : '');

if (print) { process.stdout.write(v4Text + '\n' + v6Text); process.exit(0); }

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
if (check) {
  const problems = [];
  for (const [file, text] of [[V4_FILE, v4Text], [V6_FILE, v6Text]]) {
    const current = read(file);
    if (current === null) problems.push(path.relative(ROOT, file) + ' 不存在');
    else if (current !== text) problems.push(path.relative(ROOT, file) + ' 与名单不一致');
  }
  if (problems.length) {
    console.error('[net-ban] ' + problems.join('；') + ' —— 运行 node tools/net-ban.mjs 重新生成');
    process.exit(1);
  }
  console.log(`[net-ban] ok: IPv4 ${v4.size} / IPv6 ${v6.size}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(V4_FILE), { recursive: true });
fs.writeFileSync(V4_FILE, v4Text);
fs.writeFileSync(V6_FILE, v6Text);
if (rejected.length) console.warn('[net-ban] 丢弃无法识别的条目: ' + rejected.join(', '));
console.log(`[net-ban] wrote ops/blocked-ipv4.txt (${v4.size}) 与 ops/blocked-ipv6.txt (${v6.size})`);
