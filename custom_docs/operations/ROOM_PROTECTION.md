# 房间审计与计算保护

保护由游戏进程执行，修改环境变量后需要重启；本文标注的管理接口设置可实时修改。IP 来源沿用 `TRUST_PROXY`，只能信任自己的反向代理；Nginx 必须正确还原客户端地址，不能采信公网客户端伪造的转发头。

## 建房与开局额度

按 IPv4 / IPv6 `/64` 网络共享额度，更换昵称、身份或 WebSocket 不会刷新。两个动作独立计数；本机直连且未解析出远端网络的测试连接豁免。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SP_ROOM_CREATE_BURST` | `4` | 建房突发额度，1–100 |
| `SP_ROOM_CREATE_REFILL_MS` | `15000` | 每补充一次建房额度的毫秒数，100–3600000 |
| `SP_MATCH_START_BURST` | `4` | 开局突发额度，1–100 |
| `SP_MATCH_START_REFILL_MS` | `30000` | 每补充一次开局额度的毫秒数，100–3600000 |

保留既有同时持有房间、进行中对局和连接数限制。额度不落盘，重启会重置。同一校园/公司出口共享额度，应结合正常玩家使用情况调整。分布式攻击仍可能绕过单网络额度。

注意 `4` 是建房令牌桶的**突发容量**，不是同时房间上限，也不是累计总数。默认消耗后每 15 秒恢复 1 个；持续建房仍可累计超过 4 个。既有 `maxRoomsPerAddr` 默认 **16**（同时存在、按创建网络归属的房间），`maxMatchesPerAddr` 默认 **8**（同时进行的对局）。这两个旧参数通过程序启动选项设置，不要误以为设置一个未被读取的同名环境变量会生效。

## 海外连接准入

`SP_ALLOW_FOREIGN_CONNECTIONS=on/off` 控制启动默认值，默认 `on`（允许）。监控面板「允许海外 IP 连接」实时写入布尔字段 `allowForeignConnections`，复用 RW Agent 和回环 `PUT /api/room-config`，持久化及优先级与其他房间设置一致。

关闭后，识别为非 `CN` 的公开 IP（含港澳台）请求游戏 HTML 入口时直接收到 HTTP `403` 和 JSON `{"code":"FOREIGN_CONNECTIONS_DISABLED","msg":"本服务器暂时仅对中国大陆服务"}`，不会加载游戏页面。WebSocket 在 HTTP 升级前同样返回 `403` 和该消息，不建立连接、不分配游戏 session。旧缓存即使保留页面，也不能绕过服务端握手拦截。

已有已登录连接继续游玩，不踢人；素材、管理接口和探针不拦截。断线后的 token 重连属于新连接，同样拒绝。开关切换前建立但尚未登录的连接，在首次 hello 时再次检查，发送协议拒绝后以 `4003` 关闭，浏览器显示提示并停止自动重连；这是切换时已存在连接的兜底，不是新连接准入方式。拒绝审计 `connection.foreignPolicy.denied` 全局每 10 秒采样一次并记录省略次数，防止刷日志；切换审计为 `connection.foreignPolicy.changed`。

必须正确配置可信代理和有效 `SP_GEOLITE_COUNTRY_DB`。内网、国家未知、查询错误或缺库时放行，不猜测归属；大陆专用库的 IPv4 未命中按下面 `cn-only` 规则处理。面板缺库警告、只读 `foreignSessionGeoipAvailable` 与健康信息 `foreignSessions.foreignConnectionsBlocked` 指示配置是否具备生效条件，`connectionDenied` 为拒绝次数。单会话开关、AI 开关和房间上限独立，均不被覆盖。

## 单 IP 会话上限与人群范围

限制每个来源 IP 新增身份时的在线游戏 session 数量，默认开启、范围为所有 IP、上限为 `1`。使用现有可信代理地址解析结果；此规则按单个 IP，而不是建房频率规则的 IPv6 `/64`。它不限制页面脚本、样式、资源下载或 Nginx HTTP 连接数。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SP_IP_SESSION_LIMIT` | `on` | `on` 开启，`off` 关闭单 IP 会话限制 |
| `SP_IP_MAX_SESSIONS_PER_IP` | `1` | 每个受限 IP 允许的在线身份数，整数 1–100 |
| `SP_IP_SESSION_SCOPE` | `all` | `all` 限制所有 IP；`foreign` 仅限制 GeoLite 国家结果非 `CN` 的 IP，包含 HK/MO/TW |
| `SP_GEOLITE_COUNTRY_DB` | 未配置 | 私有 Country `.mmdb` 路径，`foreign` 范围需要它识别人群 |
| `SP_GEOIP_MODE` | `country` | GeoLite2-Country 全球国家库使用 `country`；大陆专用库使用 `cn-only` |

