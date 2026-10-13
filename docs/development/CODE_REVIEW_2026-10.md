# Fork 代码审查报告（master vs origin/master @ cf7a9400）

**审查对象**：`E:/website/Stronghold-Protocol`，`origin/master..master` 全量 delta（基线 = 上游 v0.2.5 tag `cf7a9400`，merge-base 与上游 tip 相等，delta 内每行均为本 fork 所写）。

**审查方法**：

- 逐行归属：`git diff -U0` 解析 hunk，为每个文件建立新增行号区间索引；每条发现先确认"该行是否本 fork 所写"。归属工具还剔除了两条伪装成本 fork 问题的上游候选（`tools/build-i18n.mjs` 下载重试、`server/match/botEmotes.js` 模块级 env 快照——两处文件本体未被本轮触碰）。
- 客观信号：eslint 0 error / 145 warning；`tsc --checkJs` 干净；全量测试 6944 pass / 1 fail / 39 skipped。
- 二次复核：本报告全部主要发现已逐条独立复核（归属追踪 + 逐行比对 + 关键项实测），复核结论附于各条目内。

---

## 状态总览

| 级别 | 条目 | 状态 |
|---|---|---|
| P0 | master 测试套件红（CI 跑它） | ✅ 复核成立，实测复现 |
| P1-1 | 词表匹配可被插入字符绕过 | ✅ 复核成立（机制独立验证） |
| P1-2 | 两套并行本机对局记录 | ✅ 复核成立 |
| P1-3 | resultPlayerCard 影子副本回归 | ✅ 复核成立，四处分叉逐一比对 |
| P1-4 | stateFile.js 三条结构性问题 | ✅ 复核成立，store.kind 实测复现 |
| P1-5 | Lobby 私有字段回读 | ✅ 复核成立，归属措辞已修订（见下） |
| P1-6 | 快照白名单无完备性守卫 | ✅ 复核成立 |
| P2 | 17 条可优化项 | ✅ 抽查 12 条，全部属实 |
| P3 | 20 条清理项 | ✅ 抽查 8 条，全部属实 |

**复核后修订 3 处**（均不动摇结论，见附录 A）。

---

## P0 —— 唯一红灯：CI 跑的测试套件是红的

**位置**：`test/package-player.test.js:32` vs `package.json` scripts.test

**归属核验**：`test/package-player.test.js` 在 fork 内从未被改动（仅出现在 merge 提交中），断言是上游原文；`scripts.test` 的改动是本 fork 所写（diff 已核对）。

**实测复现**：单独运行该文件稳定失败，非环境抖动。

```
test/package-player.test.js:25 ✖ the packaged package.json keeps only scripts whose node files ship
AssertionError: the repository package.json still runs the suite
  actual   'node --import ./test/helpers/test-setup.js --test --test-concurrency=4'
  expected 'node --test'
```

**影响**：`.github/workflows/ci.yml` 的 `run: npm run test` 直接跑这套，CI 现在是红的。

**修法**（不要把断言改死成新字符串，否则下次合上游又红）：

```js
// test/package-player.test.js:32
assert.match(pkg.scripts.test, /^node (?:--import \S+ )?--test\b/,
  'the repository package.json still runs the suite');
```

保留原意（test 不能是静默绿的假脚本），容得下 flag 来回加。

**⚠ 修法连带面（复核补充）**：`tools/package.mjs` 的 `playerPackageProblems` / `PLAYER_NPM_SCRIPTS` 按 script 内容判定哪些 node 文件随包发布，而 `npm test` 现在引用 `test/helpers/test-setup.js`。改断言时顺手核对该文件的 KEPT 判定，否则下一个红的是打包测试的另一半。

---

## P1 —— 结构性，建议排期

### P1-1 词表匹配可被插入字符绕过，比"插字母"更松

**位置**：`server/moderation/nickname.js:7`（归一化）、`:58-65`（trie 游走）

**归属核验**：moderation 全家（nickname.js / chat.js / chatState.js / lexicon）为本 fork 2fb2e201 / c489a23f / 8645c4b7 引入。✅

**机制复核**（读源码独立成立）：归一化只保留 `\p{L}\p{N}`（:7），trie 精确逐字游走（:61），任何插入字符即切断链路——数学上必然，无需重跑词表即可确认模型缺陷。

