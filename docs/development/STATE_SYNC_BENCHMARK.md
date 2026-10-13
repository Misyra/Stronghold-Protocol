# 状态同步链路:优化前基线与优先级验证

分支 `perf/state-sync`(基线 `codex/merge-0.2.6` 的 `f168479e`)。本文回答一个问题:**"状态生成与差分、无效状态更新、检查点重复编码"这三条优先级,在实测成本里各占多少,值不值得按原计划做。** 结论先写在这里,数字与复现命令在后面。

工具:`tools/state-sync-micro.mjs`(单局分段归因)与 `tools/state-sync-bench.mjs`(真实服务端 + 真实 WebSocket 的端到端负载)。两者都只读生产代码路径,不改生产行为;三个不变量的核账在端到端工具里逐帧做。

## 一、结论

| 优先级 | 计划的做法 | 实测 | 处置 |
| --- | --- | --- | --- |
| 1 状态生成与差分 | 去掉"对象 → JSON → 解析回对象 → 差分 → JSON"的往返,复用不可变快照与公共差分结果 | 往返**每个状态帧只有一次解析**(快照内缓存,`stateDeltaStats.parsedBaselines` 可数),实测 13–14 µs,占单次动作全链约 8% | 只做安全部分:不再为增量帧预建整帧文本;新增 `SP_STATE_DELTA_VERIFY` 回放自检。**放弃**"用活对象当基线"——那会拿掉"可变异源视图不得污染基线"的既有保证(见 §四) |
| 2 无效状态更新 | 按变更范围重建公私状态,相同内容提前跳过 | 浪费比例确实高(纯私人操作下 92–100% 的公共构建内容未变),但单次只值 5–13 µs(构建 3–5 + 去重 stringify 8),全链约 8%;且停用完整构建需要一个覆盖 `publicView` **全部**输入的公开内容版本号 | **不做**(见 §五):安全子集实测约 2 µs/次,拿不出与风险相称的收益;建议改从内容侧的 `onPrice` 分派热点入手(见下) |
| 3 检查点重复编码 | 可靠的持久化版本号,未变化时只更新时钟 | 每房间每轮存档现在是 capture 18 µs + 跨线程结构化克隆 285 µs(主线程)+ Worker 编码 440 µs;多数房间两轮之间什么都没变 | **已实现并验证**:`snapshot.persistVersion` + Persister 跳过 + `SP_PERSIST_VERIFY=1` 反向自证 |

顺带量到一个计划没列、但**比上面三条都大**的热点:`m.private` 的商店价格(5 个栏位 × `onPrice` 全量分派)占 `privateView()` 的约 70–73%(49–51 µs / 70 µs),是全链单项最大成本。它是内容分派层(`server/match/effectsMeta.js`)的问题,不在本次改动范围,建议单独立项(§六)。

## 二、测量方法与口径

### 分段归因 `tools/state-sync-micro.mjs`

一局真实四人比赛(harness,`fake: true`,虚拟时钟),推进到目标回合的 PREP,每人棋盘 8 子;对同一份视图反复走每一段,预热后取 6 组中位数。它测的是**单次成本**,不含传输与 Worker。

### 端到端负载 `tools/state-sync-bench.mjs`

真实服务端(`startServer`,workers=0,真实分片存储,真实 Persister)+ N 个真实 WebSocket 连接(每房间 4 名真人,棋盘已按引擎自己的部署合法性填满)。窗口内:

- 每房间 4 Hz 的"只有时钟变化"的 `markPublic`(走 `Match.guard`,模拟战斗期进度 tick);
- 每客户端 2 Hz 的真实操作(`g.refresh` / `g.buy` / `g.freeze` / `g.sell` / 棋盘↔手牌移动);
- 生产存档节奏(默认 10 s,可用 `--save-ms` 缩短用于小规模试跑)。

子进程报告:主线程 CPU(`process.threadCpuUsage`,不含 Worker)、进程 CPU、事件循环延迟直方图、GC(PerformanceObserver)、堆/RSS、`publicView`/`privateView` 调用与耗时、整帧/增量帧数与字节、每 tick 链路耗时、检查点编码次数与耗时、分片/索引/runtime 写入、操作成功率;父进程报告三条不变量的核账。

两边都用同一份工具与同一规模跑,交替顺序重复。

### 不测什么

