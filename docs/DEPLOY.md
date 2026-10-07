# 部署指南

目标：在一台家用 Windows 小主机上长期开服，让朋友通过局域网或公网来玩。macOS / Linux / Docker 放在后面。
所有命令都在项目根目录执行。遇到问题先运行 `node tools/doctor.mjs`（只读诊断）。

## 0. 资源需求

| 项目 | 说明 |
|---|---|
| 服务器 CPU | 战斗在各玩家浏览器里模拟（DESIGN §14），服务器只负责回合、经济和校验。AI 预演、AI / 掉线玩家的普通与联防战场及结果复算默认使用 worker 线程池；作战开始时 3 个 AI 战场在开发机上约 0.2–0.5 s CPU，小主机上可能要几秒。关闭线程池或线程失败时，必要计算回退到 8 ms 分片。`SP_VERIFY=all` 会复算每个真人战场，CPU 明显增加。 |
| 服务器内存 | 空闲约 100 MB，每个进行中的对局再增加几 MB；运行后的 worker 线程还会各自持有游戏数据和模拟引擎，内存随线程数增加。 |
| 网络 | 4 人对局中服务器每回合下行约 0.25 MB（DESIGN §14 实测）。首次进入游戏时浏览器要从主机下载所需的图片 / Spine 模型 / 音频（按需加载，之后走浏览器缓存），公网隧道带宽小时第一次会慢一些。 |
| 磁盘 | 素材约 460 MB（`public/assets`）+ 依赖约 125 MB（`node_modules`；整合包只带运行依赖，约 65 MB）；可选的本地提取约 40 MB（`.venv-extract`）+ 70 MB 贴图（见第 6 节）。完整包解压后约 625 MB。 |
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

