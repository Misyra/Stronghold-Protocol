# 上游 v0.2.6 合并执行方案

对象：tag `v0.2.6`（`488db49f`），基线 `cf7a9400`（上游 0.2.5 tip）。本仓库 `master = d24c167b`。
上游在 0.2.5 之上有 58 个提交，自报 golden 全程不变。这次与 xinhai 无关（xinhai 没合 0.2.6，它的两条新提交与本批内容不重叠）。

**口径说明**：上游 0.2.6 改动 93 个文件（不含官方素材），其中 **43 个是"双方都动过"的重点复核文件** —— 这 43 个不等于 43 处冲突。实际干合（`git merge-tree --write-tree master v0.2.6`）只有 **22 个文件出现文本冲突标记**，其余 21 个自动合并。**自动合并成功不等于验收通过**，那 21 个同样要逐条复核（尤其是被上游单方面改写的调用签名、被改名的方法、被删的导出）。

## 0. 本次边界

| 内容 | 决定 |
|---|---|
| 素材内容哈希、`assetIndex.js`／`assetViews.js`、`~<hash>` 路由 | **本次不引入**。继续用现有 CDN `?v=<文件哈希>`（`.assets-manifest.json`）与本机 `/_v/<tag>/`（`server/assetVersion.js`） |
| Brotli、流量计数、WS 窄窗口握手兼容 | **收**，保留本仓库的配置开关、资源限制与缓存校验 |
| impostor 边界、场景光照、装置地块 | **收**，保留冻结染色、加载重试、上下文恢复修复 |
| 入场动画／音效、弹药数量、跳过按钮、魂灵之影修复 | **收**，源码与相关测试同批接入 |
| 教程下一页预载 | **收** |
| 教程 WebP 提取逻辑、测试、文档 | **收**（与源码同批）；**素材转换、清单重建、R2 发布另起一轮**（§10） |

上游流量层里最贵的两块我们已经有了：CDN 装机的 `.assets-manifest.json` 覆盖 12458 个素材、每文件一个 16 位哈希，客户端拼成 `<base>/assets/…?v=<hash>`，改一个文件只有它换 URL。所以本次不收索引层，代价是"别人 clone 起来自己开服"那类无 CDN 装机继续按整棵素材树的 `artTag` 击穿缓存 —— 那件事将来可以单做一个只在 `!cdn.base` 生效的小改。

真正值得收的是跟 CDN 无关的那几件，**第一价值是 `/ws` 的窄窗口握手兼容**：`/ws` 和 API 不走 CDN，全压在主机的上行带宽上。

## 1. 执行步骤

```bash
# 1. 备份与合并分支（保留未跟踪的方案文档）
git branch backup/pre-0.2.6
git switch -c codex/merge-0.2.6
git merge --no-commit --no-ff v0.2.6

# 2. 按 §2 的四组解决冲突，源码与对应测试同批处理
# 3. 按 §8 逐级验证
# 4. 全部通过后生成单个合并提交（含源码、测试与必要文档）
# 5. 教程 WebP 的素材发布独立提交、独立执行（§10）
```

**撤销明确不接入的层**：干合会把上游的索引层自动合进 `server/http/config.js`（`assetIndexOptionsFrom`）、`server/index.js`（`assetIndex`/`views` 接线）、`server/http/static.js` 与 `server/http/media.js` 的部分签名、以及新增的 `server/http/assetIndex.js`／`assetViews.js`。这些**全部撤掉**，并把随它们进来的测试（`test/asset-index.test.js`）一并删除；`test/render/browser.test.js` 里依赖 `srv.assetIndex` 的用例做自跳过处理。

## 2. 四组验收

分组解决、分组验收，源码与测试在同一个提交里。每组给出验收点，验收点之外的项目也不许红。

### 组 1：服务端压缩与流量

顺序：`server/http/files.js` → `server/http/media.js` → `server/http/static.js` → `server/http/config.js` → `server/http/websocket.js` → `server/http/routes.js` → `server/index.js`。

