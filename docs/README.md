# 文档导航

从根目录的 [README](../README.md) 开始运行项目；参与修改前阅读 [贡献指南](../CONTRIBUTING.md)。

文档分成两棵树，按来源而不是按主题分：

- **`docs/` 是上游文档**（sganggs/Stronghold-Protocol）。合并上游时这些文件按原路径更新，别在这里写本分支独有的内容。
- **`custom_docs/` 是本分支自己的文档**（皮肤、运维、加固、发布、本分支 API 与合并记录）。上游没有同路径文件，所以合并永远不会撞车。

同一个主题两边都有时以 `custom_docs/` 为准：例如部署以[custom_docs 的部署指南](../custom_docs/operations/DEPLOY.md)为准，`docs/DEPLOY.md` 只是上游原样保留的那一份。

## 玩法与内容包

| 文档 | 位置 | 内容 |
|---|---|---|
| [玩法指南](PLAYING.md) | 上游 | 游戏流程、规则、操作与快捷键 |
| [内容包](PACKS.md) | 上游 | 安装和制作干员、语言等扩展内容 |
| [对局记录](../custom_docs/guides/MATCH_HISTORY.md) | 本分支 | 战绩存储、导出与展示 |
| [匹配机制](../custom_docs/guides/MATCHMAKING.md) | 本分支 | 四人匹配和组队流程 |

## 部署与运维

| 文档 | 位置 | 内容 |
|---|---|---|
| [部署指南（总入口）](../custom_docs/operations/DEPLOY.md) | 本分支 | Linux / Docker、统一配置、更新与验收 |
| [Windows 与家用开服](../custom_docs/operations/HOME_SERVER.md) | 本分支 | Windows 自启、整合包更新与家用网络 |
| [游戏内公告](../custom_docs/operations/ANNOUNCEMENTS.md) | 本分支 | 默认中央源、站点 ID、显式本地模式与排错 |
| [监控接入](../custom_docs/operations/MONITORING.md) | 本分支 | 游戏、探针、中央面板的分工与接入 |
| [房间审计与保护](../custom_docs/operations/ROOM_PROTECTION.md) | 本分支 | 网络额度、无人暂停、计算降级和私有查询 |
| [公开接口限流与永久封禁](../custom_docs/operations/HTTP_PROTECTION.md) | 本分支 | API 请求频率、持久封禁名单与 Nginx 缓存前鉴权 |
| [WebSocket 升级防护](../custom_docs/operations/WS_PROTECTION.md) | 本分支 | 升级尝试计数、Origin 校验与入口 jail |
| [自动浏览器入口验证](../custom_docs/operations/BROWSER_GATE.md) | 本分支 | 回环服务 + `auth_request`，签名 Cookie 准入 |
| [Linux 主机加固](../custom_docs/operations/HOST_HARDENING.md) | 本分支 | 关闭公开探测、主机防火墙、fail2ban、日志轮转与每日巡检 |
| [2026-10-17 事故记录](../custom_docs/operations/INCIDENT-2026-10-17.md) | 本分支 | 防护默认值的来龙去脉与线上边界 |
| [国家库（GeoLite）](../geoip/README.md) | 本分支 | 海外识别用的 Country 库：来源、许可、放置位置与更新 |
| [发行包制作](../custom_docs/operations/PACKAGING.md) | 本分支 | 维护者制作完整、精简与更新包 |
| [Windows 便携包](WINDOWS.md) | 上游 | 制作与使用便携包 |
| [CDN 与资源更新](../custom_docs/operations/CDN.md) | 本分支 | 静态资源分发、预载与缓存 |
| [对局持久化](../custom_docs/operations/PERSISTENCE.md) | 本分支 | 检查点、索引、运行时钟与恢复 |

## 开发参考

| 文档 | 位置 | 内容 |
|---|---|---|
| [架构与代码地图](ARCHITECTURE.md) | 上游 | 目录分工、数据流与常见修改入口 |
| [设计与契约索引](DESIGN.md) | 上游 | 按章节号查找设计规则 |
| [战斗模拟](SIM.md) | 上游 | 模拟引擎、钩子与技能格式 |
| [对局与经济](META.md) | 上游 | 回合、商店、联防与最终攻势 |
| [游戏数据](DATA.md) | 上游 | 数据构建与来源 |
| [素材](ASSETS.md) | 上游 | 素材来源、清单与目录 |
| [国际化](I18N.md) | 上游 | 翻译、语言文件与覆盖范围 |
| [插件系统](PLUGINS.md) | 上游 | 清单、权限、覆盖与目录 |
| [难度与平衡](BALANCE.md) | 上游 | 难度模型和测量 |
| [干员外观](OPERATOR-SKINS.md) | 上游 + 本分支 | 时装目录、`room.skins { choices }`、预载与战斗模型 |
| [干员皮肤（插件叠加）](SKINS.md) | 上游 | 外观插件的 overlay schema 与显示规则 |
| [性能](../custom_docs/development/PERFORMANCE.md) | 本分支 | Worker 池、预载与性能优化 |
| [状态同步链路基线](../custom_docs/development/STATE_SYNC_BENCHMARK.md) | 本分支 | 视图构建/差分/检查点的分段成本与端到端对照,以及计划三条优先级的实测判定(配套[增量传输](../custom_docs/development/STATE_DELTA.md)、[增量压测](../custom_docs/development/STATE_DELTA_BENCHMARK.md)) |
| [管理界面移动端密度](../custom_docs/development/MOBILE_UI.md) | 本分支 | 非战场管理界面的紧凑层、变量契约与真机验证边界 |
| [本分支 API](../custom_docs/development/CUSTOM_API.md) | 本分支 | 房间查询、匹配与扩展接口 |
| [上游合并记录](../custom_docs/development/FORK_MAINTENANCE.md) | 本分支 | 合并流程、冲突处理与推迟清单 |

## 设计章节、历史与调研

- `docs/design/`：现行设计章节，由[设计索引](DESIGN.md)导航（含本分支那份门户代理草稿，它排在 §34 之后）。
- `docs/history/`：各版本的设计修订。
- [本分支站点更新记录](../custom_docs/history/site/CHANGELOG.md)：本分支自己发布过的东西。
- [项目版本更新记录](../CHANGELOG.md)：根目录保留的正式更新记录。
- [调研索引](research/00-INDEX.md)：`docs/research/` 中的规则调研和研究数据。
- `docs/img/`：文档图片。

`docs/research/*.json` 中部分表会被服务器和素材工具读取，请按数据文件维护，不作为临时文件清理。

## 本地文件放在哪里

临时脚本、分析结果和下载缓存统一放入 Git 忽略的 `.cache/`：日志用 `.cache/logs/`，临时冒烟脚本用 `.cache/smoke/`，检查报告用 `.cache/reports/`。可复用的正式工具放入 `tools/`，自动化测试放入 `test/`，启动与部署脚本放入 `scripts/`。

根目录保留项目入口、构建配置、许可证和部署配置。`.state/` 是实际对局存档，`announcement.json` 仅在显式文件模式下作为本机维护公告；本地 `AGENTS.md` 是仓库工作说明，均应按各自用途保留。