1. 安装 Node.js 22 LTS 和 Git（在 PowerShell 或「终端」里；用下面的整合包时不需要 Git）：
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   装完**关闭并重新打开**终端，`node -v` 应显示 v22 或更高（winget 的 LTS 目前是 v24.x，同样可用）。没有 winget 时从 <https://nodejs.org/zh-cn/download> 和 <https://git-scm.com/download/win> 下载安装。
2. 下载，三选一。建议放在一个固定、短、**不在 OneDrive 同步范围内**的目录，例如 `C:\Stronghold-Protocol`：
   - **完整包（推荐）**：在仓库的 [Releases](https://github.com/sganggs/Stronghold-Protocol/releases) 页面下载最新版本的 `Stronghold-Protocol-v<版本>.zip`（约 430 MB，解压后约 625 MB；已含运行依赖、前端库和全部素材，包括官方 3D 棋盘等本地客户端素材），解压后把里面的 `Stronghold-Protocol` 文件夹放到上述位置。不需要 Git，首次启动也不用再下载素材。素材版权归上海鹰角网络 / Yostar，仅限非商业使用，见 [NOTICE.md](../NOTICE.md)。
   - **精简包**：同一页面的 `Stronghold-Protocol-v<版本>-lite.zip`（约 22 MB）。代码、运行依赖和前端库与完整包相同，但不带素材：美术、Spine 模型、音频、字体、表情和「玩法说明」教程图在首次启动时由 setup 从公开镜像下载（约 460 MB，显示进度，可中断续传；镜像设置见下面的「国内镜像下载」）。官方 3D 棋盘等本地客户端素材需要用本机客户端提取，或从同一版本的完整包复制（第 6 节）。适合下载大文件不方便、或想先下一个小包的情况；放置方式同完整包。
   - **源码**：
     ```powershell
     git clone https://github.com/sganggs/Stronghold-Protocol.git C:\Stronghold-Protocol
     ```
3. 双击 `C:\Stronghold-Protocol\scripts\start-windows.bat`。首次会：安装依赖（`npm ci`；整合包已含，跳过）→ 复制前端库（整合包已含，跳过）→ 下载约 460 MB 素材（完整包已含，跳过；精简包和源码在这一步下载，显示进度，中断后再次启动会续传）→ 若检测到本机的明日方舟客户端，询问是否提取官方贴图（可跳过）→ 启动服务器并打开浏览器。
4. 窗口里会打印朋友可用的地址，例如 `http://192.168.1.23:3000`。用另一台设备打开它确认能进入。关闭窗口即停止服务器。

等价的手动命令：`npm ci`、`node tools/setup.mjs`、`npm start`。

#### 国内镜像下载

Setup 默认使用「GitHub 原始源 → jsDelivr」，不查询公网 IP，也不请求 gh-proxy.com。GitHub 下载失败时会提示如何手动开启镜像；仅添加提示，不自动切换到第三方代理。

镜像方法是在完整 GitHub 链接前加 `https://gh-proxy.com/`，例如：

```text
https://gh-proxy.com/https://raw.githubusercontent.com/OWNER/REPO/BRANCH/file.png
```

手动开启后顺序为「前缀镜像 → 原始源 → jsDelivr」。索引、图片、Spine、音频和字体都使用此规则（音频 voice 分支跳过 jsDelivr）。镜像是第三方代理；当前只校验格式和大小，没有内容哈希校验，请自行决定是否信任并启用。npm / pip 依赖不使用 GitHub 前缀。

```powershell
node tools/setup.mjs --asset-source=mirror  # 手动优先国内镜像
node tools/setup.mjs --asset-source=direct  # 默认：仅原始源和 jsDelivr，不使用前缀代理
$env:SP_ASSET_SOURCE = 'mirror'             # 也可用环境变量显式启用
```

`node tools/fetch-assets.mjs` 同样支持 `--asset-source=direct|mirror`。命令行优先于 `SP_ASSET_SOURCE`。默认镜像前缀为 `https://gh-proxy.com/`，可通过 `SP_GITHUB_PROXY` 指定其他 HTTPS 前缀；仅配置前缀不会启用镜像。将 `SP_GITHUB_PROXY` 设为空字符串（或全空格）可彻底禁用前缀代理，即使选择了 `mirror` 模式；未设置此变量与显式设空不同，前者使用默认前缀。Windows PowerShell 的某些版本会将空值视为删除变量，可设置 `$env:SP_GITHUB_PROXY = ' '` 或使用 `--asset-source=direct` 来明确禁用。前缀只处理 GitHub 下载链接，不重复添加。

镜像请求每个 URL 只尝试一次，响应头超时 8 秒，响应体有独立的空闲超时，失败即尝试原始源。连续 3 次网络错误、HTTP 错误或无效内容会在本次运行中关闭镜像，后续索引、素材和字体共享该状态；正在进行的镜像请求也会中止并回退。成功会清零连续失败次数；404 / 410 是资源不存在，不触发熔断。再次运行脚本会重新尝试手动启用的镜像。原始源的重试、已有文件跳过和 0.1.1 的清单缩减保护保持不变。

从历史下载记录派生的 Spine 补充贴图也按本次设置重新选择来源，禁用后不会沿用旧代理地址。

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

没装开机自启的话，最后一步改成重新双击 `start-windows.bat`。用 Releases 整合包的：停止服务器，把新版本的整合包解压到新目录后从那里启动即可（完整包已含素材；装了开机自启的，在新目录重新运行一次 `install-service-windows.ps1`）。用精简包或 GitHub「Download ZIP」源码包的：解压新版本后，把旧目录里的 `public\assets`、`public\fonts`、`.cache` 和 `data\local-assets.json`（若有）复制过去，可避免重新下载（setup 只补下新增的素材）。

资源 URL 自动带版本前缀（`/_v/<版本>/…`）：脚本、样式、游戏数据及其模块依赖按发布版本缓存一年；图片、Spine、字体、音频使用独立的素材版本，单纯更新代码不会让浏览器重新下载未改变的素材。HTML 保持 `no-cache`，刷新即可取得当前版本；旧页面发现版本变化时沿用局内更新提示，局内不会自动刷新。无需手动修改素材清单或给 URL 拼 `?v=`。

版本在进程启动时计算：代码和 JSON 按内容，大型二进制素材按路径、大小和修改时间。更新代码、下载素材、复制本地素材后都要重启服务器；不要在保留二进制文件大小和修改时间的同时替换内容。运行中改动的版本资源返回不缓存的 503，避免把新内容写进旧版本的长期缓存。反向代理需把 `/_v/` 原样交给 Node——它是 Node 按启动内容哈希解析的虚拟路径，磁盘上并不存在 `public/_v`，不能让代理用 `root` / `alias` 直出；不要对首页和 API 强制设置长期缓存。反代可以为 `/_v/` 加共享缓存降低 Node 的 CPU 与临时文件 I/O（未命中仍回源 Node，Node 始终是唯一权威），要点与坑位见下文 2.4 的「Nginx 运维备忘」。

素材也可以交给 CDN 承载（Cloudflare R2）：服务器只出代码、游戏数据、API 和 WebSocket，玩家加载图片 / Spine / 音频 / 字体走 CDN。启用步骤见下文 1.7；一次性配置与浏览器预载见 [CDN.md](CDN.md)。

### 1.6 维护公告

公告有两种来源，**二选一**：设置 `SP_ANNOUNCEMENT_URL` 的站点由运维面板统一发布（推荐多站部署时使用），否则使用本地配置文件。进入游戏后（主菜单、大厅、同盟与对局全程）显示带关闭按钮的公告条，每 30 秒检查更新，回到浏览器标签页时立即检查。关闭后同一浏览器记住当前公告，不因刷新或开始下一局重复出现；修改标题、正文或截止时间会作为新公告再次显示。浏览器禁用本地存储时，关闭状态只在本次页面内保留。

#### 方式一：运维面板统一发布（SP_ANNOUNCEMENT_URL）

在游戏服务器进程的环境里设置面板公告源地址（`<站id>` 是面板站点配置里的 id，例如 `shiyan` / `aliyun` / `hongkong`），然后重启游戏进程：

```ini
SP_ANNOUNCEMENT_URL=https://<中间页域名>/api/announce/v1/<站id>
# 可选：拉取间隔，默认 10 秒，允许 3 秒～10 分钟
# SP_ANNOUNCEMENT_POLL_MS=10000
```

服务器按间隔拉取该地址（无鉴权，只返回 `enabled` / `title` / `text` / `expiresAt` 白名单字段，字段格式与本地文件一致），拉到即热生效；拉取失败或响应非法时保留上一条有效公告，面板显式停用（`enabled: false`）立即撤下，到期自动隐藏，进程重启后重新拉取。**设置该变量后本地公告文件不再参与。** 拉取是纯出站请求，游戏服务器不需要开放任何入站端口或路由；面板 nginx 的 `/api/` 反代已覆盖公告 feed。

验证：在面板发布一条公告，约 10 秒内本站 `GET /api/announcement` 应返回该公告（面板该站的「线上生效」列从「无公告」变为公告标题）。

#### 方式二：本地配置文件（单机自用）

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

服务器最多每秒读取一次文件，多个玩家共享读取结果；保存完成后，玩家通常在 31 秒内看到更新，无需重启服务器。立即撤下可设为 `{"enabled": false}`，或删除配置文件；文件缺失、无效或超过 16 KiB 时不显示公告，无效配置会记录警告。建议先写临时文件再重命名覆盖，避免保存到一半时被读取。

配置文件放在项目根目录，不在 `public/` / `data/` 下，且已被 Git 忽略；可通过 `SP_ANNOUNCEMENT_FILE` 指定其他服务器本地路径（相对路径以项目根目录为基准）。

#### 公告接口与 nginx

两种来源下 `GET /api/announcement` 都只读，返回当前公告和服务器时间，Node 侧始终不缓存（`no-store`）。使用 nginx 时保持该 API 代理到 Node；如需减轻轮询压力，可为 `location = /api/announcement` 精确匹配加 5~10 秒的共享缓存（必须 `proxy_ignore_headers Cache-Control`），响应里的 `serverTime` 被客户端用于换算公告倒计时，TTL 越大偏差越大，不要超过 10 秒；`/api/` 其余端点保持不缓存。

### 1.7 素材 CDN（R2，可选）

美术（图片 / Spine / 音频 / 字体）可以放到 Cloudflare R2，由绑定的自定义域名经边缘缓存对外服务。游戏服务器设置一个环境变量即可启用：

```powershell
$env:SP_ASSETS_CDN = 'https://assets.example.com'
npm start        # 或写进服务管理器的环境配置
```

启用后素材 URL 形如 `https://assets.example.com/assets/…?v=<文件哈希>`：URL 由文件内容决定，内容不变则 URL 不变，浏览器、预载 Service Worker 与 CDN 边缘三层缓存永久命中；发布只让**变化过的文件**重新下载，外加一份约 200 KB 的清单。代码、游戏数据、API 与 WebSocket 仍由游戏服务器直出。

CDN 的发布清单（仓库根目录 `.assets-manifest.json`）由维护者在发布美术时用 `node tools/r2-sync.mjs --bucket <bucket> --push` 生成并提交：脚本只上传哈希变化的文件（几秒到几分钟），清单随 `git pull` 到达部署机，**不需要设置版本号**——清单不存在时自动回退为无版本 URL。更新流程与 1.5 相同：`git pull` → 重启（清单在启动时读取）。

验收约 30 秒：`/healthz` 出现 `"assetsManifest": "<16 位 tag>"`；浏览器 Network 面板中素材请求指向 CDN 域名且带 `?v=`，`/assets-manifest.json?v=<tag>` 每个版本只下载一次；`/js/`、`/api/`、`/ws` 仍指向游戏域名。

回滚：旧版「`.assets-cdn-version` + `_v/<tag>/` 快照」链路仍受支持，切回旧代码即恢复旧 URL 形状，无需清理 bucket。bucket、自定义域名、CORS 的一次性配置与浏览器预载见 [CDN.md](CDN.md)。

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
    listen 443 ssl http2;   # 新版 Nginx（1.25.1 起）写成 listen 443 ssl; 加一行 http2 on;
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

**HTTP/2**：客户端由数百个小脚本模块组成（0.2.0 起进入对局时约 340 个），隔着公网时建议让代理以 HTTP/2 提供页面：所有模块走同一条连接，远距离玩家首次进入对局明显更快。Caddy 默认就是 HTTP/2；Nginx 见上面的 `http2`。服务器本身只说 HTTP/1.1，局域网或本机游玩不受影响。

https / wss 说明：页面通过 https 打开时客户端自动连接 `wss://同一域名/ws`；http 时用 `ws://`。服务器本身只提供 http，证书由代理 / 隧道负责。代理与服务器在同一台机器或内网时，`TRUST_PROXY=auto` 会信任它的 `X-Forwarded-For` / `X-Real-IP`；代理在公网另一台机器上时设 `TRUST_PROXY=1`（同时确保游戏端口只对代理开放）。

**Nginx 运维备忘（2026-10-05 线上复核后沉淀，改配置前先读）**：

- `/_v/<tag>/` 是 Node 按启动时内容哈希解析的虚拟路径，磁盘上没有 `public/_v`：任何情况下都不能用 `root` / `alias` 直出，必须 `proxy_pass` 回 Node（模板里已有完整缓存块）。
- 为 `/_v/` 加 `proxy_cache` 时：只缓存 200/301/302——Node 对运行中被改动的版本资源返回**不缓存的 503**，把 404/503 加进 `proxy_cache_valid` 会让发布后一段时间出现幽灵错误页。nginx 不按 `Vary: Accept-Encoding` 自动分桶，缓存 key 必须并入编码维度（见模板的 `$sp_ae_key` map）。不要往 key 里加 `$request_method`：默认 `proxy_cache_convert_head on` 已让 HEAD 复用 GET 条目，加了反而各存一份（[官方文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_convert_head)：仅当关闭该转换时才应加）。Range 请求不会从缓存切片——206 是回源 Node 拿的、也不入缓存，属正常行为，不要试图缓存 206。location 内的 `add_header` 会屏蔽从 server 继承的所有 `add_header`，新增前先确认 server 块没有 server 级响应头。
- 这层缓存不减少出站带宽（字节仍由源站发出），只省 Node 的 CPU 与 `buffered to a temporary file` 临时文件 I/O。要降带宽只能让玩家走 CDN；而 CDN（`SP_ASSETS_CDN`）按设计只覆盖 `/assets`、`/fonts`、`/media` 美术路径（见 [CDN.md](CDN.md)），脚本与游戏数据的 `/_v/<release>/…` 始终由游戏主机直出。
- `/healthz` 即使加了短缓存也不是探活接口：有缓存就有陈旧语义（配了 `proxy_cache_use_stale` 时故障期间还会回放旧值）。外部监控判断死活要用其他端点或直连 Node 端口。删除云监控 / 云盾 agent 之前先备好替代告警，否则监控出现空窗。
- `sites-enabled/` 里的站点文件必须保持指向 `sites-available/` 的软链接：变成普通文件后，改 `sites-available` 不再生效、按旧文件回滚也会失效（2026-10-05 实际发生过）。
- Node 的对局计算线程数由环境变量 `SP_WORKERS` 控制（`server/workers/pool.js`，取值 0..32，默认 `min(8, CPU 核数 - 2)`，2 核机器默认 1）。`/healthz` 的 `workers.queued` 持续大于 0 说明计算线程不够：设 `SP_WORKERS=2` 可消除排队延迟，但要真正扩容量需升配 CPU（4 核时默认值即为 2）。
- 主配置模板 [`scripts/nginx.conf.example`](../scripts/nginx.conf.example) 已包含线上验证过的 `/_v/`、`/healthz`、`/api/announcement` 缓存块与坑位注释，改域名和证书路径后可直接使用。

## 3. Docker

```bash
# A) 构建时下载素材（需要联网，约 460 MB）
docker build -t stronghold-protocol --build-arg FETCH_ASSETS=1 .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v stronghold-state:/app/.state stronghold-protocol

# B) 不把素材打进镜像：先在宿主机运行 node tools/setup.mjs，然后挂载
docker build -t stronghold-protocol .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v "$PWD/public/assets:/app/public/assets:ro" \
  -v stronghold-state:/app/.state stronghold-protocol
```

镜像从源码（`git clone`）构建，Releases 的整合包不含 `Dockerfile`。镜像基于 `node:22-alpine`，多阶段构建，只含生产依赖；`public/vendor` 在构建时生成。`.dockerignore` 排除了下载的 `public/assets` 素材，但保留本分支跟踪的 `public/assets/local/`，因此 3D 棋盘等本地客户端素材会进入镜像（0.2.0 新增的召唤物模型需要先在宿主机运行 `npm run setup -- --local` 提取）；`public/fonts`、`data/assets.json` 和 `data/local-assets.json` 若存在会被复制进去。挂载整个 `/app/public/assets` 会覆盖镜像中的素材，宿主机目录也应包含 `local/`。环境变量同 README（`-e SP_VERIFY=sample` 等）。健康检查：`GET /healthz`。

docker compose 示例：

```yaml
services:
  stronghold:
    build:
      context: .
      args: { FETCH_ASSETS: "1" }
    ports: ["3000:3000"]
    restart: unless-stopped
    volumes: ["stronghold-state:/app/.state"]
    stop_grace_period: 30s
    environment:
      SP_VERIFY: "off"
volumes:
  stronghold-state:
```

启动默认启用服务端检查点。升级时保留状态目录或上面的持久卷，玩家可凭原身份恢复最近的安全阶段；配置、恢复范围和首次升级说明见 [PERSISTENCE.md](PERSISTENCE.md)。

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
| 画面是占位图、没有声音 | 素材没下完：重新运行 `node tools/setup.mjs`（会续传）；缺失明细在 `.cache/assets-report.json`。默认仅原始源和 jsDelivr；可用 `--asset-source=mirror` 手动开启前缀镜像（见上文） |
| 素材下载很慢 / 失败 | 网络问题可随时中断，重新运行会跳过已完成的文件；`node tools/fetch-assets.mjs --concurrency=4` 降低并发。有文件没下载成功时，素材清单 `data/assets.json` 保持不变（脚本列出缺少的条目并以非零状态结束；游戏里缺的图片用占位图，缺的声音不播放），重新运行即可补齐 |
| 表情显示成默认图标、「玩法说明」只有文字要点 | 素材没下载完整：重新运行 `node tools/setup.mjs`（表情和教程图随其他素材一起从公开镜像下载，不需要客户端）；缺失明细在 `.cache/assets-report.json` |
| 本地提取失败 | 游戏照常运行，只是第 6 节表格里的几样换成替代样式。确认客户端已下载全部资源；Python 版本太新导致依赖安装失败时，安装 Python 3.12 后删除 `.venv-extract` 再运行 `node tools/setup.mjs --local` |
| 3D 棋盘没出现 | 需要本地提取的棋盘贴图（`node tools/doctor.mjs` 会显示「3D 棋盘可用」），以及支持 WebGL2 的浏览器。没有客户端的服务器可以从同一版本的整合包复制本地素材（第 6 节） |
| 断线 | 同盟模拟 10 分钟内、独立模拟 24 小时内（`config.constants.singleReconnectTime`）用同一浏览器重新打开页面，自动回到原座位。同盟掉线期间按原阵容自动作战、到时自动准备（不会代为购买；想让 AI 代打请用「离开模拟 → 暂离（AI 托管）」）；独立模拟不计时，等你回来 |

## 6. 本地客户端素材（可选）

`public/assets/local/` 和 `data/local-assets.json` 是从本机安装的《明日方舟》客户端里提取的官方素材（`tools/local-extract`，DESIGN §13）：`node tools/setup.mjs` 检测到客户端时会询问是否提取，之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<…/StreamingAssets/AB/Windows>"` 指定客户端目录。setup 从公开镜像下载的素材不包含这部分，所以在没有客户端的电脑上（例如 Linux 服务器）用源码或精简包部署时不会有它；Releases 的完整包里已经带上了。

**本分支已把上游 v0.1.3 完整包的这部分素材和清单纳入 Git**，因此拉取 `master` 就会获得官方 3D 棋盘、部分界面图标和本地独有的敌人模型，无需另行提取或复制。来源和完整包校验值见 [ASSETS.md](ASSETS.md)。更新时停止服务、执行 `git pull` 后重启，再运行 `node tools/doctor.mjs` 确认「3D 棋盘可用」。普通干员美术、音频和字体仍由 setup 下载。启用素材 CDN 的站点，维护者把新素材随 R2 发布（`node tools/r2-sync.mjs --bucket weishu --push`）后，部署机 `git pull` 并重启即可，见 [CDN.md](CDN.md)。

没有本地素材时游戏照常运行，只是下面几样换成替代样式：

| 内容 | 没有本地素材时 |
|---|---|
| 官方 3D 棋盘（贴图、模型、地图特效） | 2D 棋盘，地块由程序绘制 |
| 部分官方界面图标与底板：交流按钮和表情面板的边框、暂停面板、装备替换窗口、干员调配界面、队友状态与漏怪标记、模组类型图标等 | 样式相近的替代图形、图标或文字 |
| 灼热 / 炽焰源石虫的官方模型 | 染成橙色 / 红橙色的普通源石虫 |
| 39 个召唤物的官方模型（多数自选召唤物，以及凯瑟琳的爬行号·防护单元、凛御银灰的风雪之眼；公开镜像没有） | 召唤物头像（菱形底板） |

表情（6 套 × 6 个）和「玩法说明」的 19 页教程图公开镜像也有：`node tools/setup.mjs` 会和其他素材一起下载（约 21 MB），不需要客户端；有本地素材时优先显示本地的。

**没有客户端的服务器**想要上表中的官方素材：从**同一版本**的完整包（[Releases](https://github.com/sganggs/Stronghold-Protocol/releases)）里，把 `public/assets/local/` 文件夹和 `data/local-assets.json` 复制到服务器项目目录下的相同位置。服务器每次请求都会重新读取这两处，不必重启，玩家刷新页面即可。一定要用与服务器代码相同版本的完整包：各版本提取的内容和清单可能不同（例如灼热 / 炽焰源石虫的模型是 0.1.0 之后才加入的，召唤物模型是 0.2.0 加入的），混用其他版本的文件会缺图或用错图。复制后 `node tools/doctor.mjs` 会显示本地素材的条目数和「3D 棋盘可用」。

**0.2.0 之前提取过的**：召唤物模型是 0.2.0 新增的提取项，旧的提取结果里没有（`node tools/setup.mjs` 会提示「缺少新版的自选召唤物模型」）。有客户端的电脑运行 `node tools/setup.mjs --local` 重新提取即可，只想补这一项也可以在提取用的 Python 环境里运行 `tools/local-extract/extract.py --only spine/token`（新文件写入 `public/assets/local/spine/token/`，清单里其他条目保持不变）。

**3D 棋盘贴图的下载量**：每位玩家进入对局时都要从开服的电脑下载 3D 棋盘的 12 张贴图。提取时会给这 12 张各写一份 WebP（颜色贴图有损、质量 95，法线和数据贴图无损），清单里列的是 WebP，同名 PNG 留在旁边给裁切工具和 setup 用。这部分下载量从约 6.7 MB 降到约 2 MB，网速慢的远程联机最明显。只有 PNG 的本地素材（例如在这一改动之前提取的）可以用提取时的 Python 环境运行 `tools/local-extract/extract.py --webp` 就地补上，只需要 Pillow，不需要客户端。

## 7. 打包发布（维护者）

Releases 的两个 zip 由 `tools/package.mjs` 生成，在**源码仓库**里运行（整合包里没有这个工具）：

```bash
npm run package -- --dry-run --list   # 只检查：列出每个文件和大小，不写任何文件（精简包加 --lite）
npm run package -- --out <目录>        # 完整包 Stronghold-Protocol-v<版本>.zip
npm run package:lite -- --out <目录>   # 精简包 Stronghold-Protocol-v<版本>-lite.zip
```

- **打进去的**：`git ls-files` 里的 `server/`、`shared/`、`data/`、`public/`（不含 `public/dev/`）、`packs/`（随仓库提交的内容包；只在本机安装、没提交的不打进去）、启动脚本、玩家会运行的工具（setup、vendor、fetch-assets 与 `tools/assets/`、doctor，以及 setup 调用的 `tools/local-extract/` 和 `crop-board-atlas.mjs`）、服务器和 fetch-assets 读取的 4 张研究数据表（`docs/research/` 的 `03-operators`、`05-enemies`、`05-maps`、`07-assets` 四个 JSON）、`package.json` / `package-lock.json`、许可证与说明（`LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、`README.md`、`CHANGELOG.md`）、`docs/PLAYING.md` 和本文；然后在临时目录里生成 `packs/index.json`（打进去的语言包和内容包的列表，供纯静态托管使用；服务器自己会实时列出，见 [PACKS.md](PACKS.md)），再 `npm ci --omit=dev` 装上运行依赖和 `public/vendor`。完整包再加上 `data/assets.json` 列出的素材、`public/fonts`，以及本地提取的 `public/assets/local/` 和 `data/local-assets.json`。磁盘上有、清单却没列出的文件不打进去（例如 0.2.0 移出自选的焰狐龙梓兰的旧素材）。
- **不打进去的**：`test/`、维护用的工具（数据构建、golden、botbench、i18n、导入检查、本工具等）、`scripts/make-windows-bundle.mjs`（Windows 便携包，见 [WINDOWS.md](WINDOWS.md)）、其他文档、研究笔记和 `docs/img/`、`handoff/`、`.github/`、`types/`、lint / 编辑器 / Docker 配置。和 0.1.x 的整树打包（全部跟踪文件加上 `public/assets` 的全部内容）相比，0.2.0 的完整包少了约 640 个文件、解压后小约 26 MB，zip 小约 8 MB。
- **打包前的检查**（`--dry-run` 也全部做一遍）：拒绝名单（`pv`、`review`、`.cache`、`.claude`、`.git`、`logs`、`.env`、`scripts/service.env.cmd`、`handoff`、`test` 等）；每个打进去的模块的相对导入、玩家用的 npm 脚本（start / setup / doctor / launch / postinstall / vendor / assets）都指向包里的文件；完整包里 `data/assets.json` 和 `data/local-assets.json` 列出的文件都在（缺了先运行 `node tools/fetch-assets.mjs`）；没有只差大小写的两个路径；包里的文件（二进制素材也查）不含个人目录路径（`/Users/…`、`C:\Users\…`、`/home/…`）或本机的账户名（运行时从系统读取；`SP_PACKAGE_SCAN_NAMES=a,b` 可以再加名字）；打进去的已跟踪文件没有未提交的改动（重新生成的 `data/assets.json` 要先提交）。有任何问题都会列出原因、以非零状态结束，不写 zip；正式打包时还会核对临时目录里的文件和计划完全一致。
- **需要**：已下载素材的仓库（完整包）——打包前先联网运行一次 `node tools/fetch-assets.mjs`，补齐清单计划但本机还没有的素材（清单只列出磁盘上有的文件，打包工具看不出缺了哪些；`data/assets.json` 有变化就先提交）；能访问 npm 的网络（`npm ci`）；`zip`（或 bsdtar 的 `tar`，Windows 10 起自带）。`--out` 默认是系统临时目录下的 `stronghold-protocol-release`，不能在仓库里面；`--force` 覆盖已有的 zip，`--keep-stage` 保留打包用的目录供检查。
