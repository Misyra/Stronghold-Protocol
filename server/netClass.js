// server/netClass.js — 粗分类:一条 GeoLite2-ASN 记录属于什么网络。
// (i18n-ignore-file: ops-side GeoIP classification — the ASN labels and the reasons go to tools/geoip-classify.mjs
//  and the audit log, never to a player — docs/I18N.md)
//
// GeoLite2-ASN 只说了两件事:这个地址由 AS 号 N 宣告,持有者叫 X。它没有说这是宽带、移动、卫星、企业专线、VPN 还是机房。
// 下面全部是在这条记录上做的名字+号码启发式,答案刻意只有三档:
//
//   cloud    托管 / 机房 / CDN / 云厂商网络:普通玩家不从这里上来,来自它的会话可以用最严的策略。
//   isp      普通运营商网络(家宽、移动、企业、学校、政府)。**家宽无法从这里推断**:企业专线和小机房与家宽用户
//            共用同一个 ASN。所以不要因为这一档就放宽限制。
//   unknown  没有 ASN 记录(未分配、部分 IPv6、私有地址):如实说不知道,不要猜。
//
// confidence 表示这个答案值多少:
//   asn    人工核对过的 ASN 表(最硬)
//   name   带边界的品牌匹配(AMAZON.COM / HETZNER / 阿里云…)—— 号码可能变,品牌不会
//   weak   只命中通用词(名字里带 CLOUD / HOSTING / SERVER / IDC 就算)—— 只是线索,不要单独拿来封禁
//   none   没有记录
//
// 为什么名字匹配必须带边界、且只能当次一级证据(用 1200 万随机地址实测的 64599 个 ASN):
//   * 裸 /CLOUD/ 会命中一大堆**家宽**品牌:Cloud Telecom、Cloudlink Communications、Cloudlasers Broadband、
//     Cloud 9 Wireless、cloudsky superfast broadband …
//   * 裸 /AMAZON/ 会命中巴西运营商:AMAZONET TELECOMUNICACOES、AMAZONIA TELECOM、AMAZONFIBER SERVICOS …
//   * 裸 /GOOGLE/ 会命中 **Google Fiber**(AS16591),那是正经家宽。
// 所以品牌词按词边界整段匹配,消费级词(FIBER / BROADBAND / WIRELESS / CABLE / TELECOM / MOBILE)一旦出现就压回 isp。
//   反过来说,通用词层("名字里带 HOST / xCLOUD / IDC")召回高、精度低:实测 64599 个 ASN 里命中 968 个、占地址空间 0.25%,
//   认错的方向是把小机房当运营商,不是把玩家当机房 —— 所以它只到 weak,默认不封。

/** @typedef {'cloud' | 'isp' | 'unknown'} NetworkKind */
/** @typedef {'asn' | 'name' | 'weak' | 'none'} NetworkConfidence */
/** @typedef {{ asn: number | null, org: string | null }} AsnRecord */
/**
 * @typedef {object} NetworkClass
 * @property {NetworkKind} kind
 * @property {NetworkConfidence} confidence
 * @property {number | null} asn
 * @property {string | null} org
 * @property {string | null} label   命中的人工标签,没命中为 null
 * @property {string} reason         一句话说清为什么是这个答案
 */

/**
 * 人工核对过的主机/机房/云厂商 ASN。写入标准:这个 ASN 上不会坐着一个正常玩家。
 * 号码会过时,但错误方向是安全的 —— 认不出来只会落到 isp,不会被误封;
 * 想加条目前先 `node tools/geoip-classify.mjs --asn <号码>` 看一眼库里实际的组织名。
 */
