# 机房来源分级：可行性与边界

2026-10-17 核对仓库 `GeoLite2-Country.mmdb`：116.198.45.213、47.103.57.77、111.228.63.76、49.233.9.157、120.202.218.34、39.96.95.150、180.164.155.112 均返回 CN。报告中的“现有大陆库把这批攻击 IP 判为 ZZ，因此是住宅白名单”不适用于本仓库全球库。`server/geoip.js` 的 ZZ 只是 cn-only 模式下 IPv4 未命中的策略标记，不能证明机房身份。

Country 只识别国家。需要额外 ASN 数据才能查运营网络；ASN 仍不是精确的住宅/机房标签。同一个运营网络可能同时服务家庭、企业和 IDC，住宅代理也可能用于攻击。[MaxMind ASN 字段](https://dev.maxmind.com/geoip/docs/databases/asn/)与单独的[Hosting/匿名网络字段](https://dev.maxmind.com/geoip/docs/databases/anonymous-ip/)是不同数据产品。

国内服务器可以通过已有 Nginx GeoIP2 模块另读 ASN MMDB，记录 ASN 与“待确认机房”分类，先观察拒绝时的同时在线连接与正常会话，再启用差异化额度。未知 ASN 不自动当成机房；不按宽泛的电信/联通/移动 ASN 整体封禁；单独维护、校验 IPv4/IPv6 数据与回滚。当前仓库只带 Country，没有 ASN 或 hosting 数据，因此本次没有自动添加 IDC 黑名单。

CF 侧也支持 ASN 条件，但表达式使用数值，例如 `ip.src.asnum in {37963 45102}`，不是 `{AS37963 AS45102}`。Managed Challenge 应考虑页面导航与 API/WS 的区别，WebSocket 客户端无法显示交互挑战页面；需要单独验证登录后的升级链路。[Cloudflare ASN 自定义规则](https://developers.cloudflare.com/waf/custom-rules/use-cases/update-rules-customers-partners/)

“一小时 19 条 WS”是累计连接次数，不能推导同时并发 19。“只访问 1～2 个路径”也可能是 CDN、缓存或已打开的客户端，不单独据此永久封禁。CGNAT 共用同一公网出口，按 IP 的 4 条并发和平均 5 次新建/分可能限制真实玩家；这是用户当前明确指定的参数，未自动改成报告建议的 16 条。

## 粗分类：一条 ASN 记录 → cloud / isp / unknown（2026-10-17 已实现，未接准入）

三个库到手后先做的不是黑名单，是**能不能可靠地分三桶**。结论：能，但 cloud 这一桶只有一半可信，
isp 这一桶永远不能读成"家宽"。

| 桶 | 含义 | 判定依据 | 能不能直接封 |
|---|---|---|---|
| `cloud` | 托管 / 机房 / CDN / 云厂商：普通玩家不从这里上来 | 人工核对过的 ASN 表（74 个），或带边界的品牌名 | 可以，建议只认 `asn` / `name` 两级 |
| `isp` | 普通运营商：家宽、移动、企业专线、学校、政府混在同一个 ASN 里 | 有 ASN 记录且没命中主机特征 | 不可以。这一桶**不含任何家宽信息** |
| `unknown` | 查不到 ASN（未分配、部分 IPv6、私网） | 没有记录 | 不可以，如实当未知 |

再加一个 `confidence`：`asn`（人工表）> `name`（品牌整段匹配）> `weak`（只命中 HOST / xCLOUD / IDC 这类通用词，
默认不封）。代码：`server/geoipAsn.js` 读库、`server/netClass.js` 分类、`tools/geoip-classify.mjs` 出报告、
`test/net-class.test.js` 钉规则（真库用例走 `SP_ASN_TEST_DB`）。

### 实测（2026-10-17，1200 万随机 IPv4，8734855 次命中，64599 个不同 ASN）

| 结果 | ASN 数 | 地址空间占比 |
|---|---|---|
| `cloud` / `asn`（人工表，74 个） | 74 | 11.82% |
| `cloud` / `name`（品牌匹配） | 116 | 0.16% |
| `cloud` / `weak`（通用词，仅线索） | 1339 | 0.43% |
| `isp` | 63069 | 87.52% |

这些比例是**地址空间**权重，不是玩家权重：随机抽样会让 DoD（AS749）这种巨型段排到最前面；真正在玩的人
从哪里来，只能看自己的连接日志。查一台具体机器很直观：

```bash
node tools/geoip-classify.mjs 202.96.128.86     # isp   — Chinanet 家宽
node tools/geoip-classify.mjs 154.219.110.142   # isp   — cognetcloud INC,单词粘连让边界匹配失效,只能落默认
node tools/geoip-classify.mjs <节点地址>     # cloud — CHINANET SHAANXI province Cloud Base network(weak)
```

### 名字匹配为什么必须带边界（库里真实存在的撞车）

- 裸 `/CLOUD/` 命中一堆**家宽**品牌：`Cloud Telecom LTDA`、`Cloudlink Communications`、`Cloudlasers Broadband`、
  `Cloud 9 Wireless LLC`、`cloudsky superfast broadband`、`Cloud Net Cable and Telecom`。
- 裸 `/AMAZON/` 命中巴西运营商：`AMAZONET TELECOMUNICACOES`、`AMAZONIA TELECOMUNICACOES`、`AMAZONFIBER SERVICOS`。
- 裸 `/GOOGLE/` 命中 **Google Fiber**（AS16591），那是正经家用宽带；同理 `Alibaba Travel Company`（AS34947，伊朗旅行社）。
- 反向的坑：`Huawei do Brasil Telecomunicacoes` 名字带 Huawei，却是巴西运营商网络。

所以现在的顺序是：人工 ASN 表 → 品牌整段匹配 → 消费级词（FIBER / BROADBAND / WIRELESS / CABLE / TELECOM /
MOBILE）一旦出现就压回 `isp` → 通用托管词只到 `weak`。AS16591 单独进 `ISP_ASNS` 覆盖表，先于任何名字规则生效。

### 边界（别忘）

- **isp ≠ 家宽**。企业专线和中小机房与家宽用户共用 ASN，这一桶一个字节的家宽信息都没有。
- 公共 DNS、CDN 的出口都落在 cloud 桶（`114.114.114.114` 是 Zenlayer AS21859）；但玩家**经**公网 DNS 出网时
  看到的是自己的运营商地址，不是解析服务器地址。
- 云厂商的 VPN / WARP 出口也在这一桶：一个正常玩家可以合法地从 Cloudflare 或 M247 上来。封 cloud 桶的真实
  代价是"挂 VPN 的玩家进不来"，得先接受再谈封禁。
- MaxMind 的 Connection Type（宽带 / 企业 / 移动 / 卫星）与 Anonymous IP（托管 / VPN / 代理）是另外两个产品，
  需要账户与授权；当前仓库没有，也不该假装 ASN 能替代它们。

### 本次的决定

- 只做分类与观测：没有加任何自动封禁，也没有因为 `cloud` 桶放宽或收紧配额。
- 家宽不自动放宽，每 IP 仍然 4 条并发 WS（`SP_IP_MAX_SESSIONS_PER_IP`），与用户指定的参数一致。
- ASN 库不进玩家发行包、不进 `public/` / `data/` 等静态目录，只在本地分析时读取；规则认错的方向是安全的
  （认不出来只会落到 `isp`，不会把玩家误封）。

## 明确屏蔽名单：ASN + 国家 + 逐条 IP（2026-10-17，默认开启）

分类器只是观测；真正执行的是这一层，名单是**枚举**出来的，判定就是查表，不做任何推断。

| 层 | 内容 | 数据 | 代码 |
|---|---|---|---|
| IP | 84 个扫描源（含被 CF 日志抓到的地址） | 硬编码 | `server/netBlock.js` `BLOCK_IPS` |
| 国家 | TW / VE / EC | GeoLite2-Country | `BLOCK_COUNTRIES` |
| ASN | 133 个机房 / 云 / 廉价 VPS / 防弹主机 | GeoLite2-ASN | `BLOCK_ASNS` |

命中顺序是 IP → 国家 → ASN（代价从低到高），任一命中即 403。两个入口共用同一条判定：
HTTP 游戏文档（`server/http/routes.js`）与 WebSocket 升级（`server/http/websocket.js`），
判定本身在 `Network.networkBlocked()`（`server/net.js`），审计日志动作名 `connection.netBlock.denied`。
响应体与既有海外门禁**一字不差**（`FOREIGN_CONNECTIONS_DISABLED`），客户端不需要认识第四种拒绝；
原因只进日志。

### 开关与部署

- `SP_NET_BLOCK`：`on`（默认）/ `off`。默认开是用户的决定（"全部默认屏蔽"）。
- ASN 库路径：`SP_GEOLITE_ASN_DB`，默认 `geoip/GeoLite2-ASN.mmdb`（该文件不进 git，也不进玩家发行包）。
- **ASN 库缺失时只降级、不拦启动**：日志打出 `[netblock] ASN 库不可用`，133 条 ASN 不生效，
  国家与逐条 IP 照旧。这样一次 `git pull` 不会把服务器起不来；要彻底关掉用 `SP_NET_BLOCK=off`。
- 启动日志 `[netblock] on: 133 ASN / 3 地区 / 84 IP` 表示三层齐全。

### 核对这批号码时发现的两件事

1. **名单里混着两个正经运营商**：`AS6871` 是 British Telecommunications Limited（英国电信，家宽），
   `AS4773` 是 MobileOne Ltd.（新加坡移动）。不是机房，挡了就是挡掉英国宽带与新加坡移动的玩家。
   代码里放在 `CONSUMER_ASNS_IN_LIST`，启动时逐个点名警告；名单本身按用户要求保持不变，
   要留人就把这两个号码从 `BLOCK_ASNS`（和 Cloudflare 规则）里删掉。
2. **`114.114.114.114` 与 `223.5.5.5` 也在名单上**：它们分别由 Zenlayer（AS21859）与
   Alibaba US（AS45102）宣告。它们是公共 DNS，不会有人从那里玩游戏，但它们**不能**再被当作
   "大陆放行"的测试样本 —— 测试里已改用 `202.96.128.86`（Chinanet AS4134，普通家宽）。

### 第二批 23 个（2026-10-17，用户「加进去」）

用户自己的攻击日志把缺口指出来了，所以补的时候是按证据挑的，不是按名气：

- **大陆云三家**：`45090` 腾讯云大陆、`37963` 阿里云杭州、`38365` 百度。此前名单里腾讯只有 `132203`（香港）、
  阿里只有 `45102`（美国）、华为只有海外段，**大陆段一条都没有**，而日志里腾讯大陆段出现 5 次
  （`124.223.31.113`、`42.193.180.64`、`43.142.51.107`、`42.193.21.113`、`159.75.43.39`）。
- **他日志里实际出现的香港/印度小机房与代理出口**：`140042` Zhipinshang（组织占比 5.81%）、`6134` XNNET（3.62%）、
  `139180` Shandong eshinton（3.29%）、`150623` HOSTDZIRE（2.20%）、`209554` ISIF OU、`153771` Heptasky、
  `402506` Zenixcloud、`50360` Tamatiya EOOD。
- **防弹 / 滥用机房**：`3223` Voxility LLP、`202425` IP Volume inc、`200651` FlokiNET ehf、`60117` Host Sailor、
  `49981` WorldStream、`29802` HIVELOCITY、`46606` Unified Layer、`54290` Hostwinds、`206092` F.n.s. Holdings、
  `394711` KorGrid、`49505` JSC Selectel、`204601` NovoServe —— Mirai 变种、挖矿与勒索的 C2 常租处。

顺带纠正一个容易搞错的前提：**僵尸网络不拥有 ASN**。Mirai / Mozi / Kinsing 是软件，跑在别人的机器上，
名单只能封房东。"封 ikuuu" 同样如此：它不宣告 ASN，出口租在 Oracle 免费层、Akamai、Akile、腾讯轻量上，
封的是这些房东（Oracle `31898` 本来就在名单里）。真正封不住的是**住宅代理**（911 S5、F3 之类），
它们的出口就是普通家宽，ASN 与国家都认不出来。

剩下 108 个在 ASN 库里查到的组织名全部是托管 / 云 / 廉价 VPS（Datacamp、Hetzner、M247、Hostkey、
Timeweb、netcup、Latitude.sh、cognetcloud…）。逐条明细可以用
`node -e` 遍历 `BLOCK_ASNS` + `geoip/GeoLite2-ASN.mmdb` 复现，或者看 `ops/cloudflare-net-block.rules`
里同一份集合。

### 边界

- **只拦新连接**：已经建立的 socket 不会被踢下线；名单变更后要让现有会话按正常流程离开。
- 名单是枚举的：新扫描源、ASN 归属变化都要人工维护，没有任何自动学习。
- 玩家发行包不带 ASN 库，所以玩家自建的服务器只会有国家与 IP 两层。
- 边缘侧同一份名单在 `ops/cloudflare-net-block.rules`（CF 用 `ip.geoip.asnum` / `ip.geoip.country` /
  `ip.src` 三个集合），两边要一起改。
