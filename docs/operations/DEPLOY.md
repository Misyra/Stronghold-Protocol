# 部署指南

这是本分支部署与更新的总入口。所有命令默认从项目根目录执行，Node.js 要求 22 或更高；线上运行一个常驻 Node 进程，并将站点部署在域名根路径。

| 场景 | 看这里 |
|---|---|
| Linux 生产站点 | 本文的安装、systemd、反向代理和更新步骤 |
| Docker | 本文的容器步骤 |
| Windows / 家用小主机 / 整合包升级 | [HOME_SERVER.md](HOME_SERVER.md) |
| 游戏内公告接入管理面板 | [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md) |
| 素材 R2 发布、预载和清理缓存 | [CDN.md](CDN.md) |
| 对局检查点与备份恢复 | [PERSISTENCE.md](PERSISTENCE.md) |
| 监控探针与管理面板的分工 | [MONITORING.md](MONITORING.md) |
| 制作发行包 / Windows 便携包 | [PACKAGING.md](PACKAGING.md) / [WINDOWS.md](WINDOWS.md) |

## 安装

```bash
git clone https://github.com/Misyra/Stronghold-Protocol.git /opt/Stronghold-Protocol
cd /opt/Stronghold-Protocol
npm ci --omit=dev
```

素材来源选择一种：

- 本机提供素材：运行 `node tools/setup.mjs`，下载失败可重跑续传；缺失明细和环境诊断用 `node tools/doctor.mjs`。
- 使用已发布的本站 CDN：配置 `SP_ASSETS_CDN=https://assets.misyra.com`，保留随代码发布的 `.assets-manifest.json`，无需在服务器下载整套素材。新建自己的 CDN 先按 [CDN.md](CDN.md) 配置和发布。

本分支跟踪的 `public/assets/local/` 随 Git 下载；资源来源、客户端提取和清单见[素材说明](../development/ASSETS.md)。源码部署不要混用上游发行包中的程序文件。

## 配置

推荐把线上配置放在 `/etc/stronghold/game.env`，由服务管理器加载。`npm start` 不会自动读取根目录 `.env`。

```dotenv
PORT=3000
HOST=127.0.0.1
SP_STATE_FILE=/var/lib/stronghold/game
SP_ASSETS_CDN=https://assets.misyra.com
SP_ANNOUNCEMENT_SOURCE=panel
SP_PORTAL_URL=https://game.rainya.me
# 本分支默认是西安 / 新国内，其他实例按面板的稳定 ID 修改这一行。
SP_SITE_ID=site-ad797aa8
```

| 站点 | 面板 ID |
|---|---|
| 国内（十堰） | `shiyan` |
| 国内2（阿里云） | `aliyun` |
| 香港 | `hongkong` |
| 西安 / 新国内 / 测试勿选（wei.rainya.me:16657） | `site-ad797aa8` |

默认公告来源是管理面板，未设置 URL 或保留旧 `announcement.json` 都不会切回本地文件。已有 `SP_ANNOUNCEMENT_URL` 优先，务必检查旧值是否指向正确站点；新接入站点从面板站点配置读取 ID，不能用显示名称代替。完整规则见[公告接入](ANNOUNCEMENTS.md)。

默认开启服务端检查点；保留状态目录可恢复最近的安全阶段，作战进行中重启可能重打该回合。状态目录包含私有重连身份，必须随配置一起备份。具体恢复边界见 [PERSISTENCE.md](PERSISTENCE.md)。

<a id="4-macos--linux-常驻"></a>

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stronghold
journalctl -u stronghold -f
```

macOS 临时运行可用 `scripts/start.sh`；Windows 自启见 [HOME_SERVER.md](HOME_SERVER.md#14-开机自动在后台运行)。

<a id="24-反向代理与-https有域名时"></a>

## 反向代理

游戏必须在域名根路径运行；转发 WebSocket `/ws`，其余请求交给同一个 Node 实例。完整 nginx 配置使用 [scripts/nginx.conf.example](../../scripts/nginx.conf.example)，替换域名、证书及 Node 端口。`worker_processes auto;` 放在主配置顶层；`map` 放在 `http` 中。

Caddy 的最小配置：

```caddy
game.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx 修改后先 `sudo nginx -t`，通过后再 reload。Node 只监听本机时不必对公网开放 3000；公网入口使用 HTTPS。不要让多个 Node 实例共享一个状态目录。

