// server/geoipAsn.js — GeoLite2-ASN 读取层:把一个地址换成 { asn, org },不做分类。
//
// 分类在 server/netClass.js。这里只负责读库、校验库类型、把"没有记录"如实返回成 null。
// 与 server/geoip.js 一样:启动时读一次,游戏消息路径上没有磁盘或网络访问。

import { open } from 'maxmind';
import { isIP } from 'node:net';

/**
 * @param {{ metadata: { databaseType?: string }, get: (ip: string) => any }} reader
 * @returns {(ip: string) => { asn: number, org: string } | null}
 */
export function asnLookupFromReader(reader) {
  const type = String(reader.metadata?.databaseType ?? '');
  if (!/\bASN\b/.test(type)) throw new Error('GeoLite ASN database required (got ' + (type || 'unknown') + ')');
  return (ip) => {
    if (!isIP(ip)) return null;
    const record = reader.get(ip);
    if (!record) return null;
    const asn = record.autonomous_system_number;
    if (!Number.isSafeInteger(asn) || asn <= 0) return null;
    const org = typeof record.autonomous_system_organization === 'string' ? record.autonomous_system_organization : '';
    return { asn, org };
  };
}

/** 启动时调用一次;库坏了就抛错,不要留一张空名单假装在工作。 */
export async function openAsnLookup(file) {
  const reader = await open(file);
  return asnLookupFromReader(reader);
}

/** 把两个读取层拼成一个查询:国家 + 网络,共享一次地址解析。 */
export function combineLookups({ countryLookup = null, asnLookup = null } = {}) {
  return (ip) => ({
    country: countryLookup ? countryLookup(ip) : null,
    network: asnLookup ? asnLookup(ip) : null,
  });
}
