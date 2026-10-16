# 国家库（GeoLite）

服务端用它识别来源国家，供三处判断使用：海外 AI 席位上限（`SP_BOT_MAX_FOREIGN`）、连接准入
（`SP_ALLOW_FOREIGN_CONNECTIONS`）和 `foreign` 人群的单 IP 会话配额。库只在游戏进程启动时从本地读一次，
游戏请求期间不下载、不联网查询，也不发给浏览器。

| 文件 | 库类型 | 大小 | 构建时间 | sha256 |
|---|---|---|---|---|
| `GeoLite2-Country.mmdb` | `GeoLite2-Country`（全球，含 IPv6 记录） | 3.25 MiB（3410978 字节） | 2026-10-09 | `635078e412c4443a2950c2e3f775ccdc400e0a1fea5ffd32e5489e5401a9e51d` |

配置（变量含义与判定规则见 [房间与连接保护](../docs/operations/ROOM_PROTECTION.md)，部署步骤见
[部署指南](../docs/operations/DEPLOY.md)）：

```ini
SP_GEOLITE_COUNTRY_DB=/opt/Stronghold-Protocol/geoip/GeoLite2-Country.mmdb
SP_GEOIP_MODE=country
```

**模式必须与库匹配**。这是全球库，只能配 `country`（默认值）。启动时校验常用样本，配错会直接报错而不是
静默放行：把全球库配成 `cn-only` 会因 `8.8.8.8` 命中非大陆而拒绝启动；反过来，只含大陆地址的库（如
Hackl0us/GeoIP2-CN）也不能按 `country` 模式用，否则海外来源会被当成未知而放行。

**为什么放在仓库根**：`tools/package.mjs` 的玩家发行包是对 `git ls-files` 的白名单（`server/`、
`shared/`、`data/`、`public/`、`packs/`、`schemas/` 随包分发），而 MMDB 不随游戏分发。`geoip/`
不在白名单内，因此它跟着 `git pull` 到服务器，但不会进玩家 zip；库也不能放在任何静态目录
（`public/`、`data/`、`shared/`、`packs/`）——游戏启动时会把这类路径判为错误并拒绝启动。

## 来源与许可

- 数据由 [MaxMind](https://www.maxmind.com/) 以 GeoLite2 形式发布，采用
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 许可。从 MaxMind 官方下载需要注册账户并接受
  GeoLite2 EULA，该 EULA 对再分发有额外限制；当前文件取自社区镜像
  [P3TERX/GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb) 的 `2026.10.13` 发布：
  `https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.10.13/GeoLite2-Country.mmdb`
  （入库时间 2026-10-16）。署名见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。
- 再分发本仓库（或基于它的镜像）前请自行确认这些条款。不想带这个约束时，换成
  [DB-IP Lite](https://db-ip.com/db/download/ip-to-country-lite)（CC BY 4.0，可再分发，同样含 IPv6）即可，
  读取路径、`country` 模式和启动校验都不变，只需改掉本文件里的来源与 sha256。

## 更新

先下到临时文件（不要直接覆盖正在用的库），校验通过再原子替换，最后重启游戏：

```bash
curl -fL -o /tmp/GeoLite2-Country.mmdb "https://github.com/P3TERX/GeoLite.mmdb/releases/download/<tag>/GeoLite2-Country.mmdb"

# 校验：真库样本（CN / 非 CN / IPv6）与模式校验一起跑，失败会退出非 0
SP_GEOIP_TEST_DB=/tmp/GeoLite2-Country.mmdb SP_GEOIP_TEST_MODE=country \
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
SP_GEOIP_TEST_DB=geoip/GeoLite2-Country.mmdb SP_GEOIP_TEST_MODE=country node --test test/geoip.test.js
```