实测数据（仓库密钥解出真实词表，只输出布尔/计数）：

| 变体 | 三字纯中文词条 4000 条绕过率 |
|---|---|
| 中间插一个拉丁字母 a | 3530 / 4000（88%） |
| 中间插一个数字 1 | 3527 / 4000 |
| 中间插全角 Ａ（NFKD 折成 A） | 3530 / 4000 |
| 中间插一个普通汉字 | 3520 / 4000 |
| 中间插零宽 U+200B | 0 / 4000 |

纯 ASCII 词条：末位加 'z' 绕过 4956 / 4957。简繁 12 字映射表抽测：2785 条中 1457 条繁体直接漏。

**两件事分开看**：零宽 0/4000 说明 DEPLOY.md 承诺的"零宽归一化"真实做到位；但"插入符号归一化"在字母数字/汉字这一类上方向相反。问题不是"忘了归一化"，而是匹配模型本身：有限枚举 + 归一化精确子串，攻击面正好落在枚举之外。

**建议**：优先做双字 shingle 倒排索引（词表按相邻二字切片建索引，输入滑窗查候选再精确校验），对插入/同形/简繁天然鲁棒；配合词表分层——"硬命中"（命中即拒）与"软命中"（打标/延迟复核），误报不再等于拒绝发送，164 条手工删掉的"误伤词"也就不必删。"有界跳步预算"（每条路径最多容忍 N 个插入字符，状态按 node 去重）是备选方向。

### P1-2 两套并行的"本机对局记录"，同一事件写两份

**位置**：`public/js/main.js:261` 与 `:264`（相邻两行）

**归属核验**：main.js 两行分别是 40820992（本 fork，IndexedDB 新记录）与上游 `recordResult`（localStorage 统计）。✅

```js
// public/js/main.js:261 与 :264
void recordMatchResult(result, store.get().me.playerId, { origin: location.origin, appVersion: APP_VERSION });
recordResult(result, { myId: ..., roomMode: ..., now: Date.now() });
```

`public/js/history/*`（IndexedDB，新）与 `public/js/ui/stats.js`（localStorage，上游）各成一套：各有上限（HISTORY_LIMIT vs MAX_RECORDS）、内容 id 去重、导出 JSON、导入合并、清空确认、单条回放；格式互不兼容，两个入口，两份互不可见的存储。stats.js 还多支持 `recordQuit`（中途退出），history 只吃结算后的 `m.result`——数据范围都不一致。

**建议**：让 stats.js 当记录模型（已有 compactRecord 存储预算、recordToResult 回放、recordQuit），history/storage.js 降级为 IndexedDB 持久化适配器，删掉 history/record.js 里重复的裁剪/校验/导出格式，两个视图读同一份 store。**这个决定不定，后续所有"对局记录"改动都会落在一半 UI 上。**

### P1-3 resultPlayerCard.js 是"抽了但没换掉原件"的影子副本，回归已带入

**归属核验**：`resultPlayerCard.js` 为本 fork 40820992 新建，上游无此文件；`result.js` 对上游仅 +3 行（挂 HistoryButton/HistorySaveStatus），PlayerCard 本体是上游原有的、且是修过 bug 的版本。✅

**两份逐行比对**（复核确认四处分叉）：

| result.js（原件，修过） | resultPlayerCard.js（副本，带回归） |
|---|---|
| :50 `noStack` 盟约 → `hideLayers`，不显示层数（:90 条件打印） | :39 无条件打印 `${b.layers ?? 0}` |
| :63 LineupThumb 带 `rec=${dr || si}`（自选 DIY/补位替代 + tooltip） | :35 丢失 `rec` |
| :72 评语名走 `sentText` | :21 直接用 `p.title?.name` |

`result.js:42-44` 注释写明：bonds.json 的 noStack 盟约（调和/协防干员/独行/绝技）层数是游戏本身不显示的，0.2.0 修复。历史详情页把这个回归重新引入了。

**另**：`historyPanel.js:45` `best=${{}}` 透传到 PlayerCard 的 `best[k] === p.playerId` 永远是空对象 → 历史详情"单局最高"高亮永不出现，且每次渲染新建对象。用 `useMemo([record])` 算一次。

