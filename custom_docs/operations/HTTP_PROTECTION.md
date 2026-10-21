# 公开接口限流与永久封禁

**默认关闭**：下面各项预算是 `0` 时这一维就不存在——不建计数桶、不封禁，请求直接进入业务。给任一预算填非零值才启用，且各维独立（只填速率就是只限速不封禁）。不依赖 Cloudflare，也不改变域名解析。修改 Node 环境配置后重启游戏进程；只改 Nginx 配置时通过 `nginx -t` 后 reload 即可。

可叠加[自动浏览器入口验证](BROWSER_GATE.md)：在缓存、页面、API 和 WS 握手前检查签名凭证；通过验证也不会豁免本页的请求与连接限额。

当前参数汇总、共享出口与封禁风险以 [LIMITS.md](LIMITS.md) 为准；本页说明防护机制和安装方式。

## 关闭公开探测接口

按当前部署选择，Nginx 对公网开放 `/api/ping`、`/api/announcement`、`/api/portal-room`、`/api/portal-room/status` 与 `/api/rooms/*`；游戏服务继续执行国家校验与 API 限流。其他 `/api` 路径和公网 `/metrics` 返回 444，不进入 Node、缓存或鉴权子请求。`/api/nickname/validate` 仍单独暂停，保留精确 Nginx 拒绝规则；本机监控只放行回环来源。`/healthz` 对国内来源开放，并使用下面的 5 秒缓存。将 `scripts/hardening/sp-public-api-map.conf` 安装为 `/etc/nginx/conf.d/sp-public-api-map.conf`，在目标 server 使用 `if ($sp_close_public_api) { return 444; }`。映射使用 Nginx 规范化的 `$uri`，查询参数、重复斜杠及编码字符不能绕过；不能接受客户端自报的本机地址。

`/api/nickname/validate` 当前临时停用：精确 location 用 `return 444` 阻断；前端 `NICKNAME_PREFLIGHT_ENABLED=false` 跳过 HTTP 预检。原代理配置、Node 接口实现和测试均保留。WebSocket `hello` 的最终昵称检查仍执行。公告拉取、延迟探测、门户登记与外部房间状态查询已按上方路由重新开放；本机 Node 监听与内部 `/_sp/ip-check` 继续工作。

下面的 Node 保护仍覆盖昵称接口和以后明确重新开放的 API；若要恢复公开探测，移除目标 server 的上述 `if`，保留下文限流和鉴权，然后检查配置并 reload。主机防火墙、fail2ban、内核与巡检部署见[主机加固](HOST_HARDENING.md)。

## 主页容量保护

主页全站额度由 `scripts/hardening/sp-page-global.conf`（HTTP 级 include）提供，并在游戏 server 的既有 `limit_req` 列表加入 `limit_req zone=sp_page_global burst=60 nodelay;`。`/`、`/play`、`/index.html`、`/build/index.html` 共用固定键，每台服务器合计 30 次/秒、突发 60 次；不同 IP、Host 和查询参数不能刷新总量预算。限流在 `auth_request` 前执行，超额 444，不生成验证页、不查询游戏封禁、不读取页面缓存。各 location 若自行声明 `limit_req` 会替换继承列表，新增主页入口时必须保留该全局 zone。素材与已有 WebSocket 消息不消耗主页额度。

这是一道容量保护：持续洪泛也可能抢占新访客的主页额度，并不能保证所有新访客仍能进入。访问日志中的拒绝请求仍然计数；不能把日志总请求数当成成功回源数。查看状态码、实际鉴权调用、游戏请求量和网卡吞吐一起判断。Nginx 只能处理已到达主机的流量；入口带宽被打满时，需要机房或运营商上游清洗，国内部署不需要依赖 Cloudflare。

## healthz 防刷与 5 秒缓存

