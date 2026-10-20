# 素材 CDN（Cloudflare R2）

生产部署和配置文件统一从[部署指南](DEPLOY.md)开始；本文负责 R2 发布与浏览器资源缓存。

美术（图片 / Spine / 音频 / 字体）可以放到 Cloudflare R2，由绑定的自定义域名经边缘缓存对外服务，游戏服务器不再承担素材的出网带宽与磁盘读。服务器设置一个环境变量即可启用；代码、游戏数据、API 与 WebSocket 仍由游戏服务器直出，`/js/`、`/vendor/`、`/data/`、`/api/`、`/ws` 不上 R2，`public/dev/` 不上传。

**CDN 素材不设置请求次数或下载文件总数限制。** 游戏源站的静态 `limit_req` / 业务封禁预算不应用到 `assets.misyra.com`，也不在浏览器按 CDN 下载次数累计封禁。浏览器为带宽、内存与失败退避保留的下载并发预算不等于次数限制。未启用 CDN 时由游戏主机实际发出的素材，仍执行源站的静态额度。

## 1. 一次性准备（Wrangler）

管理操作全部可用 Wrangler CLI 完成（上传走 [S3 兼容 API](https://developers.cloudflare.com/r2/api/s3/api/) 的批量脚本，见下）：

```powershell
npx wrangler login
npx wrangler r2 bucket create <bucket>
# 自定义域名需域名已托管在 Cloudflare；一个域名只能绑定一个 bucket
npx wrangler r2 bucket domain add <bucket> --domain assets.example.com --zone-id <zone_id>
# CORS：Spine / 音频是跨域 fetch，必须放行 GET / HEAD
npx wrangler r2 bucket cors set <bucket> --file scripts/r2-cors.example.json
```

## 2. 发布美术：tools/r2-sync.mjs（增量上传）

```powershell
node tools/r2-sync.mjs --bucket <bucket>            # 上传 public/{assets,fonts,media}
node tools/r2-sync.mjs --bucket <bucket> --dry-run  # 只看将要上传的内容
node tools/r2-sync.mjs --bucket <bucket> --metadata-only  # 只补齐已发布资源的预载指纹，不访问 R2
```

脚本的行为：

- 每个文件只占一个 key：普通路径 `assets/…`。项目根目录的 `.assets-manifest.json`（不入库，发布机生成）记录上次发布时每个路径的内容哈希（`{ tag, hashes, preload }`，`tag` 是全部「路径 + SHA-256 前 16 位」哈希的前 16 位十六进制，美术不变则 tag 不变）。
- 每次运行先和这份清单对比，**只上传哈希变化的文件**（通常是几个到几十个），全部成功后才重写清单；中断或失败不写清单，重跑自动补齐——清单本身就是断点续传状态，没有额外的进度文件。
- `preload` 记录同一批已发布字节的 SHA-1 前 12 位和大小，供没有本地素材的 CDN 部署验证资源包。只补齐这份元数据不会改变 tag 或任何素材 URL；公开的 `/assets-manifest.json` 仍只返回 `{ tag, hashes }`，保持原有不可变缓存响应。旧清单可在有完整本地素材的发布机运行 `--metadata-only` 补齐，再随代码部署并重启；发现本地尚未发布的素材改动时会拒绝写入。普通增量发布也自动生成这些字段。
- 上传限速约 3 req/s 并对 429 全局退避：Cloudflare 管理 API 有每账户请求配额，并发猛打会大面积 429。OAuth token 过期时自动调 `wrangler whoami` 刷新。
- 未知参数直接报错退出（历史上 `--help` 被静默忽略并触发过一次真实全量上传）。

发布新美术的完整流程：`node tools/r2-sync.mjs --bucket <bucket> --push` → 把发布机上的 `.assets-manifest.json` 同步到服务器（`scp .assets-manifest.json <服务器>:/opt/Stronghold-Protocol/`）→ 重启服务器。清单从 2026-10-19 起不入库（6.2 MB，每发一次美术就多一个大提交），所以这一步取代了原来的「`--push` 提交清单 + 部署机 `git pull`」；Docker 部署在构建镜像时用 `tools/build-assets-manifest.mjs` 按构建上下文里的素材重新生成，不需要手工拷。日常发布只传变化文件，通常几十秒内完成。

## 3. 游戏服务器接入

服务器侧只需设置 `SP_ASSETS_CDN=https://assets.example.com` 并保证项目根有 `.assets-manifest.json`（发布机生成后 `scp` 过去；镜像构建时自动生成）。服务器启动时读取它，把每个美术文件的 CDN URL 改写成 `https://assets.example.com/assets/…?v=<文件哈希>`：查询串参与 CDN 缓存键，内容不变则 URL 不变，可复用已有缓存，文件更新时只有它的 URL 变化。缓存仍可能被浏览器或边缘节点提前清理。清单本身由游戏服务器在 `/assets-manifest.json?v=<tag>` 同源提供（不可变缓存，页面在 `<head>` 里就开始拉取）。

发布层（本分支自己的 `/_v/<tag>/`，`server/assetVersion.js`）与每文件 `?v=<哈希>` 一起工作：页面和 CSS 被就地改写，代码与 CSS 走 `/_v/<runtimeTag>/…`（immutable；发版后旧 URL 一律 404，文件在进程内被改过则 503），素材走 CDN 的每文件 `?v=`。页面里只注入 `__spAssetVersion` / `__spRuntimeVersion` / `__spArtVersion`；CDN 基址与清单地址由 `/js/asset-cdn.js` 模块提供。

实现上：`server/http/static.js` 用 `assetsManifest`（`.assets-manifest.json`）生成这个响应，只认本次发布的 `?v=<tag>`（别的 tag 一律 404，免得一份清单的指纹被挂到另一个发布的 URL 上长期缓存），gzip + ETag/304 + `immutable`；同一次请求里生成的 `/js/asset-cdn.js` 会带上 `ASSETS_MANIFEST`，客户端（`public/js/main.js`）据此在模块图加载的同时开始拉哈希。没有清单或没配 CDN 时该值为空串，客户端保持不带版本的同源地址。清单不存在时回退为无版本 URL。

### 3.1 本站配置

嵌套资源也使用各自的文件哈希：字体 CSS 留在游戏服务器的 `/_v/<artVersion>/fonts/…` 路径，服务器把内部字体链接改写为 CDN 的 `?v=<字体哈希>`；R2 不负责改写 CSS。Spine 加载器按清单哈希请求并解析 atlas，为其实际引用的每张纹理补上独立哈希，再把解析后的 atlas 交给第三方加载器，避免默认派生地址时丢掉查询参数。2D、3D 地图等资源派生出的无版本 CDN 地址也会补上对应文件的哈希。客户端生成这些动态请求前等待哈希清单（最多 3 秒）；清单失败或超时时仍保留无版本回退，缓存时长由源站和缓存规则决定，迟到的清单仍可用于后续请求。

- bucket：`weishu`；自定义域名：`https://assets.misyra.com`（zone `misyra.com`）。
- bucket 只维护普通路径 key，清单不入库（2026-10-19 起），当前 tag 与预载指纹以发布机生成、同步到服务器的那份为准。

**启用（游戏服务器上唯一要做的事）**：

```powershell
$env:SP_ASSETS_CDN = 'https://assets.misyra.com'
npm start        # 或写进服务管理器的环境配置
```

未设置时从游戏服务器读取本机素材；设置后只有 `/assets`、`/fonts`、`/media` 走 R2。版本号不用设——项目根里的 `.assets-manifest.json` 在启动时读取，启动日志会打出 `assets CDN … manifest … (per-file ?v= busting)`。

**重启后验收（约 30 秒）**：

1. 打开 `https://<游戏域名>/healthz`，确认 `assetsCdn` 为 `https://assets.misyra.com`、`assetsManifest` 为当前清单 tag；启动日志同时会打出 `assets CDN … manifest …`。
2. 打开游戏页面，浏览器 Network 面板中图片 / 音频 / 字体请求应指向 `assets.misyra.com` 且带 `?v=` 参数，`/assets-manifest.json?v=…` 只在首次访问下载一次；`/js/`、`/api/`、`/ws` 仍指向游戏域名。
3. 跨域抽查（应含 `Access-Control-Allow-Origin: *`，缓存命中时可见 `CF-Cache-Status: HIT`，首次未命中可再检查一次）：

```bash
curl -I -H 'Origin: https://<游戏域名>' "https://assets.misyra.com/assets/char/avatar/char_1012_skadi2.png?v=<assets-manifest.json 的 hashes 中该路径对应的哈希>"
```

**日常发布美术（固定三步）**：

```powershell
node tools/r2-sync.mjs --bucket weishu --push   # 增量上传 + 重写清单（清单留在发布机，见 §2）
# 发布机：
scp .assets-manifest.json <服务器>:/opt/Stronghold-Protocol/
# 部署机：
git pull
重启服务器
```

### 3.2 生成资源分包

预载的分包是**部署产物**，不进 Git：`tools/resource_packs.py`（取自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol)，只用 Python 标准库）把清单按分类切成每个不超过 16 MB 的 stored ZIP，再写一份索引给服务器。先让磁盘上有一份清单 —— 它平时是 `/data/resource-manifest.json` 动态生成的，落地成文件即可：