export const CLOUD_ASNS = new Map(/** @type {[number, string][]} */ ([
  // Amazon AWS
  [16509, 'AWS'], [14618, 'AWS'], [8987, 'AWS'], [38895, 'AWS'], [214101, 'AWS 欧洲主权云'],
  // Google
  [396982, 'Google Cloud'], [139070, 'Google Cloud 亚太'], [19527, 'Google Cloud'], [15169, 'Google'],
  // Microsoft
  [8075, 'Azure'], [8068, 'Azure'], [8069, 'Azure'], [8070, 'Azure'], [12076, 'Microsoft'], [3598, 'Microsoft'],
  // 其它一线云
  [31898, 'Oracle Cloud'], [54253, 'Oracle Cloud'], [36351, 'IBM Cloud'], [200350, 'Yandex Cloud'],
  [16276, 'OVH'], [24940, 'Hetzner'], [213230, 'Hetzner'], [14061, 'DigitalOcean'], [12876, 'Scaleway'],
  [29447, 'Scaleway'], [202053, 'UpCloud'], [204548, 'Kamatera'], [51167, 'Contabo'], [47583, 'Hostinger'],
  // 托管 / 廉价 VPS / 常见代理出口
  [63949, 'Akamai / Linode'], [20940, 'Akamai'], [16625, 'Akamai'], [31108, 'Akamai'],
  [20473, 'Vultr / Choopa'], [64515, 'Vultr'], [53667, 'FranTech / BuyVM'], [44477, 'Stark / PQ Hosting'],
  [210644, 'Aeza'], [9009, 'M247'], [212238, 'Datacamp'], [60068, 'Datacamp'], [199524, 'Gcore'],
  [28753, 'Leaseweb'], [60781, 'Leaseweb'], [32613, 'Leaseweb'], [395954, 'Leaseweb'],
  [33070, 'Rackspace'], [19994, 'Rackspace'], [27357, 'Rackspace'], [30058, 'FDCservers'],
  [18779, 'EGIHosting'], [7979, 'Servers.com'], [40065, 'CNSERVERS'], [21859, 'Zenlayer'], [62610, 'Zenlayer'],
  // CDN / 边缘(玩家不会从这里上来)
  [13335, 'Cloudflare'], [209242, 'Cloudflare'], [54113, 'Fastly'], [36459, 'GitHub'],
  // 中国云与 IDC
  [45102, '阿里云'], [37963, '阿里云'], [58593, 'UCloud'], [135377, 'UCloud'],
  [45090, '腾讯云'], [132203, '腾讯云'], [55990, '华为云'], [136907, '华为云'], [38365, '百度'],
  [23724, '中国电信 IDC'], [38283, '四川电信 IDC'], [58461, '杭州电信 IDC'], [58519, '云算力'],
  [4694, 'IDC Frontier'], [132839, 'POWER LINE 机房'], [20860, 'Iomart Cloud'], [61157, 'PlusServer'],
  [198678, 'Delos Cloud'],
]));

/**
 * 品牌撞车的运营商 ASN:号码是正经运营商,名字却长着云的样子。它们先于名字匹配生效。
 * 目前只有 Google Fiber —— 它是 Google 的美国宽带业务,而 AS15169 才是 Google 自己的网络。
 */
export const ISP_ASNS = new Map(/** @type {[number, string][]} */ ([
  [16591, 'Google Fiber(美国家宽,品牌撞 Google)'],
]));

/**
 * 品牌匹配:整段词边界,不做裸子串。命中即 cloud / confidence 'name'。
 * 只收"玩家不会坐在上面"的品牌;一个品牌如果同时卖家宽(Google Fiber)就不要放进来。
 */
