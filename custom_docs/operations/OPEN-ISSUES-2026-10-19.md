# 未结问题清单 — 2026-10-19

采集时间：2026-10-19 12:5x CST　来源：`/var/log/nginx/sp/stronghold.access.log`（00:00 起，755,455 行）、`nginx -T`、`systemctl show stronghold`
改动状态：线上只动过一次（12:23 重启，见 §4）；其余改动全部只在本地仓库，未上线。

## 复核与修复结论（2026-10-19，本地）

建议先部署 **A 的加强版**，暂不迁移 WS 准入，也不采用“新身份挤掉在线玩家”。这次没有连接生产主机，下面都是仓库修复与本地验证，不能据此宣布线上恢复。

- **P1/P3：改为明确的恢复探针。** 旧补丁的 `HEAD / → 429 → 刷新` 有歧义，且仓库 gate 返回 444。新增 `GET /_gate/status`：只有 `200 + X-Gate-Required: 1` 才表示 cookie 缺失/无效；有效返回 204，403/503 保留拒绝/故障含义。它不签发失败凭证、不绕过业务准入。前台 WS 连败持续至少 20 秒才允许自动导航，探测和刷新都有间隔及跨页次数上限；耗尽后停止 WS 重试、显示刷新提示。版本检查器也改用明确标记，不再从 manifest 可访问推断 gate 失效。WS 的其他拒绝原因仍不可读，后续确有需要再设计可读准入协议。
- **P2：服务端和 Nginx 同时修。** gate 对所有已通过校验的受保护请求生成后半周期续签头；snippet 在 server 级转发 Set-Cookie。自带 `add_header` 的 location 必须重复这条（尤其 healthz），详见 [BROWSER_GATE.md](BROWSER_GATE.md)。IP 绑定保留，换出口后重新验证。
- **P4：环境变量已映射。** `server/http/config.js` 的 `lobbyOptionsFrom()` 优先读 `SP_IP_MAX_SESSIONS_PER_IP`，兼容旧名，线上所示值会解析为 8。持久化房间配置也可能覆盖环境默认，需以启动日志/管理 API 的实际值为准。当前实现已经只回收离线身份，保留在线玩家；不改默认值或引入在线抢占。
- **P5：静态桶分流。** 图标、字体（包括版本路径及构建后的哈希文件名）不再使用 per-IP 静态请求/连接桶；仍保留 gate、GeoIP、全局连接上限。业务、模块和美术下载沿用原桶。
- **P6：不能仅凭三个样本认定全部 500 的来源。** 升级上游未监听通常还需区分 502 与 auth_request 子请求导致的 500；上线前应对齐同一秒的 error.log 和 gate/systemd 日志。普通失败保持退避，不触发误刷新。
- **P8：更正红测试归因。** 使用项目规定的 `--import ./test/helpers/test-setup.js` 后，三条身份集成测试全部通过；未发现它们由 `server/index.js` 的聊天日志改动导致。manifest 测试现按两套可选模板分别验证唯一 location，真实 Nginx fixture 组合时先移除 gate 中对应 location。
- 另修复旧重连补丁的命名冲突：实例字段 `probe` 会遮蔽原来的延迟探测方法；恢复探针改名为 `gateProbe`。

本地前端构建通过；重连、版本检查、身份、IP 准入及 gate HTTP 集成回归通过。真实 Nginx 测试仍因本机没有二进制而跳过，目标配置必须先 `nginx -t`。下文 §3–§5 保留采集时的判断和方案，以上复核结论优先。

部署顺序：先安装新版 gate 服务与 Nginx snippet/map，保留原签名密钥；按现有 location 响应头继承情况补齐续签头，检查模板重复 location，`nginx -t` 后 reload；再发布构建后的前端。旧前端已打开的页面不会自动获得新代码，必要时仍需首次刷新。游戏进程如需重启，应安排维护窗口并保留回滚；不要改健康防护额度或手工封禁。验证无 cookie 探针 200+标记、有效 cookie 204、续期 Set-Cookie、页面验证后 WS 101，并观察 10 分钟的 gate 拒绝率与重连量。

