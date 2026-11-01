# 卫戍协议 · 服务器状态监控(Prometheus + Grafana)

服务器状态面板:在线连接、会话、房间 / 对局、游戏进程的事件循环延迟 / CPU / 内存、存档写入与主机(宿主机)
资源。整套以 Docker Compose 跑在服务器本机,全部只监听 127.0.0.1;对外展示可用 Grafana 的「公开仪表盘」或
SSH 隧道访问管理界面。

本目录移植自 Stardust fork 的 `deploy/stardust/monitoring`(其改编自
[xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol) 的 `deploy/monitoring`,
GPL-3.0-or-later),保留了它的安全做法:固定采集目标、不接受 `?target=`(不会变成 SSRF 代理)、超时、2 MiB 上限、
不跟随重定向、采集不重叠、标签取值有限、Prometheus 与 collector 不对外。

这是**部署资产**,不进本仓的测试分片 / package.json scripts;本地跑它目录里的测试即可(见 §5)。

与 fork 集群的差异(本仓语境):

- 数据来源是游戏服务器自己的 `GET /healthz?traffic=1`(server/http/routes.js healthReport)。`traffic` 与
  `performance` 字段只对回环 / 私网客户端返回,collector 经本机或内网访问,满足该条件;公网访问者拿到的是
  不含这两个块的普通 /healthz。
- fork 的 OpenResty 边缘指标(`ark_edge_*`、nginx job、每秒请求 / 5xx 面板)与 hello / 断线重连、
  checkpoint 仓库(`sp_store_*`)指标在 B 的 healthz 里没有对应字段,整套不搬运;prometheus.yml 只有
  collector / node / prometheus 三个 job。
- B 自己的持久化面是 healthz 的 `persist` 块(server/persist.js),导出为 `sp_persist_*`。
- 性能数字来自 server/healthMetrics.js(移植自 fork)的 10 s 缓存采样,`performance.phases` 不导出。

## 1. 组件与端口

全部容器 `network_mode: host`,只监听 127.0.0.1,不发布任何端口:

| 服务 | 镜像(固定版本) | 监听 | 作用 |
|---|---|---|---|
| collector | 本目录 `collector/` 构建,`node:24.22.0-alpine3.24` | 127.0.0.1:9108 | 每 10 秒(超时 5 秒)拉取 `MONITOR_HEALTHZ_URL`,转成 `sp_*` 指标 |
| node-exporter | `prom/node-exporter:v1.12.1` | 127.0.0.1:9100 | 主机 CPU / 内存 / 负载 / 网卡 / 文件系统 |
| prometheus | `prom/prometheus:v3.15.0` | 127.0.0.1:9090 | 采集 15 秒(collector 10 秒),保留 **30 天 / 5 GB**,预计算面板用的 recording rules |
| grafana | `grafana/grafana:13.2.4` | 127.0.0.1:3160(子路径 `/monitor/`) | 中文深色仪表盘「卫戍协议 · 服务器状态」(uid `sp-status`) |

资源:每个容器 `restart: unless-stopped`、`read_only`、`cap_drop: [ALL]`、`no-new-privileges`、`cpu_shares: 128`
(不和游戏服务器抢 CPU)、日志 10 MB × 3;内存上限 collector 96 MB、node-exporter 64 MB、Prometheus 512 MB、
Grafana 1.5 GB(`GOMEMLIMIT=1GiB`)。compose 里 node-exporter 的 `--collector.netdev.device-include=^(ens3|ark-hz0)$$`
沿用了 fork 入口机的网卡名:**部署前把 `ens3` 换成本机公网网卡名**(同时改面板里的 `device="ens3"`,
`grafana/dashboards/stronghold-status.json` 的「出口 / 入口带宽」面板),否则带宽面板没有数据。

## 2. 安全边界

- collector 只拉取一个固定 URL;`/metrics` 的查询参数被忽略;不记录响应正文、URL 或客户端地址;失败只按固定
  原因计数。某次拉取失败(或成功结果已过期)时立刻不再输出任何游戏数值(`sp_up 0`),面板显示「—」与「异常」。
- 所有标签不含 IP 或主机名:Prometheus 把 `instance` 改写为 `gameserver` / `host` / `prometheus`,删除
  node-exporter 的 `nodename` / `domainname`,丢弃 `device` 中带地址的序列。
- 游戏服务器只对回环/私网客户端返回 `traffic` / `performance`(server/http/routes.js);collector 从本机或
  内网访问,满足此条件;进程诊断细节不进公网 /healthz。
