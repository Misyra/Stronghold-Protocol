# WebSocket 状态增量传输

改编自 [xinhai-ai/Stronghold-Protocol 的 2abc60f0](https://github.com/xinhai-ai/Stronghold-Protocol/commit/2abc60f0)，遵循 GPL-3.0-or-later。

客户端通过 hello.stateDelta: 1 协商；缺省或未知版本继续接收原有完整消息，新客户端也接受旧服务器的完整消息。仅 m.public / m.private 使用 m.state 封装，战斗、房间、结算和操作确认的消息保持原格式。

首次状态和全量恢复为 { t: "m.state", kind, seq, full }；后续为 { t: "m.state", kind, seq, base, patch }。序号来自进程内快照，不要求相邻；base 必须等于该连接该频道的现有序号。补丁操作为 [路径数组, 新值] 或 [路径数组]（删除对象字段）。同长度数组按索引更新，长度或类型变化替换子树；超过 4096 个操作或 64 层路径时回退全量，补丁不比全量的 UTF-8 字节数小时也回退全量。

每条连接分别保存公共／私人基线，只有可靠帧成功排入发送队列才推进。相同公共快照和基线复用补丁编码，私人状态不会跨玩家复用。基线从编码字符串解析，避免引用游戏内可变对象。客户端按写时复制应用补丁，再派发原来的 m.public / m.private；界面应继续将状态视为只读。

基线不匹配或补丁非法时，不派发部分状态，合并请求 state.resync；使用既有重型请求限流和同身份重同步节流，客户端最多每秒安静重试一次。断线、房间关闭和结算清理基线，重连从完整状态恢复。增量状态不可丢弃，b.snap 的丢弃和硬背压断开阈值保持原样。

本分支继续复用 ENCODED，wire.byType 保持 m.public / m.private 的逻辑类型，字节统计记录实际完整／增量帧的长度（沿用现有 UTF-16 字符数口径）。结果回放仍保存完整消息，投递时按当前连接协商重新编码。现有构建标识已包含整个 shared/，新解码模块会参与页面版本更新。

此次只移植状态差分和恢复路径；没有引入 xinhai 的在线人数推送、公共匹配规则、全服任务调度或健康检查缓存。publicView / privateView 仍完整构建并编码，额外基线会消耗内存，实际带宽和延迟收益需要在本分支负载下测量。

## 验证

- test/state-delta.test.js：补丁边界、随机 JSON、写时复制、私人隔离、背压与失败、重试、完整脚本化对局状态一致性、预编码与流量统计。
- test/state-delta-integration.test.js：真实 WebSocket 四人房间、新旧客户端混用、纯真人匹配、观战、全量恢复、重连、结果回放及重型限流／恢复请求合并。
- test/ui/state-delta.e2e.test.js：真实 Chrome 网络层与应用状态，丢失基线后的自动恢复及重连；通过 SP_E2E=1、CHROME_PATH 启用。

## perf/state-sync 增补（2026-10-13）

- 整帧文本改为按需构建：原先每个状态帧都先拼出一份完整帧文本（增量帧也一样），现在只在确实要发整帧时构建，字节数由头部长度加编码长度算术得出（头部是纯 ASCII）。增量帧因此不再各自产生一份 4–5 KiB 的短命字符串。
- `SP_STATE_DELTA_VERIFY=1`（每次转换读取环境变量，可在进程内打开）：把每条线上增量按客户端路径回放（`JSON.parse` 文本 → `applyStatePatch`），与服务端当前状态做键序无关的比对；不符则计入 `stateDeltaStats.verifyMismatches` 并退回整帧，不会发出错误的补丁。
- `/healthz` 新增 `stateDelta`：`frames` / `fullFrames` / `deltaFrames` / `parsedBaselines` / `verifyChecked` / `verifyMismatches`。两次采样相减即为速率；`parsedBaselines` 用来复核“每个快照到底被解析了几次”。
- 差分基线仍然只从编码文本解析（快照内缓存 `snapshot.parsed`，一个状态帧全进程只解析一次）。**没有**改成复用活的视图对象：那会拿掉本文件上一段承诺的“避免引用游戏内可变对象”，而收益只有每帧一次解析（约 13–14 µs，占单次动作链路约 8%，见 [同步链路基线](STATE_SYNC_BENCHMARK.md) §四）。

部署时同步服务器和前端代码并重启服务器；保留现有状态目录及环境配置。此次没有新增或更改素材，无需发布 CDN 资源。

本次验证：576 项定向 Node 检查、9 项真实 Chrome 测试通过；其中 10 项发行清单检查使用独立临时索引纳入已有未跟踪的 about.js，实际暂存区不受验证影响。静态检查通过，导入边界保留现有 5 处已知跨层导入。本地 400／2000 连接、1／4Hz 全量与增量对照结果见 [本地传输压测](STATE_DELTA_BENCHMARK.md)。未做线上完整对局容量压测。