单机回环、无 TLS/代理/CDN、无浏览器渲染、无模拟池(workers=0)、战斗用测试替身、窗口内只有 PREP 一个阶段、操作节奏是合成调度。端到端工具里的 `publicView`/`privateView` 计数包装会打断 V8 的内联缓存,单次耗时会偏大——**绝对值偏大,两侧同样偏大**;要看绝对值请用 micro 工具。

## 三、优化前基线(分段,中位数)

一局真实四人比赛,R6 PREP,每人棋盘 8 子;公共状态 4485 B、私人状态 4601 B。单位 ms/次,6 组样本中位数(本机 Windows,Node 24.19.0,空闲机器)。

| 分段 | 成本 | 说明 |
| --- | ---: | --- |
| `publicView()` 构建 | 0.0034 | 有 bond 列缓存,已很便宜 |
| `publicView()` 在一次 `dirty()` 之后 | 0.0054 | 真实场景(仅私人字段变化也会作废该玩家的 bond 列缓存) |
| `privateView()` 构建 | 0.0697 | **比公共视图贵 20 倍** |
| `publicStateJson()` 去重编码 | 0.0082 | 每帧一次 |
| `JSON.stringify(privateView)` | 0.0224 | 兼作去重基线与线上正文 |
| `JSON.parse` 公共 / 私人 | 0.0140 / 0.0154 | 差分基线;每快照只解析一次(见 §四) |
| `diffState()` | 0.0173 | |
| 补丁 `JSON.stringify` | 0.0177 | |
| 整帧文本构建 + 字节数(优先级 1 去掉的那一步) | 0.0019–0.0029(公共)/ 0.0026–0.0036(私人) | 见 §四 |
| `captureMatch()` | 0.0179 | 检查点主线程捕获 |
| `structuredClone(capture)` | 0.2896 | 等价于 `postMessage` 的跨线程复制 |
| `encodeMatchCapture()`(Worker 内) | 0.4254 | 编解码 + JSON 往返 |

`privateView()` 内部归因(同口径):商店价格 0.0510、棋盘棋子 0.0051、bond 列 0.0039、下一波敌人 0.0036、手牌 0.0003、效果 0.0001。**商店价格一项就占 73%。** 战斗期交叉验证:R6 COMBAT,商店被清空后 `privateView()` 0.0384 → 0.0697 的 55%,方向一致。

一次动作的全链成本(构建 70 + 私人编码 22 + 公共构建与去重 13 + 差分 49,公共内容变化时再加 32)约 **165 µs**,其中:

| 组成 | 占比 |
| --- | ---: |
| `privateView()` 里的商店价格分派 | ~30% |
| 差分(解析 14 + 差分 17 + 补丁 17) | ~30% |
| 私人视图其余部分 + 编码 | ~21% |
| 公共构建 + 去重编码(其中 92–100% 内容未变) | ~8% |
| 检查点(每存档轮每房间一次:捕获 18 µs + 克隆 285 µs) | 按 10 s 轮摊薄 |

"内容未变"的浪费比例(真实操作节奏,200 步):

| 操作节奏 | 公共构建次数 | 其中内容未变 | 私人构建次数 | 其中内容未变 |
| --- | ---: | ---: | ---: | ---: |
| 只改私人字段(`g.refresh` / `g.freeze`) | 103 | 102(99%) | 105 | 0 |
| 混合 | 66 | 66(100%) | 65 | 0 |
| 只改公共字段(升级/买卖) | 16 | 7(44%) | 26 | 0 |

## 四、优先级 1:状态生成与差分

**计划假设**:状态帧经历了"对象 → JSON → 解析回对象 → 差分 → JSON"的往返,可以在快照层面复用不可变对象省掉解析。

**实测**:差分账本给出直接证据——一次 micro 运行里 `frames=12402`、`fullFrames=6202`、`deltaFrames=6200`、`parsedBaselines=6202`。解析次数对应"需要作为差分输入的快照数":**每个快照只解析一次**(快照内缓存 `snapshot.parsed`),既不是每个接收者各解析一次,也不是每次转换解析两次(上一个转换解析过的快照会留着)。剩下的可去掉的一步只有"为增量帧也预建整帧文本 + 扫一遍它的 UTF-8 字节数",实测 **2–3 µs/帧**(外加每帧一个 4.5 KiB 短命字符串)。

**决定**:不把差分基线从"编码文本的解析结果"改成"活的视图对象",理由:

