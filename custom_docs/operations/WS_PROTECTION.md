# WebSocket 反复升级防护

按 [2026-10-17 事故记录](INCIDENT-2026-10-17.md) 放宽应用兜底默认值：同一来源在任意连续 60 秒内，前 100 次升级尝试正常接受既有准入检查，**第 101 次触发封禁 1 小时**。
计数发生在路径、Origin、在线人数和 WS 握手校验之前；成功连接后马上断开、失败握手、换路径和查询参数都不会重置计数。
已建立连接里的消息和普通 HTTP 请求不占这个额度。封禁期间继续请求不延长到期时间。

来源沿用 `clientAddress` / `TRUST_PROXY`：IPv4 按地址，IPv6 按 `/64`，同一出口共用额度。
实际来自回环/内网、没有公网转发来源的本机监控豁免；可信代理转发的公网来源正常计数。
同一家庭、学校或公司出口的多人也会共用这 100 次额度；它与下面只统计 444 的入口 jail 是两种不同的计数。

## 应用层

默认启用，应用更新后重启生效。配置也可通过 `startServer({ wsUpgradeLimits: { threshold, windowMs, banMs } })` 传入。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SP_WS_UPGRADE_THRESHOLD` | `100` | 窗口内允许的尝试次数；第 101 次封禁 |
| `SP_WS_UPGRADE_WINDOW_MS` | `60000` | 精确滑动窗口，毫秒 |
| `SP_WS_UPGRADE_BAN_MS` | `3600000` | 封禁时长，毫秒 |
| `SP_HTTP_BAN_FILE` | `.state/http-ip-bans.jsonl` | 与现有 HTTP 防护共用的持久封禁名单 |

名单记录 `reason: WS_UPGRADE_FLOOD`、`bannedAt` 和 `expiresAt`。到期自动解除，服务重启后仍保持剩余封禁时间。旧版没有 `expiresAt` 的永久封禁继续永久生效，不会被临时封禁降级。

阈值下限由窗口决定：`SP_WS_UPGRADE_THRESHOLD` 至少每分钟 20 次，窗口拉长时按比例放大（5 分钟窗口要求 100）。这是单个客户端自身重连阶梯的量级——`public/js/net.js` 的退避从 500ms 起、每次翻倍、封顶 10s，一分钟内约十次升级尝试；低于 20/min 时，一个卡住的标签页就能把自己封掉。`SP_WS_UPGRADE_BAN_MS` 超过一小时时，阈值必须 ≥ 100。2026-10-18 线上曾跑阈值 10/min + 封禁 24 小时，当天 `/ws` 升级有 78% 被应用层自己拒掉（16,442 次 429 对 4,604 次成功，最高单小时 7,507 拒绝），玩家的正常重连被当成洪泛。不满足下限时 `startServer` 直接抛 `RangeError`，不会带病启动。
封禁拒绝 HTTP 请求和新的 WS 升级（直连 Node 为 403）；现有已建立 WS 沿用既有策略，不主动踢掉。
Node 计数表有界；闲置记录过期，表满淘汰最久未活跃的普通计数，实际封禁保留。
名单满或写盘失败时保留当前进程的拒绝；写盘失败会记错误，不能承诺重启仍保留新封禁。
名单接近 32 MiB 时原子整理有效记录，已过期的历史不会无限堆积。

## 回收原则

不按五分钟无业务操作统一踢人：观战、等待队友和后台页面可能没有业务操作，但连接仍健康。
优先回收未完成游戏握手、心跳失联和拒绝完成关闭握手的连接；已建立游戏会话沿用心跳检测。
缩短未 hello 超时时，要同时处理前端标题页的自动重连，避免正常玩家停留标题页反复升级而误触发封禁。

## Nginx 提前拒绝的请求

2026-10-19 本地增加 [gate 恢复探针](BROWSER_GATE.md)，尚未上线：WS 升级失败本身仍只表现为浏览器 1006，客户端用 `GET /_gate/status` 的明确标记判断是否重新验证。普通 429/5xx 不触发刷新；未迁移 WS 准入、未新增 4004/4005、未取消入口保险阀。后台仍可能继续普通 WS 退避，不能把本次修复描述为已消除所有重试。现场验收见 [问题清单](OPEN-ISSUES-2026-10-19.md)。

应用层只能统计真正到达 Node 的 upgrade。现有 Nginx 新建速率/并发限制、浏览器验证等可能更早拒绝请求，因此直连部署另加入口规则：

1. 合并 `scripts/nginx-log-format.conf.example` 的 `sp_log_ws_upgrade` 映射和日志末尾 `ws_upgrade` 字段；保留实际日志路径及已有格式字段。
2. 安装 `scripts/hardening/sp-ws-upgrade.filter.conf` 到 `/etc/fail2ban/filter.d/sp-ws-upgrade.conf`。
3. 将 `scripts/hardening/sp-hardening.jail.conf` 中的 `sp-ws-upgrade-direct` 部分合并到本机 jail 配置，确认日志第一列为实际 TCP 来源后设 `enabled = true`。端口填写实际公网监听端口，并保留维护出口豁免。
4. `nginx -t`、`fail2ban-client -t`、`fail2ban-regex <访问日志> /etc/fail2ban/filter.d/sp-ws-upgrade.conf` 检查后 reload。

该 jail 的 `findtime=60`、`maxretry=100`、`bantime=3600`，只统计 `/ws` 的 444 且带真实升级标记的拒绝；成功 101、普通错误与上游 5xx 不计数。原业务请求 301 次永久封禁 jail 保持独立。显式配置的旧应用阈值不会自动改变，需要同时检查环境变量。
Nginx 在 WS **连接结束时**写 101 日志，且日志有缓冲和 fail2ban 处理延迟；入口侧封禁不保证在握手瞬间生效。
现有 Nginx 速率/并发限制仍即时保护入口，Node 则在收到 upgrade 时立即计数。
入口 jail 按单个来源 IP，Node 的 IPv6 按 `/64`；两套名单各自持久化和到期，不互相同步。

这个内核 jail **仅适用于直连入口**。Cloudflare/其他代理前置时不能把报送的玩家 IP 当成内核 TCP 来源封禁，应在真实入口使用相应边缘规则；Node 仍依照可信代理的真实地址计数。
本次只提供代码和模板，不自动修改线上 Nginx、防火墙或 fail2ban。

验证：`node --import ./test/helpers/test-setup.js --test test/ws-upgrade-limit.test.js test/public-api-protection.test.js test/ws-origin.test.js test/ws-compression.test.js`。

## 国内直连部署记录（2026-10-17）

已核验 `103.120.91.25:10067`：内核 `sp_foreign_cap` 的大陆 IPv4/IPv6 准入、Nginx GeoIP2 拒绝规则及应用 `SP_ALLOW_FOREIGN_CONNECTIONS=off` 均已启用，无 Cloudflare 前置。
本次保留这些既有规则，为实际 Nginx 日志补充末尾 `ws_upgrade` 标记，并启用独立的 `sp-ws-upgrade-direct` jail：`findtime=60`、`maxretry=11`、`bantime=86400`，封禁目标端口为内部实际监听的 `80,443,8080,3000`。
原业务 301 次永久封禁规则保持独立。应用层滑动窗口代码尚未部署到此节点，因此目前入口规则仍有前述访问日志与 fail2ban 的处理延迟，不能承诺第 11 次握手瞬间拒绝。

验证：隔离网络中大陆 IPv4/IPv6 放行，海外、未知及已建立海外入站丢弃，出站访问海外的回复正常；通过源站回环访问真实 Nginx，完成入口工作量证明后页面 200、WS 101；独立测试日志前 10 条不封、第 11 条生成内核 drop，时长 86400 秒，随后清理测试封禁和日志订阅。新 SSH 会话正常，游戏 PID 保持不变。
配置检查及 Nginx 新日志标记通过，自动回滚已取消。私有备份和回滚脚本在 `/root/sec-ws-upgrade-20261017-015505`，指针 `/root/sp-ws-upgrade-current`；仅 reload Nginx 和 fail2ban，没有重启游戏或整份重载 nftables。
从维护机器绕过本机代理直连测试，公网 `80/443` 及 `8080` 未连接成功；目前只能确认源站入口正常，公网游戏端口映射仍待核对，不能据此声称域名已完整对外验收。
