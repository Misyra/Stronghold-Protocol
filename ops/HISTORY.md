# 集中监控历史保存

监控机器（sp-portal）保存各游戏站的全部脱敏监控采样、每日统计及面板观察到的连通性/采集状态、公告、证书和探针版本。中央库不按天数清理、不把原始采样替换成 5 分钟均值；游戏服只保留有限补传缓存。

## 启用与升级

监控机器使用 Node.js >= 22.13（内置 node:sqlite，无需额外数据库服务）。更新 sp-portal 和游戏仓库 ops/，游戏站重启 sp-collector、sp-admin，监控机器重启 sp-portal。先升级中央端再升级各站也能兼容旧探针，旧探针只保存轮询时取得的采样，不能补回两次轮询之间的原始点。

在监控机器的 /etc/stronghold/portal.env 配置：

```dotenv
PANEL_HISTORY_FILE=/var/lib/sp-portal/monitor-history.sqlite
PANEL_INTERVAL_MS=10000
PANEL_TIMEOUT_MS=5000
# 不设置 PANEL_STALE_MS 时按实际采样/轮询周期自动计算；设置它表示显式覆盖。
```

新版 deploy/sp-portal.service 已包含该数据库默认路径、StateDirectory=sp-portal 与 UMask=0077。既有 unit 可只在 portal.env 设置上述路径；/var/lib/sp-portal 应归 stronghold-portal 用户。自定义到其他目录时，还应在 unit 的 ReadWritePaths 中授权该持久目录。CLI 未设置 PANEL_HISTORY_FILE 时保存到仓库 data/monitor-history.sqlite；演示模式不写历史库。程序化 startPortal 调用通过 historyFile 参数启用。

数据库文件、-wal 与 -shm 留在持久目录，不能放在每次更新被替换的源码包内。此数据目录不会静态公开，历史 API 和下载均沿用面板鉴权。

## 保存内容与恢复

- samples：每次 collector 采样的完整数值指标，包含游戏连接/会话/真人/AI、CPU/IO 等待/PSI、内存、负载、磁盘容量/IO、网络速率、RSS、连接计数、日志积压/处理延迟、采样时的访问统计、容量与诊断。每次采样有独立 sampleId，中央轮询与补传不会重复存储同一点。
- daily：完整每日计数及峰值（含 499 中断、出网峰值），迟到的昨天日志也会更正其归档。样本中的 today 保存当时版本，daily 表提供最新版本。
- observations：面板每轮观察的连通性、错误、各分区状态、公告、证书和探针版本，包括失败轮询。时间为监控机器的观察时间，区别于样本中游戏服采样时间。
- cursors：按站保存的补传进度，与收到的采样在同一 SQLite 事务中提交；中途失败不推进进度，下一轮重试。

历史写入和查询在独立线程执行，SQLite 使用 WAL 与 synchronous=FULL。每站每轮最多补传 4 页，每页最多 200 点；采样文件单次读取最多 1 MiB。大量积压逐轮追赶，避免占满探针或阻塞门户网页。短暂写盘失败时，本地完整采样会暂存在最多最近 25 小时采样数量的内存重试队列，并在磁盘恢复后落盘；超过队列上限会输出明确丢失告警。

游戏站 MON_RETAIN_DAYS 默认 30（可设 1–365），只影响游戏服补传缓存，不影响中央永久保存的数据。中央初次接入会导入尚存的本地采样文件和日归档；旧采样文件仍能导入其原有指标，但过去未采集的字段不会凭空补齐。网络中断超过本地保留期、源文件已经删除或损坏的记录无法补回，面板会显示补传缺口或错误，不能将缺口解释为零。

日志使用完整行字节位点；计数和位点在同一个原子恢复文件提交，再写各日日归档。轮转时先读完旧 inode，再按轮转顺序进入下一文件；重启时按 inode 寻找未压缩的旧日志。使用 nginx rename/reopen 与 delaycompress，保留本站日志和轮转日志的只读权限；需要重启后扫描轮转文件时，日志目录还须可列出文件名。无法找回的轮转文件显示 LOG_ROTATION_GAP。copytruncate 只能识别观察到的文件缩短，不能保证检测两次采样之间的快速截断再增长。