| 文件 | 处置 |
|---|---|
| `files.js` | 收上游压缩栈（`brotliParams`/`pickEncoding`/`compressStream`、`CompressCache` 按编码分键、`serveBuffer`、`opts.{contentHash,cacheControl}`）；**删掉上游的 `if (/(^\|&)v=/.test(query)) return IMMUTABLE_CACHE`**，保留我们的 `versioned` 政策与 `INSTALL_CACHE`；`GzipCache` 保留为 `CompressCache` 的别名，避免调用点大改；`get()` 的缓存键要加上编码 |
| `media.js` | 用我们的签名（无 `query`，`{variant, versioned}` + 503 `release.matchesFile` 守卫）为底；**不接** `urlHash`/`hashedFileOpts` |
| `static.js` | 以我们的发布层为底（`/_v/` 校验、`/assets-manifest.json`、`/data/resource-manifest.json`、`transform`、CORS、`/build/`）；**不接** `splitHashedPath` 剥离、不接清单视图分支。上游这部分没有可留的东西 |
| `config.js` | 只保留我们的 `announcementOptionsFrom`／`roomAdminTokenFrom`／`lobbyOptionsFrom`；**删掉 `assetIndexOptionsFrom`** |
| `websocket.js` | 保留 `SP_WS_COMPRESSION` 开关、`level: 1`、`clientNoContextTakeover`、`concurrencyLimit: 4`；收上游的 `narrowDeflateOffer()`（在 `wss.handleUpgrade` 之前删掉过窄的 `sec-websocket-extensions`）；`serverMaxWindowBits` 改成 11；收 `meterSocket`/`traffic` 依赖；导出 `WS_DEFLATE`/`narrowDeflateOffer` 两个名字 |
| `routes.js` | 以我们的 health 面为底；加 `wantsTraffic`/`isLocalIp`/`traffic.meter`；**`?traffic=1` 不得走 `createHealthBody` 的 1 秒快照**；`meter` 要装在同步 `/healthz` 快路径之前；不复活 `build: buildTag()` |
| `index.js` | 以我们的 `release()`／`cleanupRuntime` 结构为底；只接 `createTrafficCounter` 与 `traffic` 的传递（health、`attachWebSocket`、返回值）、`trustProxy`、`pickEncoding` 导出；**不接** `assetIndex`/`views`/`createManifestViews` |

**关于 WS 的收益口径**：本仓库已经默认开启 permessage-deflate。本次新增的收益是 **(1) 窄窗口 offer 不再导致握手被拒**（客户端只声明 `server_max_window_bits=9` 时，现在会 400 拒掉整个握手），**(2) 流量观测**。12 → 11 可以采用（与上游一致、字典窗口更小），但**不要写成"每连接 zlib 状态减半"** —— 窗口减半只是压缩字典那一小块，连接状态的大头是 memLevel 与并发上限。

验收点：
- `npm run test:browser` 的 CDN 用例（`test/asset-cdn.browser.test.js`）、`test/asset-version.test.js`、`test/lobby.test.js` 的缓存断言；
- 新增 `test/traffic.test.js`（改造后）与 `test/ws-compression.test.js` 的并集（我们的开关/lib 用例 + 上游的窄窗口与裸 header 用例）；
- **`gzip` / `br` / `identity` 三种编码下 `ETag` 与 `Range` 都要对**：同一文件换编码必须换 ETag（上游按编码分 ETag），带 `Range` 的请求不许被压缩路径吞掉；
- **CDN 与本机两种装机模式**都要过：CDN 下素材走 `<base>?v=`，本机走 `/_v/<tag>/`，两种都要有 `?v=` 不被承诺一年、`/_v/` 字节变了 503 的断言。

### 组 2：渲染

顺序：`public/js/render/spine.js` → `impostor.js` → `units.js` → `app.js`。

| 文件 | 处置 |
|---|---|
| `spine.js` | 收上游整块 clip-bounds（`CLIP_SAMPLE_HZ 60`／`CLIP_SAMPLE_MAX 48`／`CLIP_BOUNDS_BUDGET_MS 2.5`、`requestClipBounds`／`stepClipBounds`／`pendingClipBounds`、`SpineActor.clipBounds`）；**冻结门用我们的** `!this.frozen \|\| !this._applied \|\| this.spine.tint !== this._appliedTint`，保留 `_posed` 字段与赋值（上游注释引用它）；保留我们构造函数的 try/catch 与 destroy；删掉上游那处会吞掉异常路径的提前 `return` |
| `impostor.js` | 上游整块 + 我们 4 行（`CONTEXT_UID` 变化时让 `page.cleared` 失效） |
| `units.js` | 上游为底（`playedClips`／`IMP_BOX`／`impostorBox`／`land()`／`deploying()`／`_updateAmmoCount`／`placed`），贴回我们的三处：`_loadSpine` 先建后拆 + 失败重试、`_spineTries/_retryAt` 复位、`_updateImpostor` 的 `contextUid/dirty` 复位（必须在 `_impOver()` 提前返回之前）；`_impBox()` 用上游函数体替换我们的几何框（同名不同语义） |
| `app.js` | 上游为底 + 贴回 `fpsLimit`／`restorePixiExtensions`／`renderFrameBudget`／`highlightTiles` 的 `destroyed` 守卫；`stepClipBounds()` 在 `impostors.flush()` 之前每帧调用；`replayDeploys`/`cancelReplay` 在 `setStage`／`enterBattle`／`destroy` 里取消；settings 字面量与 `setSettings` 取并集 |
| `app/tune.js` | 收 `DEPLOY_REPLAY_MS = 50` |

