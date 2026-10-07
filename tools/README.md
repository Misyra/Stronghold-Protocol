# 工具目录

本目录放可复用的命令行工具。命令从仓库根目录运行；临时实验脚本、日志和报告放入 `.cache/`，具体约定见[文档导航](../docs/README.md#本地文件放在哪里)。

| 用途 | 入口 | 说明 |
|---|---|---|
| 安装与检查 | `npm run setup`、`npm run doctor` | 素材准备、依赖和运行环境诊断 |
| 客户端依赖与素材 | `vendor.mjs`、`fetch-assets.mjs`、`assets/`、`local-extract/` | 下载、清单与本地客户端提取；见[素材说明](../docs/development/ASSETS.md) |
| 数据与翻译 | `build-data.mjs`、`build-emotes.mjs`、`build-i18n.mjs`、`i18n.mjs` | 从数据表生成游戏数据、表情和多语言内容 |
| 内容包 | `packs.mjs` | 内容包校验与索引；见[内容包指南](../docs/guides/PACKS.md) |
| 代码检查与回归 | `check-imports.mjs`、`kit-coverage.mjs`、`golden.mjs` | 导入边界、技能覆盖和黄金结果 |
| 对局与性能分析 | `simrun.mjs`、`matchrun.mjs`、`record-battle.mjs`、`balance.mjs`、`botbench.mjs`、`workerbench.mjs`、`memorybench.mjs` | 模拟、录像、平衡与性能测量；见[难度说明](../docs/development/BALANCE.md)和[性能说明](../docs/development/PERFORMANCE.md) |
| 持久化验证 | `persist-sim.mjs` | 写入量、恢复和故障测试；见[持久化说明](../docs/operations/PERSISTENCE.md) |
| 发布与 CDN | `package.mjs`、`r2-sync.mjs`、`asset-hashes.mjs` | 发布包构建、资源上传和哈希；见[部署指南](../docs/operations/DEPLOY.md)和[CDN 说明](../docs/operations/CDN.md) |

各工具的参数和示例见文件头部；启动与服务安装脚本在 [`scripts/`](../scripts/README.md)。
