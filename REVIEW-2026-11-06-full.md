# 全量代码审查报告(第二轮)— 2026-11-06

审查人:ZCode(主线程汇总裁决,7 个审查/原型子代理;**5 条 P2 全部经主线程逐行对码核实**,遵守「修前先复现」铁律)。
基线:master `963ea741`,工作区干净。上一轮(REVIEW-2026-11-06.md)的 7 项 P3 已随 `52f22c46`/`963ea741` 落库,本轮在其上全量展开。

## 方法与范围

- **波次1**(4 并行只读审查):前端 UI / 前端渲染·战斗·资源 / 服务端 match·协议·设施 / sim+数据管线。
- **波次2**(3 并行只读审查):三代理自报盲区——sim `battle/` 方法目录+content 补全、服务端 bot*/settle/redis/插件注册表、前端 resources/store、audio、vfx/board3d、screens 全量。
- **波次3**(3 并行,**worktree 隔离**):已确认问题的可评测修复原型,分支见「六」;源仓库除本报告与 AGENTS.md 扩充外零改动。
- 全量门:`npm run ci`(test 11762 用例)+ lint / check:imports / typecheck / test:guards。
- 并行对话的性能优化战役已完结合入,其全部落点(`28c1060d`/`c992d460`/`d3fffd27`/`eb679687`/`f7df979c`/`0cf7fd45`/`60922a97`/`0216f86f` 等)纳入本轮回归并核实闭环。

## 总体结论

- **无 P0/P1;5 条 P2;约 18 条 P3;2 条 P4。** 全部有 file:line + 代码证据。
- 修复原型已备好(3 个 worktree 分支,测试+eslint+golden 全绿),**未回源仓**,待拍板。
- **sim 引擎深审(两轮)零规则性 bug、确定性门零违例、golden 291 场景全 match**——引擎与近期 5 个 Stardust 移植提交(塔露拉/持续施法/鸭爵/四模组/domain fx)全部核实与声称行为一致。
- `npm run ci` 仅 2 失败,均为已知的 2.7.91 四模组图标素材缺口(CSR-X/TAC-D),非代码问题。

## 一、P2(5 条,均主线程核实)

1. **[客户端] rehearsal `clear()` 杀「已领任务未发出」的加载中 Worker** — `public/js/battle/rehearsal.js:225`。
   `w.task || w.sent` 恒等于「有任务」(`sent` 与 `task` 同步置/清),对局收尾时把模块图仍在加载的 Worker 一并 terminate——与同文件 `onCancel:209-213` 对同一状态的保留策略(「Keep the loading progress」)直接矛盾,`963ea741` 的温 Worker 复用被收尾窗口部分抵消;下一局首彩排重新在 3s 预算内付模块图加载,大概率超时回落服务器。
2. **[客户端] Worker 一次报错 → `broken` 页面级永久** — `rehearsal.js:93`(唯一赋值点,无复位)+ `rehearsalWorker.js:48-52`('data' 帧无 try/catch)。任一未捕获 Worker 异常后,本页每次 `b.rehearsal` 直接回 `{error:true}`,房主彩排整局退回服务器,脱主线程收益全失。
3. **[客户端] runner 同速接替(authority 交接)不按 `msg.elapsed` 重定 `t0`** — `public/js/battle/runner.js:818-822`。注释说「a handover … continue from the field's clock」,代码只在 `speedChanged` 时重算;接替后本页战斗钟与服务器场地钟的累计偏差不被纠正,上报的 `b.progress.gt/killed` 与服务器时间轴错位到本场结束。
4. **[服务端] `g.kickBallot`/`g.rerollVote` 同向重复票强制全房重播** — `server/match/match/kickVote.js:75-77→116-117`、`setupVote.js:63-67`。重复票无变化仍走 `markPublic()+flush(true)`,同时绕过 10/s 节流与内容去重,全房(含观战)逐条重播 m.public。正是 `963ea741` 给 `room.aiVote` 修掉的同类问题在另一批投票面的残留;`speedVote.js:24` 的 `if (want === has) return OK` 是正确范式。实测:6 人房连发 10 条同向票 = +10 帧全房重播。
5. **[服务端] settle 致死回合 dispatch 时 `ps.lp` 为负,DSL/外部 AI handler 可读到** — `server/match/match/settle.js:47`(`ps.lp -= loss`)→`:80`(`dispatch 'onBattleResult'`,经 `effectsMeta.js:606` 的 `lp: () => ps.lp`、`externalAI.js:70/259` 快照、`views.js:100` 私有视图)→`:83`(`eliminateBroken` 才钳零)。官方语义 LP 无负值;bot 侧 `bot.js:1923`/`aiDigest.js:21` 早已写死 `Math.max(0, lp)` 防御,「lp 永不为负」是代码库既有假设。

## 二、P3(按区域)

