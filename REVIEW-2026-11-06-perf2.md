# REVIEW-2026-11-06-perf2 · 第二轮性能专项报告

- 基线: `master 963ea741`（2026-11-06）
- 范围: 前端渲染、资源加载、接口请求链路、缓存策略、状态更新、打包产物、内存泄漏、交互响应耗时、后端/脚本热点
- 方法: 复用 2026-11-04 首轮 Bug 审查与性能战役结论，**不重复功能正确性/代码整洁审查**；四路只读侦查（渲染 / 资源HTTP / 服务端 / 泄漏+交互）→ 基准采集 → 独立 worktree 实施 → 交替 A/B → 全量验证
- 全部改动在 `perf2/*` 分支的独立 worktree，**未 push、未动源仓库主分支、未合 master**
- 交付分支 `perf2/delivery`（本文件 + AGENTS.md 性能章节）；基线日志 `/tmp/sp-perf2/baseline/run1.log`，战役笔记 `/tmp/sp-perf2/campaign-notes.md`

## 1. 基线指标（M 系列 / node v26.13.0）

| 指标 | 值 |
|---|---|
| golden | 291/291 场景全 match（roster 49 / bonds 46 / fields 22 / matches 21 / standins 10 / diy 143） |
| loadgen 12 客 / 4 房 / 60s | 232.4 msg/s 进、231.4 出、RSS 均值 280.9 MB、loop p95 max 22.5 ms、零丢帧 |
| workerbench 4 线程 / 24 battles | 60.94 battles/s（主线程基线 24.99），maxTimerDelay 950.4→2.3 ms |
| state-sync-micro | capture 0.013 ms、clone 0.129 ms/次 |
| bench-state-delta | delta 帧 0.1848 ratio、CPU −10.97%、字节逐字一致 |
| memorybench | 276 房 dispose 后 heap 69.5→60.2 MB 回落；4 worker 各 37–45 MB |
| vite 产物 | 2.8 MB / 16 chunk；entry 1,271,492 B（br 331,864）、app chunk 673,836 B（br 189,175）、CSS 631,614 B（br 97,883） |

## 2. 侦查结论（四路）

首轮落库后，广播链（encoded 直传）、持久化分片、GC 对象池、worker 数据子集化、gate/traffic/healthMetrics 热路径均近乎闲置；board3d 帧跳过、i18n switch、UI 订阅降档等维持「已否」。剩余热点集中于：spine 直绘姿态与 tint 链、film grain/filter、resource-packs 端点每请求 11 ms 纯 CPU、plugins 索引每请求重建、冷房主彩排 3s 窗口双跑、WorkerSimHost step 包每步全量 meta、拖拽高亮与 memo 尾项、entry 单入口 331KB br。

## 3. 优化清单（10 分支 / 19 commits，全部合入候选）

每条含收益预估→实测、风险、回滚。A/B 均为同机交替 ≥4 轮取每轮最小，完整逐轮数据在各分支代理报告与战役笔记。

