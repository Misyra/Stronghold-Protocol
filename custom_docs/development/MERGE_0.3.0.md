# 上游 v0.3.0 合并记录

对象：tag `v0.3.0`（`c24e17ee`，与 `origin/master` 同点，2026-10-16）；基线 `488db49f`（上游 0.2.6 tip）。本仓库合并分支 `merge/0.3.0`，起点 `f7518df3`（`port/pr-643-ui` 的 tip）。上游 0.2.6 之后 390 个提交、807 个文件（`+111,918` / `−9,489`）。

**口径说明**：干合（`git merge-tree --write-tree merge/0.3.0 v0.3.0`）得 **66 个冲突文件**：60 处内容冲突、3 处 modify/delete、3 处 add/add。文档先按主线布局搬过一遍（`d617ad05`：11 个文件从 `docs/development|guides|operations/` 升到 `docs/` 根），把冲突从 71 降到 66。自动合并成功不等于语义正确：本次还抓到 3 处「两边都合进去了同一段」的静默重复（§4）。

## 0. 本次边界

| 内容 | 决定 |
|---|---|
| 素材内容哈希、`server/http/assetIndex.js`／`assetViews.js`、`/assets/~<hash>/` 路由 | **不接**（沿用 0.2.6 的口径）。发布层仍只有 CDN 的 `?v=<文件哈希>` 与本机 `/_v/<tag>/`（`server/assetVersion.js`） |
| 素材包（`--assets`）、标题画面的「下载完整素材」与「导入素材包」、`public/sw.js` | **推迟**（§1）：那套只认带内容哈希的地址，本分支不产生这种地址，Service Worker 永不命中、导入的文件静默取不到 |
| 插件系统（`plugins/`、`server/plugins`、`server/studio`、`public/studio`、`shared/plugins`、`schemas/`、`tools/plugin.mjs`、`docs/PLUGIN-*.md`、`test/plugins/**`） | **收**（含 `SP_PLUGINS`／`SP_PLUGIN_SCRIPTS`、CSP 默认开启、服主策略文件、Trusted script plugins） |
| 官方特效与配音（`public/js/render/**`、`public/js/audio.js`、素材抓取工具） | **收** |
| 规则与 bot（`server/match/bot.js`、`server/match/Match.js`、`match/{prep,platform,messaging}.js`、`server/sim/rng.js`） | **收**；rng 保我方 `setState` 并收上游 `clone` |
| 界面与操作（`public/js/screens/**`、`public/css/**`、快捷键） | **收**上游；本分支的 CSS 契约（`--t` / `--utility-text` 分工）与移动端紧凑层保留 |
| 干员皮肤（`public/js/ui/skins.js`、`ui/skinPicker.js`、`server/skinInstall.js`） | **保留本分支**版本（上游没有这两个前端文件） |
| 作战统计面板（`public/js/battle/metrics.js`、`ui/combatMetrics.js`） | **保留本分支**实现：与上游同一 xinhai 血统，两个前端文件与 metrics 取我方，`test/match/combat-metrics.test.js` 取上游那份 |
| 文档 | 位置跟随主线；本分支自己的文档（`custom_docs/operations/DEPLOY.md`、`custom_docs/SKINS.md`、`custom_docs/development/**` 等）一个都没删 |

## 1. 推迟清单（要恢复就成对恢复）

上游 0.3.0 的「预载完整素材 + 导入素材包 + 打包素材包」是一个整簇。**为什么整簇推迟**：`public/sw.js` 只拦截 `/^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//`（`IMPORTED_ASSET_PATH`），而本分支的地址是 `/_v/<tag>/` 与 CDN 的 `?v=<hash>` —— 服务端永远不产生 `~hash` 段，装了 SW 也一个文件都取不到。而且本分支已经有等价能力：`public/js/resources/**` 配 `public/resource-sw.js`（在 `public/js/resources/index.js` 注册）与 `/data/resource-manifest.json`，再注册一个同 scope 的 `sw.js` 只会打架。

推迟的文件（都只在 v0.3.0 里存在，本分支已 `git rm`）：

- `public/sw.js`、`public/js/assetPack.js`、`public/js/assetCache.js`
- `public/js/assetDownload.js`、`public/js/ui/assetDownload.js`、`public/js/ui/assetImport.js`
- `test/ui/asset-import.test.js`、`test/ui/asset-import.browser.test.js`、`test/ui/asset-download.test.js`、`test/ui/asset-download.browser.test.js`

接线点（删掉的地方）：`public/js/main.js` 的 `registerImportedAssetWorker()`、`public/js/screens/title.js` 的两粒按钮与 `title-assets` 容器、`public/css/screens/title.css` 的 `.title-assets` / `.asset-*`、`public/js/pwa.js` 的注释、`tools/package.mjs` 的 `--assets` 与 `mainAssets()`、`test/package.test.js` 的 6 个打包用例。

