# 文档导航

从根目录的 [README](../README.md) 开始运行项目；参与修改前阅读 [贡献指南](../CONTRIBUTING.md)。本目录按读者和用途分组。

## 玩法与内容包：`guides/`

| 文档 | 内容 |
|---|---|
| [玩法指南](guides/PLAYING.md) | 游戏流程、规则、操作与快捷键 |
| [内容包](guides/PACKS.md) | 安装和制作干员、语言等扩展内容 |
| [对局记录](guides/MATCH_HISTORY.md) | 战绩存储、导出与展示 |
| [匹配机制](guides/MATCHMAKING.md) | 四人匹配和组队流程 |

## 部署与运维：`operations/`

| 文档 | 内容 |
|---|---|
| [部署指南](operations/DEPLOY.md) | 开服、反向代理、Docker 与排错 |
| [Windows 便携包](operations/WINDOWS.md) | 制作与使用便携包 |
| [CDN 与资源更新](operations/CDN.md) | 静态资源分发、预载与缓存 |
| [对局持久化](operations/PERSISTENCE.md) | 检查点、索引、运行时钟与恢复 |

## 开发参考：`development/`

| 文档 | 内容 |
|---|---|
| [架构与代码地图](development/ARCHITECTURE.md) | 目录分工、数据流与常见修改入口 |
| [设计与契约索引](development/DESIGN.md) | 按章节号查找设计规则 |
| [战斗模拟](development/SIM.md) | 模拟引擎、钩子与技能格式 |
| [对局与经济](development/META.md) | 回合、商店、联防与最终攻势 |
| [游戏数据](development/DATA.md) | 数据构建与来源 |
| [素材](development/ASSETS.md) | 素材来源、清单与目录 |
| [国际化](development/I18N.md) | 翻译、语言文件与覆盖范围 |
| [性能](development/PERFORMANCE.md) | Worker 池、预载与性能优化 |
| [难度与平衡](development/BALANCE.md) | 难度模型和测量 |
| [本分支 API](development/CUSTOM_API.md) | 房间查询、匹配与扩展接口 |

## 设计章节、历史与调研

- `design/`：现行设计章节，由[设计索引](development/DESIGN.md)导航。
- `history/`：各版本的设计修订；[本分支站点更新记录](history/site/CHANGELOG.md)单独放在 `history/site/`。
- [项目版本更新记录](../CHANGELOG.md)：根目录保留的正式更新记录。
- [调研索引](research/00-INDEX.md)：`research/` 中的规则调研和研究数据。
- `img/`：文档图片。

`research/*.json` 中部分表会被服务器和素材工具读取，请按数据文件维护，不作为临时文件清理。

## 本地文件放在哪里

临时脚本、分析结果和下载缓存统一放入 Git 忽略的 `.cache/`：日志用 `.cache/logs/`，临时冒烟脚本用 `.cache/smoke/`，检查报告用 `.cache/reports/`。可复用的正式工具放入 `tools/`，自动化测试放入 `test/`，启动与部署脚本放入 `scripts/`。

根目录保留项目入口、构建配置、许可证和部署配置。`.state/` 是实际对局存档，`announcement.json` 是本机维护公告；本地 `AGENTS.md` 是仓库工作说明，均应按各自用途保留。
