# 三台主机线上核查清单

目的：先取线上基线，确认本地修复是否已经部署，再验收。当前本轮代码尚未提交、推送或部署；旧服务缺少新增字段不算新代码故障。不要为了核查执行拉代码、重启、清缓存、改密钥或删除旧目录。

每台记录：站点名称、域名、核查时间和时区、游戏目录/端口、nginx 在宿主还是容器、探针目录/端口。下列 `/opt/Stronghold-Protocol`、3000、3999 均按实际安装替换；门户只在中央机检查。

## 1. 版本与运行位置（每台）

```bash
date -Is
git -C /opt/Stronghold-Protocol rev-parse HEAD
git -C /opt/Stronghold-Protocol status --short
systemctl show stronghold sp-collector sp-admin -p Id -p ActiveState -p SubState -p WorkingDirectory -p FragmentPath -p MainPID
```

服务名不存在时记录实际名称。从运行中的 collector 路径读取 VERSION，不能只读另一个未运行的检出。本地当前探针版本 `sp-ops-8b6a48451657`，最终发布时仍应以发布包 VERSION 为准。

中央机另取门户提交：`git -C /opt/stronghold-portal rev-parse HEAD`。记录配置文件路径和备份是否存在，不粘贴配置全文、Environment 全文或凭据。

## 2. Node 清单热请求（每台）

```bash
for i in 1 2 3; do
  curl -sS --max-time 20 -o /dev/null -w 'code=%{http_code} bytes=%{size_download} total=%{time_total}\n' http://127.0.0.1:3000/data/resource-manifest.json
done
curl -sS --max-time 20 -D - -o /dev/null http://127.0.0.1:3000/data/resource-manifest.json
```

记录首轮/后两轮耗时、ETag、Cache-Control、Vary、X-Accel-Expires。再拿返回的 ETag（保留双引号）作 If-None-Match 请求，确认 304 和耗时。直接 Node 与公网测试应使用同一 Host、同一版本参数、同一 Accept-Encoding，比较解压后的正文哈希；不要拿转换前的磁盘源文件作对照。

判断：热请求是否仍反复接近 0.4～1.3 秒；200/HEAD/304 是否正常。第一次冷请求较慢不能单独证明缓存失效。

## 3. nginx 缓存、版本保护、计时日志（每台）

在实际 nginx 所在位置执行 `nginx -t`；容器站用 `docker exec <实际容器名> nginx -t`。这一步仅检查，不 reload。

从生效配置中核对并摘录相关块：

- http 级 proxy_cache_path、log_format，以及目标站 access_log。
- `/data/resource-manifest.json`、`/assets-manifest.json`、`/_v/`、`/api/announcement`、`/healthz` location。
- proxy_cache 是否启用、缓存键是否保留站点/版本 query、Vary 编码处理、缓存锁、TTL、Cache-Control/X-Accel-Expires 处理。
- 新计时格式是否保留完整 combined 前缀和 UA，并包含 rt/urt/cache/reason。

对同一公网清单 URL 连续请求三次，记录 HTTP 状态、缓存状态响应头、ETag、耗时、正文量。缓存已热时可以一直 HIT，不要为了看到 MISS 清缓存。带当前版本参数与裸路径分别检查；gzip 与 identity 的正文解压后应一致，304 不应带完整正文。

用页面实际出现的当前 `/_v/<tag>/js/...` URL 核对正文/缓存头与 Node 一致；无效旧 tag 不应永久映射到当前代码。分别检查裸路径和版本路径的 `/sim/nodeData.js` 及大小写变体，不得返回私有文件内容；403/404 都可接受。

新增版本简版接口上线后，`/healthz?build=1` 应只返回 build，`/healthz` 仍是完整监控响应；代理不得忽略 query 而混用二者。

返回两条脱敏日志样例和计时字段是否存在即可，不需要整份 nginx -T 或整份访问日志。

## 4. Service Worker 与客户端缓存（每站浏览器）

在正常浏览器缓存设置下打开开发者工具，确认没有勾选 Disable cache：

- Application → Service Workers：注册脚本是否携带 `?v=<版本>`，作用域是否正确，有无多个遗留注册。
- Network：SW 请求的 resource-manifest 是否携带版本参数；首次进入、再次进入分别记录状态、Transferred、耗时。
- 清单请求允许 HTTP 校验缓存，普通资源仍保留现有哈希校验策略。
- 页面控制台有无模块 MIME/CSP、404 或 SW 错误；记录第一条原始错误。

不要通过手动注销 SW 或清空缓存来掩盖存量客户端升级问题。资源预载保持现状，不开启全量预载。

