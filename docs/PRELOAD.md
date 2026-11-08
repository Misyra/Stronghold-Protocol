# PRELOAD.md — 资源预载全链路：交付线、数据流与发布 SOP

资源预载不是一条线：预载包 ZIP、ModelScope 分类 ZIP、R2 逐文件回退三条交付线各管一段，加上清单、缓存、CDN
五六份状态文件。本文把它们整理成一张地图：每条线走什么、为什么、动哪些文件、谁负责哪一步。素材清单本身的
 schema 与回退规则在 [ASSETS.md](ASSETS.md)，玩家面板的操作说明在 [DEPLOY.md §2.5](DEPLOY.md#25-玩家侧素材预载资源管理面板合并自用户分支)，
CDN 环境变量表在 [DEPLOY.md §12](DEPLOY.md#预载--公告相关变量合并自用户分支)，皮肤安装见 [SKINS.md](SKINS.md)——本文只画链路与交接点，不抄写它们。

三条线的固定角色是硬规则（[AGENTS.md](../AGENTS.md)「Two delivery paths, fixed roles」）：

| 线路 | 载体 | 角色 |
|---|---|---|
| **预载包 ZIP** | `public/resource-packs/*.zip` + 索引 `data/resource-packs.json` | 玩家批量预载的主通道：整包下载、整包指纹校验、逐文件哈希写缓存 |
| **ModelScope 分类 ZIP** | 数据集 `Misyra/Arknight_Assets`（`master` 分支） | 预载包的**发布托管位置**，只用来存上面那条线产出的 ZIP；append-only |
| **R2 逐文件回退** | Cloudflare R2 桶（S3 兼容 API） | 预载缺口（缺包、没开预载、包里没有的范围）与对局内按需取数的兜底；不是预载的主通道 |

为什么这样分工：一个 ZIP 一万多个文件，逐文件从源站拉会把家用小主机的上行打满；包托管在 ModelScope 后，
批量字节根本不经过游戏服。R2 只承担「对局真的用到、预载没盖住」的那部分，量小、按内容寻址、可长期缓存。

## 1. 三条交付线怎么走

### 1.1 预载包 ZIP（构建在发布机）

`npm run resources:packs`（= `tools/build-resource-packs.mjs`）在**装了完整素材的机器**上构建，不上传任何东西：

1. `server/resources.js#createResourceIndex().get()` 生成预载清单，按 `--scopes all|fx,skin|gap` 过滤
   （`fx`/`skin` 子集构建会把旧索引里其它组的包原样保留，只替换本组；`gap` 是 0.3.4 起的**增量追加**模式，
   见下——`build-resource-packs.mjs`）。
2. 每个文件经 `tools/resourcePackPath.mjs#resourcePackPath`（拒 `%2F`/`%5C`，`server/resources.js#localPathFor`
   拒 `..`/越界）回到 `public/` 下的真实字节重新哈希——清单里的 URL 是数据，包里的字节必须当场证明。
3. 交给 `tools/resource_packs.py` 切包：每个分类 ZIP 上限 **16,000,000 字节**（`MAX_PACK_BYTES`，写死，
   `--max-bytes` 只收这个值），组名按 `tier`/路径归类：`skin`、`fx`、`voice_cn/jp/en/kr`、`voice`、`sfx`、`bgm`、
   `other`、`spine`、`map`、`character`、`ui`。ZIP 条目一律 `ZIP_STORED`（负载已是压缩格式），时间戳固定
   1980-01-01——打包时间与宿主不是内容。
4. 每个包内嵌自己的清单 `resources/stronghold-resources.json`（format `stronghold-resource-zip` v2，逐文件
   `{path, url, size, hash, sha1}`），包文件名内容寻址：`<组>-<序号>-<sha1 前 12 位>.zip`，整包 SHA-1（40 位）
   写进索引。
5. 产出 `data/resource-packs.json`：`{format:'stronghold-resource-pack-index', version:1, resourceVersion,
   maxBytes, packs:[{id, url:'/resource-packs/<名>.zip', group, tier, count, bytes, size, sha1, files:[{url,size,hash}]}]}`。

构建结束的提示就是下一步：`npm run resources:publish` 发 ModelScope，然后部署 `data/resource-packs.json`。
文件不存在会直接报错退出（`Resource missing/unreadable`）——**没有素材完整文件的机器建不出包**。

**增量补包 `--scopes gap`（0.3.4）**：把「清单全集」减去「当前 `data/resource-packs.json` 里
`packs[].files[].url` 的并集」（用 `shared/resourcePaths.js#resourceIdentity` 归一化），只给差集文件建新包。
`tools/assets/gapPacks.mjs` 负责差集、分组预览与纯追加合并：旧 `packs` 条目**一条不改**，新包 id 统一加
`gap-` 前缀（避开第一代遗留包的 `<组>-NN` 命名），`resourceVersion` 按合并后的全表重算。
`--dry-run` 只打印差集规模与各 group 计数、不写 ZIP 也不写索引。`gap` 不能与 `all` 或别的 scope 混用
（`all` 会跳过合并、整份替换索引，破坏 append-only）。这是**只做加法**的发布路径：
新素材/新类别/开场动画等杂项资源都会按 `resource_packs.py#group()` 自动归组，不再退化成逐文件 R2。

### 1.2 ModelScope 分类 ZIP（append-only）

`npm run resources:publish`（= `python tools/modelscope-packs.py`）把上一步的 ZIP 传到数据集
`Misyra/Arknight_Assets` 的 `master` 分支，默认 dry-run，`--apply` 才上传：

- 只上传**当前索引点名的 ZIP**（`allow_patterns`），先传 ZIP 负载再传 `resource-packs.json`；
  远端已有文件（包括历史上的整包 ZIP）一律保留，没有删除操作。
- 每个本地 ZIP 先验 size/SHA-1 与索引一致才上传；索引文件传成数据集根的 `resource-packs.json`。
- 凭据走 `MODELSCOPE_API_KEY` / `MODELSCOPE_TOKEN` / `MODELSCOPE_API_TOKEN` 或隐藏输入，**不落盘**（构造函数
  传入，不 `login()`）；SDK 是 `modelscope-hub==0.4.6`（找不到时提示 pip 装，或放 `.local/modelscope-sdk`）。
  断点续传靠 `.cache/modelscope-publish/<数据集>-<分支>-<索引sha1>.json` tracker。
- 成功后打印客户端需要的路由模板：`SP_RESOURCE_PACK_ROUTES=["https://modelscope.cn/datasets/Misyra/Arknight_Assets/resolve/master/{file}"]`——这正是 `shared/resourcePackRoutes.js#DEFAULT_RESOURCE_PACK_ROUTES` 的默认值。

**红线（[AGENTS.md](../AGENTS.md)「ModelScope is append-only and incomplete」）**：数据集早于现有美术、不齐全，
所以只做加法——追加新包、追加索引条目；**永不改写、重编号、重打包或删除既有包**。老索引点名的每个 ZIP 必须
永远可解析，任何一次发布都不能让老客户端 404。包文件名内容寻址正好保证这一点：新素材产生新文件名，旧名
永远不变。

### 1.3 R2 逐文件回退

两个发布工具把 `public/{assets,fonts,media}` 全树传进 R2 桶，语义相同、API 不同：

- **`tools/r2-s3-upload.mjs`（主力）**：S3 兼容 API + 手写 AWS SigV4 签名（`putObject`），不用 wrangler、不用
  Cloudflare v4 token。凭据从 `.env`（git-ignored）或环境变量取：`R2_BUCKET`、`R2_ACCOUNT_ID`（或
  `R2_ENDPOINT_HOST`）、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_REGION`（默认 `auto`）。
  默认并发 6，5 次、5xx/429 指数退避；退出码 0 完成 / 1 无事可做或用法错 / 2 上传失败。
- **`tools/r2-sync.mjs`（旧线，仍可用）**：Cloudflare v4 API + wrangler OAuth token（401/403 时自动
  `wrangler whoami` 刷新；全局限速 300 ms/请求，429 全局冷却）。`--metadata-only` 只刷新清单、拒绝任何
  未发布的字节变化；`--push` 打印把清单交给 CDN 服务器的 scp 说明（清单不入库，2026-10-19 起）。
- 两者共同的 diff 规则：**`.assets-manifest.json` 就是断点续传状态**。它记录每个路径上次发布的内容指纹
  （`published-assets.mjs`：`hashes` = 路径→SHA-256 前 16 位，`preload` = 路径→{SHA-1 前 12 位, size}，`tag` =
  全部 path+hash 的 SHA-256 前 16 位）；一个 run 只上传指纹与上次不同的对象，**全部 PUT 成功之后**才重写
  清单——中断的 run 不动清单，重跑就是接着传。`r2-s3-upload.mjs` 的清单写入是原子（临时文件 + rename，
  防止半截清单让下次 run 全量重传）；`r2-sync.mjs` 是普通 `writeFileSync`。
- **`--packs`（仅 r2-s3-upload.mjs）**：把 `data/resource-packs.json` 点名的 ZIP 也传进 R2。逐文件请求走 R2、
  预载走 ModelScope 的分工下这是例外通道（部署了本地包索引又想从 R2 供包的安装用）；默认不传。
  ZIP 的上传增量记在 `.resource-packs-published.json`（git-ignored）。
- 没有 R2 要发布、只想要逐文件指纹清单的机器（比如构建 CDN-only Docker 镜像）用
  `npm run manifest`（= `tools/build-assets-manifest.mjs`）：本地算指纹生成 `.assets-manifest.json`，不上传。

## 2. 状态文件地图

「乱」的一大来源是这些文件名字相近、职责相邻。一表定责任（★ = git-ignored，只在发布/部署机上有）：

| 文件 / 端点 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `data/assets.json`（入库） | `tools/fetch-assets.mjs` 全量重建；`tools/install-skins.mjs` 逐皮肤 splice（原子写，见 `writeFileIfChanged`） | 服务器下发、预载清单来源 | 素材清单主文件；皮肤条目（`chars[].skins[]`）随安装累积 |
| `data/skins-installed.json` ★ | `tools/install-skins.mjs` | 同上 + doctor | `{version:1, installed:[skinId]}`——**这台机器**装了哪些皮肤 |
| `data/asset-hashes.json` ★ | `tools/asset-hashes.mjs`（跑完 `npm run assets` 后） | `server/resources.js#collectRealHashes` | `{version:1, files:{url: sha1 前 12 位}}`——预载清单的逐文件指纹 |
| `.cache/asset-hashes.json` ★ | `server/http/assetIndex.js`（启动 1 s 后后台建） | 同文件 + `hashedFileOpts` | `{version:1, files:{rel:[size,mtime,sha256 前 16 位]}}`——**URL 改写**用的源站哈希索引，与上面那份 schema、用途、算法都不同 |
| `data/resource-packs.json` ★ | `tools/build-resource-packs.mjs` | `static.js` 端点、`createResourceIndex`、两个 R2 工具、modelscope-packs.py | 预载包索引（format `stronghold-resource-pack-index` v1） |
| `.assets-manifest.json` ★ | `tools/r2-s3-upload.mjs` / `tools/r2-sync.mjs` 上传成功后；`tools/build-assets-manifest.mjs` 本地生成 | `server/assetVersion.js#readAssetsManifestFile`、`createResourceIndex` | `{tag, hashes, preload}`——CDN 逐文件 `?v=` 指纹 + CDN-only 安装的尺寸/指纹 |
| `.resource-packs-published.json` ★ | `resource-pack-publish.mjs#commit` | 同文件 | `{路径: 整包 sha1}`——R2 侧包上传的增量状态 |
| `/data/resource-manifest.json`（**不是文件**） | `server/resources.js#createResourceIndex` 现场生成 | 客户端预载 | 预载清单端点，见 §3.2 |

`server/plugins/identity.js#PRESENTATION_DATA` 把 `resource-packs / asset-hashes / skins-installed / assets-collab /
local-fx-collab` 都列为展示数据：它们不进插件内容哈希，换一台机器装出不同内容不影响对局一致性。

## 3. 客户端流（`public/js/resources/`）

### 3.1 入口与选择

标题画面右下角的「预载资源」卡（`public/js/ui/resourcePanel.js#ResourceLauncher`）→「预载资源管理」对话框
（设置 ▸ 预载资源挂的是同一个组件）。四个范围：必备（tier 1：地图/干员图/Spine/UI/字体）、干员语音（tier 2，
可选语种）、干员皮肤（跟随已装备 `charId/skinId` 或全部，全部 ≈ 328 MiB，`store.js#normalizeSkinScope`）、
额外特效（`fx: true` 条目）。快捷方案「仅必备 / 日常推荐 / 完整预载」。`main.js#syncResources` 在启动与设置
变化时驱动 `resources/index.js`。

### 3.2 预载清单端点：`GET /data/resource-manifest.json`

`server/resources.js#createResourceIndex` 现场生成（`static.js:321` 拦截，永远不是磁盘文件）：

- 来源：`data/assets.json` + `data/local-assets.json` + `data/local-fx.json`（合并 groups）+
  `data/asset-hashes.json` + `.assets-manifest.json`（CDN-only 安装从这里补**尺寸**与**哈希**——`publishedSizes`
  / `publishedHashes`，只补缺、不覆盖已有）+ `data/resource-packs.json`（有则把 `packs` 经
  `shared/resourcePackRoutes.js#routeResourcePacks` 挂进响应）。站点自带的表情图（`shared/constants.js`
  `CUSTOM_EMOTE_THEME`）单独补录，且只有文件真在盘上才算。
- 每个文件条目：`{url, tier, size?, hash, skin?: 'charId/skinId', fx?: true}`——`skin`/`fx` 是本仓库加的，
  客户端按它们分组皮肤预载与「官方特效」开关（`server/resources.js#skinKeyForPath`、`tierForPath`）。
- 哈希优先级：发布清单（`.assets-manifest.json` preload，12 位 SHA-1）> `asset-hashes.json` /
  `local-assets.json` 组内哈希 > 本机现算（仅自带表情）> 合成兜底 `syn-<源清单戳的 shortHash>`。
- `version` 是全部 `url|hash|tier` 的 shortHash——信息性字段，但集合或哈希一变它必变。
- 响应头：请求带 `?v=<本次发布的 asset tag>` 且 tag 校验通过（`static.js:288 tagVerified`）→
  `immutable` 缓存一年；否则 `no-cache`。清单 URL 本身版本化（`common.js#resourceManifestUrl` 拼全局
  `__spAssetVersion`），命中时浏览器不用重验整份多 MB 清单。

### 3.3 自动分包阶段（transport）

`resources/index.js#preloadTransportPacks`（`index.js:488`）在逐文件下载**之前**跑，把清单里的 `packs`
（`common.js#validateResourcePacks` 再筛一遍形状）按「当前选择缺 ≥5% 未缓存字节」挑出来（0.3.4 起从 25%
放宽，皮肤合并包免门槛）：

- 每包先整包校验再写缓存：`transport.js#requestPack` 按 `pack.urls`（镜像列表，来自
  `SP_RESOURCE_PACK_ROUTES`）→ `pack.url`（源站/CDN）逐线路下载，空闲 20 s / 总 180 s 超时、1 次重试；
  `archive.js#readTransportPack` 流式算整包 SHA-1 对着索引的 `sha1` 验（`archive.js:406`），失败弃包。
  `startDownload` 给首条线路（ModelScope）透传 `preferredRetries: 2`——瞬时故障先在 ModelScope 重试，
  不立刻落 R2；该参数默认 `null`，不 opt-in 时线路行为与旧版一致。
- 两条网络 lane + 一个导入者，`packQueue.js` 用 96 MiB 字节预算排队，慢写入不拖慢下载。
- 面板两条进度条（下载资源包 / 解压导入）逐包跟进；导入逐文件过 `integrity.js#verifyResourceBytes`
  （12 位 SHA-1，v2 包只 SHA-1、v1 旧包 SHA-1+SHA-256），已缓存的跳过，未选中的皮肤在混合包里流过不落盘。
- 返回 `{ imported, coveredKeys, failedPacks, skippedPacks }`：成功导入的文件 key 进 `coveredKeys`，
  失败包记 `failedPacks` 并打一行日志。分包导入直接写进 Cache Storage，逐文件阶段 `status()` 已看得到，
  不会重复下载。
- **硬优先 ModelScope + 缺口兜底**：分包尽力覆盖全部所选范围，只有分包没覆盖/失败的文件才走逐文件 R2；
  索引缺失或包不全时仍全量逐文件。优先是加速与流量偏好，不是正确性依赖。

### 3.4 逐文件阶段（store）

`resources/store.js#ResourceStore` 把剩余文件写进 Cache Storage 分片缓存（`common.js#CACHE_PREFIX` =
`stronghold-resources-v1-`；兜底卡叫 `…-all`，特效按路径哈希分八片）。要点：

- 取数一律 `cache: 'no-store'`（Cache Storage 与 HTTP 缓存各存一份会翻倍磁盘）。
- **逐文件哈希校验**：清单给了 12 位内容摘要（`CONTENT_HASH_RE`）就先 `digestOf` 再 `cache.put`。
  字节不符时**换地址自愈**——对 `?sp=<file.hash>` 请求重取一次（`store.js:1093-1099`）：老 Service Worker
  可能拿自己的缓存应答了完整 URL 的请求，`?sp=` 换成一个任何缓存条目都匹配不上的地址逼它走网络；第二次
  还不符就报「资源内容与清单不一致」。这就是清单位置约 :1096 的自愈逻辑。
- 404/410 记入 `#permanentFailures`：本 run 内不阻塞完成判定（`complete`、`prune` 可达），后续 run 重试。
- 卡片索引（每缓存一个合成键 `/__sp-resource-index__`）每 64 个成功文件刷一次盘；旧布局缓存的字节先校验
  再收编（`#adopt`），跨卡错位的先搬运（`#tidy`）。

### 3.5 Service Worker 与对局内取数

预载开启时 `resources/index.js` 注册模块 Worker `public/resource-sw.js`（`?v=<发布 tag>` 版本化 URL），关闭/
清理时注销。Worker 只拦 GET 的资源树——`/assets/**`、`/fonts/**` 和无扩展名的 `/media/**` 音频路由
（`common.js#isResourcePath`；`/media/…` 由 `mediaCandidates` 映射回清单里的 `/assets/audio/…` 条目）——命中
分片缓存回，未命中透传网络（`resources/service.js#handleResourceRequest`、`readThrough.js`）。代码、`/data/`、
API、WebSocket 一律不碰，旧 Worker 永远发不出旧对局。没有 Worker 的页面照样能预载（页面自己 fetch + put），
只是**从缓存取**这一步需要它。

对局内按需取数（没预载到的文件）走 `public/js/resourceUrl.js#resourceUrl`：有 CDN 配置就经
`shared/assetCdn.js#assetCdnUrl` 上 CDN，同源时挂 `/_v/<tag>/` 前缀；玩家面板之外，游戏内「预载资源 ZIP」卡
的三个动作见 §3.6。

### 3.6 游戏内「预载资源 ZIP」卡

`resourcePanel.js` 的 ZIP 区三件套：

- **导入 ZIP**：玩家手上的包（`archive.js#importResourceZip`）流式逐条目读，整包指纹先验，每文件
  `verifyResourceBytes` 过了才写缓存、已有跳过——几百 MB 的包不整体进内存，全程不经过服务器。
- **前往下载**：打开维护者下载页。**注意：这个按钮的地址是写死的**（`resourcePanel.js:12`
  `RESOURCE_DOWNLOAD_URL = 'https://b23.tv/A4vdQ1k'`，B 站短链），与 `SP_RESOURCE_PACK_ROUTES` 无关；
  自动分包阶段的镜像列表（§3.3）才是这个环境变量管的（[DEPLOY.md §2.5](DEPLOY.md#25-玩家侧素材预载资源管理面板合并自用户分支)
  此前把两者写混，已随本文修正）。
- **导出已缓存资源**：`archive.js#exportResourceZip` 把一个范围的已缓存文件打回 ZIP 分享（同一路径不同内容
  会拒绝导出）。

## 4. 服务端流

- **清单视图**（`server/http/assetIndex.js` + `assetViews.js`）：启动 1 s 后后台对 `public/{assets,fonts}` 建
  SHA-256 前 16 位索引（缓存 `.cache/asset-hashes.json`，按 size+mtime 增量），`/data/assets.json` 等五个
  清单视图（`assetViews.js#VIEW_MANIFESTS` 含 `assets-collab.json`、`local-fx-collab.json`）里每条美术 URL
  挂 `/assets/~<hash>/…` 哈希段；Spine 一个模型共享一个模型哈希。机制细节是 ASSETS.md 的领域，不重复。
- **CDN 配置下发**：`static.js:231` 生成 `/js/asset-cdn.js` 运行时模块（`ASSETS_CDN` / `DATA_CDN` /
  `ASSETS_MANIFEST` 三个常量），页面经它拿到 CDN 基址与逐文件指纹清单地址。`assetVersion.js` 在项目根读
  `.assets-manifest.json`（`readAssetsManifestFile`，格式校验 + 50000 条上限），提供 `/assets-manifest.json?v=<tag>`
  端点给客户端逐文件哈希（**不带或带错 `?v=` 一律 404**——一份清单的指纹不能挂到别的发布上）。
- **`shared/assetVersion.js` 的发布 tag**：`createAssetVersion` 按内容算 runtime/art/总三个 16 位 tag，
  `expectedTag(path)` 决定哪类 URL 对应哪个 tag；`static.js` 的 `tagVerified`（`?v=` 校验）与 `/_v/<tag>/`
  前缀都拿它当「这字节不再变」的凭据，通过才给 `immutable`。
- **静态服务缓存策略**（`server/http/files.js#cacheControlFor`）：HTML `no-cache`；`/_v/` 或 `?v=` 校验通过 →
  `IMMUTABLE_CACHE`（31536000）；`/data/versions/…?v=` → immutable；Vite 构建产物
  `/build/assets/<名>-<哈希>.<ext>`（白名单含 webp/jpg/gif/avif 等，b21e8516 补齐）→ immutable；
  **`/resource-packs/<名>-<12hex>.zip`（文件名带整包哈希）→ immutable**；图标/manifest.json 1 小时；
  裸 `assets/fonts/vendor` 路径 1 天。
- **`SP_RESOURCE_PACK_ROUTES`**（`server/index.js:330` → `shared/resourcePackRoutes.js#parseResourcePackRoutes`）：
  JSON 数组，元素是目录 URL、`.zip` 直链或 `{file}` 模板；空串关闭全部路由。它两处生效：
  `routeResourcePacks` 把镜像列表 `urls` 挂进 `/data/resource-packs.json` 与预载清单的每个包（部署索引自带
  的 `urls` 字段会被删掉——**服务端设置才是权威**），`resourcePackUrls` 保证源站地址永远排在镜像之后兜底；
  `server/http/csp.js:45-53` 据此放开 `modelscope.cn`（含子域与 `cdn-lfs-cn-*`）的 `connect-src`。

## 5. 缓存与 CDN

### 5.1 对象元数据：1 年 immutable（b21e8516，已生效）

两个 R2 工具给每个素材对象发 `Cache-Control: public, max-age=31536000, immutable`（`ART_CACHE_CONTROL`），
预载包 ZIP 同策略。安全性论证：客户端生成的每个素材地址都是内容钉死的——逐文件 `?v=<文件哈希>`（清单在
时），清单缺失/没赶上时回退 `?v=<发布 tag>`（`shared/assetCdn.js#assetCdnUrl` 三形态，**不再发裸地址**）。
字节不变 URL 就不变，一年期对 CDN 边缘与浏览器都安全。被替换的每小时重 MISS 策略（b21e8516 前）的问题
是：活跃 URL 每小时整点在边缘全部失效。

### 5.2 Cloudflare 缓存规则（**待办**——用户尚未在 Cloudflare 上操作）

域名 assets.misyra.com 的两层规则布局（按 Cloudflare 缓存规则的求值顺序，查询串规则放上方）：

1. **上方新增：`v=` 查询串规则（待创建）**——主机名 = assets.misyra.com、URI 查询字符串包含 `v=` →
   边缘 TTL「忽略源站 Cache-Control，设为 1 年」（浏览器 TTL 同理）。带 `v=` 的地址内容钉死，永远安全。
2. **下方已有：路径前缀规则（保持原样）**——现存的路径规则不动。
3. 不带 `v=` 的地址（预载清单里的裸地址、`/_v/latest`）不进规则 1：裸地址只被预载/SW 的 `no-store` 取数和
   哈希校验消费，维持源站元数据即可。

`/_v/latest?t=<now>`（`shared/assetCdn.js#cdnLatestUrl`）永远回源——`t=` 时间戳让免费版把查询串算进缓存键，
服务器启动时经 `resolveAssetsCdnVersion` 问它拿当前发布 tag，省手配 `SP_ASSETS_CDN_VERSION`。

### 5.3 整桶重传迁移旧元数据

b21e8516 之前上传的对象带旧 `max-age=3600`，对象元数据**只跟 PUT 走**：不改字节就不换元数据。想让全桶立即
生效：把发布机的 `.assets-manifest.json` 挪开再跑一次发布工具（无上次指纹 → 全量重传并写上新元数据），传完
清单恢复。迁移期间裸地址的边缘缓存若还留着旧 1 小时条目也无害——预载/SW 对每个文件都做内容哈希校验
（§3.4），错字节过不了校验，`?sp=` 重取兜底；逐文件 `?v=` 地址则因边缘 miss 回源拿到正确字节。之后再跑
`resources:packs`/发布前，先确认 `.assets-manifest.json` 与盘上字节一致（包构建器同样按盘上字节重哈希，
`build-resource-packs.mjs:32` 注释：旧清单不得授权过期包字节）。

## 6. 当前状态与缺口（截至 2026-11-09）

### 6.0 资源线盘点后的现状（2026-11-09，PLAN-2026-11-09）

- **预载包线暂停，数据集已清空待重建。** 服务全下线后维护者拍板「全清」：ModelScope 数据集
  `Misyra/Arknight_Assets` 的 149 个 ZIP（2,019.9 MiB）与远端索引 resource-packs.json 已全部删除
  （git commit `d281a60`；每包 sha256 与字节留档在仓库根 `MODELSCOPE-CLEANUP-2026-11-09.json`）。
  复活时按届时拍板的粒度重新建包建索引——不在这份 149 包索引上追加。本节以下小节与 §6.1 的
  三份索引对照均为删除前的 2026-11-05 实测快照，仅作历史口径保留。
- **代码线（新增）：ModelScope 创空间已上线。** 浏览器代码（js / vendor / shared / sim）以内容寻址
  单树 `code/<树tag>/<root>/…` 发布到创空间 `Misyra/arknight-proto`（`tools/studio-publish.mjs`，
  append-only；tag 公式 import 自 `server/assetVersion.js`，与服务端 importmap 逐字节一致）。
  配 `SP_CODE_CDN` 后页面代码走创空间，源站 `/_v/` 持同字节作回退；与预载包线互相独立。
- **R2 逐文件线保留为美术兜底。** 两个 945MB 老整包（`assets/pack/` 与 `pack/`，同一 ETag 存两遍、
  0.3.3 起零引用）已于 2026-11-09 删除（桶 4.54→2.65GB）；逐文件对象与 `.assets-manifest.json` 不动。

以下来自本仓库可直接核对的证据（git 记录、清单内容、磁盘状态）；§6.1 的两站点与数据集数字为 2026-11-05 线上实测：

- **皮肤：清单 280 套 / 176 位干员，磁盘 1 套。** 提交版 `data/assets.json` 登记 280 条 `chars[].skins`
  条目（其中 57 条带 `dynamic` 动态立绘），但本机 `data/skins-installed.json` 只装了
  `char_1014_nearl2@epoque#17`（耀骑士临光 epoque#17），逐条对盘：280 套皮肤只有这 1 套的 Spine/头像在
  `public/assets/` 里，其余 279 套（含 56 条动态立绘）文件缺失。**后果**：从本检出起服，预载清单会照发这
  279 套的地址，客户端逐文件阶段会对它们收 404（进 `#permanentFailures`，不阻塞完成）；`npm run
  resources:packs` 若不限定 scopes 也会因缺文件失败。这些条目是发布机上安装后提交的（b21e8516 的
  data/assets.json 变更即一次皮肤安装行），磁盘在哪台机器有什么、R2/ModelScope 上对应什么，**需维护者确认**。
- **联动包：`public/assets/collab/` 整体缺失。** `data/assets-collab.json` 声明 7 位联动 6★
  （ash / yato2 / orchd2 / ela / marcil / oblvns / makoto，即 `data/backups.json#diy.excluded` 的全体）+
  1 个召唤物（艾拉的 雷鸣地雷）与 2 位干员的语音/SFX，`stats.files` 合计 **279** 个文件；`shared/collabAssets.js`
  要求全部 URL 落在 `/assets/collab/` 前缀下，本检出该目录不存在——联动干员在本机全部无图无模型。联动包按设计
  不进普通素材树（ASSETS.md「The collab pack」），它自己的发布状态（`tools/collab-assets.mjs --check` 输出）需维护者确认。
- **模块图标缺 `trp-d.png`。** 清单 `modules['trp-d'] = '/assets/module/trp-d.png'`，`public/assets/module/`
  里有 `trp-x.png`、`trp-y.png` 等，唯独没有 `trp-d.png`（其余 `-d` 图标：aft/bla/ccr/lor/msc 都在）。
  需要补抓该图标并重跑相关哈希。
- **发布机产物不在仓库里。** `data/resource-packs.json`、`public/resource-packs/`、`.assets-manifest.json`、
  `.resource-packs-published.json`、`data/asset-hashes.json` 全部 git-ignored 且两个本地检出都没有——当前
  ModelScope 数据集与 R2 桶上实际有哪些包/对象、索引版本多少，仓库内查不到，**需维护者确认**（可在发布机跑
  `python tools/modelscope-packs.py`（dry-run）与 `node tools/r2-s3-upload.mjs --dry-run --packs` 得到清单）。
- **Cloudflare `v=` 缓存规则未建**（§5.2 标注的待办）。

### 6.1 三份索引不是同一份（2026-11-05 线上实测；存档口径——所列 ZIP 已于 2026-11-09 全部删除，见 §6.0）

排查预载包数量时最容易混的一点：**「数据集里有多少 ZIP」≠「索引文件里有多少条」≠「线上用哪份索引」**。
三者是不同对象，数字对不上是正常的，口径如下（两个站点 `GET /data/resource-packs.json` 与数据集 git 树实测）：

| | 是什么 | 数 |
| --- | --- | --- |
| 数据集 git 树（物理 ZIP） | ModelScope `/datasets/Misyra/Arknight_Assets` 里实际存的包 | **134** |
| 数据集里的 `resource-packs.json` | 之前 append-only 发布到 ModelScope 的**索引文件**，rv `c8f1b9c8fcf0`，fx29 + skin51 | **80 条** |
| 线上两站 `/data/resource-packs.json` | 游戏服自己 `data/` 里的索引，rv `9bbdb783cc7a`，第一代全量切分 | **106 条** |

线上两站（game.misyra.com / test.rainya.me）的 `/data/resource-packs.json` **字节级相同**，且预载清单
`/data/resource-manifest.json` 内嵌的 `packs` 与它逐字段相等；两站是不同构建（asset/runtime/art 版本不同、
manifest `files` 数与体积不同），但共用这一份 106 包索引。106 个包的 `urls[0]` 全部指向 ModelScope，
2026-11-05 逐个 `resolve` 全 200、零缺失——它们都在数据集里。

134 个物理 ZIP 由两份索引交叉覆盖：

```
134 = 52（线上 106 ∩ 数据集 80 索引都点名）
    + 54（仅线上 106 点名：bgm/character/map/other/sfx/spine/ui/voice*，第一代全量分包）
    + 28（仅数据集 80 索引点名：fx-append-01 + extra-skin-01..27）
```

即线上 106 = 52 + 54，数据集 80 索引 = 52 + 28。「数据集里索引只有 80 条」不代表「数据集里只有 80 个 ZIP」；
判断任何包能不能删、有没有活客户端在用，要以**线上那份 106** 为准，不能只盯着数据集里那个 80 条索引文件。

## 7. 发布 SOP：新增素材 → 建包 → 传 R2 → 追加索引

前提：在**装有完整素材**的发布机上做（需要 `public/assets/` 齐全 + Python 3 + `modelscope-hub==0.4.6` +
R2 凭据 `.env`）。

1. **拿到素材**：官方数据更新走 `npm run assets`（全量计划与校验，见 ASSETS.md）；单套皮肤走
   `node tools/install-skins.mjs add <skinId>…`（几秒，原子 splice 进 `data/assets.json` 并写
   `data/skins-installed.json`，重跑即续传）；联动走 `tools/collab-assets.mjs`。提交清单变更（golden 不动——
   这是展示数据，不进内容哈希）。
2. **刷新预载指纹**：`node tools/asset-hashes.mjs` 重新生成 `data/asset-hashes.json`（`--check` 只验）。
3. **建预载包**：`npm run resources:packs`（全量；只更新特效/皮肤组用 `-- --scopes fx` / `skin`；
   只补「索引还没点名」的增量用 `-- --scopes gap [--dry-run]`，见 §1.1）。产出新 ZIP 与
   **合并后**的 `data/resource-packs.json`——scoped / gap 构建保留其它组的既有包，
   `resourceVersion` 随包集合重算。内容变了就是新文件名（内容寻址），旧 ZIP 原样留在
   `public/resource-packs/`。`gap` 是纯追加，旧 `packs` 一条不改，新包 id 带 `gap-` 前缀。
4. **追加发布到 ModelScope**：`python tools/modelscope-packs.py`（dry-run 看清单）→ `--apply`。只有当前索引
   点名的 ZIP 会上传，老 ZIP 与远端遗留文件不动；末了把新的 `data/resource-packs.json` 部署到各游戏服并重启
   （或打进更新包）。
5. **逐文件进 R2**：`node tools/r2-s3-upload.mjs`（默认不带包；要 R2 也供包加 `--packs`）。diff 只传变的，
   全部成功才重写 `.assets-manifest.json`；失败退出码 2、清单不动，重跑续传。用 CDN 的服务器要拿这份清单
   （scp 过去或从带美术的检出构建镜像，`r2-sync.mjs#pushManifest` 的说明）；没有清单的服务器照常启动，只是
   素材 URL 不带 `?v=<哈希>`（`/healthz` 的 assetsManifest 为空）。
6. **核对**：dry-run 两个工具各跑一遍确认零 pending；开一台客户端看预载面板的两条分包进度与逐文件校验；
   `/healthz` 看 assetIndex/assetsManifest 状态。

红线复述（详见 §1.2）：ModelScope 上只追加；`.assets-manifest.json` 是断点续传状态不是索引——挪开它等于
宣布全量重传；`data/resource-packs.json` 的老条目永远指向必须可解析的 ZIP。

## 8. 速查表

| 工具 / 脚本 | 命令 | 动什么 | 什么时候用 |
|---|---|---|---|
| `tools/fetch-assets.mjs` | `npm run assets` | 下载 `public/{assets,fonts}`、重建 `data/assets.json` | 官方数据更新后的全量安装（ASSETS.md 详述） |
| `tools/install-skins.mjs` | `node tools/install-skins.mjs list / add <skinId>… / remove / add-char <charId>…` | 单套皮肤的 7+ 文件、`data/assets.json` 皮肤条目、`data/skins-installed.json` | 游戏内「安装」按钮的后端；逐套补皮肤 |
| `tools/asset-hashes.mjs` | `node tools/asset-hashes.mjs [--check]` | 生成/校验 `data/asset-hashes.json`（12 位 SHA-1） | 每次素材变化后、构建预载清单前 |
| `tools/build-resource-packs.mjs` | `npm run resources:packs [-- --scopes fx,skin\|gap] [--dry-run]` | `public/resource-packs/*.zip` + `data/resource-packs.json`（经 `resource_packs.py`）；`gap` 只补索引缺口、纯追加（`tools/assets/gapPacks.mjs`） | 发布机上，指纹刷新之后；新素材/新类别/杂项资源补包用 `gap` |
| `tools/modelscope-packs.py` | `npm run resources:publish`（默认 dry-run；`--apply` 才传） | ModelScope `Misyra/Arknight_Assets`：当前索引的 ZIP + `resource-packs.json` | 建包之后；append-only |
| `tools/r2-s3-upload.mjs` | `node tools/r2-s3-upload.mjs [--bucket weishu] [--packs] [--dry-run]` | R2 桶逐文件（SigV4）+ `.assets-manifest.json`（+ `--packs` 时的包 ZIP） | R2 主发布通道；也用于整桶重传迁移元数据 |
| `tools/r2-sync.mjs` | `node tools/r2-sync.mjs --bucket <名> [--metadata-only] [--push]` | 同上，走 Cloudflare v4 API + wrangler OAuth | 旧通道/无 S3 凭据时；`--metadata-only` 只刷新清单 |
| `tools/build-assets-manifest.mjs` | `npm run manifest` | 本地生成 `.assets-manifest.json`（不上传） | CDN-only 镜像构建、无 R2 发布需求的机器 |
| `tools/resource-pack-publish.mjs` | （被两个 R2 工具调用） | 校验包指纹、产出 R2 包上传 job、写 `.resource-packs-published.json` | 不直接跑 |
| `tools/collab-assets.mjs` | `node tools/collab-assets.mjs --body <entries.json> / --fx <dir> / --check` | `public/assets/collab/`、`data/assets-collab.json`、`data/local-fx-collab.json` | 联动包的构建与校验（ASSETS.md「The collab pack」） |
| `server/resources.js` | （模块） | `/data/resource-manifest.json` 现场生成 | 服务器启动即生效，无操作 |

环境变量速记：`SP_ASSETS_CDN`（CDN 基址）、`SP_ASSETS_CDN_VERSION`（发布 tag，通常不用配——`/_v/latest`
自动解析）、`SP_RESOURCE_PACK_ROUTES`（包镜像路由，默认 ModelScope 模板，空串关闭）、`SP_ASSET_INDEX=0`
（关哈希索引）——全表在 [DEPLOY.md §12](DEPLOY.md#预载--公告相关变量合并自用户分支)。

## 9. 现状盘点与建议（「乱」在哪，怎么理）

核实过程中确认的重复与易混淆点，按影响排序；建议均为低成本整理，未实施：

1. **同名不同物，三对。** ① `/data/resource-manifest.json`（生成的预载清单端点）与 `data/resource-packs.json`
   （构建产物索引）名字互相像、内容无关；② `data/asset-hashes.json`（12 位 SHA-1，喂预载清单，
   `tools/asset-hashes.mjs` 写）与 `.cache/asset-hashes.json`（16 位 SHA-256，喂 URL 改写，`assetIndex.js` 写）
   只差一个目录；③ `tools/packs.mjs` 是语言/内容包工具，与资源预载包毫无关系，但名字最近。
   **建议**：在 `docs/ARCHITECTURE.md §3` 的文件表里给这三对加一行互相指认（本文件 §2 已可以先查）。
2. **「前往下载」与 `SP_RESOURCE_PACK_ROUTES` 的职责分界。** 按钮地址是硬编码的 B 站短链
   （`resourcePanel.js:12`），环境变量管的是自动分包的镜像列表（§3.3/§4）——两者极易被当成一回事
   （[DEPLOY.md §2.5](DEPLOY.md#25-玩家侧素材预载资源管理面板合并自用户分支) 即曾写混，随本文一并修正）。
   **建议**：若想让下载页跟着配置走，另开一个小改动把按钮改成取 `packs[0].urls[0]` 的目录页，让
   `SP_RESOURCE_PACK_ROUTES` 名副其实地成为「发布位置」的单一配置点。
3. **两条 R2 工具并存**：`r2-sync.mjs`（v4 API + wrangler OAuth、非原子清单写）与 `r2-s3-upload.mjs`
   （SigV4、原子清单写、明确的退出码）同语义不同实现，哪条是正源要靠读代码才知道。**建议**：DEPLOY.md
   已称 SigV4 为准（b21e8516 后文档），在 `r2-sync.mjs` 头注加「legacy，见 r2-s3-upload.mjs」并考虑冻结功能。
4. **清单先于磁盘（§6 皮肤 280 vs 1）没有守护。** `install-skins` 只增不删（remove 不删文件、全量重建
   `fetch-assets` 不再清皮肤条目），换机/瘦身后的检出会带着大量指向不存在文件的清单条目。预载侧行为是良性
   降级（404 计入完成），但包构建会失败、错误信息要逐个文件排。**建议**：`doctor` 加一条「清单皮肤条目 vs
   `skins-installed.json`/磁盘」的只读核对。
5. **ModelScope 凭据变量三个别名**（`MODELSCOPE_API_KEY` / `TOKEN` / `API_TOKEN`）且 dry-run 默认打印路由
   模板——把默认值印进 CI 日志无害（非凭据），但三别名建议收敛成一个并保留旧两个做兼容别名。
6. **文档三处分散**（ASSETS「Preload/ZIP resource packs」、DEPLOY §2.5/§12、散落的代码头注），本文收拢链路；
   后续规则变更请在对应章节改完再回来同步「当前状态」一节。
