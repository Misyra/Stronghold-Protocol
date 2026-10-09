# 卫戍协议：盟约 · Stronghold Protocol: Alliance

《明日方舟》季节性自走棋塔防玩法「卫戍协议：盟约」的**非官方同人复刻**：浏览器即开即玩，单人或 1–4 人联机合作。

![version](https://img.shields.io/badge/version-0.2.2-2ea44f)
![license](https://img.shields.io/badge/code%20license-GPL--3.0--or--later-blue)
![node](https://img.shields.io/badge/node-22%20%7C%2024-339933)

## 声明

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**，未获其授权或认可。
> - 《明日方舟》及「卫戍协议」相关的名称、角色、美术、音乐、音效、文本与数据等素材，版权归原权利人所有。这些素材**不适用**本项目的 GPL-3.0 许可证；GPL 只覆盖本项目自己编写的代码。
> - 仅供学习交流与个人非商业使用。**严禁任何形式的盈利**，包括但不限于：售卖本项目或整合包、付费下载或付费分发、收费服务器或收费代开、广告 / 打赏 / 会员等变现方式，以及其他任何商业用途。
> - 仓库源码不包含游戏的美术与音频素材（只有由官方数据表生成的数据和几张游戏截图，同样不适用 GPL）；[Releases](../../releases/latest) 中的整合包为了方便玩家附带了素材，下载即视为同意本声明。请勿将素材用于本项目以外的用途或单独再分发。完整条款见 [NOTICE.md](NOTICE.md)。
> - 权利人如认为本项目侵犯其权益，请通过 Issue 或邮件 **misyra@163.com** 联系，我们会**立即删除**相关内容。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。

English summary: [below](#english).

| 同盟房间 | 策略轮选 | 休整期（商店 / 盟约） |
|---|---|---|
| ![房间](docs/img/room.jpg) | ![策略](docs/img/band-draft.jpg) | ![休整期](docs/img/prep.jpg) |
| **部署方向轮盘** | **作战** | **最终攻势** |
| ![方向](docs/img/facing-wheel.jpg) | ![作战](docs/img/combat.jpg) | ![最终攻势](docs/img/final-assault.jpg) |

## 目录

- [声明](#声明) · [简介](#简介) · [本分支差异](#本分支差异) · [功能一览](#功能一览)
- [快速开始](#快速开始)：[整合包](#方式一整合包推荐) · [从源码运行](#方式二从源码运行) · [系统要求](#系统要求) · [端口与配置](#端口与配置) · [局域网联机](#和朋友一起玩局域网)
- [联机方式](#联机方式) · [操作](#操作) · [文档](#文档) · [开发与测试](#开发与测试) · [项目结构](#项目结构)
- [许可证](#许可证) · [致谢与数据来源](#致谢与数据来源) · [贡献](#贡献)

## 简介

「卫戍协议：盟约」是自走棋 + 塔防：休整期在调度中心招募干员、摆阵、配装备，作战期干员自动部署，迎击从红门涌来的敌人，漏过去的敌人扣目标生命值。本项目在浏览器里复刻了这一玩法，规则和数值尽量对照官方数据表与 PRTS 核对。

- **独立模拟**（单人）与**同盟模拟**（1–4 人**合作**，没有 PvP；空位可以加 AI 队友）。
- 服务器是一个 Node.js 程序，**战斗在各玩家的浏览器里模拟**（和官方一样），服务器只管经济与回合，一台低功耗小主机就能开服。
- 当前版本 0.2.2：干员可以单独设置潜能和练度（默认满潜、精英2 Lv.60），新增日文语音和统计数据页，按官方补上失衡、整数秒攻击间隔 30 帧等规则，并修复了 0.2.1 发布后玩家和 GitHub 上反馈的问题，详见 [CHANGELOG.md](CHANGELOG.md)。仍有少数规则按推断实现，与官方不一致的地方欢迎在 Issue 里反馈。

## 本分支差异

本分支基于主上游 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)，已同步至 **v0.2.2**，在其之上独立维护，差异集中在服务端运维与客户端体验：

| 方面 | 本分支的做法 |
|---|---|
| 服务端断点恢复 | 默认把身份、房间与安全阶段的对局写入 `.state/` 文件快照，零外部依赖，重启后玩家凭原身份回到对局；见 [docs/operations/PERSISTENCE.md](docs/operations/PERSISTENCE.md) |
| 本地对局记录 | 结算时在浏览器保存最近 100 局，可查看阵容统计、导出 JSON；见 [docs/guides/MATCH_HISTORY.md](docs/guides/MATCH_HISTORY.md) |
| 资源预载 | 移植 xinhai 资源管理更新：必备／可选分类、ZIP 导入导出、旧包完整性校验及增量补齐；在按文件 hash 增量预载之上加固：跨版本缓存别名复用（升级不重下）、会话内断点续传、流式大小上限、hash 不符一律拒收；已在 Cloudflare CDN 实测，见 [docs/operations/CDN.md](docs/operations/CDN.md) |
| 匹配 | 「同站四人」纯真人匹配：凑满 4 名真人才开局，不补 AI，断线自动出队 |
| 维护公告 | 单条维护公告进入游戏即显示（主菜单、大厅与对局全程）、可关闭：设置 `SP_ANNOUNCEMENT_URL` 由运维面板统一发布（约 10 秒轮询热生效），或用本地文件 `SP_ANNOUNCEMENT_FILE` 热加载；配 `GET /api/announcement` |
| 外部接口 | 只读房间状态 `GET /api/rooms/<房间码>/status`、延迟探测 `GET /api/ping`（供外部中间页使用）；见 [docs/development/CUSTOM_API.md](docs/development/CUSTOM_API.md) |
| 状态增量传输 | 支持协商的客户端首次全量同步，后续只传公共／私人状态变化；基线失配自动全量恢复，兼容旧客户端；见 [传输说明](docs/development/STATE_DELTA.md) |
| WebSocket 压缩 | 低等级 permessage-deflate（level 1、1 KiB 阈值），`SP_WS_COMPRESSION=off` 可关闭；配置非法直接拒绝启动 |
| 性能优化 | Bot 布局增量求值、预演不记录无人消费的事件、战斗调度器单趟扫描等热路径优化；见 [docs/development/PERFORMANCE.md](docs/development/PERFORMANCE.md) |
| 素材与部署 | Git 仓库内附带 v0.1.3 本地客户端素材（`public/assets/local/`），源码部署无需本机提取；另附 nginx 多核配置示例 |

另一个活跃分支 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol) 与本分支平行发展、同样基于 v0.1.3，思路不同、互有取舍：它把持久化放在 Redis（专用持久化 Worker 负责编码，可恢复不挂房间的匹配对局）、匹配走 solo/coop 队列（组队整体入队、60 秒后可由 AI 补位、支持无房间的独立对局）、内置受配额保护的开发者控制台（每回合 5 次 / 每局 50 次发放干员、装备、盟约）、全站定时公告与在线人数推送、资源清单 ETag/304 再验证、`SP_DATA_CDN` 数据外移与 `SP_MAX_*` 容量环境变量；本分支则在预载健壮性、Bot/战斗热路径性能、零依赖持久化、本地对局记录与压缩调优上更完整，并坚持纯真人匹配。可按自己的运营形态选用或互相借鉴。

其中本分支的共享 worker 线程池、资源预载与服务端对局检查点/恢复，分别移植改编自 xinhai-ai 分支的对应实现（commit `2e89a90`、`20524bb`、`234dc52b` 等，双方均为 GPL-3.0-or-later），并按本分支的存储、CDN 与性能方案做了改造；相关文件头部有 `Adapted from xinhai-ai/Stronghold-Protocol` 标注，细节见 [docs/development/PERFORMANCE.md](docs/development/PERFORMANCE.md)、[docs/operations/CDN.md](docs/operations/CDN.md) 与 [docs/operations/PERSISTENCE.md](docs/operations/PERSISTENCE.md)。

## 功能一览

- **完整的一局**：确认本局信息 → 策略轮选（40 名策略）→ 14 回合 → 结算称号；险境及以上满足条件时进入第 15 回合「隐秘核心」。
- **4 种难度**：标准 / 险境 / 绝境 / 终极，独立与同盟各一套参数，均取自官方数据。
- **休整期**：招募、刷新、冻结、升级调度中心；整备区与临时整备区；从整备区拖到棋盘部署，用**方向轮盘**选择朝向。同盟模拟的卡池共用。
- **晋升精锐**：3 名同名干员自动合成精锐，并获得一次高一阶的免费招募。
- **干员与调配**：112 名可招募干员（+ 精锐）及其技能、天赋和特质；开局前可以为每名干员选择携带的技能（283 个技能全部手工实现）和精锐的模组。
- **盟约与层数**：23 个盟约（8 个势力核心盟约 + 附加盟约），层数整局保留，每个盟约最多 999 层。
- **装备与机变**：装备与法术，同名装备合成、特定组合赋予盟约效果；已配发的装备锁定在干员身上。部分回合开始前有机变选卡（装备、资金、干员、层数、悬赏等）。
- **自动作战**：技能按官方「技能策略」自动释放；按接触半径阻挡，阻挡者倒下时由接触的干员接替；元素损伤与元素爆发；召唤物由玩家手动摆放；推开 / 拉拽按力度与重量计算；被击倒的干员留在原地显示再部署倒计时。
- **地形与敌人**：阻隔工事、射击台、源石流吹风机、沼泽、排气格栅、涨潮等地形装置；空中与近地悬浮敌人、悬赏敌人。
- **联防**：有人漏怪、又有人完美作战时，完美作战的队友带着阵容帮忙拦截漏掉的敌人。
- **最终攻势与隐秘核心**：两人共享一个战场，全队共同削减同一条领袖血条；10 个敌方领袖，巨型领袖约 5×3 格的受击范围，以及官方的限伤规则。
- **结算称号**：卫戍之星、不朽盟约、坚若磐石等 6 个称号。
- **本地对局记录**：结算时自动保存最近 100 局，在首页、大厅或结算页点击「对局记录」查看阵容与统计，支持 JSON 导出、删除和清空。记录保存在当前浏览器和当前站点；清除网站数据会删除记录。详见 [本地记录说明](docs/guides/MATCH_HISTORY.md)。
- **服务端断点恢复**：正常启动默认把身份、房间和安全阶段的对局状态保存到 `.state/`。保留此目录并使用兼容版本升级，重启后玩家可凭原身份回到对局；战斗中断时恢复到最近的检查点，重打该回合。详见 [持久化部署说明](docs/operations/PERSISTENCE.md)。
- **断线重连**：同盟模拟断线后 10 分钟内重新打开页面即可回到原座位，掉线期间按原阵容自动作战，也可以「暂离」交给 AI 托管；独立模拟 24 小时内可以回来继续（同一个浏览器）。
- **交互细节**：漏怪时顶栏的目标生命值实时减少（结算时确定）；点选、拖放和配发装备都按地上的方格；购买、升级和机变选卡都需要点两次确认；只有一名玩家时除作战外不计时。
- **画面与声音**：真实 Spine 小人、官方 BGM 与音效、表情（6 套 × 6 个）、作战特效；官方 3D 棋盘（本分支已附带贴图，需浏览器支持 WebGL2）。
- **手机与电脑**：触摸拖拽、长按查看详情，推荐横屏；设置里可以调低画质。

## 快速开始

### 方式一：整合包（推荐）

[Releases](../../releases/latest) 里有两种整合包，代码和运行依赖完全相同，二选一；已经装好 0.2.x 的，升级时只下载更新包即可：

- **完整包** `Stronghold-Protocol-v<版本>.zip`（约 505 MB，解压后约 710 MB）：附带全部美术 / 音频（含中文、日文两套干员语音和官方 3D 棋盘贴图），解压就能玩，不需要再下载任何东西。**推荐。**
- **精简包** `Stronghold-Protocol-v<版本>-lite.zip`（约 22 MB）：不带素材，第一次启动时自动从公开镜像下载美术、Spine 模型、音频、字体、表情和「玩法说明」教程图（约 550 MB，可中断，再次启动会续传）；官方 3D 棋盘等本地客户端素材不在其中（见下面的「本地客户端素材」）。适合下载大文件不方便的情况。
- **更新包** `Stronghold-Protocol-v<版本>-update.zip`（0.2.1 起提供，大小看改动多少，通常只有几 MB）：只含比之前的 0.2.x 版本改动过的文件，用来把已经装好的 0.2.x（完整包或精简包装的都行）升级到新版本，不用重新下载整个包。用法：先停止服务器（关掉窗口；装了开机自启的运行 `scripts\install-service-windows.ps1 -Stop`），把 zip 里 `Stronghold-Protocol` 文件夹的全部内容合并到安装文件夹、覆盖同名文件（Windows 资源管理器里复制粘贴即可；macOS 不要用访达拖放，它会整个替换文件夹，请用 `unzip -o`，见 [docs/operations/DEPLOY.md](docs/operations/DEPLOY.md) 第 1.5 节），再照常启动。启动时会先核对全部程序文件、删除新版本不再用的旧文件，然后正常运行；如果这个文件夹不是更新包对应的版本（例如 0.1.x，或者程序文件被改过），会提示下载完整包，服务器不启动。全新安装请用完整包或精简包。

两种包都只含运行和部署需要的文件（服务器、客户端、数据、启动脚本、setup / doctor / 素材下载工具、许可证与说明、[docs/guides/PLAYING.md](docs/guides/PLAYING.md) 和 [docs/operations/DEPLOY.md](docs/operations/DEPLOY.md)）；测试、开发工具和设计文档只在源码仓库里。

1. **安装 Node.js 22 或 24（LTS）**
   - Windows：在 PowerShell 里运行 `winget install OpenJS.NodeJS.LTS`，或到 <https://nodejs.org/zh-cn/download> 下载安装包。
   - macOS：`brew install node@22`，或到官网下载安装包。
   - Linux：发行版的包管理器、nvm 或 fnm。
2. **下载**：在 [Releases](../../releases/latest) 页面下载最新版本的完整包（或精简包），解压到一个路径较短的文件夹（Windows 上建议不要放在 OneDrive 同步的目录里）。
3. **启动**
   - Windows：双击 **`scripts\start-windows.bat`**。如果弹出「安全警告」，点「运行」；Windows 防火墙弹窗请勾选「专用网络」并允许。
   - macOS / Linux：在解压出的文件夹里运行 `./scripts/start.sh`（或 `bash scripts/start.sh`）。
4. 浏览器会自动打开 `http://localhost:3000`。窗口里列出的局域网地址可以直接发给同一网络的朋友。关闭窗口（或按 `Ctrl+C`）即停止服务器。

### 方式二：从源码运行

```bash
git clone https://github.com/sganggs/Stronghold-Protocol.git
cd Stronghold-Protocol
npm install        # 安装依赖（postinstall 会把 pixi / preact / three 复制到 public/vendor）
npm run setup      # 检查环境，并从公开镜像下载约 550 MB 美术 / 音频（可中断，再次运行会续传）
npm start          # 启动服务器：http://localhost:3000
```

也可以直接运行启动脚本（Windows `scripts\start-windows.bat`，macOS / Linux `scripts/start.sh`）：首次会自动安装依赖、下载素材，然后启动服务器并打开浏览器。

- **本地客户端素材**：本分支已提交上游 v0.1.3 完整包中的这部分素材和清单，git pull 后重启即可使用（3D 棋盘、部分界面图标与源石虫模型）。0.2.0 新增的 39 个召唤物官方模型不在其中：需要召唤物模型的源码部署，运行一次 `npm run setup -- --local` 提取，或从同版本完整包复制 `public/assets/local/`。以下为原始上游的提取方式：官方 3D 棋盘、部分官方界面图标（交流按钮与表情面板的边框、模组类型图标等）、灼热 / 炽焰源石虫和 39 个召唤物（多数自选召唤物）的官方模型需要从本机的《明日方舟》PC 客户端提取（Windows 原生客户端、macOS 的 CrossOver 或 PlayCover）。`npm run setup` 检测到客户端时会询问是否提取（需要 Python 3.8+，依赖装在项目内的 `.venv-extract`，不影响系统）；之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<…/StreamingAssets/AB/Windows>"` 指定路径。没有客户端时游戏照常运行，这几样换成替代样式：2D 棋盘、样式相近的图标、染色的普通源石虫、召唤物头像。表情和「玩法说明」的教程图随上面的素材一起从公开镜像下载，不需要客户端。没有客户端的服务器（例如 Linux VPS）也可以从**同一版本**的整合包里复制 `public/assets/local/` 和 `data/local-assets.json`，见 [docs/operations/DEPLOY.md](docs/operations/DEPLOY.md) 的「本地客户端素材」。
- 素材下载优先使用 GitHub，失败时自动改用 jsDelivr 镜像。
- `npm run doctor`（即 `node tools/doctor.mjs`）可以随时诊断：Node 版本、素材是否完整、端口占用、局域网地址和防火墙。

### 系统要求

| 项目 | 要求 |
|---|---|
| 开服的电脑 | Windows / macOS / Linux，Node.js 22 或 24（LTS）；磁盘约 700–850 MB（素材、依赖与本地提取贴图：完整包解压后约 710 MB）；内存空闲约 100 MB，每局再加几 MB |
| 玩家 | 支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版），电脑、手机或平板（横屏） |
| 网络 | 首次进入游戏时，每位玩家要从开服的电脑下载几十 MB 素材（之后走浏览器缓存）；对局中流量很小 |

显卡较弱时可以在「设置」里调低画质，或在网址后加 `?board=2d`（强制 2D 棋盘）/ `?render=fallback`（不用 WebGL 的简化画面）。

### 端口与配置

默认监听 **TCP 3000**。换端口：启动脚本加 `--port 3001`，或设置环境变量 `PORT`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `::` | 监听地址。默认 `::` 是双栈：同一个端口同时接受 IPv6 和 IPv4；`0.0.0.0` = 只 IPv4；`127.0.0.1` = 只允许本机，放在反向代理后面时使用 |
| `SP_COMBAT` | `client` | `client`：各玩家浏览器模拟自己的战斗（服务器负载极低）；`server`：由服务器模拟并推流 |
| `SP_VERIFY` | `off` | 服务器复算客户端上报的战斗结果：`off` / `sample`（约 1/8 抽查）/ `all`（全部复算，更耗 CPU） |
| `SP_WS_COMPRESSION` | `on` | WebSocket 状态消息压缩：`on` 开启低等级压缩；`off` 关闭。减少出网，但增加 CPU 和每连接内存；高并发部署先小流量验证 |
| `SP_ANNOUNCEMENT_URL` | 空 | 运维面板公告源：设为 `https://<面板域名>/api/announce/v1/<站id>` 后按间隔轮询拉取，热生效，断源保留最后有效公告；设置后本地公告文件不再参与。见 [部署指南](docs/operations/DEPLOY.md#16-维护公告) |
| `SP_ANNOUNCEMENT_POLL_MS` | `10000` | 公告源拉取间隔毫秒，允许 3000–600000；仅与 `SP_ANNOUNCEMENT_URL` 搭配 |
| `SP_ANNOUNCEMENT_FILE` | `announcement.json` | 维护公告配置文件；相对路径以项目根目录为基准，修改后自动生效。设置内容、截止时间和关闭方式见 [部署指南](docs/operations/DEPLOY.md#16-维护公告) |
| `TRUST_PROXY` | `auto` | 是否信任 `X-Forwarded-For` 等转发头：`auto` 只信任来自本机 / 内网的代理；`1` 总是；`0` 从不 |
| `DEBUG` | 空 | 设为任意值输出详细日志 |
| `SP_NO_BROWSER` | 空 | 设为 `1` 时启动脚本不自动打开浏览器 |

设置方式：macOS / Linux `PORT=8080 npm start`；PowerShell `$env:PORT=8080; npm start`；cmd `set "PORT=8080" && npm start`。健康检查：`GET /healthz`。

### 和朋友一起玩（局域网）

1. 打开页面 → 输入昵称 → **同盟模拟** → 创建房间。房主选择难度，可以添加 / 移除 AI 队友；开始前也可以把其他博士移出房间（对方可凭密钥重新加入）。
2. 把 4 位字母的**同盟密钥**，或「复制链接」得到的 `http://<地址>:3000/?room=密钥` 发给朋友。
3. 所有人点「准备就绪」后房主开始。
4. 同一 Wi-Fi / 路由器下的朋友打开启动窗口里列出的地址（形如 `http://192.168.x.x:3000`）即可。打不开时多半是防火墙：Windows 首次启动时在弹窗中允许「专用网络」，或运行 `npm run doctor` 查看具体命令；访客 Wi-Fi 常开启「AP 隔离」，也会导致连不上。

刷新页面或断线后，同盟模拟 10 分钟内、独立模拟 24 小时内重新打开即可回到原座位。服务器把房间和对局都保存在内存里，**重启服务器会结束所有对局**。

### 房间状态接口

供外部展示工具使用的只读 JSON 接口为 **`GET /api/rooms/ABCD/status`**（支持 `HEAD`，房间码大小写均可）。按朋友分享的房间码查询，无需登录或额外鉴权，不创建游戏会话，也不占用席位；服务器不提供房间列表。

响应包含 `code`、`mode`、`difficulty`、`inMatch`、`joinable`、`capacity`、`occupied`、`humans`、`bots`、`connectedHumans`、`phase`、`round`、`lastRound`、`deadline`、`paused`、`serverNow` 和 `seats`。席位仅包含昵称、席位编号、AI / 房主标记、在线 / 准备情况；对局中另有 `alive`、`lp` 和 `pendingLp`（实时展示生命值为 `max(0, lp - pendingLp)`）。战斗进度以服务器收到的玩家上报为准，未上报的浏览器内战斗状态不在此接口中。

接口禁止缓存并标记为不索引。持有码即可查询，包括昵称；短房间码不等同于访问密码。接口不返回玩家 ID、重连令牌、私人商店或调配数据；不开放跨域读取，外部服务可在后端按房间码请求接口。不存在、格式错误或已关闭的房间返回 `404`，不支持的方法返回 `405`；每个客户端网络限每秒 2 次、突发 10 次查询（包括失败查询），超限返回 `429` 和 `Retry-After: 1`，代理地址识别沿用 `TRUST_PROXY` 配置。

## 联机方式

朋友不在同一个局域网时，下面是几类常见做法，按自己的情况选一种即可。这里只做简单介绍，提到的工具和服务只是举例，本项目与它们没有任何关系，也不做推荐；具体的安装、费用和使用规则请以各自的官方说明为准。部署细节（防火墙、开机自启、反向代理与 HTTPS、Docker）见 **[docs/operations/DEPLOY.md](docs/operations/DEPLOY.md)**。

| 方式 | 怎么做 | 适合 |
|---|---|---|
| **同一局域网直连** | 把启动窗口里的局域网地址发给朋友 | 同一个家、宿舍或网吧 |
| **组网工具（虚拟局域网）** | 例如 Tailscale、ZeroTier、EasyTier、蒲公英：开服的人和朋友都安装同一个工具并加入同一个网络，朋友用开服电脑的虚拟 IP 访问 `http://<虚拟 IP>:3000` | 固定的几个熟人；不暴露到公网。朋友也要装客户端，部分工具需要注册账号；跨地区时可能走中继而变慢 |
| **内网穿透 / 隧道** | 只有开服的人运行客户端，朋友直接打开网址。例如自建的 frp（需要一台有公网 IP 的服务器）、Cloudflare 的 `cloudflared tunnel --url http://localhost:3000`（临时地址，每次启动都会变；国内访问延迟可能较高）、国内的樱花 frp 一类公共穿透服务（通常需要实名，大陆节点承载网页可能有备案要求） | 不想改路由器、没有公网 IP；免费线路带宽小时，首次加载素材会慢一些 |
| **云服务器 / VPS 直接部署** | 在 VPS 上运行整合包，或用仓库自带的 `Dockerfile`；用 Caddy / Nginx 加上 HTTPS。选离玩家近、线路好的地区（面向大陆玩家时，境外机房要关注回程线路，否则晚高峰延迟可能很高；大陆服务器绑定域名需要 ICP 备案） | 想长期开服、玩家分布在不同地区 |

通用注意事项：

- 游戏是**单个常驻 Node.js 进程 + WebSocket**（路径 `/ws`），只能跑一个实例，必须部署在域名根路径；Vercel 之类的 Serverless 平台和 GitHub Pages 之类的静态托管都不适用。反向代理要转发 WebSocket 升级。
- 游戏没有账号系统，**知道地址的人都能进来**。请只把地址发给朋友，不要公开发布，也不要搭建公开大厅；这同时能降低素材版权方面的风险。
- 有公网 IPv4 时也可以在路由器上做端口转发，但这会把家里的电脑直接暴露在公网上，优先考虑上面的方式。

## 操作

| 操作 | 方法 |
|---|---|
| 购买 / 升级调度中心 / 机变选卡 | 点一次选中，再点一次确认（`D` 升级） |
| 部署 / 移动干员 | 从整备区拖到棋盘格 → 出现方向轮盘 → 往上 / 右 / 下 / 左滑动选择朝向后松手；松在中心或点「✕ 点击取消」取消。拖动时指针 / 手指所在的格子就是落点，能放下时模型直接站在这一格上（不能放下时跟在指针下） |
| 调整朝向 | 把干员拖回它自己的格子，再选方向 |
| 出售 / 撤退 / 销毁装备 | 点击单位所在的格子 → 底部按钮「出售 +1」「撤退」；也可以把棋盘上的干员拖回整备区撤退。整备区里的装备与法术只能「销毁」，已配发的装备锁定在干员身上（干员出售或合成精锐时退回整备区） |
| 装备 | 把装备拖到干员所在的格子上（每人 2 件；满了会弹出替换窗口，被替换的一件会被销毁）；法术拖到地块上并选方向 |
| 查看详情 | 右键或长按单位 / 卡牌（属性为实时数值，高于基础值为绿色、低于为红色） |
| 快捷键 | `R` 刷新 · `F` 冻结 · `D` 升级 · `Q` 撤退 / `X` 出售选中的干员 · `Space` 准备就绪 · `Esc` 取消 / 关闭；除 `Esc` 外都可以在「设置 → 快捷键」里改成别的键（[玩法指南 §11](docs/guides/PLAYING.md#11-快捷键)） |
| 方向轮盘键盘操作 | 方向键预览 · `Enter` 确认 · `Esc` 取消 |
| 暂停（独立模拟） | 作战中（含最终攻势 / 隐秘核心）点顶栏的「暂停」或按 `Space`，再点「继续作战」（或 `Space`）继续；同盟模拟的作战不能暂停 |
| 表情 | 左下角「交流」，左右滑动（或方向键）换主题，冷却 1 秒 |
| 观战 | 自己的作战结束后（或休整期）点左侧队友头像 →「前往查看」；不参战的朋友可以在大厅输入同盟密钥点「观战」（每个同盟最多 2 名观战者，本作新增） |
| 统计（本机） | 标题画面右上角、大厅、等待室的「统计」：胜率、策略通过率、称号、战斗累计和对局记录（点一行回看结算页）；只存在本机浏览器里，可以导出 / 导入，没清完第一个回合就退出的对局不计入统计（[玩法指南 §13](docs/guides/PLAYING.md#13-统计本机)） |

完整的规则、数值和小技巧见 **[docs/guides/PLAYING.md](docs/guides/PLAYING.md)**（游戏内左下角也有「玩法说明」）。

## 文档

完整分类入口见 **[文档导航](docs/README.md)**：玩法指南、部署运维、开发参考、设计历史与调研。

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 更新记录：每个版本修复了什么、哪些反馈经核实不是问题 |
| [docs/guides/PLAYING.md](docs/guides/PLAYING.md) | 玩法指南：流程、经济、招募与晋升、摆阵、联防、盟约、最终攻势、结算称号 |
| [docs/operations/DEPLOY.md](docs/operations/DEPLOY.md) | 部署指南：Windows 开服与开机自启、防火墙、组网 / 隧道、反向代理与 HTTPS、Docker、systemd、排错 |
| [docs/development/CUSTOM_API.md](docs/development/CUSTOM_API.md) | 本分支 API 规范：房间号查询、延迟探测、维护公告、四人匹配及资源 / 结算扩展（排除上游已有接口） |
| [docs/operations/WINDOWS.md](docs/operations/WINDOWS.md) | Windows 便携包：怎么打一份「零安装」包（`scripts/make-windows-bundle.mjs`）、包里放了什么、授权注意事项 |
| [docs/development/DESIGN.md](docs/development/DESIGN.md) | 架构与契约（英文）：索引，按章节号找到文件；现行规则在 `docs/design/`（范围与目录分工、坐标与时间、战斗引擎、对局、网络协议、渲染与 UI），各次试玩和各版本的规则修订与依据在 `docs/history/` |
| [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md) | 代码地图（英文）：服务器、联机协议和前后端共用的战斗模拟，0.2.0 重构后的目录，数据流，黄金结果与导入边界，常见改动从哪里入手 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 参与贡献：准备环境、运行测试、忠实原则、提交与 PR 约定、怎样添加自选干员（中文，末尾附英文摘要） |
| [docs/development/SIM.md](docs/development/SIM.md) | 战斗模拟引擎参考（英文）：钩子、技能描述格式、职业默认行为 |
| [docs/development/META.md](docs/development/META.md) | 对局与经济引擎（英文）：回合流程、商店、联防、最终攻势的实现细节 |
| [docs/development/DATA.md](docs/development/DATA.md) | 由官方数据表生成的游戏数据（英文） |
| [docs/development/ASSETS.md](docs/development/ASSETS.md) | 素材来源、目录结构与清单（英文） |
| [docs/development/I18N.md](docs/development/I18N.md) | 界面语言（英文）：界面文字、游戏文本与服务器消息怎样翻译，覆盖范围；**添加一种语言只需在 `public/i18n/` 放一个语言文件**（社区翻译步骤见「Adding a language」，内容包格式见 [docs/guides/PACKS.md](docs/guides/PACKS.md)） |
| [docs/development/BALANCE.md](docs/development/BALANCE.md) | 难度模型与测量（英文） |
| [docs/research/](docs/research/00-INDEX.md) | 官方规则、数据与界面的调研记录 |

## 开发与测试

```bash
npm run dev                 # node --watch：改动服务器代码后自动重启
node --test                 # 单元 + 集成测试（约 3170 项；缺少素材 / 浏览器的用例会自动跳过）
SP_E2E=1 node --test test/ui/mock.e2e.test.js        # 浏览器端到端测试，需要本机 Chrome（CHROME_PATH 可指定路径）
SP_REAL_E2E=1 node --test test/ui/real.e2e.test.js   # 需要 Chrome + 已下载的素材
RENDER_E2E=1 node --test 'test/render/*.browser.test.js'   # 渲染测试，部分需要本地提取的棋盘贴图
GOLDEN_FULL=1 node --test test/golden.test.js           # 黄金结果：固定种子的整套战斗与人机对局摘要（默认只跑快速子集）
node tools/perfbench.mjs --cpu 1,4,6 --profile             # 真实战斗的帧耗时基准（Chrome 降速 CPU 近似中低端手机），需要 Chrome + 已下载的素材
```

- 游戏数据由 `npm run build-data`（`tools/build-data.mjs`）从官方数据表生成，不要手工修改 `data/*.json`。
- 性能测试：`/dev/battle-perf.html` 在浏览器里跑一场真实战斗（对局用的战斗运行器、模拟和渲染），实时显示帧率与逐帧耗时；在手机上打开后点击「开始测量（10 秒）」，生成的报告可以复制后附在反馈中。用到的战斗来自 `node tools/capture-specs.mjs` 从固定种子的机器人对局里截取的数据（`public/dev/perf/`）。
- 只重构、不改玩法的提交不能改变 `test/golden/*.json`；有意改变玩法时运行 `npm run golden:update`，检查差异后随改动一起提交（见 [test/golden/README.md](test/golden/README.md)）。
- GitHub Actions（[.github/workflows/ci.yml](.github/workflows/ci.yml)）在 Ubuntu 与 Windows、Node 22 / 24 上运行 `npm ci`、`node --test` 和服务器冒烟测试。
- 代码怎么分层、改某个规则该从哪个文件入手，见 [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md)。

## 项目结构

| 路径 | 内容 |
|---|---|
| `server/` | 入口 `index.js`；Node HTTP 静态服务 + WebSocket（`/ws`，代码在 `http/`）、大厅、对局引擎（`match/`）、战斗模拟（`sim/`，浏览器与服务器共用） |
| `shared/` | 前后端共用的常量与网络协议 |
| `public/` | 浏览器客户端（原生 ES 模块，PixiJS + pixi-spine、three.js 3D 棋盘、Preact + htm UI） |
| `data/` | 由官方数据表生成的游戏数据与素材清单 `assets.json` |
| `tools/` | `setup.mjs` / `doctor.mjs`、素材下载、数据构建、本地提取；见[工具说明](tools/README.md) |
| `scripts/` | 启动与部署脚本；见[脚本说明](scripts/README.md) |
| `docs/` | [文档导航](docs/README.md)：`guides/` 玩法、`operations/` 运维、`development/` 开发；`design/`、`history/`、`research/` 保留专题资料 |
| `test/` | `node:test` 测试 |
| `.cache/` | 本地缓存、临时脚本、日志与报告（Git 忽略） |
| `.state/` | 服务器对局存档（Git 忽略） |

## 许可证

- **代码**：本项目自己编写的代码以 **GPL-3.0-or-later** 发布，全文见 [LICENSE](LICENSE)；另附一条 GPL 第 7 条的附加许可，允许与 pixi-spine 中的 Spine Runtimes 组合分发（见 [NOTICE.md](NOTICE.md)）。
- **游戏素材不在许可范围内**：《明日方舟》相关的美术、音乐、音效、文本与数据等版权归原权利人所有，不适用 GPL，使用限制见上方的[声明](#声明)和 [NOTICE.md](NOTICE.md)。
- **第三方组件**各自遵循其许可证：通过 npm 安装的库（整合包的 `node_modules` 中附带各自的许可证文件）、`tools/local-extract/aklz4.py` 的算法（BSD-3-Clause），以及字体等，清单与许可证全文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 致谢与数据来源

- 游戏数据：[Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)。
- 素材来源：[yuanyan3060/ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource)、[fexli/ArknightsResource](https://github.com/fexli/ArknightsResource)、[isHarryh/Ark-Models](https://github.com/isHarryh/Ark-Models)、[ArknightsAssets/ArknightsAssets2](https://github.com/ArknightsAssets/ArknightsAssets2)；字体来自 [TimWangZi/The-font-of-Arknights](https://github.com/TimWangZi/The-font-of-Arknights) 与 Google Fonts（Noto Sans SC）。详见 [docs/development/ASSETS.md](docs/development/ASSETS.md)。
- 规则核对参考：[PRTS 明日方舟中文 Wiki](https://prts.wiki/)。
- LZ4AK 解包：`tools/local-extract/aklz4.py` 的算法来自 [isHarryh/Ark-Unpacker](https://github.com/isHarryh/Ark-Unpacker)（BSD-3-Clause，经 MooncellWiki/UnityPy）；解析 Unity 资源使用 [UnityPy](https://github.com/K0lb3/UnityPy)（MIT）。
- 库：[PixiJS](https://pixijs.com/)（MIT）、[pixi-spine](https://github.com/pixijs/spine)（MIT；其中包含的 Spine Runtime 另受 [Spine Runtimes License](https://esotericsoftware.com/spine-runtimes-license) 约束）、[three.js](https://threejs.org/)（MIT）、[Preact](https://preactjs.com/) + [htm](https://github.com/developit/htm)（MIT）、[ws](https://github.com/websockets/ws)（MIT）。
- 分支实现参考：[xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol) —— 本分支的共享 worker 线程池、资源预载与服务端对局检查点/恢复移植改编自该分支（GPL-3.0-or-later），改造细节见 [docs/development/PERFORMANCE.md](docs/development/PERFORMANCE.md)、[docs/operations/CDN.md](docs/operations/CDN.md)、[docs/operations/PERSISTENCE.md](docs/operations/PERSISTENCE.md)。

感谢以上项目的作者与维护者，以及鹰角网络带来的这款游戏。

## 贡献

欢迎提 Issue 反馈 bug、与官方规则不一致的地方或改进建议，也欢迎提交 Pull Request：

- 准备环境、运行测试、忠实原则和提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 提交前请运行 `node --test`，并同步更新相关文档；文档使用简体中文，代码与注释使用英文。
- 提交的代码将以 GPL-3.0-or-later 发布。
- 本分支跟踪来自上游 v0.1.3 完整包的 `public/assets/local/` 和 `data/local-assets.json`，方便 Git 部署；其余下载素材仍由 `.gitignore` 排除。游戏素材不受 GPL 授权，使用声明见 [NOTICE.md](NOTICE.md)。
- 本项目坚持非商业：请不要提交广告、付费、打赏等任何形式的变现功能。

---

## English

An **unofficial, non-commercial fan remake** of Arknights' seasonal auto-chess tower-defense mode *Stronghold Protocol: Alliance*, played in the browser: solo, or 1–4 player co-op (AI teammates can fill seats). Combat is simulated in each player's browser, so a low-power PC can host.

- **Run:** download the all-in-one bundle from [Releases](../../releases/latest), install Node.js 22 or 24, then double-click `scripts\start-windows.bat` (Windows) or run `./scripts/start.sh` (macOS / Linux) and open <http://localhost:3000>. From 0.2.1 on, `…-update.zip` contains only changes since earlier 0.2.x bundles: stop the server, extract it over a matching install and start again; the first start verifies the files and removes obsolete unmodified files. From source: `npm install && npm run setup && npm start` (setup downloads the art from public mirrors, the emotes and the how-to-play pages included; this fork includes the v0.1.3 local-client art and manifest in Git, providing the official 3D board, some HUD icons and two enemy models without local extraction — the 39 summon models 0.2.0 added need one `npm run setup -- --local` or a copy from the same-version full bundle; WebGL2 is required for the 3D board).
- **Languages:** Chinese (the default), English, 日本語, 한국어 and 繁體中文 — switch on the title screen or in Settings. Game texts come from the official clients; the Japanese, Korean and Traditional Chinese interface strings are machine translations (corrections welcome: [docs/development/I18N.md](docs/development/I18N.md)).
- **Play with friends:** create a co-op room and share the 4-letter key or the `?room=KEY` link. On a LAN, use the address printed at start; otherwise use a virtual-LAN tool, a tunnel or a VPS — see [docs/operations/DEPLOY.md](docs/operations/DEPLOY.md).
- **Disclaimer:** not affiliated with or endorsed by Hypergryph or Yostar. All Arknights names, art, audio, text and data are © their respective owners and are **not** covered by this project's GPL licence. For study and personal non-commercial use only — no selling, paid distribution, paid servers or monetisation of any kind. Rights holders may request removal via an [Issue](../../issues) or email **misyra@163.com**; content will be removed immediately. Provided "as is", without warranty.
- **License:** code GPL-3.0-or-later ([LICENSE](LICENSE)); game assets excluded. Portions of this fork (shared worker pool, resource preload, match checkpointing) are adapted from [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol) (GPL-3.0-or-later).
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) (an English summary at its end); the code map is [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md).