`/api/announcement` 转发到游戏 Node；面板公开 feed `/api/announce/v1/<siteId>` 由 sp-portal 提供，两者是不同接口。公告 API 如加共享缓存，保持 5 秒，不超过 10 秒；普通 API 不缓存。资源预载的 `/resource-sw.js`、`/js/resources/`、`/data/resource-manifest.json` 必须指向当前 Node，遵循源站缓存头，不能套用素材一年缓存规则。

<a id="3-docker"></a>

## Docker

从本分支源码构建，默认镜像不下载整套素材；以下使用已发布 CDN，并挂载持久化状态：

```bash
docker build -t stronghold-protocol .
docker run -d --name stronghold --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file /etc/stronghold/game.env \
  -e HOST=0.0.0.0 -e SP_STATE_FILE=/app/.state/server.state.json \
  -v stronghold-state:/app/.state stronghold-protocol
```

容器内部需要监听 `0.0.0.0`，覆盖宿主机环境文件里的 `127.0.0.1`；状态路径同样覆盖为容器持久卷。不用 CDN 时，以 `--build-arg FETCH_ASSETS=1` 构建并移除 `SP_ASSETS_CDN`，或挂载宿主机已准备好的整个 `public/assets`（包括 `local/`）。

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
    volumes: ["stronghold-state:/app/.state"]
    restart: unless-stopped
    stop_grace_period: 30s
volumes:
  stronghold-state:
```

更新镜像后复用同一个持久卷。容器备份与恢复见 [PERSISTENCE.md](PERSISTENCE.md#docker)。

<a id="15-更新"></a>

## 更新与验收

先正常停止游戏并备份状态目录和 `/etc/stronghold/game.env`，再更新程序；首次从不支持持久化的旧版升级时，等旧进程的对局结束。

```bash
sudo systemctl stop stronghold
# 此时备份 /var/lib/stronghold 和 /etc/stronghold/game.env 到你的私有备份位置
cd /opt/Stronghold-Protocol
git status --short
git pull --ff-only
npm ci --omit=dev
# 本机素材模式才需 node tools/setup.mjs；CDN 模式随代码更新发布清单即可。
sudo systemctl start stronghold
```

若本机 setup 修改了 `data/assets.json`，先核对差异并备份，再恢复该生成文件后拉取；不要用整树重置覆盖配置和其他修改。回滚同时恢复对应版本的状态备份，不能假定旧代码能读取新版存档。

验收：

1. `curl -s http://127.0.0.1:3000/healthz`：版本、`persist`、`assetsCdn`、`assetsManifest` 符合部署配置。
2. `curl -s http://127.0.0.1:3000/api/announcement`：`source.mode` 为 `panel`，`source.siteId` 对应本站；在面板发布后确认正文生效。
3. 浏览器打开游戏，创建并加入房间；确认 WebSocket 正常连接，刷新后可重连。
4. CDN 模式检查图片和音频请求带 `?v=`；预载窗口可导入资源包并显示结果。

## 排错与调优

| 现象 | 检查 |
|---|---|
| 端口占用 | 是否重复启动了 systemd、计划任务或手动进程；先停止重复进程 |
| 画面或声音缺失 | `node tools/doctor.mjs`；CDN 模式核对清单和资源 URL，本机模式补跑 setup |
| 面板已发布，游戏无公告 | 核对 `/api/announcement.source`、旧 `SP_ANNOUNCEMENT_URL`、站点 ID 和日志 `[announcement]`；见[公告排错](ANNOUNCEMENTS.md#排错) |
| 重启后无法恢复 | `/healthz.persist` 和状态目录权限；是否挂载原持久卷；见[持久化说明](PERSISTENCE.md) |
| 游戏能访问，面板监控无数据 | 探针、令牌及 nginx 管理路由；见[监控接入](MONITORING.md) |
| CPU / 内存过高 | Worker 数量、队列与校验模式，见[性能说明](../development/PERFORMANCE.md) |

`SP_WS_COMPRESSION` 默认 `on`，可设 `off`；`SP_WORKERS` 控制模拟线程数，0 关闭，默认可用逻辑核心减 2、至少 1、最多 8。资源占用与真实并发有关，用 `/healthz` 观察 CPU、内存、队列与网络状况后调整，变量修改需重启。

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
本地客户端素材见 [ASSETS.md](../development/ASSETS.md)。
<a id="7-打包发布维护者"></a>
发行包制作移至 [PACKAGING.md](PACKAGING.md)。
