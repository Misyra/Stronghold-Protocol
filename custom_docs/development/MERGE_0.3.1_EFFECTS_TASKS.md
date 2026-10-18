# 0.3.1 特效层 + 匹配：交接任务清单

这份文件是给**执行 agent** 用的施工单，不是设计文档。读完第 1–4 节就可以开工；第 5 节按任务号顺序做，
每个任务自带验收标准和回滚方法。有歧义时**照抄参考树**，不要自己重新设计任何东西。

---

## 1. 环境与四棵树

| 代号 | 路径 | 分支/提交 | 角色 |
|---|---|---|---|
| **OURS** | `E:\website\Stronghold-Protocol` | `master` @ `56b12619` | 施工场地，所有改动落这里 |
| **REF** | `E:\website\_ref-stardust` | `master` @ `fab1b97`（"Merge upstream v0.3.1"） | **抄的来源**：Stardust 分支 |
| **BASE** | 同 OURS 的 git 对象 | `origin/master` = `b3deebda`（上游 v0.3.1） | 三方合并的**共同祖先** |
| **XINHAI** | `E:\website\_up-xinhai` | `e01036a` | 只作参考：worker / Redis / 持久化是我们已经采纳的线，**不在这份清单里** |

远程：`origin` = sganggs/Stronghold-Protocol（上游），`fork` = Misyra/Stronghold-Protocol（我们的发布）。

**取得 BASE 的方式**：不要 checkout，用 `git show b3deebda:<path>` 按需取单个文件。

---

## 2. 三条铁律

1. **照抄，不重写。** 参考树里的实现比我们自己写的版本好，这是决定抄它的原因。合并冲突时以 REF 的行为为准，
   除非冲突点落在第 6 节列出的「已知我们不同」清单里。
2. **不整份覆盖。** 62 个差异文件里有一半带着本分支自己做完的功能（皮肤、商店立绘、自选编队、状态增量）。
   整份覆盖 = 把这些删掉。**一律走三方合并**，逐个文件过。
3. **一批一提交，跑完四道闸再提交。** 提交信息用第 7 节模板。不允许「攒一大坨再提交」。

---

## 3. 命令模板

### 3.1 三方合并一个文件

```bash
mkdir -p .tmp-merge
git show b3deebda:public/js/render/units.js > .tmp-merge/base.js
cp "E:/website/_ref-stardust/public/js/render/units.js" .tmp-merge/theirs.js
git merge-file -p --diff3 public/js/render/units.js .tmp-merge/base.js .tmp-merge/theirs.js > .tmp-merge/out.js
# 看 .tmp-merge/out.js 里的 <<<<<<< ======= >>>>>>> 段，手工定夺后写回；然后删掉 .tmp-merge
```

**注意**：`git merge-file` 的退出码 = 冲突段数，不是错误。

### 3.2 单份照抄（只在任务明确写了「照抄」时用）

```bash
cp "E:/website/_ref-stardust/public/js/render/app/tune.js" public/js/render/app/tune.js
```

### 3.3 跑测试（一次别超过 ~200 个文件，否则会超时）

```bash
# 指定文件
node --import ./test/helpers/test-setup.js --test --test-concurrency=4 <files…>

# 整个目录（用 glob，Node 会自己展开；不要用 shell 重定向 > 文件，Windows 下会拼错参数）
node --import ./test/helpers/test-setup.js --test --test-concurrency=4 --test-reporter=dot "test/sim/**/*.test.js"
```

**python 相关用例需要 HOME**（本机沙箱里 `process.env` 是空的，否则 `extract.py` 会 `Path.home()` 报错）：

```bash
set USERPROFILE=C:\Users\Misyra && set HOME=C:\Users\Misyra && node --import ./test/helpers/test-setup.js --test test/local-extract.test.js
```

### 3.4 四道闸（每批必跑）

```bash
node node_modules/eslint/bin/eslint.js <改过的 .js 文件>     # 必须 0 error（warning 允许，见基线）
node tools/check-imports.mjs                                  # 只能剩 3 条既有豁免（server/sim/nodeData.js）
node tools/i18n.mjs extract                                   # 必须 "0 Chinese literals not wrapped"
# 第四道：该批对应的测试，失败集合必须 ⊆ 第 4 节基线
```