**这是本次最该先修的一条——一行改动，玩家可见。**

### P1-4 server/stateFile.js（本 fork 9e957e6e 起，389 行）—— 三件事

**归属核验**：文件为本 fork 新建（9e957e6e → 85e9f247 / 17ea590c / edcec62a）。✅

**(a) 两套写入口 + 双向分片转换各一份。** `save(doc)`（:220-238）与 `saveSharded(payload)`（:246-274）的队列样板逐字重复（:235-236 与 :271-272）；`shardedPayloadFromDoc`（doc→shards）与 saveSharded 的 file 分支（shards→doc）是同一份知识两个方向，各自只在另一种布局下执行、永不互相验证。生产只有 Persister 调 saveSharded，save() 的 dir 分支只有测试触发。

修法：抽 `#enqueue(work)` 承担串行；save(doc) 退化成 `return this.saveSharded(this.shardedPayloadFromDoc(doc))`；file 布局降级收敛到 saveSharded 里唯一一处 `if (this.mode !== 'dir')`。

**(b) 被跳过的 shard 永不回收。** loadSharded 三处 continue（:176 损坏 / :184 envelope 非法 / :188 matchCount 不匹配）都没把文件登记进 `this.shards`，而删除循环（:330-343）只遍历 `this.shards.keys()`。对照：房间未知的孤儿 shard 在 :166 立刻 unlink。同类残留两种处理——崩溃点那个可能数 MB 的分片永久占盘、每次启动重新 read+parse+warn，damaged 文件永不自愈。`test/state-shards.test.js:82-97` 只钉了"跳过"，没钉"回收"。

修法：continue 前记进 `this.staleNames`，删除阶段与孤儿路径共用一条 unlink。

**(c) store.kind 恒为 'file'。【实测复现】** 构造函数写死 `this.kind = 'file'`（:32），resolveMode() 只改 mode/label/dir。dir 模式下实测：`kind === 'file'`、`mode === 'dir'`。`server/http/routes.js:57` 的 `persist.backend: store?.kind` 在分片布局下永远报 file。修法一行：resolveMode() 里 `this.kind = this.mode;`。

### P1-5 Lobby 私有字段回读（归属措辞已修订，见附录 A.1）

**归属核验（复核修订）**：`rehearsalPressure` 的 lobby.js:1106 读点 + websocket.js:59 事后赋值均为本 fork 6aa91a3e 引入，上游 lobby.js / websocket.js 中该标识符不存在；**`_workerTasks` 同样是本 fork 引入**（2e89a901 worker pool + 8f0e1a8c，两提交均不在上游祖先内），上游 Match.js 无此字段；roomAdmin.js / roomStatus.js 均为 fork 新文件。**四个回读点 100% 是本 fork 自己的代码，无上游演进因素。**

```js
server/lobby.js:1106        rehearsalPressure: this.rehearsalPressure,   // Lobby 从不声明此字段
server/http/websocket.js:59 lobby.rehearsalPressure = network.diagnostics.rehearsalPressure;
server/lobby.js:517         for (const task of room.match?._workerTasks || []) task.suspend();
server/roomAdmin.js:37      pending: room.match?._workerTasks?.size || 0
server/roomStatus.js:22     const match = room.match ? room.matchCtx?.status : null;
```

rehearsalPressure 特别值得在意：lobby.js 全文件仅 :1106 一处读，构造函数/字段列表/JSDoc 均无。任何不走 websocket.js:59 的构造路径（测试、工具、将来第二个入口）拿到 undefined，`server/match/bot.js:1112` 的 `?.cap(...) ?? m.botRehearsal` 兜住——压力限制静默不生效，无日志、无报错。同形状：`ctx.status` 改名 → status API 的 phase 恒为 LOBBY；`_workerTasks` 改名 → drain 不平滑挂起。

修法：rehearsalPressure 改 Lobby 构造参数（websocket.js:53-59 本来就同时造 Network 和 Lobby，删掉事后赋值）；Match 把 `_workerTasks` 提升为 `get workerTasks()`；给 Room.matchView() 唯一读 matchCtx 的地方。三条同形状，一起做成本最低。**因为全是自己的代码，修起来无兼容包袱，可与"单一真源"批并排。**