例如，所有 IP 每个最多 2 个在线身份：

```ini
SP_IP_SESSION_LIMIT=on
SP_IP_SESSION_SCOPE=all
SP_IP_MAX_SESSIONS_PER_IP=2
SP_GEOLITE_COUNTRY_DB=/var/lib/GeoIP/Country.mmdb
SP_GEOIP_MODE=country
```

只限制国外 IP 时，将 `SP_IP_SESSION_SCOPE` 改为 `foreign`；关闭限制时将 `SP_IP_SESSION_LIMIT` 改为 `off`。`all` 不依赖国家库，国内、海外、未知国家、局域网与回环地址都适用；`foreign` 在国家未知、查询失败或缺库时放行，不猜测归属，缺库时健康接口 `foreignSessions.enabled=false` 并输出启动警告。库损坏或格式错误仍按已有规则拒绝启动。

旧的 `SP_FOREIGN_SESSION_LIMIT`、`SP_FOREIGN_MAX_SESSIONS_PER_IP` 继续兼容；新旧名称同时设置时，新名称优先。面板和程序选项仍使用 `limitForeignSessions`、`maxForeignSessionsPerIp`，不会增加另一套配额。环境变量修改后需重启游戏服务，Nginx 无需重载；范围只在启动时加载。健康接口 `foreignSessions.scope`、`maxPerIp`、`enabled` 显示实际生效的策略。

监控面板可以通过现有 RW Agent 实时更新 `PUT /api/room-config` 的布尔字段 `limitForeignSessions` 及整数 `maxForeignSessionsPerIp`，例如 `{"maxForeignSessionsPerIp":3}`，无需重启。保存的面板配置优先于环境默认值，显式程序选项优先级最高，与 `allowBots` 一致。会话设置与房间上限、AI 添加开关及海外连接准入独立，不修改其他值。数据库文件和查询模式仍只在启动时加载，本功能不是数据库热更新。

关闭后允许同 IP 多身份，但仍保留受限范围内来源的配额键，供再次开启时识别。开启或调低上限不踢掉已有在线身份，之后仅在在线数低于新上限时接受新身份；有空位时按原规则回收该 IP 的离线旧身份。已有身份的同 IP 有效 token 重连仍可用，因此调低后的过渡期可能保留超过新上限的已有身份。接口中的只读 `foreignSessionGeoipAvailable` 指示国家库是否可用；只有 `foreign` 范围依赖它。

- 该 IP 在线身份数达到配置上限时，拒绝新身份以及其他 IP 的 token 向此 IP 的迁入，返回 `FOREIGN_SESSION_LIMIT`；不踢原玩家。携带当前身份的有效 token 重连仍沿用现有同身份窗口接管规则。
- 同 IP 的旧 session 已断线时，新身份会先按大厅的退出逻辑清理旧席位、匹配队列和回放，再撤销旧 token。无人房间销毁并释放 AI；仍有其他真人的房间保留。不会继承旧玩家的配置、房间访问权或战斗结果。
- 仍有效的聊天处罚转入新身份，不能靠换 token 清空处罚。旧 token 再次连接时不能踢掉新的在线身份。
- `all` 范围不受国家查询失败影响；`foreign` 范围按国家查询结果决定是否受限。查询异常计数仍可在健康接口查看。
- 海外 session 的私有 SHA-256 IP 配额键随存档保存，重启恢复时重建索引，不增加原始 `session.addr` 的持久化。该键是可关联的配额标识，**不是匿名化保证**；不出现在客户端消息、公开健康信息或审计中。旧存档缺少此键时不猜测来源，首次重连后才纳入规则。
- 平时检查同 IP 索引，不逐次遍历全体房间或 session；恢复后首次海外握手初始化索引，过期扫描清理索引引用。`foreignSessions` 健康指标包括启用状态、每 IP 上限、回收/拒绝和查询异常计数；审计使用 `session.foreignLimit.denied`（每 IP 10 秒采样）和 `session.foreignLimit.reclaimed`，不记录 token。

会话数量限制不能替代建房频率、房间并发和 AI 总量限制；同一 IP 仍可退出后顺序建房，多 IP 也仍可并行。新身份会放弃旧的断线对局，需要恢复时应使用原 token。海外共享代理下的不同玩家共享此上限；默认 1 时不能同时进入，应提示关闭代理或更换出口。