---

## 4. 基线红名单（**不是你的锅，也不许修**）

下面这些在干净树上就是红的。你唯一要证明的是：**你改完之后，红名单没有变长**。

| 用例 | 现象 | 结论 |
|---|---|---|
| `test/content/kits_alt_t3.test.js:276` 等 5 项（琳琅诗怀雅 S3 千金一掷） | 推击/金币断言失败 | 已确认既有（clean tree 复现） |
| `test/build-size.test.js:146` | 需要 `npm run build` 的产物 | 已确认既有 |
| `test/plugins/records.test.js:75`、`errors.test.js:40`、`tool.test.js:110` | schema / `PLUGIN_*` 错误码 / 模板素材漂移 | 疑似既有，未逐条复现；与本次改动无交集 |
| `test/ops/syn-ban-list.test.js:12` | 封禁名单漂移 | 疑似既有（`node tools/net-ban.mjs` 可重生成） |
| `test/studio/studio.test.js`（8 项） | `EPERM: symlink` | Windows 环境限制 |
| `test/local-extract*.test.js`、`test/render/board3d-{extract,scene}.test.js` | `Path.home()` 失败 | 环境缺 HOME；设好 HOME 后 `local-extract` 10/10 全过 |
| `test/render/board3d.test.js:404`、`board3d-extract.test.js:190` | 缺本地客户端提取出来的网格 | 素材环境 |

**判定方法**：先跑一遍拿到失败文件:行号集合（基线），改完再跑，两个集合做差。出现新条目就回滚这一批。

---

## 5. 任务清单

> 任务号 = 提交顺序。每个任务都写了「参考」「输入清单」「步骤」「验收」「回滚」。

### A0 — 零冲突照抄（7 个文件）

- **目标**：把「REF 改了、我们没改」的 7 个文件原样拿过来。它们零冲突，用来验证工具链没污染。
- **参考**：REF 同名文件。
- **清单**（全部 `cp` 覆盖，不要合并）：
  ```
  public/js/render/app/tune.js
  public/js/render/drag.js
  public/js/render/interp.js
  public/js/render/vfx/funnelfx.js
  server/sim/ai.js
  server/sim/battle/events.js
  server/sim/buffs.js
  ```
- **步骤**：拷 7 个 → 跑 eslint → 跑 `test/sim/**` → 跑 `test/render/**`。
- **验收**：`test/sim` 失败集合 = 基线（那 5 项琳琅诗怀雅）；`test/render` 失败集合 = 基线（python + 素材 4 项）；
  `test/match` 与改动前一致。
- **回滚**：`git checkout -- <7 个文件>`。

### A1 — vfx 渲染层三方合并

- **目标**：把 REF 的特效渲染（粒子、技能特效、几何挂点、挂点/线缆）引进来，同时保住我们的皮肤 vfx 链路。
- **参考**：REF 同名文件；BASE 作共同祖先。
- **清单（需要合并）**：
  ```
  public/js/render/vfx/geom.js
  public/js/render/vfx/wiring.js
  ```
- **清单（先 diff 再决定，多数应该保留我们的）**：
  ```
  public/js/render/vfx/available.js   effect.js   library.js   pluginFormat.js
  public/js/render/vfx/psys.js        skillfx.js  skills.js    yuwall.js
  public/js/render/impostor.js  manifold.js  skillAttack.js  tiles.js
  ```
  处理方式：逐份 `diff` OURS vs REF。
  - REF 有实质新逻辑（新函数、新分支、修 bug 的注释）→ 三方合并进来。
  - 差异只是注释/排版/我们自己的本地改动 → **保持 OURS 不动**，在提交信息里记一笔。
- **重点**：`vfx/wiring.js` 的 `skinOf(u)` 是我们把「皮肤 → 官方特效」接起来的唯一入口，
  合并后必须仍然存在，且读 `u.skin`（我们线上字段名，见第 6 节）。
- **验收**：`test/render/vfx-*.test.js`（14 个文件）全绿；`test/local-extract-fx.test.js` 绿；
  `test/skins.test.js` `test/spine-preview.test.js` 绿。

