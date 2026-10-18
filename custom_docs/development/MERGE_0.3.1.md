# 上游 0.3.1 合并记录（四个交互特性）

对象：Stardust-minus/Stronghold-Protocol 的 `fab1b97`（"Merge upstream v0.3.1"，父 `88fa1c7` + `b3deebd`）。
本分支基线 `2b355176`。口径与 [MERGE_0.3.0.md](MERGE_0.3.0.md) 相同：**能抄就抄原文**，冲突的地方跳过而不是手写一份合并版。

那个提交合并的是对方自己的 0.3.1 分支，不是一条纯主线；518 个文件的净变化要按「对方分支 vs 对方 master」读，
不是「主线发版」。

## 0. 本次边界

| 内容 | 决定 |
|---|---|
| 重刷本局投票（¾ 在线真人 / 20 s / 每局 3 次）、投票移出（过半 / 30 s）、掉线由 AI 接管（2 轮）、玩家给 AI 指定开局策略（`room.setBotBand`） | **收并接线** |
| 0.3.1 的服务端与共享模块、客户端渲染、数据、文档 | **收**（前两项里有一批只落文件、未接线的，见 §3） |
| 容量池分组（`createPoolGroups` / `createItemPools`）、combat worker 池、`server/studio` + `public/studio`（工坊）、cluster、`m.notice` 通道 | **不接**（§3） |
| `g.bondPlan`、`g.revive`、`g.unequip`、`room.setExperimental`、8–20 人容量 | **搁置**：它们依赖上面那三层，单独抄进来只会留下半成品 |
| 文档 | **收**，但整块节号 +20 顺延（§1） |

## 1. 文档分区编号：上游的 §34 与本分支的 §34 撞号

本分支的 §34–§53 已经是 [portal-agent-wss.md](../../docs/design/portal-agent-wss.md)（门户/Agent 草稿，合并 0.3.0 时从 §32–§51 顺延过来的），
而上游 0.3.1 正好是 §34 —— `test/helpers/designDocs.js` 对同一节号出现两次直接抛 `§N appears twice`，`docs-consistency`
整个文件在 import 阶段就红。

改法：0.3.1 那一整块**顺延成 §54**，一处不改口径：

- `docs/history/0.3.1.md` 的 h1（`# DESIGN §54 — 0.3.1`）与全部 `##` / `###` / `####` 标题（62 个子节）；
- 全部 `§34` / `§34.x` 引用，共 78 处 / 30 个文件，包括 `docs/{PLUGINS,PLUGIN-API,PLUGIN-GUIDE,design/engine}.md`、
  `plugins/README.md`、`schemas/plugin.schema.json`、`public/js/{themeVars,render/manifold,render/skillAttack,render/vfx/*}.js`、
  `server/{testMode,sim/content/generic,match/match/testCommands,match/player/pieces,plugins/*}.js`、`shared/{testMode,plugins/*}.js`、
  `tools/{assets/official-tables,local-extract/*}`；
- `docs/DESIGN.md` 索引新增 `| §54 | history/0.3.1.md |` 一行，**§34–§53 那行一个字没动**。

**别把 0.3.1 塞进 §0..§53 的洞里**：`test/docs-paths.test.js` 要求 `§0..max` 连续无洞（`for (let n = 0; n <= max; n++) assert.ok(where.has(n))`），
而 `§` 编号是永久的 —— 挪 portal 草稿就意味着再改 116 处引用，不划算。

顺带补上 `docs/OPERATOR-SKINS.md`：`docs/SKINS.md`（0.3.1 收进来的）链到它，上游有、本分支没有，`docs-paths` 的「相对链接都能解析」会红。

## 2. 与原文的差异（别改回去）

1. **结果提示走本分支的 `m.toast`**：上游的四个特性用 `m.notice`（0.3.1 新开的通道），本分支没有这条通道，也没有对应的通知堆栈。
   抄的时候把提示换成 `this.toast(ps, kind, msg(...))`，其余判定逻辑一字未动。