验收点：
- **冻结染色**：冻结中的单位在 `tint` 变化后颜色要应用（`test/render/frozen-pose.test.js`、`hered-pose.test.js`）；
- **显卡上下文恢复**：`CONTEXT_UID` 变化后 impostor 图集不出残影，且冻结/眩晕模型的姿势仍正确；
- 新增 `test/render/impostor-bounds*.test.js`（3 个）、`test/render/deploy-replay.test.js`、`test/render/hud-readouts.test.js` 的弹药块；
- `test/render/boardart.test.js` 的 `Graphics` stub 与 `c.page.bodies` → `c.box` 改名要同步；`playtest6-promote.test.js` 的 `landPiece` 源码断言要同步；
- `docs/design/client.md` 里 `SCENE_LIGHT` 从 `0.8/0.4` 改成 `1/1`。

### 组 3：音频与界面

顺序：`public/js/audio.js` → `public/js/diag.js` → `public/js/ui/gameLogic/settings.js` → `public/js/ui/gameLogic/phases.js` → `public/js/ui/settings.js` → `public/js/screens/game.js` → `public/js/ui/guide.js` → `public/js/main.js`。

| 文件 | 处置 |
|---|---|
| `audio.js` | 收上游落地音池（`LAND_VOICES`／`_playLanding`／`_stealLanding`／`warmLandings`／`deployCue`）与 BGM 静音门控（`bgmSilent`／`wantBgm`）：**`playBgm` 的守卫与 `setVolumes` 的 `wasSilent` 重启必须同批落**，否则取消静音后 BGM 不回来。保留我们的 `_buffer` 瞬时失败重试（`BUFFER_RETRY_MS`／`bufRetryAfter`）。**派生音效地址**：优先使用明确的 tokenDie 清单项；必须回退派生时，先去掉旧文件的哈希，再按**目标文件**解析地址 —— 不许沿用 `charDie` 的文件哈希 |
| `diag.js` | 收上游 traffic 块（`installTrafficMeter`／`recordResourceEntry`／`trafficSummary`／`clearTraffic`／`trafficLine`）；`trafficCategory` 只适配我们已有的两种形态（剥 `/_v/<tag>/` 前缀、认 CDN origin），**不引入 `~<hash>` 形态** |
| `gameLogic/settings.js` | `DEFAULT_SETTINGS` 与 `sanitizeSettings` 取并集（`ammoCount` + 我们的 `fpsLimit`/`preload*`） |
| `phases.js` + `gameLogic.js` | 收 `deployOrder`／`roundStartReplay` 及其 re-export（字节与 base 相同，干净落地），但**必须手工接到 `screens/game.js`**，否则是死代码 |
| `ui/settings.js` | 上游「弹药数量」`Toggle` + 提示插在「官方伤害数字」之后、我们的 `ResourceRow` 之前 |
| `screens/game.js` | 加 `roundStartReplay` 的导入与 `replayedRef` 效果；保留我们 `.gm__corner` 那层（聊天审核、作战统计按钮、公告按钮、`e.text` 守卫） |
| `guide.js` | 收上游的 `guidePreloadUrl`（只预载下一页）替换我们相邻两页那两行；保留我们的 `loadImageElement`／`recoverImageError`／`crossorigin` |
| `main.js` | 加 `installTrafficMeter()`（`installGlobalErrorHandlers()` 之后、`installDeviceSupport()` 之前）；**把 CDN origin 传给采集器**，否则 CDN 装机的素材/音频流量全被归进 `external` 桶 |

验收点：
- **静音 → 取消静音**：BGM 要回来（`test/ui/audio.test.js` 的 BGM 静音块 + 我们原有三条）；
- **入场动画的触发范围**：观战席不触发、切换轮次后按新部署顺序重放、同一次落地只响一声（`test/render/deploy-replay.test.js`、`test/ui/deploy-replay.test.js`、`test/ui/deploy-replay.e2e.test.js`）；
- 弹药数量开关开/关两态（`test/ui/ammo-count.test.js`、`hud-readouts`）；
- 跳过按钮只在"还有别人没选"时可点（`test/ui/band-draft-skip.e2e.test.js`、`test/ui/bandDraft.test.js`）；
- 我们自己的移动端回归（`test/ui/utility-mobile.test.js`、`room-mobile.test.js`）不许红。

