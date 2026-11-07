# 部署指南

目标：在一台家用 Windows 小主机上长期开服，让朋友通过局域网或公网来玩。macOS / Linux / Docker 放在后面。
所有命令都在项目根目录执行。遇到问题先运行 `node tools/doctor.mjs`（只读诊断）。

## 0. 资源需求

| 项目 | 说明 |
|---|---|
| 服务器 CPU | 战斗在各玩家浏览器里模拟（DESIGN §14），服务器负责回合、经济和校验；未启用 P2P 时的原模式测量值为：**每个房间每个作战回合约 1 ms CPU**。P2P 转发会增加状态签名开销，且保留看门狗的 WebSocket 补发，不能按四人只发一份估算下行。AI 队友 / 掉线玩家的战场由服务器模拟：作战开始时 3 个 AI 战场在开发机上约 0.2–0.5 s CPU，小主机上可能要几秒（分成 8 ms 小片执行，不会卡住其他房间）。`SP_VERIFY=all` 会复算每个真人战场，CPU 明显增加，小主机建议保持 `off` 或 `sample`。AI 布阵的试算也会消耗 CPU；线上房间默认交给房主浏览器代算，设 `SP_BOT_REHEARSAL=server`（或 `off` / `0` / `false`）则回到服务器试算（见下面）。 |
| 服务器内存 | 空闲约 100 MB，每个进行中的对局再增加几 MB。 |
| 网络 | 4 人对局中服务器每回合下行约 0.25 MB（DESIGN §14 实测；0.2.6 起 1 KB 以上的 WebSocket 消息用 permessage-deflate 压缩，实测一局单人对局的服务器消息从 173 KB 降到 60 KB，约为原来的三分之一）。首次进入游戏时浏览器要从主机下载所需的图片 / Spine 模型 / 音频（按需加载，之后走浏览器缓存），公网隧道带宽小时第一次会慢一些。0.2.6 起服务器启动后在后台给素材算内容哈希（第一次约 1–20 秒，看机器和硬盘；之后只检查大小和修改时间），下发的素材清单里每个地址带上哈希：浏览器把图片、模型和音频缓存一年（素材 CDN 上的对象同样按一年
`immutable` 发布，见下方「预载 / 公告相关变量」一节的说明），服务器更新、重新解压或 Docker 重建之后，玩家只重新下载内容真的变了的文件。哈希存在 `.cache/asset-hashes.json`，删掉会重新计算；目录不可写（例如只读的容器）时只在内存里算。 |
| 磁盘 | 素材约 720 MB（`public/assets`，含中文约 65 MB、日文约 85 MB、英文约 71 MB、韩文约 80 MB、本土语言约 18 MB 的干员语音）+ 依赖约 125 MB（`node_modules`；整合包只带运行依赖，约 65 MB）；可选的本地提取约 40 MB（`.venv-extract`）+ 约 330 MB（贴图、各战场官方场景和官方战斗特效，见第 6 节）。完整包解压后约 1.16 GB。 |
| 玩家设备 | 支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版），电脑或手机平板（横屏）。老旧设备可在设置里调低画质或访问 `/?board=2d`。 |

会话、房间和运行中的对局会周期性落盘（`.state/server-<PORT>/`，`SP_STATE_FILE` 改路径、`off` 关闭），进程重启后恢复：token 重连回来还是同一个玩家、对局回到最近一个安全检查点（见下面「断点续玩」一节）。自己安装或制作的插件、`plugins/config.json` 和工作台钥匙保存在磁盘上，请按需备份 `plugins/`。

**房主帮 AI 试算布阵（线上房间默认开启）：**房主开局的线上房间默认把 AI 队友的布阵试算交给当前房主的浏览器：整备阶段用同源的模块 Worker（`/js/battle/rehearsalWorker.js`，不绘图、不用 `eval`）比较 AI 队友的几种布阵，只把选中的序号发回；服务器直接采用，不再重算。环境变量 `SP_BOT_REHEARSAL=server`（或 `off` / `0` / `false`，大小写不敏感）让本进程启动的房间回到服务器试算；不设或设为 `host` 保持开启。候选数由 `SP_BOT_REHEARSAL_COUNT` 设（0–8，默认 6；线上设 3 可缩短房主 Worker 的耗时，服务器接管时同样最多试算 3 个）。引擎层直接构造的 Match（botbench、golden、回放、工作室）默认仍关，不受这条线上默认影响。房主掉线、换人、报错、答案不合法或超时时，服务器用同一批候选自己算。应答窗按房主自适应：房主第一次拿到试算任务时（浏览器 Worker 还在加载 `/sim/` 模块图，3 秒窗会让这单超时、服务器和浏览器两头白干）给 7 秒冷启动窗（`SP_BOT_REHEARSAL_COLD_ANSWER_MS` 可调，0 = 固定窗），答上第一单后回落 3 秒常温窗（`SP_BOT_REHEARSAL_ANSWER_MS`，缺省 3000）。窗口不延长回合：整备先结束则取消试算、保留默认布阵。正式战斗和真人「AI 托管」不受影响。开了玩法插件的房间不走这条路：对局在内容组合自己的进程里，仍由服务器试算，避免浏览器用错数据包或绕过脚本额度。没有可用房主时也不会减少服务器负担。浏览器会多算一些，耗时取决于房主设备和局面。这个接口（任务、答案序号、超时、回退到服务器）以后可以换成本机或外部计算，当前版本不会对外发起网络请求。

**外部 AI（目前仅开发分支，不随发布包提供）：**维护者 2026-10-23 决定，在语言模型席位的终极胜率接近 100% 之前，外部 AI 与顾问模式不进入发布包、更新包和 Docker 镜像（§35.66）。发布包里的服务器遇到 `SP_BOT_STRATEGY=external`、`SP_BOT_STRATEGY_SEATS` 中的 `external`、`SP_EXTERNAL_AI_*` 或 `SP_LLM_*` 时不崩溃、不连外网，忽略这些设置，用内置 AI，并打一行日志。内置 AI 和 #673 策略框架照常随包提供。从源码运行的开发分支仍可按
[服主接入指南](EXTERNAL_AI_ZH.md)与 [External AI API](EXTERNAL_AI.md) 配置；本机程序具有服务器权限，第三方服务能看到该席位视图，请自行选择可信服务。


## 1. Windows 小主机：一步步

### 1.1 安装与首次启动

