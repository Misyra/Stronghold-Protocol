# 工具目录

本目录放可复用的命令行工具。命令从仓库根目录运行；临时实验脚本、日志和报告放入 `.cache/`，具体约定见[文档导航](../docs/README.md#本地文件放在哪里)。

| 用途 | 入口 | 说明 |
|---|---|---|
| 安装与检查 | `npm run setup`、`npm run doctor` | 素材准备、依赖和运行环境诊断 |
| 客户端依赖与素材 | `vendor.mjs`、`fetch-assets.mjs`、`fetch-stats-assets.mjs`、`install-skins.mjs`、`prepare-operator-voices.mjs`、`assets/`、`local-extract/` | 下载、清单与本地客户端提取；`fetch-stats-assets.mjs`（0.3.0）只补官方统计插画、保留既有清单条目；`install-skins.mjs` 按需装一套干员皮肤（约 1 MB，装在开服那台机器上），见[外观说明](../docs/OPERATOR-SKINS.md)与[素材说明](../docs/ASSETS.md) |
| 数据与翻译 | `build-data.mjs`、`build-emotes.mjs`、`build-i18n.mjs`、`i18n.mjs` | 从数据表生成游戏数据、表情和多语言内容（皮肤目录是代码模块 `shared/skin-catalogue.js`，没有构建步骤） |
| 构建体积 | `build-size.mjs` | 只读 Vite 构建模块体积报告：首屏、懒加载与合计（原始/gzip）；需先 `npm run build` |
| 内容包 | `packs.mjs` | 内容包校验与索引；见[内容包指南](../docs/PACKS.md) |
| 插件（0.3.0） | `plugin.mjs`、`records-schema.mjs` | 列出、校验与打包 `plugins/` 下的插件与语言包；从运行时 `RECORDS_SCHEMA` 生成 `schemas/records.schema.json`；见[插件指南](../docs/PLUGINS.md) |
| 代码检查与回归 | `check-fork-boundaries.mjs`、`check-imports.mjs`（旧入口）、`kit-coverage.mjs`、`golden.mjs`、`vfx-skill-coverage.mjs` | 导入边界、技能覆盖、官方特效覆盖率（`vfx-skill-coverage.mjs`，0.3.0）和黄金结果 |
| 对局与性能分析 | `simrun.mjs`、`matchrun.mjs`、`record-battle.mjs`、`balance.mjs`、`botbench.mjs`、`workerbench.mjs`、`match-workerbench.mjs`、`memorybench.mjs` | 模拟、录像、平衡与性能测量；见[难度说明](../docs/BALANCE.md)和[性能说明](../custom_docs/development/PERFORMANCE.md) |
| 网络与健康检查性能 | `healthbench.mjs`、`bench-cooperative.mjs`、`bench-state-delta.mjs`、`wsbench.mjs`、`server-hotpathsbench.mjs` | 健康统计成本、真实 Bot 并发时的 WebSocket RTT、增量广播成本；见[延迟测试](../custom_docs/development/LATENCY.md)和[增量压测](../custom_docs/development/STATE_SYNC_BENCHMARK.md) |
| 状态同步链路 | `state-sync-micro.mjs`、`state-sync-bench.mjs` | 分段归因（视图构建/去重编码/解析/差分/检查点）与端到端负载（主线程 CPU、事件循环延迟、GC、检查点与落盘）对照；`--idle-rooms` 混入没有连接的对局房间（检查点唯一的"没变化"来源）；三个不变量逐帧核账。见[同步链路基线](../custom_docs/development/STATE_SYNC_BENCHMARK.md) |
| 持久化验证 | `persist-sim.mjs`、`persistbench.mjs`、`seed-state-to-redis.mjs` | 写入量、恢复和故障测试；`persistbench.mjs` 量检查点 / 落盘的耗时分布；`seed-state-to-redis.mjs` 在停机时把文件后端存档一次性灌进 Redis；见[持久化说明](../custom_docs/operations/PERSISTENCE.md) |
| 发布与 CDN | `package.mjs`、`r2-sync.mjs`、`r2-s3-upload.mjs`、`asset-hashes.mjs`、`build-assets-manifest.mjs` | 发布包构建、资源上传和哈希；`build-assets-manifest.mjs` 按本机素材重新生成 `.assets-manifest.json`（清单不入库），`r2-s3-upload.mjs` 用 S3 SigV4 上传、不经过 wrangler；见[部署指南](../custom_docs/operations/DEPLOY.md)和[CDN 说明](../custom_docs/operations/CDN.md) |
| 内核封禁名单 | `net-ban.mjs` | 把 `server/netBlock.js` 的逐条 IP 渲染成 nft 名单（`ops/blocked-ipv4.txt` / `blocked-ipv6.txt`）；`--check` 检测名单漂移，见[内核封禁](../ops/README.md) |
| 地址粗分类 | `geoip-classify.mjs`、`fetch-geoip.mjs` | 用 GeoLite2-ASN 把地址分三桶（cloud / isp / unknown）：直接查若干 IP，或 `--sample N` 看桶分布与命中的机房 ASN；`fetch-geoip.mjs` 首次启动/构建时下载 `geoip/GeoLite2-Country.mmdb`（数据库不入库）；规则、精度与边界见[机房来源分级](../custom_docs/operations/IDC_PROTECTION.md) |
| 辅助入口与内部模块 | `browser-test-setup.mjs`、`capture-specs.mjs`、`ci.mjs`、`crop-board-atlas.mjs`、`doctor.mjs`、`encrypt-lexicon.mjs`、`package-update.mjs`、`perfbench.mjs`、`published-assets.mjs`、`setup.mjs`、`sim-check.mjs`、`state-pressure-bench.mjs` | 参数见对应文件头；浏览器测试设置、发布元数据和诊断辅助。 |

各工具的参数和示例见文件头部；启动与服务安装脚本在 [`scripts/`](../scripts/README.md)。