## 房间高水位回收

房间数达到配置上限的 **90%** 时进入回收状态，按整个房间最后一位在线成员的断线时间从早到晚回收，直到房间数严格低于 **80%**。例如上限 1000，达到 900 时触发，目标为最多 799。断线时间缺失时用房间创建时间排序，同时间优先回收创建更早的房间。

只回收真人玩家和观战者均离线的房间；AI 在线状态不保住房间。有人在线的房间永远不因这一策略被销毁。如果离线房间不够，清完可回收房间后保持回收状态，后续有房间离线时继续，低于 80% 才退出回收状态。低水位下仍沿用正常断线保留规则。

每 15 秒检查一次，未达到高水位且未处于回收状态时不遍历房间；建房前后也触发检查，全量检查最多每秒一次，避免建房洪水放大遍历成本。管理 API 修改房间上限后强制立即检查。高水位回收优先于联机 10 分钟、单人 24 小时的重连保留期，包括服务器重启后恢复但尚未重连的房间。回收会终止房间的对局、清理计时器和计算任务并释放 AI 名额；重连时提示「服务器房间容量紧张，离线同盟已被回收，请重新创建或加入同盟」。

逐房审计 `room.disposed` 的 `reason` 为 `capacity`；每批另记 `room.pressure.reclaimed`，含回收前后数量、上限、目标和回收数量。健康接口 `roomPressure` 含 `active` 与累计 `reclaimed`。

## AI 队友存量上限

每台服务器独立限制当前存在的 AI 席位，不再使用每 IP 一小时 10 个的额度，也不按开局次数计数。备战、运行中、无人暂停的房间都计入；重新开局或重连不会增加计数。真人断线后的自动接管不算新增 AI 席位。

- 全服所有来源合计达到 **300** 个后，任何 IP 都不能继续添加，返回 `AI_POPULATION_LIMIT`，显示「当前服务器AI队友数量异常，可能正在被攻击，暂停AI 队友创建。」。
- GeoLite `country.iso_code` 非 `CN` 的来源（包括 `HK`、`MO`、`TW`）共用 **50** 个海外 AI 席位，不是每个 IP 50 个。达到后只拒绝新的海外 AI，返回 `FOREIGN_AI_POPULATION_LIMIT`，显示「由于你的ip属于海外，当前AI队友达到上限，如果你开了代理请关闭代理，或者前往联机大厅匹配队友」。全服上限的提示优先。
- 不删除已有 AI，不阻止已有房间开局或恢复，不终止对局。移除 AI 或房间销毁会立即释放名额；断线暂停只暂停计算，不释放 AI 名额。
- 添加时固定来源国家/地区，不随换昵称、身份、连接或房主改变。只将该国家/地区代码随席位存档，不保存原始来源 IP、不发给客户端；重启恢复房间时重建存量计数，不会把名额清零。旧存档缺失来源或 GeoLite 未覆盖的地址计入全服总量，但不擅自当成海外。
- 添加、移除、销毁和恢复时维护计数，添加检查是 O(1)，不会逐次扫描所有房间。地区未知和查询异常分别在健康接口累计 `lookupMisses` / `lookupErrors`。