文档：`docs/ASSETS.md` 的 predownload 与 import 两节、`docs/DEPLOY.md` §2.5、`docs/design/client.md` §13。恢复时这些要成对写回，并把 `assetPack.js`／`sw.js` 的路径匹配从 `~hash` 改成 `/_v/`（那是独立的一项移植，不是三行适配）。

插件层**不依赖**索引层（已核）：`server/plugins/{registry,visualSet,roomSets,forgeImport}.js` 与 `server/studio/watch.js` 对 `assetIndex`／`assetViews`／`createAssetIndex`／`createManifestViews` 的引用次数为 0；`server/plugins/visualSet.js` 自带 `hash16`。引用索引层的只有 HTTP 层、上面这批素材包客户端、`tools/package.mjs` 与它们的测试。

## 2. 冲突处理（摘要）

| 文件 | 处置 |
|---|---|
| `server/lobby.js`（18 块，最大） | 并集：保留本分支 `checkpoint` 恢复链（`subscribeCheckpoint`／`checkpoint`／`seatEntries`，来自 `server/matchRestore.js`）与 `chatLog`／`workerPool`／`rehearsalPressure`／`skins`，收上游 `content`／`plugins`／`hosts`／`dataFor`／`seatSettings`／`trustedRuntime roomClosed`。b7 是分岔点：活房间走上游的 `dataFor` + `seatSettings` 过滤，checkpoint 恢复走本分支带 `skins` 的路径 |
| `server/index.js`（9 块） | 以上游的启动序列为底（`computeVanillaContent`／`createPluginRegistry`／`visual`／`policy`／`contents`／`roomSets`／`hosts`／`studio`／`trustedRuntime`），保留本分支的 `release()`／`cleanupRuntime`／worker pool／`roomAdmin`／`portalRoom`；`createSessionStack` 的两侧调用点合成**一条**；**删掉** `assetIndex`／`views` 接线 |
| `server/http/static.js` | 上游的插件路由（`/plugins/index.json`、`/cs/`、`/vs/`、`/p/`、`/packs/`）与本分支的发布层（`/_v/`、`/assets-manifest.json`、`/data/resource-manifest.json`、`/build/`）取并集；**不接** `assetIndex`／`views`／`splitHashedPath`／`hashedFileOpts`。插件路由本来就在自动合并区，冲突只在头部注释、import、签名与尾部 |
| `server/http/routes.js` | 保本分支 health 面（`/healthz?build=1|traffic=1`、`/metrics`、`/api/ping`、`/api/rooms/<code>/status`、`/api/announcement`、`/api/portal-room`），收上游的 `/x/`（trustedRuntime）与 `/studio` 分发、`Content-Security-Policy` 头、health 里的 `content`／`trusted` 字段 |
| `public/i18n/*.json`（4 个） | 并集：上游键序在前，本分支独有键追加；同名不同值 33 处一律取上游；`_meta` 逐字节相同 |
| `data/assets.json` | 取本分支（288,335 文件 / 41.3 GB；上游那份是 16,705 / 758 MB 的旧子集）。**日后要重新生成** |
| `docs/DEPLOY.md`（modify/delete） | 收上游那份（本分支原本删除它）。本分支自己的部署文档仍在 `custom_docs/operations/DEPLOY.md`，一字未动 |
| `server/http/assetViews.js`、`test/asset-index.test.js`（modify/delete） | 继续删除（索引层不接） |
| `public/js/battle/metrics.js`、`public/js/ui/combatMetrics.js`（add/add） | 取本分支（同一 xinhai 血统） |
| `package-lock.json` | 取本分支锁（带 `@zip.js/zip.js`、`maxmind`、平台二进制），再 `npm install` 补上游新增的 `ses` / `@endo/*`；`acorn` 两侧都有 |

## 3. 本分支侧的适配（别改回去）