该接口匿名、无状态、响应快，正常浏览器只在 `public/js/ui/buildGuard.js` 中每 60 秒检查一次版本。浏览器的 `cache: no-store` 只要求获取当前版本，不应让任意请求头或随机查询参数驱动昂贵回源。国别限制和单 IP 限流对一个无状态接口都不足以单独解决，所以这里同时做全局预算与缓存。

裸 `/healthz` 当前规则：单 IP 30/分（burst 10），所有来源共用 9/秒（burst 18），版本检查 `?build=1` 独立为单 IP 45/分（burst 12）、全站 40/秒（burst 120）；两类健康请求合计最多 48 个并发。超过额度 444。全局预算在 auth_request 和缓存读取之前执行，缓存命中仍受限流；内部封禁子请求不消耗这个预算。不能把服务总量限制误写成另一个按 IP 的 zone。

安装 `sp-health-cache-map.conf` 到 HTTP 级 include。公开请求仅分为“完整公开健康”和 `build=1` 两个缓存键，键不含 Host、客户端 IP 或任意 query；回源查询也按这两种形式规范化，避免大小写/重复参数使缓存内容错位。缓存仅保存 200、TTL 5 秒，启用填充锁，不使用过期副本或后台更新。Nginx TTL 按整秒判断，集成测试留出一秒边界余量。拒绝非 GET/HEAD 及带 Authorization 的健康请求，禁 Range 分段，刷新头不能强制回源。

回环监控同时绕过缓存读取和写入，保留原始查询；`?traffic=1` 诊断不进入公开缓存。响应给浏览器仍是 `Cache-Control: no-store`，`X-Health-Cache` 标明 MISS/HIT/EXPIRED/BYPASS。本次选择的是源站 Nginx 缓存，没有开启 Cloudflare 缓存或给 CF 网段开内核例外。启用公共健康缓存前必须先启用 GeoIP2 入口国别闸门，否则缓存命中可能跳过 Node 的国别判断；完整示例默认要求 GeoIP2 模块。

Nginx 仍在缓存读取前检查已有封禁。访问日志增加 `public_api=1`，让缓存命中与前置拒绝均进入 fail2ban 请求计数。不要靠关闭访问日志来减少攻击开销，也不要在每次拒绝时重复打印 Node 错误。轮转与日志缓冲沿用主机加固设置。

## 海外 API 来源过滤

公开 API 默认不做来源过滤，要过滤用 `SP_HTTP_API_CN_ONLY=on`。打开后 GeoIP 明确识别为非 `CN`（包括台湾、香港、澳门）的请求立即收到 `403 FOREIGN_IP_BLOCKED`，不读取健康状态、公告、房间信息或请求正文；这些被拒请求仍计入 600 次永久封禁阈值，但不消耗国内访客的全局请求额度。

这是独立的 API 规则，不改变原有 `SP_ALLOW_FOREIGN_CONNECTIONS`、游戏页面/WebSocket 的地区开关或房间设置。已配置的 `SP_GEOLITE_COUNTRY_DB` 或程序注入的国家查询优先复用；否则**只为 API**加载仓库自带的 `geoip/GeoLite2-Country.mmdb`（全球库、country 模式），不会因此启用游戏侧原本未配置的 GeoIP 门禁。`SP_HTTP_API_CN_ONLY` 默认 `off`，本页的限流与永久封禁是另外两个独立开关，默认同样为 `off`，三者互不代表。

本机和私网监控豁免，本机代理转发来的公网来源仍按真实 IP 判断。完整国家库没有结果的 IP **一律按海外拒绝**（未知不是国内；内核国别集合与 Nginx geoip2 映射本来就是这样）。数据库不可用是故障，返回 503，不静默放行；连数据库都没配的部署保持旧的 fail-open，避免把整机锁在门外。数据库不可用或查询异常时，公网 API 返回 `503 GEOIP_UNAVAILABLE`，不静默放开海外过滤，本机探针仍可用。GeoIP 不能阻止攻击者使用大陆代理出口。

