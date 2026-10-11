# Agent 与 nginx 示例复查（2026-10-11）

## 探针更新状态

门户 `deploy/sync-agent.mjs --check` 通过，游戏 `ops/` 与门户探针源码一致，当前内容版本 `sp-ops-8b6a48451657`。新增采集和过滤逻辑主要在 collector 与共享库，不能只覆盖 `agent.mjs`。应更新完整 ops/，保留运行实例自己的 env、公告目录和历史目录，重启 sp-collector、sp-admin；中央门户也须更新并重启，才能识别新字段。

先核对 systemd 实际 WorkingDirectory/ExecStart 指向哪个检出。独立 `/opt/stronghold-ops` 部署不会因另一个游戏目录 git pull 自动更新。安装器回归验证旧配置、令牌和数据目录保留；日常源码更新无需重新安装 unit。游戏进程新增 loop/GC 区间窗口需在正常发布时重启游戏才生效。

Agent 保持回环监听、Bearer RO/RW 权限区分、无 CORS、无共享缓存。新指标经白名单转发，历史补传保留原采样时刻；私有 IP/任意字段被清除。缺失、旧探针或不支持的 Linux 指标显示 null，而非 0。公告写能力仍取决于各站 RW 密钥、文件路径及权限，未替线上配置。

## 本轮 nginx 修正

- 主示例取消 `/healthz` 的旧 5 秒共享缓存，避免监控旧样本和短暂错误被掩盖。`?build=1` 与完整 health 均直接回源。
- 主示例接入 http 级计时日志格式，并在目标站点使用 sp_game；格式需只 include 一次。按本站实际日志路径安装，保留轮转和 spmonitor 读权限。
- 共享缓存路径显式开启响应缓冲，避免继承已有 WebSocket 配置中的 buffering off。
- `/_v/` 缓存键增加分隔符、端口和上游隔离，改用新命名空间，只缓存 200；不剥版本前缀、不 alias 私有 sim 文件。
- 更正 Range 说明：可以从完整缓存响应切片，不应单独缓存 206。

## 清单缓存口径

| 地址 | nginx TTL | 浏览器与错误行为 |
| --- | --- | --- |
| `/data/resource-manifest.json?v=<当前 release>` | Node X-Accel-Expires 控制 12 小时 | no-cache/ETag 复验；query 参与 key |
| 裸 resource-manifest | 15 秒 | 兼容旧客户端；过期后源站失败不回退旧清单 |
| `/assets-manifest.json?v=<当前素材 tag>` | 30 天 | 保留 immutable；错误参数 404 不缓存 |
| `/api/announcement` | 30 秒 | 过期后源站失败不回退旧公告 |

保留上游 Vary 编码分桶、缓存锁、HEAD 复用 GET、Cache-Control/Expires 忽略与 X-Accel-Expires 生效。共享缓存减少回源；客户端重复正文下载是否降低，仍须验证 SW 与 HTTP 缓存。

## 本地验证与线上边界

使用官方 nginx 1.26.3 Windows 便携版，在临时目录、随机回环端口运行实际主配置和片段（仅替换 TLS、路径、端口以适配本地环境）。未修改任何主机服务或真实凭据。

测试命令：`NGINX_PATH=<nginx 可执行文件> node --test test/nginx-cache.integration.test.mjs`。

覆盖 nginx -t、清单 MISS/HIT、ETag 304、HEAD、Host/query/gzip 隔离、并发填充锁、错误不缓存、过期不回退、版本静态缓存、Range、实时 health、真实 Agent 经 nginx 鉴权及指标/历史脱敏转发、计时与业务原因日志。短 TTL 过期场景由测试上游 X-Accel-Expires 缩短，不改变示例生产 TTL。

仍需每台主机对实际配置执行 nginx -t，再 reload，并确认缓存目录/日志目录权限、容器挂载、探针运行路径及线上命中；本机验证不能替代各站实际环境验收。
