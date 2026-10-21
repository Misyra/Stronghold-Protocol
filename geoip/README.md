# 国家库（GeoLite）

服务端用它识别来源国家，供三处判断使用：海外 AI 席位上限（`SP_BOT_MAX_FOREIGN`）、连接准入
（`SP_ALLOW_FOREIGN_CONNECTIONS`）和 `foreign` 人群的单 IP 会话配额。库只在游戏进程启动时从本地读一次，
游戏请求期间不下载、不联网查询，也不发给浏览器。

| 文件 | 库类型 | 大小 | 构建时间 | sha256 |
|---|---|---|---|---|
| `GeoLite2-Country.mmdb` | `GeoLite2-Country`（全球，含 IPv6 记录） | 3.25 MiB（3408573 字节） | 2026-10-16 | `55fb913b4a5ab69fb0bbe11f86242b8a3f64061205227f4c1efceef7e14e5dbc` |

上表是写这份文档时实测的那一版；`node tools/fetch-geoip.mjs` 每次下载都会打印它实际拿到的 sha256。

**下载**（这份库从 2026-10-19 起不入库）：

```bash
node tools/fetch-geoip.mjs          # 两个镜像，下载后校验体积与 MMDB 尾标；已存在则跳过
node tools/fetch-geoip.mjs --force  # 换库
```

Docker 镜像在构建阶段自动下载，`--build-arg FETCH_GEOIP=0` 可跳过。缺库时服务照常启动，只打一条
`[geoip] no country database configured` 警告并关掉海外 AI 席位上限，其余规则不变。

配置（变量含义与判定规则见 [房间与连接保护](../custom_docs/operations/ROOM_PROTECTION.md)，部署步骤见
[部署指南](../custom_docs/operations/DEPLOY.md)）：

```ini
SP_GEOLITE_COUNTRY_DB=/opt/Stronghold-Protocol/geoip/GeoLite2-Country.mmdb
SP_GEOIP_MODE=country
```

**模式必须与库匹配**。这是全球库，只能配 `country`（默认值）。启动时校验常用样本，配错会直接报错而不是
静默放行：把全球库配成 `cn-only` 会因 `8.8.8.8` 命中非大陆而拒绝启动；反过来，只含大陆地址的库（如
Hackl0us/GeoIP2-CN）也不能按 `country` 模式用，否则海外来源会被当成未知而放行。

**为什么放在 `geoip/`**：`tools/package.mjs` 的玩家发行包是对 `git ls-files` 的白名单（`server/`、
`shared/`、`data/`、`public/`、`packs/`、`schemas/` 随包分发），而 MMDB 不随游戏分发。`geoip/`
不在白名单内，所以它不会进玩家 zip；库也不能放在任何静态目录（`public/`、`data/`、`shared/`、
`packs/`）——游戏启动时会把这类路径判为错误并拒绝启动。它同样不在版本库里：`git pull` 不会带回任何
`.mmdb`，换机器或换库都要跑一次上面那条命令（或把文件复制到相同位置）。

## 来源与许可