### P1-6 快照白名单没有完备性守卫

**归属核验**：`server/match/snapshot.js` 为本 fork 新建（9e957e6e → 14255081 / edcec62a）。✅

`MATCH_FIELDS` / `PLAYER_FIELDS`（:180/:189）同时驱动编码（:236/:283）与恢复（:260/:319/:375）。Match/PlayerState 是上游持续演进的类，引擎新增字段时既不存也不恢复，且不会有测试变红——`test/match/snapshot.test.js` 的对比断言用同一份白名单，自证。表现只能是"重启后某一局少一块状态"。在本仓库尤其危险：工作方式就是持续合上游（AGENTS.md 记录的 0.2.5 合并），重复的规则在合并时不会有冲突提示。

修法：加守卫型测试（仓库已有 `test/ui/utility-mobile.test.js` 扫全部声明的先例）——遍历新构造的 Match 与每个 PlayerState 的 own 属性，要求 ∈ 白名单 ∪ 显式 TRANSIENT_* 集合；需将两个常量 export。

---

## P2 —— 明确可优化

（归属全部核验为本 fork；下列抽查过的条目标 ✅）

### 服务端

- ✅ **stateFile.js canonicalIndex**（:24-26, :300）：每轮 flush 把 sessions + rooms（含 lastSummary 与整份 replay frames）整体 JSON.stringify 一遍只为脏检查；persist.js:106 每轮还 `[...frames]` 重建全部 replay 数组。"廉价脏检查"的 CPU 与想省下的写盘同量级。修法：元数据带单调 metaVersion，store 只比数字。
- ✅ **persist.js dispose/shutdown 顺序相反**（:410-424，逐行核对）：dispose 先 `encoder.close()` 再 `await this._pending`，shutdown 相反。runtimeCleanup 走 dispose，lobby 关停触发的 onCheckpoint 会撞上已关闭的 encoder，退回主线程同步编码整局快照。顺序对调即可。
- **persist.js:255**：`this.lobby.onCheckpoint = (…) => …` 是赋值非订阅，不保存旧 handler、dispose 后不退订。改 Set 或 subscribeCheckpoint() 返回退订函数。
- ✅ **chatLog.js:91,105-108**（逐行核对）：批次写之前就 splice 出队，catch 只累加计数——一次瞬时 ENOSPC/EIO 丢最多 100 条含 IP、playerId、聊天原文的审计记录。失败时 unshift 回队并限次重试。
- **chatLog.js:41**：retentionDays 默认 0 = 永不删除，内容含 IP + playerId + 昵称 + 原文。建议默认 30 天，"永久"变显式选择并启动时 warn。
- **net.js 三处同构**：_pumpOutbound（:790-810）与 _pumpFanout（:827-852）两份切片泵，"128 次 / 2ms"预算写在两处；`_eachConnection` 的 kind='broadcast' 默认值死代码；broadcastAll（:859）只被测试调用。收成共享切片泵 + 删死默认值。
- **net.js:1117-1125**：close() 直接 clear() 掉 _outbound/_blockedOutbound，而 beginDrain() 注释与 boot.js 承诺优雅关服发 `room.closed{reason:'shutdown'}`，客户端 main.js:246 消费此帧。关前做一次无预算同步冲刷，或改注释与承诺。
- **http/files.js:191**：cacheControlFor 的 query 一路透传，唯一消费者 `void query;`。删参数链，尾部三个裸位置参数收成对象。

### 审核