1. 收益是每帧一次解析(约 13–14 µs,全链 8%),不是每接收者、也不是每次转换两次——快照的解析结果已经缓存在 `snapshot.parsed` 里,`stateDeltaStats.parsedBaselines` 可直接在采样里复核。
2. 代价是传输层失去一条既有保证:`test/state-delta.test.js` 明确钉住"可变异源视图不得污染基线"。比赛确实会改视图借用出去的对象——`waves.js` 在回合开始改写 `factions.schedule`,视图里的 `factions` 是 `m.factions.slice()`。为 8% 把这条保证换成"调用方保证发送后不再改视图",不划算。
3. 真正能把这一段的 48 µs(解析 14 + 差分 17 + 补丁 17)打下来的做法不是换基线对象,而是**让状态生产方按变更范围产出补丁**(计划里优先级 2 的"根据变更范围"),即让 `publicView`/`privateView` 在构建时就知道自己改了哪几个子树,差分与整帧构建一起消失。这是一个跨协议与客户端的设计改动,不适合在这次验证里做,但它是唯一能把这一段(战斗期占单帧链路约 60%)真正减半的方向。

**已做的安全部分**:

- 整帧文本不再为每个状态帧预建:`prepareStateFrame` 只在真的要发整帧时构建它,字节数用头部长度 + 编码长度算术得出(头部是纯 ASCII)。增量帧因此不再各自产生一份 4–5 KiB 的短命字符串。
- `SP_STATE_DELTA_VERIFY=1`:每条增量按客户端解码路径回放(`JSON.parse` 线上文本 → `applyStatePatch`),与服务端当前状态做键序无关的比对;不符则计数并**退回整帧**(不会发出错误的补丁)。它是"差分基线必须跟实际发送一致"的运行时版本,`test/state-delta.test.js` 用整局脚本对局断言 `verifyChecked > 50 && verifyMismatches === 0`。
- `/healthz` 新增 `stateDelta`:`frames` / `fullFrames` / `deltaFrames` / `parsedBaselines` / `verifyChecked` / `verifyMismatches`。两次采样相减即为速率——这是复核"解析到底发生了几次"的采样钩子。

## 五、优先级 2:无效状态更新

**实测**:在一个只改私人字段的操作节奏下(`g.refresh` / `g.freeze`),203 次公共视图构建里有 202 次(99–100%)内容与上一帧完全相同;混合节奏 92%;只改公共字段的节奏 47%。私人视图构建没有一次是"内容未变"。

**但绝对值很小**:公共构建 3–5 µs + 去重 stringify 8 µs,即每次无效更新约 5–13 µs,占单次动作全链约 8%。而且这个浪费是 PREP 特有的:战斗期公共内容每帧都在变(`fields[].progress`、队友待扣 LP),去重几乎必然放行。

**为什么不做**:要让"内容没变"在**构建之前**就知道,必须有一个覆盖 `publicView` 全部输入的版本号——比赛级字段、每个玩家的 `shopLevel` / `deployCount` / `lp` / `bands` / `ready` / `autopilot`…,以及 bond 列。漏掉任何一个输入就是**少发一帧公共状态**,客户端会一直停在旧状态直到下一次相关变更;这与"差分基线必须跟实际发送一致"是同一条底线。安全子集(把 bond 列缓存的键从"任何 `dirty()`"收紧到 bond 相关的版本号)实测只值约 2 µs/次。

**建议**:真要做,先补一个内容侧的"公共字段来源清单"(`publicView` 读到的每个字段由一个 choke point 维护的版本号覆盖),再用"影子比对"(版本号说没变时照样构建并比对,计数不符)在长对局语料上跑一轮证明覆盖完整,才能打开。同样的写法在这次优先级 3 里已经用过(见下),可以复用。

## 六、顺带量到的最大单项:商店价格分派

`m.private` 的每个商店栏位都要跑一次 `onPrice` 全量分派(`PlayerEconomy.priceOf` → `EffectDispatcher.dispatch`):特质 → 全局 → 盟约 → **全部 bond** → 装备中的道具 → 持久效果。5 个栏位就是 5 次完整扇出,实测 49 µs,占 `privateView()` 的约 70%、单次动作全链的约 30%——比上面三条优先级每一条都大。

交叉验证:战斗期商店被清空(只有冻结栏位存活),`privateView()` 从 65–95 µs 掉到 37 µs,方向一致。

