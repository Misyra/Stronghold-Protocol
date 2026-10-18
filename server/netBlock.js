// server/netBlock.js — 明确的网络屏蔽名单:ASN + 国家 + 单个 IP，默认开启（2026-10-17 用户拍板「全部默认屏蔽」）。
// (i18n-ignore-file: the list, its labels and its startup warnings are operator diagnostics; a blocked player
//  receives the existing foreign-gate error verbatim (server/http/websocket.js) — docs/I18N.md)
//
// 只用两份数据：ASN 库（地址 → 运营网络）与国家库（地址 → 国家）。不用 MaxMind 的 Connection Type /
// Anonymous IP，也不在这里做任何"像不像机房"的推断 —— 名单是**枚举**出来的，判定就是查表。
//
// 三个桶任一命中即拒绝，顺序是 IP → 国家 → ASN（代价从低到高）：
//   * IP：用户给的逐条地址（含被 GFW/CF 日志抓到的扫描源）；
//   * 国家：TW / VE / EC（另有既有的"仅中国大陆"门禁，两者互不替代）；
//   * ASN：人工核对的机房 / 云 / 廉价 VPS / 防弹主机网络（133 条，2026-10-17）。
//
// 两个坑写在这里备查（2026-10-17 用 ASN 库逐个核对这些号码时发现的）：
//   * AS6871 = British Telecommunications Limited，AS4773 = MobileOne（新加坡移动）—— **正经消费级运营商**，
//     不是机房。它们在这个名单里，就意味着英国家宽和新加坡移动玩家会被一起挡住。启动日志会点名警告。
//   * 名单里另外 65 个的 org 名字不含任何托管词（NetLab Global、GTT Host、InterServer…），靠名字分类会漏，
//     所以这一层只认号码，不认名字。

/**
 * 机房 / 云 / 廉价 VPS / 防弹主机 ASN，逐个在 GeoLite2-ASN 里核对过组织名。
 * 第一批 110 个是用户 2026-10-17 给的清单；第二批 23 个当天补入（用户日志里实际出现的大陆云与香港小机房，
 * 加上 Mirai / 挖矿 / 勒索基础设施常租的防弹机房）。号码会过时，加条目前先看库里的组织名。
 */
export const BLOCK_ASNS = new Set(/** @type {number[]} */ ([
  31898, 63023, 20473, 33333, 14061, 30058, 16276, 132203,
  21859, 57043, 216071, 45102, 36352, 214238, 154177, 197223,
  200740, 61112, 152194, 41745, 139648, 139341, 16509, 396982,
  9370, 210976, 63150, 63199, 8560, 207728, 63949, 62468,
  401696, 16003, 979, 136907, 212238, 213529, 35916, 215590,
  215355, 216139, 9009, 395839, 135330, 142594, 6206, 200758,
  401701, 36007, 8075, 213887, 212552, 48314, 49581, 28753,
  25198, 35251, 20860, 197540, 207957, 60790, 204548, 43641,
  199959, 201988, 59253, 214172, 216444, 41436, 51847, 216127,
  24940, 133199, 51247, 210661, 19318, 206264, 142113, 136258,
  6871, 151338, 215439, 149020, 215607, 215703, 400992, 216475,
  204044, 198037, 49791, 216024, 26383, 47264, 396356, 8796,
  219357, 213535, 210329, 216154, 21769, 197196, 197703, 199741,
  53808, 46475, 4773, 38136, 400618, 215540,
  // ——— 第二批（2026-10-17，用户拍板「加进去」）———
  // 大陆云三家：名单此前只有境外段（45102 阿里美国、132203 腾讯香港、136907/55990 华为海外），
  // 大陆段一条没有，而用户自己的攻击日志里腾讯大陆段出现 5 次。
  45090, 37963, 38365,
  // 用户日志里实际出现的香港 / 印度小机房与代理出口（对应他组织占比表的 5.81% / 3.62% / 3.29% / 2.20%）。
  140042, 6134, 139180, 150623, 209554, 153771, 402506, 50360,
  // 防弹 / 滥用机房：Mirai 变种、挖矿、勒索的 C2 常租处（组织名照抄 GeoLite2-ASN）。
  3223, 202425, 200651, 60117, 49981, 29802, 46606, 54290, 206092, 394711, 49505, 204601,
]));

/** 明确屏蔽的地区（ISO 3166-1 alpha-2）。 */
export const BLOCK_COUNTRIES = new Set(['TW', 'VE', 'EC']);