- `vite.config.js`：新增 `simPaths()` 插件（`/sim/` 映射到 `server/`），并在 `worker.plugins` 里也挂一份 —— `public/js/battle/simHost.js` 用 `new Worker(new URL("./simWorker.js", import.meta.url))`，Vite 会为 worker 起**独立的一趟 Rollup**，不继承 `browserContracts`；缺了它 `vite build` 报 `[vite:worker-import-meta-url] Rollup failed to resolve import "/sim/detmath.js"`。
- `test/vite.test.js`：上游把 `loadBrowserSim` 搬进 `public/js/battle/simLoader.js`，它只用运行期变量导入，没有任何东西**静态**抵达 `server/sim`，客户端 bundle 里不再有 `simulation` 分块，上游那条 parity 测试不再成立。改成 `the simulation the browser runs is served unbundled`：断言 `/sim/{spec,simdata,content/support/index}.js` 按仓库原文服务、`/sim/nodeData.js` 404、只有 `nodeData.js` 引 node 内置、11 个 `SIM_DATA_FILES` 与实际数据相等、13 个 golden 场景在「HTTP 取的 `DataSource`」与「`getData()` 的 `DataSource`」下结果一致。**不要把模拟器打回 bundle**：`simLoader` 靠「同一 URL = 同一模块实例」在运行期 import `/sim/content/extensions.js` 与 `/shared/plugins/officialBounds.js`，打进 bundle 会让插件扩展与 official bounds 各持两份实例。
- `server/http/files.js`：`serveFile` 是本分支的 9 参签名，上游那行 `if (opts.headers)` 改成第 10 个可选参数 `extraHeaders`（不能叫 `headers`，函数体里已有同名 `const`），插件 UI 帧的 `Content-Security-Policy` 仍生效；**不收**上游签名里的 `query`（「任意 `?v=` 即 immutable」那条与本分支相反），`server/http/static.js` 与 `server/studio/index.js` 的调用点按 9 参调用。
- `server/http/files.js` 的 `CompressCache.get(absPath, stat, body = null, variant = "", encoding = "gzip")` 是本分支的形状（键里已含 `ino`／`ctimeMs`）。上游测试按三参 `cache.get(file, stat, "gzip")` 调会把 `"gzip"` 喂进 `body`；`test/plugins/visualSet.test.js` 的两处已改成 `cache.get(file, stat, null, "", "gzip")`。
- `server/lobby.js` 的 `seatEntries` 来自 `server/matchRestore.js`（不是 lobby 内部函数）；`dataFor`／`seatSettings` 是 lobby 的方法（活房间用）。
- `test/client-static.test.js`：合并后同时带着两侧互斥的断言，删掉过时那三条 —— 内联 `<script nomodule>`、`devices.css` 必须最后（本分支最后一张是 `utility-mobile.css`）、内联 `onerror="window.__spBootFail"`（上游把这块挪进 `public/js/boot.js`，靠 `id="sp-main"` 判来源，并断言 CSP 下没有内联事件处理器）。
- `test/plugins/visualSet.test.js`：去掉 `createAssetIndex`／`createManifestViews` 接线；overlay 那条不再断言服务出的 manifest 带 `~hash` 段（本分支不发），改断言「没被插件改的条目保持页面加载到的那个 URL」。
- `tools/package.mjs`：`PLAYER_DOCS` 是本分支与上游的并集（多了 `docs/DEPLOY.md` 与 `docs/PLUGIN-*.md` 等上游玩家文档，同时保留 `custom_docs/SKINS.md` 与 `custom_docs/operations/{DEPLOY,HOME_SERVER,ANNOUNCEMENTS,CDN,PERSISTENCE,MONITORING}.md`）；`RUNTIME_RESEARCH` 多 `docs/research/08-skins.json`；**删掉** `--assets`／`mainAssets()`／`rewriteManifest`／`planFromManifests`。`test/package.test.js` 的发货集合计数随之从 36 改成 38（+`docs/DEPLOY.md`、+`scripts/start-windows-sandbox.bat`）。
- 文档分区编号：0.3.0 拿走了 DESIGN 的 §32（插件系统，`docs/history/0.3.0.md`）与 §33（特效格式，`docs/design/vfx-format.md`），而本分支那份未入库草稿 `docs/design/portal-agent-wss.md` 原本占 §32–§51。合并时把它整块 **+2 顺延为 §34–§53**（`test/helpers/designDocs.js` 对同一节号出现两次直接抛 `§N appears twice`）。连草稿一起改的引用共 116 处 / 21 个文件（`portal-agent-wss.md` 的 h1 与全部 `## N.` / `### N.x` 标题，加上 `custom_docs/operations/PORTAL_ROOMS.md`、`public/js/screens/room.js`、`public/js/ui/roomShare.js`、`server/{announcement,http/config,http/portalRoom,http/routes,index,lobby,roomAdmin,roomConfig}.js`、`test/{bot-policy,foreign-sessions,portal-room*,room-config-v2,ui/room-share}.test.js`、`AGENTS.md`）。**别挪到 §52–§71**：`test/docs-paths.test.js:101` 要求 §0..max 连续无洞（`for (let n = 0; n <= max; n++) assert.ok(where.has(n))`），留空洞必红。`docs/DESIGN.md` 的索引行也重写成测试认得的 `| §N, §M | [file](file) |` 形状——旧行以中文「草稿（编号与 §32 / §33 撞号…」开头，那条正则根本解析不到它。