玩家发行包不附带 GeoIP 数据库，使用发行包开公网服务时须单独配置有效的国家库；容器需保留仓库 `geoip/` 或挂载数据库。门户如果从海外服务器调用公开 API，同样会被拒绝，应把探测移到可信内网/本机，或采用已认证的独立接口，不以 User-Agent 或客户端自报地址放行。

## WebSocket 来源与代号形近字

`/ws` 在应用侧校验浏览器的 `Origin`（`server/http/websocket.js` 的 `wsOriginAllowed`）：没有 `Origin` 的请求不是浏览器（游戏客户端、探针、测试），交给原有的地址限额；浏览器必须报出**本机同一个 host**，或用 `SP_WS_ORIGINS`（逗号分隔的 `host[:port]`）显式放行，`Origin: null` 一律拒绝。这样别的站点不能拿访客的地址和连接额度刷这台服务器，也不能让滥用看起来来自那个访客。

代号在清洗时做 NFKC 折叠（`ＹＧ` → `YG`），并拒绝把拉丁字母与西里尔／希腊字母混排的形近名（`УG` 冒充 `YG`）；CJK 与拉丁混排（`甲YG`）不受影响。预检 `POST /api/nickname/validate` 与 `hello` 两条路径都执行同一规则，返回既有的 `NICKNAME_SENSITIVE`。

## 请求规则