---

## 0. 先纠正我自己的一个判断

我昨晚到今早说过"根子是每 IP 每分钟 5 次握手失败就被封，NAT 连坐"。**今天的数据不支持这个结论。**

今天 23,322 次 `/ws` 握手，17,644 次被拒（**75.7%**），而这 17,644 条全部是：

```
req_limit=PASSED  conn_limit=PASSED  urt=-  rt=0.001
```

nginx 的限流桶**一次都没触发**。拒绝它们的是 gate：`auth_request` 拿 401 → `@sp_gate_needed` → 非导航请求 `return 429`。也就是说问题不是"额度太小"，是"这个请求在 nginx 这层就已经被判定为不合格，而且判定理由传不到浏览器"。

抬额度仍然要做（`/healthz` 那边确实有异物在磨），但它**救不了这个症状**。

---

## 1. 线上现状（只读采集）

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

分小时（00–12 点）：`101` 在凌晨 03–07 点掉到每小时 24–94 次，而 `429` 仍然是每小时 1,026–1,713 次 —— **深夜里 429 的主体不是玩家，是挂着的页面在敲**。

### 2.3 `/ws` 429 集中在谁身上

| IP | `/ws` 429 | 该 IP 今天的全部状态 |
|---|---|---|
| 58.222.228.208 | 4,328 | **4,328 次全是 429，零个 200/304/101** |
| 112.46.114.18 | 4,310 | **同上，全是 429** |
| 223.89.15.238 | 2,893 | 622 次 304、89 次 200、**2 次 101** |
| 175.7.78.99 | 794 | 134 次 101（会被踢出去再回来） |
| 39.144.124.142 | 626 | — |

- 有 `/ws` 429 的独立 IP：**123 个**（占全站 IP 的 6.5%）
- 其中"拿到过 101 又被拒"的：**80 个**
- 其中"一次都没握上手"的：**43 个**

4,328 次 ÷ 12.8 小时 = 每 10.6 秒一次 —— 正好是客户端退避的天花板（`BACKOFF.max = 10000`）。这两个 IP 是**纯僵尸页**：页面整夜开着，只重试握手，一次页面请求都没发。

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

## 3. 问题清单

### P1 —— WS 握手的四分之三被 gate 拒掉（最高优先）

- **证据**：17,644 / 23,322 条 429 全部 `req_limit=PASSED conn_limit=PASSED urt=-`；其中 2 个 IP 各 4,3xx 次、零成功；43 个 IP 全天没进去过。
- **机制**：
  ```
  页面持有一个失效/缺失的 gate cookie
    → auth_request /_sp/gate-check 返回 401
    → error_page 401 = @sp_gate_needed
    → if ($sp_gate_navigation = 0) { return 429; }   ← 非导航请求（WS 升级）在这里被判死刑
    → 浏览器只看见 WebSocket 1006
    → 客户端按 500ms→10s 退避重试同一个必败的握手
    → 无限循环，直到页面被关掉
  ```
- **影响**：43 个 IP 今天一次都没进来；80 个 IP "进来 → 被踢 → 重试"来回折腾。这类玩家的唯一自救方式是手动刷新页面，而他们在对局里不会刷新。
- **可选动作**：
  1. 客户端反查（本地已写好，见 §4）：探针 `HEAD /` 看到 429 就重新导航一次，让 gate 渲染挑战页。
  2. gate 侧给 WS 一条活路：把"cookie 缺失"和"cookie 无效"区分开，前者回 `429 + Retry-After` 并在响应里带一个 `X-Gate-Required` 头，让页面知道该去解挑战。
  3. 拒绝权搬到 Node（见 P3），用 close code 说话。

### P2 —— gate cookie 没有续期路径

