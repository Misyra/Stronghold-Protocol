# deploy/ — 部署资产

放部署侧（宿主机 / 运维）资产，不进发布链、不进 npm scripts：

- `monitoring/` — Prometheus + Grafana 监控面板，起法与安全边界见
  [monitoring/README.md](monitoring/README.md) 与 [docs/DEPLOY.md](../docs/DEPLOY.md) §13。
- `main-thread-priority.conf` — systemd drop-in 片段：服务进程调度优先级 `Nice=-20`。
  应用 / 验证 / 回滚见下；同一份说明也在 docs/DEPLOY.md §14。

## main-thread-priority.conf：主线程调度优先级 Nice=-20

### 背景与目标

生产（systemd 单元 `stronghold`，`User=stronghold`，8 核，`Nice=0`）在晚高峰页面加载海啸 /
断线风暴时偶发主线程事件循环阻塞 1.2–2.9 s（Prometheus `sp_event_loop_delay` max）——主线程
和本机其他进程平等抢 CPU。目标是让服务进程在**本机 CPU 争抢**时排在普通 `Nice=0` 进程前面。

### 作用与边界

- **只在 CPU 争抢时起作用**：机器空闲时 nice 无感。不增加 CPU 配额、不改变 cgroup 权重、
  不是实时调度（SCHED_OTHER 的 nice 只改变同调度类内的权重），也不替代代码层优化。
- **对整个进程生效**：`Nice=` 由 systemd 管理器在降权（`User=stronghold`）之前设置，负值能设上；
  之后 Node 在同进程创建的 worker_threads（战斗模拟线程池）继承 -20。「主线程 -20、Worker 0」
  的内部对比被弱化，但「赢过本机其他进程」不受影响——所以这仍是第一步。
- **零代码改动**：golden、协议、sim 全不动；改动面只有一个 drop-in 文件，回滚即删文件。

### 应用步骤

```sh
# 1. 复制为 drop-in（zzzzz- 前缀让它排在既有 zzzz-0XX-release.conf 之后，将来排查最终生效值直观）
sudo cp deploy/main-thread-priority.conf \
     /etc/systemd/system/stronghold.service.d/zzzzz-main-thread-priority.conf

# 2. 重载管理器配置（不断线，尚未生效）
sudo systemctl daemon-reload

# 3. 重启服务生效——会断一次所有 WebSocket，房间从状态文件 / Redis 恢复，挑凌晨低峰
sudo systemctl restart stronghold

# 4. 验证：NI 列应为 -20；线程级查询下所有线程 NI 均 -20 也是本方案的预期
ps -o pid,ni,comm -p $(pgrep -f 'server/index.js')
ps -eLo pid,tid,ni,comm -p $(pgrep -f 'server/index.js')
```

### 收益判读（A/B，与 allocator 调优同一套工具）

环境变量不同，这条**必须重启才生效**（写 drop-in + `daemon-reload` 不断线，`restart` 才算数）。
重启前后各采一段对比，噪声大时按项目惯例取 min 逼近无干扰下界：

```sh
# 重启前：基线；重启后：同窗口长度再采
node tools/allocator-observe.mjs --label before --minutes 30 > /tmp/prio-before.jsonl
node tools/allocator-observe.mjs --label after  --minutes 30 > /tmp/prio-after.jsonl
node tools/allocator-observe.mjs --compare /tmp/prio-before.jsonl /tmp/prio-after.jsonl
```

看 `eventLoopDelayMs.p95/p99/max` 是否收窄（监控面板的 `sp_event_loop_delay` 与 `SP_LOOP_SAMPLE=1`
的 `[loop]` 行是同一现象的两个视角）；RSS 一列与本步无关，别误读成收益或损失。

### 回滚

```sh
sudo rm /etc/systemd/system/stronghold.service.d/zzzzz-main-thread-priority.conf
sudo systemctl daemon-reload && sudo systemctl restart stronghold
```

下次重启回到默认 `Nice=0`；删文件本身不断线，`restart` 才断。

### 第二步（可选，暂缓）：只提主线程的 helper + watcher

参考设计是 Stardust fork 的 `deploy/stardust/MAIN-THREAD-PRIORITY.md`（读法：
`git -C /tmp/stardust-fork show stardust/master:deploy/stardust/MAIN-THREAD-PRIORITY.md`）。
它的策略是**只有游戏 Node 的主 TID** `nice=-20`（SCHED_OTHER + `SCHED_RESET_ON_FORK`），其余线程
（worker_threads、libuv / V8 线程池）保持 0：宿主机 root helper 等 Worker 全部 ready 后对唯一主
TID 设 reset-on-fork 再降 nice，读回验证；之后新建的线程由内核重置回 0。配套一个 root systemd
watcher 订阅容器 start 事件、每次应用前重核身份（镜像白名单 revision + image ID 成对匹配、空白
名单拒绝、Worker 数与健康门槛一致、运行锁串行化、事务异常只逆序恢复自己改过的状态）。

**为什么暂缓**：

- fork 的 helper 强绑它的部署形态（Docker socket、容器名、`prod|beta|core|local` 固定 profile），
  本仓是单进程 systemd 裸机部署，定位逻辑（MainPID → 主 TID）要重写，不是拿来就用；
- 第一步已经拿到「赢过本机其他进程」的主要收益，内部对比（主线程 vs 自己的 Worker）是否值得
  一个 root 常驻组件，要等数据说话：先用第一步的 A/B 与 `SP_LOOP_SAMPLE=1` 的 `[loop]` 慢 tick
  分布验证收益，`sp_event_loop_delay` 的残余尖峰明显且归因于 Worker 争抢时再上第二步。

**如果要做的验收标准**（都来自 fork 方案，写下来防止实现时走样）：

1. 只改主 TID：helper 对主 TID 设 reset-on-fork + nice=-20，**读回**确认；已有其他线程不动，
   之后由内核把新建线程重置为 0——线程级查询里 Worker 的 NI 必须是 0。
2. 身份与竞态门槛：目标 PID 来自 `systemctl show -p MainPID` 且可执行文件是 node，重应用（服务
   重启后）重走完整校验；运行锁串行化；异常只恢复本次自己改过的状态，不覆盖第三方修改。
3. watcher 按事件驱动不轮询，断连退避重订阅；停用 watcher 不自动恢复已设置的 nice。
4. 回滚路径明确：先停 watcher，再显式把主 TID nice 恢复 0 并清 reset-on-fork 标记，**不要**对
   整进程 / 全线程 renice。
5. golden 零移动（纯部署件，不进 Node / 浏览器代码），A/B 按 §13 的协议报数。