`/healthz`、`/metrics` 和 `/api` 下所有路径共用请求预算，包含 GET、HEAD、OPTIONS、POST、错误方法及不存在的 API。换接口、查询参数、昵称或连接不刷新预算。IPv4 按地址计数，IPv6 按 `/64` 计数。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SP_HTTP_API_RATE` | `0` | 每个网络每秒恢复的请求额度，`0` = 不限制 |
| `SP_HTTP_API_BURST` | `0` | 每个网络突发容量 |
| `SP_HTTP_API_GLOBAL_RATE` | `0` | 所有公开 API 合计每秒恢复额度，`0` = 不限制 |
| `SP_HTTP_API_GLOBAL_BURST` | `0` | 所有公开 API 合计突发容量 |
| `SP_HTTP_HEALTH_RATE` | `0` | 所有公网来源 `/healthz` 合计每秒恢复额度，`0` = 不限制 |
| `SP_HTTP_HEALTH_BURST` | `0` | `/healthz` 合计突发容量 |
| `SP_HTTP_BAN_THRESHOLD` | `0` | 同一网络在滑动窗口内最多请求次数，最大 10000；`0` = 不封禁 |
| `SP_HTTP_BAN_WINDOW_MS` | `60000` | 精确滑动窗口毫秒数，最大 86400000 |
| `SP_HTTP_BAN_FILE` | `<项目目录>/.state/http-ip-bans.jsonl` | 持久封禁名单，必须在所有静态目录之外 |

普通额度耗尽时，Node 返回小型 JSON `429 RATE_LIMITED`、`Retry-After: 1`，不再收集健康状态、读取公告或处理请求正文。按下节配置的 Nginx 会把防护拒绝转换为 444 静默断开，不向公网发送该 JSON。健康限额独立于其他 API，`?build=1`、`?traffic=1` 和任意随机查询参数仍共用健康限额，避免两百多个地址轮换刷健康接口。

**开启 `SP_HTTP_BAN_THRESHOLD` 后：到达 Node 的同一网络在任意连续 60 秒内的第 `阈值+1` 次 API 请求触发永久封禁**（默认 `600` 时即第 601 次），包括已被 Node 限流后交给 Nginx 静默断开的请求。该请求及以后请求在 Node 端返回小型 JSON `403 IP_BANNED`，Nginx 公网入口静默断开；HTTP 页面、素材与新的 WebSocket 握手都受封禁检查。时间流逝不会解封，重启后从名单重新加载。正常页面、素材下载和已建立 WebSocket 内的游戏消息不计入这 600 次；已有 WebSocket 不因 HTTP 封禁主动断开，断线后不能再连接。阈值为 `0` 时这一段整体不生效，没有永久封禁也没有 `IP_BANNED`。

直接本机及内网监控沿用现有可信代理策略豁免；本机代理转发来的公网地址不豁免。学校、公司和家庭共用出口会共用计数与封禁，请按正常使用量调整阈值。User-Agent 不可信，不能作为判定依据。

计数表最多 4096 个网络：闲置记录定期清理，表满时**淘汰最久未活跃的网络**而不是拒绝新来源（拒绝新来源等于让一批无桶来源把真实玩家和监控一起锁在门外，那些来源因为没有计数桶，既不会被计数也不会被封；被淘汰的洪泛源再回来时从零计数，仍在它自己的第 601 次请求上被封）。封禁表满（100000 条）时 `ban()` 返回 `false` 而不再抛异常：拒绝它的网络由限流器自己在同一个滑动窗口内继续拒绝，既不丢计数也不会把请求变成 500。封禁表最多 100000 条，名单文件最多加载 32 MiB；损坏名单或启动时不可写会阻止启动，避免静默丢失封禁。运行中写盘失败会记录错误并保留当前进程内封禁，此时需要修复磁盘和名单，不能认为重启仍会保留新封禁。

## Nginx 部署

应用更新只保护进入 Node 的请求。**同时合并 `scripts/nginx.conf.example` 与 `scripts/nginx-game-cache.conf.example` 的变更**：

1. `auth_request /_sp/ip-check` 在返回缓存内容或直接文件前检查封禁，避免已经封禁的地址继续从 Nginx 缓存下载素材。每个正常请求增加一次本机鉴权子请求，检查只查内存，不收集健康状态。Nginx 需要 `--with-http_auth_request_module`；可用 `nginx -V` 查看。模块说明：[Nginx auth_request](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html)。
2. `/_sp/ip-check` 必须 `internal`，子请求禁止转发正文、禁止缓存，并设置 `auth_request off` 防止递归；不能将结果缓存，否则新封禁无法立即生效。Node 只对实际来自私网/本机的请求提供此检查。
3. `/api/announcement` 是另一个明确配置的 5 秒共享缓存例外，且只缓存 200。每个请求仍先经过 Nginx 限流、封禁检查和访问日志；缓存命中不会增加 Node API 计数。浏览器仍收到 `no-store`，WS 提示变化和运维即时核验使用 `?nocache=1` 绕过缓存。健康接口保持独立的 5 秒缓存规则；其他新增 API 不自行放进共享缓存。
4. 所有代理 location 覆盖 `X-Real-IP`、`CF-Connecting-IP` 为已还原的 `$remote_addr`。如果前面还有 CDN/代理，只对其真实网段配置 `set_real_ip_from`，绝不能信任 `0.0.0.0/0` 或 `::/0`。Node 监听回环并保持 `TRUST_PROXY=auto`。未修正的 CF 头可让攻击者伪造任意来源甚至冒充本机，绕过计数。
5. `@sp_ip_banned` 关闭鉴权、防止递归，执行 `return 444`。保留访问日志的 444 状态与零正文长度供审计使用，沿用日志缓冲、轮转及目录权限，不为每次拒绝额外输出 Node 错误日志。

## 444 静默拒绝

完整 Nginx 示例对以下情况静默断开连接：统一 API 限流、健康接口全局限流、房间状态/昵称 HTTP 限流、永久封禁、海外 API 拦截，以及 `/ws` 的非 GET／非 WebSocket 请求。正常 HTTP 403 权限错误、404、500 和 503 服务故障不统一转换成 444；GeoIP 故障的 `503 GEOIP_UNAVAILABLE` 也保留，便于定位配置问题。

所有游戏回源 location 覆盖 `X-SP-Drop-Rejections: 1`。Node 只接受实际来自本机/私网代理的这个标记，为防护拒绝添加 `X-Accel-Redirect: /_sp/http-drop`，Nginx 转入仅内部可访问的 location 执行 `return 444`。不使用 `proxy_intercept_errors` 全站吞掉正常错误；不要配置 `proxy_ignore_headers X-Accel-Redirect` 在普通游戏回源上，否则无法丢弃防护响应。这类上游拒绝先经过 Node 计数；Nginx 自己提前关闭的请求由下一段的 fail2ban 策略处理。

鉴权子请求 `/_sp/ip-check` 是例外：它清空 opt-in 请求头，并设置 `proxy_ignore_headers X-Accel-Redirect`，只返回 204/403 给 auth_request；主请求再按封禁结果断开。如果在鉴权子请求中直接断开，Nginx 会把它当成鉴权故障，可能对外返回 500。客户端直连 Node 没有 opt-in 时仍收到标准 JSON；只更新 Node 而没有更新 Nginx，不会启用 444。

日志中的 444 是 Nginx 内部记录，不是发给客户端的 HTTP 状态。`$body_bytes_sent=0` 只说明没有 HTTP 正文，不能单凭它证明零 HTTP 响应；集成测试直接读取 TCP 收到的所有字节，验证没有状态行、响应头和正文。实际网络仍包含 TCP 建连/关闭、TLS 握手和可能的 HTTP/2 控制帧，**444 不等于线路总流量为零**。[Nginx return 文档](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#return)

访问日志保留 444，并增加 `http_reject=RATE_LIMITED/FOREIGN_IP_BLOCKED/IP_BANNED`（鉴权直接封禁及无效 WS 请求可能没有该上游字段）。已有 fail2ban 可按 444 匹配，但必须有对应 filter/jail，不能认为只写 `return 444` 就自动启用了 fail2ban。日志每 5 秒缓冲刷盘，需配置轮转与容量限制，避免攻击变成磁盘日志压力。

如果前面还有 Cloudflare 橙云代理，444 发生在源站到 CF 这一段，CF 可能将空响应转成自己的 520 错误页，玩家侧不保证零字节。因此 CF 海外阻止/限速规则仍应保留，在边缘先拒绝不必回源。[Cloudflare 空响应说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-520/)

正常用户也可能因共享出口、批量操作或阈值设置过低触发限流；静默断开会让浏览器显示网络错误，无法读取 Retry-After。不能承诺“真玩家永远不会触发”。部署后观察 444 比例、正常对局连接和监控，按实际共享出口用量调阈值。无效 `/ws` 请求在 Nginx 直接丢弃，不计入 Node 的 API 600 次额度。

若需回滚成可读错误，普通回源将 `X-SP-Drop-Rejections` 清空，`@sp_ip_banned` 恢复为 403 JSON，并按需移除 `/ws` 的两条 `return 444`；修改后 `nginx -t` 再 reload。不要只删除内部 drop location 而仍发送 opt-in 标记，否则内部重定向会变成错误页面。

当前 Nginx 前置预算：同 IP 跨页面、API、WS 握手共用 450/分（burst 45）；页面另限 180/分（burst 15），健康另限 30/分（burst 10）。WS 新建平均 30/分（burst 10，可集中握手 11 次），同 IP 最多 8 条（应用层仍按 `SP_IP_MAX_SESSIONS_PER_IP` 限制真实会话），使用独立计数区，不把普通 HTTP 活跃请求计成 WS。版本检查 45/分（burst 12），全局 40/秒（burst 120）。连接后不回应应用心跳或未完成 hello 的连接由既有应用机制回收，Nginx 另设上游无数据 120 秒、发送阻塞 30 秒的兜底超时；不以玩家没有操作为由断开正常对局。

已知静态目录及素材清单使用独立的 150/秒、burst 1536 预算，静态加载及失败重试均不进入永久封禁计数，避免正常批量下载或 CDN 故障时误封。独立 `assets.misyra.com` 不经过游戏源站，本来就不占本机额度。路径按 Nginx 规范化的 URI 判断，API/WS 不接受 Host、User-Agent 或自报 CDN 头豁免；静态例外只作用于静态路径。这是漏桶限流，允许短时突发，并非任意 60 秒严格最多 5 次 WS。子 location 声明自己的 `limit_req` 后必须重复共享业务预算，否则不继承父级规则；带 `return` 的 rewrite 阶段会早于限流，所以主动关闭的 API 不消耗漏桶预算，但仍写日志计数。

被 Nginx 提前丢弃的请求或直接返回的缓存命中不会进入 Node 计数。直连部署使用 `sp-hardening-direct` 文件型 jail，累计同 IP 60 秒内的全部业务响应（`business=1`，含页面、API、WS、200/HIT 和 444），第 **451** 条触发永久封禁实际来源 IP。静态加载标记为 `business=0`，一次日志只匹配一次。IPv6 的内核 jail 按单地址封，Node 仍按 /64；健康总预算同时覆盖地址轮换。访问日志缓冲与 fail2ban 处理存在延迟；WS 的 101 日志在连接结束时写入，新建速率由 Nginx 立即限制。代理部署不得直接照搬此内核封禁配置。下面的 Node 默认 600 次 API 规则仍是独立兜底，当前源站外层更严格。

先备份实际配置，再 `nginx -t`，通过后 reload；部署新 Node 代码并重启后再启用鉴权片段。旧 Node 不提供鉴权端点，会导致 Nginx 拒绝访问。容器部署必须把 `SP_HTTP_BAN_FILE` 所在目录挂到持久卷，给运行用户写权限，否则容器重建会丢失名单。

以上属于应用层请求防护，分布式低频请求可能全部低于永久封禁阈值，此时全局额度只限流，不擅自封掉所有访客。即使 444 不发送 HTTP 响应，TLS 和连接开销仍存在，无法代替上游 DDoS 清洗或阻止入站链路被打满；独立素材 CDN 也不受本站封禁名单控制。

## 查看与手动解封

封禁名单是每行一个 JSON，例如：

```json
{"key":"203.0.113.9","bannedAt":1792108800000,"reason":"PUBLIC_API_FLOOD"}
```

IPv6 的 `key` 为规范化 `/64`，例如 `2001:db8:1234:5678::/64`。名单不公开提供下载，也不提交 Git。

解封时先停止游戏进程，备份名单，删除目标 `key` 对应的整行，再启动。不要在运行中删文件并误以为已解封，内存中的永久名单仍然存在；也不要直接清空其他人的记录。

## 验证

2026-10-19 本地更新了 [浏览器 gate 的续期及恢复路径](BROWSER_GATE.md)，尚未部署生产。图标、字体从 per-IP 静态请求/连接桶分流，仍检查 gate、GeoIP 和全局连接上限；这不是健康接口或业务 API 的免限流规则。恢复探针只读、不对失败请求签发凭证，不能把普通 429/503 当作 cookie 失效。部署前核对实际端口、续签头继承及完整 Nginx 配置。

```sh
node --import ./test/helpers/test-setup.js --test test/public-api-protection.test.js test/healthz-cache.test.js
NGINX_PATH=/usr/sbin/nginx node --test test/http-protection.nginx.test.mjs
```

测试使用临时文件和测试地址，覆盖第 601 次封禁、滑动窗口、249 个来源分布式健康洪泛、永久名单重载、代理信任、IPv6 轮换、WebSocket 拒绝，以及真实 Nginx 的缓存命中/文件直出不可绕过、拒绝连接接收零 HTTP 字节、444 日志、正常错误响应和成功 WebSocket 握手。不要在生产站点发送数百次请求验证，以免永久封禁自己的共享出口。