- Grafana:匿名访问关闭、禁止注册、管理员密码只从文件读取(`GF_SECURITY_ADMIN_PASSWORD__FILE`)、
  `cookie_secure`、Grafana Live 关闭(`[live] max_connections = 0`)、不发统计/更新检查/新闻/gravatar/插件预装/
  外部快照请求。公开仪表盘不支持模板变量,本面板也没有;注释(annotations)关闭。
- 管理界面只走 SSH 隧道:`ssh -L 3160:127.0.0.1:3160 <服务器>`,然后打开 `http://127.0.0.1:3160/monitor/`。
- `monitoring.env` 里没有秘密;密码文件不放进仓库、不打印、不计算哈希。

## 3. 部署(服务器本机)

前提:Docker 与 Docker Compose;游戏服务器在本机(默认 3000 端口)或内网可达的地址上跑着。

```sh
cd deploy/monitoring                    # 或只把本目录复制到服务器,不需要整个仓库
cp monitoring.env.example monitoring.env
# 编辑 monitoring.env:MONITOR_HEALTHZ_URL=http://127.0.0.1:3000/healthz?traffic=1
#                      GRAFANA_ROOT_URL=https://<站点>/monitor/(或保持本地地址,纯隧道使用)

# 1) 拉取固定版本镜像,构建 collector
docker compose --env-file monitoring.env -f compose.monitoring.yaml pull node-exporter prometheus grafana
docker compose --env-file monitoring.env -f compose.monitoring.yaml build collector

# 2) Grafana 管理员密码文件:属主 472(镜像内 grafana 用户),0400,不在终端显示
sudo install -d -m 0750 /etc/sp-monitor
sudo sh -c 'umask 077; head -c 32 /dev/urandom | base64 | tr -d "\n=+/" > /etc/sp-monitor/grafana-admin-password'
sudo chown 472:0 /etc/sp-monitor/grafana-admin-password && sudo chmod 0400 /etc/sp-monitor/grafana-admin-password

# 3) 启动并检查
docker compose --env-file monitoring.env -f compose.monitoring.yaml config --quiet
docker compose --env-file monitoring.env -f compose.monitoring.yaml up -d
docker compose --env-file monitoring.env -f compose.monitoring.yaml ps
curl -fsS http://127.0.0.1:9108/metrics
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up'   # 3 个 job 都应为 1

# 4)(可选,公开状态页)建立公开仪表盘,打印访问 token 与路径
sudo GRAFANA_URL=http://127.0.0.1:3160/monitor \
     GRAFANA_ADMIN_PASSWORD_FILE=/etc/sp-monitor/grafana-admin-password \
     [GRAFANA_PUBLIC_URL=https://<站点>/monitor/] \
     node publish-dashboard.mjs
```

`publish-dashboard.mjs`(Node ≥ 22,无依赖;机器上没有 Node 时可用
`docker run --rm --network host -v "$PWD/publish-dashboard.mjs:/p.mjs:ro" -v /etc/sp-monitor/grafana-admin-password:/pw:ro -e GRAFANA_ADMIN_PASSWORD_FILE=/pw node:24.22.0-alpine3.24 node /p.mjs`)
是幂等的:第一次创建(share=public、允许选择时间范围、注释关闭),以后只在设置被改动时纠正,token 不变。输出:

```
status=created            # 或 updated / unchanged
dashboard_uid=sp-status
public_dashboard_uid=<uid>
access_token=<32 位十六进制>
public_path=/monitor/public-dashboards/<access_token>
public_url=https://<站点>/monitor/public-dashboards/<access_token>   # 仅在设置 GRAFANA_PUBLIC_URL 时
```

token 本身就是公开地址,可以打印;密码只以 HTTP Basic 发给 `GRAFANA_URL`(明文 http 只允许回环地址)。
对外发布公开页时,反向代理只应放行 `/monitor/public-dashboards/`、`/monitor/api/public/`、`/monitor/public/`
三个前缀,其余 `/monitor/...` 一律 404(fork 用 OpenResty 做的事,任何反代都能配)。

Grafana 管理员密码只在**第一次创建数据库**时生效;之后改了文件要同步到数据库(密码从 stdin 读,不进命令行历史):
`docker compose --env-file monitoring.env -f compose.monitoring.yaml exec -T grafana grafana cli admin reset-admin-password --password-from-stdin < /etc/sp-monitor/grafana-admin-password`。

## 4. 指标

