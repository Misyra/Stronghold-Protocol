# 部署总览与探针部署清单（2026-10-07 起）

中间页与运维面板已合并为**一个服务**（本项目 `sp-monitor` 仓库已并入，仅作回滚参考）。现在只剩两类机器：

| 机器 | 运行 | 说明 |
|---|---|---|
| Web 服务器（阿里云） | `sp-portal` 单进程 + nginx | 玩家页面 `/`、运维面板 `/ops/`、公告拉取 `/api/announce/v1/`、脚本管理 `/api/admin/*`（仅回环） |
| 游戏服务器 ×3（十堰、阿里云、香港） | 游戏进程 + 探针（collector + Agent） | 探针把本机指标交给面板轮询；临夏站为第三方，不部署探针 |

```text
浏览器 ──► nginx(阿里云) ──► node server.mjs ──轮询──► 各站 Agent (Bearer)
                                    │
游戏进程(各站) ──10秒拉取──► /api/announce/v1/<站id>   ← 面板公告存储（唯一编辑入口在 /ops/）
Agent(各站) ──读──► collector(3999) + 游戏 /healthz + 证书
```

## 一、Web 服务器（阿里云）升级步骤

1. 备份现有 `/opt/stronghold-portal` 与 `/etc/stronghold/portal.env`、`/var/lib/sp-portal/rooms.json`。
2. 复制新代码到 `/opt/stronghold-portal`（根目录 .mjs、`lib/`、`client/` 全部，含 `client/ops/`）。
3. `portal-sites.json` 按新 `sites.example.json` 增加 `adminUrl` / `tokenEnv` 字段（站点其余字段不变；临夏站不加）。
4. `portal.env` 增加面板与探针令牌变量（见 README 环境变量块）：`PANEL_AUTH_USER`、`PANEL_AUTH_PASSWORD`、`PANEL_ANNOUNCE_FILE`、三个 `SP_SITE_*_TOKEN_RO`。
5. 更新 nginx（`deploy/nginx-portal.conf.example`）：`/api/panel/` 的 `client_max_body_size` 放宽到 32k；新增 `location ^~ /ops/`（托管 `client/ops/` 静态文件）；`/api/admin/` 保持 404；`/api/` 反代不变（公告拉取与面板 API 都走它）。
6. `systemctl restart sp-portal`，验证：
   - `curl -s http://127.0.0.1:4200/api/health` → `{"ok":true,...}`
   - `curl -s http://127.0.0.1:4200/api/announce/v1/aliyun` → `{"enabled":...}`
   - 浏览器开 `https://<中间页域名>/ops/`，用 `PANEL_AUTH_USER/PASSWORD` 登录。
7. 旧监控面板（`sp-panel.service`，端口 4100）确认新面板正常后停用：`systemctl disable --now sp-panel`。

## 二、探针部署清单（十堰、香港各执行一遍）

阿里云游戏站若已装过旧版 collector/Agent，只需更新文件并重启对应 unit；下面按全新安装写。

### 方式 A（推荐）：游戏仓库绑定，更新 = git pull

探针源码由 sp-portal 的同步脚本 vendored 进游戏仓库 `ops/` 目录（collector + Agent + 部署文件 + `VERSION` 版本标记）。面板站点卡片会显示每台的「探针 sp-ops-xxxx」版本（探针文件内容哈希），三台是否都更新到位一眼可见。

```bash
# 开发机（sp-portal 目录）：改完探针后同步进游戏仓库，然后提交推送游戏仓库
node deploy/sync-agent.mjs            # 目标默认 ../Stronghold-Protocol/ops；--check 只校验一致性

# 游戏服首次安装（游戏仓库已在服务器上；APP_DIR 指向其中的 ops 目录）：
sudo env APP_DIR=/opt/Stronghold-Protocol/ops SITE_NAME=十堰 \
  SP_ADMIN_TOKEN_RO="$(openssl rand -hex 32)" MON_CAPACITY=325 \
  MON_NGINX_LOG=/var/log/nginx/sp.rainya.me.access.log MON_IFACE=eth0 \
  /opt/Stronghold-Protocol/ops/deploy/install-agent.sh

# 游戏服日常更新（探针随游戏代码一起 git pull）：
cd /opt/Stronghold-Protocol && git pull
sudo systemctl restart sp-collector sp-admin
```

