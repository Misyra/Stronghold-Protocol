# 健康检查、网络诊断与多房间调度

2026-10-09，参考 [xinhai 的 23d0a929](https://github.com/xinhai-ai/Stronghold-Protocol/commit/23d0a929) 移植，适配本仓库的详细健康状态、共享 worker、客户端战斗校验与虚拟时钟。两边代码采用 GPL-3.0-or-later。

## 健康检查缓存

`GET /healthz` 和 `HEAD /healthz` 保持原字段、HTTP `Cache-Control: no-store`、安全响应头和 HEAD 语义。服务端内部按实例复用统计快照和编码后的 JSON，单调时钟控制有效期，最长一秒。房间总数或匹配队列条目数变化立即刷新；连接数、会话数和 uptime 每次请求读取。对局、人数、worker、内存、缓存、发送量、发送缓冲和持久化等详细字段仍然存在，最多滞后一秒。

常见健康检查路径直接同步返回，减少 URL 解析与 Promise 分配。统计采集或编码失败返回 500，并在下次请求重试，避免把旧快照当成刷新成功。

`GET /metrics` / `HEAD /metrics` 返回即时采集的完整健康报告，以及 `websocket.diagnostics`；它不复用健康检查缓存，适合运维按需或低频采样。

## 有上限的网络诊断

每个 Network 实例持有一套累积计数，关闭时停用事件循环监测；socket 通过 WeakMap 关联诊断实例。只记录统计，不保存帧内容、玩家身份或逐帧样本数组。

| 字段 | 含义 |
|---|---|
| period / elapsedSec | sinceStart；本 Network 实例启动以来的时间与累积统计 |
| eventLoop | 20ms 分辨率的事件循环延迟与利用率；延迟单位 ms |
| receivedFrames / receivedBytes | 收到的帧与字节数，含无效帧 |
| sentFrames / sentBytes | 成功调用 ws.send 入队的帧与 UTF-8 字节数，不能解释为对端已收到 |
| handlerMs | 各合法 C2S 类型的同步处理时间；无效类型统一归入 invalid，键数量有界 |
| sendCompletionMs | 每 64 个入队帧抽样一次发送回调耗时，包含本地压缩/排队；不是网络 RTT |
| droppedSnapshots / slowDisconnects | 超过软缓冲阈值丢弃快照的次数，以及超过硬阈值断开的次数 |

处理时间和发送完成时间使用固定 21 个桶；`p95UpperMs` / `p99UpperMs` 是桶给出的分位数上界。事件循环和这些累积数据不会在读取指标时清零。原有 `wire` 字段继续保持原语义。

## 进程共享 CPU 队列

所有真实对局通过同一个 FIFO 队列运行本地 Bot 经济/布局/预演、worker 结果后的布局收尾、接管战斗分片与严格/抽样校验分片。每轮 setImmediate 最多执行 64 个任务，或在任务返回后发现已达到 4ms 预算就让出事件循环；回调后的状态 flush 计入预算。

这是协作式软预算：不能中断一个正在执行的回调；Bot 和战斗仍沿用各自的分片预算。worker 线程仍负责原来的后台计算。取消、回合切换、退出和释放调度器会移除对应任务；异步返回仍检查回合令牌，不能写回旧回合。虚拟时钟和没有 setWork 的自定义调度器沿用零延时定时器行为，保留模拟的确定性。

本机实验发现，给队列的 Immediate 调用 unref 会使连续分片等待下一次 I/O 或定时器唤醒：相同 Bot 批次约需 13.2–13.6 秒。当前实现有排队任务时保留 Immediate 引用，排空或取消后自然释放，既让出 I/O 又保持计算进展；修正后约 5.4–5.5 秒。独立子进程回归测试验证了无其他 I/O 时 130 个任务仍可完成并正常退出。

## 本地 A/B 结果

环境：Windows，Node.js v24.19.0，AMD Ryzen 7 7840H（16 逻辑处理器），约 23.2 GiB 内存。基准依次运行，未绑定 CPU；运行时未并行跑全套测试。数字描述此本机测试场景。

健康检查基准使用真实 Lobby.stats 与 Network.bufferedBytes，在构造的 500 个房间、2000 个 socket 上连续读取 100000 次。比较旧版完整采集/编码与缓存路径；断言去除会随时间变化的 memory/uptime 后字段一致。

| 批次 | 旧路径墙钟 / CPU | 缓存路径墙钟 / CPU | 房间扫描 / socket 扫描 |
|---|---:|---:|---:|
| 1 | 1621.90 / 1702 ms | 11.80 / 16 ms | 各 100000 → 各 1 |
| 2 | 1565.82 / 1578 ms | 11.73 / 47 ms | 各 100000 → 各 1 |

这是统计与响应体构建成本，CPU 减少约 97–99%，不包含 HTTP/TLS，也不是健康接口或整站吞吐提升比例。

Bot 基准准备 32 个确定种子的 solo 对局到第 7 回合 PREP，固定游戏时钟并保持该阶段；每局执行一次真实 Bot 经济、布局、3 个候选的真实战斗预演及状态 flush。禁用 worker 以覆盖主线程回退，预演分片 2ms。另一个进程的 16 个真实压缩 WebSocket 客户端持续 ping，每次响应后等待 20ms；帧限流调高，避免把限流等待混入调度测量。

legacy 使用原零延时定时器调度；cooperative 使用共享队列。最后一批按 cooperative → legacy 反向运行。

| 路径 / 批次 | WS RTT P95 | WS RTT P99 | Bot 批次墙钟 | 服务端 CPU | ping 样本 |
|---|---:|---:|---:|---:|---:|
| legacy 1 | 51.86 ms | 57.93 ms | 5584.22 ms | 7985 ms | 1584 |
| cooperative 1 | 5.37 ms | 6.92 ms | 5405.24 ms | 7453 ms | 2800 |
| legacy 2 | 48.52 ms | 85.59 ms | 5791.48 ms | 8124 ms | 1585 |
| cooperative 2 | 5.06 ms | 6.67 ms | 5526.07 ms | 8516 ms | 2864 |
| legacy 3（反向） | 47.99 ms | 60.24 ms | 5491.48 ms | 7374 ms | 1488 |

所有运行均完成 32 局、错误 0、ping 失败 0；整组最终 matchState 的 SHA-256 完全一致：

`acb1e9962e7a7065557df055a5baced4823a701b9d42a6c2f2f4f11f7e8c08e6`

这个场景 P95 约降低 90%，批次完成时间相近。闭环 ping 的样本数会随响应速度变化，服务端 CPU 没有稳定下降，不能据此承诺省 CPU、实际线上容量或完整对局吞吐。基准输出的诊断是 sinceStart 累积值，含准备/预热；表中的 RTT 和批次耗时只测正式工作窗口。

复现命令（仓库根目录）：

```powershell
node tools/healthbench.mjs --rooms 500 --reads 100000
node tools/bench-cooperative.mjs --variant legacy --matches 32 --rehearsal 3 --clients 16
node tools/bench-cooperative.mjs --variant cooperative --matches 32 --rehearsal 3 --clients 16
```

本次原始输出保存在本地忽略目录：`.cache/healthbench-500-r{1,2}.json`、`.cache/cooperative-32-legacy-r{1,2,3}.json`、`.cache/cooperative-32-ref-r1.json`、`.cache/cooperative-32-cooperative-ref-r2.json`。未保留引用的对照实验为 `.cache/cooperative-32-cooperative-r{1,2}.json`。

## 回归验证

- 全套 Node 测试：6069 项，6041 通过、28 跳过、0 失败；浏览器大套按 SP_E2E=0、SP_REAL_E2E=0、RENDER_E2E=0 关闭。使用临时 Git index 处理本地新增文件，保留用户原暂存状态。
- 之后针对缓存刷新原子性和 Immediate 活性补充修正与测试，最终专项 52 项通过，覆盖这三项功能、校验分片和 worker；其中本次新增测试共 25 项。
- 最终实时联机、大厅、增量同步集成测试另跑 70 项通过，包括 2 人 + 2 AI 到第 4 回合、四人混合客户端、私有视图隔离、重连和完整恢复。
- 黄金结果 283 项一致；真实 Chrome 的增量同步/丢失基线/重同步/重连测试 1 项通过。
- 全仓 lint 无错误（保留原有 145 个 warning），typecheck 通过，diff 空白检查通过；导入边界检查仍报告原有 5 项，未新增。