### 组 4：规则与文档

| 文件 | 处置 |
|---|---|
| `server/sim/content/kits/ops/op-wisdel.js` | 收 #557（`battle.onFieldBoard`）；`test/content/op_wisdel.test.js` 同批 |
| `docs/history/0.2.6.md` | 收（五个测试引用 §31.8/§31.9，`test/docs-paths.test.js` 会管） |
| `docs/DESIGN.md` 的 §31 索引行 | 搬进 `docs/DESIGN.md`，href 用 `../history/0.2.6.md` |
| `docs/DEPLOY.md` | 保持删除；六段内容搬进 `custom_docs/operations/*`（§9） |
| 其余平铺文档 | 按 §9 搬进我们的目录结构 |
| 版本号四方 | `package.json` + `package-lock.json` 两处 + `shared/constants.js` 的 `APP_VERSION` 同批改成 `0.2.6` |
| `public/i18n/{en,ja,ko,zh-TW}.json` | **只合增量**：每个文件本次只多两个弹药键（`弹药数量` + 含 `13/14` 的说明）。上游这一批没有 `_about`／`_meta.credits` 的改动，不需要整份选边，我们自己的键全部保留 |
| `package-lock.json` | 整份保留本仓库版本，只改版本字段 |

验收点：`test/version.test.js`、`test/i18n*.test.js`、`test/docs-paths.test.js`、`test/docs-consistency.test.js`、`test/golden.test.js`。

## 3. 43 个重点复核文件

这 43 个是"双方都改过"的文件，含 22 个有文本冲突标记的和 21 个自动合并的。裁决见下；标 **（冲突）** 的是干合会留标记的。

### 3.1 服务端（7，全冲突）

`static.js`、`files.js`、`routes.js`、`config.js`、`media.js`、`websocket.js`、`index.js` —— 处置见组 1。共同原则：**我们的是底**（发布层、房间/健康接口、worker 与持久化、有界的 WS 压缩），上游只贡献它真正新增且与 CDN 无关的部分；索引层整块不接。

### 3.2 客户端核心（4，1 冲突）

| 文件 | 裁决 |
|---|---|
| `main.js` | 我们的 + 上游 4 行（见组 3） |
| `audio.js` | 两边都要，几乎不重叠（见组 3） |
| `media.js` **（冲突）** | 本次**用我们的**（`/_v/` 前缀 + 校验链）。将来若收 `~hash`，才需要在一个函数里组合两种方言 |
| `shared/constants.js` | 纯并集 + `APP_VERSION = '0.2.6'` |

### 3.3 渲染（4，全冲突）

`spine.js`、`impostor.js`、`units.js`、`app.js` —— 处置见组 2。

### 3.4 界面（4，2 冲突）

| 文件 | 裁决 |
|---|---|
| `screens/game.js` | 自动合并（两边行段不重叠），仍要复核 `roundStartReplay` 接线 |
| `ui/gameLogic/settings.js` **（冲突）** | 手合：注释、`DEFAULT_SETTINGS` 字面量、`@returns`、sanitize 返回；**`test/ui/gameLogic.test.js` 的 deepEqual 必须两边字段都带** |
| `ui/settings.js` **（冲突）** | 注释并集 + 弹药 `Toggle` 插点 |
| `ui/guide.js` | 收上游单页预载 |

### 3.5 元数据与 i18n（6）

i18n ×4（只合 2 个键的增量）、`package.json`（我们的 + 版本）、`package-lock.json`（我们的 + 版本）。

### 3.6 文档（7，3 冲突）

| 文件 | 裁决 |
|---|---|
| `CHANGELOG.md` | 自动合并 |
| `README.md` **（冲突）** | 用我们的 `**Run:**` 那行，把上游的 `~560 MB / ~790 MB` 并进去；`已同步至 v0.2.5` 改成 `v0.2.6`；**不收 `SP_ASSET_INDEX` 那一行**（本次不接索引层，不要给不存在的功能写文档） |
| `docs/DEPLOY.md` **（modify/delete）** | 保持删除，六段内容搬进 `custom_docs/operations/*` |
| `docs/design/client.md` **（冲突）** | 两个 bullet 拼接；收 §31.8/§31.9 与素材地址段；`SCENE_LIGHT` 改成 1/1；`docs/ASSETS.md` → `docs/ASSETS.md`；补一句我们的 CDN 形态，免得读成"只有 `~<hash>`" |
| `docs/design/geometry-time.md` | 自动合并 |
| `docs/design/network.md` | 自动合并，但 WS 参数要跟实际代码对齐（我们保留开关/level/并发/双向无上下文接管 + window 11） |
| `docs/design/overview.md` | 自动合并，补 `server/assetVersion.js` 与 `shared/assetCdn.js` 两行，标明实际部署走哪条 |

