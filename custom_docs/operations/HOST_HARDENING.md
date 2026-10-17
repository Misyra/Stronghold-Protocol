# Linux 主机防刷与巡检

本页配合[公开接口防护](HTTP_PROTECTION.md)与 `scripts/hardening/` 模板。部署前读取实际监听、NAT、代理与现有规则，不整份覆盖别台机器的配置。

最终使用者设置：同 IP 跨业务路径 300/分，第 301 条永久封禁；WS 并发 4、新建平均 5/分（burst 3）；健康单 IP 12/分、全体 5/秒、源站缓存 5 秒；页面 120/分。正常静态文件及其重试独立 100/秒、burst 1024，不进永久封禁预算。下面较早的 600/601 验证是升级历史，当前配置以本段与实际 after 快照为准。ASN/机房策略目前只评估，未启用；Country 不是住宅白名单。

## 入口与封禁

`sp-public-api-map.conf` 安装到 Nginx HTTP 级 include，目标 server 添加 `if ($sp_close_public_api) { return 444; }`。只开放页面使用的公告、延迟探测、门户和房间状态 API；未知 API、昵称 HTTP 预检与公网 `/metrics` 仍关闭。公开 API 继续由浏览器认证、国家校验和分层限流保护，`/healthz` 使用 5 秒源站缓存。不能用 Origin、Referer、User-Agent 或自报 IP 证明请求可信，参数见 HTTP 防护文档。

### 整机国内准入与 DNS-01

当前选择是在内核阻止所有非 CN 或未知来源的新入站，**SSH 也受限制**，没有 CF、普通私网或 ACME 入站例外。回环与必要的本地 IPv6 邻居发现保留；对服务器主动发起出站连接的回复使用 `ct direction reply ct state established,related` 放行，DNS、HTTPS、证书申请仍能工作。不能简单把所有 established 放在国别判断之前，否则已有海外入站连接还能继续。目标机器是静态地址、`ip_forward=0` 的服务端；DHCP、路由或容器转发机器须另行适配，不能照抄。

`render-country-firewall.py` 依赖 Debian `python3-maxminddb`，从仓库全球 `GeoLite2-Country.mmdb` 提取 `country.iso_code == CN` 的 IPv4/IPv6 网络，合并 CIDR，验证国内/海外/未知样本与每个网段边界，再渲染 `sp-country-input.nft.example`。不使用独立第三方 CN 段表；不把 `registered_country` 或国家未知当成 CN。当前库得到 8104 个 IPv4 与 43885 个 IPv6 网段；集合按 512 条一批用 `add element` 写入，避免 Debian 11 的 nft 0.9.8 在单个 `elements` 报文过大时报 `No buffer space available`。维护出口通过 `--require-ip` 验证，生成失败保留已部署文件。

```sh
apt-get install python3-maxminddb libnginx-mod-http-geoip2
python3 scripts/hardening/render-country-firewall.py \
  --db geoip/GeoLite2-Country.mmdb --output /root/country.new.nft \
  --require-ip <当前SSH实际来源IP>
```

生成器只生成文件，不加载规则。已有 `sp_foreign_cap` 表要用同一 nft 事务先删除该表再创建新表，并更新 `/etc/nftables.d/sp-foreign-cap.nft` 开机 include。先备份、`nft -c` 并准备五分钟自动回滚，再应用；全新 SSH 连接成功后撤销回滚。只替换此表，不清空 fail2ban 或其他业务规则。

Nginx 同时安装 `sp-geoip-country.conf.example` 为 HTTP 级 `sp-geoip-country.conf`，启用 GeoIP2 动态模块并在 server 添加 `if ($sp_geoip_denied) { return 444; }`。公网仅正向命中 CN 放行，HK/MO/TW 和未知均拒绝；回环可监控，普通私网不整体豁免。使用明确的 `source=$remote_addr`，不读取客户端提交的 GeoIP 头。当前直连入口不启用 realip 信任；Cloudflare 前置与“内核仅国内入站”不兼容，不能悄悄放行 CF 网段。

证书采用 **DNS-01**，不放行 HTTP-01、TLS-ALPN-01 的海外验证入站。当前目标没有 ACME 客户端或证书配置；后续签发需指定域名和 DNS 服务商，DNS API 凭据放私有配置。国家库更新后须验证并重新生成 nft 集合、reload Nginx，应用进程按既有步骤重启；三个位置不会自动同步。未知的新国内分配也会被严格规则阻止，需要及时维护数据库。