- ✅ **chat.js:20-22 注释错误**：注释写"stays hot for 30 minutes"，chatState.js:3 的 CHAT_WINDOW_MS 是 1 小时。
- ✅ **chat.js:16 不可见字符策略不一致**：只拒 `\p{Cc}\p{Cs}`，U+202E(RLO)、U+2028-202E、U+2066-2069、U+FEFF、U+200B-200F 全是 Cf，原样广播并渲染进气泡（emotes.js:192 是 preact 文本节点，不转义）——而 net.js:487 的昵称 STRIP_RANGES 拦这些。同一策略写了两遍且不一致。把 STRIP_RANGES 提到共用模块，聊天侧拒方向类子集（别整段照搬 [0x200B,0x200F]，会连 emoji ZWJ U+200D 一起拒）。
- ✅ **nickname.js:13 模块顶层同步解密**：import 链 chat.js → nickname.js，websocket.js:11 一 import 就付 readFileSync + AES-GCM 解密 + gunzip + 42732 条 NFKD 归一化 + 建 trie 的成本。默认关闭聊天也照样解密整表；缺密钥进程直接起不来。改惰性 + 缓存，"必须能审核"做成 startServer 显式前置检查。
- **nickname.js:19**：词条长度上限用昵称的 NAME_MAX_LEN = 12，却服务 30 字上限的聊天。当前词表最长正好 12 所以没漏检，但这是静默失效的坑。
- **http/nickname.js:46 vs net.js:501**：按 UTF-16 长度卡原始输入 vs 按码位截断。`{"name": "😀"×9}` 预检判 400，同一名字走 hello 却被接受。预检和校验两套口径。
- ✅ **lexicon/SOURCE.json:90 decodedSha256**：明文摘要 + 上游地址 + 精确 commit + 18 个文件 sha256 + 100 条 upstreamExcludedTerms，把"用密钥才能得到明文"的性价比打掉了。删掉 decodedSha256，改 `termsBucket: "42k"` 之类。

### 客户端

- ✅ **combatMetrics.js:70 无条件 stopPropagation**（逐行核对：:24-28 的 window 监听只在 Escape 时拦，:70 组件 onKeyDown 无条件 stop）+ :23 打开面板抢焦点。Preact 根容器事件委托，原生 stopPropagation 拦住此后到 window 的冒泡——screens/game.js:1307 和 shopBar.js:251 的快捷键都挂 window。面板是 modeless、战场还在打，玩家会以为快捷键坏了。只在 Escape 拦：
  ```js
  onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
  ```