export const CLOUD_NAME_RES = /** @type {[RegExp, string][]} */ ([
  [/\bAMAZON\.COM\b|\bAMAZON TECHNOLOGIES\b|\bAMAZON DATA SERVICES\b/i, 'AWS'],
  [/\bGOOGLE LLC\b|\bGOOGLE ASIA PACIFIC\b|\bGOOGLE CLOUD\b/i, 'Google'],
  [/\bMICROSOFT CORPORATION\b/i, 'Microsoft'],
  [/\bDIGITALOCEAN\b/i, 'DigitalOcean'], [/\bHETZNER\b/i, 'Hetzner'], [/\bLINODE\b/i, 'Linode'],
  [/\bLEASEWEB\b/i, 'Leaseweb'], [/\bCONTABO\b/i, 'Contabo'], [/\bVULTR\b/i, 'Vultr'],
  [/\bM247\b/i, 'M247'], [/\bDATACAMP\b/i, 'Datacamp'], [/\bZENLAYER\b/i, 'Zenlayer'],
  [/\bRACKSPACE\b/i, 'Rackspace'], [/\bHOSTINGER\b/i, 'Hostinger'], [/\bUPCLOUD\b/i, 'UpCloud'],
  [/\bKAMATERA\b/i, 'Kamatera'], [/\bG-?CORE\b/i, 'Gcore'], [/\bAEZA\b/i, 'Aeza'],
  [/\bIONOS\b/i, 'IONOS'], [/\bSCALEWAY\b|\bONLINE SAS\b/i, 'Scaleway'], [/\bOVH\b/i, 'OVH'],
  [/\bSOFTLAYER\b/i, 'IBM SoftLayer'], [/\bFRANTECH\b/i, 'FranTech'], [/\bCONSTANT COMPANY\b/i, 'Vultr'],
  [/\bFASTLY\b/i, 'Fastly'], [/\bCLOUDFLARE\b/i, 'Cloudflare'], [/\bAKAMAI\b/i, 'Akamai'],
  [/\bTENCENT\b/i, '腾讯云'], [/\bALIBABA \(US\)|\bALIBABA CLOUD\b|\bHANGZHOU ALIBABA\b/i, '阿里云'],
  [/\bHUAWEI CLOUDS?\b/i, '华为云'],
  [/\bUCLOUD\b/i, 'UCloud'], [/\bORACLE CORPORATION\b/i, 'Oracle Cloud'],
]);

/** 通用词:命中只算线索(confidence 'weak'),单独不足以封禁。 */
export const HOSTING_HINT_RE = /\bCLOUD\b|[a-z]cloud\b|\bHOST|\bSERVER\b|\bSERVERS\b|\bVPS\b|\bCOLOCAT|\bDATACENT(?:ER|RE)\b|\bDATA CENTER\b|\bIDC\b|\bWEB HOST/i;

/** 消费级/运营商词:出现就压回 isp,哪怕名字里还带着云。 */
export const CONSUMER_HINT_RE = /\bBROADBAND\b|\bFIBER?\b|\bCABLE\b|\bWIRELESS\b|\bDSL\b|\bRESIDENTIAL\b|\bMOBILE\b|\bCELLULAR\b|\bTELECOM(?:UNICACOES|MUNICATION|MUNICATIONS)?\b/i;

/** @type {(asn: number | null | undefined, org: string | null | undefined) => NetworkClass} */
export function classifyNetwork(record) {
  const asn = record && Number.isSafeInteger(record.asn) && record.asn > 0 ? record.asn : null;
  const org = record && typeof record.org === 'string' && record.org.trim() ? record.org.trim() : null;

  if (asn !== null) {
    const curated = CLOUD_ASNS.get(asn);
    if (curated) return { kind: 'cloud', confidence: 'asn', asn, org, label: curated, reason: `ASN ${asn} 在人工主机名单里(${curated})` };
    const operator = ISP_ASNS.get(asn);
    if (operator) return { kind: 'isp', confidence: 'asn', asn, org, label: operator, reason: `ASN ${asn} 是运营商(${operator})` };
  }
  if (!org) return { kind: 'unknown', confidence: 'none', asn, org, label: null, reason: '没有 ASN 记录' };

  for (const [re, label] of CLOUD_NAME_RES) {
    if (re.test(org)) return { kind: 'cloud', confidence: 'name', asn, org, label, reason: `组织名命中品牌 ${label}` };
  }
  if (CONSUMER_HINT_RE.test(org)) return { kind: 'isp', confidence: 'name', asn, org, label: null, reason: '组织名是消费级/运营商词' };
  if (HOSTING_HINT_RE.test(org)) return { kind: 'cloud', confidence: 'weak', asn, org, label: null, reason: '组织名只命中通用托管词,仅作线索' };
  return { kind: 'isp', confidence: 'name', asn, org, label: null, reason: '有 ASN,未命中任何主机特征' };
}

/** 是否值得按"机房"处理:默认要求 asn 或 name 级证据,weak 由调用方自己决定要不要认。 */
export function isHostingNetwork(classification, { weak = false } = {}) {
  if (!classification || classification.kind !== 'cloud') return false;
  return weak || classification.confidence !== 'weak';
}