（systemd unit、nginx 片段由安装脚本按 APP_DIR 生成；数据目录 `/var/lib/stronghold-monitor` 与 `/etc/stronghold/*.env` 不随仓库走，更新代码不影响历史数据与令牌。）

### 方式 B：zip 手动部署

部署包解压后，每台游戏服务器**一条命令**完成：写 env、装 systemd unit、装 nginx 片段、启动并自检。

```bash
# 0) 上传 dist/sp-ops-agent.zip 解压到 /opt/stronghold-ops；本站令牌先在中间页 portal.env 配好
# 1) 在本站执行（十堰示例；香港替换 SITE_NAME/MON_NGINX_LOG/MON_CAPACITY）：
sudo env SITE_NAME=十堰 \
  SP_ADMIN_TOKEN_RO="$(openssl rand -hex 32)" \
  MON_CAPACITY=325 \
  MON_NGINX_LOG=/var/log/nginx/sp.rainya.me.access.log \
  MON_IFACE=eth0 \
  CENTRAL_HEALTH=https://<中间页域名>/api/health \
  /opt/stronghold-ops/deploy/install-agent.sh
# 2) 按脚本结尾提示，把  include snippets/stronghold-ops.conf;  加进本站 HTTPS server 块后 reload nginx
```

脚本行为：生成 `/etc/stronghold/{monitor,admin}.env`（600 权限；已存在则保留，`FORCE=1` 覆盖）、安装 `sp-collector`/`sp-admin` systemd 单元（含硬化选项）、写 `/etc/nginx/snippets/stronghold-ops.conf`、启动服务并 curl 自检（collector 3999 / Agent 3900 / 可选中间页连通性）。nginx 的 include 与 reload 留给人执行，避免脚本改坏线上 vhost。完成后跳到下面第 4 步验证；下面 1–3 是手动等价步骤，供排查或不用脚本时参考。

### 手动步骤（与脚本等价）

### 0. 准备

- 服务器上需有 Node.js ≥22（`node -v`）。
- 部署包：本地 `dist/sp-ops-agent.zip`（含 `collector.mjs`、`agent.mjs`、`lib/`、`deploy/`），上传解压到 `/opt/stronghold-ops`。
- 在 Web 服务器上为本站生成只读令牌（每站不同，写入 `/etc/stronghold/portal.env` 的对应 `SP_SITE_*_TOKEN_RO`）：
  `openssl rand -hex 32`
  同一个值也要写进游戏站的 `/etc/stronghold/admin.env`（下一步）。

### 1. 本机采集器（collector，回环 3999）

`/etc/stronghold/monitor.env`（按站点实际情况改容量与网卡）：

```ini
MON_BIND=127.0.0.1
MON_PORT=3999
MON_HEALTHZ=http://127.0.0.1:3000/healthz
MON_DATA_DIR=/var/lib/stronghold-monitor
MON_NGINX_LOG=/var/log/nginx/<本站域名>.access.log
MON_IFACE=eth0
MON_CAPACITY=<本站容量，如 325 / 799>
MON_TIME_ZONE=Asia/Shanghai
# 可选：磁盘 IO 性能指标统计的设备（读/写 KB/s、%util、await）；留空自动取 / 挂载点设备
# MON_DISK_DEV=vda1
# 可选：单轮最多解析的日志行数（默认 10000，超出顺延下一轮不丢数据）；日志峰值很大时可调小
# MON_LOG_MAX_LINES=10000
```

```bash
sudo useradd -r -s /usr/sbin/nologin spmonitor || true
sudo mkdir -p /var/lib/stronghold-monitor && sudo chown spmonitor:spmonitor /var/lib/stronghold-monitor
# 访问日志需要可读：给 spmonitor 读取权限或在 logrotate 里补一套
sudo systemctl enable --now sp-collector      # unit 模板见 deploy/stronghold-monitor.service.example
curl -s http://127.0.0.1:3999/api/health      # → {"ok":true,...}
```

访问日志使用 nginx 的 combined 格式。只授予 `spmonitor` 本站访问日志的读权限及父目录的遍历权限；不要授予私钥或日志写权限。若使用 ACL，可对该日志执行 `setfacl -m u:spmonitor:r-- <日志路径>`；同时在现有 logrotate 配置的 postrotate 中恢复该 ACL，或使用固定的只读日志组，确保轮转后仍可读。安装脚本会以 `spmonitor` 检查日志可读性；新探针把路径、权限、格式错误单独报告，访问统计显示“—”，游戏和系统采样继续。