- 数据由 [MaxMind](https://www.maxmind.com/) 以 GeoLite2 形式发布，采用
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 许可。从 MaxMind 官方下载需要注册账户并接受
  GeoLite2 EULA，该 EULA 对再分发有额外限制；当前文件于 2026-10-17 使用账户授权从 [MaxMind 官方下载接口](https://dev.maxmind.com/geoip/updating-databases/#directly-downloading-databases)下载，数据库构建时间为 2026-10-16。署名见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。
- 再分发本仓库（或基于它的镜像）前请自行确认这些条款。不想带这个约束时，换成
  [DB-IP Lite](https://db-ip.com/db/download/ip-to-country-lite)（CC BY 4.0，可再分发，同样含 IPv6）即可，
  读取路径、`country` 模式和启动校验都不变，只需改掉本文件里的来源与 sha256。

## 更新

本次部署也由 Nginx GeoIP2 直接读取此全球库，并用 `scripts/hardening/render-country-firewall.py` 从同一文件生成 nftables 国内来源集合。严格入口仅允许 `country.iso_code == CN`，含命中的 IPv6；未知也拒绝，与应用层的未知放行规则不同。库更新后须重新生成和校验内核集合、reload Nginx，再按下文重启应用，三层不会自动同步。详情见[主机加固](../custom_docs/operations/HOST_HARDENING.md)。

先下到临时文件（不要直接覆盖正在用的库），校验通过再原子替换，最后重启游戏：

```bash
curl -fL -o /tmp/GeoLite2-Country.mmdb "https://github.com/P3TERX/GeoLite.mmdb/releases/download/<tag>/GeoLite2-Country.mmdb"

# 校验：真库样本（CN / 非 CN / IPv6）与模式校验一起跑，失败会退出非 0。
# 两个样本清单是必填的：缺任何一个，真实库那条用例会被跳过（跳过在 node --test 里算通过）。
SP_GEOIP_TEST_DB=/tmp/GeoLite2-Country.mmdb SP_GEOIP_TEST_MODE=country \
SP_GEOIP_TEST_MAINLAND=223.5.5.5,2400:3200::1 SP_GEOIP_TEST_FOREIGN=8.8.8.8,2606:4700:4700::1111 \
  node --test test/geoip.test.js

mv /tmp/GeoLite2-Country.mmdb geoip/GeoLite2-Country.mmdb
sha256sum geoip/GeoLite2-Country.mmdb   # 换库后把新值写回本文件的表格与 THIRD-PARTY-NOTICES.md
sudo systemctl restart stronghold
```

下载失败就保留旧库，不要用空文件覆盖。换库只在启动时加载，重启才生效；服务器上的路径与文件本身一起备份。

## 启动时的表现

| 配置 | 日志 | 效果 |
|---|---|---|
| 库路径正确、模式匹配 | `[geoip] country database loaded in country mode` | 海外识别生效（连接准入、海外 AI 上限、`foreign` 会话配额） |
| 未配置 `SP_GEOLITE_COUNTRY_DB` | `[geoip] no country database configured; foreign AI limit is disabled, total AI limit remains active` | 游戏照常启动，未知来源一律放行，全服 AI 总量限制仍生效 |
| 库缺失、损坏、是 ASN 库，或模式与库不匹配 | 启动失败并报错 | 不会启用空白名单，也不会把所有人当成海外 |

```bash
# 只验这一个库而不启动服务器
SP_GEOIP_TEST_DB=geoip/GeoLite2-Country.mmdb SP_GEOIP_TEST_MODE=country \
SP_GEOIP_TEST_MAINLAND=223.5.5.5 SP_GEOIP_TEST_FOREIGN=8.8.8.8 node --test test/geoip.test.js
```

## 本地可选数据库

2026-10-17 同时从 MaxMind 官方下载了 ASN 与 City 两库，只供本地分析，已忽略、不随仓库提交；游戏运行时仍只读 Country 库。

| 文件 | 库类型 | 大小 | 构建时间 | sha256 |
|---|---|---|---|---|
| `GeoLite2-ASN.mmdb` | `GeoLite2-ASN`（IPv4/IPv6） | 8.56 MiB（8977215 字节） | 2026-10-17 | `358da21ba0a945f4bbc1152d02f98acff291c08e0ea1a6820e3fd6e0361e97bd` |
| `GeoLite2-City.mmdb` | `GeoLite2-City`（IPv4/IPv6） | 48.5 MiB（50901339 字节） | 2026-10-16 | `fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029` |

ASN 库用来把地址粗分成 cloud / isp / unknown：`server/geoipAsn.js` 读库、`server/netClass.js` 分类、
`tools/geoip-classify.mjs` 出报告。它只在本地跑，不进玩家发行包，也没有接进任何准入判定。

```bash
node tools/geoip-classify.mjs <地址> [<地址> …]
node tools/geoip-classify.mjs --sample 300000        # 桶分布 + 命中的机房 ASN
SP_ASN_TEST_DB=geoip/GeoLite2-ASN.mmdb SP_ASN_TEST_CLOUD=104.16.0.1 SP_ASN_TEST_ISP=223.5.5.5 \
  node --test test/net-class.test.js
```

ASN 仍不是住宅/机房标签（同一条运营商 ASN 里同时坐着家宽、企业专线和中小机房），规则与实测精度见
[机房来源分级](../custom_docs/operations/IDC_PROTECTION.md)。