```powershell
# 1) 把当前清单落地（用你自己的域名 / 端口）
Invoke-WebRequest "http://127.0.0.1:3000/data/resource-manifest.json" -OutFile data/resource-manifest.json
# 2) 切包：素材在 public/ 下，产物放 public/resource-packs（静态层按 /resource-packs/… 直接服务）
python tools/resource_packs.py --manifest data/resource-manifest.json --assets-root public `
  --output public/resource-packs --index data/resource-packs.json
# 3) 重启服务器：/data/resource-packs.json 变成这份索引（客户端预载开始用分包）
```

脚本会逐个文件核对 `hash`（清单里的 12 位 SHA-1 前缀）与 `size`，任何不一致直接失败、不留半个包 —— 所以**清单里每个文件都必须有真实的内容指纹**，跑之前先 `node tools/asset-hashes.mjs`（未生成指纹的文件用的是 `syn-…` 合成值，脚本会拒绝）。本机实测：27,083 个文件 / 约 1.2 GiB 素材，`asset-hashes` 8.7 s，切包 92 s，产出 81 个包共 1.15 GiB（约等于素材体积，stored ZIP 不再压缩）。分类是 `spine` / `character` / `ui` / `map`（必备层）与 `voice_cn`、`voice_jp`、`sfx`、`bgm`、`fx`、`other`（额外层），包名 `<组>-<序号>`、文件名带整包 SHA-1 前缀。部署机器上需要有对应的素材文件（CDN-only 的安装请先 `node tools/fetch-assets.mjs`），清单里 `syn-…` 这类合成指纹的文件不能进包 —— 先跑 `node tools/asset-hashes.mjs` 生成真指纹。

**只发增量**（可选）：`tools/resource_delta.py` 比较两份已经是 v2 格式的资源 ZIP（全量导出或分包都行），产出一份只含新增/改动文件的小 ZIP 和一份 JSON 报告，浏览器的手动导入可以直接吃它。

```powershell
python tools/resource_delta.py --base <旧.zip> --target <新.zip> --output <delta.zip>
```

报告里 `summary.added / changed / unchanged / absentFromTarget / delta` 分别给出条数与字节数，`--analyze-only` 只比对不产出。客户端没有自动吃增量包的入口：它是给「手动导入」和 CDN 分发决策用的。
### 3.2 资源分包的镜像线路（SP_RESOURCE_PACK_ROUTES）

预载用的资源分包是整包 ZIP（见 [预载说明](#4-浏览器预载)）。`SP_RESOURCE_PACK_ROUTES` 让游戏服务器把**镜像地址**写进清单：客户端按顺序试，失败就换下一条，**当前地址永远留一个在最后**，所以镜像挂了不会让预载整体失败。

值是一段 JSON 数组，每一项可以是目录（`https://mirror.example/packs`，自动补 `/{file}`）、裸主机（补成 https 并补 `/{file}`）、同源目录（`/local/packs`），或一个模板（`https://m.example/p/{id}/{file}`，`{id}` 是分包 id，`{file}` 是文件名），或某个固定的整包 ZIP。写错的值（不是数组、不是 http(s) 的 `.zip`、模板里有未知占位符）在**启动时**就报 `SP_RESOURCE_PACK_ROUTES` 错误，不会把坏地址发给浏览器。