/** 逐条屏蔽的地址（用户 2026-10-17 提供的扫描源）。IPv6 会做一次规范化再比较。 */
export const BLOCK_IPS = new Set(/** @type {string[]} */ ([
  '42.200.176.21', '60.249.21.30', '67.220.82.10', '86.53.110.15', '89.34.167.181', '103.218.173.218',
  '119.205.235.58', '123.111.169.70', '130.94.29.155', '131.186.26.94', '144.24.78.206', '147.90.229.163',
  '152.69.229.110', '158.247.220.241', '193.122.119.241', '195.133.38.112', '209.9.201.182', '213.1.145.4',
  '216.36.80.137', '216.167.13.196', '219.76.13.166', '219.76.13.167', '219.76.13.169', '219.76.13.177',
  '219.76.13.181', '132.226.172.115', '186.24.19.97', '200.71.151.81', '45.8.186.219', '104.251.236.24',
  '186.24.59.217', '200.35.115.41', '186.24.48.145', '116.206.178.146', '124.223.31.113', '200.35.71.169',
  '200.35.71.113', '103.91.208.74', '186.24.49.178', '146.56.161.138', '152.175.8.45', '186.24.16.65',
  '186.24.252.193', '163.61.30.46', '186.24.49.154', '186.166.207.249', '200.35.105.65', '114.66.6.159',
  '45.195.74.119', '200.71.155.155', '186.24.57.38', '200.71.154.25', '42.193.180.64', '43.161.229.11',
  '186.24.57.97', '43.142.51.107', '200.35.88.105', '186.24.56.153', '154.40.61.235', '186.24.252.161',
  '186.24.32.9', '186.24.0.241', '200.35.77.201', '186.24.49.218', '172.104.41.15', '200.35.77.33',
  '131.186.41.182', '146.56.102.6', '187.130.148.181', '186.24.62.241', '43.153.185.228', '201.96.79.201',
  '43.161.241.173', '154.12.21.86', '187.143.224.145', '209.248.1.17', '187.157.80.81', '42.193.21.113',
  '58.187.79.213', '159.75.43.39', '45.205.31.134', '118.170.87.153', '79.124.40.158', '154.219.110.142',
]));

/**
 * 名单里混着的**消费级运营商**：号码在名单上，但它的用户是家宽/移动用户而不是机房租户。
 * 启动时警告，运行时不自动放宽 —— 名单是用户的决定，这里只负责不让他不知情。
 */
export const CONSUMER_ASNS_IN_LIST = new Map(/** @type {[number, string][]} */ ([
  [6871, 'British Telecommunications Limited（英国家宽）'],
  [4773, 'MobileOne Ltd.（新加坡移动 ISP）'],
]));

/** SP_NET_BLOCK：on（默认）| off。列表本身不通过环境变量改，改名单就是改这个文件。 */
export function parseNetBlockMode(value = 'on') {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === '') return true;
  if (['1', 'true', 'on'].includes(mode)) return true;
  if (['0', 'false', 'off'].includes(mode)) return false;
  throw new RangeError(`SP_NET_BLOCK must be on or off (got ${value})`);
}

/** Canonicalize the way server/foreignSessions.js keys addresses, so `::ffff:` spellings cannot slip past a literal. */
export function normalizeBlockIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  if (!ip) return null;
  if (ip.includes(':')) {
    // IPv4-mapped forms (`::ffff:1.2.3.4` and `::ffff:0102:0304`) are compared as the plain IPv4 address,
    // otherwise a dual-stack peer could dodge a listed literal by presenting the mapped spelling.
    const dotted = /^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (dotted) return dotted[1];
    let canonical;
    try { canonical = new URL(`http://[${ip}]/`).hostname.replace(/^\[(.*)\]$/, '$1'); } catch { return null; }
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return canonical;
  }
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ? ip : null;
}

/**
 * The list plus the two lookups. One instance per server; `check()` runs on the connection path and does no I/O.
 */
export class NetBlock {
  /**
   * @param {{ enabled?: boolean, asns?: Iterable<number>, countries?: Iterable<string>, ips?: Iterable<string>,
   *   asnLookup?: ((ip: string) => { asn: number, org: string } | null) | null,
   *   countryLookup?: ((ip: string) => string | null) | null }} init
   */
  constructor({ enabled = true, asns = BLOCK_ASNS, countries = BLOCK_COUNTRIES, ips = BLOCK_IPS,
    asnLookup = null, countryLookup = null } = {}) {
    this.enabled = enabled;
    this.asns = new Set(asns);
    this.countries = new Set([...countries].map((c) => String(c).trim().toUpperCase()).filter(Boolean));
    this.ips = new Set([...ips].map(normalizeBlockIp).filter(Boolean));
    this.asnLookup = typeof asnLookup === 'function' ? asnLookup : null;
    this.countryLookup = typeof countryLookup === 'function' ? countryLookup : null;
    this.counts = { blocked: 0, byIp: 0, byCountry: 0, byAsn: 0, asnMisses: 0, asnErrors: 0, countryMisses: 0, countryErrors: 0 };
  }