- **证据**：`add_header Set-Cookie $sp_gate_renew always;` 线上只出现在 `/healthz` 一段（`nginx -T` 第 670 行），页面导航与 `/ws` 都没有。
- **后果**：cookie 到期或被判无效之后，唯一的补救是一次**导航**。而卡住的页面永远不导航 → 永远拿不到新 cookie。这是 P1 的上游原因。
- **动作**：受保护的 HTML/业务 location 上加 `add_header Set-Cookie $sp_gate_renew always;`（滑动续期），并确认 cookie 是否绑了 IP —— 若是，移动网络换出口 IP 就会永久失效，需要放宽到绑 UA。

### P3 —— 拒绝码对客户端不可读

- **证据**：`/ws` 被拒一律 429/444；WebSocket 升级失败时浏览器只暴露 `code: 1006`，没有任何 HTTP 状态。
- **后果**：客户端无法区分"gate 要挑战""IP 配额满""服务器重启中""网络断了"，于是只能统一重试。
- **动作**：把 WS 准入搬到 Node（它能发 close frame），用 `4004 IP_QUOTA` / `4005 GATE_REQUIRED` 这类码表达；nginx 只保留数量级高两级的保险阀。

### P4 —— 同 IP 身份上限与 NAT 冲突

- **证据**：线上 `SP_IP_SESSION_SCOPE=all` + `SP_IP_MAX_SESSIONS_PER_IP=8`；仓库默认值 `maxForeignSessionsPerIp` 是 **1**（`server/roomConfig.js:26`）。
- **待验**：代码读的是 `SP_FOREIGN_MAX_SESSIONS_PER_IP`（含 legacy 别名），`SP_IP_MAX_SESSIONS_PER_IP` 是否真被映射过去，我还没在源码里确认 —— 如果没被读到，线上实际生效的是默认值 1。
- **动作**：默认值抬到 4；满了之后**顶掉最久空闲的身份**而不是拒绝新人；真拒绝时带 `4004`。

### P5 —— 静态资产被一起限流

- **证据**：favicon 类 429 合计 2,271 次，`app.svg` 653，`fonts.css` 78。
- **后果**：页面被限流后，连图标和字体都拉不到 —— 玩家看到的是"这站坏了"，比"重连中"更糟。
- **动作**：把 `favicon*`、`apple-touch-icon*`、`icons/*`、`fonts/*` 从 per-IP 桶摘出去（幂等 GET，不需要按 IP 计）。

### P6 —— 391 个 500 on `/ws`

- **证据**：样本三条都停在 `12:23:07`（重启那一秒），来自 6 个 IP。
- **判断**：重启窗口内 upgrade 打到尚未 bind 的 upstream。可接受，但客户端应把它当"稍后重试"而不是无限重试。

### P7 —— `/healthz` 的 429 是正常防护

云厂商地址（`82.157.129.214` 5,260 次、`120.253.215.110` 4,269 次）在扫，9 r/s 的桶按设计工作。**不要为了这个加额度。**

### P8 —— 两条既有红测试（不是本次改动引入）

1. `test/ops/incident-defaults.test.mjs:59`：断言 cache + gate 两份片段里 `location = /data/resource-manifest.json {` 合计 1 处，实际 2 处（HEAD 版本就是 2）。要么删一份 location，要么改断言。
2. `test/client-identity-session.test.js` 三条：`Timed out waiting for welcome`。把我的 `net.js` stash 掉后报错一字不差 → 由工作区里脏的 `server/index.js` 引起。

### P9 —— 工作区未提交且混杂

`git status`：30 个 modified + 2 个 untracked，其中 4 个是**他原本就脏的文件**（`server/chatLog.js`、`server/index.js`、`server/roomAdmin.js`、`test/portal-room-chat.test.js`）。上线前必须分清谁是谁。

---

## 4. 本地已改、尚未上线