2. **重刷 / 策略池的重建走单池**：上游在容量池分组上重建（`createPoolGroups`），本分支只有单池，重建时直接调本分支的池构造函数。
3. `setupVote.js` 是照 0.3.1 原文重写的（`REROLL_VOTE_MS = 20_000`、`MAX_SETUP_REROLLS = 3`、`rerollNeed = ceil(0.75 n)`、
   `_dropSetupVoter` / `_settleSetupVote` / `_setupProposals`），旧的全票一致语义连同它的用例一起作废。

## 3. 放弃的「科研屎山」（不合并、不留死文件）

- **工坊**：`server/studio`、`public/studio` 整棵回退到本分支版本。0.3.1 的工坊依赖一个没有合并进来的 registry，
  照抄只会得到一批 import 不存在的导出的文件（`readOffers` / `initializeGameData` / `REVIVAL_COST` …）。
- **未接线的 UI 副本**，抄进来就删：`testConsole`、`testAudit`、`testDock`、`offerOverlay`、`protocolBoot`、`bossPlates`、
  `downedPlate`、`turnBanner`、`turnPopup`、`notices`、`pluginSkinPicker`、`public/studio/js/console`、5 个没挂上的 CSS。
- **combat worker 池**：`server/match/combat/{data,engine,pool,rehearsal,trial,worker}.js` 与 `match/extensions.js` 删除 ——
  本分支的模拟走 `server/sim`，这套 0.3.1 的战斗进程池没有对应的接线点。
- **恢复本分支自己的文件**（抄过去会断静态 import 图）：`public/js/battle/simHost.js`、`public/js/ui/pluginFrame.js`、
  `shared/packs.js`、`server/plugins/pack.js`。
- 8–20 人容量池、revival、bondPlan、unequip、cluster、`m.notice`：**不合并**，也没留半成品文件。

## 4. 验证阶段一起修掉的三条红（老账，不是这四条特性引入的）

| 用例 | 症状 | 处置 |
|---|---|---|
| `test/i18n.test.js` | `server/netClass.js`、`server/netBlock.js` 里 26 条中文没包 `t()` | 这两份是运维侧诊断（ASN 标签、封禁原因、启动告警，`tools/geoip-classify.mjs` 与审计日志读），玩家永远看不到 —— 按 `server/match/audit.js` / `server/chatLog.js` 的先例加 `i18n-ignore-file`。`public/js/screens/lobby.js` 的设计署名提成 `DESIGN_CREDIT` 常量（`i18n-ignore`），名字不是界面文本 |
| `test/bot-policy.test.js` | 落盘断言期望 `limitForeignSessions: true`，实得 `false` | `test/helpers/test-setup.js` 给 socket 夹具把单 IP 会话限额关了（`SP_FOREIGN_SESSION_LIMIT=off`，而 `SP_IP_SESSION_LIMIT` 是它的主名）。这条用例验的是**落盘内容**，不是默认策略，改成显式传 `limitForeignSessions: true` |
| `test/i18n-packs.test.js` | 「丢一个语言包进去，下一次请求就该看见」失败 | `server/index.js` 的 registry 是 `background: true`（0.3.1 的后台扫描线程）：读操作只踢扫描、答的是上一份快照，于是**装完语言包刷新页面还看不见，得刷两次**。`server/http/static.js` 的 `/packs/index.json` 与 `/plugins/index.json` 改成等这一次扫描（`settledIndex`），扫描失败则退回上一份好索引 |

## 5. 验证

- 四条特性与相邻的用例：50 条全绿（`setup-reroll`、`setup-reroll-ws`、`bot-band`、`lobby-bot-band`、`offline-takeover`、
  `kick-vote`、`snapshot`、`draft`）
- 文档：`docs-consistency` 24 条、`docs-paths` 11 条全绿
- i18n：`node tools/i18n.mjs check en --strict` → 2422 / 2422（100 %）
- 客户端静态 import 图：`client-static` 680 条无断链