- **本分支侧偏离（验证阶段补记）**：
  1. shared/plugins/scriptLoad.js 第 29 行上游写的是 `(...args) => globalThis.fetch(...args)` 形式，在本分支会报 TS2556（spread 参数需要元组或 rest 形参）——因为本分支 jsconfig.json 的 lib 是 [ES2022, DOM]（上游只有 [ES2022]），有 DOM 才有 fetch 的重载签名。改成两参直呼 `(url, init) => globalThis.fetch(url, init)`（调用处就是 fetchFn(url, { cache: … })），语义不变，typecheck 干净。
  2. public/js/battle/simLoader.js：0.3.0 把 loadBrowserSim 从 runner.js 搬进这个新文件，搬的是上游版本（写死 `fetch(`${dataBase}${n}.json`, { cache: 关闭 })`），本分支的 /_v/<tag>/ 版本化取数在这一步被静默丢掉。已恢复成 resourceUrl + resourceCache 的取数（`const url = resourceUrl(...)` / `await fetchFn(url, { cache: resourceCache(url) })` / `return res && res.ok ? await res.json() : null`），runner.js 里随之空转的那两行 import 也删掉了；runner.js 的 unitStatsEntry 同理（本分支 battle/simHost.js 的两个 host 都自带 unitStats(id)）。**这类静默丢失只能靠 no-unused-vars 反查**：对改动的 .js 收集未用标识符，再看它在 git show HEAD:<file> 里出现过几次，≥2 就是人工复核对象。
- public/js/battle/runner.js 的 combatMetrics：两侧都改了同一处（HEAD 把 combatMetrics: null 内联在入口对象字面量那一行，上游拆成独立带注释的行；返回值里 HEAD 版带 combatCache/remember/combatVersion 与本分支的版本数组，上游版用 localEntries + combineCombat）。合成后两处都是重复键（no-dupe-keys），按 §0「统计面板保本分支」**保留本分支那份**，删掉上游那 21 行与内联的那一个键。
- test/asset-paths.test.js：合并保留了本分支的 `const V = 0123456789abcdef`，却收下上游用 H 的那两行断言，于是 no-undef；统一改成 V（/vs/<V>/ 的 10 处引用）。
- acorn AST 重复键全扫（702 个改动 .js）只报出 5 处，逐个核对全是两侧本来就有的 get/set 对（render/units.js 的 visFacing、match/finalAssault.js 的 hp、sim/skills.js 的 spCostMul、sim/spec.js 的 hp、sim/units.js 的 facing），**不是合并损伤**——扫描器把 get/set 当同键了。

- **测试侧适配（验证阶段补记，别改回去）**：
  1. `test/plugins/{contentBattle,dsl-data,script-integration}.test.js` 的 `fs.cpSync` 过滤器：上游写的是 `endsWith(斜杠 nodeData.js)`，而 Windows 的 `src` 是反斜杠路径、永不命中，于是 runtime 里带着 `nodeData.js`；`server/sim/simdata.js` 顶层 `await import(nodeData.js)`、nodeData 又动态 `import(../data.js)`（runtime 里那个是被 shim 顶掉的替身），构成 ESM 环 + 顶层 await **死锁**，用例永不 settle（25 s 超时取消）。三个文件都改成 `filter: (src) => path.basename(src) !== 字符串 nodeData.js`（都已 import `node:path`）。Linux/macOS 上过滤器命中，所以上游 CI 看不到。
  2. `test/ui/plugins-content.test.js` 的 `tick` 从 `setTimeout(r, 0)` 改成 `setImmediate(r)`：Node 把 0 ms 钳到 1 ms，rig 那 50 次 `setImmediate` 抽水窗口（微秒级）先跑完，随后 3600 次不含 await 的假时钟循环又把它饿死。把 `runner.js` 换回 v0.3.0 原版同样 flaky（6 次跑 3 次红），**不是合并损伤**；`test/ui/{buildGuard,cosmetics-lazy,plugins-client}.test.js` 有同样写法（当前绿，潜在同类脆弱点）。
  3. `test/ui/image-policy.test.js` 抓到上游新代码里两处 `new Image()`（`public/js/render/vfx/library.js`、`public/js/screens/stats.js`），都改走 `public/js/image.js` 的 `loadImageElement`。注意那条规则的正则会命中注释里写出的 `new Image()` 字样——注释得换个说法。
  4. `test/ui/ammo-count.test.js` 的 settings 字面量断言把两侧合成一条（本分支多 `fpsLimit: 0`）；`test/ui/playtest6_summons.test.js` 两处 `path.join(ROOT, docs, guides|development, …)` 改成 `docs/PLAYING.md` / `docs/SIM.md`。**路径扫描要连 `path.join` 分段形态一起扫**，字符串形态那轮漏了它。

- **Windows 环境限制（测试红但不是代码问题，别去「修」）**：`test/plugins/forgeImport.test.js` 26 条、`test/plugins/install.test.js:192`、`test/plugins/script-integration.test.js:80` 与 `test/studio/**` 13 条都要写目录符号链接，Windows 需 Developer Mode（或 junction），否则 `EPERM: operation not permitted, symlink …`；`test/studio/trial.test.js:97` 断言 `child.killed === true` 在 Windows 为 false —— `server/studio/trial.js` 先 `spawnSync(taskkill, /PID … /T /F)` 再 `child.kill(SIGKILL)`，句柄此时已失效（进程确实死了、`b.active() === 0` 成立；上游 Linux 走 `process.kill(-pid, SIGKILL)` 抢在退出前调 `kill()` 所以标志为真）。先 `kill()` 再 `taskkill` 会有孤儿风险，**不要动代码也不要改测试**。

