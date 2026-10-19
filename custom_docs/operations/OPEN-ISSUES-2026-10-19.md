# 未结问题清单 — 2026-10-19

采集时间：2026-10-19 12:5x CST　来源：`/var/log/nginx/sp/stronghold.access.log`（00:00 起，755,455 行）、`nginx -T`、`systemctl show stronghold`
状态：本次 gate 修复已在本地实现，未部署生产。下面的线上数据和重启记录来自原采集，本次没有重新连接生产主机核验。

## 复核与修复结论（2026-10-19，本地）

建议先部署 **A 的加强版**，暂不迁移 WS 准入，也不采用“新身份挤掉在线玩家”。这次没有连接生产主机，下面都是仓库修复与本地验证，不能据此宣布线上恢复。

- **P1/P3：改为明确的恢复探针。** 旧补丁的 `HEAD / → 429 → 刷新` 有歧义，且仓库 gate 返回 444。新增 `GET /_gate/status`：只有 `200 + X-Gate-Required: 1` 才表示 cookie 缺失/无效；有效返回 204，403/503 保留拒绝/故障含义。它不签发失败凭证、不绕过业务准入。前台 WS 连败持续至少 20 秒才允许自动导航，探测和刷新都有间隔及跨页次数上限；耗尽后停止 WS 重试、显示刷新提示。版本检查器也改用明确标记，不再从 manifest 可访问推断 gate 失效。WS 的其他拒绝原因仍不可读，后续确有需要再设计可读准入协议。
- **P2：服务端和 Nginx 同时修。** gate 对所有已通过校验的受保护请求生成后半周期续签头；snippet 在 server 级转发 Set-Cookie。自带 `add_header` 的 location 必须重复这条（尤其 healthz），详见 [BROWSER_GATE.md](BROWSER_GATE.md)。IP 绑定保留，换出口后重新验证。
- **P4：环境变量已映射。** `server/http/config.js` 的 `lobbyOptionsFrom()` 优先读 `SP_IP_MAX_SESSIONS_PER_IP`，兼容旧名，线上所示值会解析为 8。持久化房间配置也可能覆盖环境默认，需以启动日志/管理 API 的实际值为准。当前实现已经只回收离线身份，保留在线玩家；不改默认值或引入在线抢占。
- **P5：静态桶分流。** 图标、字体（包括版本路径及构建后的哈希文件名）不再使用 per-IP 静态请求/连接桶；仍保留 gate、GeoIP、全局连接上限。业务、模块和美术下载沿用原桶。
- **P6：不能仅凭三个样本认定全部 500 的来源。** 升级上游未监听通常还需区分 502 与 auth_request 子请求导致的 500；上线前应对齐同一秒的 error.log 和 gate/systemd 日志。普通失败保持退避，不触发误刷新。
- **P8：更正红测试归因。** 使用项目规定的 `--import ./test/helpers/test-setup.js` 后，三条身份集成测试全部通过；未发现它们由 `server/index.js` 的聊天日志改动导致。manifest 测试现按两套可选模板分别验证唯一 location，真实 Nginx fixture 组合时先移除 gate 中对应 location。
- 另修复旧重连补丁的命名冲突：实例字段 `probe` 会遮蔽原来的延迟探测方法；恢复探针改名为 `gateProbe`。

本地前端构建通过；重连、版本检查、身份、IP 准入及 gate HTTP 集成回归通过。真实 Nginx 测试仍因本机没有二进制而跳过，目标配置必须先 `nginx -t`。§3–§6 已按复核结果更新，不应再执行旧版 HEAD / + 429 判据或在线身份抢占方案。

部署顺序：先安装新版 gate 服务与 Nginx snippet/map，保留原签名密钥；按现有 location 响应头继承情况补齐续签头，检查模板重复 location，`nginx -t` 后 reload；再发布构建后的前端。旧前端已打开的页面不会自动获得新代码，必要时仍需首次刷新。游戏进程如需重启，应安排维护窗口并保留回滚；不要改健康防护额度或手工封禁。验证无 cookie 探针 200+标记、有效 cookie 204、续期 Set-Cookie、页面验证后 WS 101，并观察 10 分钟的 gate 拒绝率与重连量。

---

## 0. 先纠正我自己的一个判断

我昨晚到今早说过"根子是每 IP 每分钟 5 次握手失败就被封，NAT 连坐"。**今天的数据不支持这个结论。**

原采集称 `/ws` 共 23,322 次，其中 17,644 条拒绝具有以下特征（与 §2.2 的状态计数有差异，见该节核对说明）：

```
req_limit=PASSED  conn_limit=PASSED  urt=-  rt=0.001
```

