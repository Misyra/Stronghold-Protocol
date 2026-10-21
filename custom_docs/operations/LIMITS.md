# 部署限额与正常游戏验收

核对日期：2026-10-20。本文记录当前仓库模板和代码默认值；**不代表 A/B/C 已部署这些值**。部署总入口为 [DEPLOY.md](DEPLOY.md)，历史现场值只作背景参考。实际值需核对 `nginx -T`、systemd/容器环境、面板保存的房间配置与本机健康指标；面板保存值可能覆盖环境默认值。

## 当前限额

这里的速率是请求/消息数量，不是下载带宽。仓库游戏 Nginx 模板没有配置 `limit_rate` 或 `proxy_limit_rate`。CDN 素材不设次数限制；游戏源站的本地素材仍受独立静态预算保护。

| 层与范围 | 仓库当前值 | 对正常游戏的影响 |
|---|---|---|
| Nginx 单 IP 业务 | 450/min，burst 45；业务并发 96 | 页面、API、WS 握手共享；已建立 WS 内的消息不计数 |
| Nginx 单 IP 静态 | 150/s，burst 1536；并发 384 | 源码模块、构建、清单、本地素材独立计数；小图标/字体有单独豁免映射 |
| Nginx 页面 | 单 IP 180/min，burst 15；全站 30/s，burst 60 | 同时刷新大批页面仍可能耗尽全局突发 |
| Nginx WS 握手 | 单 IP 30/min，burst 10 | 适合少量页面；共享出口多页面同时重连可能被拒 |
| Nginx WS 并发 | 单 IP 8；全站 1600 | 比 Node 的每网络不限更紧；8 条不是允许 8 个游戏身份 |
| Nginx 总并发 | 4500；每 worker 16384，文件描述符上限 65535 | 包含长期占用的 WS；代理还占上游描述符，不能把 16384 当玩家人数 |
| Nginx 裸健康 | 单 IP 30/min，burst 10；全站 9/s，burst 18 | 与版本检查分桶 |
| Nginx 版本检查 | 单 IP 45/min，burst 12；全站 40/s，burst 120 | 前台页面每 60 秒检查；两类健康合计并发 48，源站缓存 5 秒 |
| Nginx 门户 | ping 60/min，burst 15；房间查询 30/min，burst 8 | ping 不进入口业务永久封禁预算；Node 仍有自己的 API 计数 |
| Node 公开 API | **默认关闭**（`SP_HTTP_API_*` 与 `SP_HTTP_BAN_THRESHOLD` 全为 `0`）；开启后每网络 5/s，burst 30；全局 200/s，burst 400 | 独立于游戏 WS 消息；到达 Node 的健康另有全局 20/s，burst 40；阈值为 `0` 时没有永久封禁 |
| Node WS | 总连接 2000；每网络不限（`maxConnectionsPerAddr` 默认 `0`）；每连接消息 40/s，burst 40 | 网络按 IPv4 或 IPv6 /64；普通操作不会经过 Nginx 握手桶 |
| Node 重状态消息 | 每连接 2/s，burst 6 | 包括 `state.resync`、`g.watch`、配装等；连续重同步/配装应先查请求来源 |
| Node 在线身份 | `SP_IP_SESSION_LIMIT=on`、`SP_IP_SESSION_SCOPE=all`、`SP_IP_MAX_SESSIONS_PER_IP=1` | **默认会拒绝同一 IP 第二个新身份**，现有身份有效 token 重连另有接管规则 |
| Node 建房/开局 | 两桶各 burst 4；每 15s / 30s 恢复 1 个 | 按网络共享；同时房间默认 16、进行中对局 8，与动作频率不同 |
| Web SYN 防护 | 单 IP 120/min，burst 40；全局 50/s，burst 100 | 只限制新 TCP，HTTP/2 请求和既有 WS 消息不是新 SYN |