### 3.7 测试与工具（11，5 冲突）

| 文件 | 裁决 |
|---|---|
| `test/ws-compression.test.js` **（add/add）** | 保留我们的文件 + 上游三段用例（裸 header 断言、`narrowDeflateOffer` 五个分支、窄 window offer 期待 `''`），按本仓库实际配置改写 |
| `test/ui/gameLogic.test.js` **（冲突）** | sanitize 字面量取并集 |
| `test/ui/audio.test.js` **（冲突）** | 两边新测试同锚点 → 都留 |
| `test/ui/emotes.e2e.test.js` **（冲突）** | 正则并集：`/\/assets\/(?:(?:~[0-9a-f]{16}\/)?ui\/emoticon\|local\/emoticon\/ciallo)\//` |
| `test/scene-assets.test.js` **（冲突）** | 保留我们的块（`fileURLToPath` ROOT + `.gitignore` 模式） |
| `test/lobby.test.js` | 收上游压缩/ETag 断言；**`?v=` 那条按我们的语义反转** |
| `test/render/boardart.test.js` | 上游 `Graphics` stub + `c.page.bodies` → `c.box`；保留我们的 CDN 测试 |
| `test/render/board3d.test.js` | 上游 #569 断言 + 我们的 CDN 测试 |
| `test/content/tokens_summons.test.js` | 自动合并 |
| `test/ui/localArt.test.js` | 上游 `guidePreloadUrl` 块 + 我们的 `EMOTE_CATALOG` 过滤 |
| `tools/local-extract/extract.py` | 自动合并；WebP 部分随 §10 |

**不跳过测试**。URL 方言不同的用例（`test/media-url.test.js` 的 `~hash`、`test/asset-index.test.js`）改成验证本仓库实际支持的行为，或者删掉并在此文档记明理由 —— 不许留成 skip 掉的红灯。

## 4. 上游独有文件（50）的处置

**干净落地**：`shared/media.js`（仅注释）、`op-wisdel.js`、`public/dev/render-demo.js`、`board3d/{layout,materials,scene}.js`、`screens/bandDraft.js`、`ui/fieldHost.js`、`docs/META.md`、`docs/PLAYING.md`、`docs/history/0.2.6.md`、`test/render/board3d-scene.test.js`、`test/ui/bandDraft.test.js`、`test/ui/bond-audio.e2e.test.js`、`test/ui/leftovers.e2e.test.js`、`test/ui/loadout.e2e.test.js`、`test/ui/mock.e2e.test.js`、`test/ui/real.e2e.test.js`、`test/ui/band-draft-skip.e2e.test.js`、`test/e2e/{client,coop.e2e}.mjs`、`test/render/impostor-bounds.browser.test.js`。

- `board3d/{layout,scene}.js` 必须**整对**落地，否则 `board3d-scene.test.js` 的 `meshes.raised` 会红。
- `test/render/impostor-bounds.browser.test.js` 不在 `npm run test:browser` 的文件表里，要跑得手工加或单独显式运行。
- `test/ui/bond-audio.e2e.test.js` 的 `/~` 断言块在我们这里恒不进入（我们的 cue URL 用 `?v=`），无害。

**必须接线（不接就是静默失效）**：`shared/assetPaths.js`（`diag.js` 的 `trafficCategory` 依赖它，缺失会导致模块加载失败）、`server/http/traffic.js`、`public/js/diag.js`、`ui/gameLogic/phases.js` + `gameLogic.js`、`render/app/tune.js`。

**带雷**：

| 文件 | 雷 |
|---|---|
| `test/diag.test.js` | 具名 import 一堆 `diag.js` 里不存在的导出 → 链接期失败，会连带把本仓库已有的 diag 测试一起弄死。必须与 `diag.js` 的 traffic 块同批 |
| `test/media-url.test.js` | 断言 `~hash` 形态，本次不支持 → 改成验证我们的形态 |
| `test/local-extract.test.js` | 读 `jobs.guideWebp` 与 `GUIDE_WEBP_MODE`，随 §10 的提取逻辑同批落 |
| `test/asset-index.test.js` | 整块依赖不引入的索引层 → **删**，理由记在本文档 |
| `test/render/browser.test.js` | 读 `srv.assetIndex` → 该用例自跳过 |
| `test/render/{deploy-replay,hud-readouts,impostor-bounds*,playtest6-promote}.test.js`、`test/ui/{deploy-replay*,ammo-count}.test.js` | 断言的是**我们改过的文件**里的新 hunk，源码不 graft 就红（无 skip 门）。它们同时也是最好的"接线完成"验收器 |
| `docs/{ASSETS,ARCHITECTURE,DESIGN,SIM,PLAYING}.md` | 搬进我们的布局；`ASSETS.md` 的新段会撞我们的 `## Preload` 锚点，且其 `~hash`/"never ?v="/`.cache/asset-hashes.json` 说法与我们已上线的形态矛盾 → 改写或引到 `custom_docs/operations/CDN.md`；`ARCHITECTURE.md` 点名三个我们不放的文件 → 必须删掉那几行，否则 `test/docs-paths.test.js` 红 |

