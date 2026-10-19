# 本分支文档索引

总导航在 [docs/README.md](../docs/README.md)：那里按来源分两棵树，`docs/` 是上游的、`custom_docs/` 是本分支的，同一主题两边都有时以本分支为准。这个文件只负责 `custom_docs/` 内部的目录约定。

## 目录约定

| 目录 | 放什么 | 谁来写 |
|---|---|---|
| `operations/` | 线上运维：部署、防护、监控、发布、持久化。默认是可执行的操作步骤与已验证的边界 | 改服务器之前、之后 |
| `development/` | 本分支为什么和上游不一样：API、合并记录、测试流程、性能与测量 | 改代码时 |
| `guides/` | 玩法向说明（战绩、匹配），给服主看 | 功能变化时 |
| `history/site/` | 本站已发布版本的更新日志 | 每次发版 |
| `archive/` | 已经结清的东西：完成的审查、过期的一次性计划、历史任务清单 | 只追加，不改写 |
| `screenshots/` | 文档里引用的截图 | 换界面时 |

`archive/` 里按性质分子目录：`reviews/`（审查与整改记录）、`plans/`（一次性计划、任务清单、验收表）。归档文件保留当时的结论和日期，不再跟着代码更新；里面的路径与提交号属于当时的事实，不要为了让它们"看起来还是最新的"而改写。

## 运维（operations/）

| 文档 | 内容 |
|---|---|
| [DEPLOY.md](operations/DEPLOY.md) | 部署总入口：Linux / Docker、统一配置、更新与验收 |
| [HOME_SERVER.md](operations/HOME_SERVER.md) | Windows 与家用开服：自启、整合包更新、家用网络 |
| [ANNOUNCEMENTS.md](operations/ANNOUNCEMENTS.md) | 游戏内公告：中央源、站点 ID、显式本地模式 |
| [MONITORING.md](operations/MONITORING.md) | 监控探针与管理面板的分工、接入与版本同步 |
| [PACKAGING.md](operations/PACKAGING.md) | 维护者制作完整包、精简包与更新包 |
| [PERSISTENCE.md](operations/PERSISTENCE.md) | 对局持久化：检查点、索引、运行时钟与恢复 |
| [CDN.md](operations/CDN.md) | 素材 CDN：分发、预载、缓存与版本化 |
| [PORTAL_ROOMS.md](operations/PORTAL_ROOMS.md) | 同盟房间一键收录与两端鉴权 |
| [ONLINE-CHECKLIST.md](operations/ONLINE-CHECKLIST.md) | 三台主机的线上核查清单 |

### 防护

| 文档 | 内容 |
|---|---|
| [HTTP_PROTECTION.md](operations/HTTP_PROTECTION.md) | 公开接口限流、持久封禁名单、Nginx 缓存前鉴权 |
| [WS_PROTECTION.md](operations/WS_PROTECTION.md) | WebSocket 升级尝试计数、Origin 校验与入口 jail |
| [BROWSER_GATE.md](operations/BROWSER_GATE.md) | 自动浏览器入口验证：回环服务 + `auth_request` + 签名 Cookie |
| [ROOM_PROTECTION.md](operations/ROOM_PROTECTION.md) | 房间审计与计算保护：网络额度、无人暂停、降级 |
| [HOST_HARDENING.md](operations/HOST_HARDENING.md) | 主机加固：关闭公开探测、防火墙、fail2ban、日志轮转、巡检 |
| [IDC_PROTECTION.md](operations/IDC_PROTECTION.md) | 机房来源分级：ASN 名单的可行性、证据与封不住的边界 |
| [INCIDENT-2026-10-17.md](operations/INCIDENT-2026-10-17.md) | 事故记录：防护默认值的来龙去脉 |

运维文档里不写真实主机地址与端口，需要指代时用 `<节点地址>:<端口>`。真实地址写在服务器上的私有备注里，不进仓库。

## 开发（development/）