## 4. 干净合并造成的静默重复（要靠全量 `node --check` 抓）

- `server/data.js` 的 `setData`：两侧各有一份，删本分支的、留上游带校验的那份。
- `public/js/battle/runner.js` 的 `metrics` import、`public/js/ui/settings.js` 的 `hooks` import：`git` 不报冲突，重复声明到运行那行才炸。
- 合并前就有的本分支缺陷，顺手修掉：`public/js/screens/game.js` 重复的 `metricsOpen`、`public/js/screens/title.js` 丢了 `import { installedCount } from "../content.js"`。
- `test/docs-consistency.test.js` 的「干员战斗语音 (DESIGN §21.30)」用例：两侧各有一条语音语言断言 —— 本分支的 `「语音语言」选 **中文 / 日本語**`（2 语言）与上游 0.3.0 的 4 语言版（EN / KR 配音是这版加的），合并后两条落进同一个用例，2 语言那条必红（`docs/PLAYING.md` 的合并结果只讲 4 语言）。删掉 2 语言那条，留住 4 语言那条。

## 5. 验收

```bash
node --check <每个改动的 .js>            # ESM 语法（package.json type=module）
node node_modules/eslint/bin/eslint.js <改动的 .js>
npm run lint && npm run typecheck && node tools/check-imports.mjs
npm run golden                            # 288 场景
node --test <目标测试集>
```

重点：`test/package.test.js`（发货集合）、`test/plugins/**`（插件层）、`test/match/**`（规则与 bot）、`test/vite.test.js`（按 `--test-name-pattern` 拆着跑，整份超预算）、`test/client-static.test.js`、`test/ui/**`。HTTP 层改过之后要真的起一次 handler 取个页面（本次就是这样抓到 `static.js` 丢了最后一行 `serveFile` 调用 —— 所有请求都拿不到响应头）。

## 7. 合并后验证阶段改回来的八处（7.1–7.7 是混血/静默丢失，语法与单测都查不出来；7.8 是 0.3.0 新功能与本分支 release 层的集成 bug）

### 7.1 `server/match/bot.js` 的 `Layout` 取上游（代价：本分支的布阵优化被顶掉）
- 症状：`npm run golden` 只有 matches 一族红（21 个场景全差），其余五族全绿。样例 `solo-FUNNY-1`：期望 `victory` / `roundsPassed 9` / `teamLp 27`，实测 `false` / `3` / `eliminated`。
- 根因：合并把**两侧对同一个函数的重写混在了一起**。本分支在 `8f0e1a8c`（优化 bot 与模拟、CDN 版本化）里把 `Layout` 改成「构造器预置 `cover`／`healCover`／`blockAt`，`value(candidate)` 收候选单位、`add(u)` 提交，`layoutUnitCaches` 三级缓存 + `u.signature`」；上游 0.3.0 的 `Layout` 是无参 `value()`（每次从 `this.units` 重算），候选单位由调用方 `layout.units.push(u)` / `pop()` 包夹，提交用 `layout.units.push(unitOf(...))`。合成结果是**上游的调用点 + 本分支的类内部** → `candidate` 为 `undefined`，`value()` 里读 `.key` 抛 TypeError（`server/match/bot.js` 的 `planLayoutSteps` ← `arrangeSteps`），每个 bot 都不布阵（board size 0、lp 0）。
- 为什么只有 golden 抓到：golden 的静默 log 把引擎异常吞成 digest 的 `.errors.engine = 4`，board hash 是空串的 FNV（`811c9dc5`）—— **看到某族全红而别的族全绿，先查 `.errors.*` 与 board hash**。混血重写既过 `node --check` 也过单个单测，只有整场对局会暴露。
- 处置：把 `class Layout` 到 `function distinctPlans` 之前那 239 行整块换成 v0.3.0 的 217 行。判据是 YG 的口径「规则 + bot 基本上都可以合并」「有一样的实现优先用上游」。**代价**：`8f0e1a8c` 的布阵性能优化随上游重写一起作废，要恢复得在上游新 planner 上重做（两边改的是同一段，无法机械共存）。`test/` 与 `tools/` 里没有任何引用 `layout.add(` / `layoutUnitCaches` / `new Layout(`，所以去掉它不破测试。修后 `npm run golden` 288 场景全 match（matches 21/21）。