| # | 分支 / commit | 优化 | 实测收益 | 风险 | 回滚 |
|---|---|---|---|---|---|
| 1 | `perf2/packs-memo` `8444300b` | `/data/resource-packs.json` 按 stat 身份记忆化（cdnCache 同型） | 200 starttransfer 13.7→0.25 ms（55×）；304 重验证 13.5→0.20 ms（**69×**），4 轮区间零重叠 | 常驻 +6.5 MB；stat→readFile TOCTOU 窄窗（自愈）；首次/文件变动仍付全量 | `git revert 8444300b` |
| 2 | `perf2/plugins-cache` `02dedd12` | `/plugins/index.json` 按扫描代际 + vanilla 键缓存 | 无压缩 p50 0.93→0.27 ms（0.29×）；br 端到端 p50 1.17→0.50 ms（**−57%**）；装/改/卸新鲜度与基线逐字一致 | 安全面无变化（仅复用已过审的构建体）；每代际每键一份目录体（≤2 键） | `git revert 02dedd12` |
| 3 | `perf2/interact-batch` `4660e614` | 拖拽高亮脏检查（组内 tile 序列/绘制字段签名） | 全量重画/拖 125→8（−94%）、0.365→0.030 ms（**−92%**）；3D 切换/换场强制重画路径保持 | 纯视觉；Node 探针只覆盖 CPU/投影，浏览器 GPU 侧收益更高未测 | `git revert 4660e614` |
| 4 | 同上 `688fd8fa` | BondStrip/EffectsList/CombatHud memo 尾项 + strip/分层/client useMemo + 稳定 onOpen | 稳定 props 组渲染 201→1；BondStrip 4.6→0.2 ms、EffectsList −98%、CombatHud −80~90% | m.public 全量重序列化 bonds/effects 的推送无收益（如实记录）；需协议侧数组复用才能吃掉 | `git revert 688fd8fa` |
| 5 | 同上 `240426b3` | battle/metrics 行键静态拼接 | 0.087→0.065 µs/事件（**−25~28%**），少一次数组+JSON 分配 | 极低；key 单射性经论证；cardRangeKey 子项实测拼接比 stringify 慢 2.4× **主动放弃** | `git revert 240426b3` |
| 6 | `perf2/step-packet` `9f23f38d` | WorkerSimHost step 包瘦身：fieldMeta/ownerOps 按单位身份指纹按需化 + meta RPC + show 后 refreshMeta 兜底重进场 | 每步包体均值 5341→1534 B（**−71.3%**）、p95 −34.3%；tick RPC 0.0483→0.0310 ms（−35.8%）；终局载荷逐字节一致；插件房 SES 路径验证 | 指纹漏报三层防护（含 down 位/op 身份，宁多带；show 兜底重进场）；指纹与 fieldMeta 过滤器须同步演进 | `SP_STEP_PACKET=full`（或页面 `__SP_STEP_PACKET__`）即恢复每步全量，无需回退提交 |
| 7 | `perf2/rehearsal-obs` `bf2be037` `c31b3aab` `9ae220bd` `5dce92f5` | 彩排观测出网（[loop] / healthz）+ loadgen 应答延迟档 + 冷启动应答窗自适应（首单 7s，答上后回落 3s；不越 prep deadline；externalAI 预留同步）+ 底座补强 | 冷房主（首单 3500 ms）：pooled/accepted 8→0、cancel 8→0、answered 0→8、**CPU 中位 29.5%→7.5%**；暖房主 D=500 两侧 100% 等价无回退 | 确定性不受墙钟影响（同候选集同 index，sim/golden 零改动）；永久不答房主多等 4s（prep deadline 仍提前取消）；worker 池契约未碰 | 观测三件各自 revert；窗口可线上 `SP_BOT_REHEARSAL_COLD_ANSWER_MS=0` 直接回退 |
| 8 | `perf2/render-batch` `5d1cf25a` `c5e9c39c` `29bbd848` `0cf82143` | SpineActor tint 缓存；vfx effect info 静态副本；POSE_SKIP_PX 旋钮（默认 0 关）；perfbench --poseSkip | tint 使 `isSourceEqual` self 2.6/1.5%→0；skip45 时 1x spinePose 23.4→14.6%、view 2.30→2.10 ms，unite 4x 5.18→3.63 ms、boss 4x 6.41→5.22 ms；视觉 diff 1.52/0.76 低于帧间运动量 | 默认 0 关闭 = 官方模式零视觉偏差，交维护者拍板；vendor rgb2hex 补丁与 zones domainField 脏重建留后续 | 各件独立 revert；R1 保持 0 等效关闭 |
| 9 | `perf2/battle-chunk-preload` `04444408` | 首屏 rIC 空闲预热 `import('../render/app.js')`（与 fieldHost.js:263 同说明符），幂等 + rIC 缺失兜底 | Edge 冷缓存 8 轮：app chunk responseEnd 4832→**213 ms**、host 同时提前；206 KB br + 674 KB 解析编译搬出进对局关键路径 | 每个页面提前 206 KB br（含不进对局访客）；rIC 3s 期限可能与标题页素材争带宽；**「进对局到首帧」本机无素材环境 1526→1549 ms 噪声内持平，未证收益** | `git revert 04444408`（删 `arm()` 一行） |
| 10 | `perf2/entry-split` `20a142da` | title 静态留 entry，lobby/room/game 动态化 + idle/hover 预载；boot helper 抽到 screens/helpers.js；测量脚本 `tools/perf2-lcp.mjs`/`perf2-probe.mjs` 入库 | entry raw −46.7% / **br −45.1%**（331,864→182,332）；冷首屏下载 **−22.8%（−101 KB br）**；Edge CDP 4 Mbps/40 ms RTT 下 LCP min 4908→**3912（−20.3%）**、均值 −11%；换屏预热完备 88→83 ms 等价；CSS 零变化 | 落地即点未预热付 0.6–0.73 s 瀑布；modulepreload 5→11，高 RTT 链路需复测；LCP 收益被 entryFilm/异步标题内容稀释；vite 约束全部保持 | `git revert 20a142da` + `npm run build` 重建（产物 git-ignored） |
| 11 | `perf2/film-perf` `5c332067` `8fc280e3` | grain 预生成 8 帧 / 30Hz 轮换（对齐官方录像 30fps）；filter 24 档量化 + 仅变化时写 style | grain 纯 JS 0.3976→0.0019 ms/帧（**~200×**）、Edge 页面级 0.584→0.0245 ms（**~24×**）、puts 192→96；filter 写入 1680→63（**−96.3%**）；时间轴零触碰（transform/opacity 写 49=49） | grain 8 帧轮换真机观感待确认；24 档台阶（最大 0.042，大跳来自原曲线非新增）；filter 的 JS 计时噪声级，真收益在少触发大图层重合成（未测浏览器 frame-time，如实） | 各自 revert；无负收益件 |
| 12 | `perf2/images-budget` | **本轮未产出**：重派代理返回空结果、零 commit、零 A/B 数据 | — | — | 分支干净，可直接删除或留作后续候选（assets.js images Map 无预算的静态证据见侦查报告） |