### A2 — 渲染主干（分两次提交）

- **目标**：REF 的渲染主干改造（材质加载、3D 战场、Spine 层、单位视图）进来，保留我们的皮肤/立绘。
- **参考**：REF 同名；BASE 祖先。
- **A2a 清单**：
  ```
  public/js/render/app/pixi.js
  public/js/render/app/info.js
  public/js/render/app.js
  ```
- **A2b 清单**：
  ```
  public/js/render/board3d/load.js
  public/js/render/board3d/scene.js
  public/js/render/boardArt.js
  public/js/render/spine.js
  public/js/render/units.js
  ```
- **必须在合并里保住的（OURS 侧）**：
  - `render/app/info.js`：`renderInfo()` 里的 `skin: u.skin ?? null` 一行。
  - `render/units.js`：`this.info.skin` 传给 `spineEntry(id, { skin })` 的 4 处、图片缓存 key 带 skin。
  - `render/spine.js` / `public/js/spineManifest.js`：`manifestSkinKey()` 的双 id 容错。
  - `render/app.js`：`pieceInfo()` 的 `skin: piece.skin ?? skinFor(baseId) ?? skinFor(piece.id)`、
    `skinOf/shownSkin`（设置「显示其他玩家的皮肤」）、`info.skinId` 的签名与重建逻辑。
- **禁止**：不要顺手把 REF 的 `ui/dynamicIllustration.js`、`ui/skinAssets.js`、`ui/pluginSkinPicker.js`
  引进来 —— 那是 REF 的插件皮肤选择器，我们保留自己的 `ui/skinPicker.js`（含商店立绘）。
- **验收**：`test/render/**`（111 文件）失败集合 = 基线；`test/ui/skins*`、`test/skins*.test.js`、
  `test/spine-preview.test.js` 全绿；`test/resources/**` 绿。

### A3 — 模拟层三方合并

- **目标**：REF 的战斗模拟改动进来；**战斗结果一个像素都不许变**。
- **参考**：REF 同名；BASE 祖先。
- **清单**：
  ```
  server/sim/Battle.js
  server/sim/battle/lifecycle.js
  server/sim/battle/players.js
  server/sim/units.js
  server/sim/snapshot.js
  server/sim/spec.js
  server/sim/rng.js
  server/sim/content/bands/meta.js
  server/sim/content/garrisons/meta.js
  server/sim/content/support/index.js
  shared/constants.js
  shared/i18nPacks.js
  shared/protocol.js
  shared/plugins/ui.js
  ```
- **必须在合并里保住的（OURS 侧）**：
  - `battle/players.js`：`skin: inp.skin` 从 battleInput 传到 sim unit 的两处。
  - `units.js`：`this.skin = init.skin ?? null`。
  - `snapshot.js`：`skin: u.skin ?? undefined`（无皮肤时不出现在线上）。
  - `shared/protocol.js`：我们刚做完的 `room.skins { choices }` 一段（`isSkinChoices` 校验）。
    REF 的这段是旧版（死代码 `checkSkinSelection`/`operatorCharIds`），**不要回退**。
- **硬验收（最重要的一批）**：
  1. `node tools/golden.mjs` —— 与 `test/golden/*.json` 逐字节一致，**变了就是错，不是「优化」**。
  2. `test/sim/**` 失败集合 = 基线。
  3. `test/match/**` 全绿（sim 的下游）。
  4. `test/golden*` 全绿。
- **回滚**：整批 `git reset --hard HEAD`（合并中，未提交时）。

### A4 — 数据 / 索引差异（可跳过）

- **目标**：REF 若有特效索引数据（`data/`、`shared/` 下的 fx 相关）差异，单独一批。
- **步骤**：`git diff --no-index` REF 与 OURS 的 `data/assets.json`、`shared/**` 里非代码资源；
  只有**数据条目**差异才动，代码差异归 A1–A3。
- **验收**：`test/resources/**`、`test/render/vfx-*.test.js` 不变红。
- **注意**：我们**不重建素材清单**（276 套皮肤 / 273 已装是既定事实）。