`sp-lockdown.nft.example` 只创建自己的 `inet sp_lockdown` 表，input priority 10、policy drop，不清空其他表或改动转发/NAT。将 `__SSH_PORTS__` 替换成 **sshd 实际监听端口**，并补齐实际使用的游戏端口。外部 NAT 10067 不代表虚拟机内部也监听 10067。按机器需求保留 DHCP/VPN/代理等其他必要服务；模板不是通用安装器。

先 `nft -c -f <新配置>`，创建五分钟自动回滚任务，再加载自己的表、添加开机 include。另开一个全新 SSH 会话并验证游戏入口，成功后才撤销回滚。回滚只删除自己的表、恢复备份的启动 include，不用 `flush ruleset`。已有海外来源过滤单独保留，修改拒绝为 drop 时按实际 handle 定点替换并同步持久配置。

fail2ban 模板分为 `sp-hardening.filter.conf`（安装到 `filter.d/sp-hardening.conf`）与 `sp-hardening.jail.conf`（安装到 `jail.d/sp-hardening.local`）。模板默认关闭，确认日志中的 IP 就是 TCP 来源后才启用。`backend=auto` 读取文件型日志；60 秒内全部业务请求（日志 `business=1`，含页面、API、WS、缓存命中和 444），超过 300 条即第 301 条永久封禁，`bantime=-1`、`nftables-multiport[blocktype=drop]`，端口填实际监听。单条过滤表达式只匹配 `business=1`，同一行不重复计数；静态资源及重试不计入。不要另开更低阈值的通用 jail 偷偷改变策略。将当前维护出口与回环加入 ignoreip；不要豁免所有私网或所有国内地址。

执行 `fail2ban-client -t`、`fail2ban-regex <访问日志> <filter>`，确认 File list 正确。过滤器允许时间戳被 fail2ban 去除后留下空方括号。使用文档保留地址（如 192.0.2.254）手动 ban，检查 nft 中确实为 drop，重启 fail2ban 确认永久封禁恢复，然后 unban。不要对生产入口发数百个请求测试。Debian 11 的 fail2ban 0.11.2 在 `bips` 表保留 `bantime=-1` 记录；保持其 SQLite 数据库持久化，不通过清空数据库升级。重新加载整个 nftables 规则集会丢掉 fail2ban 动态表，之后须重启 fail2ban 恢复封禁。

```sh
fail2ban-client status sp-hardening-direct
fail2ban-client set sp-hardening-direct unbanip <IP>
```

内核封禁作用于真实传输来源，优先于 established 检查可拦住已建立流量。Cloudflare 代理时传输来源通常是 CF 节点，日志中的访客 IP 不能直接交给 nft 封禁；此时保持该 jail 关闭，使用 CF 边缘规则与应用内封禁。只信任明确代理网段的真实 IP 头。nft 计数为零只说明该地址没作为包源出现，不能据此断定伪造。路径少也可能来自缓存、客户端或 CDN，不能单独据此永久封禁。

## 内核、日志与巡检

`90-sp-hardening.conf` 含 SYN cookies、禁源路由和重定向等 11 个键。先备份并检查现有 sysctl 管理者，只加载这些键；不要照抄 `sysctl --system` 或改变 `rp_filter`、`ip_forward`、`route_localnet`。检查 `/etc/sysctl.conf` 以及其他 drop-in 是否有后加载覆盖。

`sp-hardening.logrotate.conf` 专门覆盖 `/var/log/nginx/sp/*.log`，避免与现有 pattern 重叠。保留正确的 Nginx 用户和 pid 路径。`maxsize 100M` 只有运行 logrotate 时才检查，不是文件大小硬上限；本次服务器将现有 `logrotate.timer` 改为每十分钟执行，rotate 7、压缩，轮转后 USR1 重开日志。先 `logrotate -d /etc/logrotate.conf` 检查重复和权限。

巡检安装 `sp-integrity-check.sh` 与 `sp-integrity-check.py` 到 `/usr/local/sbin/`（root:root，0700），安装同名 service/timer 到 `/etc/systemd/system/`。timer 明确每天 **北京时间 04:17**，不会随服务器 UTC 时区错开。`sp-integrity.cron` 只是按服务器时区执行的备选，不能同时启用。

脚本比较 UID0 账户、密钥、账户权限、启动配置、systemd/cron 和当前根文件系统上的 SUID/SGID 文件。保存哈希及权限，不保存密钥正文；跳过内核虚拟目录、容器目录与其他挂载文件系统。首次检查完成配置后显式 `--init`，基线不自动跟随变化更新；初始化不是证明机器没有入侵。变更返回 1、执行错误返回 2，写本机 authpriv 日志与私有报告，不发送外部通知。