配置：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SP_GEOLITE_COUNTRY_DB` | 未配置 | 私有 Country `.mmdb` 文件路径；未配置时海外限制不启用，全服总量限制仍生效 |
| `SP_GEOIP_MODE` | `country` | `country` 用于全球国家库；`cn-only` 用于大陆 IPv4 专用库（GeoIP2-CN），将 IPv4 未命中视为非大陆 |
| `SP_IP_MAX_SESSIONS_PER_IP` | `1` | 受限人群中每个 IP 的在线新身份配额，1–100；兼容旧名 `SP_FOREIGN_MAX_SESSIONS_PER_IP` |
| `SP_BOT_MAX_TOTAL` | `300` | 全服 AI 席位上限，1–10000 |
| `SP_BOT_MAX_FOREIGN` | `50` | 海外来源 AI 席位共用上限，1–10000 |

国家库不入库（2026-10-19 起）：在服务器上跑一次 `node tools/fetch-geoip.mjs` 下载到 `geoip/GeoLite2-Country.mmdb`（GeoLite2-Country，含 IPv6 记录；来源、校验值与许可见 [geoip/README.md](../../geoip/README.md)）。服务器上配置：

```ini
SP_GEOLITE_COUNTRY_DB=/opt/Stronghold-Protocol/geoip/GeoLite2-Country.mmdb
SP_GEOIP_MODE=country
```

`country` 模式读库里的真实国家代码：`CN` 为大陆，其余两位代码（含 `HK`、`MO`、`TW`）按海外处理；未命中、内网、畸形记录与查询失败仍是未知并放行，不猜测归属。连接准入、海外单身份和海外 AI 总量限制共用同一个结果，不需要修改监控 Agent。库格式、常用大陆 IPv4 样本及海外样本在启动时校验，缺失、损坏、空库、ASN 库或模式明显不匹配会报错而非启用空白名单。不要根据文件名自动猜测模式。

仍支持大陆专用库（[Hackl0us/GeoIP2-CN](https://github.com/Hackl0us/GeoIP2-CN) 的离线 `Country.mmdb`，无需 MaxMind 账户或下载密钥）：它只包含大陆地址，海外 IPv4 查询返回空值，必须配 `SP_GEOIP_MODE=cn-only` —— 此时合法 IPv4 未命中返回内部标记 `ZZ`（仅表示非大陆，不表示真实国家），**不能按默认全球国家库模式使用**，否则海外来源会被当成未知而放行。两种库各有自己的启动校验，把全球库配成 `cn-only`（或把大陆专用库配成 `country`）会直接报错。

**IPv6：`country` 模式读库里的 IPv6 记录（本库有覆盖，但不保证每个网段都在）；`cn-only` 数据源没有大陆 IPv6 覆盖，未命中的 IPv6 视为未知并放行。** 文件元数据的 `ipVersion: 6` 本身不代表包含全部网段。不能据此声称完整封禁了海外 IPv6；未命中的地址按未知处理，宁可放行也不误伤大陆玩家。

MMDB 只随 Git 到服务器，不随游戏分发给玩家，且不能放在 `public/`、`data/`、`shared/` 或 `packs/` 静态目录中（启动时会对这些目录里的库直接报错）。`tools/package.mjs` 的玩家发行包是对 `git ls-files` 的白名单（`server/`、`shared/`、`data/`、`public/`、`packs/`、`schemas/`），`geoip/` 不在其中。只在游戏启动时加载本地库，游戏请求期间不下载、不联网查询。后续更新先下载到临时文件，校验成功后原子替换；下载失败保留旧库，不用空文件覆盖。更新文件后需在安排好的维护窗口重启游戏加载新版。

也仍兼容自己维护的 MaxMind 全球库：注册账户后用 `geoipupdate` 下载更新 `GeoLite2-Country.mmdb`，账户与 LicenseKey 放服务器私有配置，不入库、不发给浏览器；`SP_GEOIP_MODE` 保持 `country`。各上限与开关：

```sh
SP_GEOLITE_COUNTRY_DB=/opt/Stronghold-Protocol/geoip/GeoLite2-Country.mmdb
SP_GEOIP_MODE=country
SP_BOT_MAX_TOTAL=300
SP_BOT_MAX_FOREIGN=50
```

上线前必须验证真实 IP 信任链：Nginx 仅信任已配置的上游代理，并把 `X-Real-IP` 与 `CF-Connecting-IP` 都覆盖为已还原的 `$remote_addr`，不能透传公网客户端伪造的 CF 头。Node 的 `TRUST_PROXY` 保持只信任自有代理，监听回环。IP 库识别的是网络出口，不保证是真实玩家位置。

`/healthz` / `/metrics` 的 `botPopulation` 返回 `total`、`foreign`、`maxTotal`、`maxForeign`、`foreignEnabled`、拒绝次数与地区查询异常计数，不暴露 IP 或数据库路径。审计 `room.botAdd.denied` 含拒绝码、国家/地区与当前计数，拒绝日志沿用采样。多 IP 仍不能绕过全服或海外共用上限；但攻击者可以占用海外名额，此上限并不保证能识别攻击者。

## 无人暂停与计算降级

聊天处罚的身份保留不再延长房间的重连期限。联机默认 10 分钟、单人对局默认 24 小时后释放超时席位；保留的身份仍携带处罚记录，重连不恢复已回收的房间。重启恢复也遵守此规则。

- 所有未离开的真人席位断连后，暂停对局计时器、主线程计算续片和 Worker 任务；任一真人重连后按剩余时间恢复。观战者不能恢复计算，AI-only 测试对局不触发此规则。
- 重连窗口和清理由大厅继续计时，不会因游戏暂停而无限延长。已有单人手动暂停在重连后保持。
- 取消任务后丢弃旧结果；恢复时重新提交仍有效的任务，不应用过期回调。
- 每秒采样主线程单核 CPU：超过 60% 时新预演最多一个候选，超过 70% 时关闭新预演。恢复带 5 个百分点回差：关闭状态需连续 5 个样本不高于 65% 才恢复，降为一个候选后需连续 5 个样本不高于 55% 才恢复正常；低负载持续 5 个样本也可以从关闭直接恢复正常。只限制新任务，不中途打断已有预演。
- 使用 `process.threadCpuUsage()`，不把 Worker CPU 计入主线程；旧 Node 不支持时以事件循环利用率兜底，指标来源在健康接口标明。按实际采样间隔计算，AI 只读取缓存状态，不请求监控 API，也不逐个采集系统指标。
- 计算池满载或有任务排队时也最多预演一个候选。各项上限取最小值，不修改正常配置。`SP_BOT_REHEARSAL=0` 始终不预演，包括旧存档恢复的对局。CPU 压力那一档可以用 **`SP_REHEARSAL_PRESSURE=off`** 关掉（默认开，值同其它开关：`off` / `0` / `false` / `no` 关）：关掉后采样照旧（`/metrics` 的 `rehearsalPressure.percent` 还在，`state` 变 `off`），候选数完全按 `SP_BOT_REHEARSAL` 走，不再随本机负载降级。
- 可选预演队列上限为 `min(maxQueue, workers × 2)`；拒绝时使用基础布局，不把额外模拟转移到主线程。必要战斗接管/校验仍保留原有有界分片兜底。

## 审计日志

审计写入现有服务日志，每行以 `[audit] ` 开头，后接 JSON。覆盖连接/重连/断连、建房、加入/离开、AI 添加/移除、开局/恢复/结束、销毁、无人暂停/恢复和 Worker 拒绝/失败。拒绝日志按网络和动作每 10 秒采样，未进入额度表的网络共用溢出采样；`suppressed` 为上次采样后省略的条数，健康计数不采样。

房间事件包含 `at`（UTC）、`ip`、`network`、`playerId`、`name`、`roomCode`、`roomCreatedAt`、`matchCount`、`mode`、`difficulty`、`bots`。以 `roomCode + roomCreatedAt` 区分重复使用的房间码，再以 `matchCount` 关联对局。系统事件的身份字段是当时房主，并不表示房主执行了系统动作。拒绝事件含 `reason`；Worker 事件含任务类型、错误码、池负载和对局计算计数。

```sh
journalctl -u stronghold --since '2026-10-12 00:00:00' --no-pager | grep '\[audit\] '
```

日志含 IP 和昵称，应限制读取权限并配置 journald 留存上限，不公开下载。不记录登录令牌或聊天正文。IP 不随存档保存，恢复后尚未重连的会话可能显示 `null`。历史上未记录的身份与 IP 无法补回。

## 私有房间列表

配置独立随机密钥 `SP_ROOM_ADMIN_TOKEN` 后，游戏进程在 `127.0.0.1:3001` 开启本机管理 API；未配置时不监听该端口。密钥必须是 32–256 个非空格 ASCII 字符，建议至少 32 随机字节的十六进制值，只放私有环境文件，不复用玩家令牌或放在 URL 中。可用 `SP_ROOM_ADMIN_PORT` 改端口。

```sh
curl -H "Authorization: Bearer $SP_ROOM_ADMIN_TOKEN" \
  'http://127.0.0.1:3001/api/rooms?limit=100&offset=0'
