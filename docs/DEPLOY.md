# 部署指南

目标：在一台家用 Windows 小主机上长期开服，让朋友通过局域网或公网来玩。macOS / Linux / Docker 放在后面。
所有命令都在项目根目录执行。遇到问题先运行 `node tools/doctor.mjs`（只读诊断）。

## 0. 资源需求

| 项目 | 说明 |
|---|---|
| 服务器 CPU | 战斗在各玩家浏览器里模拟（DESIGN §14），服务器只负责回合、经济和校验。AI 预演、AI / 掉线玩家的普通与联防战场及结果复算默认使用 worker 线程池；作战开始时 3 个 AI 战场在开发机上约 0.2–0.5 s CPU，小主机上可能要几秒。关闭线程池或线程失败时，必要计算回退到 8 ms 分片。`SP_VERIFY=all` 会复算每个真人战场，CPU 明显增加。 |
| 服务器内存 | 空闲约 100 MB，每个进行中的对局再增加几 MB；运行后的 worker 线程还会各自持有游戏数据和模拟引擎，内存随线程数增加。 |
| 网络 | 4 人对局中服务器每回合下行约 0.25 MB（DESIGN §14 实测）。首次进入游戏时浏览器要从主机下载所需的图片 / Spine 模型 / 音频（按需加载，之后走浏览器缓存），公网隧道带宽小时第一次会慢一些。 |
| 磁盘 | 素材约 270 MB（`public/assets`）+ 依赖约 125 MB（`node_modules`）；可选的本地提取约 40 MB（`.venv-extract`）+ 70 MB 贴图（见第 6 节）。 |
| 玩家设备 | 支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版），电脑或手机平板（横屏）。老旧设备可在设置里调低画质或访问 `/?board=2d`。 |

服务器**无状态**：房间和对局只存在内存里，没有数据库和存档，**不需要备份**。重启服务器会结束正在进行的对局（包括断线后本可在 24 小时内回来继续的独立模拟）。

WebSocket 默认开启低等级 `permessage-deflate` 压缩，客户端不支持时仍可正常连接。配置固定为 level 1、memLevel 7、12-bit 服务端窗口、不复用跨消息字典、服务端只压缩至少 1024 字节的消息，zlib 并发上限为 4；消息内容和广播频率保持不变。真实对局消息的本地回放中，该配置减少约 78% WebSocket 下行字节，实际收益取决于对局和消息分布。

压缩会增加 CPU 和每连接内存，尤其在 Linux 高并发时应先用少量房间验证：对比相近在线人数下的出网、CPU、RSS、延迟与断线情况。需要关闭时，在启动服务器前设置 `SP_WS_COMPRESSION=off`（PowerShell：`$env:SP_WS_COMPRESSION='off'`），再按原方式启动；重新开启设为 `on`。开关在启动时读取，修改需重启并结束存量对局，建议先等待对局清空。`1` / `true` 与 `on` 等价，`0` / `false` 与 `off` 等价；其他非空值会报错，避免拼写错误导致意外配置。

Bot 布局预演、普通 / 联防战场的无画面模拟（包括掉线接管）和客户端结果校验默认使用同一个 worker 线程池。共享领袖血量的战场仍在主线程按实时节奏运行；`SP_COMBAT=server` 的旧式快照流也保留原方式。线程按需启动并复用，队列满、超时或线程崩溃时，必要计算回退到本地分片；抽样校验在饱和时跳过。Bot 默认仍预演 3 个布局，worker 不减少 AI 候选数。

| 环境变量 | 默认 / 范围 | 用途 |
|---|---|---|
| `SP_WORKERS` | 可用逻辑核心数减 2，最少 1、最多 8；配置范围 0–32 | 模拟线程数；0 关闭线程池。 |
| `SP_WORKER_QUEUE` | 256；0–10000 | 等待任务上限，不含运行中的任务。 |
| `SP_WORKER_TIMEOUT_MS` | 120000；1–3600000 | 单任务超时，包含排队时间。 |
| `SP_BOT_REHEARSAL` | 3；0–8 | Bot 预演布局数；0 使用启发式摆阵。降低此值会影响 AI 质量。 |

