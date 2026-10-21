# 部署指南

这是本分支部署与更新的总入口。所有命令默认从项目根目录执行，Node.js 要求 22 或更高；线上运行一个常驻 Node 进程，并将站点部署在域名根路径。

| 场景 | 看这里 |
|---|---|
| 限额、共享 IP 与 A/B/C 逐机验收 | [LIMITS.md](LIMITS.md)（当前参数唯一汇总） |
| Linux 生产站点 | 本文的安装、systemd、反向代理和更新步骤 |
| Docker | 本文的容器步骤 |
| Windows / 家用小主机 / 整合包升级 | [HOME_SERVER.md](HOME_SERVER.md) |
| 游戏内公告发布与接入 | [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md) |
| 素材 R2 发布、预载和清理缓存 | [CDN.md](CDN.md) |
| 对局检查点与备份恢复 | [PERSISTENCE.md](PERSISTENCE.md) |
| 制作发行包 / Windows 便携包 | [PACKAGING.md](PACKAGING.md) / [WINDOWS.md](../../docs/WINDOWS.md) |

## 安装

```bash
git clone https://github.com/Misyra/Stronghold-Protocol.git /opt/Stronghold-Protocol
cd /opt/Stronghold-Protocol
npm ci --omit=dev
```

### 生产前端构建

源码模式仍可直接运行。生产推荐在独立构建目录安装开发依赖并生成 Vite 产物：

```bash
npm ci --include=dev
npm run build
```

构建输出为 `public/build/`，不会复制整套美术资源。服务启动时检测到 `public/build/index.html` 就使用构建入口；缺少构建时自动使用源码入口。`npm run dev` 或 `node server/index.js --source-client` 始终使用源码入口。