### B1 — 服务端匹配（三方合并）

- **背景**：`server/matchmaking.js` 两边都有、都不一样；`server/matchmakingRooms.js` **只有我们有**
  （组队匹配层，4 个导出：`allocateMatchmakingGroup / mergePartyMatchmaking / queuePartyMatchmaking / cancelPartyMatchmaking`），必须保留接口。
- **参考**：REF 的 `server/matchmaking.js`、`server/match/host/proxy.js`。
- **步骤**：
  1. 三方合并 `server/matchmaking.js`：**队列/成组/超时判定以 REF 为准**，回调签名若变了，
     在 `server/matchmakingRooms.js` 里适配（不要改它的导出名，有 3 个测试和 lobby 在用）。
  2. 三方合并 `server/match/host/proxy.js`。
  3. 检查 `shared/names.js`（REF 独有）：只被 `server/net.js` 用到 → 判断是不是匹配/房间的昵称生成；
     是就抄（含调用点），不是就不抄，提交信息里写明。
- **验收**：`test/matchmaking*.test.js`、`test/matchmakingRooms*.test.js`、`test/lobby*.test.js`、
  `test/match-worker-lobby.test.js` 全绿；组队匹配 / 单人匹配 / 取消 / 超时 / 重连 五条路径各有用例（缺则补）。
- **禁止**：不要引入 `server/cluster/**`、`server/persist/**`（第 6 节）。

### B2 — 客户端匹配界面（三方合并）

- **参考**：REF 的 `public/js/ui/matchmaking.js`。
- **步骤**：三方合并；新文案一律 `t()`/`N_()` 包裹；文案进 `public/i18n/{en,ja,ko,zh-TW}.json`
  （en 必须是英文、不能留中文）。
- **验收**：`test/ui/**` 失败集合 = 基线；`node tools/i18n.mjs extract` = 0；`node tools/i18n.mjs check --all --strict` 不新增失败；
  浏览器用例（`SP_E2E=1`，需要 Chrome）里匹配相关几条手动跑一次。
- **禁止**：REF 的 30 多个新面板（`turnBanner` `damageBoard` `bossPlates` `bondPlan` `serverStatus` …）
  不在本期范围，除非匹配界面直接 import。

### C1 — 收尾

1. `custom_docs/development/FORK_MAINTENANCE.md`：补「特效层」「匹配」两行来源（REF @ `fab1b97`），
   并把第 6 节的三个「我们不同」记进去。
2. 确认 `server/match/combat/**` 7 个文件仍未接入（`git grep -n "match/combat" server` 应为空）。
3. 跑 `test/docs-paths.test.js`、`test/docs-consistency.test.js`、`test/package.test.js`、`test/plugin-package.test.js`。
4. 最终全量按目录跑（一遍跑不完 917 个文件，会超时）：
   `root 1959 / ui 1000 / render+resources 1230 / sim 887 / match 463 / plugins+history+studio+ops 249 / content 170`，
   判绿标准 = 失败集合等于第 4 节基线。

---

## 6. 已知的「我们不同」，合并时不许跟