## 查询与导出

站点详情页提供日期筛选、每日归档分页、原始采样 CSV、完整采样 JSONL、状态记录 JSONL。未填日期表示查询/导出全部已保存历史。导出使用有界分页和流式响应，CSV 为 UTF-8，并包含各当前指标列及 data_json 完整元数据列。

鉴权与原面板相同：浏览器 Basic Auth，脚本也可使用 X-Admin-Key。令牌、玩家 IP、连接明细、日志位点及任意上游私有字段不进入中央库；独立访客仅保存 IP 去重后的数量。

```text
GET /api/panel/v1/sites/:id/history?type=samples|observations|daily&limit=1000
GET /api/panel/v1/sites/:id/history/export?type=samples&format=csv
GET /api/panel/v1/sites/:id/history/export?type=samples&format=ndjson
GET /api/panel/v1/sites/:id/history/export?type=observations&format=ndjson
```

samples/observations 的 from、to 为毫秒时间戳或 ISO 时间，端点均包含在区间内；daily 使用 YYYY-MM-DD。limit 为 1–1000。分页响应含 records、nextCursor、hasMore；samples/observations 另含 untilId，继续分页时一并带回，保证读取一个固定的历史快照。样本按入库 id 分页，补传的旧点可能晚入库，分析时应按 t 排序。

原 1h/24h 趋势优先查询中央原始数据，断线或中央进程重启后历史仍可查看；7d 保持每日峰值口径。5 分钟曲线 kind 为 sampled-mixed，aggregation 明确会话取 mean，其余显示指标取 max；原始记录始终保留，不受曲线聚合影响。

## 备份与分析

在线一致性备份（不停止监控，不覆盖已有目标文件）：

```bash
sudo -u stronghold-portal node /opt/stronghold-portal/tools/history-backup.mjs \
  /var/lib/sp-portal/monitor-history.sqlite \
  /var/lib/sp-portal/backups/monitor-2026-10-09.sqlite
```

工具使用 SQLite VACUUM INTO，将已提交的 WAL 数据一起写入独立备份。不要仅复制正在写入的 .sqlite 主文件而遗漏 WAL。可以把一致性备份复制到分析机器，再用 SQLite、Python 或其他工具读取；中央库无自动过期策略，磁盘用量会随时间增长。

例如在备份中按站和日分析原始 CPU：

```sql
SELECT site, date(t / 1000, 'unixepoch', '+8 hours') AS day,
       AVG(json_extract(payload, '$.current.cpu')) AS average_cpu,
       MAX(json_extract(payload, '$.current.cpu')) AS peak_cpu,
       COUNT(*) AS samples
FROM samples
GROUP BY site, day
ORDER BY day, site;
```

t 为采样时间（毫秒），payload 是完整 JSON。此 SQL 示例按 Asia/Shanghai（UTC+8）分日，其他站点统计时区应调整。不要把 NULL 当作零，也不要把日志请求数等累计计数逐采样求和；日总量用 daily 表的最新归档。

Node SQLite 支持：[Node 官方文档](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)。在线备份原理：[SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)。

## 交互诊断字段（2026-10-11）

游戏 /healthz.processDiagnostics 提供独立定时结算的约 15 秒完整窗口，保留最近 8 个。读取不触发 reset。探针将新鲜窗口的事件循环 p99/max 取峰值（约两分钟保持），GC 取最新完整窗口；同时保留 gameDiagEndedAt/windowMs。不能把这些有重叠的窗口或 GC 数值逐采样求和。无新鲜窗口显示 null。

主线程 CPU 以单核 100% 为基准，其他线程 CPU 可大于 100%。首次采集、PID/线程 starttime 变化、时钟 tick 无法获取或 /proc 不可读时速率为 null。TCP 基础计数来自 /proc/net/snmp，扩展来自 /proc/net/netstat；接收错误/丢弃按包增量比例。重传累计量回退不产生峰值。最高三个线程只保留名称和占比，不上报 tid。