## 4. 全轮验收

- **golden 291/291 全 match，零场景移动**：每分支各自跑过；汇总阶段在源仓库串行亲跑一次 `npm run golden` 复核（49+46+22+21+10+143，EXIT=0）。preload 报告的「242 场景」系漏抄 roster 49 行，已定案。
- **失败名单与基线逐名一致**：本机无 `public/assets` 抽取，7–8 个素材覆盖断言为环境性；偶发 `test/sim/robustness.test.js` 0.5 ms 门限抖动为跨 worktree 并行跑全量套件时 CPU 争抢所致，串行重跑 35/35 绿——**全量测试必须串行**。
- lint 0 error、typecheck 0、`check:imports` 0、`tools/ci.mjs --only smoke` PASS；build 页 Edge 探针（标题屏挂载、换房不白屏、0 uncaught JS error）。
- `server/sim/` 逐字未改；worker 池真实契约、`test/workers-room.test.js` 锚点保持；协议/安全面（plugins 缓存仅复用已过审体，安全影响无变化）。
- 测量工具与文字报告的归属：可复现工具入库（`tools/perf2-lcp.mjs`、`perf2-probe.mjs`、`tools/loadgen.mjs` 的应答档、`perfbench --poseSkip`）；`docs/perf2-render-batch-report.md` 未 commit（单列，不污染优化提交）。

## 5. 合并顺序与后续

1. 合并顺序（存在 `main.js` 交叠）：**`perf2/entry-split` 先合 → `perf2/battle-chunk-preload` rebase**。其余分支相互独立，一分支一 PR、一行中文提交、无 attribution 尾注。
2. 需要维护者拍板的默认值：`POSE_SKIP_PX`（默认 0 关闭，实测 skip45 收益）；grain 30Hz 前提「官方录像 30fps」若实际 60Hz 需复核。
3. 复测建议（本机边界）：带完整 `public/assets` 的机器复测「进对局到首帧」与 film/filter 的 CDP LayerTree 重合成耗时；真实高 RTT（≥150 ms）链路复测 LCP 与 11 个 modulepreload 的请求数代价。
4. 未做的候选（勿当已完成）：vendor `rgb2hex`/`Color.shared` 补丁、`fx/zones.js` `_updateDomains()` 每帧 `g.clear()` 脏重建、assets.js `images` Map 预算、Cloudflare `v=` 边缘规则（非代码）、协议侧 bonds/effects 数组复用。
5. 事故记录：provider 切换（→ new-provider/hy4free）杀掉全部在飞代理（2× quota、3× server error），但已 commit 的工作不丢——处置一律「先盘点 worktree 再决定续跑/重派」；并发上限经用户指令 3→5→事故后 2→全部继续，额度失败时队列补位、不热重试。