```powershell
$env:SP_RESOURCE_PACK_ROUTES = '["https://mirror.example/packs", "https://backup.example/packs"]'
npm start
```

服务端产出的是清单里的 `pack.urls`（顺序 = 配置顺序 + 当前地址），并把 `pack.url` 与包内 `/assets/…` 的地址按 `SP_ASSETS_CDN` / `SP_DATA_CDN` 改写；客户端 `fetchTransportPack` 逐条尝试，只有整包指纹校验通过才导入缓存，所以镜像返回的错误内容不会被当成有效分包。部署清单里自带的 `urls` 会被忽略 —— 线路只有服务器配置说了算。

不配置时行为不变：清单里没有 ${B}urls${B} 字段，客户端直接用当前地址。
**可选的回源优化**：[Smart Tiered Cache](https://developers.cloudflare.com/smart-shield/configuration/smart-tiered-cache/) 让多个边缘节点未命中时先查询上层缓存，减少各自直接读取 R2。实际节省取决于流量分布与缓存命中情况，应根据 R2 的 Class B 用量验证；不能仅凭 TTL 或单个 URL 的 HIT 推算月费用。

### 3.3 数据也放 CDN（SP_DATA_CDN）

把与游戏服同一版本的 `data/` 整个目录传到 CDN 根下，然后设 `SP_DATA_CDN`：

```powershell
$env:SP_DATA_CDN = 'https://data.example.com/stronghold'
npm start
```

服务端把它写进运行时模块 `/js/asset-cdn.js` 的 `DATA_CDN`；客户端 `main.js` 挂到 `__spAssetCdn.dataBase`，游戏 JSON 的加载器（`public/js/data.js`）与浏览器战斗模拟（`public/js/battle/simLoader.js` 的 `dataBase` 默认值）都从 `dataBasePath()` 取根路径，于是请求变成 `<SP_DATA_CDN>/data/chess.json`。**显式传入的 `base` / `dataBase` 永远优先**（房间的内容集、内容插件、测试都是这样显式指定的），所以这个开关不会覆盖任何按房间来的数据来源。

没配时一切照旧（同源 `/data/`）。Node 自己的 `/data/*.json` 仍然读本机文件、仍然 200/304，不做跳转 —— CDN 只影响浏览器从哪儿取数据。

注意两点：`data/` 里只有静态 JSON 会被搬走，`/data/resource-manifest.json` 与 `/data/resource-packs.json` 仍是本服务动态生成的（素材清单依赖本机装了哪些素材与插件）；语言包文本走 `/packs/<id>/…`，仍由本服务提供（`shared/cdn.js` 里上游的 `i18nUrl()` 本分支没有使用）。
## 4. 浏览器预载

首页右下角或对局设置中的「预载资源」打开共用资源管理窗口。预载默认关闭；开启后随个人设置保存，之后进入页面会在后台继续。窗口按**必备资源、干员语音、干员皮肤、额外特效**四张卡片展示，各自集中显示开关、缓存进度和大小。音效、音乐与玩法说明在必备资源卡片内独立选择，与干员语音互不绑定；旧设置里的语音选择从 `preloadOptional` 迁移到 `preloadVoices`。语音以复选框提供中文、日语、英语、韩语和本土语音，可同时勾选多个语种，也可选择全部语言；未发布的语种显示为不可选。预载语种独立保存，不会切换游戏播放语言；旧设置默认跟随播放语言。每种语音显示其大小。皮肤默认跟随干员调配，主进度按本次选择的套数计算，另列服务器已安装与本机已缓存的总套数；勾选「全部皮肤」后才下载完整目录。特效是独立范围，缓存不会改变画质设置。没有安装皮肤或特效的部署不显示对应卡片。上方汇总**本次预载、已缓存、还需下载**，并提供「仅必备」「日常推荐」「完整预载」三个快捷方案；选择方案不会启动已暂停的下载。关闭窗口后已开启的下载继续，**暂停下载会保存关闭状态，刷新后仍暂停**；已有缓存保留。ZIP 导入区放在预载汇总下方并默认展开；导出范围、资源包说明和清理操作按需展开。清理可选资源会同步关闭所有可选范围，清理全部资源后暂停下载。需要 HTTPS 或 localhost。

支持 ZIP 导入导出：导出 v2 包，记录完整 SHA-1 及其前 12 位指纹；导入兼容旧 v1 SHA-256 包。每个条目的 ZIP 文件头、CRC、大小和摘要均验证通过后才写入，再按当前清单的路径、内容 hash 和已知大小复用有效文件。成功导入自动开启预载，只补齐所选范围内的缺失资源。导入结果在后台下载继续时仍单独保留，并显示已有、跳过数量及原因；导出结束后恢复此前正在进行的下载，用户主动暂停或清理时不会恢复。失败或取消保留已经验证并保存的进度，失败条目不写入。小文件最多四路并发，共享 1 MiB 原始字节预算；较大文件独占处理，ZIP 读取缓存上限为 32 MiB。资源包与解压总大小最多 2 GiB，单文件最多 24 MiB。zip.js 与 CRC 模块由 vendor 脚本复制到 `public/vendor/`，随游戏服务器提供，无需上传 R2。

迁移多份旧缓存时，遇到过期副本仍会继续寻找其他可校验的有效副本，全部不匹配才下载。音频解码缓存保留内存上限；加载中的条目被淘汰后，其迟到结果不会干扰剩余缓存的大小统计。网络错误、服务端错误或限流造成的音频失败，至少等待 5 秒后在下一次播放时才重试；确定缺失的文件和无法解码的音频不会反复请求。

清单由 `/data/resource-manifest.json` 动态生成，沿用游戏的 CDN 配置和资源版本。Service Worker 只读取素材缓存；游戏仍需要服务器连接。内容未改变的二进制素材会跨版本路径复用，CSS/JSON 因可能被服务器重写而重新校验版本。意外关闭页面后，已经保存但尚未写入索引的文件会先校验内容指纹，匹配就直接恢复，无需重新下载；过期副本会先清除，避免 Service Worker 返回旧内容而触发重试。单文件限制 24 MiB，已知超大文件跳过；界面显示本站存储占用、预计可用空间和预计新增大小；导入前按兼容条目估算，提示仅供参考。空间不足会停止，并保留已有进度。下载失败可展开文件与错误详情。「清理可选资源」删除所有语种的语音、音效、音乐、特效、皮肤及可选图片，并关闭额外资源预载；「清理全部资源」删除本站预载缓存并暂停下载。两者均保留个人设置和其他应用缓存。另一标签页预载期间不能清理共享缓存，请先暂停该标签页。

反向代理需将 `/resource-sw.js`、`/js/resources/` 和 `/data/resource-manifest.json` 路由至此版本的 Node 服务；浏览器继续遵循源站 `no-cache`。nginx 可按 [部署指南](DEPLOY.md#清单性能修复与-nginx-一次性更新) 缓存带页面发布版本的资源清单 12 小时，普通地址仅 15 秒；素材哈希清单按其 `?v=` 缓存 30 天。更新资源/数据后必须重启 Node 生成新版本；不要把 Worker、普通 JS/CSS 或无版本资源清单套用长期缓存。

本地已有文件在首次读取清单时补算内容指纹，不增加启动时的素材读取。也可在部署前运行 `node tools/asset-hashes.mjs`，生成本机 `data/asset-hashes.json`（不提交 Git）；用 `node tools/asset-hashes.mjs --check` 检查。素材改变后重生成指纹并重启。CDN 部署从发布清单的 `preload` 读取内容指纹和大小，无需在服务器保存完整素材或运行 `asset-hashes.mjs`。旧发布清单缺少这些字段且本地也没有素材时，才回退到合成指纹，相关文件不能从 ZIP 导入。补齐并部署清单后，原来导出的 ZIP 可直接再次导入；已有浏览器缓存会校验后复用。CDN 两次返回与内容指纹不符的文件不会标记为完成，请先重新发布素材（`node tools/r2-sync.mjs --bucket <bucket> --push`）再重试。

预载实现移植并改编自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol)，保留 GPL-3.0-or-later 许可，并增加本站版本资源与 CDN 的适配。

## 5. Cloudflare「Under Attack」与同源兜底

### 5.1 症状与原因

CF 把整个 zone 拉到 Under Attack（或浏览器完整性检查拦住了非常规 UA）时，游戏页面本身能打开——导航拿得到 `cf_clearance`——但**预载一个文件也下不了**：控制台里 CDN 请求全是 403 加一段 challenge 网页，而素材域名不在挑战后面的部署照常预载。

原因是 `cf_clearance` **按主机名签发**，而预载、纹理、数据 JSON 的跨域请求都是不带 cookie 的匿名请求（`fetchResource` 用 `credentials:'same-origin'`，跨域即匿名），挑战永远问不过去；CDN 上"缓存命中"也救不了——challenge 由边缘先答，命中的是 challenge 而不是素材。

两边一起做：CF 侧给素材域名开 Skip（**根治**，也是唯一能保住源站带宽的做法），代码侧保留**有上限的**同源兜底（配错时运行期还能跑，但预载不会把源站当 CDN 用）。

### 5.2 CF 侧（必须）

WAF ▸ 自定义规则，表达式只写主机名：

```
http.host eq "assets.example.com"
```

`http.host` 里只有主机名，写成 `assets.example.com/*` 或带引号里的通配符**永远 0 匹配**，保存前看一眼「匹配数」。

动作 Skip，勾这几项就够：**安全级别**（Under Attack 的本质就是它拉到最高）、**浏览器完整性检查**、**所有托管规则**、**所有速率限制规则**（一次预载两千多个文件很容易撞限流）。不要勾「所有其余自定义规则」——否则以后加的防盗链、IP 封禁会被一起跳过；「区域锁定 / 用户代理阻止 / Hotlink 保护」按是否真的在用决定，**用了防盗链就别勾 Hotlink 保护**。素材域名只放静态文件，除了防盗链和流量没有别的东西要护，宽一点无妨。

**游戏主域名不要套这条**：那里有登录、房间和 WebSocket，挑战是唯一的机器人闸门。主域名最多只跳过静态树路径 `^/(assets|fonts|data|packs|i18n|resource-packs|_v|build)/`。

验证：

```bash
curl -sI https://assets.example.com/assets/local/ui/icon.png | head -3   # 200，且没有 cf-mitigated: challenge
```

### 5.3 代码侧（兜底）

- `shared/assetCdn.js` 的 `assetSiteUrl(cdnUrl)`：把 `<SP_ASSETS_CDN>/assets/x.png?v=<hash>` 还原成源站路径 `/assets/x.png`（去掉只为 CDN 缓存用的 `?v=`，保留完整性重试用的 `?sp=`）。
- `public/js/resources/network.js` 的 `fetchResource`：先走 CDN，失败（403 challenge / opaque / 超时 / 无 CORS 头）才换源站那份。**连续两次失败熔断 5 分钟**，否则 27 000 个文件会把同一个 block 重新发现 27 000 次。熔断只影响"先试 CDN"这一步：缓存键仍是 CDN URL，内容指纹照旧校验，预载索引与 ZIP 导入导出不受影响。
- **任何情况都先试 CDN**：顺序永远不变，源站只在一个请求的 CDN 那一步失败之后才被用到；熔断只是让**批量**工作别把同一次拒绝重新发现 27 000 次，运行期那张图每次都会先问 CDN（显式重试时连记住的源站副本也会先忘掉）。
- **源站不是兜底带宽**（`allowOrigin` / `takeOriginBudget`）：批量预载（`store.js` 与 SW 的预载交接）传 `allowOrigin: false` —— CDN 被拦时它以一条可重试的错误**停下来**，一个字节都不去源站；运行期那张图 / 那个 Spine 才允许用源站副本，而且整个页面共用一份预算（400 个文件 / 48 MiB，`resourceNetwork.js` 与 `image.js` 同一个计数器），用完就报"回退已达本次会话上限"。若真想让预载也回退，得同时改 `store.js` 的调用和这里的预算，并清楚那是把 ~310 MiB × 每个玩家压在源站上。
- `public/js/image.js`：只有跨域图片才设 `crossOrigin='anonymous'`，同源图片不再强制 CORS（否则等于主动丢掉挑战要的那张 cookie）；CDN 图失败一次就切到源站副本并在这个页面里记住。`recoverImageError` 重试同源图片时还会摘掉模板上的 `crossorigin`。
- `public/js/data.js`：数据 CDN（`SP_DATA_CDN`）读失败换源站 `/_v/<tag>/data/…`，语言 overlay 同理。

代价：走兜底的那批文件由源站提供，缓存头是 `no-cache` 而不是 CDN 的 immutable，每次预载会多几次 304。这是有意的——正确性优先；5.2 的 Skip 规则配好后走的是 CDN 那条快路。

## 6. 回滚

旧版「`_v/<tag>/` 全量快照」布局的对象仍保留在 bucket 里，`.assets-cdn-version` 与手动 `SP_ASSETS_CDN_VERSION` 的解析链也还在——切回旧代码即回到 `_v/<tag>/` 的版本化 URL，无需动 bucket。同步脚本不再写入这两者（旧服务器若拉到新 tag，会指向已不再生成的 `_v/` key）。