### 7.2 作战统计面板改成上游的 opt-in 开关（本分支的测试 rig 必须跟着钉开）
- 本分支 HEAD 无条件挂表（`e.combatMetrics = trackCombat(battle)`）；0.3.0 改成设置开关驱动、默认关：`let metricsWanted = false` + `metricsEnabled()`（`deps.combatMetrics` 布尔优先，测试用）+ `if (metricsEnabled() && !e.host.remote) e.combatMetrics = trackCombat(battle)` + `setCombatMetrics()`。
- 合并收下了上游的 gating 与 `game.js` / `settings.js` / `gameLogic/settings.js` 的开关接线（设置里一项「作战统计」、战场 `.gm__metrics` 按钮、`diag.js` 打 settings 行），但 `test/match/runner.test.js` 的 rig 还是本分支的简版 —— 表没挂，`rows` / `damage` 全空，3 条统计测试红。
- 处置：把 rig 换成上游那版（`function rig({ hidden = false, combatMetrics = true, pinMetrics = true, createHost = null } = {})` + `if (pinMetrics) deps.combatMetrics = combatMetrics`），并把被合并整条丢掉的上游 3 条测试补回（默认关且关掉后摘钩子、Worker host 永不挂表、设置默认关且按钮只在开启时出现），另补回散在四处的上游断言（`authoritative battle` 的记账块、silent catch-up / hidden-tab 的 damage 断言、`solo pause` 的冻结断言）。要测挂表就用 `deps.combatMetrics` 布尔钉，**不要改生产默认值**。
- 教训：**以「取我方」解决的合并会静默漏掉上游新增的测试**。要专门拿 `test/` 对上游 tag 做 `git diff --numstat` 复核（本次靠它发现 `test/match/runner.test.js` 少了 3 条），合并前的 churn 表看不出来。

### 7.3 新增字段的持久化表态（`test/match/snapshot.test.js` 强制逐个表态）
- 上游 0.3.0 的 `Match` 新字段（`cs` / `vs` / `requireCs` / `hostId`）与本分支 rehearsal 委派（`botRehearsalDelegate` / `botRehearsalDelegateMs` / `_rehearsalTasks` / `_rehearsalSeq` / `rehearsalStats`）共 9 个 → 全部进 `server/match/snapshot.js` 的 `TRANSIENT_MATCH_FIELDS`。依据：`server/lobby.js` 的 `startMatchWith` 每次都从 room 现取 `hostId` / `cs` / `vs` / `requireCs`，两条恢复路径（`server/matchRestore.js` 的 `restoreLobbyMatch` / `adoptRestoredMatch`）都走同一个 `startMatchWith`，恢复时会被重建。
- `creditedKills`（上游 PR #509 的击杀计入，`PlayerState` 字段，`settle.js`／`bossRounds.js` 累加）是**累计计数、恢复时不会重算**，因此进 `PLAYER_FIELDS`（不是 transient）。

### 7.4 `server/match/bot.js` 的排练池契约（上游 delegate + 本分支 workerPayload 并集）
- 症状：`test/room-protection.test.js:233` 与 `test/rehearsal-pressure.test.js:73` 拿到的 `job.workerPayload === undefined`（`TypeError: Cannot read properties of undefined (reading options)`）。
- 根因：合并把上游 0.3.0 的 `createRehearsalSteps`（只在 `onPool` 时 push `options`，且 `options.length < 2` 就落回本地）与本分支「只要 `m.workerPool` 就返回带 `workerPayload` 的 relay job」混在一起 —— 池报忙（`load.queued > 0 || load.busy >= load.size`）时上游一个候选都不 push，relay job 就没了。
- 处置：保留上游的 `delegate` / `pending` / `onSettled` 与 `rehearsalCap(m.wave.timeLimit)`，恢复本分支的池契约：`const pool = !!m.workerPool && !delegate`；`const busy = pool && !!(load && (load.queued > 0 || load.busy >= load.size))`；`const cands = distinct.slice(0, busy ? Math.min(1, budget) : budget)`；循环里 `if (pool) options.push(structuredClone({ ...opts, content: m.battleContent }))`；末尾 `if (!pool || !options.length) return createRehearsalJob(m, ps, chosen, cands, inputs, battles.length ? battles : null)`，否则返回 relay job（`workerPayload: { options, playerId: ps.playerId, timeLimit: wave.timeLimit }`，`run` 里懒建 `createRehearsalJob`）。消费方是 `server/match/match/prep.js:93`（有 `workerPayload` 才 `_submitWorker(rehearsal, …)`，否则本地切片），池拒绝时 `workerStats.rejected` / `audit = worker.rejected` 那条也依赖它。「池忙 → 只排练 1 个候选；被拒 → 落回基础布局、绝不把可选 CPU 甩到主线程」是本分支的编码口径。
- 验证：`node --test test/rehearsal-pressure.test.js test/workers.test.js test/room-protection.test.js test/match/bot.test.js` 71/71；`node tools/golden.mjs --family matches` 21/21。