它不是状态同步层的问题,但它是这条链路上最贵的一段,建议单独立项:**给分派器建一个"实现了 `onPrice` 的 key 索引"**(注册时按 hook 建索引,`onPrice` 只遍历真正实现了该 hook 的 key,而不是 60+ 个 bond 的 `reg.get` + `_call` 空转)。它需要自己的正确性验证(注册表可以动态加 key、`_call` 有 repeat/投资人倍数语义),不要和状态同步的改动混在一起上线。

## 七、优先级 3:检查点重复编码(已实现)

**做法**:`server/match/snapshot.js` 新增 `persistVersion(m)`,由三部分组成,都便宜:

1. 变更计数:`markPublic` / `markPrivate` 各自把 `m._persistRev` +1。所有 PlayerState 变更都经 `dirty()` → `markPrivate`,所以**嵌套**状态(Map 多一枚棋子、商店栏位卖空、轮抽选择)也会推动版本号。
2. 直接读取的持久化标量面:`_battleSeq` / `uidSeq` / `errorCount` / `errors.length` / `simErrors` / `setupRevision` / `hiddenLayerSum` / 每名玩家的 `funds` / `lp` / `shop.level` / `deployCount` / 手牌与临时区数量…——**绕过计数的直接写入**同样会推动版本号。这一条是"可靠"而不是"相信所有 mutator 都守规矩"的关键。
3. 六个 RNG 位置(抽取、预演会在没有任何状态变更的情况下推进)与共享池自己的 `revision`(`left` 计数是持久化的)。

`Persister` 把版本号和已落盘的 body 一起存;版本没变时**只刷新时钟信封**(`matchClocks`,它本来就在 body 之外),跳过 capture、跨线程结构化克隆、编解码与 JSON 往返。房间结束/换局/房间消失时清掉版本号。

**验证**:`SP_PERSIST_VERIFY=1`(或构造参数 `verifyVersion: true`)打开**反向自证**:版本说"没变"时照常编码一遍,和已存的 body 逐字节比对。相同 → 计数为一次跳过;不同 → 计入 `versionHoles`、告警,并**提交新的 body**(验证模式永远不会留下过期检查点)。`test/persist-version.test.js` 覆盖四件事:

- 未变化的房间不提交检查点,只刷新时钟(`deadlineRemainingMs` / `startedAtAgoMs` 都在动,body 一字不改);
- 池拷贝、`errorCount`、`_persistRev` 各自都能触发重新编码;
- **被跳过的检查点仍然精确还原当前对局**:`restoreMatch` 后的 `matchState` 与活对局逐字段相等(这是"恢复不能漏掉任何已确认的状态变化");
- 版本号不是"信"而是"查":故意只改一个持久化字段(`gameSpeed`)时,检测器报警并且新 body 覆盖旧 body(证明前一条测试的 0 洞是有意义的)。

`/healthz` 的 `persist` 新增 `checkpointsEncoded` / `checkpointsSkipped` / `versionChecks` / `versionHoles`(`versionHoles` 应长期为 0)。

## 八、端到端对照(同规模,A/B)

两侧同一份工具、同一规模、交替顺序重复;每侧 4 次(端到端)或 2 次(250 房间存档)。

### 检查点(250 房间,`tools/persist-sim.mjs --rooms 250 --skip-multi`,每侧 2 次)

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 冷启动 flush(250 个分片真正写入) | 1153 / 1153 ms | 1032 / 1094 ms |
| **稳态 flush(无变化)** | **78 / 81 ms** | **8 / 9 ms** |
| 稳态分片写入 | 0 | 0(两侧都靠分片脏检测) |
| 磁盘 / 重启恢复 | 253 文件 1978 KB,250/250 恢复 | 253 文件 1979 KB,250/250 恢复 |

稳态那一轮是 **-89%(约 10 倍)**:跳过的是 250 次捕获 + 250 次跨线程结构化克隆 + 250 次编解码。这是"房间在两轮存档之间什么都没变"时的上限;真实服务器上的收益取决于有多少轮存档落在这样的时刻,用 `/healthz` 的 `checkpointsSkipped` 与 `checkpointsEncoded` 两个计数即可直接测出来。

### 状态链(16 房间 / 64 连接 / 25 s 窗口,每侧 4 次)