这些记录的限流桶均标记 PASSED；不能据此推断所有请求的限流桶都未触发。按原采集配置，拒绝路径是 gate：`auth_request` 拿 401 → `@sp_gate_needed` → 非导航请求 `return 429`。也就是说问题不是"额度太小"，是"这个请求在 nginx 这层就已经被判定为不合格，而且判定理由传不到浏览器"。

继续抬额度无法修复失效凭证；`/healthz` 的既有防护不因这次故障而放宽。

---

## 1. 原采集时的线上配置（本次未重新核验）

| 项 | 值 |
|---|---|
| 主机 | 103.236.75.12:10169（Debian 13，4 vCPU / 3.9 GB） |
| 主域名 | `wei.rainya.me`（`xa.misyra.com` 备用） |
| 游戏进程 | `node server/index.js`，systemd `stronghold.service`，`127.0.0.1:3000` |
| 进程状态 | pid 2294130，12:23:07 重启，RSS 749 MB，CPU 25.4%（累计 986 CPU-分钟，自 10-17） |
| gate | `127.0.0.1:3101`，`stronghold-browser-gate/gate.mjs` |
| 采集 | `127.0.0.1:3001`（`SP_ROOM_ADMIN_PORT`） |
| nginx | 1.26.3，配置 `/etc/nginx`，站点片段 `fleet-game-locations.inc` |

关键环境变量（`systemd show stronghold -p Environment`，摘录）：

```
SP_IP_SESSION_LIMIT=on           SP_IP_SESSION_SCOPE=all
SP_IP_MAX_SESSIONS_PER_IP=8      SP_ALLOW_FOREIGN_CONNECTIONS=off
SP_HTTP_API_CN_ONLY=on           TRUST_PROXY=auto
SP_WS_UPGRADE_THRESHOLD=100      SP_WS_UPGRADE_WINDOW_MS=60000   SP_WS_UPGRADE_BAN_MS=3600000
SP_HTTP_BAN_THRESHOLD=300        SP_HTTP_BAN_WINDOW_MS=60000
SP_ANNOUNCEMENT_SOURCE=agent     SP_COMBAT=client                SP_VERIFY=off
```

关键 nginx 额度（`nginx -T`，线上实值）：

| 桶 | 键 | 额度 | 位置 |
|---|---|---|---|
| `sp_gate_issue` | `$binary_remote_addr`（仅 `/_gate/challenge|verify`） | **9 r/m**，burst 12 | 挑战/验证 |
| `sp_gate_global` | 常量 `gate` | 15 r/s，burst 45 | 全局 |
| `sp_conn_ip` | IP | 24 并发 | `/_gate/` |
| `fleet_ws_rate` | IP | **18 r/m**，burst 9 | `/ws` |
| `fleet_ws_conn_ip` | IP | 6 并发 | `/ws` |
| `fleet_ws_conn_all` | server_name | 1200 | `/ws` |
| `fleet_conn_all` | server_name | 4500 | 全站 |
| `sp_business` | map（含 WS） | 450 r/m，burst 45 | 业务 |
| `sp_static` | map | 150 r/s，burst 1536 | 静态 |
| `fleet_page_ip` | IP | 180 r/m，burst 15 | 页面 |
| `fleet_health_ip` | IP | 18 r/m，burst 5 | `/healthz` |

---

## 2. 今天的数字

### 2.1 请求量

| URI | 次数 |
|---|---|
| `/api/announcement` | 148,062 |
| `/healthz` | 95,010 |
| `/ws` | 23,322 |
| `/` | 4,320 |
| `/api/ping` | 4,129 |
| `/data/resource-manifest.json` | 3,656 |
| `/shared/i18n.js` / `i18nPacks.js` | 3,113 / 3,110 |
| `/api/portal-room` | 2,794 |
| `/packs/index.json` | 2,021 |

独立 IP 1,892 个。

### 2.2 `/ws` 结局

| 状态 | 次数 | 占比 |
|---|---|---|
| **429** | **17,623** | **75.6%** |
| 101（握手成功） | 5,285 | 22.7% |
| 500 | 391 | 1.7% |
| 444 | 27 | 0.1% |
| 502 | 4 | 0.02% |

核对说明：表内状态次数相加为 23,330，比原总数 23,322 多 8；429 的 17,623 也与前述 17,644 相差 21。本地没有原始日志，保留原数值供回查，拒绝比例只能暂记为约四分之三。上线前按同一时间范围、URI 和状态重新统计。

分小时（00–12 点）：原采集记录 `101` 在凌晨 03–07 点每小时 24–94 次，`429` 仍为每小时 1,026–1,713 次。这与滞留页面持续重试相符，但仅凭访问日志不能排除自动脚本，也不能确认玩家人数。

### 2.3 `/ws` 429 集中在谁身上