1. 安装 Node.js 22 LTS 和 Git（在 PowerShell 或「终端」里；用下面的整合包时不需要 Git）：
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   装完**关闭并重新打开**终端，`node -v` 应显示 v22 或更高（winget 的 LTS 目前是 v24.x，同样可用）。没有 winget 时从 <https://nodejs.org/zh-cn/download> 和 <https://git-scm.com/download/win> 下载安装。
2. 下载，三选一。建议放在一个固定、短、**不在 OneDrive 同步范围内**的目录，例如 `C:\Stronghold-Protocol`：
   - **完整包（推荐）**：在仓库的 [Releases](https://github.com/sganggs/Stronghold-Protocol/releases) 页面下载最新版本的 `Stronghold-Protocol-v<版本>.zip`（约 800 MB，解压后约 1.16 GB；已含运行依赖、前端库和全部素材，包括中文、日文、英文、韩文和本土语言的干员语音和官方 3D 棋盘、各战场官方场景、官方战斗特效等本地客户端素材），解压后把里面的 `Stronghold-Protocol` 文件夹放到上述位置。不需要 Git，首次启动也不用再下载素材。素材版权归上海鹰角网络 / Yostar，仅限非商业使用，见 [NOTICE.md](../NOTICE.md)。
   - **精简包**：同一页面的 `Stronghold-Protocol-v<版本>-lite.zip`（约 25 MB）。代码、运行依赖和前端库与完整包相同，但不带素材：美术、Spine 模型、音频（含全部干员语音）、字体、表情和「玩法说明」教程图在首次启动时由 setup 从公开镜像下载（约 720 MB，显示进度，可中断续传；镜像设置见下面的「国内镜像下载」）。官方 3D 棋盘等本地客户端素材需要用本机客户端提取，或从同一版本的完整包复制（第 6 节）。适合下载大文件不方便、或想先下一个小包的情况；放置方式同完整包。
   - **源码**：
     ```powershell
     git clone https://github.com/sganggs/Stronghold-Protocol.git C:\Stronghold-Protocol
     ```
3. 双击 `C:\Stronghold-Protocol\scripts\start-windows.bat`。首次会：安装依赖（`npm ci`；整合包已含，跳过）→ 复制前端库（整合包已含，跳过）→ 下载约 550 MB 素材（完整包已含，跳过；精简包和源码在这一步下载，显示进度，中断后再次启动会续传）→ 若检测到本机的明日方舟客户端，询问是否提取官方贴图（可跳过）→ 启动服务器并打开浏览器。
4. 窗口里会打印朋友可用的地址，例如 `http://192.168.1.23:3000`。用另一台设备打开它确认能进入。关闭窗口即停止服务器。

等价的手动命令：`npm ci`、`node tools/setup.mjs`、`npm start`。

**插件需要的官方数据表（0.3.1）：**完整包和精简包都不内置官方 excel 缓存。只有 Forge 导入要推导名单外官方干员，
或 setup（包括启动、更新前的缺项检查）发现已安装插件引用这类干员时，才补齐
`.cache/gamedata/excel/` 的 `character_table.json`、`skill_table.json`、`range_table.json`、
`uniequip_table.json`、`battle_equip_table.json`、`activity_table.json`（约 50 MB，未压缩估算；日志列出本次缺的表、大小与原因）。
来源与语音表相同：Kengxxiao/ArknightsGameData 的 zh_CN 官方数据镜像，原始源 → jsDelivr，沿用下方的源与代理选项。
已有表不再下载，只有 `--refresh-index` 会重新获取；JSON、表结构和大小校验通过才原子写入。
`--check`、`--no-assets` 不下载这些表；新增 `--offline` / `--no-network` 等价于只读 `--check`，整个 setup 不联网。
下载失败或拒绝不会阻断 setup / 导入：导入报告仍写明跳过的干员和原因，缺表的美术 / 特效发现保持原来的回退。
表下载不等于同意提取美术，客户端素材提取仍按第 6 节单独选择。大厅、对局与游戏客户端不会获取这些表。
规则与限制见 [§34.33](history/0.3.1.md#3433-official-tables-for-plugin-operators-outside-the-roster-downloaded-when-needed)（维护者 2026-10-17 决定）。

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
nssm set StrongholdProtocol AppEnvironmentExtra PORT=3000 HOST=::
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

没装开机自启的话，最后一步改成重新双击 `start-windows.bat`。

#### 用整合包安装的：更新包

0.2.1 起，Releases 里每个版本除了完整包和精简包，还有更新包 `Stronghold-Protocol-v<版本>-update.zip`：只含比说明中列出的旧版本改动过的文件（程序、数据、运行依赖，以及改动过的素材），通常只有几 MB。它用来升级用 0.2.0 及以后的完整包或精简包装好的文件夹（适用的版本写在 Releases 说明里）；全新安装、0.1.x 和 GitHub「Download ZIP」源码包请用完整包或精简包，`git clone` 的用上面的 `git pull`。

```powershell
cd C:\Stronghold-Protocol
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Stop   # 装了开机自启时；没装就关掉服务器窗口
Expand-Archive -Force <下载目录>\Stronghold-Protocol-v<版本>-update.zip C:\       # 解压到安装文件夹的上一层，合并进 C:\Stronghold-Protocol、覆盖同名文件
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Restart
```

没装开机自启的，最后一步改成双击 `start-windows.bat`。也可以在资源管理器里打开 zip，把其中 `Stronghold-Protocol` 文件夹的全部内容复制到安装文件夹，选「替换目标中的文件」。macOS / Linux：停止服务器后运行 `unzip -o Stronghold-Protocol-v<版本>-update.zip -d <安装文件夹的上一层>`（安装文件夹名为 `Stronghold-Protocol`）；不要用访达拖放，它会把同名文件夹整个替换掉。

启动时（双击启动、`npm start`、开机自启的计划任务、NSSM / systemd 都一样）服务器先完成更新：按 `MANIFEST.json` 核对全部程序文件（代码、数据、运行依赖、前端库和说明文档；素材归 setup 管，不在其中），删除 `UPDATE.json` 列出的、新版本不再使用的旧文件（只删内容与旧版本发布时完全一样的文件：自己改过的文件、自己装的内容包、`logs`、`.cache` 都不会动），再把 `UPDATE.json` 改名为 `.update-applied.json`，然后照常启动，日志里有一行「已更新到 v<版本>」。

- **文件夹不是更新包对应的版本**（例如 0.1.x、只解压了一部分、程序文件被改过）：服务器**不启动**，提示「这个更新包只能覆盖在 v0.2.0 … 的整合包安装上（检测到 N 个文件与 v<版本> 不一致或缺失）」并举出几个文件（开机自启的，`-Status` 显示的日志里能看到）。新旧文件混在一起运行，容易出现看起来像游戏 bug 的错误，所以宁可不启动。下载完整包重新安装，或把更新包重新完整解压一遍再启动（`UPDATE.json` 还在，会重新检查；在此之前什么都不删）。
- 只有说明文档、`scripts\`、`tools\` 里的文件不一致：照常启动，日志里列出是哪些文件。`UPDATE.json` 损坏：跳过并提示，按现有文件启动。
- **精简包装的也能用**：程序部分与完整包完全相同；更新包带着完整包里改动过的素材，其余素材仍由 setup 补齐。如果更新包带来了新的本地客户端素材清单（`data/local-assets.json`）而这台电脑没有对应的素材，启动时会提示：从同一版本的完整包复制 `public/assets/local/`（第 6 节），或运行 `node tools/setup.mjs --local` 提取，不需要时删掉 `data/local-assets.json` 即可。
- 更新包不联网、不会自动更新，和完整包一样从 Releases 手动下载。`npm run doctor` 的「文件校验 MANIFEST.json」一行随时显示全部程序文件是否与这个版本一致（源码目录没有这个文件，不做校验）。

不用更新包也可以：停止服务器，把新版本的整合包解压到新目录后从那里启动（完整包已含素材；装了开机自启的，在新目录重新运行一次 `install-service-windows.ps1`）。用精简包或 GitHub「Download ZIP」源码包的：解压新版本后，把旧目录里的 `public\assets`、`public\fonts`、`.cache` 和 `data\local-assets.json`（若有）复制过去，可避免重新下载（setup 只补下新增的素材）。

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

**固定访问地址能省很多流量**：浏览器的缓存、设置、统计和断线令牌都按地址（域名或 IP + 端口）分开保存。地址一换，对玩家来说就是一个新网站：每个人进游戏都要把图片、模型和音频重新下载一遍（第一局约 20–50 MB），设置和本机统计也看不到了。临时隧道每次重启都换域名，所以固定朋友圈子长期开服时，建议用命名隧道、Tailscale（2.1）或固定的公网 IP / 局域网 IP（1.3），让大家一直用同一个地址。

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

**HTTP/2**：客户端由数百个小脚本模块组成（0.2.0 起进入对局时约 340 个），隔着公网时建议让代理以 HTTP/2 提供页面：所有模块走同一条连接，远距离玩家首次进入对局明显更快。Caddy 默认就是 HTTP/2；Nginx 见上面的 `http2`。服务器本身只说 HTTP/1.1，局域网或本机游玩不受影响。HTTP/2 省的是往返等待，不减少字节数。

**压缩**：服务器自己压缩脚本、样式、数据和 Spine 的 `.skel` / `.atlas`：浏览器支持 brotli 时用 brotli（0.2.6 起，质量 5，比 gzip 快且更小：实测 `.skel` 小约 27%、游戏数据 JSON 小约 26%、前端库小约 14%、脚本小约 5%），否则用 gzip；图片和音频本来就是压缩格式，原样发送。浏览器只在 HTTPS 页面（以及 `localhost`）上声明支持 brotli，所以通过代理或隧道的 https 地址访问时用 brotli，局域网里的 `http://192.168.x.x:3000` 这类地址用 gzip。代理不需要另开压缩（Caddy 的 `encode`、Nginx 的 `gzip` 遇到已经压缩的响应会跳过）。

**Cloudflare 缓存**（命名隧道或自己的域名经过 Cloudflare 时）：Cloudflare 默认只缓存常见扩展名，`.skel`、`.atlas` 和没有扩展名的音频地址 `/media/…` 都不在其中，每个请求都会回到开服的电脑。在 Cloudflare 控制台的「缓存规则」里加一条：主机名是你的游戏域名、且 URI 路径以 `/assets/`、`/fonts/` 或 `/media/` 开头时「符合缓存条件」，边缘 TTL 选「使用源站的 Cache-Control」。0.2.6 起素材清单里的地址带内容哈希（`/assets/~<哈希>/…`），服务器给这类地址一年的 `immutable`，换了内容的文件会换地址，所以长期缓存是安全的；`/data/`、页面和脚本不要加进规则（它们要随服务器更新）。注意：边缘公开缓存官方素材会增加被投诉的风险，大量媒体文件也要留意 Cloudflare 的服务条款；只给自己人玩时不加这条规则也可以。

https / wss 说明：页面通过 https 打开时客户端自动连接 `wss://同一域名/ws`；http 时用 `ws://`。服务器本身只提供 http，证书由代理 / 隧道负责。代理与服务器在同一台机器或内网时，`TRUST_PROXY=auto` 会信任它的 `X-Forwarded-For` / `X-Real-IP`；代理在公网另一台机器上时设 `TRUST_PROXY=1`（同时确保游戏端口只对代理开放）。

### 2.5 玩家侧素材预载（资源管理面板，合并自用户分支）

标题画面右下角有一张「预载资源」卡：显示预载状态，点开（或从 设置 → 预载资源）进入**预载资源管理**。玩家按范围选择要提前缓存的素材——必备（地图、干员图片、Spine、界面与字体）、干员语音（可选语种）、干员皮肤（跟随已选皮肤或全部收录套数）、额外特效——快捷方案「仅必备 / 日常推荐 / 完整预载」一键设置，然后点「开始预载」。

- 只有 **HTTPS** 或 **localhost** 能预载。浏览器只在安全上下文里提供 Service Worker 和可用的 Cache Storage。`http://局域网IP:3000` 可以正常玩游戏，但不能预载；面板会说明原因，而不是报错。
- 预载的文件进这台浏览器的分片缓存（`stronghold-resources-v1-*`），之后由可选的模块 Service Worker（`public/resource-sw.js`）就近应答 `/assets/`、`/fonts/` 和 `/media/` 的请求，未命中走网络；页面、脚本、`/data/`、`/sim/` 和 `/ws` 仍每次走网络。关闭预载即注销该 Worker，清理用面板底部的「清理可选资源 / 清理全部资源」。
- **ZIP 资源包**：维护者用 `npm run resources:packs` 把素材打成类别 zip（`public/resource-packs/`，索引 `GET /data/resource-packs.json`，构建见 docs/ASSETS.md「Preload」）。0.3.4 起客户端**硬优先**走这些 ModelScope 分包（覆盖率门槛放宽、首线路加重试），R2 逐文件只补分包没覆盖或失败的缺口；新增素材/类别用 `npm run resources:packs -- --scopes gap` 只补索引缺口、纯追加，不全量重打包。玩家点「导入 ZIP」读自己已有的包：整包指纹校验通过后逐文件按哈希写入缓存，已有的自动跳过，整套包也不必整个读进内存；「前往下载」打开维护者发布的下载页（按钮地址写死在 `public/js/ui/resourcePanel.js`，B 站短链；`SP_RESOURCE_PACK_ROUTES` 配的是**自动分包**的镜像列表，见第 12 节），「导出已缓存资源」把一个范围的已缓存文件打包分享。导入不经过服务器逻辑，服务器日志里看不到这些文件。全链路（发布 SOP、CDN 缓存规则、状态文件、当前缺口）见 [PRELOAD.md](PRELOAD.md)。
- 预载能省下的，是这些本来会从你的机器发出去的字节：整套美术约 1 GB，玩家第一局真正用到的通常约 20–50 MB。
- 0.3.3 及更早版本的标题屏按钮「下载完整素材 / 导入素材包」已由本面板取代。更早版本导入过的素材（`sp-imported-assets-v1` 缓存）仍会被旧的 `/sw.js` 读取，「设置」→「素材存储」的「清理旧版本素材」可以清理；详见 docs/ASSETS.md「Legacy imported-asset cache」。

### 2.6 P2P 公共状态转发（可选，默认关闭）

这是一条**可选的转发路径**，默认关闭：不设置 `SP_P2P` 时，所有公共对局状态仍由服务器直接分发，行为与之前完全一致。开服者显式设置 `SP_P2P=1`（或 `true`）后，同盟房间才会在玩家与观战者之间建立 WebRTC 星形连接，由一名浏览器转发服务器签名的公共对局状态（`m.public`）。连接就绪的成员从该浏览器接收，未就绪的成员继续由服务器发送。服务器先向中继发送一份；约 2.5 秒（`P2P_ACK_MS`）的看门狗到期后，仍向每名接收者的 WebSocket 补发最新快照。确认序号不会取消计时或补发，窗口内的新快照只覆盖待补发的旧快照。因此服务器总发送量不会从 4 份变成 1 份，不能据此承诺带宽节省；实际字节数取决于更新频率、状态大小、签名与压缩。战斗仍在浏览器计算。私人数据、玩家操作、战斗报告、实时领袖血量流（`b.pool`）及其他事件继续走 WebSocket；素材仍通过 HTTP 下载或使用本地缓存。`m.public` 中的领袖血量快照随公共状态一起转发。

- 推荐通过 **HTTPS**（或本机 `localhost`）访问，以便使用 WebCrypto 验证服务器签名。浏览器不支持相关 API 时直接使用 WebSocket。
- 默认不访问公共 STUN / TURN 服务，适合同一网络内直连。公网跨 NAT 可由开服者配置自己的 ICE 服务：

  ```powershell
  $env:SP_P2P = '1'
  $env:SP_P2P_ICE_SERVERS = '[{"urls":"stun:stun.example.com:3478"}]'
  npm start
  ```

  TURN 的格式为 `[{"urls":"turn:turn.example.com:3478","username":"临时用户名","credential":"临时密码"}]`。这些配置会发送给参与连接的浏览器，请使用有期限、权限受限的 TURN 凭据。TURN 中继会产生自身的流量费用，优先使用直连。
- WebRTC 需要客户端之间的网络可达性；只配置反向代理的 `/ws` 不会打通 UDP。
- **主机候选地址可能暴露局域网地址**：建立连接时浏览器会交换 ICE 候选地址，其中包含主机候选（本机在内网的地址，例如 `192.168.x.x`、`10.x.x.x`）。这些信息会发给同房间正在建立连接的成员，等同于把你的内网地址告诉对方。请按与朋友共享网络连接的方式使用；不希望暴露内网地址时不要开启 `SP_P2P`，或对客户端的网络权限加以限制。
- **回退空窗约 2.5 秒**：中继通道仍显示连接、却不再转发状态（或转发的快照丢失、无法通过签名校验）时，服务器的看门狗会在约 2.5 秒（`P2P_ACK_MS`）后，把最新那条已签名快照从自己的 WebSocket 补发给该成员；只有计时期间确认序号完全没有前进才停用这条通道。也就是说这条路径上单次故障的恢复时间上界约为 2.5 秒，期间该成员看到的是上一帧状态；客户端自报的序号不会被当作"已应用"的证据，因此即便收到错误确认也会补发。
- 开关：全服默认关闭，显式 `SP_P2P=1` 开启；单个浏览器在网址后加 `?p2p=off`（已有参数时用 `&p2p=off`）关闭。ICE JSON 配置错误会关闭 P2P 并给出日志提示，游戏继续走 WebSocket。

### 2.7 访问口令门禁（0.3.4 起）

`SP_GATE_PASSWORD` 设置一个访问口令后，公网来的访客先看到 `/entry?next=/` 的终端登录页，输入口令才进入；本机与局域网地址默认不受影响（`SP_GATE_LOCAL=0` 让它们也走门禁）。直接暴露公网 IP 或经 FRP 端口转发时，这一层是「谁能进来」的唯一控制，建议开启。

- **挡什么**：页面、`/data/*.json`、`/shared/`、`/sim/`、素材与插件文件全部需要授权 cookie；没有的话 HTML 导航（`Accept: text/html`）302 到 `/entry`，其余请求（素材、数据、API）401。**WebSocket `/ws` 的 upgrade 也要验同一枚 cookie**，只挡 HTTP 的话脚本可以绕过页面直接连进来。
- **放行**：`/entry`、`/_gate/login`、`/_gate/logout`，以及公开只读接口 `/healthz`（隧道 / 探活）、`/api/online`（当前在线人数）、`/api/announcement`（维护公告）——它们不含任何玩家状态。其余一律在门禁后面。
- **cookie**：`sp_gate=<过期毫秒>.<HMAC-SHA256>`，HttpOnly、SameSite=Lax，默认 7 天（`SP_GATE_TTL_DAYS`）；HTTPS 请求自动加 `Secure`。签名输入里带口令摘要，**改口令会让所有旧 cookie 立即失效**。签名密钥取 `SP_GATE_SECRET`，没有就生成 `.cache/gate-secret`（0600），删掉它等于让所有人重新登录；没有可写目录时退化为进程内随机值（重启即全员重登）。
- **本机免门禁只认真实对端**：`SP_GATE_LOCAL` 的旁路只看 TCP 连接的对端地址（`req.socket.remoteAddress`），**不看** `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`。放在 FRP / 反代后面时这些头永远换不来旁路；确实要从公网进来就保持门禁开着，或按 `TRUST_PROXY` 的语义另行配置。
- **无头 TCP 隧道要关掉本机旁路**：`frpc` tcp 模式、`ssh -R`、ngrok tcp 这类不转发任何 HTTP 头的隧道跑在本机（或局域网任一台机器）上时，公网访客在本服务眼里就是 loopback / 内网对端、且没有任何转发头——默认旁路会替**整个互联网**放行，门禁形同虚设。这类部署必须设 `SP_GATE_LOCAL_BYPASS=off`（或 `SP_GATE_LOCAL=0`）关掉本机旁路；带转发头的反代（Cloudflare Tunnel、nginx）不在其列，旁路对它们本来就是关的。
- **口令的编码**：Windows 的 cmd 里 `set SP_GATE_PASSWORD=阿米娅不是驴` 会被代码页弄成乱码。中文（或任何非 ASCII）口令请用 PowerShell 设置 `$env:SP_GATE_PASSWORD = '…'`，或者写成 UTF-8 文件并设 `SP_GATE_PASSWORD_FILE=gate-password.txt`。口令文件读首行、上限 1 KB、不做 trim（口令首尾的空格会被保留）；环境变量仍优先于文件；**文件不可读时服务直接启动失败**，不会静默敞开。
- **登录页**：单文件 HTML、内联样式、没有脚本（站点 CSP 不允许内联脚本），中文 + English；令牌用双提交 cookie 校验，口令按 SHA-256 定长比较；同一 IP（IPv6 按 /64 归一）10 分钟内 5 次失败后 429（`Retry-After`），成功即清零；失败页会重新签发 CSRF，输错一次可以直接重试。
- **部署提示**：门禁只保护本服务。`X-Forwarded-Proto: https` 只有在 `TRUST_PROXY` 信任对端时才会让 `Secure` 生效；限速与统计用同一套客户端地址解析（`clientAddress().key`）。

## 3. Docker

```bash
# A) 构建时下载素材（需要联网，约 720 MB）
docker build -t stronghold-protocol --build-arg FETCH_ASSETS=1 .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped stronghold-protocol

# B) 不把素材打进镜像：先在宿主机运行 node tools/setup.mjs，然后挂载
docker build -t stronghold-protocol .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v "$PWD/public/assets:/app/public/assets:ro" stronghold-protocol
```

镜像从源码（`git clone`）构建，Releases 的整合包不含 `Dockerfile`。镜像基于 `node:22-alpine`，多阶段构建，只含生产依赖（包括 `ses@2.3.0` 和 `acorn@8.18.0`）；`public/vendor`（含 `ses.umd.js` / `acorn.mjs`）在构建时生成。构建阶段会删掉外部 AI / 语言模型集成的文件并写入 `server/release-without-llm`，与发布包同一道门（§35.66）：镜像里的服务器忽略 `SP_BOT_STRATEGY=external` 及相关变量，用内置 AI。`node_modules` 是镜像安装目录里的实际文件，不是指向镜像外的符号链接，脚本沙箱子进程可以在 `--allow-fs-read` 范围内读取。`.dockerignore` 排除了 `public/assets`（不会把宿主机素材打进构建上下文）；`public/fonts`、`data/assets.json` 和 `data/local-assets.json` 若存在会被复制进去。环境变量同 README（`-e SP_VERIFY=sample` 等）。健康检查：`GET /healthz`。

**持久化插件**：把命名卷或宿主机目录挂到 `/app/plugins`，例如加 `-v stronghold-plugins:/app/plugins`。
镜像在 `/app/plugin-resources` 保留只读的 `_template/`、`README.md` 和 `AGENTS.md`，用
`SP_PLUGIN_RESOURCES=/app/plugin-resources` 让工作台读取模板；不要把卷挂到这个资源目录。
即使 `/app/plugins` 是空的，界面和脚本模板仍可用。CLI、Schemas、作者文档和测试助手也在镜像里。
命名卷首次使用继承目录的 `node` 用户权限；宿主机绑定目录须允许容器里的 `node` 用户写入（工作台钥匙和草稿也写在这里）。
镜像不会复制构建机器自己的插件、插件打包产物或备份。

脚本模式用 `-e SP_PLUGIN_SCRIPTS=sandbox` 显式开启；默认仍关闭。容器默认监听 `0.0.0.0`，
原生受信任执行因此必须选择 `trusted-force` 并按第 10 节审查与固定哈希。需要工作台时从本机或局域网地址访问。

Docker Compose 示例（插件命名卷与只读模板分开；脚本默认关闭）：

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
      # SP_PLUGIN_SCRIPTS: sandbox
    volumes:
      - stronghold-plugins:/app/plugins
volumes:
  stronghold-plugins:
```

## 4. macOS / Linux 常驻

- 临时开服：`scripts/start.sh`（或 `npm start`），保持终端窗口打开。macOS 首次会询问是否允许 node 接受传入连接，选「允许」。
- 启动加速（0.3.4 起）：`npm start`、`scripts/start.sh` 和 `scripts/start-windows.bat` 都经 `node --import server/compile-cache.mjs` 先启用 V8 编译缓存（`.cache/compile/`，已忽略；首次启动写入，之后每次启动/重启少约 50ms 的模块编译，删除该目录无副作用，源码变更自动失效）。直接 `node server/index.js` 同样能跑，只是没有这份缓存；自定义 systemd 等启动想把加速带上，把 `ExecStart` 换成 `/usr/bin/node --import /opt/Stronghold-Protocol/server/compile-cache.mjs /opt/Stronghold-Protocol/server/index.js`。
- 启动日志顺序：数据表、内容哈希与版本文件三路读取并行读盘，插件/语言包扫描在读取期间进行，所以 `[packs]` 行可能先于 `[content]` 行打印；各行内容与含义不变。
- 可选：`npm run build` 把浏览器 UI 打包进 `public/build/`（Vite，`SP_CLIENT=source` 回退）。服务器检测到构建产物就提供打包页（首屏加载更快），没有时用源码模块，两者功能一致。
- Linux systemd（`/etc/systemd/system/stronghold.service`，路径与用户按实际修改）：

  ```ini
  [Unit]
  Description=Stronghold Protocol game server
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/opt/Stronghold-Protocol
  ExecStart=/usr/bin/node server/index.js
  Environment=PORT=3000 HOST=::
  Restart=always
  RestartSec=5
  User=stronghold

  [Install]
  WantedBy=multi-user.target
  ```

  `sudo systemctl daemon-reload && sudo systemctl enable --now stronghold`；日志 `journalctl -u stronghold -f`；防火墙 `sudo ufw allow 3000/tcp`。

  **glibc 部署：malloc arena 收敛（0.3.4 起）**。裸机 / VM 上用系统 Node + glibc 跑时，稳态的 WS 帧编码（`JSON.stringify` 出 10–102 KB 字符串）与
  permessage-deflate 的大块原生分配会撞上 glibc 的 arena 隔离：线程 A `free()` 的块线程 B 拿不到，每个 arena 各自膨胀，最后 RSS 里堆着几千个碎小的
  匿名 `rw-p` 段（生产 8 核机上实测 7268 段 / 2.28 GB `RssAnon`，99.4% 的段 <1 MB；V8 堆反而只有 150–290 MB）。`Dockerfile` 的 `node:22-alpine` 是
  musl，**没有 arena 概念，这个变量不生效**——只有 glibc 部署需要。

  用一个独立 drop-in 设上限，别改主 unit 或 `EnvironmentFile`（发布链靠 `zzzz-0XX-release.conf` 切换 `WorkingDirectory`，allocator 配置不该跟版本回滚耦合）：

  ```ini
  # /etc/systemd/system/stronghold.service.d/zzzzz-allocator.conf
  [Service]
  Environment=MALLOC_ARENA_MAX=4
  ```

  **取值 `4` 是实测选的，不是照 `UV_THREADPOOL_SIZE` 凑的**（2026-11-05 在生产同款 glibc 2.41 / 8 核机上跑的独立
  探针，8 个 `worker_threads` 各持独立 V8 堆 + 大 Buffer + 10 KB 级 JSON 字符串，交替 5 轮 × 15 s 取 min/median）：

  | `MALLOC_ARENA_MAX` | `rw-p` 段 min/med | `rw-p` 总量 MB min/med | `RssAnon` MB min/med | ≥500 MB 段 |
  | --- | --- | --- | --- | --- |
  | `2` | 713 / 718 | 1778 / 1807 | 1587 / 1599 | **稳定 1 个** |
  | `4` | 690 / 725 | **1606 / 1844** | **1366 / 1596** | 0 |
  | `8` | 635 / 730 | 1781 / 1860 | 1483 / 1548 | 0 |
  | 默认（64 上限） | 736 / 738 | 1909 / 1957 | 1445 / 1496 | 0 |

  `4` 的 `rw-p` 总量与 `RssAnon` 下界都最低（总量比默认少约 16%），且不产生巨型段。`2` 虽然段数最少，但
  glibc 会用一个 ≥500 MB 的 mmap 大段去伺候多个 V8 隔离堆——推测是早期诊断里「7 个 510 MB 段」的成因
  （2026-11-05 这次只读采样里 ≥500 MB 段为 0，形态已是 7268 个小段；两者是不同时间点的碎片阶段）。
  段数少了但总量和 RSS 反而更高。注意别把纯线程 `bytearray` churn 的结论外推到 Node：那份探针（Python，
  无 V8 堆）测出「arena 越少越好、吞吐 +2.7x」，一换成 `worker_threads` 就反转了，因为每个线程有独立 V8 堆
  和大 Buffer。

  `MALLOC_TRIM_THRESHOLD_` 先不加——99% 的段 <1 MB 时 128 KB 阈值会放大 `madvise` 系统调用抖动。

  环境变量在**进程启动时读取**：写 drop-in + `daemon-reload` 不断线，必须重启 `stronghold.service` 才生效（会断一次所有 WebSocket，房间从 Redis / 状态文件恢复，
  挑凌晨低峰）。重启前后各采 30 分钟做 A/B，见 §13「allocator 调优的 A/B 观测」。回滚就是删 drop-in + `daemon-reload`，下次重启回到默认。

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
| 素材地址里的 `~` 加一串字母数字 | `/assets/~<哈希>/…` 是 0.2.6 起的带版本地址（见第 0 节「网络」），浏览器可以长期缓存，属于正常现象。怀疑它导致问题时，可以用 `SP_ASSET_INDEX=0` 启动服务器临时关闭（清单改回普通地址），并请在 issue 里说明 |
| 想知道开服电脑上传了多少流量 | 浏览器打开 `http://localhost:3000/healthz?traffic=1`（换成你的端口）：`traffic.http` 是服务器启动以来各类内容（`assets` 图片和模型、`audio` 音频、`code` 页面和脚本、`data` 游戏数据和素材清单）发出的字节数和请求数（压缩后的实际字节，`notModified` 是只回了「没变」的 304），`traffic.http.status` 是按状态族的完成数（`ok` 2xx、`redirect` 3xx、`rate_limited` 门禁 429、`client_error` 4xx、`server_error` 5xx、`aborted` 响应没写完连接就断开——放在前面的代理会把这类请求记成 499），`traffic.ws` 是 WebSocket 的线上字节（`wireOut` / `wireIn`，压缩后）和压缩前的消息字节（`payloadOut` / `payloadIn`）。数字只在内存里，重启后从 0 开始；只有本机和局域网（含虚拟局域网地址）的访问能看到，公网访问者（包括经隧道 / 反代转发来的）只拿到普通的 `/healthz`。玩家那边：设置 →「问题反馈」复制的诊断里有一行 `traffic:`，是这个页面从打开起下载的字节数（`cached` 是浏览器缓存直接给的，不占流量；`external` 是其他网站，例如 Google 字体） |
| 想知道布阵试算（房主代算）跑得怎么样 | 同一个 `/healthz?traffic=1` 页面的 `rehearsal` 是所有在跑对局的试算计数合计（`lobby.rehearsalStats`，只读）：`delegated` / `answered` / `takeovers` 是交给房主浏览器的试算数、房主答上来的数、超时 / 掉线 / 换人后服务器接管数；`pooled` / `accepted` / `fallbacks` 是其中交给模拟进程池的数、池算出结果的数、池没能算（忙 / 坏 / 无池）退回主线程数。`answered` 长期低于 `delegated` 说明房主答不进应答窗，`fallbacks` 高说明池忙。本地日志采样器的 `[loop]` 行（`SP_LOOP_SAMPLE=1`，§5）带同样两个三元组（`rehe=d/a/t pool=p/a/f`），不用拉 /healthz 也能看 |
| 想知道静态文件缓存占了多少内存 | 同一个 `/healthz?traffic=1` 页面还有 `staticCache`：`gzip*` 是压缩结果缓存，`transform*` 是改写后响应体（页面 HTML、CSS、`/_v/<tag>/` 下的 js 与版本化 JSON）连同其 ETag 的缓存——热路径每个文件只做一次正则改写与哈希，不随请求重付；键里带文件的 size/mtime/ino/ctime，文件一变自动失效。`*Bytes` 是当前占用、`*LimitBytes` 是预算（96MB / 32MB，超限按最久未用淘汰）、`*Entries` 是条数，重启清零 |
| 断线 | 同盟模拟 10 分钟内、独立模拟 24 小时内（`config.constants.singleReconnectTime`；第一期数据没有这项，24 小时是沿用的便利 [ASSUMED]）用同一浏览器重新打开页面，自动回到原座位。同盟掉线期间按原阵容自动作战、到时自动准备（不会代为购买；想让 AI 代打请用「离开模拟 → 暂离（AI 托管）」）；第二期独立模拟不计时，等你回来。第一期独立模拟的休整与机变按每轮计时，断线后仍可在这 24 小时内回来 |

## 6. 本地客户端素材（可选）

`public/assets/local/` 和 `data/local-assets.json` 是从本机安装的《明日方舟》客户端里提取的官方素材（`tools/local-extract`，DESIGN §13）：`node tools/setup.mjs` 检测到客户端时会询问是否提取，之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<安装目录或 …/StreamingAssets/AB/Windows>"` 指定客户端目录（安装目录和「Arknights Game」都可以，成功后记住解析出的资源目录）。setup 从公开镜像下载的素材不包含这部分，所以在没有客户端的电脑上（例如 Linux 服务器）用源码或精简包部署时不会有它；Releases 的完整包里已经带上了。

没有本地素材时游戏照常运行，只是下面几样换成替代样式：

| 内容 | 没有本地素材时 |
|---|---|
| 官方 3D 棋盘（贴图、模型、地图特效） | 2D 棋盘，地块由程序绘制 |
| 各战场的官方场景（沙地等 11 个战场；完整包在提取后带上，精简包和源码可在本机下载并提取，见下） | 3D 棋盘用程序生成的金属地块 |
| 部分官方界面图标与底板：交流按钮和表情面板的边框、暂停面板、装备替换窗口、干员调配界面、队友状态与漏怪标记、模组类型图标等 | 样式相近的替代图形、图标或文字 |
| 灼热 / 炽焰源石虫的官方模型 | 染成橙色 / 红橙色的普通源石虫 |
| 39 个召唤物的官方模型（多数自选召唤物，以及凯瑟琳的爬行号·防护单元、凛御银灰的风雪之眼；公开镜像没有） | 召唤物头像（菱形底板） |
| 官方战斗特效（0.3.0「官方特效」：普攻、弹道、命中、状态、阵亡、部署和技能；`extract.py --only fx --fx-set used` 单独提取，约 8800 个文件、磁盘约 190 MB，清单是 `data/local-fx.json`；完整包附带一份，精简包和源码需要本机提取） | 本作自己绘制的特效，设置里不显示「官方特效」 |

表情（6 套 × 6 个）和「玩法说明」的 19 页教程图公开镜像也有：`node tools/setup.mjs` 会和其他素材一起下载（约 21 MB），不需要客户端；有本地素材时优先显示本地的。

**没有客户端的服务器**想要上表中的官方素材：从**同一版本**的完整包（[Releases](https://github.com/sganggs/Stronghold-Protocol/releases)）里，把 `public/assets/local/` 文件夹和 `data/local-assets.json`（还有官方战斗特效的清单 `data/local-fx.json`）复制到服务器项目目录下的相同位置。服务器每次请求都会重新读取这两处，不必重启，玩家刷新页面即可。一定要用与服务器代码相同版本的完整包：各版本提取的内容和清单可能不同（例如灼热 / 炽焰源石虫的模型是 0.1.0 之后才加入的，召唤物模型是 0.2.0 加入的），混用其他版本的文件会缺图或用错图。复制后 `node tools/doctor.mjs` 会显示本地素材的条目数和「3D 棋盘可用」。分组或官方特效清单和这一版对不上时，它会提示已有多少、这一版期望多少。

**分组对不上这一版提取器的**：`node tools/setup.mjs` 对照当前提取器会写出的分组（`tools/local-extract/extract.py --print-jobs` 里的 `expectedGroups`，不需要客户端）。少了分组，或清单写的条目数和分组里列出的不一致，会提示已有多少个分组、多少项，这一版期望多少个分组。缺的不是战场场景时，请用 `node tools/setup.mjs --local` 重新提取。缺的分组如果全是 `scene/`（某个战场，或共用贴图 `scene/tex`），有客户端时改为 `node tools/setup.mjs --scenes`，没有客户端时改为从同一版本的完整包复制 `public/assets/local` 和 `data/local-assets.json`：`--local` 不会下载战场场景。召唤物模型是 0.2.0 新增的提取项（`spine/token/<id>`）；只想补这一项也可以在提取用的 Python 环境里运行 `tools/local-extract/extract.py --only spine/token`（新文件写入 `public/assets/local/spine/token/`，清单里其他条目保持不变）。官方特效清单 `data/local-fx.json` 是另一步，用项目里的 `.venv-extract/bin/python`（Windows 是 `.venv-extract\Scripts\python.exe`）运行 `tools/local-extract/extract.py --only fx --fx-set used`：没有它只记一行「未提取」，不把本地美术算成失败；有了但分组、条目数或版本不对会单独警告。

**各战场的官方场景**（维护者 2026-10-12 起随完整包提供；精简包和源码安装可以在本机下载）：官方棋盘是每个战场一个做好的场景（11 个战场，其中 9 个是沙地）。提取不全（少了某个战场，或少了共用贴图 `scene/tex`）时，setup 不会把它报成已完成，而是提示已有多少个战场、这一版期望多少。分组都在、但每个战场清单里的 `scene` 记录（kind 为 Scene）不是这一版 `--print-jobs` 的 `scenes.version` 时，同样不算完成：有客户端请重新运行 `node tools/setup.mjs --scenes` 一次，没有客户端则从同一版本的完整包复制。`scene.json` 的网格版本不变，旧场景在重新提取前仍能显示。有客户端时请用 `--scenes` 补；没有客户端时改为从完整包复制，不提示 `--scenes`。已经有一部分战场时，直接回车或等待不会从客户端提取，回答「是」也不会；只有 `--scenes` 或 `--yes` 会。分组都在、只是清单里的场景版本旧了时，仍是这一句提问（默认否，回车和等待不提取）。回答「是」会像第一次一样下载并运行 `extract.py --only scene`；回答「否」会记住，之后不再问。场景包只在赛季开放期间随客户端分发，赛季外的客户端里没有。仓库不存放这些官方文件。有客户端的电脑可以 `node tools/setup.mjs --scenes`（询问或强制下载并提取；`--no-scenes` 跳过）。也可以分两步：`python3 tools/local-extract/fetch_scenes.py`（从官方 CDN 下载赛季版本 `26-04-13-12-31-42_e9b560` 的 33 个场景包，共 22,801,308 字节，放进 `.cache/official-scenes/`；`--list` 只看清单不下载），再用提取环境的 Python 运行 `tools/local-extract/extract.py --only scene`（材质和贴图仍取自本机客户端；`--game` 可指定客户端目录）。没有 Python 3.8+，或 UnityPy / lz4 / Pillow 没装好时，setup 只提示并继续，3D 棋盘用金属地块。没有客户端时贴图取不出来，从同一版本的完整包复制 `public/assets/local/` 和 `data/local-assets.json`。作者估计每个场景在进对局时另下载约 2–7 MB，各场景共用贴图约 3 MB；本机没有跑过提取，完整包因此增加的解压体积没有实测。

**3D 棋盘贴图的下载量**：每位玩家进入对局时都要从开服的电脑下载 3D 棋盘的 12 张贴图。提取时会给这 12 张各写一份 WebP（颜色贴图有损、质量 95，法线和数据贴图无损），清单里列的是 WebP，同名 PNG 留在旁边给裁切工具和 setup 用。这部分下载量从约 6.7 MB 降到约 2 MB，网速慢的远程联机最明显。只有 PNG 的本地素材（例如在这一改动之前提取的）可以用提取时的 Python 环境运行 `tools/local-extract/extract.py --webp` 就地补上，只需要 Pillow，不需要客户端。

**「玩法说明」教程图的下载量**（0.2.6 起）：本地提取的 19 页教程图每页 1.2–1.5 MB，玩家每翻一页都要从开服的电脑下载。提取时同样给每页写一份 WebP（有损，质量 90，放大两倍对比看不出差别），清单列 WebP，PNG 留在旁边；19 页合计从约 25.6 MB 降到约 4.2 MB。看说明时只预载下一页（以前前后两页都预载）。已经提取过的同样用 `tools/local-extract/extract.py --webp` 补上。

## 7. 打包发布（维护者）

打包命令默认在生成 ZIP 后执行启动冒烟检查（#568）：完整包、精简包分别解压到临时目录；更新包在
每个 `--from` 基础包的临时副本上覆盖。只用包内文件及运行依赖执行 `node server/index.js`，绑定
本机随机空闲端口，依次验证 `/healthz` 的版本、首页及 `/vendor/pixi.min.js`。不下载素材、不跑对局、
不加入系统 CI 矩阵。素材专用 ZIP 不含服务器，仍走素材包校验。
失败使打包命令返回非零，错误标明解压／启动／具体请求阶段；日志保留为 ZIP 旁的 `.smoke.log`
（更新包为 `.base-N.smoke.log`）。无论成功失败都关闭本次子进程并清理临时安装。
可单独重查：`node tools/package-smoke.mjs <release.zip> [base.zip或目录]`。`--no-install` 也不跳过冒烟，
因此缺少运行依赖的调试包会失败；`--dry-run` 不产生 ZIP，也不启动检查。


Releases 的 zip（完整包、精简包，0.2.1 起还有更新包）由 `tools/package.mjs` 生成，在**源码仓库**里运行（整合包里没有这个工具）：

```bash
npm run package -- --dry-run --list   # 只检查：列出每个文件和大小，不写任何文件（精简包加 --lite）
npm run package -- --out <目录>        # 完整包 Stronghold-Protocol-v<版本>.zip
npm run package:lite -- --out <目录>   # 精简包 Stronghold-Protocol-v<版本>-lite.zip
npm run package -- --update --from <旧版本的完整包>[,<…>] --out <目录>   # 更新包 Stronghold-Protocol-v<版本>-update.zip
```

完整包在打包机已经提取战场场景时带上 `public/assets/local/scene/`（`--dry-run` 摘要里的 `battlefield scenes` 一行）。还没有提取时完整包仍能打，棋盘用金属地块。要带上 11 个官方场景，先运行 `python3 tools/local-extract/fetch_scenes.py`，再用提取环境的 Python 运行 `tools/local-extract/extract.py --only scene`（或 `node tools/setup.mjs --scenes`），然后再 `npm run package`。精简包不带场景。`.cache/official-scenes/` 在拒绝名单里，不会打进任何包。`tools/local-extract/scenes.py` 和 `fetch_scenes.py` 必须先提交：打包读的是 `git ls-files`，未提交的脚本不会进玩家包。

- **打进去的**：`git ls-files` 里的 `server/`、`shared/`、`data/`、`public/`（不含 `public/dev/`）、`packs/`（随仓库提交的内容包；只在本机安装、没提交的不打进去）、`plugins/`（只允许 `README.md`、`AGENTS.md` 与 `_template/`，即使误跟踪服主插件也不打进去；服务器自己放进去的插件不会提交，也不打进去，见 [PLUGINS.md](PLUGINS.md)）、启动脚本、玩家会运行的工具（setup、vendor、fetch-assets 与 `tools/assets/`、doctor，以及 setup 调用的 `tools/local-extract/` 和 `crop-board-atlas.mjs`）、`tools/plugin.mjs`、`schemas/`、插件作者文档（`docs/PLUGINS.md`、`docs/PLUGIN-GUIDE.md`、`docs/PLUGIN-DSL.md`、`docs/PLUGIN-API.md` 与目录示例）、`test/helpers/battleHarness.js`（作者测试使用，只依赖包内的 server/shared）、服务器和 fetch-assets 读取的 4 张研究数据表（`docs/research/` 的 `03-operators`、`05-enemies`、`05-maps`、`07-assets` 四个 JSON）、`package.json` / `package-lock.json`、许可证与说明（`LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、`README.md`、`CHANGELOG.md`）、`docs/PLAYING.md` 和本文；然后在临时目录里生成 `packs/index.json`（打进去的语言包和内容包的列表，供纯静态托管使用；服务器自己会实时列出，见 [PACKS.md](PACKS.md)），再 `npm ci --omit=dev` 装上运行依赖和 `public/vendor`（含沙箱必需的 SES / Acorn 及其浏览器文件，玩家无需另装）。完整包再加上 `data/assets.json` 列出的素材、`public/fonts`，以及本地提取的 `public/assets/local/` 和 `data/local-assets.json`。磁盘上有、清单却没列出的文件不打进去（例如 0.2.0 移出自选的焰狐龙梓兰的旧素材）。日文干员语音（`audio.voiceJp`，`public/assets/audio/voice/jp/` 的 2674 个文件，约 85 MB，zip 后约 76 MB）默认也打进完整包；`tools/package.mjs` 里的开关 `FULL_ZIP_JP_VOICE` 改成 `false` 时，完整包（以及由它比较出的更新包）不带这些文件：玩家首次启动时 setup 会像精简包那样下载它们，下载完成前选「日本語」会播中文语音，更新包也不会删除玩家已有的日文语音。英语、韩语和本土语言配音（`audio.voiceEn` / `audio.voiceKr` / `audio.voiceNative`）同样默认打进完整包（5712 个文件，约 169 MB，zip 后约 157 MB）；开关是 `FULL_ZIP_OPTIONAL_VOICE`（`tools/package.mjs`，默认 `true`）。改成 `false` 时完整包不带这些文件，玩家首次启动时 setup 再下载，下载完成前缺的那一句播中文，更新包也不会删除玩家已有的这些配音。
- **不打进去的**：`test/` 除上述作者助手外的文件、维护用的工具（数据构建、golden、botbench、i18n、导入检查、本工具等）、`scripts/make-windows-bundle.mjs`（Windows 便携包，见 [WINDOWS.md](WINDOWS.md)）、其他文档、研究笔记和 `docs/img/`、`handoff/`、`.github/`、`types/`、lint / 编辑器 / Docker 配置。和 0.1.x 的整树打包（全部跟踪文件加上 `public/assets` 的全部内容）相比，0.2.0 的完整包少了约 640 个文件、解压后小约 26 MB，zip 小约 8 MB。
- **打包前的检查**（`--dry-run` 也全部做一遍）：拒绝名单（`pv`、`review`、`.cache`、`.claude`、`.git`、`logs`、`.env`、`scripts/service.env.cmd`、`handoff`、`test` 除精确允许的作者助手外、服主自己的插件、`plugins/_dist/` / `_moved/` 等）；每个打进去的模块的相对导入、玩家用的 npm 脚本（start / setup / doctor / launch / postinstall / vendor / assets）都指向包里的文件；完整包里 `data/assets.json` 和 `data/local-assets.json` 列出的文件都在（缺了先运行 `node tools/fetch-assets.mjs`）；没有只差大小写的两个路径；包里的文件（二进制素材也查）不含个人目录路径（`/Users/…`、`C:\Users\…`、`/home/…`）或本机的账户名（运行时从系统读取；`SP_PACKAGE_SCAN_NAMES=a,b` 可以再加名字）；打进去的已跟踪文件没有未提交的改动（重新生成的 `data/assets.json` 要先提交）。有任何问题都会列出原因、以非零状态结束，不写 zip；正式打包时还会核对临时目录里的文件和计划完全一致。
- **玩家包里的脚本和文档链接**：临时目录里的 `package.json` 只留下每条 `node <文件>` 都指向包内文件、并且至少指出一个文件的脚本（`start`、`dev`、`setup`、`doctor`、`launch`、`postinstall`、`vendor`、`assets`）。`test`、`golden`、数据构建、lint、本工具等不留，避免玩家运行 `npm test` 时在没有测试文件的情况下得到「0 个测试、成功退出」。`README.md`、`CHANGELOG.md`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、`docs/PLAYING.md`、本文、插件参考和作者指南里，指向包内没有的文件的相对链接改成该版本 GitHub 标签上的同一路径（版本号去掉末尾的 `-dev` 后加 `v`；图片用 `raw`，其余用 `blob`）；`../../releases/latest` 改为仓库的 Releases 地址。源码仓库里的这些文件仍是相对链接。
- **MANIFEST.json**：三种包的根目录都有（`npm ci` 之后写入）：除素材（`public/assets/`、`public/fonts/`、`data/assets.json`、`data/local-assets.json`，归 setup 管）以外每个文件的大小和 sha256，同一版本的三种包内容相同。`npm run doctor` 和更新包的启动检查（`server/update.js`）用它核对安装。
- **更新包**（0.2.1 起，每个版本都发）：`--from` 后面列出**此次支持升级的每个旧版本完整包**（Releases 上的 zip，或它解压出来、没动过的文件夹；逗号分隔或写多个 `--from`），例如发布 0.2.2 时 `--from Stronghold-Protocol-v0.2.0.zip,Stronghold-Protocol-v0.2.1.zip`。工具照常构建完整包的临时目录（`npm ci` 等），逐个文件（大小 + sha256）和每个旧版本比较：和任何一个旧版本不同、或旧版本没有的文件都打进去，所以一个更新包能覆盖在列出的每个版本上；旧版本有、新版本没有的文件记进 `UPDATE.json` 的 `removed`（连同各旧版本里的 sha256，玩家那边只删内容一致的文件；只差大小写的同名文件和 `.env` 之类的本机文件名不删，摘要里会列出）。旧版本必须比当前版本旧、带素材（不能是精简包或更新包）、每个版本只给一次，`--dry-run` 只读取并检查旧版本。更新包里还有新版本的 `MANIFEST.json` 和 `UPDATE.json`（适用的旧版本、文件数、字节数、文件列表和 `removed`），同样经过拒绝名单和个人信息检查；摘要列出和每个旧版本相比改动 / 新增 / 删除的文件数和更新包里各类文件的数量。发布时在 Releases 说明里写明更新包适用的版本（即 `--from` 列出的版本）。0.3.0 至少以 0.2.6 完整包为基线；新增的插件模块、Schemas、作者工具、模板、SES / Acorn 与前端库都会作为新增或改变的文件进入更新包。删除列表以实际基线比较为准，不要凭开发过程里曾出现过的页面名手写。`--keep-stage` 保留更新包目录和完整包的临时目录（`<目录>/Stronghold-Protocol-v<版本>-update/` 里的 `Stronghold-Protocol/` 和 `.full/`）。
- **素材包**（`--assets`，0.3.0 起，可选）：给标题画面「导入素材包」用的范例，只含这个版本导入时能收下的美术——`data/assets.json`、`data/local-assets.json`、`data/local-fx.json` 列出的文件（字体也在其中），按打包机上的语音和官方特效开关取舍，和完整包一致；不含清单本身（浏览器读的是服务器上的清单）、清单没有列出的本地提取残留文件，也不含任何代码。zip 里只有一个文件夹 `Stronghold-Protocol-v<版本>-assets/`，里面是 `public/assets/…`、`public/fonts/…` 和中英文说明 `README.txt`（是什么、对应哪个版本的清单、怎么导入；其他版本的服务器上，内容变了的文件校验不符、不会收下）。每个路径都带 `public/`，导入时整包按同一个前缀识别；说明文件是导入结果里唯一「跳过」的文件。打包前做和完整包相同的检查：清单列出的文件都在、没有只差大小写的路径、个人信息扫描（素材也查）、`data/assets.json` 已提交（`--allow-dirty` 跳过这一项）、开发版本要加 `--allow-dev`；`--dry-run [--list]` 只检查、不写文件。不运行 `npm ci`，也没有 `MANIFEST.json`。素材包要和发布的完整包用同一份素材来打：打包后又重新提取过本地素材（例如官方特效）就要重打，改过的文件在别人的服务器上会校验不符；本地提取的那部分（场景、官方特效等）也只对提供同一份提取结果的服务器（这个版本的完整包）有效，自己从其他客户端版本提取的服务器会拒收这些文件，其余照常导入。0.3.0 的素材包是 30936 个文件、990 MB，zip 约 711 MB。素材包**不附在 GitHub Release 上，也不提交到仓库**：维护者可以把它放到网盘等处另行提供下载；Releases 仍然只有完整包、精简包和更新包。
- **需要**：已下载素材的仓库（完整包）——打包前先联网运行一次 `node tools/fetch-assets.mjs`，补齐清单计划但本机还没有的素材（清单只列出磁盘上有的文件，打包工具看不出缺了哪些；`data/assets.json` 有变化就先提交）；能访问 npm 的网络（`npm ci`）；`zip`（或 bsdtar 的 `tar`，Windows 10 起自带）；更新包还要之前各版本的完整包（工具自己读 zip，不需要 `unzip`；Releases 上可以重新下载）。`--out` 默认是系统临时目录下的 `stronghold-protocol-release`，不能在仓库里面；`--force` 覆盖已有的 zip，`--keep-stage` 保留打包用的目录供检查。玩家侧按需取美术改走资源管理面板的预载 / ZIP 资源包（`npm run resources:packs`，见 2.5 节），0.3.0–0.3.2 的 `--assets` 素材包随旧导入界面一并移除。

## 8. 插件：服主策略文件（0.3.0 起）

插件放在 `plugins/<id>/`（见 [PLUGINS.md](PLUGINS.md) §2）。房主在房间的「插件」面板里开关：外观插件只换画面和声音，对局仍是原版；**改变玩法的插件**（数据 / DSL，以及显式启用的脚本）让这个房间玩一套自己的内容组合，每位博士的页面都会下载并逐字节校验，对局标为「非官方」，默认不计入统计总览（PLUGINS.md §11）。

房间能用哪些插件由服主决定：在 `plugins/` 里放一个可选的 `config.json`（和服务器自己的插件一样不会提交、不会被更新覆盖）。没有这个文件、且未开启脚本执行时，就是下面的默认值：

```json
{
  "rooms": "host",
  "default": [],
  "allow": ["*"],
  "classes": { "cosmetic": true, "content": true },
  "limits": { "maxSets": 4 },
  "allowIncompatible": false
}
```

| 字段 | 含义 |
|---|---|
| `rooms` | `"host"`：房主自己选插件（默认）；`"fixed"`：每个房间都固定用 `default` 里的插件，房主不能改；`"off"`：房间只玩原版（玩家在「设置」里给自己开的外观插件不受影响，它们不会进房间） |
| `default` | 新房间一开始就开着的插件 id（默认没有：原版） |
| `allow` | 房间可以用的插件：`["*"]` 全部，或列出 id |
| `classes` | 关掉某一类：例如 `{ "content": false }` 只允许外观插件；`classes` 按项覆盖默认值：默认允许 cosmetic/content；开启 sandbox 时再默认允许 script，trusted 模式再默认允许 trusted。其他未列出的类别不允许。ui 只供个人开启，不进房间组合 |
| `limits.maxSets` | 同时运行的「改变玩法」内容组合上限（0–64，默认 4）；超过时房主会看到「本服务器同时运行的插件组合已达上限，请稍后再试」 |
| `allowIncompatible` | 为其他游戏版本制作的改变玩法插件默认不能启用；设成 `true` 时大厅放行（房间里会提示）——但目前内容组合的构建本身仍会拒绝这类插件，所以暂时还开不了（DESIGN §32.6 待办）。外观插件只提示，不拦 |
| `allowDownloadHosts` | 按地址安装时额外允许的主机（字符串数组，默认没有）。一项是主机名（任意端口），或 `主机:端口`，IPv6 写成 `[地址]` 或 `[地址]:端口`。没有通配符。点名的主机才可以不是公网地址、才可以用 443 以外的端口。目录文件自己不能往这份名单里加。这个字段不参与房间策略；写错或文件坏了就当作没有额外主机，公网 https 下载不受影响。也可以用环境变量 `SP_PLUGIN_DOWNLOAD_ALLOW`（逗号分隔），和文件里的名单一起生效 |

- 环境变量 `SP_PLUGINS=off|host|fixed` 优先于文件里的 `rooms`，例如 `SP_PLUGINS=off npm start` 临时让所有房间只玩原版。
- 文件改了不用重启：房主下一次操作时（最多每秒检查一次）按新内容生效。写错的字段保持默认值，并在服务器日志里提示一次（`[plugins] …`）。
- 用了改变玩法插件的房间，对局在单独的子进程里运行（每套内容组合一个，同一组合的房间共用）：开发机实测子进程启动约 0.2 秒，载入数据和对局代码后约占 117 MB 内存（RSS），每个的堆上限 768 MB，最多同时 4 个，空闲 10 分钟后自动结束。子进程卡死（10 秒没有心跳）、崩溃或内存用尽时，只结束这套组合的对局，房间回到大厅并提示原因，服务器和其他房间不受影响。
- `SP_MATCH_HOST=worker` 改用 worker 线程（在服务器进程里运行，不另起 Node 进程）。**公网服务器不要用**：在 Node 22 上实测，worker 线程里一次性的超大分配用尽内存时，会让**整个服务器进程**退出（`FATAL ERROR: … Allocation failed`，退出码 134），原版房间也一起断开；子进程同样的情况只结束子进程。默认就是子进程（DESIGN §32.6）。
- `http://localhost:3000/healthz` 的 `content.sets` 是当前在用的改变玩法内容组合数。
- 按地址安装（[PLUGINS.md](PLUGINS.md) §17）只接受公网 https 的 443 端口，并且必须校验 zip 的 SHA-256；服务器下载后先检查再放入 `plugins/`，不执行包里的任何代码。内网、本机、链路本地和 `.local` 默认拒绝，重定向到这些地址或离开 https 也会拒绝。一次等待包含正文，不是每一跳重新计时。服主要放行某个主机，写在上面的 `allowDownloadHosts` 或 `SP_PLUGIN_DOWNLOAD_ALLOW` 里。
- 有人反馈问题时，诊断信息里的 `content:` 一行写着房间用的内容（`MODDED cs=… plugins=…` 表示开了改变玩法的插件），问题模板也会问「是否开了插件」。插件房间的问题请先找插件作者，并尽量在原版里复现。


### 测试控制台（0.3.1）

从本机或局域网打开插件工作台，使用启动窗口里的同一把钥匙，点击顶栏「测试控制台」；也可访问
`/studio/console.html`。它沿用工作台的访问限制和 `SP_STUDIO=off` 关闭开关，不新增端口。
场景在服务器校验，战斗在浏览器运行，不创建对局、不记战绩，也不修改普通房间。场景只保存在浏览器，
需长期保存或迁移时下载 JSON。操作见 [插件新手指南](PLUGIN-GUIDE.md#测试控制台)。

战斗沙盒只跑一场战斗，不创建房间。完整对局的测试房间默认关闭。

开启：环境变量 `SP_TEST_MODE=1`，或启动脚本 `scripts/start.sh --test-mode 1`（`scripts\start-windows.bat` 同样）。
不带取值的 `--test-mode` 等同于 `--test-mode 1`。取值 `off` / `1` / `force`。`off` 会去掉继承来的变量。`1`（以及 `true` / `yes` / `on` / `local`）在明确的本机或局域网地址上生效。默认绑定 `::` / `0.0.0.0` 时，看这台机器的网卡：非内部地址都是回环、私网（含 CGNAT `100.64.0.0/10`）、链路本地或 IPv6 ULA 时，按局域网接受 `1`（[ASSUMED] 路由器上的端口转发和写明局域网地址一样，由服主自己负责）。任一公网地址，或监听地址本身是公网，则 `1` 不开启，启动脚本和服务器日志用中文说明：仅本机用 `--host 127.0.0.1`，局域网用 `--host <局域网IP>`，要在公网监听上开则用 `--test-mode force`（或 `SP_TEST_MODE=force`）。`force` 在公网监听上仍会警告。写了认不出的值（例如 `forced`）保持关闭，并在启动时警告。
经公网反代转到本机回环的，仍按公网部署处理：进程只看自己绑定的地址和本机网卡。地址还不知道时（还没绑定）一律不开。没写这个变量就是关闭，欢迎消息里没有 `testMode`，大厅不显示「测试房间」，任何测试请求都拒绝。
服务器已经在运行时，`--test-mode` 不会改它，要先停掉再开。

谁能用：只有房主能建测试房，也只有当时的房主能下测试指令。同盟测试房可以有其他人，加入或观战前必须确认「测试」提示，最近房间入口和房间卡保留标记，指令仍只有房主能发。普通房间不能在开局前或对局中改成测试房。观战席不能发。

指令走对局自己的操作（加资金、获得棋子和装备、开回合、商店刷新、升级、悬赏、选策略、休整倒计时），不另写一套规则。可以改资金、把内容里有的棋子 / 装备 / 所属召唤物拿到手牌、改自己的目标生命、改领袖池生命和队伍生命、跳到某一回合或阶段、指定下一次商店、关掉或恢复阶段计时、设置盟约额外人数来激活盟约并叠到指定层数、换策略、升一级调度中心、加一条悬赏、替自己选一张机变。数量和 id 不对就拒绝，不会悄悄改成合法值。过长的 id 或字符串同样直接拒绝，不会裁短，也不会写进输入日志。每种指令 10 秒内最多 8 条，房客和观战席的尝试也计入，并且先计数再记审计。目标生命已经是 0 时，跳回合会按结算同样的方式淘汰；场上没有存活玩家就结束对局，不再进入新回合。生命写成 0 本身不立刻淘汰，下一场战斗仍会进入结算。跳进隐藏首领回合时，如果队伍生命还没合并过，会按决战开始时的方式合并。

记下什么：每一条送达测试对局的指令（包括拒绝）都进 `[test-audit ROOM]` 日志（谁、哪条、调度器时间、成功或错误码），局内面板能看到最近的记录。结算和回放带「测试」以及成功执行了几次。测试结果和退出都不保存到本地对局记录。服务端不授予称号、奖杯或奖励，统计、成就、徽章和卫戍认证也不算它；没有「含测试对局」开关。标记由服务端创建，不接受客户端更改。

此外，`[test-input ROOM]` JSON 日志记录初始配置、平台输入和实际触发的计时回调。被时间片切开的回调额外记下走了多少步，重演按这个步数停下，不再读墙钟。一局日志最多 4096 行；写满后该局标成不能重演，日志以一条 capped 记录结束，而不是悄悄截断。保留同一局从 init 开始的完整日志，使用同版本和同内容集的 `server/match/testReplay.js` 离线重演；它不是客户端接口。日志由原有服务端 logger 输出，不单独开文件。房间可复用，按 init 行区分局次。真实调度器上的测试局仍用 8 毫秒的机器人休整和服务器战斗时间片，虚拟时间才不限。

测试指令只改当前房间里房主自己的席位，不到别的房间、别人的私人状态、服务器文件或插件脚本。战斗沙盒仍只在浏览器里跑，不写服务器对局。官方 3D 场景和特效仍依赖第 6 节的本地素材。

## 9. 脚本沙箱与 CSP（0.3.0 起）

`SP_PLUGIN_SCRIPTS=sandbox` 开启 script 类的 SES 沙箱执行，默认关闭；trusted 类遵循第 10 节的原生执行门槛，永远
不进入此沙箱。用启动脚本开服时也可以不设环境变量，直接加参数：`scripts/start.sh --scripts sandbox`、
`scripts\start-windows.bat --scripts sandbox`；Windows 上双击 `scripts\start-windows-sandbox.bat` 等于后者（参数取
`off` / `sandbox` / `trusted` / `trusted-force`，`off` 会去掉继承来的环境变量；服务器已经在运行时参数不生效，要先停止它）。此开关允许公网部署，要求有效 lock 和全部文件字节一致，但不要求 trusted pin，也不要求逐人同意
（维护者 2026-10-14 确认）。房间标「脚本（沙箱）」；同一 SDK、描述符与预算已接通，不降级执行。所有玩法插件的浏览器战斗都在专用 Worker 中，卡死看门狗默认 2 秒。
首次应用未缓存的脚本时，每个插件的注册探测默认最多 5 秒，大厅（含原版房间）可能短暂停顿；`SP_SCRIPT_PROBE_MS` 可设为 500–60000 毫秒，慢机器可提高。成功与失败都会缓存，文件或设置变了需重新探测。
沙箱脚本服务器宿主强制子进程，忽略 `SP_MATCH_HOST=worker`；Node 22 `--permission` 只开放安装目录读取，没有写文件、
起子进程、起线程或原生扩展权限，通过 JSON IPC 收取内容，保留现有内存上限和心跳看门狗。

Node 22 权限模型不是恶意代码安全边界，且不限制网络。SES/V8 逃逸后仍可能访问内网、安装目录和已打开的文件描述符；
安装目录内指向外部的符号链接可能扩大可见范围，也可能被 Node 的真实路径权限检查拒绝。`node_modules` 必须实际装在安装目录里，不要链接到外部目录，否则沙箱可能无法加载 SES / Acorn。建议用低权限用户，最好部署在限制出站/内网访问、内存与 CPU 的容器中
[ASSUMED]。不要把启用沙箱等同于可以安全运行任何来源的插件。官方说明见
[Node 22 permissions](https://nodejs.org/docs/latest-v22.x/api/permissions.html)。

整站默认发送 CSP，覆盖主页、开发页面和 `/studio/`；importmap 用精确内容的 SHA-256 放行，页面没有 unsafe-eval。
字体保留 Google Fonts 域名，样式允许 unsafe-inline，图片允许 data/blob，媒体允许 'self' 和 blob:（玩家在本机选的大厅视频背景和
大厅音乐的时长检查，不加远程来源；反向代理不要拦截 blob: 媒体），WebSocket 与同源连接以及 blob Worker 保留。
Pixi 使用无动态求值的 uniform 适配器。服主可设 `SP_CSP=off` 关闭整站策略 [ASSUMED]；界面插件 `/p/` 和
模拟 Worker 自己的 CSP 不随此开关关闭。整站 connect-src 仅保留 'self'，现有同源 WebSocket 仍可连接。反向代理应保留 CSP 响应头，不要额外叠加会阻断 importmap 或 Worker 的策略。
Worker 响应单独允许 unsafe-eval 供 SES evaluate 使用，并设 `connect-src 'none'`。
受信任页面脚本从同源 `/cs/<cs16>/scripts/<id>/<entry>` 下发，先校验描述符与响应字节，再原生 import；
无需给页面 script-src 加 data:、blob: 或 unsafe-eval。script 与 trusted 混合组合整体按受信任处理，逐人同意。

CSP 和沙箱在 Chrome 里有浏览器测试（`SP_E2E=1 node --test test/ui/sandbox.e2e.test.js` 及 DESIGN §32.11 列出的套件）；
Firefox 和 Safari 还没有专门测过，遇到问题请附浏览器版本反馈。

## 10. Trusted script plugins（原生受信任执行，实验接口）

Scripts are off by default. After reviewing every file, pack the plugin and set `SP_PLUGIN_SCRIPTS=trusted`.
In `plugins/config.json`, add `"trusted": { "<id>": "<SHA-256 of plugin.lock.json>" }`. The exact lock and every
file must match; repack and repin after edits. The catalogue still lists disabled scripts with a refusal reason.

Bind to an explicit loopback or private LAN IP. Public addresses and wildcard listeners (`0.0.0.0`, `::`) refuse
trusted code; `SP_PLUGIN_SCRIPTS=trusted-force` explicitly overrides this [ASSUMED name]. The check uses the listening
address, never a request's address. If a public reverse proxy fronts the server, make the same public-deployment
`trusted-force` decision even when the listener is on a loopback address. Existing room class/allow policy still applies.
All numeric spellings of IPv6 zero, IPv4 0/8 and IPv4-mapped equivalents are refused;
the actual address returned after binding is checked again, and any refused trusted service is killed and reaped.

This executes native third-party code: it can control a player's whole game page, and server code can access the
server account's files and network. The lexical “sandboxable” label is not isolation. Every seated player must accept
the current content hash before starting; a red banner stays visible. Unconsenting spectators receive data/snapshots
only. Infinite loops in the page are not stopped by P3a's action budget. Use only code all participants trust.

Gameplay code always runs in a match child, including bots and SP_VERIFY; it never runs in the main server.
Experimental trusted server entries use a separate child and become active at startup. Restart to change/revoke those
entries; end an active match to revoke its already pinned snapshot. Activation/request timeouts (5 s), startup failures
and shutdown use SIGKILL and wait for that child to exit. Its 128 MB old-space heap limit is not a total memory or
subprocess sandbox. Health extensions are limited to 16 KiB of UTF-8 JSON per plugin.

Composition keeps the synchronous C1 interface: an uncached registration probe pauses the lobby for up to 5 s per
plugin (`SP_SCRIPT_PROBE_MS`, 500–60000: raise it on a slow machine, where starting the engine and SES takes longer),
including vanilla rooms — once per plugin version and settings, since results are cached. Probes use SIGKILL and cache successes/failures by plugin, lock, source descriptor and
settings (256 recent results). The explicit local `node tools/plugin.mjs test <id>` command authorizes execution
without server mode or trusted-pin checks; it is not evidence that those files match the production pin.
Full SDK, pinning, consent and limitations:
[PLUGINS §13](PLUGINS.md#13-scripts-p3a).

Node 22 的 `--permission` **不限制网络**（TCP/UDP/DNS/监听均可能可用）。安装根内指向外部的符号链接也会
扩大可读范围：不要在安装根中放此类链接，包括外链 node_modules、npm link 和配置/存储链接。建议使用容器或
网络命名空间限制出站与内网访问，并设置 OS 内存/CPU 限额。父进程已对日志、启动错误、发送帧、RPC 回复等 IPC
做形态和长度复核（DESIGN §32.11），但 Node 在复核前已解码 IPC，不能据此声称免疫内存炸弹或消息洪泛。

## 11. 官方版本（0.3.2 起）

除了现在的「第二期下半」（`act2autochess`），服务器还提供更早的三个官方版本：第二期上半（`act2autochess@V2_1`）、
第一期下半（`act1autochess`）、第一期上半（`act1autochess@V1_1`）。数据随发布包和 Docker 镜像一起提供（`data/versions/`）。
**不设置时四个版本都启用**（注册表顺序，默认版本仍是第二期下半），大厅右上角有「版本」。`npm start`、`scripts/start.sh` 和
`scripts/start-windows.bat` 不用加参数。`SP_VERSIONS=act2autochess`（或只含第二期下半的列表）收窄到这一个版本，大厅不显示版本按钮。
房间和消息里省略的版本字段仍表示代码常量 `act2autochess`（DESIGN §35.23.11）。

| 环境变量 | 作用 |
|---|---|
| `SP_VERSIONS` | 启用哪些版本。不设置等于 `all`（四个都开）。也可写 `all`，或逗号分隔的版本 id，例如 `SP_VERSIONS=act2autochess,act1autochess`。写错的 id 在启动日志里提示并忽略。`SP_VERSIONS=act2autochess` 只开第二期下半 |
| `SP_VERSION_DEFAULT` | 没有指定版本时新房间用哪个版本（默认第二期下半）；不在已启用列表里时提示，并改用第一个启用的版本 |
| `SP_MAX_VERSION_HOSTS` | 版本对局子进程的上限（默认等于启用的非默认版本数；只要还有非默认版本，至少为 1） |

- 启动日志会打印一行实际启用的版本，例如 `[versions] enabled: act2autochess (第二期下半, default), act1autochess (第一期下半)`。
- 玩家在大厅里自己选版本（浏览器记住）；房间的版本由房主发起切换，房间里所有真人同意才生效（只有一个真人时立即生效）。
- 非默认版本的对局在单独的子进程里运行（每个版本一个，同一版本的房间共用），和插件子进程分开计数。进程在该版本的第一局开局时才启动，
  空闲的服务器不会额外拉起进程。载入数据和对局代码后每个约占 100+ MB 内存 [ASSUMED：按插件子进程实测的约 117 MB 估计]，空闲 10 分钟后自动结束；
  冷启动约 0.2 秒到几秒。小主机内存紧张时用 `SP_VERSIONS` 只启用需要的版本，或用 `SP_MAX_VERSION_HOSTS` 限制同时存在的进程数。
- 这些房间的 AI 布阵试算总在服务器上算（不会交给房主浏览器），CPU 比默认版本的房间略高。
- 玩家第一次进入某个版本时，浏览器要下载该版本的数据（约 5 MB，之后缓存）。
- `http://localhost:3000/healthz` 在启用了非默认版本时多一项 `versions`（不设置时就会有）：启用的版本、默认版本和版本子进程的数量。空闲时 `workers` 为 0。
- 也可以在 `startServer({ versions: { enabled, default, maxHosts } })` 里设置（优先于环境变量）。

## 12. 容量与调优（服务端配额）

以下配额默认写死在代码里，都能用环境变量覆盖；显式传给 `startServer()` 的选项仍然优先，所以测试完全可控。
启动时会打一行日志，写明实际生效的值：

```
[http] limits: rooms 1000 (16/network), matches 8/network, sockets 2000 (64/network)
```

`0` 在两类配额上含义不同：**全局配额**（`SP_MAX_ROOMS`、`SP_MAX_CONNECTIONS`）取 `0` 是全部拒绝；**按网络配额**
（带 `_PER_ADDR` 的三个）取 `0` 才是不限制。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SP_MAX_ROOMS` | 1000 | 全局房间数上限（`0` = 全部拒绝）。满员后新建房间返回「服务器内部错误」 |
| `SP_MAX_ROOMS_PER_ADDR` | 16 | 单个客户端网络同时存在的房间数（`0` = 不限） |
| `SP_MAX_MATCHES_PER_ADDR` | 8 | 单个客户端网络同时进行的对局数（`0` = 不限） |
| `SP_MAX_CONNECTIONS` | 2000 | 并发 WebSocket 连接数（`0` = 全部拒绝）。全局满员时新连接在升级阶段返回 **503** |
| `SP_MAX_CONNECTIONS_PER_ADDR` | 64 | 单个客户端网络的并发连接数（`0` = 不限）。单个网络超限时在升级阶段返回 **429** |
| `SP_MAX_ONLINE` | 0 | 同时在线的**已认证玩家**上限（`0` = 不限）。满了只拒绝新会话（玩家看到「服务器已满」），重新连回来的 token 照常放行（只限在线人数这一层，见下面「重连不会被拒」的两条前提） |
| `SP_ROOM_CREATE_BURST` | 4 | 每网络「创建房间」动作的令牌桶容量（`server/roomProtection.js`，合并自用户分支；与上面的并发上限互补，限制的是*节奏*）。取 `0` 会因配置非法**拒绝启动** |
| `SP_ROOM_CREATE_REFILL_MS` | 15000 | 上述令牌的回填周期（ms） |
| `SP_MATCH_START_BURST` | 4 | 每网络「开始模拟」动作的令牌桶容量（匹配入场也走这里）。取 `0` 拒绝启动 |
| `SP_MATCH_START_REFILL_MS` | 30000 | 上述令牌的回填周期（ms） |

几点运维提醒：

- **503 / 429 只描述连接数配额。** 全局连接数满了是 **503**，只有单个网络连接数超限才是 **429**；两者都在升级阶段就结束，
  socket 根本建不起来，也不会进入游戏协议。另外两个配额不在这一层，别混着排查：**在线人数**（`SP_MAX_ONLINE`）满了是
  `hello` 之后才回的一帧「服务器已满」（已经带着 token 在玩的人不受影响），**房间数**上限满了是游戏内的错误回包。
- 「按网络」的口径来自 `clientAddress()`：只有在 `TRUST_PROXY` 允许时才会信任 `CF-Connecting-IP` / `X-Real-IP` /
  `X-Forwarded-For`，否则整条 NAT / CGNAT 后面的玩家会共用一个配额 —— 家里直连、没有反代时不要打开 `TRUST_PROXY=1`。
- 写了非法值（非整数、负数）会**告警并保持默认**，不会因为一个拼写错误把保护悄悄去掉。
- 「重连不会被拒」只在**在线人数**这一层成立，另外两个前提照样生效：**连接数**上限（`SP_MAX_CONNECTIONS`）满了，
  带 token 的连接同样在升级阶段被 **503** 挡住；会话还在另一条 socket 上活着时，`noReplace`（或更旧的 `claimAt`）
  会让这个 `hello` 回「会话已在别处使用」而不是接管，拿不回原来的身份。
- 房间要等它被真正从大厅移除（`disposeRoom`）才归还配额，玩家掉线不算：大厅断线宽限（`lobbyGraceMs`）和对局中的会话重连窗口是两只独立的时钟。
  前者管理未开局房间中的断线成员，后者管理对局重连；不能用其中一个期限推断另一个期限或整个房间的销毁时间。
  排查「明明没人了还开不出房」时，先看房间是否仍存在、是否正在等待断线成员。

### 进程级环境变量（Node / glibc，不由 `startServer()` 读）

这几个变量在 **Node 或 libc 启动时**就消费，不经过 `config.js`，也不出现在启动日志的 `[http] limits:` 行里。改完必须重启进程。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `MALLOC_ARENA_MAX` | glibc 默认 `8 × CPU 核数` | glibc malloc arena 上限。8 核默认 64；多 arena 各自管理空闲块、互不共享，`free()` 只标记不归内核，稳态大块分配下 RSS 会碎成几千个小 `rw-p` 段。设 `4` 收敛最干净（`rw-p` 总量比默认少约 16%），设 `2` 反而让 glibc 用 ≥500 MB 的 mmap 大段伺候多个 V8 隔离堆（§4 实测表）。**仅 glibc 生效**，alpine/musl 忽略 |
| `MALLOC_TRIM_THRESHOLD_` | glibc 默认（128 KB 量级、按 arena 动态） | 空闲块超过该阈值就 `madvise` 还给内核。默认已经够积极；小段占绝对多数时调低只会增加系统调用，**不建议随手改** |
| `UV_THREADPOOL_SIZE` | 4 | libuv 线程池（`fs`、异步 `zlib`）。本项目的 permessage-deflate 与检查点落盘都走它；调 `MALLOC_ARENA_MAX` 时与它对齐 |
| `NODE_OPTIONS=--max-old-space-size=…` | Node 默认 | V8 老生代上限。它管的是 JS 堆，**管不了堆外 Buffer / 原生分配**（`external` / `arrayBuffers` 在 `/healthz` 的 `performance` 块里），别拿它当 RSS 上限 |

诊断口径：`/healthz?traffic=1`（仅 loopback / 私网，见 §13）的 `performance.process.rssBytes` 与 `mainThread.memory.{externalBytes,arrayBuffersBytes}`
分开看——**heapUsed 平稳但 RSS 摆动 = 堆外 / 原生分配**。持久化检查点的 `checkpointsEncoded` 计数不能当 malloc churn 的佐证：`persist.js` 有版本脏检查
（实测跳过是编码的 9 倍）、编码在独立 Worker 里产出 JS string、代码路径没有 `Buffer.alloc/from`；稳态 churn 来自 WS 帧链（每帧字符串 + deflate 大块）。

### 模拟线程池（`SP_WORKERS`）

服务器用一个进程内的工作线程池跑 AI 布阵试算。`SP_WORKERS` 默认 **4**：`1`–`32` 取指定线程数，`0` 关闭线程池（试算回到主线程，和没有线程池时一样），留空、写错或超出范围也按 4。每个线程在第一次试算任务到来时才启动（空闲不占线程），启动时结构化克隆一份 sim 必需的数据子集（`server/data.js simWorkerData`，不含美术清单、表情、调参等 sim 路径读不到的表），开发机实测常驻内存约 **75–90 MB/线程**（全量克隆时约 130–135）。按机器调整：内存紧张的小主机设 `SP_WORKERS=0`，内存宽裕的机器可以调大。改完重启服务器后实测：

```bash
node tools/workerbench.mjs --workers 4 --battles 8
node --expose-gc tools/memorybench.mjs
```

第一条比较主线程与线程池的耗时、吞吐和主线程定时器延迟，第二条打印主进程与每个线程的常驻内存。启动日志里的 `[workers] simulation pool: …` 一行会写明实际生效的线程数或 `off`。

### 主线程 turn 预算（`SP_TURN_BUDGET_MS`）

libuv 在一次 timers turn 里一次性排空同一时刻到期的全部定时器：单片有界（bot 切片 8 ms、战斗 tick 20 ms），turn 本身没有界——turn 时长 = 该批到期回调之和。2026-11-07 的线上栈采样里，主线程所有 ≥150 ms 停顿共享同一入口（`processTimers → listOnTimeout → RealScheduler._wrap → match guard`：战斗 tick 切片、bot 布防规划 `planLayoutSteps` / `parseKey`）。

`SP_TURN_BUDGET_MS`（默认 **50**）给这个 turn 加预算：一轮累计派发达到预算后，后续到期回调用 `setTimeout(1)` 顺延到下一轮（仍走同一包装、记账一致；顺延中的工作被 `clearTimeout` / `clearInterval` / dispose 取消后不再执行）；一个 setImmediate（check 阶段，恰在两轮 timer 排空之间）把计数清零，饱和下不饿死。已经在跑的回调不抢占——单个不可切片的大调用（~120–170 ms 档）仍是残余尾巴。`0` = 完全关闭：关闸路径与改动前逐字节等价（无时钟读数、无额外句柄），是回滚口。

台架 A/B（bot 布防风暴：8 场对局 × 3 bot 持续重规划，1 ms JS 层采样器，ABBAABBA 8 轮取 min）：drift max 103.0 → 56.7 ms（−45%）、p99 91.9 → 55.3 ms（−40%）；关闸与 master 原版同噪声带（drift max 121.4 / p99 99.4）；开闸不降吞吐（规划完成数 911–951 vs 关闸 868–903）。见 docs/history/0.3.4.md §37.132。

### boss 接管追帧分片的墙钟预算（`SP_PACER_SKIP_BUDGET_MS`）

boss 场被服务器接管时（权威客户端离开 / 静默 / 报了不可信结果），`HeadlessPacer` 新建战斗并把追帧（快进到场钟）摊到一个个 33 ms 的泵间隔里做。每个间隔的追帧量原本只有一个**定数**上限（`CATCHUP_TICKS_PER_INTERVAL`，240 tick）：一个 tick 的真实成本随战场深度与主机负载放大时（线上 70–240 ms/块），每个间隔的停顿跟着放大——这就是线上 `server takeover` 后事件循环被抬 200–300 ms 的来源（docs/history/0.3.4.md §37.137）。

`SP_PACER_SKIP_BUDGET_MS`（默认 **8**）给每个间隔的追帧再加一道**墙钟**预算：间隔内从 `performance.now()` 起表，超过预算即停，余量下一轮续（每轮至少 1 tick，不饿死；预算内能跑多少跑多少，不强制跑满；240 tick 的定数上限保留为第二道界）。normal / 联防场的接管切片早就是墙钟有界的（`HEADLESS_SLICE_MS`），不走这条路径。追帧只改分片节奏，不改战斗数学：同样的 tick 序列、同样的结果，golden 零移动。`0` = 完全关闭：回到与改动前等价的纯定数行为（无时钟读数），是回滚口。

台架 A/B（真实 Match，g.test 跳轮 R14 boss 深战，战斗 10 s 后 `onDisconnect` 接管，1 ms 漂移采样器，ABBA + A3/B3 共 6 轮取 min）：接管后 2 s 窗口 drift max，关（A）11.75–40.25 ms / 开（B）8.80–15.47 ms；单块墙钟 A 无界（本台架最坏 40.2 ms；线上 70–240 ms）→ B 一律 ≤ 9.2 ms（预算 + 1 tick 过冲）。追帧完成墙钟：240 tick ≤ 预算时与旧版逐轮相同（同种子对局实测 107.9 vs 107.8 ms）；tick 单价更高（深战尾盘、慢核）时每多一轮 +33 ms——用完成时长换停顿有界正是本 knob 的取舍，`0` 可随时关闸（详见 §37.137 的原始轮次表）。

### 版本开机预热（`SP_VERSIONS_PREWARM`）

官方多版本（DESIGN §35.23）的数据原本在「第一个该版本的房间 / 清单请求 / 对局宿主」触到时才在主线程同步载入：readFileSync×16（~5 MB）+ JSON.parse + deepFreeze + official bounds，单版本 ≈ 3.4 s（2026-11-07 线上 18:49:22 窗口 max=3405.8 ms；重启恢复潮里带版本的房间同样触发，见 §37.133）。开机预热在**开监听和恢复存档之前**把每个启用非默认版本的 data + bounds + manifest 逐一走完（逐版本让出），此后四条路径全部命中内存。

`npm start`（进程入口）**默认开**；`startServer()` 的程序化调用（测试、工具、探针）默认关。`SP_VERSIONS_PREWARM=0`（或 `off` / `false` / `no`）是运维回滚口：立即回到惰性首载行为。单个版本载入失败只记 error 日志并跳过——该版本保持既有的「永久不可用」语义（`available` 拒绝、`welcome` 不列），启动绝不被阻断。开机成本 = 每个启用非默认版本 ~1–3 s（慢机/冷缓存；开发机热缓存 ~80–100 ms/版本），发生在无人连接的窗口；启动日志 `[versions] prewarmed: <id> <ms>…` 一行写明实测耗时。

### 结果校验（`SP_VERIFY`）

战斗在各玩家浏览器里模拟，服务器默认只按 spec 检查结果的形状和边界（`fields.js validateClientResult`），不重算。三档：

| 值 | 行为 |
| --- | --- |
| `off`（默认） | 只做边界校验：人数、击杀/漏怪上限、层数收益上限、金币上限、`perfect` 与漏怪自洽。结构上说得通就接受，零额外 CPU |
| `sample` | **诊断用，不是防线**。约 1/8 的战场在结果**已被接受之后**由服务器重算一次，不一致只写一条 warn 日志，不替换结果。用途是发现「同一份 spec 在两边跑出了不同结果」：数据版本没同步、插件内容漂移、页面没更新。抽样按 `battleId` 哈希，客户端可以自己算出来，所以别把它当防作弊 |
| `all` | 收到结果后先重算再接受，不一致就用服务器的结果。每场多一次完整战斗（实测正常场约 0.2 s、联防约 0.8 s CPU，8 ms 切片），四人房每轮约多 1–3 s |

一般服务器保持 `off`。怀疑客户端不同步时临时开 `sample` 看日志；只有「对局结果必须严格」的场合才用 `all`。

### 预载 / 公告相关变量（合并自用户分支）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SP_RESOURCE_PACK_ROUTES` | ModelScope 的 `Misyra/Arknight_Assets` 数据集模板 | 资源包发布位置：JSON 数组，元素是目录 URL、`….zip` 直链或含 `{file}` 的模板（2.5 节的「前往下载」与客户端分包索引按它取包）。设为空串关闭全部路由 |
| `SP_ASSETS_CDN` | （空 = 同源） | 素材 CDN 基地址；配置后素材 URL 走 CDN，`static.js` 不再从本机发素材 |
| `SP_ASSETS_CDN_VERSION` | 逐级回退 | CDN 发布版本：发布机生成的逐文件 `.assets-manifest.json` 优先（每个文件自己的 `?v=`），否则仓库的 `.assets-cdn-version`，再否则问 CDN 的 `/_v/latest`；都没有就发不带版本的 URL |
| `SP_DATA_CDN` | （空 = 同源 `/data/`） | 游戏数据 JSON 的 CDN 基地址 |
| `SP_ANNOUNCEMENT_FILE` | `config/announcements.json` | 公告排程文件（单源，热加载；`announcementFile: null` 关闭公告） |
| `SP_ANNOUNCEMENT_POLL_MS` | 10000 | 排程文件的热加载轮询间隔（ms） |

### 部署包必须携带的本机文件（2026-11-04 事故后固化）

用 `git archive` 打包时，下面这些文件**被 `.gitignore` 排除、不会进包**，必须从上一版 release（或本机）复制进去，否则上线后功能静默退化：

| 文件 | 丢了会怎样 |
| --- | --- |
| `data/resource-packs.json` | 预载**不再走 ModelScope 分包**，退化成逐文件下载（2026-11-04 实际发生：新 release 漏带，`/data/resource-packs.json` 404、manifest 的 `packs` 消失） |
| `.assets-manifest.json` | 素材 URL 失去逐文件 `?v=` 指纹，CDN 缓存无法按内容失效 |
| `data/asset-hashes.json` | 预载清单缺哈希，客户端无法跳过已缓存文件 |
| `data/local-fx.json` | 官方特效分组与文件清单缺失 |
| `data/local-assets.json` | 本地客户端素材清单缺失 |
| `data/skins-installed.json` | 已安装动态立绘记录丢失 |
| `public/fonts/` | 自托管字体缺失，页面回退系统字体；css2 分段（Noto Sans SC / Oxanium / Rajdhani，`webfonts.css` + `google/`）缺了用 `node tools/fetch-webfonts.mjs` 重新生成 |

**打包后自检**（在解压出的 release 目录里跑，任何一行是 `MISS` 就不要切换）：

```sh
for f in data/resource-packs.json .assets-manifest.json data/asset-hashes.json \
         data/local-fx.json data/local-assets.json data/skins-installed.json public/fonts/fonts.css public/fonts/webfonts.css; do
  [ -e "$f" ] && echo "OK   $f" || echo "MISS $f"
done
```

切换后立刻验证分包还在（`packs` 非空、首个包的 `urls` 首选 ModelScope）：

```sh
curl -s http://127.0.0.1:3000/data/resource-packs.json -o /dev/null -w 'index %{http_code}\n'
curl -s http://127.0.0.1:3000/data/resource-manifest.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log("packs",(m.packs||[]).length)})'
```

补文件**不需要重启**：`createResourceIndex` 每次请求都 stat 索引，放进去下一次请求就生效。
**素材 CDN 的缓存元数据**（`tools/r2-s3-upload.mjs` / `tools/r2-sync.mjs`）：桶里每个素材对象都带
`Cache-Control: public, max-age=31536000, immutable` 发布——客户端生成的每个素材地址都是内容钉死的
（逐文件 `?v=<哈希>`，清单缺失或没赶上时回退到发布 tag 的 `?v=<tag>`，`shared/assetCdn.js` 不再发裸地址），
字节不变 URL 就不变，一年期对 CDN 边缘和浏览器都安全（资源包 ZIP 的发布脚本一直是这个策略）。两点运维注意：

- **旧对象要迁移一次**：在本策略之前上传的对象带着旧的 `max-age=3600`，只有该文件下次变化重传时才会换新元数据。想让全桶立即生效，把发布机上的 `.assets-manifest.json` 挪开再跑一次发布工具（全量重传一遍，清单随后恢复）；期间 CDN 边缘可以先用一条缓存规则兜底。
- **Cloudflare 缓存规则（可选，立即生效）**：主机名选素材 CDN 的域名、URI 查询字符串包含 `v=` 时，边缘 TTL 选「忽略源站 Cache-Control，设为 1 年」（浏览器 TTL 同理）。带 `v=` 的地址内容钉死，永远安全；不带 `v=` 的地址（预载清单里的裸地址，只被预载/SW 的 no-store 取数和哈希校验消费）不进这条规则，维持源站元数据。

### 局内聊天（合并自用户分支）

局内聊天（交流面板的文字消息、敏感词过滤、违规禁言）**默认关闭**。打开后服务器在启动期就要求一套可用的
审核配置——缺密钥或词表解不开会**拒绝启动**，而不是等第一句话上线才发现；关闭时不要求任何密钥。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SP_CHAT_ENABLED` | `off` | `on`/`1` 开启局内聊天；取其它值拒绝启动（写错比静默关闭安全） |
| `SP_MODERATION_KEY` | （无） | 词表解密密钥，64 位十六进制。与 `SP_MODERATION_KEY_FILE` 二选一，环境变量优先 |
| `SP_MODERATION_KEY_FILE` | `.state/moderation.key` | 密钥文件路径（内容同样是 64 位十六进制）。**密钥不入 Git、不进任何公开目录** |
| `SP_MODERATION_LEXICON_FILE` | `server/moderation/lexicon/words.enc` | 加密词表路径（AES-256-GCM，`SPLEX001` 头） |
| `SP_CHAT_LOG_DIR` | `.state/chat-logs/` | 聊天审计日志目录（JSONL，逐条记录被拒/被禁言的消息）。目录绝不对外服务——指到公开目录会拒绝启动 |
| `SP_CHAT_LOG_COMPRESS_AFTER_DAYS` | 1 | 日志按天归档 gzip 前保留的天数 |
| `SP_CHAT_LOG_RETENTION_DAYS` | 30 | 日志保留天数；`0` 是显式永久保留（启动时告警一次） |

**词表要部署方自己重加密。** 仓库里的出厂 `words.enc` 是用作者私钥加密的，任何其它密钥都解不开它——
准备一份自己的 UTF-8 词表（一行一词，可含注释），生成密钥后重加密：

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > .state/moderation.key
node tools/encrypt-lexicon.mjs private-words.txt server/moderation/lexicon/words.enc
```

（`tools/encrypt-lexicon.mjs` 用 `.state/moderation.key` 或 `SP_MODERATION_KEY` 里的密钥加密，全程不回显密钥与词表内容。）
词表内容不入库——入库的只有密文 `words.enc`，明文词表留在部署机私有位置。

两点运维口径：禁言状态（违规计数与剩余禁言时长）只存在会话内存里，**服务器重启即清零**，审计日志是唯一的
追溯手段；聊天没有跨服共享的在线名单或 Redis 之类的依赖，审核全在本进程内完成（`server/moderation/`，
玩法描述见 [PLAYING.md](PLAYING.md) 的「交流」一节）。

### 断点续玩（服务器持久化，合并自用户分支）

会话、房间和**运行中的对局**会周期性落盘，进程重启后恢复：同一个 token 重连回来还是同一个玩家、同一个座位；
对局恢复到**最近一个安全检查点**——只在状态完全可序列化的阶段拍摄（信息确认 / 选策略 / 机变 / 回合开始 /
休整期），作战中重启的对局回到所在回合的开头把那一仗重打一遍。没到过检查点的对局（崩在开局最后几秒）恢复成
空房。玩法插件房与官方多版本房的对局跑在子进程宿主里，检查点取不回来：**房间保留、对局不恢复**，玩家重开一局。

**启用**：`npm start` 默认把状态写在 `.state/server-<PORT>/`（分片布局：`index.json` 元数据变化才写、
`runtime.json` 时钟每轮刷、`matches/<房间码>.json` 每房一片内容变化才写）。生产环境建议固定一个私有路径：

```powershell
$env:SP_STATE_FILE='E:\stronghold-data\game'   # 目录 → 分片；*.json 结尾 → 单文件；'off' → 关闭
npm start
```

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SP_STATE_FILE` | `.state/server-<PORT>` | 状态路径（目录 = 分片布局，`….json` = 单文件，`off` = 纯内存）。**绝不指向公开静态目录**（会拒绝启动）；空串当作没写，回退默认路径并告警 |
| `SP_STATE_SAVE_MS` | 10000 | 落盘周期（ms，最短 1000）。检查点事件（开局 / 休整期结束）即时合并进下一轮 |
| `SP_PERSIST_VERIFY` | （关） | `1` 反向自证版本脏判断：版本说「没变」也重新编码并比对，不一致计入 `/healthz` 的 `versionHoles` 并告警 |
| `SP_PERSIST_ENCODE_BUDGET` | 24 | 每轮落盘最多提交的检查点编码数（一次 capture 是整场对局的同步 clone，预算+逐房让出把它摊进多个 tick；被推后的房下一轮优先重编，checkpoint 至多陈旧一个落盘周期）。事件编码自 §37.131 起并入清扫，全部需求走此预算。`0` = 不设上限 | 
| `SP_PERSIST_EVENT_INLINE` | （关） | `1` 恢复 §37.131 前的行为：checkpoint 事件立即编码（不进预算）——恢复潮等相位对齐的房间里会成簇阻塞主线程，仅作回滚口 |
| `SP_REDIS_URL` / `REDIS_URL` | （空 = 用文件） | 改用 Redis 后端（`redis://` / `rediss://` / `unix:`），配了就不再写文件。**一个前缀只给一个游戏服**，两个进程同前缀会互相覆盖 |
| `SP_REDIS_PREFIX` | `stronghold:` | Redis 键前缀（`<前缀>index` / `runtime` / `cp:<房间码>`，与文件分片一一对应） |
| `SP_REDIS_TTL` | 90000 | 每次写刷新的键过期时间（秒，最小 60）；默认 25 小时 ≈ 最长重连窗口。**Redis 后端不配 AOF/RDB 时重启即丢**——推荐配置见 fork 的 deploy 文档；持久性弱于默认文件布局 |
| `SP_VALKEY_URL` | （空 = 不启用） | 改用 **Valkey 后端**（`valkey://` / `valkeys://`(TLS) / `redis://` / `rediss://`，可带 `user:pass@` 与 `/库号`）。零 npm 依赖——RESP 协议客户端是本仓自带的（`server/valkeyClient.js`，合并自 Stardust fork）。键布局与 Redis 后端完全相同（`<前缀>index` / `runtime` / `cp:<房间码>` / 旧版 `<前缀>state` 迁移键），配了就不再写文件，优先于 `SP_REDIS_URL` |
| `SP_VALKEY_PREFIX` | `stronghold:` | Valkey 键前缀；**一个前缀只给一个游戏服**，两个进程同前缀会互相覆盖（与文件后端的独占锁不同，这里靠约定，见下） |
| `SP_VALKEY_TTL` | 90000 | 每次写刷新的键过期时间（秒，最小 60；默认 25 小时 ≈ 最长重连窗口）。**不配持久化（AOF/RDB）的 Valkey 重启即丢**，持久性弱于默认文件布局 |
| `SP_VALKEY_PASSWORD_FILE` | （空） | 从文件读密码（去掉行尾换行）；URL 与文件里的密码都不会进日志。坏 URL / 读不到的密码文件会**拒绝启动**，不会悄悄退回文件后端 |
| `SP_VALKEY_CONNECT_TIMEOUT` / `SP_VALKEY_COMMAND_TIMEOUT` | 3000 / 4000 | 连接 / 单条命令超时（ms）。命令超时按「流是否有进展」计：还在到达中的大回复（满员大厅的启动读）不算停滞 |
| `SP_PERSIST_BACKEND` | （自动） | 显式指定后端：`valkey` / `redis` / `file`。缺省自动——`SP_VALKEY_URL` → Valkey，`SP_REDIS_URL` / `REDIS_URL` → Redis，都没配 → 文件 |
| `SP_GATE_PASSWORD` | （空 = 不启用） | 访问口令（门禁，见 2.7）。非空即启用：公网访客要先在 `/entry` 输入口令；本机 / 局域网默认免。中文口令请用 PowerShell 设置，cmd 的代码页会弄乱 |
| `SP_GATE_PASSWORD_FILE` | （空） | 从 UTF-8 文件读口令：首行、上限 1 KB、不 trim；文件不可读时**启动失败**（不静默开门）。`SP_GATE_PASSWORD` 优先。非 ASCII 口令推荐用它 |
| `SP_GATE_SECRET` | `.cache/gate-secret` | 门禁 cookie 的 HMAC 密钥；缺省自动生成 0600 文件，删掉等于让所有人重新登录 |
| `SP_GATE_TTL_DAYS` | 7 | 授权 cookie 有效期（天，1–365） |
| `SP_GATE_LOCAL` | `1` | `0` / `false` / `off` / `no`：本机与局域网也要口令；其余值免门禁 |
| `SP_GATE_LOCAL_BYPASS` | `1` | `0` / `false` / `off` / `no`：同上，关掉本机 / 局域网旁路——无头 TCP 隧道（frpc tcp、`ssh -R`）部署的专用开关，见 2.7 |

锁与备份：状态目录带独占锁（另一个活着的游戏进程拿同一路径会拒绝启动；陈锁按 pid 探活自动回收）。升级流程：
正常停服（关停时先写终档再关大厅）→ 备份状态目录 → 更新 → 启动。坏了的的单个分片只丢那个房间的对局，
其余照常恢复。`GET /healthz` 的 `persist` 块（`writes` / `failures` / `checkpoints` / `pendingLoad`…）是它的体检面：
`failures` 增长说明保存有问题，`pendingLoad: true` 说明启动读还没成功、在那之前不会写回以免覆盖存档。

**Valkey 后端（可选，合并自 Stardust fork）**。`SP_VALKEY_URL` 指向一个 Valkey / Redis 兼容存储时的语义：

- **原子性与写序**：一个房间一个检查点键（`<前缀>cp:<房间码>`，单键 SET 原子，没有半份可读）；每轮写按
  「分片 → index → runtime → 删除不再被点名的分片」落地——索引永远晚于它点名的分片，崩在任何一步都不会
  出现索引点名一个不存在的分片。与文件 / Redis 后端同一套键布局与读回形状，`restoreServer` 无需分支。
- **写锁**：`[ASSUMED]` 不加跨进程锁（与 Redis 后端同口径）——单键写由存储串行化，写序保证崩溃一致性；
  「一个前缀只给一个游戏服」是约定而不是强制，两个进程同前缀会互相覆盖。
- **降级**：存储连不上或命令失败，命令立即失败（不排队）、本轮保存记入 `failures`、服务器照常内存运行，
  之后每轮自动重试；**不会自动回退文件后端**（同一份状态悄悄写两处比显式改回 `SP_STATE_FILE` 更糟）。
  启动读不成功时 `pendingLoad` 挡住所有写，绝不覆盖没读回来的存档；`-LOADING`（存储还在加载数据集）与
  连接被拒 / 没回音一样按「暂时性失败」等它过去，拒密则立即定论。

## 13. 性能度量与监控面板（Prometheus / Grafana）

两块独立的东西，都不改变游戏本身的任何行为：

**性能度量（`/healthz` 的 `performance` 块）**。服务器进程自带一个只读采样器（`server/healthMetrics.js`，
移植自 Stardust fork）：每 10 秒采一次主线程的事件循环延迟（20 ms 分辨率的 p50 / p95 / p99 / max）、事件循环
利用率、GC 停顿（`gc.pauses` / `gc.totalMs` / `gc.maxMs`，窗口内停顿次数与总 / 最长时长，PerformanceObserver 异步
送来、按窗口清零）、CPU、内存，缓存在进程里，`/healthz` 读缓存而不是现算；采样器坏了只会降级成 `unavailable`，绝不会
影响服务。这个块和 `traffic` 一样**只给回环 / 私网客户端**：浏览器打开 `http://localhost:3000/healthz?traffic=1`
能看到，公网访问者拿到的是不含它的普通 `/healthz`。另有一个更细的本地日志采样器（`SP_LOOP_SAMPLE=1` 的
`[loop]` 行，见 §5）与之互补：前者进面板，后者带房间 / 阶段计数落日志。

**监控面板（`deploy/monitoring/`）**。Prometheus + Grafana 的 Docker Compose 部署资产，不进 npm scripts，
起法：

```sh
cd deploy/monitoring
cp monitoring.env.example monitoring.env   # 填 MONITOR_HEALTHZ_URL（默认本机 3000 端口）与 GRAFANA_ROOT_URL
docker compose --env-file monitoring.env -f compose.monitoring.yaml up -d
```

里面有一个 collector（把 `/healthz?traffic=1` 转成 `sp_*` Prometheus 指标，只拉固定 URL、不当 SSRF 代理）、
node-exporter（主机资源）、Prometheus（127.0.0.1:9090，保留 30 天 / 5 GB）和 Grafana（127.0.0.1:3160 的
`/monitor/`，中文仪表盘「卫戍协议 · 服务器状态」）。有效指标：连接 / 会话 / 房间 / 对局 / 人数、`performance`
窗口的延迟 / CPU / 内存、`persist` 存档计数、`traffic` 流量计数。完整起法、公开状态页、安全边界、
`sp_*` 指标清单与「fork 集群专用、本仓拿不到的指标」见 `deploy/monitoring/README.md`。

### allocator 调优的 A/B 观测（§4 / §12）

`MALLOC_ARENA_MAX` 必须在重启前后各采一段才能判断值定得对不对：只看 RSS 降了不够，得确认 event loop 没被
arena 锁拖毛。仓库自带只读脚本 `tools/allocator-observe.mjs`，在**游戏服务器本机**跑（`?traffic=1` 只对
loopback / 私网开放）：

```sh
# 重启前：30 分钟基线
node tools/allocator-observe.mjs --label before --minutes 30 > /tmp/alloc-before.jsonl

# 挂上 drop-in（写文件 + daemon-reload，不断线）→ 凌晨低峰 restart stronghold → 再采 30 分钟
node tools/allocator-observe.mjs --label after --minutes 30 > /tmp/alloc-after.jsonl

# 本地对比（离线，不联网）
node tools/allocator-observe.mjs --compare /tmp/alloc-before.jsonl /tmp/alloc-after.jsonl
```

脚本每 30 秒采一次：`/healthz?traffic=1` 的 `performance.process.rssBytes`、`mainThread.memory.*`、
`eventLoopDelayMs.p95/p99`、`persist.checkpointsEncoded/Skipped`，加上 `/proc/<MainPID>/smaps` 的 `rw-p`
段数 / 大小分布与 `/proc/<MainPID>/status` 的 `RssAnon` / `Threads`。默认从 `systemctl show -p MainPID --value
stronghold` 取 pid（每次重取，期间重启过也能跟上）；非 systemd 部署用 `--pid <n>` 钉死、`--unit <name>` 改服务名。
全程只读，不重启、不写服务配置。

对比输出按 **min / p50 / p95 / max** 给每个指标的 before/after（本机负载噪声大，按项目惯例用 min 逼近
无干扰下界，p95 抓毛刺）。判读：

- **RSS 与 `rw-p` 段数收敛**（min…max 区间变窄、`smallSegments` / `under1MB` 下降）= arena 收敛生效；
- **`eventLoopDelayMs.p95` 与 `cpuPercent` 不恶化** = `4` 这个值没引入明显争用；p95 明显抬头而 RSS 收益有限 → 试 `8`；
  出现 ≥500 MB 的 `rw-p` 段 → 别再往下压（试 `8` 或回默认）。
- **RSS 仍上蹿** → 再考虑叠加 `MALLOC_TRIM_THRESHOLD_`，并回头查 WS 帧链有没有新的堆外大块分配路径。

`checkpointsEncoded` 只作上下文，**不是** malloc churn 的指标（§12 已说明脏检查与 Worker 编码）。

## 14. 主线程调度优先级（systemd `Nice=-20`）

给 systemd 常驻部署（§4 的 Linux 单元，生产 `User=stronghold`、8 核、`Nice=0`）把服务进程的调度
优先级提到 `Nice=-20`：晚高峰页面加载海啸 / 断线风暴时，主线程事件循环不再和本机其他进程平等抢
CPU，压掉生产观测到的偶发 1.2–2.9 s 阻塞（`sp_event_loop_delay` max）。drop-in 片段在
`deploy/main-thread-priority.conf`，应用 / 验证 / 回滚 / 收益判读（复用 §13 的
`tools/allocator-observe.mjs` 做 before/after）的完整说明在 `deploy/README.md`，这里只写决策面：

- **何时该用**：裸机 / VM 上 systemd 常驻、本机有会抢 CPU 的其他负载（备份、日志轮转、其他用户
  进程），且 `sp_event_loop_delay` / `[loop]` 数据显示争抢时段有阻塞尖峰。
- **何时不该用**：Docker 部署（`Nice=` 要写进 compose 的 `ulimits`/`cpus` 语境，语义不同，本仓
  未做）；容器 / cgroup 已有 CPU 硬限额的（nice 在限额内排队，提了也白提）；机器独占、没有其他
  负载可争时收益趋近于零。
- **边界要知道**：只在 CPU 争抢时起作用，不增加配额、不是实时调度；`Nice=` 对整个进程生效——
  systemd 在降权前设置负值，之后 Node 的 worker_threads 继承 -20，「主线程 -20、Worker 0」的
  内部对比被弱化，但「赢过本机其他进程」不受影响。
- **第二步（可选，暂缓）**：只提主线程的 root helper + watcher（Stardust fork 的
  `deploy/stardust/MAIN-THREAD-PRIORITY.md` 方案，Worker 线程保持 0）。暂缓理由与验收标准见
  `deploy/README.md`；等第一步的 A/B 与 `SP_LOOP_SAMPLE=1` 的 `[loop]` 数据说明残余尖峰确实
  来自 Worker 争抢再考虑。本条规则记录在 DESIGN §37.128。