负载两侧完全一致(墙钟 25.25 s、状态帧约 8990、成功操作约 3126、相位漂移 0、引擎错误 0、三项不变量全 0):

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 主线程 CPU(中位数) | 2344 ms | 1969 ms |
| 同指标单次极差 | 1610–3187 ms | 1406–2844 ms |
| GC 次数 | 28 / 28 / 28 / 26 | 22 / 23 / 48 / 21 |
| GC 停顿合计 | 57 / 57.5 / 56.5 / 65.7 ms | 42.3 / 47.8 / 71.2 / 49.3 ms |
| 每 tick 链路耗时 P95 | 0.89–1.26 ms | 0.88–1.26 ms |
| 检查点编码(默认 10 s 存档) | 48 次 / 59–71 ms | 48 次 / 57 ms |
| 检查点编码(2 s 存档) | 192 次 / 202–203 ms | 192 次 / 213–215 ms |

结论要说清楚:

- **主线程 CPU 在这台机器上分辨不出这个量级的差异**:同一侧四次运行之间就有 1.6 s–3.2 s 的极差(±40%),中位数差 16% 落在噪声里,不能当作收益。
- **GC 是可分辨的**:优化前的 GC 次数几乎是常量(28/28/28/26),优化后同口径 22/23/21(一次 48 是离群),停顿合计中位数 57 → 49 ms。这与"每个增量帧少一次 4.5 KiB 整帧文本拼接"的预期一致(优先级 1 去掉的那一步)。代价是结束后堆更高、波动更大(73–117 MiB vs 81–87 MiB):整帧文本改为按需构建后,原本"随手就有的"那份字符串不再被生成,`matchVersions` 与快照缓存则多留了一点活对象;这一项只用过一次采样,不能当成稳态结论。
- **P3 在持续的合成负载下不会跳过**:窗口内每房间每秒 8 次真实操作,几乎每一轮存档都有变化,所以两侧的编码次数、耗时、分片写入**完全相同**(48/48、192/192、分片 48/48、192/192)。跳过只发生在"存档落在无变化时刻"的房间上,见上一小节的 250 房间场景。

## 九、守住的三个不变量

| 不变量 | 怎么守 |
| --- | --- |
| 私有状态不能串玩家 | 端到端工具逐帧核对 `m.private.playerId` 与接收者身份(`privateLeaks` / `privateOwnershipViolations`,必须为 0);同一房间四名玩家收到的公共内容摘要必须一致(`publicDigestMismatches`);`test/state-delta.test.js` 的按频道/按所有者基线隔离用例;本次改动没有让任何缓存跨玩家(版本号按房间、`matchDocs`/`matchClocks`/`matchVersions` 都是 per-room,差分转换缓存仍按"同一基线对")。 |
| 差分基线与实际发送一致 | 基线只在实际排入发送队列后才推进(既有);`SP_STATE_DELTA_VERIFY=1` 把每条线上增量回放后与服务端状态比对,不符退整帧并计数;端到端工具把每个客户端**最后重建出来的**状态与服务端自己的去重基线逐字比对(`baselineMismatches`,必须为 0)。 |
| 恢复不能漏掉任何已确认的状态变化 | `SP_PERSIST_VERIFY=1` 反向自证"版本没变 ⇒ body 没变";`test/persist-version.test.js` 用 `restoreMatch` + `matchState` 断言被跳过的检查点仍精确等于活对局;`test/match/snapshot.test.js` 的无损还原用例守卫还原路径本身。 |

## 十、复现

```
# 分段归因(单局,目标回合的 PREP,四人棋盘各 8 子)
node --expose-gc tools/state-sync-micro.mjs --round 6 --steps 400 --json > .cache/state-sync-micro.json

# 端到端(真实服务端 + 真实 WebSocket;小规模先跑通)
node tools/state-sync-bench.mjs --rooms 4 --sockets 16 --seconds 12 --round 3 --save-ms 2000 --out .cache/state-sync-smoke.json

# 对照(两侧同一命令,交替顺序重复)
node tools/state-sync-bench.mjs --rooms 16 --sockets 64 --seconds 25 --round 4 --label <side> --out .cache/ab-<side>-<n>.json

# 检查点:编码 vs 跳过(/healthz 的 persist 与 stateDelta 计数是生产侧采样钩子)
SP_PERSIST_VERIFY=1 node --test test/persist-version.test.js

# 差分:整局脚本对局的回放自检
SP_STATE_DELTA_VERIFY=1 node --test test/state-delta.test.js
```

Windows 定时器粒度约 15.6 ms,`monitorEventLoopDelay({ resolution: 10 })` 的均值/中位数含这一底噪,看 P99 与最大值;GC 数字是窗口内的采集,未强制 GC。