```

默认每页 100，最多 200；响应含 `total`、`offset`、`limit`、`serverNow`、当前房间上限和 `rooms`。房间提供公开状态、真人 ID/昵称/IP/连接状态、创建时间、对局次数、无人暂停状态、预演配置和计算计数，不返回玩家令牌。响应 `no-store`，不开放跨域。此端口只监听回环地址，不要配置 nginx 公网转发。

Agent 可在同机通过 `MON_GAME_ADMIN_URL=http://127.0.0.1:3001/` 和 `SP_GAME_ADMIN_TOKEN` 代理访问；后者与游戏的 `SP_ROOM_ADMIN_TOKEN` 相同。Portal 站点需配置 Agent 的 `SP_ADMIN_TOKEN_RW`，房间清单含玩家 IP，因此只读令牌不能访问。Agent 不会把游戏密钥转发给浏览器。

本机管理端点：`GET /api/rooms?limit=100&offset=0`；`GET/PUT /api/room-config`；`POST /api/rooms/:code/close`；联机站 Agent 的私有端点 `GET /api/portal/rooms/:code/status` 与 `POST /api/portal/rooms/status-batch`（最多二十项）。配置支持部分更新，例如 `PUT {"maxRooms":1000}`、`PUT {"allowBots":false}`、`PUT {"limitForeignSessions":false}`、`PUT {"allowForeignConnections":false}` 或 `PUT {"maxForeignSessionsPerIp":3}`，也可同时提交；未提交的值保持不变。`maxRooms` 为 1–10000 的整数，`maxForeignSessionsPerIp` 为 1–100 的整数，其他三项必须为布尔值，空对象和未知字段拒绝。列表的 `config` 及配置读取接口返回五项设置、只读 `foreignSessionGeoipAvailable`、配置版本 `revision` / `values` / `lastMutation` 和 `gameBootId`。