- ✅ **combatMetrics.js:20,67-68 渲染路径重算**：useTicker(250) 下每次渲染都 runner.combatMetrics({ scope })，scope:'match' 时重建全量聚合（combineCombat 深拷 + 整体 sort）。combatHistory 近 50 份快照，4 Hz 下每秒几百次分配 + 全量排序。按 battle.tickCount 缓存，聚合移到 ticker 回调算一次存 state。
- **historyPanel.js:45**：`best=${{}}`（已在 P1-3 提及）。
- ✅ **room.js:257-261**（diff 核对为本 fork 引入）：依赖 `room?.matchmaking` 对象引用，store.set({ room }) 每次推送换新对象 → 每次心跳 clearInterval + setInterval + setElapsed。改 `!!room?.matchmaking`。
- ✅ **history/record.js:40,55**：`JSON.stringify(record).length > 128*1024` 数的是 UTF-16 码元，中文下"128 KB 上限"实测可达近 3 倍；导入那条按字节判同一份数据、文案写死"16 MB"（:6 `HISTORY_IMPORT_BYTES = 16 * 1024 * 1024`，已核对）。统一用 `new TextEncoder().encode(s).length`。
- **resources/* 三条契约无唯一出处**：缓存条目 schema 七个读写点；资源路径身份 4 份且规则不一致（store.js:352 不解码 / schedule.js:5 decodeURI / archive.js:23 decodeURIComponent / readThrough.js:30 什么都不做）——分歧表现是"写进去了但下次找不到"，静默全量重下；12 位内容指纹 3 处各写一遍而 store.js 已 import integrity.js 却没用。各收一处。
- ✅ **workerCache.js:56-58 永久判死**（逐行核对）：请求 catch 里 `capabilities.set(worker, Promise.resolve(false))`——一次超时（timeoutMs 30s）永久降级到页面自己 fetch，无日志、无提示。只在协议层判死，超时只降级本轮。（:45 hello 探测超时本就是 1s，此修法与其一致。）

### 工具链

- ✅ **r2-sync.mjs:95 唯一能直接崩进程的 bug**：`refreshPromise.finally(() => { refreshPromise = null; })` 派生 promise 无人接管。readToken()（缺 oauth_token 或配置 ENOENT）一抛，unhandledRejection 直接退进程——284 行那段"N uploads FAILED + 失败清单"永远打不出来。修法：
  ```js
  refreshPromise = (async () => { … })().finally(() => { refreshPromise = null; });
  ```
- ✅ **r2-sync.mjs:58,251 上传无门槛**：`BUCKET = flag('--bucket', 'weishu')`、`ACCOUNT = flag('--account', CONFIG_ACCOUNT || '66c7c5b7…')`——无参数就是真上传，失败模式是往线上 CDN 发布错误字节。脚本已为"未知 flag"设防（:45-53），未为"参数缺失"设同类防线。--bucket 去掉默认值、缺失即报错。
- **r2-sync.mjs:66**：wrangler 配置路径写死 AppData\Roaming\xdg.config\...，不看 XDG_CONFIG_HOME/WRANGLER_HOME、无 CLI 覆盖；失败先抛裸 ENOENT，把"跑 npx wrangler login"的真指引埋掉。（可移植性缺口，非现存故障。）
- **r2-sync.mjs:218**：每次发布对约 1.4 万文件从头 SHA-256，await 在 for 里同时只有 1 个在算——上一份 .assets-manifest.json 已存每路径 hash。同仓 tools/asset-hashes.mjs:83-98 已有并发 lane 写法。
- **tools/ 无共享层**：8 个 bench/压测脚本各抄骨架；✅ `const distribution` 在 bench-state-delta.mjs:68 与 persist-sim.mjs 逐字重复（核对）；--name value 解析 5 份且行为不一致；fork+IPC 收发 2 份；停顿探针 2 份；目录遍历 3 份。输出去向是 docs/development/ 的发布依据，口径分叉结论不可比。建议加 tools/lib/bench.mjs（纯本地模块），先迁重复度最高的两个。
- ✅ **persist-sim.mjs:376-381 两阶段并发**（逐行核对）：phaseMultiUser() 与 phaseScale() 在 push 前已调用，两个 async 各自跑到第一个 await → Promise.all 下并发。B 阶段报的 maxLag/ms 是在 A 持续制造负载时读的，文档当规模结论引用。改串行 for…await。
- ✅ **bench-state-delta.mjs:78 键名拼错**（核对）：`announcementsFile: null` 而 server/http/config.js:47 只认 `announcementFile`——静默丢弃回落 SP_ANNOUNCEMENT_SOURCE。钉死 `announcementSource: 'file'` + tmp 路径。
- **tools/README.md:12 与 scripts/README.md:7-13 与实际入口不符**：check:imports 实际入口已是 check-fork-boundaries.mjs；漏登 state-pressure-bench.mjs、encrypt-lexicon.mjs、network-probe.ps1、两个 nginx 片段（nginx.conf.example 两个 include 的目标，照 README 装完 nginx -t 缺文件）。加"目录下每个 .mjs/.ps1 必须在 README 表格出现"断言。

### CSS

- ✅ **utility-mobile.css:72-73**：同选择器同属性两次 max-height，第一行死声明。
- **:109-131 被 :441-458 重述的属性全部无效**（后者源序更晚、选择器更具体——正是有意让资源/设置/关于三弹窗"不吃可读下限"的那块）；:52 与 :411-414 的 `--utility-text: var(--t)` 重复声明。

---

## P3 —— 清理项（已 grep 确认归属）

| 位置 | 问题 |
|---|---|
| server/match/snapshot.js:112,117,119 ✅ | `let n = 0; … n++; void n;` 死计数器 |
| server/match/snapshot.js:403,444 ✅ | enterPhase(m, doc, now) 的 now 被 void 掉，调用点也传了它 |
| server/match/snapshot.js:477 ✅ | matchDigest 全仓只有定义处，注释说"tests / tools"但测试只 import matchState |
| server/announcement.js:110-111 | `error?.expected ? error.message : error.message` 两分支相同，:95 专门加的 `{ expected: true }` 被丢掉 |
| server/moderation/chat.js:6 ✅ | CHAT_COOLDOWN_MS export 无人引用（只 :17 自用） |
| server/moderation/chat.js:5 | 三个常量再导出的真实消费者都直接 import chatState.js，此行只为测试存在 |
| public/js/resources/common.js:161 | cacheName 只被测试调用（注释自己写明） |
| public/js/net.js:45 | 重新导出 ENCODED/STATE_COALESCE 无人从 net.js 拿（wireHints.js 设计意图正相反） |
| public/js/battle/metrics.js:2 | DAMAGE_TYPES 缺 sim 用的 'element'，未知类型静默并入 'true'（注：元素一列记 0 是有意设计，见"证伪"节） |
| public/js/history/record.js:5 等 | 只在本文件内使用的 export（HISTORY_SCHEMA、STAT_ROWS、ANNOUNCEMENT_CHECK_MS） |
| public/js/ui/chat.js:21 | maxlength="60" 按 UTF-16 计数，服务端与计数器按码位 30——ASCII 下能输入 60 字、计数显示 40/30、发送键无解释置灰 |
| server/index.js:114,125,200 + chatLog.js:13 + update.js:185 | "路径是否在公开目录内"判定 4 份且细节不同（update.js 把 '' 判 false，chatLog.js 判 true），安全相关判定各写一遍 |
| server/resources.js:326 vs 392 | 同一文件"算内容哈希"一处走流、一处整块读内存；加 asset-hashes.mjs / published-assets.mjs / assetVersion.js，"sha1 取前 12 hex"散落 5 处 |
| tools/memorybench.mjs:11 | 无 --expose-gc 时 global.gc?.() 空操作，照常打印带标签的 MiB，读的人不知道是未回收的数 |
| tools/asset-hashes.mjs:114 | --out 缺值时 path.resolve('') 变 cwd，然后在目录名上写文件 |
| tools/package.mjs:165 | ciallo 目录名写死，与 shared/constants.js:242 的 CUSTOM_EMOTE_THEME.dir 重复 |
| test/tmp-churn.test.js | 未入库（.gitignore:64 显式忽略）的临时复现脚本，钉 RefLru churn 不变量——要么提升为正式测试，要么删 |
| public/js/ui/about.js:5 / settings.js:189 / screens/title.js:333 vs :370 | 仓库 URL 四份硬编码，且同屏两条链接指向不同仓库（新的指 Misyra，上游那条还是 sganggs） |

---

## 做对了的 —— 这些别改

- **接缝很薄**：往上游文件打的补丁最大 108 行（title.js），其余个位数到几十行；新功能基本活在新文件里。这是 fork 最该有的样子。
- **stateFile.js 崩溃一致性真想过**：分片→index→runtime 写入顺序 + revision + matchCount 双戳，`envelope.matchCount !== room.matchCount` 能挡"新分片配旧 index"；写入失败 return false 不提交时钟。"崩在分片写与 index 写之间""崩在 index 写与 runtime 写之间"逐条推演过，均可自洽恢复。
- **net.js 三处是踩过坑的**：OutboundQueue 不可变帧共享 + 队列链独占 + remove() 节点回收重挂尾；stateTransport seq 入队预留、baseline 成功后 commit；_pumpOutbound 用 delete+set 让 Map 插入序轮转实现公平。
- **/_v/\<tag\>/ 内容寻址 + per-file ?v= 是这类服务器里少见的正解。**
- **tools/check-fork-boundaries.mjs 真接进 CI**（check:imports + ci.yml:95），登记 server/sim/nodeData.js 三个 Node 内建例外、不许整文件豁免；docs/development/FORK_MAINTENANCE.md 是真在执行的模块归属契约。
- **tools/ci.mjs 步骤表与 ci.yml、package.json 三方对齐**，test/ci.test.js 钉住。
- **AGENTS.md 两条硬契约确实遵守**（自查）：utility-mobile.css 里 .combat-metrics 规则块读 --utility-text 为 0 处；px 字号下限 `max(calc(.2 * var(--t)), 16px)` / (.14→12px) / (.1→10px) 与 game.css 一致；477 行无 !important。
- 全部自写行只有 1 个空 catch（r2-sync.mjs）；环境变量读取基本统一在 server/index.js 组合根 `opts.x ?? process.env.X` 注入。
- **history/record.js 导入防线**（schema 校验 + ids 唯一 + makeRecord 重建后比对 record.id）不是装饰。