| 文档 | 内容 |
|---|---|
| [FORK_MAINTENANCE.md](development/FORK_MAINTENANCE.md) | 维护边界：模块归属、合并流程、冲突处理与推迟清单 |
| [CUSTOM_API.md](development/CUSTOM_API.md) | 本分支服务端 API：房间查询、匹配与扩展接口 |
| [TEST_WORKFLOW.md](development/TEST_WORKFLOW.md) | 三个测试入口、已知常年红的用例、各套基线 |
| [MODEL-RECOVERY.md](development/MODEL-RECOVERY.md) | 模型消失问题：结论与回归覆盖 |
| [PERFORMANCE.md](development/PERFORMANCE.md) | Worker 池、预载与性能优化 |
| [LATENCY.md](development/LATENCY.md) | 健康检查、网络诊断与多房间调度 |
| [STATE_DELTA.md](development/STATE_DELTA.md) | WebSocket 状态增量传输 |
| [STATE_SYNC_BENCHMARK.md](development/STATE_SYNC_BENCHMARK.md) | 状态同步链路基线与优先级验证 |
| [STATE_DELTA_BENCHMARK.md](development/STATE_DELTA_BENCHMARK.md) | 增量传输的本地对照测试 |
| [MOBILE_UI.md](development/MOBILE_UI.md) | 管理界面移动端密度 |

### 上游合并记录

合并记录留着是因为它们是"代码为什么长这样"的依据，上游文件与 `shared/` 的注释直接指向它们。

| 文档 | 内容 |
|---|---|
| [MERGE_0.2.6.md](development/MERGE_0.2.6.md) | v0.2.6 合并执行方案（素材地址与 seams 的决定） |
| [MERGE_0.3.0.md](development/MERGE_0.3.0.md) | v0.3.0 合并记录 |
| [MERGE_0.3.1.md](development/MERGE_0.3.1.md) | v0.3.1 合并记录：四个交互特性 |

## 玩法（guides/）

| 文档 | 内容 |
|---|---|
| [MATCH_HISTORY.md](guides/MATCH_HISTORY.md) | 本机对局统计与记录：存储、导出与展示 |
| [MATCHMAKING.md](guides/MATCHMAKING.md) | 同站同盟匹配与组队流程 |

## 站点更新记录（history/site/）

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](history/site/CHANGELOG.md) | 本站更新记录 |
| [0.3.0-release.md](history/site/0.3.0-release.md) | 0.3.0 发布说明 |

## 归档（archive/）

| 文档 | 为什么归档 |
|---|---|
| [CODE_REVIEW_2026-10.md](archive/reviews/CODE_REVIEW_2026-10.md) | 对 `cf7a9400` 的整轮审查，P0–P3 已按记录整改 |
| [CODE_REVIEW_REFACTOR_2026-10.md](archive/reviews/CODE_REVIEW_REFACTOR_2026-10.md) | 上面那份审查的整改记录，改动已落地 |
| [NGINX-AGENT-REVIEW.md](archive/reviews/NGINX-AGENT-REVIEW.md) | 2026-10-11 的探针与 Nginx 示例复查，结论已并入运维文档 |
| [OPTIMIZATION-ROLLOUT.md](archive/plans/OPTIMIZATION-ROLLOUT.md) | 一次性部署验收表，逐站核验未执行 |
| [MERGE_0.3.1_EFFECTS_TASKS.md](archive/plans/MERGE_0.3.1_EFFECTS_TASKS.md) | 0.3.1 特效层交接任务清单，任务已合并 |

## 不放进来的东西

- 一次性的复现脚本、截图、抓包与日志：放 Git 忽略的 `.cache/` 或 `.local/`，不进本树。
- 含真实主机地址、端口、SSH 用户与密钥路径的现场备注：只留在服务器与本机私有目录。
- 上游已有的文档：合并时按原路径更新 `docs/`，不在 `custom_docs/` 复制一份。