跨机的配置写用**版本化请求**：`PUT {"expectedRevision":N,"patch":{…},"opId":…,"expiresAt":…}`。版本比较发生在串行写入队列内部（入队前比一次的话，两个同时到达的写都会通过），过时页面拿到 `409 CONFIG_CONFLICT` 与当时的实际值；同一个 `opId` 同内容重发是幂等重放（不递增版本，回 `replayed:true` 与 `originalResultRevision`），同 `opId` 不同内容 `409 OP_ID_CONFLICT`；`expiresAt` 已过则**不执行**。迁移期仍保留的旧写法（直接 `PUT {"maxRooms":700}`）走同一个队列并同样递增版本，不会绕过版本控制。

当前默认上限是 `1000`，默认允许添加 AI 队友；启动时可用 `SP_ALLOW_BOTS=off` 禁止（默认 `on`）。面板的「允许添加 AI 队友」可实时切换，无需重启；服务端同时检查 `room.addBot`，不能通过绕过按钮添加 AI。关闭只禁止新增，不移除已有 AI、不阻止其所在房间开局、不终止已有对局，也不改变真人断线后的自动接管。等待房间收到实时状态更新，重新允许后即可继续添加。

这些配置会原子保存到 `.state/room-admin.json`，或由 `SP_ROOM_ADMIN_STATE_FILE` 指定私有路径；保存失败不应用运行时改动。文件格式是 **v2**：`{schemaVersion:2, revision, values:{五个字段}, lastMutation:{opId,payloadHash,revision}}`。旧 v1 文件在启动时读成 values 并按 `revision=1` 落成 v2（第一次真正的改动是第 2 版）；文件里出现 `revision:0`（手工改坏或极老存档）一律向上取成 1 —— 版本号只是单调变化的令牌，而联机站面板的协议层要求它 ≥ 1。写入至少覆盖临时文件 `fsync` 与 `rename`（Linux 上再 `fsync` 目录）：只做 rename 时内容可能还停在页缓存里，断电后拿到的是空文件或半截 JSON，症状是「重启之后房间上限悄悄变回默认值」。重启优先读取已保存配置（高于环境变量默认值，显式程序启动参数仍优先），旧配置缺少的字段沿用环境默认值。会话数量变更记录 `session.foreignMaxPerIp.changed`，包含前后值；拒绝审计同时记录当前 `maxPerIp`，健康信息 `foreignSessions.maxPerIp` 返回实时配置。降低房间上限会按前述高水位规则回收无人房间，不影响在线房间。关闭房间会断开成员并终止该房间对局：除创建时间外还接受并校验房间**实例号** `roomId`（`409 ROOM_CHANGED` 表示这个码现在指着另一间房），带 `expiresAt` 且已过期的命令不执行（回 `200 {closed:false, code:'DEADLINE_EXCEEDED'}`），执行成功回 `{closed:true}`。

`/healthz` 新增 `roomProtection`（允许/拒绝计数及已跟踪网络数）、`offlinePausedMatches`；`/metrics`（仅本机回环/内网，见 [CUSTOM_API.md](../development/CUSTOM_API.md) 第 6 节）提供 `rehearsalPressure`：指标来源、负载百分比、采样时间、当前档位、候选上限（`null` 表示沿用配置）及阈值，以及计算池的 `queuedByType`、`oldestQueuedMs`。这些是进程内累计/当前值，重启归零。判断攻击应结合实际动作、频率和计算消耗，不仅凭 ASN 或昵称封禁。