**前端**
- `public/js/ui/offerOverlay.js:139`:变体按钮可用性守卫传 `mine ? priv : null`,与 `:129` 的 picked 双守卫不一致(当前无用户可见后果,语义相左)。
- `public/js/ui/accounts.js:132`:`data.load('local')` fire-and-forget,头像面板不订阅该清单,极端时序下头像分组缺失。
- `public/js/ui/chat.js:79`:`new Date(entry.at).toISOString()` 对非有限 `at` 抛 Invalid time value,render 期异常被 error boundary 接住整屏白屏(协议可信故正常不触发,守卫缺失)。
- `public/js/battle/runner.js:596-604`:`resultSent` 先置位、`compactResult` 失败后永不上报,服务器等满 deadline 才接管。
- `public/js/battle/runner.js:1064-1067`:`retained` 数组永不清理(断线期结束的对局条目+整份 spec 滞留到刷新)。
- `public/js/battle/runner.js:675-679`:`stats.catchups` 在 `stepping` 早退前计数,dev 统计口径虚高。
- `public/js/render/app.js:428-429`:`webglcontextlost` 清理项被 `setupCleanup.length = 0`(:2394)抹掉,`destroy()` 漏补。
- `public/js/render/fx/zones.js`(bf3e5c33):domainField 无 key 回退键 `@${size}` 可互相并单(旧数据才可触)。
- `public/js/resources/store.js:1203`:`clear({optionalOnly})` 的 `/assets/audio/` 兜底不校验 manifest tier(清单一旦标 ESSENTIAL 音频即误删)。
- `public/js/resources/common.js:300`:一切 AbortError 被当「查询超限」,整卡永久降级 `#keysRefused`。
- `public/js/screens/settle.js:456`:离场 `setTimeout(onNext)` 未保存未清理,卸载窗口内可多触发一次 onNext。

**服务端**
- `server/match/match/prep.js:200-208`:endPrep 被 _checkIdle/_checkOffline 踢完人后提前 return,跳过 `_cancelRehearsal`(已结束未 dispose 窗口内彩排任务继续烧池)。
- `server/match/match/rehearsal.js:74`:委托应答窗口被 `scaled()` 放缩,与 `Match.js:177`「wall-clock ms」文档相悖(timerScale 生产恒 1,潜伏)。
- `server/match/externalAI.js:114`(波次3 发现):外部 AI 的委托窗口同样被 scaled() 放缩,同病,**尚未在任何分支修复**。
- `server/redisState.js:71-74`:`inflateRaw` 无 `maxOutputLength`,后置大小检查挡不住解压分配(存储被写入极端压缩比值时启动期一次解出数 GB)。
- `server/redis.js:173-177`:StateStore.load「连上但读失败」立即定论 unavailable,与注释声明的 boot 重试意图不符。
- `server/redis.js:199-211`:ValkeyStateStore 未覆写继承的 `saveSerialized`(当前无调用方,未来一旦调用即绕过分片布局)。

**sim / 数据**
- `server/sim/content/bands/meta.js:499`:duckPicks 的下路门依赖 `routes` 缺失时经 `gateOf(null)→'lower'` 静默退化为「全部算下路」,无告警。
- `server/sim/content/enemies/element.js:96-98`:死亡之眼施法者死亡时 `ab:channel` buff 遗留尸体(无功能影响)。
- `server/sim/content/kits/ops/chess_char_6_11-mlyss.js:196-200`:侵蚀附伤未排除 `hpLoss` 标签(当前不可达;pithst 同形;op-dminon 同类已排除,两种写法并存)。

**素材/环境(非代码)**
- `data/assets.json` 缺 CSR-X/TAC-D 模组类型图标(`5c7316a3` 只带了 isw-a/dec-x):`npm test` 的 assets-diy/moduleIcons 两条覆盖测试失败。修复 = 重跑 `npm run assets` + `npm run manifest`(需 2.7.91 素材在本机)。

## 三、P4

- `public/js/audio.js:1535`:试听回退到非 tap 槽位时开启 1.2s 全局语音间隔,吞掉随后第一条战斗语音。
- `public/js/screens/settle.js:456` 同上(已列 P3,影响级别 P4)。

## 四、未证实疑点(不构成发现,留给后续轮/维护者裁定)

- `bosses.js:339-356` mirror() 的 1-tick 死亡窗口:领袖出生同 tick 被杀会凭空补一只(官方无此场景记载)。
- 恐惧不打断持续施法(`ai.js:696` 只查 stun/silence/目标死):官方语义无源可考。
- bot 读共享卡池余量(`bot.js:590`、`botIoletaPolicy.js:84`):不出网,但「官方是否公开池计数」未证实,属还原度问题。
- `shared/stateDelta.js:104-105` 收到更旧全帧即 fail+resync:服务端保证不会发生,防御性代码。
- RefLru failTtl 分支、p2p 时钟回拨、net.js handshaking 心跳盲区、pluginFrame sync() 对 studio 预览的理论耦合、`g.offer` 越界 idx 的服务端拒绝形态:均未构造出可达路径。

## 五、整洁度(节选)