### 7.5 `public/js/render/units.js` 的 `_acquireSpine` catch：模型构建失败也要走有界重试
- 症状：`test/render/model-recovery.test.js`（**本分支的测试**，v0.3.0 里没这个文件，来自 `8e56d74b`）5/5 红 —— 构建失败后 `_retryAt === 0`（不排下一次重试）、本地模型构建失败不落 web fallback。
- 根因：本分支的 catch 调 `failed()`（清 `_spineBusy` → `_releaseEntry` → `entry.fallback` 优先 → `_spineTries < SPINE_RETRY_MS.length` 才 `_retryAt = nowMs() + SPINE_RETRY_MS[this._spineTries++]`），上游 0.3.0 的 catch 只 `this._releaseEntry(entry)` + `try { a.failed?.(entry.skel) } catch {}` 就返回（重试只留给下载失败那条 `.then` 的第二参）。合并取了上游的 catch。
- 处置：catch 里两样都留 —— 保留上游的 `a.failed?.(entry.skel)` 钩子，再补本分支的 `if (this.destroyed || req !== this._spineReq) return;` → `if (entry.fallback) { this._acquireSpine(entry.fallback, id, retry); return; }` → `if (this._spineTries < SPINE_RETRY_MS.length) this._retryAt = nowMs() + SPINE_RETRY_MS[this._spineTries++];`（等于把 HEAD 的 `failed()` 内联，别再写一次 `_releaseEntry`）。**不要动** tick 守卫 `if (this._retryAt && nowMs() >= this._retryAt) { this._retryAt = 0; if (!this._spineBusy) this._loadSpine(true); }` —— 没有上游的 `!this.actor` 正是「旧模型还在显示时也能重试」那条需求。
- 验证：`node --test test/render/model-recovery.test.js` 5/5；render 三组 284/305/341 项只剩 §6 里那一条素材缺口。

### 7.6 宿主与插件边界对「最小夹具」的两处强读
- `server/http/routes.js`：上游新测试用只带 `log` / `health: {}` / `csp` 的 handler 打 `/healthz`，本分支的 foreign-connection 守卫读 `health.network.foreignConnectionDenied(...)` 会抛 TypeError → 500（渲染成本分支的中文错误页，症状是前端 `JSON.parse` 报 `Unexpected token <`）。改成 `health.network?.foreignConnectionDenied?.(clientAddress(req, trustProxy))`。同一处 `publicHealthReport` 的 `roomProtection` / `botPopulation` 改成 `lobby.roomActions?.stats() || null` / `lobby.botPopulation?.stats() || null`，`createHealthBody` 的失效判定改成 `health.lobby.rooms?.size ?? 0`（上游没有 `createHealthBody`，那是本分支的缓存）。
- `shared/plugins/ui.js` 的 `isIntentType`：上游正则只有 `hello|ping|room.*|g.*|b.*`，本分支 56 个 C2S 键里的 `state.resync` / `matchmaking.join` / `matchmaking.cancel` / `room.skin.install`（嵌套两点）都不命中，`test/plugins/ui.test.js:126` 红。改成 `^(?:hello|ping|(?:room|state|matchmaking|g|b)\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)`；UI_PLUGIN_MESSAGES 与 UI_HOST_MESSAGES 的键一个都不命中（已核过）。

### 7.7 新拆出的 `public/js/spineManifest.js` 必须先 `git add`
- `test/package.test.js:83` 报 `public/js/assets.js:58 imports ./spineManifest.js (not shipped)`：`tools/package.mjs` 的 `trackedFiles` 走 `git ls-files -z`，`importProblems` 只认发货集合里**已跟踪**的文件，所以新模块还挂在未跟踪（`??`）时会被判 not shipped。
- 这个文件是把 `spineEntry` / `localAssetUrl` / `validSpine` / `hasBackSpine` / `baseCharId` 等纯函数从 `public/js/assets.js` 拆出来的：`test/ui/plugins-client.test.js:419` 要求 `public/js/assets.js` **不在** `public/js/main.js` 的静态 import 图里，而本分支的 `public/js/render/spinePreview.js` 正好把 `assets.js` 拉了进去（main → screens/loadout → spinePreview）。拆出纯层后 `spinePreview.js` 静态只 import `spineManifest.js`，`assets` 改成按需 `await import(../assets.js)`（`clipsOf` 仍同步用 `spineEntry`，不能整份改异步）。**副作用：新文件必须先 `git add` 再跑 `test/package.test.js`。**

