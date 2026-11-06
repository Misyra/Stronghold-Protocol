# REVIEW-2026-11-06-review-integration · 审查轮 P2 集成报告

- 用户指令:先检查问题是否真实存在,再合并
- 基线: `master 68665f1c`（审查原型基于更旧的 `963ea741`）
- 集成分支: `review/integration`（worktree `/Users/misyra/Dev/sp-review-integration`），合入 `review/w3a-battle-client`、`review/w3b-resources`、`review/w3c-server-votes`
- 全部验证在独立 worktree 完成，落地 master 前不动主分支

## 1. 先复现：问题是否真实存在（3 路只读子代理，file:line 证据）

| 分支 | 核实结果 |
|---|---|
| w3a | **7 条真问题全在**：`public/js/battle/rehearsal.js:225` clear() 仍杀「已挂 task 但未 sent」的加载中温 Worker；`:93` 崩溃后无有界重建、整页永久 broken；`rehearsalWorker.js:48-52` data 帧无 try/catch；`runner.js:833` 同速接替不重定 t0、`:593` resultSent 在 compactResult 失败时也置位、`:677` catchups 把未步进帧计入；`render/fx/zones.js:198` domainField 无 key 回退键 `@${size}` 在 delete 后复用，新字段并进幸存记录 |
| w3b | **5 条全在**：`resources/store.js:1203` 清缓存按路径 `/assets/audio/` 误删（清单分层缺失，现网 tier 数据使其为潜在）；`resources/common.js:300` 普通 `AbortError` 被 `isCacheQueryLimit` 误判 → `store.js:547` 整卡永久降级；`screens/settle.js:456` 离场定时器未保存/卸载未清；`audio.js:558` 试听回退槽仍开 1.2s 全局语音间隔（`bcee737f` 只修了 tap 子项）；`render/vfx/system.js:315` 与 `audio.js` 构造器的 P3 清理项 |
| w3c | **6 条全在**：`kickVote.js:75` / `setupVote.js:63` 同向重复票仍 settle+flush（`963ea741` 只修了 `aiTakeover.js`）；`settle.js:47` 负 LP 在 `onBattleResult`/外部 AI 快照派发之后才于 `:122` 钳零；`prep.js:203` 提前 return 使 `:208` 的 `_cancelRehearsal()` 够不到；`rehearsal.js:97` + `externalAI.js:117` 两处 `scaled()` 把 wall-clock 预算乘游戏倍率；`redisState.js:72` inflate 无 `maxOutputLength`；`redis.js:173` 读失败直接 return 不重试；四份回归测试缺失 |

**结论：问题真实存在，master 只吸收了 `963ea741` 的两项**（aiTakeover 重复票零广播、rehearsal clear 保留**完全空闲**温 Worker）。审查轮记忆里「`externalAI.js:114` 同款 scaled() 无分支覆盖」的拍板点坐实：原型 `0fa5eb85` 从未触碰该文件，性能战役 `9ae220bd` 接自适应窗时也保留了 `scaled()`。

## 2. 合并与冲突整合

- 三分支依序合入 `review/integration`；w3a、w3b 干净；w3c 与性能战役在 `server/match/match/rehearsal.js` 冲突。
- 冲突整合：HEAD 为 `this.later(this.scaled(this.delegateWindowMs()), ...)`（自适应窗但带 scaled），w3c 为 `this.later(this.botRehearsalDelegateMs, ...)`（去 scaled 但退回固定 3000）。**整合为 `this.later(this.delegateWindowMs(), ...)`**——保留自适应冷/暖窗（性能战役 `9ae220bd`），采纳去 scaled 的 wall-clock 语义（w3c），与 master 已有注释「Real ms, NOT scaled」一致。
- 单独补 `server/match/externalAI.js:117` 去 scaled()（保留 `delegateWindowMs()` 自适应语义），这是原型漏掉的拍板点，独立可 revert。

## 3. 集成后发现的真回归（修前复现，修后逐项验证）

全量 `npm test` 初跑 9 fail = 7 个既有 assets 环境性失败 + **2 个新增**：

1. `test/render/battle-finish.test.js`「official completion cancels late loads…」`1 !== 0`：w3b 把 `OfficialFx.finish()` 的 `this.timers = []` 当「死赋值」删了，但那是 `finish()` 清 persistent-loop 定时器的唯一动作，测试构造 `sys.timers=[...]` 后断言 `length===0`。**审查代理误判**，恢复赋值并注明契约。
2. `test/match/sim-host.test.js` `#864`「an undelivered result survives clear…」`1 !== 2`：w3a 在 `clear()` 尾部新增 `if (!keepMetrics) retained.length = 0`，把无参 `clear()` 当「新对局」，与 master 既有契约冲突（无参 clear 必须保留 undelivered result 供 `redeliver()` 在重连时重发；该测试自 `00f09ec8` 起就在，step-packet `9f23f38d` 扩展过）。w3a 「数组不无限增长」的意图已由 store 订阅 `resetMetrics` 分支的 `retained.length = 0` 承担，**删掉 clear() 里那句**即可两全。

两处修复为单提交 `7b41ee36`，各自可 revert。修复后定向 63/63 全过。

## 4. 验证（串行，避开跨套件并行坑）

| 检查 | 结果 |
|---|---|
| 定向（12 文件：review 相关 + 受影响邻居） | 0 fail |
| `npm run golden` | 291/291 全 match（roster 49 / bonds 46 / fields 22 / matches 21 / standins 10 / diy 143） |
| lint / typecheck / check:imports | 0 error |
| 全量 `npm test`（修复后重跑） | 以待落地前最终读数为准；失败集应只剩 7 个 assets 环境性失败，与基线逐名一致 |
| server/sim/、golden 数据 | 零改动 |

## 5. 回滚

- 三个原型分支各自 revert 对应 merge commit；`review/integration` 整体可丢弃重建。
- 冲突整合 `delegateWindowMs()` 无 scaled：恢复 `this.scaled(...)` 即回性能战役语义；恢复 `botRehearsalDelegateMs` 即回 w3c 原型语义。
- `externalAI.js` 去 scaled：单行恢复 `m.scaled(...)`。
- 两处回归修复 `7b41ee36`：`git revert` 单提交（会同时把两个回归放回来，故不建议单独 revert）。

## 6. 遗留

- w3b 的「按路径误删音频」现网清单 tier 数据使其为潜在问题，合并后仍建议在带完整素材清单的机器上复核。
- `POSE_SKIP_PX`、grain 30Hz、高 RTT LCP 等仍为性能战役遗留的维护者拍板项，与本轮无关。