| IP | `/ws` 429 | 该 IP 今天的全部状态 |
|---|---|---|
| 58.222.228.208 | 4,328 | **4,328 次全是 429，零个 200/304/101** |
| 112.46.114.18 | 4,310 | **同上，全是 429** |
| 223.89.15.238 | 2,893 | 622 次 304、89 次 200、**2 次 101** |
| 175.7.78.99 | 794 | 134 次 101（断开原因待核） |
| 39.144.124.142 | 626 | — |

- 有 `/ws` 429 的独立 IP：**123 个**（占全站 IP 的 6.5%）
- 其中"拿到过 101 又被拒"的：**80 个**
- 其中"一次都没握上手"的：**43 个**

4,328 次 ÷ 12.8 小时 = 每 10.6 秒一次 —— 正好是客户端退避的天花板（`BACKOFF.max = 10000`）。行为与滞留页面按客户端退避周期重试相符；这仍是推断，不能排除脚本或共享 IP 后的其他来源。

### 2.4 其余 429

| URI | 429 次数 |
|---|---|
| `/healthz` | 17,182 |
| `/build/assets/favicon-*.png|ico` | 700 + 647 + 640 + 284 |
| `/build/assets/app-CfJ_7QFp.svg` | 653 |
| `/`（导航） | 279 |
| `/api/announcement` | 165 |
| `/_v/…/fonts/fonts.css` | 78 |

`/healthz` 的 429 主体（`82.157.129.214` 5,260、`120.253.215.110` 4,269 …）是云厂商地址在扫，**这块是健康的，别动**。

---

## 3. 问题状态与处理决定

### P1 —— gate 拒绝后客户端无法恢复：本地已修，待上线

原采集显示大量 WS 拒绝未触发 Nginx 的请求/连接桶，符合 cookie 缺失或无效后反复握手的机制。旧页面只得到 WebSocket 1006，无法读握手 HTTP 响应。

现使用明确的状态探针，前台连续失败至少 20 秒且得到 gate 必须验证的标记才导航恢复。探测频率、刷新间隔和跨页次数都有限制；刷新预算耗尽后停止 WS 自动重试并提示手动刷新。后台不探测或自动刷新；这项改动不承诺停止所有后台 WS 退避请求。旧页面不会自动获得新代码。

43 个从未成功的 IP、80 个成功后又被拒的 IP 都是原统计，不等于同样数量的玩家；cookie 失效本身不会主动踢掉已建立的 WS，具体断开原因需另查。

### P2 —— 续期依赖单一健康响应：本地已修，待验证配置继承

gate 原来只对 healthz 检查生成续签头，所以只给 HTML 添加 Set-Cookie 不足以解决问题。新版服务在有效凭证的后半周期对受保护请求生成续签头，Nginx 在相应响应中转发。自带 add_header 的 location 必须重复续签指令并保留安全头。凭证一旦过期、签名或绑定失效，仍需挑战；IP/Host/协议/UA 绑定保留。

### P3 —— 升级失败原因不可读：先解决 gate，其他原因待设计

GET /_gate/status 对缺失/无效 cookie 返回 200 + X-Gate-Required: 1，有效凭证且未封禁返回 204。它不授予失败请求访问业务的权限。有效凭证的封禁检查失败时，服务返回 403/503；Nginx 或网络层可能继续按现有规则丢弃响应。普通 429、503、404 或网络错误不能当作验证失效。

不实施 WS 准入搬迁、4004/4005 或移除现有 WS 保险阀。浏览器只能在成功升级后接收 close frame，相关设计需另行评估握手前后的资源和拒绝策略。

### P4 —— 同 IP 身份配额：已核对，不改在线玩家策略

SP_IP_MAX_SESSIONS_PER_IP 是首选环境名，兼容 SP_FOREIGN_MAX_SESSIONS_PER_IP；原采集环境值解析为 8。持久化房间配置可覆盖环境默认，必须查看启动日志或管理 API 才能确认最终值。仓库默认值仍为 1。

当前逻辑只回收离线身份，已连接身份不被新人抢占。本次不抬默认值、不顶掉在线玩家，也不新增 4004。若 NAT 共享出口仍频繁碰限，应先采集实际配额与拒绝原因再调整。

### P5 —— 图标、字体与静态模块共用 per-IP 桶：本地已分流

图标、字体（含版本路径、构建哈希文件名）从 per-IP 静态请求和连接桶中排除；gate、GeoIP、全局连接上限保留。模块、美术下载和业务仍保留原桶。gate 本身拒绝这些资源时，此次分流不会绕过验证。

### P6 —— WS 500：根因待核

仅有三条同秒样本不足以认定 391 条 500 都来自重启。需要对齐 error.log、gate 与游戏服务日志，区分 auth_request 失败与升级上游故障。此类错误继续正常退避，不触发 gate 自动刷新。

### P7 —— healthz 429：保留防护