依据：`scripts/nginx.conf.example`、`scripts/hardening/sp-*-map.conf`、`sp-page-global.conf`、`server/net.js`、`server/http/publicApiLimit.js`、`server/http/wsUpgradeLimit.js`、`server/roomConfig.js`；房间设置细节见 [ROOM_PROTECTION.md](ROOM_PROTECTION.md)。构造器选项不等于同名环境变量，不能凭名称新增一个环境变量就认为会生效——完整环境变量清单见[开服指南 · 环境变量总表](../../开服指南.md#环境变量总表)。

## 是否过低及调整建议

单人正常操作暂无证据表明 40 条消息/秒或重状态 2 条/秒不足，先保留。600–800 人在线也不能证明某个校园出口不受限；玩家总数与单出口人数是两种容量。

四人共网联机建议显式设置以下配置，并检查面板的已保存值；面板可通过 `maxForeignSessionsPerIp` 实时调整，环境变量修改需重启：

```dotenv
SP_IP_SESSION_LIMIT=on
SP_IP_SESSION_SCOPE=all
SP_IP_MAX_SESSIONS_PER_IP=4
```

这是一套推荐部署覆盖，代码默认仍为 1。配合 Nginx 8 条 WS，给四个玩家保留约一倍连接余量；同一身份多标签页会接管连接，不能当成独立玩家验收。不要只提高身份上限而忽略 Nginx 连接/握手上限。

校园/公司/CGNAT 若需同 IP 承载 N 个玩家，先量峰值再成套调整身份数、WS 并发、握手 burst/持续速率、业务/API 桶、建房桶和封禁阈值。30/min 只有平均每秒 0.5 次握手；若按每页约 10 次/分钟的失败重连预算，4 页已可能超额。增加握手额度之前，先修复导致持续重连的 gate、网络或服务故障，并检查全站容量；不以全面放开限额代替定位。

### 封禁不是限速

入口 `sp-hardening-direct` 默认禁用，启用后累计所有业务响应（包括成功及 444），第 451 次/60s 永久封禁；入口 WS jail 同样默认禁用，启用后仅累计 444 升级拒绝，第 100 次/60s 封 1h。Node 这两层（API 永久封禁、升级尝试封禁）默认也是关闭的：填 `SP_HTTP_BAN_THRESHOLD` 才是到达应用的 API 第 601 次/60s 永久封禁（默认 `600`），填 `SP_WS_UPGRADE_THRESHOLD` 才是累计全部到达的升级尝试第 101 次/60s 封 1h（默认 `100`）。这些数字不能互换。

**451 并不天然安全地高于 450/min 的漏桶**：还存在 burst 45，漏桶可放过的短窗请求可能超过 451。入口累计普通业务成功请求还会把共享出口正常玩家加总。部署前用实际日志回放验证，调整时给持续量、突发、多人共网与重试留余量，并检查全部已启用 jail，避免旧 301 次永久封禁或低阈值 `nginx-limit-req` 抢先触发。日志缓冲和 fail2ban 处理还有延迟，不保证精确在某次握手时生效。

### WS 超时

精确 `/ws` 模板是 `proxy_read_timeout 120s`、`proxy_send_timeout 30s`，普通 `/` 的 1h 不会覆盖精确 location。120s 指两次上游读取之间的空闲时间，**不是连接总寿命**；应用 30s ping/pong 可维持活跃连接。[Nginx 官方定义](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)。

因此 P3 不能仅凭配置认定为“每 120 秒被掐”。先对齐 WS 关闭时刻、Nginx upstream timeout、Node 心跳/事件循环停顿和中间代理空闲超时。需要统一 1h 时只修改实际 `/ws` 块，代价是失效上游连接可能更久占用资源；延长不能修复丢失心跳。

## A/B/C 发布与验收

1. 每台分别保存 `nginx -T`、已启用 jail、服务环境和面板有效配置到私有备份；只比较相关字段，不把密钥日志放进仓库。区分模板值、实机值和本次目标值。
2. 使用同一次构建发布代码、`public/build/`、`data/assets.json`、`data/asset-hashes.json`、可选本地资源索引与 `.assets-manifest.json`。单独同步根清单不能修复本地源索引差异；比较文件 SHA-256、游戏注入版本和资源清单条数/哈希模式。各机清单响应还可能受本机资源配置影响，不只检查根清单 tag。
3. 缓存片段合并到现有站点，修正端口/路径并移除重复 location；`nginx -t` 后 reload。Node 环境/代码更新按 [更新与验收](DEPLOY.md#更新与验收) 停服、备份和重启。旧 worker 持有长 WS 时可能继续退出中，不能只凭该状态判为卡死；结合 PID、连接及退出时长判断，必要重启安排维护窗口。
4. 先单机观察再逐机推进。一个公网出口四台设备用不同身份入房，进行整备、战斗、切后台/前台、断网恢复；同时冷加载静态文件及版本检查。记录 `FOREIGN_SESSION_LIMIT`、WS 1006/1008、444/429、`$limit_req_status`/`$limit_conn_status`（需日志格式支持）、fail2ban 新封禁和 Node 拒绝指标，确认拒绝发生在哪层。
5. 清单连续请求应 MISS→HIT，核对 ETag、gzip/identity、HEAD、旧 query tag 回退及发布后版本切换（旧 query 并非 404，现片段共享 TTL 15s）。公告连续请求应 MISS→HIT，缓存 TTL 5 秒；`?nocache=1` 应绕过缓存。核验发布/撤销的正常传播窗口不超过 5 秒；ping 不应出现共享缓存 HIT。
6. 对比变更前后同等在线量的网卡出站、CPU steal、事件循环停顿、WS 重连率和加载耗时。只有配置核验与正常玩法走通不能证明千人容量，峰值承载另需压测。回滚恢复该机配置和同版本程序/数据/构建，保留状态目录及旧哈希 chunk。
