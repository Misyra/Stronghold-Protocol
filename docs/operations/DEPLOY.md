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
SP_ANNOUNCEMENT_SOURCE=agent
SP_MODERATION_KEY_FILE=/etc/stronghold/moderation.key
```

公告默认读取探针管理文件。在面板配置好本站探针和管理密钥即可发布，无需绑定游戏站点 ID。已有 feed 部署升级时显式改为 agent 并重启；无探针站点可保留 feed。完整步骤见[公告接入](ANNOUNCEMENTS.md)。

联机断线保留席位 10 分钟；单人对局可在断线后 24 小时内恢复。

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
  -e SP_MODERATION_KEY_FILE=/run/secrets/moderation.key \
  -v /etc/stronghold/moderation.key:/run/secrets/moderation.key:ro \
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
2. `curl -s http://127.0.0.1:3000/api/announcement`：`source.mode` 为 `agent`（无探针 feed 站点为 `panel`）；在面板发布后确认正文生效。
3. 浏览器打开游戏，创建并加入房间；确认 WebSocket 正常连接，刷新后可重连。
4. CDN 模式检查图片和音频请求带 `?v=`；预载窗口可导入资源包并显示结果。

## 排错与调优

| 现象 | 检查 |
|---|---|
| 端口占用 | 是否重复启动了 systemd、计划任务或手动进程；先停止重复进程 |
| 画面或声音缺失 | `node tools/doctor.mjs`；CDN 模式核对清单和资源 URL，本机模式补跑 setup |
| 面板已发布，游戏无公告 | 核对 `/api/announcement.source`、探针推送状态、文件路径和日志 `[announcement]`；见[公告排错](ANNOUNCEMENTS.md#排错) |
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

## 昵称审查

点击“开始”后，浏览器先向同源 `POST /api/nickname/validate` 提交 `{"name":"博士代号"}`，服务器通过才保存昵称并进入游戏。拒绝只回固定错误码，客户端显示“代号包含不适宜内容，请更换昵称”，并提示“如果你认为昵称没有问题，可以前往 GitHub 反馈”，提供本站仓库的 Bug 反馈链接；网络失败停留标题页，可重试。WebSocket `hello` 在创建会话、重连接管和改名前再次检查，不能靠跳过 HTTP 预检绕过。

词库来自 [konsheng/Sensitive-lexicon](https://github.com/konsheng/Sensitive-lexicon)，固定版本 `d967c30b053fa40b06c5a0dddf0be493f2dfae46` 的 17 份 `Vocabulary/*.txt` 与本站补充规则，已在部署前归一化、筛选、排序并去重，整合为唯一有效词表。42,812 条词先 gzip 压缩，再使用 AES-256-GCM 加密为 `server/moderation/lexicon/words.enc`；文件包含版本、随机 nonce、认证标签和密文，密钥独立保管。服务端启动时仅在内存中解密一次，再编译原有字典树及片段集合；每次昵称和聊天审核不进行解密，也不请求外部服务。空词、单字、超过昵称长度的词和已确认误伤的普通称呼、食物、游戏用语等词条在整合时排除（按完整词条删除，违规长词仍独立保留）；筛选记录、上游原始文件摘要及合并文件摘要见同目录 `SOURCE.json`，完整 MIT 许可证见 `LICENSE`。英文及纯数字按完整片段匹配，全角、零宽、大小写及插入符号在比较时归一化。词表仍可能误伤，按实际反馈维护规则。

**密钥部署（升级前必须完成）**：本次迁移生成的随机密钥只保存在开发机 `.state/moderation.key`，不随 Git、发行包或镜像分发。把同一份密钥通过私有渠道复制到每台服务器，例如 `/etc/stronghold/moderation.key`，赋予游戏运行账号只读权限（如 `root:stronghold`、`0640`），并在环境文件中设置 `SP_MODERATION_KEY_FILE=/etc/stronghold/moderation.key`。也可将 64 位十六进制值配置到 `SP_MODERATION_KEY`，该变量优先于密钥文件；默认读取项目根目录 `.state/moderation.key`。不要在服务器重新生成密钥：随机新密钥无法解开现有词表。缺少密钥、密钥错误或词表损坏会阻止启动，不会降级为不审核。密钥需纳入私有备份；不要提交、输出到日志或放入公开静态目录。Docker 需要只读挂载密钥文件，并设置容器内的 `SP_MODERATION_KEY_FILE`。

**仅服务端持有词库**：不放入 `shared/`、`data/`、`public/`、`server/sim/`、浏览器资源包或 CDN，不开放下载、列举或命中详情接口。维护规则时在仓库外编辑 UTF-8 文本（每行一个字面词，不支持正则，`#` 开头为注释），在已配置密钥的环境中运行 `node tools/encrypt-lexicon.mjs /私有路径/words.txt server/moderation/lexicon/words.enc`。同步 `SOURCE.json` 的词数、密文 SHA-256 与 `decodedSha256`，保留许可证并重启服务；只提交密文，不提交密钥和源明文。公开 CI 使用显式测试预加载器 `node --import ./test/helpers/moderation-fixture.js --test`，在未配置真实密钥时创建独立的小型测试词表，不需要生产密钥；正常启动不加载测试词表。HTTP 预检按网络限流，与房间状态接口预算分离。

加密保护的是当前文件，无法收回之前已公开的明文或 Base64 版本。旧 Git 历史、远程平台缓存及已有克隆需分别处理；密钥泄漏后应重新加密并更换部署密钥。公开上游词库本身仍可独立获取。

**反向代理**：`/api/nickname/validate` 必须转发到游戏 Node，并关闭缓存。在同机 `/api/` 已转发给 sp-portal 的部署中，增加 `location = /api/nickname/validate` 精确规则（参照 `scripts/nginx.conf.example`），避免被面板路由接走。不要用仓库根目录作为静态站点根目录。

标题页提交后显示校验结果；服务端在首次 hello、重复 hello 改名和令牌重连时最终检查，拒绝发生在创建或接管会话之前。旧保存昵称命中词表时回到标题页修改。新增规则不会主动踢出正在游戏中的玩家；其下次登录或重连按新规则校验。

### 局内聊天

默认关闭。设置环境变量 `SP_CHAT_ENABLED=on` 开启，`SP_CHAT_ENABLED=off` 关闭，未设置时也关闭；修改后重启游戏服务。各服务器独立配置。关闭时隐藏整个聊天区域，「交流」恢复为紧凑的纯表情面板，不保留输入框、提示或空白占位；服务端也拒绝聊天发送请求。

局内工具栏点击「交流」，同一面板上方输入聊天，下方选择表情；关闭面板保留草稿，发送成功后自动收起。关闭聊天功能时仍保留表情面板。经服务端屏蔽的文字显示在发送者头像右侧，与表情共用弹出和淡出动画、显示时长（默认约 3 秒）；同一玩家新文字或表情替换上一条，其他玩家互不影响。重连同步的历史不会重新弹出气泡。

每条消息最多 30 个 Unicode 字符，至少间隔 1 秒。服务端使用启动时已解密的私有词表审查，只广播替换为星号后的内容，局内最多保留 50 条；观战者只读。使用滚动 10 分钟窗口统计命中的消息数，正常消息不清零；窗口内累计 5 条命中后按玩家会话身份禁言 12 小时，刷新、重连、换房不清除累计记录或解除禁言。旧版未记录命中时间戳，升级后累计窗口从新记录开始，已有禁言保留。配置 `SP_STATE_FILE` 后禁言随会话保存并恢复，关闭状态保存时重启会丢失。当前没有登录账号，清除身份或换浏览器仍可获得新身份。

开启聊天后，服务端自动记录每条成功发送的**原始消息**（敏感词替换前，保留原有空格），包括第五条触发禁言的消息。默认写入仓库下 `.state/chat-logs/YYYY-MM-DD.jsonl`，文件日期和记录时间均为 UTC；重启后继续追加，每天单独一份，不自动删除历史。每行是一个 JSON 对象，字段为 `at`（ISO 时间）、`ip`、`playerId`、`name`（昵称）、`roomCode` 和 `text`（原文）。昵称和 IP 使用服务端确认的信息，IP 沿用 `TRUST_PROXY` 的连接解析规则，不采信聊天消息自带的身份字段。超长、频繁、禁言期间、观战者和关闭聊天时被拒绝的消息不落盘；重连历史同步不会重复记录。

可通过 `SP_CHAT_LOG_DIR=/var/lib/stronghold/chat-logs` 指定私有日志目录；修改后重启。目录不得位于 `public/`、`data/`、`shared/` 或内容包的公开目录内，目录链接也会检查。默认 `.state/` 已排除在 Git、发行包和 Docker 构建内容之外；容器需要挂载持久卷来保留日志。日志只在服务端本地保存，没有下载接口，客户端广播、房间历史和存档中仍只保留替换后的消息，不增加玩家 IP。写入异步排队且内存有上限；正常停服等待写完，磁盘或权限错误会在服务端错误日志中提示，不打断对局。