nginx 可在完整 combined 前缀之后追加 rt=$request_time urt=$upstream_response_time cache=$upstream_cache_status host=$host（格式定义必须在 http 级）。旧格式仍统计请求，但延迟为未知。延迟采用固定桶直方图上界，排除 WS 连接生存时长。http* 计数表示本轮处理的日志行，日志积压时不能当成最近 15 秒真实请求量；缺日志时为 null。中央 five-minute series 取这些采集轮次的峰值，不伪称一分钟请求率。

新增字段经白名单清洗后落入样本及补传，中央 SQLite 与探针聚合均保留诊断峰值。daily 增加事件循环 p99 和主线程 CPU 峰值，旧历史缺失不补零。CSV 在第一条旧记录也预声明新诊断列；JSONL 保留完整脱敏结构。worker 排队毫秒及 persist failures 为累计值；累计均值并非本轮时延。

门户前端和 ops 前端由同一个文件内容构建版本标识；服务启动时固定这份前端，部署后重启门户。代码变化会更新版本，mtime 不参与。旧页面只提示刷新，不自动打断管理编辑；CSP policyVersion 继续独立反映站点来源变化。独立 classic 启动脚本可报告主模块加载错误/可见页面启动超时。

## 本地告警（2026-10-11）

中央在成功采到新样本后判断阈值，API 读取不推进告警。主线程 CPU、排队、背压、TCP 重传和 GC 占比需持续约 60 秒，严重事件循环延迟即时触发；恢复需要 30 秒健康新样本。GC/loop 规则只用最新完整窗口，避免把保留窗口峰值误当持续异常。陈旧、缺失、时钟回退和长采样空档不累计持续时间；已经触发的规则暂停判断，不伪报恢复。存档累计失败只按新增失败触发，启动基线与重启回退不产生告警。

面板概览显示活动告警及最近事件，内存最多保留 100 条，门户重启重新建立基线；当前不发送外部通知、不持久化告警历史。`PANEL_EXPECTED_OPS_VERSION` 可设置期望探针版本，不设置则不判断版本不一致。证书规则判断探针提供的源站证书；缺少证书数据不推断为安全。请求失败同时保留原处理轮次指标，并新增完整分钟指标；每分钟 5xx >20 或 499 >50 使用分钟结束时间去重。

容量仍按 sockets，可通过站点管理配置；真实容量需根据线上基线测量，不按核数自动改写。

## 请求分钟桶

`httpMinute*` 根据 nginx 日志事件时间计算，`httpMinuteStartedAt/EndedAt` 明确分钟区间。首次运行的半分钟、日志缺失、不可解析、轮转缺口以及尚未追平的积压均不输出完整分钟值；等日志 flush 的 10 秒宽限后才结算。完整但没有请求的分钟计数为 0、没有耗时样本时分位数为 null。不会把 WS 连接生存时长计入请求耗时。

分钟桶与已消费日志游标写入同一个原子恢复帧。进程内最多保留约 180 分钟；补读和迟到修正通过有界 `requestMinuteWindows` 传输，以站点+分钟在中央 SQLite 独立存储，按采样版本覆盖，重复补传不累加，旧补传不能覆盖新修正。曲线按原分钟所在的五分钟桶取峰值，不按处理时间落点。超出保留时长的日志仍计入每日统计，但不承诺补齐分钟曲线。

没有日志访问时间也能统计状态码；若原日志未带 rt/urt，则分钟延迟为 null。没有用用户 IP 或任意路径作为分钟维度，清单/房间属于固定分类。门户随机加入在错误响应中输出受控的 X-Portal-Reason，nginx 日志追加 reason=$upstream_http_x_portal_reason 后可分别计数繁忙、上游不可用、候选预算耗尽和超时；没有新字段的旧日志仍为未分类，不能由 503 猜测业务原因。

`cpuStealPct` 来自 /proc/stat 的 steal 增量，表示虚拟 CPU 被宿主调度去执行其他工作的时间比例。Windows、首个样本或计数回退为 null；现有 cpu 口径保持不变（包含 steal，不应将两者相加）。该指标可作为宿主竞争的证据，但 0 不足以排除所有云侧性能问题。持续超过 5% 在面板提示，生产阈值仍需基线校准。