## 5. 接缝与陷阱

1. **`/healthz?traffic=1` 不得走 `createHealthBody` 的 1 秒快照** —— 否则要么计数器被冻住，要么主机的流量数字泄给非本地客户端（上游明确禁止；`test/healthz-cache.test.js` 也会红）。绕开快照或把 `withTraffic` 并进快照键。
2. **`traffic.meter` 装在同步 `/healthz` 快路径之前**，否则那个早返回的响应不被计量。
3. **`runtimeCleanup.js` 解构固定键集** —— 将来若收索引层，必须把 `assetIndex, views` 加进去，否则 `release()` 静默不关（句柄泄漏）。本次不接索引，但这条要留在文档里。
4. **`WS_DEFLATE`/`narrowDeflateOffer` 要按上游导出**（它的测试 import 这两个名字），但配置值用我们的：`narrowDeflateOffer` 的比较基准必须等于实际生效的 `serverMaxWindowBits`。
5. **`_posed` 字段保留、门用我们的**（组 2）。
6. **`units.js:_impBox` 同名不同语义** —— 是"替换函数体"，不是"合并"；我们的缓存与 `_updateImpostor` 的 `contextUid` 修复要留下。
7. **`land` 在 sim kit 里也用了**（`server/sim/content/kits/ops/*`、`enemies/fly.js` 的模块内 helper），别把两边接起来。
8. **`bgmSilent` 的守卫与 `setVolumes` 的 `wasSilent` 重启同批落**。
9. **派生音效地址**：`tokenDieUrl()` 会被 `?v=<hash>` 卡住；修法是优先用明确的 tokenDie 清单项，回退派生时去掉旧文件哈希、再按目标文件解析地址。`map.js`/`tiles.js` 那类派生地址是同一类问题，合并时扫一遍。
10. **`compressed()` 的缓存键要带编码**，否则 br 与 gzip 会互相污染。
11. **`transform` 与清单视图的归属**：本次只有我们一方写 `/data/assets.json`，不接视图分支就没有双写问题（这也是不收索引层的一个附带好处）。

## 6. 名字撞车

| 名字 | 上游 | 我们 | 处理 |
|---|---|---|---|
| `_impBox()` | 按 clip 量、可返 null、带 `over` | `spine.getLocalBounds()` 几何框、永不 null | 用上游函数体 |
| `serveFile`/`serveMedia` | 带 `query` + `hashedFileOpts` | 无 `query`，`{body,variant,versioned}` | 我们的签名 |
| `healthReport` | 加 traffic/assetHashes | 我们重写的字段集 | 我们的 + `withTraffic` |
| `GzipCache` | 改名 `CompressCache` | `GzipCache.get(…, variant)` | 用 `CompressCache`，导出 `GzipCache` 别名 |
| `WS_DEFLATE` | 常量 | `perMessageDeflateFor()` | 两个名字并存 |
| `asset-hashes.json` | `.cache/asset-hashes.json`（SHA-256 16 hex，URL 段索引） | `data/asset-hashes.json`（SHA-1 12 hex，预载指纹） | **不是一回事**，文档里分开写 |

## 7. 明确不接入 / 不修回去

- 不引入 `server/http/assetIndex.js`、`server/http/assetViews.js`、`~<hash>` 路由、`assetIndexOptionsFrom`、`createManifestViews`；不在 HTTP 层调用 `splitHashedPath`。
- 不把上游的 `/(^|&)v=/ → immutable` 加回来。
- 不用上游的 `!this.frozen || !this._posed` 替换我们的冻结门。
- 不把 `_impBox()` 换回几何框。
- 不收上游的 `package-lock.json`。
- 不复活 `buildTag()` 扫描（现行是 `build: serveStatic.version`）。
- 新文档里不得把 `data/asset-hashes.json` 与 `.cache/asset-hashes.json` 混为一谈。