- `server/match/bot.js` 4497 行单文件:策略评分/几何建模/FA 装备数学/prep 编排未拆,定位成本全仓最高。
- `server/aiTakeover.js:58-65` failTicker 按 detail 字符串分派(拼写一改即静默落 default),`:102-105` 30000 三处双写。
- `server/http/static.js:364/429` ETag 编码分叉两处重复;`server/match/match/rehearsal.js` poolRehearsal/_rehearsalToPool ~40 行重复。
- `server/match/aiDigest.js` 跨层调 `ps._gate()/_slotPolicy()/_legal()` 私有方法;`watch.js:256` 视图签名挂 PlayerState。
- `public/js/assets.js:85` 与 `spineManifest.js:87` skinHasModel 重复;`pluginFrame.js:91` 孤儿 JSDoc;`main.js:221` 双重 t();`render/interp.js:540` JSDoc 漂移;`render/vfx/system.js:315` 死赋值;`externalAI.js:21` AI_ACTIONS 重复项;`audio.js:653` `_unlockDropped` 未声明。

## 六、波次3 交付(修复原型,worktree 隔离,待拍板合并)

| 分支(基于 963ea741) | 提交 | 内容 | 验证 |
|---|---|---|---|
| `review/w3a-battle-client`(/Users/misyra/Dev/Stronghold-Protocol-worktrees/w3a-battle-client) | `6f618949`+`1f6bb3fb`+`4ec9e818` | P2-1/2/3 + runner resultSent 重试/catchups/retained + zones 回退键;温 Worker 复用实测:下一局首彩排重建成本中位 300ms→1ms(LOAD_MS=300 口径),每对局 Worker 数 2→1 | 44/44 测试、eslint 0、golden 全 match |
| `review/w3b-resources`(同目录 w3b-resources) | `b9949d0f` | 音频兜底按清单 tier、isCacheQueryLimit 只认措辞、settle 定时器清理、试听不开语音间隔 + 2 处整洁 | 421 用例全绿、eslint 0(1 基线警告) |
| `review/w3c-server-votes`(同目录 w3c-server-votes) | `0fa5eb85` | 重复票零广播(实测 +10 帧→+0)、settle 源头钳零(选型 a:一处修复全部读点)、endPrep 补 _cancelRehearsal、委托窗口去 scaled()、redis inflate 保险丝+load 重试 | 1593/1597(1 为本机 SES 环境失败,基线同样)、golden 全 match(50072ms) |

拍板注意:w3a 的失败预算(每局 3 次)/500ms 重试节奏/retained 新局清空是拍的默认值,分支内可一行调整;w3c 的重复票回 ok(与 aiTakeover 一致)如需 ALREADY 语义需另定;`externalAI.js:114` 的 scaled() 同病不在任何分支,需单独修。

## 七、已验证干净(要点,供后续轮免重复)

- **XSS 全扫(ui+screens+vfx)**:innerHTML/dangerouslySetInnerHTML 全部不可控数据源,昵称/聊天/插件文本走文本节点;无 eval/Function。
- **gameLogic 纯度**:17 文件零 DOM/clock/random 命中;i18n 四包 3214 msgids 100%。
- **协议信任边界**:C2S 抽查 10+ 条 handler 只读 validator 绑定字段;rid 四路回显一致;b.progress 全钳位;b.result 过 validateClientResult+requireCs。
- **安全守卫**:gate 本地旁路零转发头、插件 zip 九重拒、https 安装 timingSafeEqual、studio 逐级 realpath、peerRelay 防重放——抽查全部在位。
- **经济/结算资金面**:addFunds 钳负截断、结算金币非负、半结算/重复结算 phase 守卫齐、联防漏怪计费正确。
- **bot 状态机无死路**(prepDeadline 兜底、guard 上限齐),bot 不越权读私有帧;externalAI 传输无重定向/限字节/密钥不进日志。
- **worker 池契约**(d3fffd27 闭环)、state-delta 分通道基线、br/gzip ETag/Vary/304、963ea741/52f22c46 全部回归闭环。
- **sim**:确定性零违例、跨局零泄漏(WeakMap-by-battle/unit.mem 合规)、结算 API 使用合规、快照/回放完备、battle/ 八文件+bosses/tokens/enemies 全文干净。
- **资源缓存**:写入原子性/损坏检测/配额/版本迁移/键归一全部成立;audio 解锁/BGM 竞态/LRU 双预算成立;vfx/board3d GPU 释放与 NaN 防御成立;drag 单指针状态机成立;diag 零外发。

## 八、覆盖面与测试

- **深读**:ui/ 主要 14 文件、screens 16 文件、battle/ 9 文件、render 核心+fx/vfx/board3d 主体、resources 22 文件、net/p2p、server match 核心+votes/settle/offers/watch/prep/reports、bot 家族关键路径、externalAI 全家、host/、plugins registry/zip/install、redis/valkey 全家、sim 核心+content 大部。
- **未覆盖**(下轮候选):`bot.js` ~六成纯评分函数、`resources/store.js` 边角、vfx 大型数据驱动文件(skillfx/wiring 逐行)、`render/fx/` 全量(前轮已审)、kits 其余 ~225 文件(测试兜底)。
- **测试**:全量 11762(2 失败=素材缺口);各代理另跑约 30 组针对性套件全绿;golden 只读验证 3 次(含 worktree 分支)全 match;lint/typecheck/check:imports/test:guards 全绿。