---

## 已证伪 / 存疑（勿照改）

1. **tools/build-i18n.mjs:249 与 tools/build-data.mjs:105 的下载重试重复**——归属工具确认两文件本轮只改了文档路径字符串，download/ensureGamedata 本体是上游的。同理 tools/assets/{cache,downloader,spine}.mjs 完全未触碰。**不采信。**
2. **server/match/botEmotes.js:6 的模块级 env 快照**——上游代码（改编自 PR #444），文件未被本轮触碰。**不采信。**
3. **allocatePartyMatchmaking "多队合并 + 回滚"分支不可达**——【复核补充】原判"前提搞反、不可达"过强。lobby.js:629 确是 `freeSeat() < 0` 才 fail（有空位才入队），所以单队满员后再 queueParty 进不来；但**两个各有余位的队同时匹配**时，allocateMatchmaking:603 发现 group 成员已有房间 → 走 allocatePartyMatchmaking，:657 给无座成员 freeSeat 合并——路径可达性存疑而非确定不可达。**维持存疑，建议自查调用链后再定。**
4. **metrics.js 把 'element' 记成真实伤害**——数字上不会错（server/sim/damage.js:513 元素损伤只涨 stats.elem，stats.dmg 差值恒 0），AGENTS.md 明确"元素充能只涨 stats.elem 因而不计入"是有意的。只有"未知类型静默并入 'true'"的兜底值得收（已在 P3 列出）。**不采信为 bug。**