| 文件 | 改了什么 | 验证 |
|---|---|---|
| `public/js/net.js` + `test/client-gate-reconnect.test.js` | gate 感知重连：第 3 次失败起，每 10 秒最多一次 `HEAD /`；**429 才重载**（≥20 秒且间隔 ≥60 秒，跨页面加载最多 3 次，后台标签页不动作） | 6/6 绿 |
| `server/http/static.js` | `?v=<16 位 tag>` 且等于本次发布 tag ⇒ `max-age=31536000, immutable`；tag 不匹配仍是 `no-cache` | 6 行矩阵实测 |
| `public/js/battle/{simLoader,simHost,simWorker,simWorkerRuntime,rehearsal,rehearsalWorker}.js`、`public/js/render/fx/speeds.js` | 动态 `import()` 的裸路径改成带 tag 的 URL，worker 从自己的 URL/location 取 tag | 20/20 + 8/8 |
| `server/http/wsUpgradeLimit.js` + `test/ws-upgrade-limit.test.js` | 启动期校验：阈值下限 20/分；`banMs ≥ 1 小时` 时阈值不得低于 100/分 | 10/10 绿 |
| `scripts/nginx.conf.example`、`scripts/hardening/*.conf`（6 个） | 默认额度抬到线上手调值以上；`proxy_buffer_size 32k` / `proxy_buffers 16 32k` / `worker_rlimit_nofile 65535` / `keepalive_requests 10000` | 本机无 nginx，**未跑 `nginx -t`** |
| `custom_docs/operations/*.md`（5 份） | 额度、WS、HTTP 防护、部署、事故复盘的数值同步 | — |
| 4 个测试 pin | 断言里写死的旧数值同步 | 通过（除 P8 两条既有红） |

**线上唯一改动**：12:23:07 重启（`99-fleet-protection.conf` 已备份为 `.bak-20261019-1223`），之后 WS 500 的 391 条里有一批是重启瞬间的。

---

## 5. 三条岔路

### A. 最小动作（只治僵尸页）
1. 上线 `public/js/net.js`（需要重新构建 + 重启 Node，因为 `runtimeTag` 会变）；
2. gate 侧给 HTML location 加 `Set-Cookie $sp_gate_renew`（滑动续期）；
3. 把图标/字体从 per-IP 桶摘出。
- 改动面：1 个前端文件 + 2 段 nginx。**代价**：重启一次（踢掉所有房间）；缓解 43 个纯僵尸 + 80 个来回踢的 IP，但不改"拒绝码不可读"。

### B. A + 拒绝权搬家
把 WS 准入从 nginx 搬到 Node，用 `4005 GATE_REQUIRED` / `4004 IP_QUOTA` 说话；客户端收到 4005 就地解挑战（不刷新页面）。
- **代价**：`server/net.js` 准入路径 + 客户端分支 + nginx 撤掉 `/ws` 的 per-IP 桶。这一层做完，"页面空转到天亮"这个故障类别从根上消失。

### C. B + 多身份策略
同 IP 满了顶掉最久空闲、默认 1 → 4、真拒绝带码。
- **代价**：动 `server/foreignSessions.js` 的准入策略，需要回归 `test/` 里现有的准入用例。

---

## 6. 上线检查清单（无论走哪条）

- [ ] 本机**没有** nginx 二进制，改过的 `.conf` 从未跑过 `nginx -t` → 必须在目标机先 `nginx -t`
- [ ] 备份：`cp -a /etc/nginx /root/nginx.bak-$(date +%F-%H%M)`
- [ ] 重启窗口：06:00 前后低峰（今天 06 点全小时只有 24 次成功握手）
- [ ] 回滚：旧 `net.js` / 旧 conf 各留一份
- [ ] 不要碰那两个手工加的 24 小时封禁（`58.222.228.208`、`112.46.114.18` 之外的那两个）
- [ ] 上线后 10 分钟查：`/ws` 的 429 占比、`gate-check` 的 401 计数、`uptime`