## 8. 逐级验证

```bash
npm run lint
npm run typecheck
npm run check:imports
npm test
npm run golden
npm run build
npm run test:browser
npm run test:client
```

外加**显式**运行上游新增的渲染/入场动画浏览器测试（它们不在默认脚本的列表里）：

```bash
RENDER_E2E=1   CHROME_PATH=<chrome> node --test test/render/impostor-bounds.browser.test.js
SP_E2E=1       CHROME_PATH=<chrome> node --test test/ui/deploy-replay.e2e.test.js test/ui/band-draft-skip.e2e.test.js
```

以及本仓库的移动端回归：`test/ui/utility-mobile.test.js`、`test/ui/utility-mobile.e2e.test.js`（opt-in）、`test/ui/room-mobile.test.js`。

**golden 预期零变化**。有差异先解释原因 —— 要定位到具体场景与字段、说清是哪一处的语义改动导致的；**不得仅凭"涉及维什戴尔"就更新基准**。确认合理后，按 `test/golden/README.md` 的既有先例把"哪几个场景、为什么"写进 README 再 `npm run golden:update`。

**本次合并不改变素材内容与 URL 形态**，所以 `.assets-manifest.json`、`data/asset-hashes.json`、`packs/index.json` 都不需要动（教程 WebP 那一轮除外，见 §10）。

## 9. 文档迁移

`docs/DEPLOY.md` 的六段 → 我们的布局：

1. 网络/磁盘两行（WS 压缩数据、`完整包解压后约 790 MB`）→ `custom_docs/operations/HOME_SERVER.md`（顺手把过时的 505/710 MB 改成 560/790 MB）。
2. 「固定访问地址能省很多流量」整段 → `custom_docs/operations/HOME_SERVER.md` 隧道小节旁。
3. 压缩（brotli）与 Cloudflare 缓存规则两段 → `custom_docs/operations/DEPLOY.md` 反向代理节 + `custom_docs/operations/CDN.md`。
4. 两条排查行（哈希段、`/healthz?traffic=1`）→ `custom_docs/operations/DEPLOY.md` 排错表 + `custom_docs/operations/MONITORING.md`。
5. 教程图 WebP 说明 → `docs/ASSETS.md` + `custom_docs/operations/PACKAGING.md`。
6. 平铺文档并入：`ARCHITECTURE/ASSETS/DESIGN/META/SIM → custom_docs/development/`、`PLAYING → custom_docs/guides/`、`history/0.2.6.md → docs/history/`。

搬迁时用**我们实际的 URL 形态**写（CDN `<base>/assets/…?v=<hash>`、本机 `/_v/<artTag>/…`），不要照抄"`~<hash>` 是唯一形态"。

## 10. 教程图 WebP：独立一轮

代码、测试、文档与源码合并同批落（`tools/local-extract/extract.py` 的 `jobs.guideWebp`、`GUIDE_WEBP_MODE`、`test/local-extract.test.js`、`docs/ASSETS.md`）。**素材转换与发布另起一轮**：

```bash
python3 tools/local-extract/extract.py --webp   # 由现有 PNG 生成 WebP 副本
# 检查文字清晰度与页面加载（19 页，质量 90，放大两倍对比）
node tools/asset-hashes.mjs                     # 刷新 data/asset-hashes.json
node tools/r2-sync.mjs                          # 重写 .assets-manifest.json 并同步 R2
```

然后用**CDN 与本机两种装机模式**各验证一遍教程页能正常显示，再提交相关清单。官方素材仍不入库。

## 11. 交付说明要写清

- 拒收项（索引层、`~<hash>` 路由、上游 `package-lock.json`）及理由；
- 冲突裁决（22 个文本冲突文件逐个说明取谁、为什么）；
- 四组验收的测试结果；
- **未执行**的浏览器检查（哪些 opt-in 套件没跑、为什么，比如机器上没有 Chrome）。

---

## 12. 执行记录（2026-10-13）

已按本文档执行完毕，合并提交 `7768704a`（双亲 `d24c167b` + `488db49f`），分支 `codex/merge-0.2.6`，备份分支 `backup/pre-0.2.6`。

**范围**：上游碰了 93 个文件（不含官方素材），其中 43 个是双方都改过的重点复核文件，22 个出现文本冲突。提交里相对上游的差异是 89 个文件。

**拒收 / 不接入**

