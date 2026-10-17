#!/usr/bin/env node
// tools/geoip-classify.mjs — 粗分类报告:把地址(或一批随机地址)分成 cloud / isp / unknown。
//
//   node tools/geoip-classify.mjs 8.8.8.8 154.219.110.142
//   node tools/geoip-classify.mjs --sample 200000            # 桶分布 + 命中的主机 ASN(按地址空间权重)
//   node tools/geoip-classify.mjs --sample 200000 --weak     # 把"只带通用词"的线索也算进 cloud
//   node tools/geoip-classify.mjs <ip>… --json
//
// 默认库:geoip/GeoLite2-ASN.mmdb(--db <file> 可换)。样本权重是**地址空间**权重,不是玩家权重。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsnLookup } from '../server/geoipAsn.js';
import { classifyNetwork } from '../server/netClass.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(here, '..', 'geoip', 'GeoLite2-ASN.mmdb');

const args = process.argv.slice(2);
const json = args.includes('--json');
const weak = args.includes('--weak');
let db = DEFAULT_DB;
let sample = 0;
const ips = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--db') db = path.resolve(args[++i]);
  else if (a === '--sample') sample = Number(args[++i]) || 0;
  else if (a === '--json' || a === '--weak') continue;
  else if (a.startsWith('--')) { console.error('unknown flag ' + a); process.exit(2); }
  else ips.push(a);
}
if (!ips.length && !sample) { console.error('usage: geoip-classify.mjs <ip>… | --sample N [--weak] [--json] [--db file]'); process.exit(2); }
if (!fs.existsSync(db)) { console.error('ASN database not found: ' + db); process.exit(2); }

const lookup = await openAsnLookup(db);

const row = (ip) => {
  const record = lookup(ip);
  const c = classifyNetwork(record);
  return { ip, asn: c.asn, org: c.org, kind: c.kind, confidence: c.confidence, label: c.label, reason: c.reason };
};

const out = [];
for (const ip of ips) out.push(row(ip));

const buckets = { cloud: 0, isp: 0, unknown: 0 };
const cloudAsns = new Map();
let sampled = 0, hits = 0;
if (sample > 0) {
  let nonce = 0x9e3779b9 >>> 0;
  for (let i = 0; i < sample; i++) {
    nonce = (Math.imul(nonce, 1664525) + 1013904223) >>> 0;
    const n = nonce;
    const ip = ((n >>> 24) & 255) + '.' + ((n >>> 16) & 255) + '.' + ((n >>> 8) & 255) + '.' + (n & 255);
    sampled++;
    const record = lookup(ip);
    if (record) hits++;
    const c = classifyNetwork(record);
    const counts = c.kind === 'cloud' && c.confidence === 'weak' && !weak ? false : true;
    if (counts) buckets[c.kind]++;
    else buckets.isp++;
    if (c.kind === 'cloud' && (weak || c.confidence !== 'weak')) {
      const key = String(c.asn);
      const cur = cloudAsns.get(key);
      if (cur) cur.n++;
      else cloudAsns.set(key, { asn: c.asn, org: c.org, label: c.label, confidence: c.confidence, n: 1 });
    }
  }
}

if (json) {
  console.log(JSON.stringify({ db, rows: out, sample: sample ? { sampled, hits, buckets, cloudAsns: [...cloudAsns.values()].sort((a, b) => b.n - a.n) } : null }, null, 2));
} else {
  if (out.length) {
    const w = (s, n) => String(s).padEnd(n).slice(0, n);
    console.log(w('IP', 42) + w('ASN', 8) + w('KIND', 9) + w('CONF', 6) + 'ORG / 理由');
    for (const r of out) console.log(w(r.ip, 42) + w(r.asn ?? '-', 8) + w(r.kind, 9) + w(r.confidence, 6) + (r.org ? r.org + ' — ' : '') + r.reason);
  }
  if (sample > 0) {
    const total = buckets.cloud + buckets.isp + buckets.unknown;
    const pct = (n) => (100 * n / total).toFixed(2) + '%';
    console.log('\nsample ' + sampled + ' 随机 IPv4,有 ASN 记录 ' + hits + ' (' + (100 * hits / sampled).toFixed(1) + '%)' + (weak ? ' [包含 weak]' : ''));
    console.log('  cloud    ' + String(buckets.cloud).padStart(7) + '  ' + pct(buckets.cloud));
    console.log('  isp      ' + String(buckets.isp).padStart(7) + '  ' + pct(buckets.isp));
    console.log('  unknown  ' + String(buckets.unknown).padStart(7) + '  ' + pct(buckets.unknown));
    const top = [...cloudAsns.values()].sort((a, b) => b.n - a.n);
    console.log('\n被认成主机/机房的 ASN:' + top.length + ' 个,地址空间占比 ' + pct(buckets.cloud));
    for (const r of top.slice(0, 40)) console.log('  ' + String(r.asn).padStart(7) + ' ' + String(r.n).padStart(7) + '  ' + r.confidence.padEnd(5) + ' ' + (r.label ?? '-').padEnd(12) + ' ' + (r.org ?? ''));
    if (top.length > 40) console.log('  … 还有 ' + (top.length - 40) + ' 个');
  }
}