自定义 `MON_DATA_DIR` 使用独立持久目录（绝对路径，无空格；不使用 /tmp、/var/tmp）。安装脚本按现存 monitor.env 中的路径创建目录、设置属主并生成 ReadWritePaths；直接使用 unit 模板时需同步修改这一行。容量 `MON_CAPACITY` 按各站实际情况分别设定。

注意：本机 nginx 日志路径须与 `MON_NGINX_LOG` 一致，且确认「面板与内部接口不计入统计」的路径过滤（`/api/admin/`、`/api/panel/`、`/healthz` 等）符合本站 vhost 实际路径。

### 2. 只读 Agent（回环 3900）

`/etc/stronghold/admin.env`（权限 600，不要提交 Git）：

```ini
SP_ADMIN_TOKEN_RO=<第 0 步生成的令牌>
MON_COLLECTOR_URL=http://127.0.0.1:3999/api/data
MON_ANNOUNCEMENT_URL=http://127.0.0.1:3000/api/announcement
SP_ADMIN_PORT=3900
MON_AGENT_INTERVAL_MS=10000
MON_TIMEOUT_MS=5000
MON_STALE_MS=45000
# 可选：证书到期提醒，只需公开证书 PEM 的读权限，不要私钥
# MON_CERT_FILE=/etc/letsencrypt/live/<域名>/fullchain.pem
```

```bash
sudo systemctl enable --now sp-admin          # unit 见 deploy/sp-admin.service
curl -s -H "Authorization: Bearer <令牌>" http://127.0.0.1:3900/api/admin/v1/health
```

### 3. 本站 nginx 增加管理路由

把 [deploy/nginx-agent.conf.example](deploy/nginx-agent.conf.example) 合并进本站现有 HTTPS server 块：

- `location ^~ /api/admin/v1/` → 反代 `127.0.0.1:3900`，透传 `Authorization`，`auth_basic off`，不缓存；
- 不要在本站暴露 3900 端口本身；
- 检查与现有 CORS／缓存头合并效果，不要添加 `Access-Control-Allow-Origin`。

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4. 回到 Web 服务器验证

```bash
curl -s -H "Authorization: Bearer <本站令牌>" https://<本站域名>/api/admin/v1/overview | head -c 300
```

面板 `/ops/` 中该站卡片应从「尚未配置」变为「运行正常」；趋势与归档约几分钟后出现数据。两台都完成后，三个自建站全部显示；重启面板不需要动游戏进程。

### 5. 游戏内公告接入（可选但推荐）

在每台自建游戏站（十堰、阿里云、香港）游戏进程的环境里设置：

```ini
SP_ANNOUNCEMENT_URL=https://<中间页域名>/api/announce/v1/<站id>
# 可选：拉取间隔，默认 10 秒（允许 3 秒～10 分钟）
# SP_ANNOUNCEMENT_POLL_MS=10000
```

重启游戏进程后，`/ops/` 发布的公告约 10 秒内到达该站：拉取失败或断源保留上一条有效公告，面板显式停用（`enabled: false`）立即撤下，到期自动隐藏。若该站此前配过本地公告文件 `SP_ANNOUNCEMENT_FILE`，设置本变量后本地文件不再参与（二选一，拉取优先接管）。拉取是纯出站请求，游戏站不需要开放任何入站端口或路由（面板 nginx 的 `/api/` 反代已覆盖公告 feed）。临夏站为第三方分支（xinhai），其游戏端没有 `SP_ANNOUNCEMENT_URL`，暂无法接入。

验证：在 `/ops/` 发布一条公告，约 10 秒内该站「线上生效」列应从「无公告」变成公告标题。

### 6. 本次修复的升级与验证

先更新 Web 服务器的 `lib/metrics.mjs` 和 `client/ops/` 并重启 sp-portal，让面板识别“访问日志状态 / 统计落盘状态”。各游戏服更新完整 ops/ 后重启 sp-collector、sp-admin，核对面板探针版本与本地 VERSION 一致。已有 unit 若使用自定义数据目录，应重新运行安装脚本（默认保留原有 env 与令牌），或修正 unit 的 ReadWritePaths 后 daemon-reload。