| 项 | 处理 |
|---|---|
| `server/http/assetIndex.js`、`assetViews.js`、`test/asset-index.test.js` | 新文件删除，不进仓库 |
| `assetIndexOptionsFrom`、`createManifestViews`、`assetIndex`/`views` 接线、`hashedFileOpts`、`splitHashedPath` 的 HTTP 挂点 | 未接入（`config.js`、`static.js`、`media.js`、`routes.js`、`index.js` 均解回本仓库原样） |
| 上游的 `/(^&)v=/ → immutable` 规则 | 删除，保留本仓库的 `versioned` 政策（`test/lobby.test.js` 的断言保持不变） |
| 上游的 `package-lock.json` | 只取两处版本字段，依赖树保留本仓库的 |
| `~<hash>` 音频方言 | 不收；`public/js/media.js` 继续用 `/_v/<tag>/` 形式，`test/media-url.test.js`、`test/ui/audio.test.js` 改成验证本仓库的行为 |
| `test/asset-index.test.js` 的全部用例 | 不适用（依赖拒收的层），已删除 |

**净无差异（解回本仓库原样，因此不在提交里）**：`server/http/static.js`、`server/http/config.js`、`test/scene-assets.test.js`。

**冲突裁决要点**（详见提交信息与 §2）：`files.js` 收上游压缩栈 + 本仓库缓存政策；`websocket.js` 收 `narrowDeflateOffer` + `meterSocket`，window 12 → 11，保留开关与并发上限；`routes.js` 的 `?traffic=1` 闸门放进 `serveHealth`（同步快路径会绕过 `handleRequest`），`meter` 装在快路径之前；`spine.js` 收整块 clip-bounds，冻结门用本仓库更严的条件；`units.js` 收上游 impostor/弹药/入场动画，保留 `_loadSpine` 重建与 `contextUid` 修复；`audio.js` 两边都要，`tokenDieUrl` 改为按目标文件解析；`diag.js` 的 `trafficCategory` 只认 `/_v/` 与 CDN 源。

**验收结果**（`codex/merge-0.2.6`）

| 检查 | 结果 |
|---|---|
| `npm run lint` | 0 error，143 个既有 warning（与合并前同源，未新增） |
| `npm run typecheck` | 干净 |
| `npm run check:imports` | 无越界 |
| `npm test` | 7096 项，**0 失败**，41 项 opt-in 跳过 |
| `npm run golden` | **287 场景零变化**（roster 49 / bonds 46 / fields 22 / matches 20 / standins 10 / diy 140） |
| `npm run build` | 通过 |
| `npm run test:browser` | 16/16（首次全量运行时 `asset-cdn.browser` 抖动失败一次，单独与重跑均通过） |
| `npm run test:client` | 1/1 |
| 本机模式教程页 | `/_v/<ca3c34666c5d4012>/assets/local/guide/autochess_home_1.webp` → 200 `image/webp` immutable，240 KB |
| **未执行** | `RENDER_E2E` / `SP_E2E` 浏览器套件（本机无 Chrome）、CDN 模式验证、真机移动端 e2e |

**教程图 WebP（§10）**

- 已收：`tools/local-extract/extract.py` 的 `jobs.guideWebp` / `GUIDE_WEBP_MODE`、`test/local-extract.test.js`、`ui/guide.js` 的单页预载、文档（`docs/ASSETS.md`、`docs/design/client.md`）。
- 已生成：`tools/local-extract/extract.py --webp`（需要 Pillow；本机在 `.venv-extract` 里装了 Pillow 12.3.0）产出 31 个 WebP 副本 —— 19 页教程图 **24.5 MB → 4.0 MB**，另有 12 张棋盘贴图。质量核对：19 页与 PNG 的平均像素差 MAE 1.29–1.74 / 255、p99 ≤ 10 / 255，肉眼无差。
- 已更新：`data/local-assets.json`（guide 各页指向 `.webp` 并带 `webp: "lossy"`），`data/asset-hashes.json` 已重建（该文件在 `.gitignore` 里，不入库）。
- **未完成（待执行）**：R2 发布与 CDN 验证。`public/assets/local/**` 不入库，CDN 装机要靠 bucket 里有这些文件；本机没有 Wrangler 凭据，且发布是外部写操作，需要确认后执行：

  ```bash
  node tools/r2-sync.mjs --bucket <bucket> --push     # 写 .assets-manifest.json 并上传 31 个 WebP
  ```

  顺序要求：**先发布，再让这版到达玩家**。在发布前，CDN 装机的教程页会请求 bucket 里还没有的 `.webp`（清单里没有它的哈希 → 退化成裸地址 → 404）；本机装机不受影响。
- 待发布完成后提交 `data/local-assets.json`（现在它是未提交状态，等 CDN 验证通过再提交，符合 §10 的步骤 5）。
