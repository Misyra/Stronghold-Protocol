# 工具目录

本目录放可复用的命令行工具。命令从仓库根目录运行；临时实验脚本、日志和报告放入 `.cache/`，具体约定见[文档导航](../docs/README.md#本地文件放在哪里)。

| 用途 | 入口 | 说明 |
|---|---|---|
| 安装与检查 | `npm run setup`、`npm run doctor` | 素材准备、依赖和运行环境诊断 |
| 客户端依赖与素材 | `vendor.mjs`、`fetch-assets.mjs`、`assets/`、`local-extract/` | 下载、清单与本地客户端提取；见[素材说明](../docs/development/ASSETS.md) |
| 数据与翻译 | `build-data.mjs`、`build-emotes.mjs`、`build-i18n.mjs`、`i18n.mjs` | 从数据表生成游戏数据、表情和多语言内容 |
| 构建体积 | `build-size.mjs` | 只读 Vite 构建模块体积报告：首屏、懒加载与合计（原始/gzip）；需先 `npm run build` |
| 内容包 | `packs.mjs` | 内容包校验与索引；见[内容包指南](../docs/guides/PACKS.md) |
| 代码检查与回归 | `check-fork-boundaries.mjs`、`check-imports.mjs`（旧入口）、`kit-coverage.mjs`、`golden.mjs` | 导入边界、技能覆盖和黄金结果 |
| 对局与性能分析 | `simrun.mjs`、`matchrun.mjs`、`record-battle.mjs`、`balance.mjs`、`botbench.mjs`、`workerbench.mjs`、`memorybench.mjs` | 模拟、录像、平衡与性能测量；见[难度说明](../docs/development/BALANCE.md)和[性能说明](../docs/development/PERFORMANCE.md) |
| 网络与健康检查性能 | `healthbench.mjs`、`bench-cooperative.mjs`、`bench-state-delta.mjs` | 健康统计成本、真实 Bot 并发时的 WebSocket RTT、增量广播成本；见[延迟测试](../docs/development/LATENCY.md)和[增量测试](../docs/development/STATE_DELTA_BENCHMARK.md) |
| 状态同步链路 | `state-sync-micro.mjs`、`state-sync-bench.mjs` | 分段归因（视图构建/去重编码/解析/差分/检查点）与端到端负载（主线程 CPU、事件循环延迟、GC、检查点与落盘）对照；`--idle-rooms` 混入没有连接的对局房间（检查点唯一的"没变化"来源）；三个不变量逐帧核账。见[同步链路基线](../docs/development/STATE_SYNC_BENCHMARK.md) |
| 持久化验证 | `persist-sim.mjs` | 写入量、恢复和故障测试；见[持久化说明](../docs/operations/PERSISTENCE.md) |
| 发布与 CDN | `package.mjs`、`r2-sync.mjs`、`asset-hashes.mjs` | 发布包构建、资源上传和哈希；见[部署指南](../docs/operations/DEPLOY.md)和[CDN 说明](../docs/operations/CDN.md) |
| 辅助入口与内部模块 | `browser-test-setup.mjs`、`capture-specs.mjs`、`ci.mjs`、`crop-board-atlas.mjs`、`doctor.mjs`、`encrypt-lexicon.mjs`、`package-update.mjs`、`perfbench.mjs`、`published-assets.mjs`、`setup.mjs`、`sim-check.mjs`、`state-pressure-bench.mjs` | 参数见对应文件头；浏览器测试设置、发布元数据和诊断辅助。 |

各工具的参数和示例见文件头部；启动与服务安装脚本在 [`scripts/`](../scripts/README.md)。