  /** ASN 库没加载时，ASN 这一层整层不生效（国家与 IP 照旧）。启动日志会说出来。 */
  get asnAvailable() { return this.asnLookup !== null && this.asns.size > 0; }

  /**
   * @param {string | null | undefined} rawIp
   * @returns {{ blocked: boolean, reason: 'ip' | 'country' | 'asn' | null, ip: string | null, asn: number | null, country: string | null }}
   */
  check(rawIp) {
    const result = { blocked: false, reason: null, ip: null, asn: null, country: null };
    if (!this.enabled) return result;
    const ip = normalizeBlockIp(rawIp);
    if (!ip) return result;
    result.ip = ip;
    if (this.ips.has(ip)) {
      result.blocked = true; result.reason = 'ip'; this.counts.blocked++; this.counts.byIp++;
      return result;
    }
    if (this.countryLookup && this.countries.size) {
      let country;
      try { country = this.countryLookup(ip); }
      catch { this.counts.countryErrors++; }
      if (typeof country === 'string' && /^[A-Z]{2}$/.test(country)) {
        result.country = country;
        if (this.countries.has(country)) {
          result.blocked = true; result.reason = 'country'; this.counts.blocked++; this.counts.byCountry++;
          return result;
        }
      } else this.counts.countryMisses++;
    }
    if (this.asnLookup && this.asns.size) {
      let record;
      try { record = this.asnLookup(ip); }
      catch { this.counts.asnErrors++; }
      if (record && Number.isSafeInteger(record.asn)) {
        result.asn = record.asn;
        if (this.asns.has(record.asn)) {
          result.blocked = true; result.reason = 'asn'; this.counts.blocked++; this.counts.byAsn++;
        }
      } else this.counts.asnMisses++;
    }
    return result;
  }

  stats() {
    return { enabled: this.enabled, asnAvailable: this.asnAvailable, asns: this.asns.size, countries: [...this.countries],
      ips: this.ips.size, consumerAsns: [...CONSUMER_ASNS_IN_LIST.keys()].filter((a) => this.asns.has(a)), ...this.counts };
  }
}

/**
 * 从 startServer() 选项 / 环境变量建一份名单。
 * @param {{ mode?: string | boolean, asnLookup?: Function | null, countryLookup?: Function | null,
 *   asns?: Iterable<number>, countries?: Iterable<string>, ips?: Iterable<string>,
 *   consumerAsns?: Iterable<number>, log?: { info: Function, warn: Function } }} init
 */
export function createNetBlock({ mode = 'on', asnLookup = null, countryLookup = null, asns = BLOCK_ASNS,
  countries = BLOCK_COUNTRIES, ips = BLOCK_IPS, consumerAsns = CONSUMER_ASNS_IN_LIST.keys(), log = console } = {}) {
  const enabled = typeof mode === 'boolean' ? mode : parseNetBlockMode(mode);
  const block = new NetBlock({ enabled, asns, countries, ips, asnLookup, countryLookup });
  if (!enabled) return block;
  log.info?.(`[netblock] on: ${block.asns.size} ASN / ${block.countries.size} 地区 / ${block.ips.size} IP`);
  if (!block.asnAvailable)
    log.warn?.(`[netblock] ASN 库不可用：ASN 那 ${block.asns.size} 条不生效，只有地区与逐条 IP 仍然拦截（SP_GEOLITE_ASN_DB 或 geoip/GeoLite2-ASN.mmdb 缺失）`);
  if (!block.countryLookup)
    log.warn?.('[netblock] 国家库不可用：TW/VE/EC 三条不生效');
  for (const asn of consumerAsns) {
    if (!block.asns.has(asn)) continue;
    const label = CONSUMER_ASNS_IN_LIST.get(asn) ?? '消费级运营商';
    log.warn?.(`[netblock] 名单里有消费级运营商 ASN ${asn}：${label} —— 它的家宽/移动用户会和机房一起被拒`);
  }
  return block;
}