- `/api/data` 的 diagnostics.nginx、diagnostics.storage 应为 ok；Agent overview 的 sections 同样报告它们。老探针缺失这些字段时显示“未知”。
- `/api/health` 的 ready 表示存在近期采样，degraded 表示日志或落盘故障；ok 仅表示进程可达。
- 日志读取按完整行的字节位点续读，默认每轮最多 10000 行 / 4 MiB，64 KiB 分段读取并在达到行数预算时停止。未处理的文本保留在日志文件中，不叠加 carried，也不会在落盘时再次回退位点。
- 统计落盘失败会告警并保留待写状态，下一轮自动重试，不中断游戏和系统指标采样。

### 7. 探针的资源占用与限额

探针刻意做得很轻：collector 默认 15 秒采样一轮（`MON_INTERVAL_MS`），单轮本地工作只有几毫秒（读 /proc 若干小文件 + 增量解析日志 + 一次本地 healthz），常态 CPU 占用远低于 1% 单核。在此之上还有四层硬性保证，限制异常情况下的资源占用：

1. **systemd `CPUQuota=10%`**——两个 unit 各自硬性封顶单核 10%，超限只会拖慢探针自己的采样，限制它们对游戏的 CPU 影响；另有 `Nice=10` + `CPUSchedulingPolicy=batch`（CPU 让路）、`IOSchedulingClass=idle`（磁盘让路）、`MemoryMax`（内存护栏，collector 512M / agent 384M）。
2. **日志解析行数预算** `MON_LOG_MAX_LINES`（默认 10000 行/轮）——单轮最多解析这么多行，积压顺延到下一轮且字节守恒不丢行；单轮 CPU 因而有界。
3. **进程 RSS 扫描降频**——全量 /proc 扫描每 15 轮一次，其余轮次只回读缓存的几个 pid。
4. **慢轮自监控**——单轮本地工作超过 1 秒会在 journal 里告警（`journalctl -u sp-collector` 可见），异常积压或 IO 延迟可触发这个阈值。

### 8. 集中历史保存与本次升级

监控机器需要 Node.js >= 22.13，并在 portal.env 设置 PANEL_HISTORY_FILE=/var/lib/sp-portal/monitor-history.sqlite；新版 sp-portal.service 已有该默认值。中央库永久保留完整原始采样、每日统计和状态记录，游戏服 MON_RETAIN_DAYS 仅控制有限补传缓存。先更新中央端，再更新游戏服完整 ops/ 并重启 sp-collector、sp-admin，最后重启 sp-portal；已有 unit 不必重装探针，新增模块由游戏仓库同步分发。

浏览器在站点详情页查询日期、分页日归档、导出 CSV/JSONL。面板会显示归档采样数量、覆盖时间、补传进度、错误或已过保留期的缺口。旧探针兼容轮询保存，但无法补传原始采样。查看 [集中历史保存、备份与分析](HISTORY.md)；必须使用一致性备份方式复制运行中的 SQLite 数据库。

MON_STALE_MS/PANEL_STALE_MS 未显式设置时自动按采样/轮询周期调整；已有固定配置是明确覆盖，如需自动调整请移除该固定值。日志积压/处理延迟通过 logBacklogBytes/logLagSec 显示；游戏 RSS 优先读取 healthz.memory.rss，仅旧服务使用 /proc 回退。

## 三、安全边界

- 面板凭据（Basic Auth）与各站探针令牌只存在服务端环境文件；浏览器只接触面板同域 API，从不持有探针令牌。
- 面板 API、/ops 静态页与探针 Agent 对**鉴权失败统一延迟 200ms**（配合常数时间比较），拖慢在线爆破；可在 nginx 对 `/api/panel/` 加 `limit_req` 进一步收紧（见示例注释），或直接上 fail2ban。
- Agent 只读：无写方法、无玩家 IP 列表、无会话明细；指标经白名单脱敏后才进入面板。
- `/api/announce/v1/` 是面板唯一无鉴权前缀，仅返回玩家可见的公告字段。
- 探针管理路由的 CORS 关闭、无缓存；令牌只走 `Authorization` 头（query 传令牌直接 400）。
- 面板写接口带同源校验 + JSON 限定；`/api/admin/*` 不经公网（nginx 404），脚本在同机回环调用。

## 四、回滚

- Web 服务器：git 回退本项目到合并前版本并重启 `sp-portal`，恢复 `sp-panel.service`（旧 4100 面板）即可；`/var/lib/sp-portal/rooms.json` 与公告文件格式未变。
- 游戏站：`systemctl disable --now sp-admin sp-collector` 并移除 nginx 管理路由；游戏进程全程未改动。