## 5. 游戏 → 探针 → 中央面板（每台与中央）

在主机本地读取，结果留本机：

```bash
curl -fsS --max-time 10 http://127.0.0.1:3000/healthz
curl -fsS --max-time 10 http://127.0.0.1:3999/api/data
```

新代码上线、等待至少两个采样周期后检查：

- 游戏 processDiagnostics 有完整区间窗口、事件循环/GC 值；persist.lastSaveMs 按实际持久化能力存在。
- 探针 current 有 gameMainThreadCpuPct、gameWorkerCpuPct、gameNvcswPerSec、cpuStealPct、tcpRetransPct 等；启动首样本/不支持来源可为 null，不应编造 0。
- socketBuffers、worker queue/compute、heap、persist 计数进入探针。
- 新日志完整覆盖一分钟并追平积压后，httpMinute* 有值；启动半分钟、缺口或积压未追平时允许 null。正常无失败应为 0。
- diagnostics.nginx/storage 状态、日志积压、采样时间与探针版本是否正常。
- 中央单站详情、历史图和导出能找到同一字段；断连补传按原时间落图，不挤到恢复时刻、不重复计数。

回传时只摘录相关数值和诊断状态，移除 connsTop、IP、私有 URL、token、原始配置等字段。

## 6. 门户随机加入与房源（只查中央）

记录 PORTAL_RANDOM_CONCURRENCY、PORTAL_RANDOM_TIMEOUT_MS、PORTAL_RANDOM_MAX_CANDIDATES 是否设置及数值；不要求照抄旧报告的建议值。

在有真实可加入房间时正常点击一次随机加入，记录站点/房间范围、耗时、HTTP 状态、业务 reason、X-Portal-Reason；无房间时记录对应文案。核对房源统计与登记生命周期。

从日志统计一个明确时段（最好包含晚高峰）的请求总数、成功、NO_ROOM、ROOM_CHECK_BUSY、不可用、预算耗尽和超时；旧日志没有 reason 时明确写“无法区分”，不要都归为无房间。不在线做并发压测或批量创建房间。

## 7. 原有更新保存和自动恢复（下一次正常发布时验收）

现在只核对实际存档后端/目录、服务用户写权限、最终保存日志和近期 failures。不要为了核查主动重启游戏。

下一次正常更新时记录更新前后同一对局是否自动重连、状态恢复、有没有丢档；版本刷新是否避开进行中的对局。继续沿用现有保存/重启/恢复流程，不加等待对局结束的 drain。

## 8. 告警、公告权限和遗留配置

- 中央面板活动告警、数据陈旧暂停、恢复记录是否符合真实样本；MON_CAPACITY 数值及晚高峰 sockets/延迟基线。当前告警只在面板，外部通知尚未接入。
- 各站只回答 SP_ADMIN_TOKEN_RW 是否配置，绝不返回密钥；MON_ANNOUNCEMENT_FILE 实际路径是否与游戏读取路径一致，服务用户是否可写/可读。
- 面板现有“测试探针”结果与读写能力是否一致。实际公告推送留待正常发布一条公告时验收，不发布测试公告骚扰玩家。
- `/panel/` 是否仍指向已停服务；旧检出是否被服务、容器挂载或发布脚本依赖。先记录，不删除。

## 9. 三个历史疑点的证据（保留原日志时查）

1. 公告 405：按日期、HTTP method、脱敏来源、UA 聚合，注明具体域名/端点；对照当时服务版本、路由与公告源超时日志。
2. WS 累计上行 657MB：记录对应连接存续时长、连续两次字节计数及时间差、连接对应客户端和消息类型汇总。累计字节不能当瞬时速率，不能单据此认定攻击。不得回传玩家消息正文。
3. 请求未到达与宿主抖动：对照同一时区的云系统事件、防护拦截、CPU steal、请求耗时和客户端网络探针。历史证据已轮转或不存在就明确写“无记录”，不补猜测结论。

## 回传模板

```text
站点/域名：
核查时间/时区：
游戏提交/门户提交（中央）/运行探针 VERSION：
游戏、collector、agent、nginx 运行位置与状态：
Node 清单：首轮/热请求/304 耗时，ETag：
公网清单：缓存头、状态、耗时、编码/版本隔离：
nginx -t 与计时日志：
SW 注册 URL、清单 URL、重复下载量、第一条浏览器错误：
healthz/探针/中央各层新字段与 null 或 error：
随机加入分布（中央）：
存档失败数/最近一次正常发布恢复结果：
公告读写能力、路径一致性、旧路由依赖：
历史 405/WS/云事件证据：
未查到或尚未部署的项目：
```
