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