```sh
systemctl daemon-reload
systemctl enable --now sp-integrity.timer
/usr/local/sbin/sp-integrity-check.sh --init
systemctl start sp-integrity.service
cat /var/lib/stronghold-hardening/integrity/last-report.txt
journalctl -u sp-integrity.service
```

合法升级也可能触发变更，应先审阅报告，再显式更新基线。检查 x-ui 等服务的实际用途后再关闭；不存在的服务不额外安装或修改。配置备份含环境变量和私钥时，只存 root 私有目录与 0600 压缩包，不放进仓库或站点。

## 本次部署记录

2026-10-17 应用到 <节点地址>，外部 SSH 10067、内部 SSH 22。Debian 11，Nginx 1.18；游戏只监听 127.0.0.1:3100，Nginx 保留 80/8080/3000。没有 CF 真实 IP 还原配置，入口覆盖上游 IP 头，当前为直连模式。国家集合已改为仓库 MMDB 的 CN 网络，整机包括 SSH 受其限制。没有发现 x-ui systemd 服务或监听。

首轮备份目录 `/root/sec-20261017-005839`，压缩包 `/root/srv-hardening-20261017.tar.gz`。本次 GeoLite 与健康缓存更新备份目录 `/root/sec-geoip-20261016-173349`（服务器采用 UTC 命名），指针 `/root/sp-geoip-current`；压缩包 `/root/srv-geoip-health-hardening-20261017.tar.gz`。包内包含应用前后快照、测试结果与回滚说明，权限 0600。

验证包括新 SSH 会话成功、HTTP 页面 200、非回环请求六个已关闭接口接收零 HTTP 字节、昵称校验 200、本机健康 200、WS 升级 101、fail2ban 永久测试封禁跨服务重启恢复并清理，以及 nftables/Nginx/logrotate/systemd 配置检查。非回环入口测试使用本机绑定内部网卡源地址，不替代云端端口映射全链路测试。

后续严格规则验证：隔离网络命名空间中真实测试国内 IPv4/IPv6 通过、海外/未知/已有海外入站被丢弃、服务器主动连接海外的回复正常；新国内 SSH 成功。真实 GeoIP2 Nginx 独立实例验证国别/伪造头、缓存填充锁、5 秒过期、参数规范化、诊断 BYPASS、错误不缓存、分布式全局限流与坏库校验失败。独立 fail2ban 测试 jail 验证 600 条 HIT 不封、601 封禁及重启恢复，已清理测试 jail 和地址。

Nginx reload 的信号发送成功并不代表新配置已经加载。此次旧共享限流区变更了 key，运行中拒绝复用旧区；已改用新 zone 名并通过实际请求与新 worker 验证。以后修改计数 key 也须更换 zone 名，检查 error log，不能只看 `nginx -t`。

最终 301 阈值复验：独立测试 jail 中 400 条静态响应不计数、300 条业务响应不封，第 301 条业务 444 触发永久封禁；重启恢复后清理测试 jail 和地址。

2026-10-17 已在国内源站叠加[自动浏览器验证](BROWSER_GATE.md)：未验证业务请求 444，浏览器导航显示验证页；公网健康、缓存、静态直出和 WS 均检查凭证，本机健康例外。6 小时凭证由健康响应续期。原游戏 PID 未改变；现场页面、图标、昵称校验为 200，WS 为 101，未验证和伪造头请求均拒绝。备份 `/root/srv-browser-gate-20261017.tar.gz` 含签名密钥，权限 0600；目录指针 `/root/sp-browser-gate-current`，内附回滚脚本。

2026-10-17 按后续要求**临时关闭昵称 HTTP 预检**：原 Node 和前端实现保留；前端 `NICKNAME_PREFLIGHT_ENABLED=false`，Nginx 注释 API 放行项并为 `/api/nickname/validate` 增加临时 `return 444`。WebSocket `hello` 最终检查保留。已重新构建并重启游戏服务，客户端版本为 `2caa3fd738fdaa6e`；验证接口的 GET/POST、查询参数及规范化路径均拒绝，原 Node 回环实现仍可用，页面 200、WS 101、升级封禁 jail 仍运行。私有备份及回滚脚本在 `/root/sec-nickname-pause-20261017-020414`，指针 `/root/sp-nickname-pause-current`，验证后已取消自动回滚。恢复步骤见 [HTTP_PROTECTION.md](HTTP_PROTECTION.md)。
本地真实 Chrome 验证首次进入、WS 拒绝敏感昵称、修改代号及刷新后恢复均通过，全程没有请求昵称 API；原 HTTP 取消场景保留，开关恢复后重新启用。原接口的服务端测试、前端停用/恢复测试及 lint/imports/typecheck 通过。