---

## 附录 A：复核修订（3 处，均不动摇结论）

1. **P1-5 归属措辞**：原报告暗示 `_workerTasks` 是"上游持续演进的类"的字段。实际它是本 fork 2e89a901（worker pool）+ 8f0e1a8c 引入，上游 Match.js 无此字段；rehearsalPressure 的读点与事后赋值也是 fork 6aa91a3e 引入。四个回读点 100% 是本 fork 自己的代码——问题性质不变、责任更明确，修复无兼容包袱。
2. **"剔除"第 3 条**：由"确定不可达"降级为"存疑"（见上节）。
3. **P0 修法连带面**：改 `test/package-player.test.js:32` 断言时需同步核对 `tools/package.mjs` 对 `npm test` script（引用 test/helpers/test-setup.js）的 KEPT 判定，否则打包测试的另一半会红。

## 附录 B：归属核验方法与覆盖

- 基线：`git merge-base master origin/master` = `cf7a9400`（上游 tip），delta 内所有行均为本 fork 所写。
- 每条发现独立核验：`git log cf7a9400..master --diff-filter=A / -S / -- <file>` 追踪引入提交；对上游同名文件 `git show cf7a9400:<path>` 直接比对确认"上游无此代码"。
- 实测复现项：P0（单文件跑测试稳定失败）、P1-4(c)（dir 模式 saveSharded 后 `kind='file', mode='dir'`）。
- P1-1 词表绕过率数字未重跑（需仓库密钥），但"compact 只留 \p{L}\p{N} + trie 精确游走 ⇒ 插入即断链"的机制从源码独立推导成立。

---

## 建议动手顺序

1. **P0**：package-player.test.js:32 断言改属性匹配（连带核对 tools/package.mjs）→ CI 先绿回来，后面所有改动才有回归网。
2. **resultPlayerCard 与 result.js 的 noStack 分叉**——一行止血，玩家可见回归。
3. **作决定：history/* 与 ui/stats.js 谁是记录模型**——不定，后续改动落在一半 UI 上。
4. **三个"单一真源"模块**（小改动、行为不变、test/state-*.test.js 现成回归网）：splitClocks/mergeClocks 消灭 4 份时钟合并；hashFile(abs) 消灭 5 份内容哈希；stateFile.save(doc) 退化为 saveSharded 薄包装。顺手修 store.kind 与被跳过 shard 的回收。
5. **Lobby 减负**：rehearsalPressure 改构造参数、Match.workerTasks 只读 getter、Room.matchView() 收敛 matchCtx 读取点——三条同形状，全是自己的代码，可与第 4 步并排。
6. **两条守卫型测试**：扫 Match/PlayerState own 属性对白名单；断言"稳态一轮 flush 的 CPU 不随 index 字节数增长"。让这两类问题在 code review 之前被钉死。
7. 之后才是 tools/lib/bench.mjs、审核匹配模型（P1-1）、r2-sync 安全默认值。