资源 Service Worker 同时打成独立的 `build/assets/resource-sw-<哈希>.js`，减少其源码依赖的重复 304。Node 代理模式自动提供根作用域所需响应头；Nginx 若直接读取 `/build/` 文件，须补 `add_header Service-Worker-Allowed "/" always;`，并验收 SW 根 scope 注册与离线取图。详见 [CDN 与 SW 缓存](CDN.md#源站-304-与-service-worker)。

以下源码更新命令不会自动刷新已有构建。启用构建模式的站点，每次更新代码时都必须同步同一版本的新 `public/build/`；不能只拉代码并重启。发行 ZIP 仍按原流程使用源码入口，不会自动收录本机未跟踪的构建目录。

发布时先上传新哈希资源，再原子替换构建入口，并按正常维护流程重启业务服务以刷新版本信息；不要在运行目录边构建边覆盖入口。构建默认保留旧 chunk，发布同步也不得使用删除旧 chunk 的规则，否则旧标签页后续加载会失败。清理期限需要覆盖允许的旧页面及对局存活期。

这只保留构建 JS/CSS 等内容哈希资源；现有 `/_v/` 数据、资源清单和服务端协议仍有独立兼容边界，不能据此承诺跨不兼容版本不停服。开发依赖只用于构建，运行机器可以只安装生产依赖；同时运行一次 `node tools/vendor.mjs`，保留源码回退和可选加载所需的库。Docker 构建阶段已包含 Vite，最终镜像仍仅含生产依赖。

素材来源选择一种：

- 本机提供素材：运行 `node tools/setup.mjs`，下载失败可重跑续传；缺失明细和环境诊断用 `node tools/doctor.mjs`。
- 使用已发布的本站 CDN：配置 `SP_ASSETS_CDN=https://assets.misyra.com`，把发布机生成的 `.assets-manifest.json` 放到项目根（`scp` 过去；镜像构建时会自动生成），无需在服务器下载整套素材。新建自己的 CDN 先按 [CDN.md](CDN.md) 配置和发布。

`public/assets/local/` 从 2026-10-19 起不再随 Git 下载（65 MB）：用 CDN，或在本机跑 `node tools/setup.mjs --local` 提取，或从同版本完整包复制；之后 `npm run manifest` 生成指纹清单。CDN-only 游戏节点确认清单与 CDN 对象齐全后可删除 `public/assets/` 和字体二进制，只保留 `public/fonts/fonts.css` 供服务器改写字体 URL；CDN 不可用时源站素材回退会 404。资源来源、客户端提取和清单见[素材说明](../../docs/ASSETS.md)。源码部署不要混用上游发行包中的程序文件。

## 配置

推荐把线上配置放在 `/etc/stronghold/game.env`，由服务管理器加载。`npm start` 不会自动读取根目录 `.env`。

```dotenv
PORT=3000
HOST=127.0.0.1
SP_STATE_FILE=/var/lib/stronghold/game
SP_ASSETS_CDN=https://assets.misyra.com
SP_MODERATION_KEY_FILE=/etc/stronghold/moderation.key
# 公告来源：不填就是默认值，不需要探针也能发（见下）
# SP_ANNOUNCEMENT_SOURCE=agent
```

**公告不依赖监控探针**。默认模式先读探针写的那份文件，读不到就退到仓库里的 `config/announcements.json`——直接改它就能发，不用重启，10 秒内生效。整个服只有一条维护公告时，这样就够了；`SP_ANNOUNCEMENT_SOURCE=file` 是另一种更简的单条格式。只有多台机器、想让人在网页上点一下发布、或者要「面板保存 → 探针写入 → 游戏读到」三层状态时，才值得另装探针——探针和面板都属于 sp-portal 项目，代码不在本仓库，本仓库只负责读那份文件。已有 feed 部署升级时显式改为 `panel` 并保留 URL。全部规则与示例见[公告接入](ANNOUNCEMENTS.md)。

联机断线保留席位 10 分钟；单人对局可在断线后 24 小时内恢复。

默认开启服务端检查点；保留状态目录可恢复最近的安全阶段，作战进行中重启可能重打该回合。状态目录包含私有重连身份，必须随配置一起备份。具体恢复边界见 [PERSISTENCE.md](PERSISTENCE.md)。

### 明确屏蔽名单（ASN + 国家 + IP，默认关闭）

`server/netBlock.js` 里有一份枚举名单：133 个机房 / 云 / 廉价 VPS / 防弹主机的 ASN、TW/VE/EC 三个地区、
84 个逐条来源 IP。命中任一条，游戏文档与 WebSocket 升级都返回 403（与既有海外门禁同一个响应体）。
默认 **off**，要拦就显式 `SP_NET_BLOCK=on`。

ASN 库走 `SP_GEOLITE_ASN_DB`（默认 `geoip/GeoLite2-ASN.mmdb`）。这个文件不在仓库里，需要自己下载放到
`geoip/`；**没有它时 ASN 那 133 条不生效，只降级不拦启动**，日志会打 `[netblock] ASN 库不可用`。
启动日志 `[netblock] on: 133 ASN / 3 地区 / 84 IP` 表示三层齐全。名单里混着两个运营商号码
（AS6871 英国电信、AS4773 新加坡移动），启动时会点名警告——要留人就把它们删掉。
详见[机房来源分级](IDC_PROTECTION.md)，Cloudflare 侧的同一份表达式在 `ops/cloudflare-net-block.rules`。

### 国家库（GeoLite，可选）

海外 AI 席位上限、连接准入与 `foreign` 人群的单 IP 会话配额都要先识别来源国家，需要一个 Country `.mmdb`。库不入库（从 2026-10-19 起），在服务器上跑一次 `node tools/fetch-geoip.mjs` 下载到 `geoip/GeoLite2-Country.mmdb`（Docker 镜像在构建阶段自动下载；不进玩家发行包）：

```ini
SP_GEOLITE_COUNTRY_DB=/opt/Stronghold-Protocol/geoip/GeoLite2-Country.mmdb
SP_GEOIP_MODE=country
```

`SP_GEOIP_MODE` 必须与库匹配：全球库用 `country`（默认），大陆专用库（Hackl0us/GeoIP2-CN）用 `cn-only`。模式配错、库缺失或损坏都会在启动时报错，不会静默放行；库也不能放在 `public/`、`data/`、`shared/`、`packs/` 静态目录中。来源、校验值、许可与更新步骤见 [geoip/README.md](../../geoip/README.md)，各变量、判定规则与限制见[房间与连接保护](ROOM_PROTECTION.md)。启动日志出现 `[geoip] country database loaded in country mode` 即生效；未配置时游戏照常启动，只是海外相关限制不启用。

<a id="4-macos--linux-常驻"></a>

## 开服流量（0.2.6）

开服的电脑主要在两处出流量：素材（图片 / Spine 模型 / 音频）和对局期间的 WebSocket 消息。0.2.6 起：

- **WebSocket 消息压缩**：1 KB 以上的消息走 permessage-deflate（`SP_WS_COMPRESSION`，默认 `on`），一局单人对局的服务器消息实测从 173 KB 降到 60 KB。客户端声明 `server_max_window_bits` 比服务器小时，握手不再被拒，而是回落到不压缩。
- **素材地址版本化长期缓存**：本机模式下发 `/_v/<tag>/…`（`server/assetVersion.js`，整棵素材树的内容哈希，字节没变 tag 就不变）；CDN 模式按文件哈希发 `<base>/assets/…?v=<hash>`（见 [CDN.md](CDN.md)）。重新解压、重建容器只要字节没变，玩家就不重下。
- **brotli**：脚本、样式、数据和 `.skel`/`.atlas` 在浏览器声明 brotli 时用 brotli（质量 5），否则 gzip；图片和音频原样发送。浏览器只在 https 页面（和 `localhost`）上声明 brotli，所以隧道 / 域名访问用 brotli，局域网 `http://192.168.x.x:3000` 用 gzip。代理不需要再开压缩。
- **静音不下载背景音乐**：静音或背景音乐音量 0 时不下载 BGM，恢复可听后再取当前该放的那首。
- **教程图 WebP**：本地提取的 19 页玩法说明每页另存 WebP（有损，质量 90，19 页由约 25.6 MB 降到约 4.2 MB），看说明时只预载下一页。重新提取用 `python3 tools/local-extract/extract.py --webp`。
- **看主机的出流量**：本机或局域网打开 `http://localhost:3000/healthz?traffic=1`，`traffic.http` 是按类别（assets / audio / code / data）发出的字节与请求数，`traffic.ws` 是 WebSocket 的线上字节与压缩前的消息字节。数字只在内存里，重启清零；只有本机 / 局域网访问能看到。玩家那边：设置 →「问题反馈」的诊断里有一行 `traffic:`，是本页打开以来的下载量（`cached` 是浏览器缓存直接给的）。

**固定访问地址能省很多流量**：浏览器的缓存、设置、本机统计和断线令牌都按地址（域名或 IP + 端口）分开保存。地址一换，对玩家来说就是一个新网站：素材要重新下载一遍（第一局约 20–50 MB），设置和统计也看不到了。临时隧道每次重启都换域名，长期开服建议用命名隧道、Tailscale 或固定的公网 / 局域网 IP，让大家一直用同一个地址。

**HTTP/2**：客户端由数百个小脚本模块组成，隔着公网时建议让代理以 HTTP/2 提供页面（所有模块走同一条连接，首次进入对局明显更快）。Caddy 默认就是 HTTP/2；Nginx 见上面的 `http2`。服务器本身只说 HTTP/1.1，局域网或本机游玩不受影响。

**Cloudflare 缓存**（命名隧道或自己的域名经过 Cloudflare 时）：Cloudflare 默认只缓存常见扩展名，`.skel`、`.atlas` 和无扩展名的 `/media/…` 都不在其中。在「缓存规则」里加一条：主机名是游戏域名、路径以 `/assets/`、`/fonts/` 或 `/media/` 开头时「符合缓存条件」，边缘 TTL 选「使用源站的 Cache-Control」。`/data/`、页面和脚本不要加（它们要随服务器更新）。注意边缘公开缓存官方素材会增加被投诉的风险。

## Linux 常驻

先创建运行账号和可写状态目录（已有账号不必重复创建）：

```bash
sudo useradd --system --home-dir /opt/Stronghold-Protocol --shell /usr/sbin/nologin stronghold
sudo install -d -o stronghold -g stronghold /var/lib/stronghold
sudo install -d -m 750 /etc/stronghold
sudo chmod 600 /etc/stronghold/game.env
```

保存 `/etc/systemd/system/stronghold.service`：

```ini
[Unit]
Description=Stronghold Protocol game server
After=network-online.target
Wants=network-online.target

[Service]
User=stronghold
WorkingDirectory=/opt/Stronghold-Protocol
EnvironmentFile=/etc/stronghold/game.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=multi-user.target
```

代码和依赖须对 `stronghold` 可读，状态目录须可写。按 `command -v node` 修正 Node 路径，然后启动：

发布沿用现有停止保存、重启恢复和客户端自动重连流程，无需等待对局结束。先确认部署启用了存档目录且新旧进程使用同一目录；停止须留足最终存档时间，避免强制杀死。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stronghold
journalctl -u stronghold -f
```

macOS 临时运行可用 `scripts/start.sh`；Windows 自启见 [HOME_SERVER.md](HOME_SERVER.md#14-开机自动在后台运行)。

启动时会流式读取可公开资源的全部内容，计算跨机器一致的版本哈希；约 500 MB 素材需要读取同等规模的数据，耗时取决于磁盘速度和系统缓存。部署时记录从启动到 `/healthz` 首次成功的耗时，并给健康检查预留相应启动时间；不要用 mtime 代替内容哈希。

<a id="24-反向代理与-https有域名时"></a>

## 内核层封禁（可选，公网开服建议开）

`ops/` 里是这台机器用的永久封禁名单和加载器。它们不进玩家包，理由同 `geoip/`：
只属于部署机。

```bash
sudo install -m 0644 ops/banned-ips.txt     /etc/stronghold/banned-ips.txt
sudo install -m 0644 ops/blocked-ipv4.txt   /etc/stronghold/blocked-ipv4.txt
sudo install -m 0644 ops/blocked-ipv6.txt   /etc/stronghold/blocked-ipv6.txt
sudo install -m 0755 ops/sp-syn-ban-load    /usr/local/sbin/sp-syn-ban-load
sudo install -m 0644 ops/sp-syn-ban.service /etc/systemd/system/sp-syn-ban.service
sudo systemctl daemon-reload
sudo systemctl enable --now sp-syn-ban
```

`blocked-ipv{4,6}.txt` 由 `node tools/net-ban.mjs` 从 `server/netBlock.js` 的逐条 IP 生成，不要手改；
应用层名单一变就跑一遍再 `systemctl restart sp-syn-ban`（原子替换，不断流，但会清空 `auto4` 的 24h 自动封）。
`node tools/net-ban.mjs --check` 可以在部署前确认没有漂移。ASN 与地区不进内核层——nft 没有 ASN 概念。

两件事它做：

- **永久名单**（`perm4` / `perm6`，无 timeout）：名单里的 IP 在 `input` 链最先被 drop，连
  conntrack 之后的后续处理都到不了。IPv4 与 IPv6 分成两个集合——nft 不替你按地址族分流，
  混在一起整份表都会校验失败。
- **SYN 速率自动封**（`auto4`，24 小时）：同一 IP 超过 20 SYN/s（burst 40）就进集合。
  阈值按真实玩家峰值上浮留余量：实测 0.3 SYN/s，20 SYN/s 是它的 6.7 倍，另见 `ops/sp-web-syn-guard.nft`。

名单的维护方式和表结构见 [`ops/README.md`](../../ops/README.md)。

另有一份 **每 IP 的 SYN 速率闸**：

```bash
{ echo 'delete table inet sp_web_syn_guard'; cat ops/sp-web-syn-guard.nft; } | sudo nft -f -
```

它管的是「一个 IP 建连接的速率」，与上面的永久名单互补。默认值 30 次/分钟
（真玩家实测峰值 18 次/分钟，1.7 倍余量）。阈值依据写在文件头。

```bash
sudo nft list table inet sp_syn_ban          # 看计数器
sudo systemctl status sp-syn-ban             # 是否加载过
```

**不要指望 `/etc/nftables.conf`**：很多发行版上 `nftables.service` 是 `enabled`
但 `inactive`，而且那份 conf 里的 `flush ruleset` 会顺手清掉 ufw 的
`table ip filter`。这个 unit 是独立加载的。

## 反向代理

游戏必须在域名根路径运行；转发 WebSocket `/ws`，其余请求交给同一个 Node 实例。完整 nginx 配置使用 [scripts/nginx.conf.example](../../scripts/nginx.conf.example)，替换域名、证书及 Node 端口。`worker_processes auto;` 放在主配置顶层；`map` 放在 `http` 中。

首次采用或升级到该 nginx 示例时，先安装 GeoIP2 模块与 HTTP 级片段：`sp-business-limit-map.conf`、`sp-log-format.conf`、`sp-public-api-map.conf`、`sp-health-cache-map.conf`、`sp-page-global.conf`、`sp-geoip-country.conf`，每份只加载一次（已有 `conf.d/*.conf` 通配 include 时不要重复 include）。完整独立示例显式 load_module；Debian 已经通过 `modules-enabled` 加载时不要重复。缺少模块、国家库或片段会导致 `nginx -t` 失败。当前示例仅允许国家库命中 CN 的公网来源，关闭可选公开 API（昵称 HTTP 预检临时停用，原实现保留），保留 5 秒源站缓存的健康接口；本机监控绕过缓存。详见[接口防护](HTTP_PROTECTION.md)和[主机加固](HOST_HARDENING.md)。

Caddy 的最小配置：

```caddy
game.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx 修改后先 `sudo nginx -t`，通过后再 reload。Node 只监听本机时不必对公网开放 3000；公网入口使用 HTTPS。不要让多个 Node 实例共享一个状态目录。

完整 Nginx 示例支持将限流、永久封禁、海外 API 拦截转换为 444 静默断开，并拒绝 `/ws` 的普通 HTTP 请求。需要连同 Node 代码、回源 opt-in 请求头和内部 drop location 一起部署；配置和回滚见 [公开接口防护](HTTP_PROTECTION.md#444-静默拒绝)。正常错误与本机探针仍保留可读响应。

`/api/announcement` 转发到游戏 Node；面板公开 feed `/api/announce/v1/<siteId>` 由 sp-portal 提供，两者是不同接口。使用本仓库 Nginx 缓存片段时，公告只在源站共享缓存 5 秒，限流和封禁检查仍在缓存查找前执行；其他公开 API 不共享缓存。每个公告请求仍经过 Nginx 限流、封禁与访问日志，Node 的 API 计数只统计实际回源。公告浏览器响应保持 `no-store`；运维可用 `/api/announcement?nocache=1` 绕过共享缓存。防护配置见 [公开接口防护](HTTP_PROTECTION.md)。资源预载的 `/resource-sw.js`、`/js/resources/`、`/data/resource-manifest.json` 必须指向当前 Node，不能套用素材一年缓存规则。清单共享缓存的例外见下节，Worker 和普通 JS/CSS 继续遵循源站复验规则。

### 清单性能修复与 nginx 一次性更新

代码修复将资源清单的缓存判断提前到 JSON 读取、解析、URL 改写和遍历之前，未变化时直接复用结果；素材哈希清单每个进程只序列化一次。首次生成和源文件变化后仍需重建。热路径上只有缺失（ENOENT/ENOTDIR）才算依赖不存在，其他 stat 错误按失败拒绝而不是悄悄丢掉依赖；测试重置缓存时，进行中的旧构建仍会回答自己的调用方，但不会覆盖重置后新构建的缓存。没有新增环境变量，不需要重传 R2 素材，也不需要清理玩家浏览器资源包。

线上使用 [nginx-game-cache.conf.example](../../scripts/nginx-game-cache.conf.example) 的缓存与直出配置，Node 同时提供安装清单缓存：

| 路径 | 策略 |
|---|---|
| `/data/resource-manifest.json?v=<页面发布版本>` | 当前片段缓存 15 秒，查询参数参与 key；当前版本响应 immutable，旧/不匹配 query tag 回退 no-cache，并非 404 |
| 不带版本的 `/data/resource-manifest.json` | 兼容旧客户端和 Worker 后备读取，仅缓存 15 秒 |
| `/assets-manifest.json?v=<素材版本>` | nginx 缓存 30 天；浏览器保留源站不可变缓存头；只缓存 200 |
| `/api/announcement` | 源站 Nginx 缓存 5 秒；限流、封禁和访问日志仍按每个请求执行；`?nocache=1` 绕过缓存 |
| `/icons/` | nginx 直接读取图标，缓存 1 小时；未配置直出时 Node 同样缓存 1 小时；文件名无版本，更新图标最多延迟 1 小时 |
| `/manifest.json` | Node 提供，浏览器缓存 1 小时，过期后通过 ETag 复验 |

新页面自动带资源清单版本，发布版本随代码、数据和素材变化。当前 Node 未发送 `X-Accel-Expires`；片段忽略上游 Cache-Control/Expires 后，带版本与裸地址均按 `proxy_cache_valid 200 15s` 缓存，不能沿用旧文档的 12 小时承诺。Node 仅对匹配当前发布 tag 的 query 响应 immutable，其余 query 回退 no-cache；Nginx 仍可能保留 15 秒副本。查询串参与缓存 key，保留上游 `Vary` 处理；不使用过期回退。以后增加长期缓存必须先补版本校验与真实 Node 集成测试，不能只依赖模拟上游的 X-Accel-Expires。发布代码/数据/素材后重启 Node 刷新页面版本，不能仅热覆盖文件。

已有 nginx 站点不用整份替换主配置，按以下步骤合入：

1. 保留现有域名、证书、WebSocket、`/_v/`、普通 JS/CSS 和 ping 路由。在 `http {}` 中确认已有 `sp_assets` 缓存区（完整定义见 [nginx.conf.example](../../scripts/nginx.conf.example)），无需新建 `sp_status`。将 [nginx-log-format.conf.example](../../scripts/nginx-log-format.conf.example) 安装为 `/etc/nginx/conf.d/sp-log-format.conf`，只在 http 级 include 一次；目标站点 access_log 改用 `sp_game`，保留已有日志路径和轮转权限。完整主示例已接入该格式。
2. 安装片段，修改片段里所有 Node 端口及图标 `root`。本站独立静态目录可为 `/opt/sp-public`；普通源码部署可为 `/opt/Stronghold-Protocol/public`；须确认 nginx 能读取 `root/icons/app.svg`。Docker 若宿主机无图标目录，可先删除图标块，继续由 Node 提供。
3. 将原有上述同路径 location **替换或删除**，然后在游戏站点 `server {}` 加一行 `include /etc/nginx/snippets/stronghold-game-cache.conf;`。不要重复定义。片段的 `add_header` 在旧版 nginx 会覆盖继承的 `add_header`；站点原有必需响应头需一并保留。

```bash
cd /opt/Stronghold-Protocol
git pull --ff-only
npm ci --omit=dev
sudo install -d /etc/nginx/snippets
sudo install -m 644 scripts/nginx-game-cache.conf.example /etc/nginx/snippets/stronghold-game-cache.conf
sudo install -d /etc/nginx/conf.d
sudo install -m 644 scripts/hardening/sp-business-limit-map.conf /etc/nginx/conf.d/sp-business-limit-map.conf
sudo install -m 644 scripts/nginx-log-format.conf.example /etc/nginx/conf.d/sp-log-format.conf
sudo install -m 644 scripts/hardening/sp-public-api-map.conf /etc/nginx/conf.d/sp-public-api-map.conf
sudo apt-get install libnginx-mod-http-geoip2
sudo install -m 644 scripts/hardening/sp-health-cache-map.conf /etc/nginx/conf.d/sp-health-cache-map.conf
sudo install -m 644 scripts/hardening/sp-page-global.conf /etc/nginx/conf.d/sp-page-global.conf
sudo install -m 644 scripts/hardening/sp-geoip-country.conf.example /etc/nginx/conf.d/sp-geoip-country.conf
# 编辑片段的端口、图标 root，并合入上面的 server include 后：
sudo nginx -t
# 检查通过再依次执行；重启会短暂断连，恢复边界见 PERSISTENCE.md。
sudo systemctl restart stronghold
sudo systemctl reload nginx
```

资源清单使用新的缓存键前缀，不需删除整个 nginx 缓存。不要修改状态目录、公告目录或审核密钥。重启同时会关闭本次临时开启的 inspector；若启动参数本身包含 `--inspect`/`NODE_OPTIONS=--inspect`，需先去掉该选项。

当前示例的公告 location 使用独立缓存键，只缓存 200 五秒，不提供过期副本；Nginx 限流、封禁检查和访问日志在缓存查找前执行。Node API 计数只增加实际回源，不能把它解释为所有公告请求数。浏览器仍收到 `no-store`，普通页面以 30 秒轮询兜底；WS 版本变化和页面恢复时以 `?nocache=1` 及时读取最新内容。发布或撤销在普通缓存下最多有 5 秒传播延迟。

验证时使用游戏首页注入的 `__spAssetVersion` 拼出 `/data/resource-manifest.json?v=<版本>`，连续请求应从 `X-Resource-Cache: MISS` 变成 `HIT`；带原 ETag 的条件请求可由 Nginx 用新鲜缓存体返回 304，Node 回源数不增加。清单缓存到期后重新请求完整 200，不向 Node 做 304 再验证。素材清单看 `X-Asset-Manifest-Cache`；公告连续请求应出现 `X-Announcement-Cache: MISS` 后 `HIT`，`?nocache=1` 应绕过缓存；`/api/ping` 仍不共享缓存。普通 JS/CSS 不应被新增长 TTL。nginx 缓存减少 Node 回源和处理开销，不减少同样响应向玩家发送的字节；首次填充较大清单时仍可能产生正常的缓存文件写入。

完整示例的 `/healthz` 使用 5 秒 Nginx 源站缓存，公开完整响应与 `build=1` 分开规范化缓存键。回环探针完全绕过缓存；进程性能数据 `/metrics` 也不缓存且不对公网开放。浏览器响应仍是 `Cache-Control: no-store`；入口总限流、缓存填充锁和永久封禁计数不能省略，详见[接口防护](HTTP_PROTECTION.md)。缓存 location 显式 `proxy_buffering on`，避免继承 WebSocket 的关闭缓冲配置导致缓存不生效；不要全站覆盖 `X-Accel-Buffering: no`。`/_v/` 缓存键仍隔离 Host、端口、上游与完整 URI，只缓存 200，保留 Vary。Range 可由缓存完整素材切片，不能据此把 206 单独长期缓存；健康接口禁止 Range 分段。

<a id="3-docker"></a>

## Docker

从本分支源码构建，默认镜像不下载整套素材；以下使用已发布 CDN，并挂载持久化状态：

```bash
docker build -t stronghold-protocol .
docker run -d --name stronghold --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file /etc/stronghold/game.env \
  -e HOST=0.0.0.0 -e SP_STATE_FILE=/app/.state/server.state.json \
  -e SP_MODERATION_KEY_FILE=/run/secrets/moderation.key \
  -v /etc/stronghold/moderation.key:/run/secrets/moderation.key:ro \
  -v stronghold-state:/app/.state stronghold-protocol
```

容器内部需要监听 `0.0.0.0`，覆盖宿主机环境文件里的 `127.0.0.1`；状态路径同样覆盖为容器持久卷。不用 CDN 时，以 `--build-arg FETCH_ASSETS=1` 构建并移除 `SP_ASSETS_CDN`，或挂载宿主机已准备好的整个 `public/assets`（包括 `local/`）。镜像在构建阶段下载 `geoip/GeoLite2-Country.mmdb`（`--build-arg FETCH_GEOIP=0` 跳过）：容器里配置 `SP_GEOLITE_COUNTRY_DB=/app/geoip/GeoLite2-Country.mmdb`（`SP_GEOIP_MODE=country`）即可启用海外识别，也可以挂载宿主机自己的库替换它。

Compose 示例：

```yaml
services:
  stronghold:
    build: .
    ports: ["127.0.0.1:3000:3000"]
    env_file: /etc/stronghold/game.env
    environment:
      HOST: "0.0.0.0"
      SP_STATE_FILE: /app/.state/server.state.json
      SP_MODERATION_KEY_FILE: /run/secrets/moderation.key
    volumes:
      - "stronghold-state:/app/.state"
      - "/etc/stronghold/moderation.key:/run/secrets/moderation.key:ro"
      - "/var/lib/stronghold-announcement:/var/lib/stronghold-announcement:ro"
    restart: unless-stopped
    stop_grace_period: 30s
volumes:
  stronghold-state:
```

先运行探针安装脚本创建宿主机公告目录，再启动容器；公告目录整体只读挂载以支持原子替换。更新镜像后复用同一个持久卷。容器备份与恢复见 [PERSISTENCE.md](PERSISTENCE.md#docker)。

<a id="15-更新"></a>

## 更新与验收

先正常停止游戏并备份状态目录和 `/etc/stronghold/game.env`，再更新程序；首次从不支持持久化的旧版升级时，等旧进程的对局结束。

构建模式须先在独立目录准备本次版本的 Vite 产物；在下面启动服务之前，按「生产前端构建」的顺序同步新资源及入口。源码模式无需此步骤。

```bash
sudo systemctl stop stronghold
# 此时备份 /var/lib/stronghold 和 /etc/stronghold/game.env 到你的私有备份位置
cd /opt/Stronghold-Protocol
git status --short
git pull --ff-only
npm ci --omit=dev
# 本机素材模式才需 node tools/setup.mjs；CDN 模式同步同版本 data 素材索引、哈希索引和根发布清单，见 LIMITS.md。
# 构建模式：此时同步同版本的新 public/build/，保留旧哈希资源。
sudo systemctl start stronghold
```

若本机 setup 修改了 `data/assets.json`，先核对差异并备份，再恢复该生成文件后拉取；不要用整树重置覆盖配置和其他修改。回滚同时恢复对应版本的状态备份，不能假定旧代码能读取新版存档。

验收：

1. `curl -s http://127.0.0.1:3000/healthz`：版本、`assetsCdn`、`assetsManifest` 与在线统计符合部署配置；`curl -s http://127.0.0.1:3000/metrics`：`persist`、`workers`、`memory` 等进程诊断正常（该接口只对本机回环 / 私网应答）。
2. `curl -s http://127.0.0.1:3000/api/announcement`：`source.mode` 为 `agent`（无探针 feed 站点为 `panel`）；在面板发布后确认正文生效。
3. 浏览器打开游戏，创建并加入房间；确认 WebSocket 正常连接，刷新后可重连。
4. CDN 模式检查图片和音频请求带 `?v=`；预载窗口可导入资源包并显示结果。
5. 配置了国家库的服务器看启动日志 `[geoip] country database loaded in <mode> mode`：`geoip/GeoLite2-Country.mmdb` 不在 Git 里，换库用 `node tools/fetch-geoip.mjs --force`（或复制文件过去），换库后必须重启才生效；海外识别没生效时先查这条日志与 `SP_GEOIP_MODE`。

## 排错与调优

| 现象 | 检查 |
|---|---|
| 端口占用 | 是否重复启动了 systemd、计划任务或手动进程；先停止重复进程 |
| 画面或声音缺失 | `node tools/doctor.mjs`；CDN 模式核对清单和资源 URL，本机模式补跑 setup |
| 面板已发布，游戏无公告 | 核对 `/api/announcement.source`、探针推送状态、文件路径和日志 `[announcement]`；见[公告排错](ANNOUNCEMENTS.md#排错) |
| 重启后无法恢复 | `/metrics.persist`（本机回环）和状态目录权限；是否挂载原持久卷；见[持久化说明](PERSISTENCE.md) |
| 游戏能访问，但外部监控没有数据 | 本仓库只提供 `/healthz`（含 `?traffic=1`）和只给回环的 `/metrics`；采集端与面板属于 sp-portal 项目，不在本仓库 |
| CPU / 内存过高 | Worker 数量、队列与校验模式，见[性能说明](../development/PERFORMANCE.md) |
| 想知道开服电脑上传了多少流量 | 本机 / 局域网打开 `/healthz?traffic=1`，按类别看 `traffic.http` 与 `traffic.ws`；公网访问者只会拿到普通报告 |
| 素材地址里出现 `/_v/<tag>/` 前缀 | 这是本仓库的版本化地址（`server/assetVersion.js`）：素材字节没变前缀就不变、浏览器长期缓存，属正常现象；怀疑素材没更新时先确认服务器上真的换了文件 |
| 海外玩家 / 海外 AI 限制没有生效 | 启动日志是否有 `[geoip] country database loaded in … mode`；`SP_GEOLITE_COUNTRY_DB` 是否指向 `geoip/GeoLite2-Country.mmdb`，`SP_GEOIP_MODE` 是否与库匹配；未命中、内网与查询失败的地址按未知放行，属正常行为；见[房间与连接保护](ROOM_PROTECTION.md) |
| 启动即报国家库错误 | 库缺失、损坏、是 ASN 库，或模式与库不匹配（全球库配 `cn-only`，或大陆专用库配 `country`）；重新运行 `node tools/fetch-geoip.mjs --force`（库不在 Git 里，`git pull` 不会带回它），或按 [geoip/README.md](../../geoip/README.md) 更新 |

`SP_WS_COMPRESSION` 默认 `on`，可设 `off`；`SP_WORKERS` 控制模拟线程数，0 关闭，默认可用逻辑核心减 2、至少 1、最多 8。资源占用与真实并发有关，用 `/metrics` 观察 CPU、内存、队列与网络状况后调整，变量修改需重启。

`SP_ROOM_WORKERS`（默认 0，可选 1 到 SP_WORKERS，不得超过 SP_WORKERS，否则拒绝启动）启用按房间分组的模拟泳道：每个房间的模拟任务固定排进同一泳道的独立队列，不同房间的任务互不插队；对局本身仍留在主线程。开启后 `/metrics` 的 `workers.kind` 变为 `room-lanes`，并逐泳道给出房间数与任务明细。它只改变排队方式（队列隔离），不承诺任何性能收益；是否开启请结合 `/metrics` 的实测数据决定，变量修改需重启。

`SP_MATCH_WORKERS`（默认 0，可选 1 到 32）把**无插件对局整局搬进独立线程**（`server/workers/matchPool.js`，取自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol)）：计时器、AI、战场模拟与房间状态都留在那条 lane 里，主线程只转发帧、拍存档、回收泳道。0 时完全保持原样（对局在主线程）。开启后启动日志出现 `[workers] N match lanes`，`/metrics` 的 `matchWorkers` 给出每条泳道的房间数、排队与负载。

两条边界：带**玩法插件**（`cs` 非原版）的房间仍在它自己的 match host 里跑（插件内容集有自己的进程/线程）；lane 线程崩掉时，那条泳道上的对局**结束**——房间回到大厅，玩家还在，最后一份存档留在盘上（重启后还能把这一局接回去），不会写出半张战绩页；该泳道不再接新房间。只剩死泳道时开局会明确报错，重启即恢复。变量修改需重启。

重启后的对局也在 lane 里恢复：启动时 `restoreServerForBoot` 会等每条 lane 把检查点应用完再监听端口，所以「服务器被杀 → 重启」之后，房间和它那局仍然在后台线程里继续，而不是掉回主线程。启动日志会写明 `match #N restored in a worker`。

### 4 核 4 GB：线程与内存怎么取

线程不是越多越好，每条线程都自带一份游戏数据。在本机（4 核 4 GB）用真实战场实测：

| 项 | 实测 |
| --- | --- |
| 主进程 + 引擎 + 数据（空闲） | RSS 153 MiB，堆 38.5 MiB |
| 一个 worker 线程 | 约 **87 MiB RSS**（线程内 heapUsed 58 / heapTotal 103 / external 5.4 MiB） |
| 1 / 2 / 4 条线程跑真实战场 | RSS 244 / 331 / 504 MiB |
| 一场战斗 | 单线程 575 ms；4 条线程并行 4 场共 820 ms（约 2.8 倍） |

所以 4 核的取值：

| 变量 | 4c4g 取值 | 理由 |
| --- | --- | --- |
| `SP_WORKERS` | `2`（默认就是 `min(8, 核数-2)`） | 两条线程约 174 MiB，留两核给主线程与系统 |
| `SP_ROOM_WORKERS` | `0` | 泳道不增加线程，只是把同一个池按房间分队列；房间少时没有队头阻塞可解 |
| `SP_MATCH_WORKERS` | `0`；`>=` 四局同时跑再试 `1` | 一条 lane 是**另一条**约 90 MiB 的线程，外加整局状态 |
| `SP_VERIFY` | `off`（默认） | `all`/`sample` 会把每个被接受的结果再算一遍 |
| `SP_BOT_REHEARSAL` | `host` | AI 布阵试算交给房主浏览器，是这台机器上最省的一档 |
| `SP_REHEARSAL_PRESSURE` | 与上一行同时设 `off` | 试算已经不在服务器上，再按自己的负载降档没有意义 |

预算大致是：主进程 300–450 MiB（跑起来之后）+ 两条模拟线程 174 MiB + 持久化 Worker（不加载游戏数据，开销最小）+ Redis 封顶 384 MiB + 系统与浏览器，4 GB 里还有相当余量。**真正的瓶颈是主线程**：对局逻辑、AI 决策的编排和状态广播都在那里，worker 只接三类 CPU 活（AI 布阵试算、客户端战斗复算、校验），所以先看 `/metrics` 的 `memory`、`workers.queue` 与事件循环延迟，再决定加不加线程。

Windows 上给主进程封个顶，别让它把整台机器吃掉（实测空闲堆 38 MiB，768 MiB 足够）：

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=768'
npm start
```

<!-- 保留旧文档锚点，外部链接继续到达对应说明。 -->
<a id="16-维护公告"></a>
公告完整流程移至 [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md)。
<a id="17-素材-cdnr2可选"></a>
素材发布与缓存移至 [CDN.md](CDN.md)。
<a id="1-windows-小主机一步步"></a>
Windows 开服步骤移至 [HOME_SERVER.md](HOME_SERVER.md)。
<a id="2-让不在同一网络的朋友加入"></a>
家用网络接入移至 [HOME_SERVER.md](HOME_SERVER.md#2-家用网络接入)。
<a id="6-本地客户端素材可选"></a>
本地客户端素材见 [ASSETS.md](../../docs/ASSETS.md)。0.2.5 的官方战场场景同样不随 Git 仓库提供（提取结果是官方文件，`public/assets/local/scene/` 不提交）：需要时在有客户端的机器上运行 `node tools/setup.mjs --scenes`（或先 `python3 tools/local-extract/fetch_scenes.py` 再用提取环境的 Python 运行 `tools/local-extract/extract.py --only scene`）；没有场景时 3D 棋盘用程序生成的金属地块。
<a id="7-打包发布维护者"></a>
发行包制作移至 [PACKAGING.md](PACKAGING.md)。

## 昵称审查

**临时停用 HTTP 预检**：`public/js/screens/title.js` 的 `NICKNAME_PREFLIGHT_ENABLED=false`；Nginx 注释 `/api/nickname/validate` 放行项，并对该精确路径返回 444。原 HTTP 实现、代理配置和以下说明保留，WebSocket 最终审查照常。恢复时同步打开前端开关、恢复放行并移除临时 return，重新构建部署。

点击“开始”后，浏览器先向同源 `POST /api/nickname/validate` 提交 `{"name":"博士代号"}`，服务器通过才保存昵称并进入游戏。拒绝只回固定错误码，客户端显示“代号包含不适宜内容，请更换昵称”，并提示“如果你认为昵称没有问题，可以前往 GitHub 反馈”，提供本站仓库的 Bug 反馈链接；网络失败停留标题页，可重试。WebSocket `hello` 在创建会话、重连接管和改名前再次检查，不能靠跳过 HTTP 预检绕过。

词库来自 [konsheng/Sensitive-lexicon](https://github.com/konsheng/Sensitive-lexicon)，固定版本 `d967c30b053fa40b06c5a0dddf0be493f2dfae46` 的 17 份 `Vocabulary/*.txt` 与本站补充规则，已在部署前归一化、筛选、排序并去重，整合为唯一有效词表。42,812 条词先 gzip 压缩，再使用 AES-256-GCM 加密为 `server/moderation/lexicon/words.enc`；文件包含版本、随机 nonce、认证标签和密文，密钥独立保管。服务端启动时仅在内存中解密一次，再编译原有字典树及片段集合；每次昵称和聊天审核不进行解密，也不请求外部服务。空词、单字、超过昵称长度的词和已确认误伤的普通称呼、食物、游戏用语等词条在整合时排除（按完整词条删除，违规长词仍独立保留）；筛选记录、上游原始文件摘要及合并文件摘要见同目录 `SOURCE.json`，完整 MIT 许可证见 `LICENSE`。英文及纯数字按完整片段匹配，全角、零宽、大小写及插入符号在比较时归一化。词表仍可能误伤，按实际反馈维护规则。

**密钥部署（升级前必须完成）**：本次迁移生成的随机密钥只保存在开发机 `.state/moderation.key`，不随 Git、发行包或镜像分发。把同一份密钥通过私有渠道复制到每台服务器，例如 `/etc/stronghold/moderation.key`，赋予游戏运行账号只读权限（如 `root:stronghold`、`0640`），并在环境文件中设置 `SP_MODERATION_KEY_FILE=/etc/stronghold/moderation.key`。也可将 64 位十六进制值配置到 `SP_MODERATION_KEY`，该变量优先于密钥文件；默认读取项目根目录 `.state/moderation.key`。不要在服务器重新生成密钥：随机新密钥无法解开现有词表。缺少密钥、密钥错误或词表损坏会阻止启动，不会降级为不审核。密钥需纳入私有备份；不要提交、输出到日志或放入公开静态目录。Docker 需要只读挂载密钥文件，并设置容器内的 `SP_MODERATION_KEY_FILE`。

**仅服务端持有词库**：不放入 `shared/`、`data/`、`public/`、`server/sim/`、浏览器资源包或 CDN，不开放下载、列举或命中详情接口。维护规则时在仓库外编辑 UTF-8 文本（每行一个字面词，不支持正则，`#` 开头为注释），在已配置密钥的环境中运行 `node tools/encrypt-lexicon.mjs /私有路径/words.txt server/moderation/lexicon/words.enc`。同步 `SOURCE.json` 的词数、密文 SHA-256 与 `decodedSha256`，保留许可证并重启服务；只提交密文，不提交密钥和源明文。公开 CI 使用显式测试预加载器 `node --import ./test/helpers/moderation-fixture.js --test`，在未配置真实密钥时创建独立的小型测试词表，不需要生产密钥；正常启动不加载测试词表。HTTP 预检按网络限流，与房间状态接口预算分离。

加密保护的是当前文件，无法收回之前已公开的明文或 Base64 版本。旧 Git 历史、远程平台缓存及已有克隆需分别处理；密钥泄漏后应重新加密并更换部署密钥。公开上游词库本身仍可独立获取。

**反向代理**：`/api/nickname/validate` 必须转发到游戏 Node，并关闭缓存。在同机 `/api/` 已转发给 sp-portal 的部署中，增加 `location = /api/nickname/validate` 精确规则（参照 `scripts/nginx.conf.example`），避免被面板路由接走。不要用仓库根目录作为静态站点根目录。

标题页提交后显示校验结果；服务端在首次 hello、重复 hello 改名和令牌重连时最终检查，拒绝发生在创建或接管会话之前。旧保存昵称命中词表时回到标题页修改。新增规则不会主动踢出正在游戏中的玩家；其下次登录或重连按新规则校验。

### 局内聊天

默认关闭。设置环境变量 `SP_CHAT_ENABLED=on` 开启，`SP_CHAT_ENABLED=off` 关闭，未设置时也关闭；修改后重启游戏服务。各服务器独立配置。关闭时隐藏整个聊天区域，「交流」恢复为紧凑的纯表情面板，不保留输入框、提示或空白占位；服务端也拒绝聊天发送请求。

局内工具栏点击「交流」，同一面板上方输入聊天，下方选择表情；关闭面板保留草稿，发送成功后自动收起。关闭聊天功能时仍保留表情面板。通过审查的文字显示在发送者头像右侧，与表情共用弹出和淡出动画、显示时长（默认约 3 秒）；同一玩家新文字或表情替换上一条，其他玩家互不影响。重连同步的历史不会重新弹出气泡。

每条消息最多 30 个 Unicode 字符，至少间隔 1 秒。服务端使用启动时已解密的私有词表审查，命中词表的消息**直接拒绝发送**（错误提示「聊天包含不适宜内容，请文明交流」），只有干净内容会广播，局内最多保留 50 条；观战者只读。前三次违规只提示、不禁言；第 4 次起按 5 分钟、15 分钟、1 小时逐级禁言，第 7 次及以后最长 6 小时。上次违规或禁言结束后满 1 小时没有新违规，计数自动归零；禁言期间的新消息只被拒绝、不累计次数。刷新、重连、换房不清除违规记录或解除禁言。旧版按「10 分钟内 5 条命中禁言 12 小时」的滚动窗口记录命中时间戳，升级后迁移为最新命中时间与次数并沿用同一阶梯，已有禁言保留。配置 `SP_STATE_FILE` 后违规记录与禁言随会话保存并恢复，关闭状态保存时重启会丢失。当前没有登录账号，清除身份或换浏览器仍可获得新身份。

开启聊天后，服务端自动记录每条成功发送的**原始消息**（保留原有空格；命中词表的消息被直接拒绝，不会广播也不会落盘）。默认写入仓库下 `.state/chat-logs/YYYY-MM-DD.jsonl`，文件日期和记录时间均为 UTC；重启后继续追加，每天单独一份，默认不删除历史。每行是一个 JSON 对象，字段为 `at`（ISO 时间）、`ip`、`playerId`、`name`（昵称）、`roomCode` 和 `text`（原文）。昵称和 IP 使用服务端确认的信息，IP 沿用 `TRUST_PROXY` 的连接解析规则，不采信聊天消息自带的身份字段。命中词表、超长、频繁、禁言期间、观战者和关闭聊天时被拒绝的消息不落盘；重连历史同步不会重复记录。

可通过 `SP_CHAT_LOG_DIR=/var/lib/stronghold/chat-logs` 指定私有日志目录；修改后重启。目录不得位于 `public/`、`data/`、`shared/` 或内容包的公开目录内，目录链接也会检查。默认 `.state/` 已排除在 Git、发行包和 Docker 构建内容之外；容器需要挂载持久卷来保留日志。日志只在服务端本地保存，没有下载接口，客户端广播、房间历史和存档中仍只保留已通过审查的消息，不增加玩家 IP。写入异步排队且内存有上限；正常停服等待写完，磁盘或权限错误会在服务端错误日志中提示，不打断对局。

服务启动时和此后每小时在后台检查一次旧日志，逐个文件流式 gzip 压缩；今天和未来日期的文件继续保留 JSONL，归档文件为 `YYYY-MM-DD.jsonl.gz`，解压后的内容、空格和字段均不变。归档与追加写入串行处理，期间新消息仍可接收并排队；压缩失败保留原文件，写入队列满时会计入丢失记录并报错。同名归档不会被覆盖；若上次中断留下的归档与原文件内容完全相同，可安全移除重复原文件，否则保留两份并提示维护错误。多个游戏实例应使用各自独立的日志目录。

| 环境变量 | 默认值 | 行为 |
| --- | --- | --- |
| `SP_CHAT_LOG_COMPRESS_AFTER_DAYS` | `1` | 保留最近 N 个 UTC 日期的原文件，更早的日志压缩；`0` 关闭压缩 |
| `SP_CHAT_LOG_RETENTION_DAYS` | `30` | `0` 永久保留；正整数 N 仅保留今天及此前 N−1 个 UTC 日期，超过范围的 JSONL 和 gzip 归档会删除 |

例如 `SP_CHAT_LOG_RETENTION_DAYS=30` 保留最近 30 个 UTC 日期，修改后重启。清理只处理目录内日期有效的标准日志文件，不递归遍历目录、不跟随文件链接，也不删除其他文件；一天前遗留的本程序临时归档文件会回收。

`/metrics.chatLog`（只回应回环 / 私网调用者，公开的 `/healthz` 不含该字段）提供日志文件数、总占用字节数、原文件与归档的数量/大小、待写记录数、丢失记录数、维护错误次数、最近完成维护时间和保留配置。统计在后台扫描后缓存，正常追加成功时增量更新；初次扫描完成前大小和文件数为 `null`，目录不存在时完成扫描后为 `0`。接口不读取或返回消息正文、IP、昵称、日志目录路径或文件名，玩家界面不增加日志入口。

## 同盟房间收录到联机站

可选的一键提交入口与两端鉴权、限流配置见 [PORTAL_ROOMS.md](PORTAL_ROOMS.md)。未配置时不启用。

## 模板默认值

2026-10-19 的 gate 恢复修复仍待上线，安装顺序、实际端口、续签头继承与验收步骤见 [BROWSER_GATE.md](BROWSER_GATE.md)（含安装顺序与验收步骤）。完整修复包含 `30437428`、`2ec469e9`、`70bba335`，不要只拣最后一条文档/探针修正提交部署。先更新 gate 与 Nginx 并在目标机通过 `nginx -t`，再发布对应前端；保留密钥、现场健康防护及手工封禁。旧标签页首次可能仍需刷新。

当前模板参数、与 Node 的叠加关系、四人共网推荐配置及三机发布核验统一维护在 [LIMITS.md](LIMITS.md)。早期模板的 3000/800、4000、4 条 WS、5 次/min 属于历史值，不能继续用作新部署默认。现场以 `nginx -T` 和应用有效配置为准，逐机验收步骤见 [LIMITS.md](LIMITS.md)。