例如在 PowerShell 启动前设置 `$env:SP_WORKERS='2'`，然后 `npm start`。这些设置需重启生效；内存较紧张的部署可减少线程数。`/healthz.workers` 报告运行中线程、排队数、完成 / 失败 / 取消 / 拒绝计数和 `avgComputeMs`（成功任务占用线程的平均毫秒数，包含首次线程启动，排队另计）。复现本机基准：`node tools/workerbench.mjs --workers 4 --battles 24`，详情见 [PERFORMANCE.md](PERFORMANCE.md)。

## 1. Windows 小主机：一步步

### 1.1 安装与首次启动

1. 安装 Node.js 22 LTS 和 Git（在 PowerShell 或「终端」里；用下面的完整包时不需要 Git）：
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   装完**关闭并重新打开**终端，`node -v` 应显示 v22 或更高（winget 的 LTS 目前是 v24.x，同样可用）。没有 winget 时从 <https://nodejs.org/zh-cn/download> 和 <https://git-scm.com/download/win> 下载安装。
2. 下载，二选一。建议放在一个固定、短、**不在 OneDrive 同步范围内**的目录，例如 `C:\Stronghold-Protocol`：
   - **完整包（推荐）**：在仓库的 [Releases](https://github.com/sganggs/Stronghold-Protocol/releases) 页面下载最新版本（当前为 v0.1.2）的完整包 zip（已含依赖、前端库和全部素材，包括官方 3D 棋盘），解压后把里面的 `Stronghold-Protocol` 文件夹放到上述位置。不需要 Git，首次启动也不用再下载素材。素材版权归上海鹰角网络 / Yostar，仅限非商业使用，见 [NOTICE.md](../NOTICE.md)。
   - **源码**：
     ```powershell
     git clone https://github.com/sganggs/Stronghold-Protocol.git C:\Stronghold-Protocol
     ```
3. 双击 `C:\Stronghold-Protocol\scripts\start-windows.bat`。首次会：安装依赖（`npm ci`；完整包已含，跳过）→ 复制前端库 → 下载约 270 MB 素材（完整包已含，跳过；显示进度，中断后再次启动会续传）→ 若检测到本机的明日方舟客户端，询问是否提取官方贴图（可跳过）→ 启动服务器并打开浏览器。
4. 窗口里会打印朋友可用的地址，例如 `http://192.168.1.23:3000`。用另一台设备打开它确认能进入。关闭窗口即停止服务器。

等价的手动命令：`npm ci`、`node tools/setup.mjs`、`npm start`。

### 1.2 防火墙

- 第一次启动时 Windows 会弹出「Windows 安全中心警报」：勾选**专用网络**并点「允许访问」。
- 没弹窗或点错了，用**管理员** PowerShell 添加规则（下面的开机自启脚本也会自动添加）：
  ```powershell
  netsh advfirewall firewall add rule name="Stronghold Protocol" dir=in action=allow protocol=TCP localport=3000 profile=private,domain
  ```
- 家里的网络要是「公用网络」，Windows 会拦截入站连接。改成专用（管理员 PowerShell；网卡名用 `Get-NetConnectionProfile` 查看）：
  ```powershell
  Set-NetConnectionProfile -InterfaceAlias "以太网" -NetworkCategory Private
  ```
- `node tools/doctor.mjs` 会显示规则是否存在、每个网络的类型，以及朋友可用的地址。

### 1.3 固定局域网 IP（推荐）

主机 IP 变了，朋友收藏的地址就失效。推荐在**路由器**后台的「DHCP 静态分配 / 地址保留」里把小主机的 MAC 地址绑定到固定 IP（如 `192.168.1.50`）。也可以在 Windows「设置 → 网络和 Internet → 属性 → IP 分配 → 编辑」里手动设置（IP、子网掩码、网关、DNS 与路由器一致，且不要与别的设备冲突）。

### 1.4 开机自动在后台运行

先关闭 `start-windows.bat` 的窗口（否则端口冲突），然后在项目目录运行（会自动请求管理员权限）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1
```

它会：运行一次 `tools/setup.mjs` → 把设置写入 `scripts\service.env.cmd`（node.exe 路径、端口等）→ 注册计划任务 **StrongholdProtocol**（开机 20 秒后以 SYSTEM 身份运行 `scripts\run-server.cmd`，无需登录；服务器退出后 5 秒自动重启）→ 添加防火墙规则 → 立即启动并显示状态。日志在 `logs\server.log`（超过 10 MB 自动轮换）。

| 需求 | 命令（都加在 `powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1` 之后） |
|---|---|
| 换端口 / 其他设置 | `-Port 8080`、`-Verify sample`、`-Combat server`、`-BindHost 127.0.0.1`（只给反向代理用） |
| 公用网络也放行 | `-AllowPublicNetwork`（一般不需要；Tailscale 网卡被识别为公用网络时可能需要） |
| 查看状态和最近日志 | `-Status` |
| 重启（更新代码后） | `-Restart` |
| 停止 | `-Stop`（下次开机仍会自动启动） |
| 卸载 | `-Uninstall`（删除计划任务、防火墙规则和 `service.env.cmd`） |

建议同时关闭睡眠，否则小主机会在无人操作时休眠：`powercfg /change standby-timeout-ac 0`。

<details>
<summary>替代方案：用 NSSM 注册成真正的 Windows 服务</summary>

```powershell
winget install NSSM.NSSM            # 或从 https://nssm.cc 下载
nssm install StrongholdProtocol "C:\Program Files\nodejs\node.exe" server\index.js
nssm set StrongholdProtocol AppDirectory C:\Stronghold-Protocol
nssm set StrongholdProtocol AppEnvironmentExtra PORT=3000 HOST=0.0.0.0
nssm set StrongholdProtocol AppStdout C:\Stronghold-Protocol\logs\server.log
nssm set StrongholdProtocol AppStderr C:\Stronghold-Protocol\logs\server.log
nssm start StrongholdProtocol
```

防火墙规则仍需按 1.2 手动添加。两种方式只选一种。
</details>

### 1.5 更新

```powershell
cd C:\Stronghold-Protocol
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Stop   # 装了开机自启时
git checkout -- data/assets.json    # 素材清单由 setup 重新生成，先还原以免 git pull 冲突
git pull
npm ci
node tools/setup.mjs                # 补下载新增的素材（已有文件会跳过）
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Restart
```

没装开机自启的话，最后一步改成重新双击 `start-windows.bat`。用 Releases 完整包的：停止服务器，把新版本的完整包解压到新目录后从那里启动即可（素材已包含；装了开机自启的，在新目录重新运行一次 `install-service-windows.ps1`）。用 GitHub「Download ZIP」源码包的：解压新版本后，把旧目录里的 `public\assets`、`public\fonts`、`.cache` 和 `data\local-assets.json`（若有）复制过去，可避免重新下载。

资源 URL 自动带版本前缀（`/_v/<版本>/…`）：脚本、样式、游戏数据及其模块依赖按发布版本缓存一年；图片、Spine、字体、音频使用独立的素材版本，单纯更新代码不会让浏览器重新下载未改变的素材。HTML 保持 `no-cache`，刷新即可取得当前版本；旧页面发现版本变化时沿用局内更新提示，局内不会自动刷新。无需手动修改素材清单或给 URL 拼 `?v=`。

版本在进程启动时计算：代码和 JSON 按内容，大型二进制素材按路径、大小和修改时间。更新代码、下载素材、复制本地素材后都要重启服务器；不要在保留二进制文件大小和修改时间的同时替换内容。运行中改动的版本资源返回不缓存的 503，避免把新内容写进旧版本的长期缓存。反向代理需把 `/_v/` 原样交给 Node；不要对首页和 API 强制设置长期缓存。

国内站可保留原 DNS，让素材使用香港站的 Cloudflare 缓存：设置 `SP_ASSETS_CDN=https://game.misyra.com`（不含 `/play`）。香港站须先启用素材跨域响应；两站版本缓存上线后，可用 `SP_ASSETS_CDN_VERSION` 指定香港站的 `artVersion`。完整步骤、nginx 片段与缓存规则见 [CDN.md](CDN.md)。

### 1.6 局内维护公告

复制项目根目录的 `announcement.example.json` 为 `announcement.json`（PowerShell：`Copy-Item announcement.example.json announcement.json`；Linux / macOS：`cp announcement.example.json announcement.json`），修改为：

```json
{
  "enabled": true,
  "title": "维护公告",
  "text": "服务器将于 17:00 开始维护，请提前结束模拟。",
  "expiresAt": "2026-10-04T17:00:00+08:00"
}
```

将示例日期替换为实际维护日期；`expiresAt` 必须包含时区，例如北京时间用 `+08:00`，UTC 用 `Z`。公告从配置生效起显示到该时刻，到期自动隐藏，不会触发停服、踢人或结束对局。`title` 可省略（默认「维护公告」），最多 80 个字符；`text` 为纯文本，支持换行，最多 2000 个字符，不解析 HTML。

局内（含开局简报、选羁绊和结算）显示带关闭按钮的公告条，每 30 秒检查更新，回到浏览器标签页时立即检查。关闭后同一浏览器记住当前公告，不因刷新或开始下一局重复出现；修改标题、正文或截止时间会作为新公告再次显示。浏览器禁用本地存储时，关闭状态只在本次页面内保留。

服务器最多每秒读取一次文件，多个玩家共享读取结果；保存完成后，局内通常在 31 秒内看到更新，无需重启服务器。立即撤下可设为 `{"enabled": false}`，或删除配置文件；文件缺失、无效或超过 16 KiB 时不显示公告，无效配置会记录警告。建议先写临时文件再重命名覆盖，避免保存到一半时被读取。

配置文件放在项目根目录，不在 `public/` / `data/` 下，且已被 Git 忽略；可通过 `SP_ANNOUNCEMENT_FILE` 指定其他服务器本地路径（相对路径以项目根目录为基准）。`GET /api/announcement` 返回当前公告和服务器时间，响应不缓存；这是只读接口，发布和修改只能通过本地配置文件完成，无需管理页面或管理令牌。使用 nginx 时，保持该 API 代理到 Node，避免配置静态缓存。

## 2. 让不在同一网络的朋友加入

### 2.1 Tailscale / ZeroTier（推荐给家用小主机）

组一个虚拟局域网：不需要公网 IP、不需要改路由器、不暴露到互联网。

- **Tailscale**：主机和朋友都安装 <https://tailscale.com/download>（Windows：`winget install Tailscale.Tailscale`）并登录。朋友用自己的账号时，在 Tailscale 管理后台把这台主机「Share」给他们，或邀请他们加入你的 tailnet。朋友访问 `http://<主机的 100.x.y.z 地址>:3000`（`tailscale ip -4` 查看；开了 MagicDNS 也可以用 `http://<主机名>:3000`）。
- **ZeroTier**：在 <https://my.zerotier.com> 创建网络，主机和朋友安装客户端并加入同一个 Network ID，在后台勾选授权成员；访问 `http://<主机的 ZeroTier IP>:3000`。
- 连不上时运行 `node tools/doctor.mjs`：看 VPN 网卡是否被 Windows 识别为「公用网络」，是的话按 1.2 改为专用，或安装自启时加 `-AllowPublicNetwork`。

### 2.2 cloudflared 临时隧道（朋友什么都不用装）

```powershell
winget install --id Cloudflare.cloudflared      # macOS: brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

把输出的 `https://xxxx.trycloudflare.com` 发给朋友。页面是 https 时客户端自动改用 `wss://`，不需要任何配置；服务器会通过隧道转发的 `CF-Connecting-IP` 识别真实来源（`TRUST_PROXY=auto`）。临时隧道每次启动地址都不同，且没有可用性保证；需要固定地址请使用 Cloudflare 账号 + 自己域名的「命名隧道」。

### 2.3 路由器端口转发

仅当你有**公网 IPv4**（很多宽带是运营商级 NAT，没有公网 IP，此时请用 2.1 / 2.2）：

1. 先按 1.3 固定主机的局域网 IP。
2. 路由器「虚拟服务器 / 端口转发」：外部端口 3000（或任意端口）→ 内部 `主机IP:3000`，TCP。
3. 朋友访问 `http://<你的公网 IP>:外部端口`。

注意：游戏没有账号系统，知道地址的人都能进来。服务器对来自互联网的连接有按网络的数量限制（每个网络最多 64 个连接，房间 / 对局数量也有上限），但仍建议不玩时关掉转发，或优先用 Tailscale。

### 2.4 反向代理与 HTTPS（有域名时）

必须部署在**域名根路径**（客户端使用 `/data/`、`/vendor/`、`/ws` 等绝对路径，不支持挂在子路径下）。代理需要转发 WebSocket 升级（路径 `/ws`）。建议让服务器只监听本机：`HOST=127.0.0.1`（Windows 自启：`-BindHost 127.0.0.1`）。

**Caddy**（自动申请 HTTPS 证书，WebSocket 无需额外配置）：

```caddy
game.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**：

完整主配置模板见 [`scripts/nginx.conf.example`](../scripts/nginx.conf.example)，默认使用 `worker_processes auto;`，按可用 CPU 核心数选择 worker 数。首次部署时修改模板中的域名和证书路径；已有 nginx 的，在现有 `/etc/nginx/nginx.conf` 顶层将 `worker_processes` 设为 `auto`，保留已有站点配置：

```nginx
worker_processes auto;
```

该指令必须位于 `http`、`server`、`events` 块之外，不能放进通常在 `http` 中加载的 `conf.d` / `sites-enabled` 站点文件。修改后运行 `sudo nginx -t && sudo nginx -s reload`，检查成功后平滑重载，无需重启 Node 服务。这只使 nginx 使用多个 worker，不改变 Node 的游戏计算方式。指令说明见 [nginx 官方文档](https://nginx.org/en/docs/ngx_core_module.html#worker_processes)。

下面是站点配置，放在 `http` 块内（或其中加载的站点文件）：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 443 ssl;
    server_name game.example.com;
    ssl_certificate     /etc/letsencrypt/live/game.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;      # WebSocket 长连接
    }
}
```

https / wss 说明：页面通过 https 打开时客户端自动连接 `wss://同一域名/ws`；http 时用 `ws://`。服务器本身只提供 http，证书由代理 / 隧道负责。代理与服务器在同一台机器或内网时，`TRUST_PROXY=auto` 会信任它的 `X-Forwarded-For` / `X-Real-IP`；代理在公网另一台机器上时设 `TRUST_PROXY=1`（同时确保游戏端口只对代理开放）。

## 3. Docker

```bash
# A) 构建时下载素材（需要联网，约 250 MB）
docker build -t stronghold-protocol --build-arg FETCH_ASSETS=1 .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped stronghold-protocol

# B) 不把素材打进镜像：先在宿主机运行 node tools/setup.mjs，然后挂载
docker build -t stronghold-protocol .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v "$PWD/public/assets:/app/public/assets:ro" stronghold-protocol
```

镜像基于 `node:22-alpine`，多阶段构建，只含生产依赖；`public/vendor` 在构建时生成。`.dockerignore` 排除了 `public/assets`（不会把宿主机素材打进构建上下文）；`public/fonts`、`data/assets.json` 和 `data/local-assets.json` 若存在会被复制进去。环境变量同 README（`-e SP_VERIFY=sample` 等）。健康检查：`GET /healthz`。

docker compose 示例：

```yaml
services:
  stronghold:
    build:
      context: .
      args: { FETCH_ASSETS: "1" }
    ports: ["3000:3000"]
    restart: unless-stopped
    environment:
      SP_VERIFY: "off"
```

## 4. macOS / Linux 常驻

- 临时开服：`scripts/start.sh`（或 `npm start`），保持终端窗口打开。macOS 首次会询问是否允许 node 接受传入连接，选「允许」。
- Linux systemd（`/etc/systemd/system/stronghold.service`，路径与用户按实际修改）：

  ```ini
  [Unit]
  Description=Stronghold Protocol game server
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/opt/Stronghold-Protocol
  ExecStart=/usr/bin/node server/index.js
  Environment=PORT=3000 HOST=0.0.0.0
  Restart=always
  RestartSec=5
  User=stronghold

  [Install]
  WantedBy=multi-user.target
  ```

  `sudo systemctl daemon-reload && sudo systemctl enable --now stronghold`；日志 `journalctl -u stronghold -f`；防火墙 `sudo ufw allow 3000/tcp`。

## 5. 排错

| 现象 | 处理 |
|---|---|
| 任何问题 | `node tools/doctor.mjs`：Node 版本、依赖、素材完整性、端口、局域网地址、防火墙、网络类型 |
| `端口已被占用 / EADDRINUSE` | 已经有一个服务器在运行（自启任务？）或其他程序占用 3000：换端口 `scripts\start-windows.bat --port 3001` |
| 朋友打不开页面 | 防火墙规则 / 网络类型（1.2）；确认用的是 `LAN` 地址而不是 `localhost`；访客 Wi-Fi 常开启「AP 隔离」；不在同一网络请看第 2 节 |
| 画面是占位图、没有声音 | 素材没下完：重新运行 `node tools/setup.mjs`（会续传）；缺失明细在 `.cache/assets-report.json`。GitHub 原始地址访问失败时会自动改用 jsDelivr 镜像 |
| 素材下载很慢 / 失败 | 网络问题可随时中断，重新运行会跳过已完成的文件；`node tools/fetch-assets.mjs --concurrency=4` 降低并发。有文件没下载成功时，素材清单 `data/assets.json` 保持不变（脚本列出缺少的条目并以非零状态结束；游戏里缺的图片用占位图，缺的声音不播放），重新运行即可补齐 |
| 表情显示成默认图标、「玩法说明」只有文字要点 | 素材没下载完整：重新运行 `node tools/setup.mjs`（表情和教程图随其他素材一起从公开镜像下载，不需要客户端）；缺失明细在 `.cache/assets-report.json` |
| 本地提取失败 | 游戏照常运行，只是第 6 节表格里的几样换成替代样式。确认客户端已下载全部资源；Python 版本太新导致依赖安装失败时，安装 Python 3.12 后删除 `.venv-extract` 再运行 `node tools/setup.mjs --local` |
| 3D 棋盘没出现 | 需要本地提取的棋盘贴图（`node tools/doctor.mjs` 会显示「3D 棋盘可用」），以及支持 WebGL2 的浏览器。没有客户端的服务器可以从同一版本的整合包复制本地素材（第 6 节） |
| 断线 | 同盟模拟 10 分钟内、独立模拟 24 小时内（`config.constants.singleReconnectTime`）用同一浏览器重新打开页面，自动回到原座位。同盟掉线期间按原阵容自动作战、到时自动准备（不会代为购买；想让 AI 代打请用「离开模拟 → 暂离（AI 托管）」）；独立模拟不计时，等你回来 |

## 6. 本地客户端素材（可选）

`public/assets/local/` 和 `data/local-assets.json` 是从本机安装的《明日方舟》客户端里提取的官方素材（`tools/local-extract`，DESIGN §13）：`node tools/setup.mjs` 检测到客户端时会询问是否提取，之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<…/StreamingAssets/AB/Windows>"` 指定客户端目录。setup 从公开镜像下载的素材不包含这部分，所以在没有客户端的电脑上（例如 Linux 服务器）从源码部署时不会有它；Releases 的完整包里已经带上了。

没有本地素材时游戏照常运行，只是下面几样换成替代样式：

| 内容 | 没有本地素材时 |
|---|---|
| 官方 3D 棋盘（贴图、模型、地图特效） | 2D 棋盘，地块由程序绘制 |
| 部分官方界面图标与底板：交流按钮和表情面板的边框、暂停面板、装备替换窗口、干员调配界面、队友状态与漏怪标记、模组类型图标等 | 样式相近的替代图形、图标或文字 |
| 灼热 / 炽焰源石虫的官方模型 | 染成橙色 / 红橙色的普通源石虫 |

表情（6 套 × 6 个）和「玩法说明」的 19 页教程图公开镜像也有：`node tools/setup.mjs` 会和其他素材一起下载（约 21 MB），不需要客户端；有本地素材时优先显示本地的。

**没有客户端的服务器**想要上表中的官方素材：从**同一版本**的完整包（[Releases](https://github.com/sganggs/Stronghold-Protocol/releases)）里，把 `public/assets/local/` 文件夹和 `data/local-assets.json` 复制到服务器项目目录下的相同位置。复制后重启服务器，让资源版本更新，玩家刷新页面即可。一定要用与服务器代码相同版本的完整包：各版本提取的内容和清单可能不同（例如灼热 / 炽焰源石虫的模型是 0.1.0 之后才加入的），混用其他版本的文件会缺图或用错图。复制后 `node tools/doctor.mjs` 会显示本地素材的条目数和「3D 棋盘可用」。