按原采集，主要来源为云厂商地址；不为这次 gate 恢复问题放宽健康接口额度。原表的 per-IP 18 r/m 与全局桶是不同维度，不能混用数值说明拒绝原因。

### P8 —— 原红测试：已复核并修正

- 身份集成测试使用项目预加载 --import ./test/helpers/test-setup.js 后三条通过，不能归因于 server/index.js 的聊天日志改动。
- cache 与 gate 是两套可选部署模板，分别保证清单 location 唯一；组合部署须移除重复项。断言和真实 Nginx fixture 已按此修正；真实 Nginx 测试本机仍跳过。
- 恢复探针实例字段改名 gateProbe，避免遮蔽原有 probe() 延迟检测方法，并补回归测试。

### P9 —— 提交与部署边界

完整修复已分布在已有提交 `30437428`（gate 服务、Nginx 模板、重连及静态桶等）、`2ec469e9`（版本检查与横幅）和 `70bba335`（恢复探针命名冲突及回归）。本次后续提交校正文档与部署边界，不能仅拣最后一条文档提交就当成完整上线包。素材缓存、管理聊天记录和其他 UI 更新是独立提交；不要因本清单描述过它们就一并部署。

## 4. 本地验证与线上状态

本次验证覆盖 gate HTTP 校验/续期、明确状态标记、误刷新防护、迟到响应、刷新预算、原延迟探测方法，以及版本检查与身份恢复。相关回归及前端构建通过；IP 准入回归也通过。构建仍有现存警告，构建成功不等于线上验收。

提交文档前再次运行以下命令：42 条测试，41 条通过，1 条真实 Nginx 用例因缺少二进制跳过，0 失败；`git diff --check` 通过。

```sh
node --import ./test/helpers/test-setup.js --test test/client-gate-reconnect.test.js test/ui/buildGuard.test.js test/client-identity-session.test.js test/ops/browser-gate.test.mjs test/ops/incident-defaults.test.mjs test/ops/browser-gate.nginx.test.mjs
```

真实 Nginx 测试因本机缺少二进制而跳过；可选真实 ASN 数据库测试缺少测试数据库时跳过。目标机的语法、响应头继承、缓存和 WS 握手必须另行验证。

原采集记录线上曾在 12:23:07 重启，并备份过 99-fleet-protection.conf；这是历史记录，不是本次执行的部署。本次没有访问生产机，没有调整在线限流、封禁或重启游戏。

## 5. 采用方案与部署顺序

采用 A 的加强版，完整操作说明见 [BROWSER_GATE.md](BROWSER_GATE.md)。先备份实际配置、gate 程序和前端发布包，保留原签名密钥与私有回滚材料。

1. 安装新版 gate 服务，确认实际 SP_GATE_GAME_PORT；当前原采集为 3000，旧安装示例 3100 不能直接照抄。重启 gate 时保留密钥。
2. 合并新版 gate snippet 和静态分流 map，保留现场健康防护、全局连接上限、安全头和手工封禁；检查清单 location 重复项，以及自带 add_header 的受保护 location。
3. 对目标机完整配置运行 nginx -t，通过后 reload，并确认新配置实际加载。
4. 发布包含完整修复的前端构建。如果游戏资源版本在进程启动时固定，安排维护窗口重启；不要在对局中无计划重启。旧标签页首次仍可能需要手动刷新。
5. 立即验证状态接口、正常页面、续期与 WS，再观察至少 10 分钟。只有现场验证完成后才记录“已上线/已恢复”。

B（迁移 WS 准入）与 C（改在线身份抢占策略）均未实施。

## 6. 上线检查清单

- [ ] 备份实际 Nginx 配置、gate 程序、签名密钥和前端发布包，记录可执行回滚步骤。
- [ ] 核对实际游戏端口、gate 端口和配置 include 位置，不把旧节点示例当现场值。
- [ ] 检查清单 location 唯一、续签头继承、原安全头与健康/全局防护。
- [ ] 目标机完整 nginx -t 通过，reload 后确认实际加载新配置。
- [ ] 无 cookie 探针返回 200 + X-Gate-Required: 1，不能直接获得凭证或业务访问；有效 cookie 探针返回 204。
- [ ] 进入后半有效期的测试凭证能在 HTTP 响应中续期；正常 cookie 页面与 WS 分别正常返回 200/101。
- [ ] 用隔离测试验证普通 429/503 不触发自动刷新，恢复失败有次数上限及手动提示；不要在生产批量打请求。
- [ ] 不修改已有手工封禁；此前“两条封禁”的地址信息不全，必须核对实际名单，不能按猜测操作。
- [ ] 至少观察 10 分钟 WS 429/444/5xx、gate-check 401、状态探针量与 uptime；统计使用一致的时间范围和分母。