| 点 | 我们 | REF | 为什么 |
|---|---|---|---|
| 皮肤线上字段名 | `UnitInfo.skin`（皮肤值已是目录 id） | `UnitInfo.skinId` | 我们的 sim/snapshot/render 全链条已按 `skin` 命名并通过测试；改名是 30+ 处纯噪声。已记在 `docs/SKINS.md` |
| 皮肤目录 | 代码模块 `shared/skin-catalogue.js` + `room.skins { choices }`（`isSkinChoices` 白名单） | 同左，但 protocol 里还留着死代码 `checkSkinSelection`/`operatorCharIds` | 我们刚做完，且已修好 i18n 缺口；不要回退 |
| 皮肤选择器 | 我们的 `ui/skinPicker.js`（含商店立绘 `PORTRAITS_PREF`、安装状态、spine 预览） | 插件驱动的 `ui/{skinAssets,skinsModel,pluginSkinPicker,dynamicIllustration}.js` | 抄过来会丢掉商店立绘和 DIY 槽皮肤同步 |
| 状态增量 | `shared/stateDelta.js`（我们从 xinhai `2abc60f` 移植） | 同一份 xinhai 代码的另一个版本 | 两版都没有共同 base；我们这版已接线 + 有基准测试 |
| 集群 / 持久化 | 不接 `server/cluster/**`（17 文件）、`server/persist/**`（6 文件） | 全套 | 我们保留自己的 worker + Redis（`server/redis.js` `redisState.js`），4c4g 参数已按实测定好 |
| 战斗线程池 | 不接 `server/match/combat/**`（7 文件 / 106 KB：`pool` 34KB 固定 worker 池、`runner` 22KB 主线程适配器、`engine` 20KB 阶段隔离、`rehearsal`+`trial` bot 预演、`worker` 私有协议、`data` 每线程数据集） | 全套 | ① 我们的 `Match` 在主线程跑 `server/sim/Battle.js`，接它要重写 Match 的拥有关系（phase/settlement/watchers）；② 已有 lane worker（`server/workers/matchPool.js`，xinhai 线）在做同一件事，两套线程模型并存＝双倍复杂度；③ 它强依赖 REF 版 `match/fields.js`、`finalAssault.js`、`gamedata.js`，我们的 sim 引擎是 xinhai 的；④ 4c4g 上每 worker 实测 ~87 MiB。`runner.js` 早已删过（`f4e2fcf1`） |
| `match/extensions.js` | 不接 | REF 独有，被 `Match.js`/`effectsMeta.js` 引用 | 属于 REF 的扩展机制，不是本期四样 |
| `ui/` 新面板 | 不抄 REF 独有的 35 个 `public/js/ui/*.js`（3535 行）：赛事视频还原（`bossPlates` 16KB、`downedPlate`、`protocolBoot`、`turnBanner`、`turnPopup`）、房间增强（`nickname`、`playerCard`、`opPicker`、`roomCues`、`lobbyFeedback`、`matchNotice`、`notices`、`announcements`、`serverStatus`、`danmaku`、`teamLayout`、`emblem`、`siteBoards`）、素材下载（`assetDownload`/`assetImport`/`assetSection`/`materialImage`，与我们 `public/js/resources/**` 功能重叠）、对局内件（`bondPlan`、`offerOverlay`、`revival`、`gameLoading`）、管理台（`testConsole` 16KB、`testDock` 8KB、`testAudit`、`experimental`）、模型（`operatorPresetModel`） | REF 独有 | 每个都要配套 CSS + i18n + `m.public.*` 新字段与后端支持，单抄一个文件是死代码；且不属于本期四样。其中 `skinAssets`/`skinsModel`/`pluginSkinPicker`/`dynamicIllustration` **禁止抄**（与我们的 `ui/skinPicker.js` 同位置冲突） |

---

## 7. 提交信息模板

```
<type>(<scope>): <中文一句话>

来源: Stardust-minus/Stronghold-Protocol @ fab1b97 <具体文件/函数>，净变化对 b3deebda（上游 0.3.1）。
<为什么这么合/放弃了什么>

- <改动点 1>
- <改动点 2>

验证：<跑了哪些用例，多少项>；eslint 0 error；check-imports 只剩 3 条既有豁免；i18n extract 0 条未包装。
失败集合与基线一致：<列出仍然红的用例及原因>（见 custom_docs/development/MERGE_0.3.1_EFFECTS_TASKS.md §4）。
```

`type` 用 `feat`（功能）/ `fix`（修 bug）/ `chore(merge)`（纯合并）/ `docs`。
**不要**写「update」「improve」这类空话。

---

## 8. 完成的定义（DoD）

一个任务算完成，必须同时满足：

1. 四道闸全绿（§3.4）。
2. 该任务的验收测试失败集合 ⊆ 基线（§4）。
3. 一批一提交，提交信息含来源与验证数字。
4. `git status --porcelain` 干净（临时目录 `.tmp-merge/` 已删）。
5. 没有引入第 6 节列出的「不许接」的东西（`git diff --name-only HEAD~1 | grep -E 'cluster/|persist/|match/combat/'` 应为空）。

不确定的地方：**先跑测试，再问**。测试和 golden 结果比任何人的判断都可靠。