collector(`collector/metrics.mjs` 有完整表格;缺失 / null / 非数字字段不输出,不当作 0;计数器以 `_total`
结尾,服务器重启后归零,由 `rate()` 处理):

- 自身:`sp_up`、`sp_scrape_duration_seconds`、`sp_last_success_timestamp_seconds`、`sp_polls_total`、
  `sp_poll_failures_total{reason}`、`sp_info{app,build}`
- 玩家与房间(gauge):`sp_sockets`、`sp_sessions`、`sp_rooms`、`sp_matches`、`sp_humans`、`sp_bots`、
  `sp_spectators`、`sp_uptime_seconds`、`sp_ok`、`sp_content_sets`、`sp_content_plugins`
- 性能(healthMetrics.js 的 10 秒窗口,gauge,秒/字节/比例):`sp_event_loop_delay_seconds{stat=p50|p95|p99|max}`、
  `sp_event_loop_utilization`、`sp_process_cpu_ratio`(1 = 一个核心)、`sp_process_resident_memory_bytes`、
  `sp_heap_used_bytes` 等;`performance.phases` 不导出
- 存档(`persist` 块,server/persist.js):`sp_persist_writes_total`、`sp_persist_failures_total`、
  `sp_persist_checkpoints`、`sp_persist_last_save_seconds` 等
- 流量(traffic 计数器):`sp_http_responses_total{class}`、`sp_http_response_bytes_total{class}`、
  `sp_http_not_modified_total{class}`、`sp_ws_wire_bytes_total{direction}`、`sp_ws_payload_bytes_total{direction}`、
  `sp_ws_messages_total{direction}`、`sp_ws_connections_total`、`sp_ws_open`
- **fork 集群专用、本仓拿不到**:在线人数 / 排队(`online` / `queued`)、每网络上限与拒绝(`sp_limit*`)、
  断线重连(`sp_hello_total` / `sp_match_seat_departures_total`)、backpressure / stateDelta(`sp_state_*`)、
  协调器存档仓库(`sp_store_*`)、OpenResty 边缘(`ark_edge_*`)——均不导出

recording rules(`prometheus/rules.yml`,面板只读这些和少量 gauge,公开查询很便宜):`sp:server_up`、
`sp:persist_writes:rate2m`、`sp:persist_failures:rate2m`、`host:cpu_usage:ratio`、`host:memory_usage:ratio`、
`host:network_{transmit,receive}_bits:rate2m`。没有告警规则(没有 Alertmanager)。

面板不显示 fork 的杭州游戏主机机器指标与入口带宽之外的东西;`device="ens3"` 按本机网卡改(见 §1)。

## 5. 保留、升级与备份、测试

- Prometheus 保留 30 天或 5 GB(先到者生效),数据在命名卷 `sp-monitor_prometheus-data`;Grafana 数据库
  (含公开仪表盘 token)在 `sp-monitor_grafana-data`。**不要运行 `down -v`**。升级镜像前备份这两个卷。
- 修改面板:编辑 `grafana/dashboards/stronghold-status.json`,Grafana 每 60 秒重新读取;界面上的改动不会保存。
- 修改规则或采集配置后重启 Prometheus(未开启 lifecycle API):`docker compose ... restart prometheus`。
- 本目录自带的测试(不需要 Docker):

```sh
node --test deploy/monitoring/test/config.test.mjs deploy/monitoring/test/collector.test.mjs deploy/monitoring/test/publish.test.mjs
npx eslint deploy/monitoring
docker run --rm -v "$PWD/deploy/monitoring/prometheus:/etc/prometheus:ro" --entrypoint promtool \
  prom/prometheus:v3.15.0 check config /etc/prometheus/prometheus.yml
docker run --rm -v "$PWD/deploy/monitoring/prometheus:/etc/prometheus:ro" --entrypoint promtool \
  prom/prometheus:v3.15.0 check rules /etc/prometheus/rules.yml
curl -fsS http://127.0.0.1:9108/metrics | docker run --rm -i --entrypoint promtool prom/prometheus:v3.15.0 check metrics
```

config / collector / publish 三个测试在本仓已适配并通过(fork 的 OpenResty 与集群指标断言随面板一起裁掉);
promtool 与真实栈的启动验证是部署机上的动作,仓库里没跑。

## 6. 致谢

collector、compose 与 Prometheus 配置改编自 Stardust fork(其改编自
xinhai-ai/Stronghold-Protocol 的 `deploy/monitoring`,GPL-3.0-or-later),感谢原作者。