### 7.8 CSP 只放行磁盘版 import map，而发出去的是 `/_v/` 改写版（0.3.0 新加的 CSP × 本分支 release 层）
- 症状：`--source-client` 起服务器，客户端黑屏报「游戏脚本加载失败」（`public/js/boot.js` 写的 `#boot-err`），控制台两条 CSP 违规（被拒的两条内联脚本建议哈希分别是改写后的 import map 与注入的版本脚本），`globalThis.__spRuntimeVersion`／`__spAssetVersion` 全是 `undefined`，`/_v/shared/*.js` 一批 404。可 `/healthz` 的 tag 是对的，`/_v/<tag>/js/main.js` 直接 fetch 也 200 —— 第一次看会以为素材或版本层坏了。
- 根因：0.3.0 新加 `server/http/csp.js`，`siteCsp(publicDir)` 只做一件事：读磁盘上 6 个 HTML，把 **importmap 正文**算成 sha256 放进 `script-src`。而本分支的 release 层在响应时把 HTML 交给 `assetVersion.transform`：重写 importmap 的值（`/vendor/preact.module.js` → `/_v/<tag>/vendor/preact.module.js`，另追加 `/js/` `/shared/` `/sim/` 这些前缀键）并在 `<head>` 注入内联 `globalThis.__spAssetVersion=…`。于是**浏览器拿到的两份内联脚本都不是被哈希的那份** → importmap 被拒 → `preact`／`htm` 裸说明符解析不了 → 整条模块图挂掉（注入脚本被拒是 `resourceUrl()` 拿不到 tag、那批 `/_v/shared/*.js` 404 的直接来源）。合并前本分支**没有 CSP**（`f7518df3` 里没有 `server/http/csp.js`），所以这是合并新引入的集成缺陷，不是既存红。
- 处置：`siteCsp(publicDir, transformPage = null)` 对**两个变体**都取哈希 —— 磁盘版（上游原规则一字未改）与 `transformPage(html, path.extname(rel))` 版（真正发出去的字节）；新增 `INJECTED_RELEASE` 规则，只认 release 层自己写的那句 `globalThis.__sp…`，仍然是「只哈希 import map + 本服务器自己写的内联脚本」，没有放宽到任意内联脚本。候选文件补了 `build/index.html`（默认模式发的就是它）。`createStaticHandler` 暴露 `handler.transformPage = (text, ext) => release.transform(text, ext)`，`server/index.js` 改成 `siteCsp(publicDir, serveStatic.transformPage)`。
- 验证：`test/plugins/csp.test.js` 加一条回归（`clientBuild` 两种模式各请求一次 `/`，断言响应体里**每个**非 `src` 内联脚本的 sha256 都在响应头的策略里，并断言注入了 release tag）；真起服务器用 puppeteer 走通：0 条 CSP 违规、0 条 console 错误、0 个 ≥400 响应，`__spRuntimeVersion`／`__spAssetVersion` 有值，标题页之后大厅渲染出 3 个入口与 S.W.E.E.P.报告／干员调配；`npm run build` 重生成 `public/build` 后默认（构建）客户端同样 0 违规 0 错误。

## 6. 遗留

- `npm install` 已把 `ses` / `@endo/*` 补进 `node_modules` 与锁文件，`tools/vendor.mjs` 重新 vendor 了 `ses.umd.js` 等；装 `esbuild@0.25.12` 的 postinstall 被 allow-scripts 拦下（未批准），不影响构建测试。
- `data/assets.json` 是 41.3 GB 的老清单，需要按当前素材重新生成（`tools/fetch-assets.mjs` 那一线）。
- **已经补掉的最后一条红（`board3d-extract` 的 round-40 素材，2026-10-16）**：上游给 `public/js/render/board3d/load.js` 的 `PACK_IMAGES` / `PACK_MESHES` 各加了一条 `platform: [mesh/trap_110, TX_trap_1106_achplat]`（`extract.py` 的 mesh 作业从 4 个变 5 个），而本分支跟踪的 `data/local-assets.json`（1658 条）与 `public/assets/local/mesh/**` 还是 v0.1.3 那批。补法：用 HTTP Range 从 v0.3.0 完整包（802 MB，`Stronghold-Protocol-v0.3.0.zip`）只取了 `mesh/trap_110/` 的五个条目（压缩后共 0.36 MiB）+ 上游清单，把上游那份的 `mesh/trap_110` 组**逐字**插进本分支清单（`mesh/s_wind_device` 之后，与上游键序一致），`count` 1658 → 1662；再 `git add -f` 四个**源文件**（`trap_1106_achplat.obj`、`TX_trap_1106_achplat.png`、`materials.json`、`prefab.json`）—— 与本分支已跟踪的 1491 个本地素材一致：只跟踪 PNG/OBJ/JSON，**不跟踪 `extract.py` 派生的 `.webp`**。上游清单里另外 12 个 `scene/*` 组的 `env`（Reflection PNG）条目**没有采纳**：本地没有那些文件，收下只会让清单指向不存在的东西。
- 同一批把 `test/render/board3d-extract.test.js` 的 `hasFiles` 门槛改**诚实**：上游写的是 `existsSync(public/assets/local/map/fx)`（上游仓库不跟踪本地素材，那个目录只在提取过客户端时才存在），而本分支跟踪了 `map/fx` 的源文件，于是这个门槛在**干净克隆里恒为真** → 12 个槽位的 `.webp` 一不存在，整份测试就红（`master` 上同样红，**既存条件，不是合并带来的**）。改成按清单里 `map/autochess/TX_autochessi_D` 的 `.webp` 是否存在来 gate：干净克隆跳过磁盘检查（「每个包槽位都在清单里」那条断言仍无条件跑），有素材的机器照旧全查。同一批里 `test/resources/archive.test.js` 在干净克隆里也红（同属既存条件，本次**未动**）。
- `test/ui/*.e2e.test.js` 与本分支的 hub 界面标记要对齐（`port/pr-643-ui` 那一轮的遗留），仓库惯例是 `SP_E2E=1` opt-in。
