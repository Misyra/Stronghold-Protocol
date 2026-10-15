# 同盟房间一键收录

房主在同盟等待室点击「提交本房间到联机站」，公开房间密钥供其他玩家加入。仅接受仍有空位、未开局、未进入匹配队列的协力房间；独立模拟和观战者不能提交。未配置时，公网访问仍隐藏按钮；通过 localhost、回环地址或 IPv4 私有局域网地址访问时，显示分享入口和未配置提示，并提供「复制邀请链接」「前往联机站」。此时直接提交按钮禁用，不会发出登记请求；配置接口并重启服务后，点击「重试」重新探测即可使用直接提交。

分享有两种**显式模式**（`docs/design/portal-agent-wss.md` §43.1、§45.3），由游戏服的启动配置决定，浏览器不能指定目的地或凭据：

| `SP_PORTAL_ROOM_MODE` | 谁去联系联机站 | 需要哪些配置 | 什么时候用 |
|---|---|---|---|
| `off` | — | 无 | 本站不开放直接提交（公网隐藏按钮，本机或 IPv4 私有局域网访问显示未配置提示） |
| `legacy-http` | 游戏进程自己，带 HMAC 签名直连中央 | `SP_PORTAL_URL`、`SP_SITE_ID`（或旧别名 `SP_PORTAL_SITE_ID`）、`SP_PORTAL_ROOM_KEY` | 第三方站点：游戏服能被联机站访问，双方都持有密钥 |
| `agent` | 本机 Agent 的**桥接口**，由 Agent 用它的中央连接去登记 | `SP_PORTAL_AGENT_URL`、`SP_PORTAL_BRIDGE_TOKEN` | 自营站点：游戏只依赖本机 Agent，不需要中央凭据，也不需要被中央从公网访问 |

不写 `SP_PORTAL_ROOM_MODE` 时按旧配置判定：配了分享密钥（或那个只为分享存在的旧站点别名）就按 `legacy-http`，什么都没有就是 `off`。只配置公告用的 `SP_PORTAL_URL` 不会被当成「配了分享」。

启动日志会自述当前模式（`[portal] site <siteId> · room share <mode> …`）。配置错误（模式名不认识、本机地址不是回环 HTTP 根路径、密钥长度不对、`SP_SITE_ID` 与旧别名冲突）一律**拒绝启动**，而不是等玩家点分享时才失败。

## 站点 ID

统一使用 `SP_SITE_ID`（1–40 位 `[a-z0-9-]`）。旧的 `SP_PORTAL_SITE_ID` 只作兼容别名，**两者同时出现且不同就拒绝启动**：公告发到 A 站、房间登记到 B 站不会报任何错，只会安静地各干各的。

## legacy-http 模式

游戏服与联机站各自设置环境变量并重启。`siteId` 必须与联机站现有 `sites.json` 的 `id` 完全一致（例如 `hongkong`）。每个游戏站点生成不同的专用密钥，不复用探针或管理密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

游戏服环境（部署环境文件只允许运行用户读取，不入库）：

```ini
SP_PORTAL_ROOM_MODE=legacy-http
SP_PORTAL_URL=https://你的联机站域名
SP_SITE_ID=hongkong
SP_PORTAL_ROOM_KEY=替换为生成的64位小写十六进制密钥
```

联机站环境（JSON 中对应的值必须与该游戏服一致）：

```ini
PORTAL_GAME_ROOM_KEYS={"hongkong":"替换为相同密钥"}
```

游戏服目标地址必须是 HTTPS；仅本机调试允许 loopback HTTP。联机站仍需要通过已配置的 `apiUrl` 访问游戏服 `GET /api/rooms/<code>/status`，且该站不能设置 `roomApi: false`。密钥只存在两端服务器环境中，轮换时同时更新两端并重启；应保持时钟同步。

这种模式下的登记结果只有「成功 / 失败」两种：中央没有「按房间查登记结果」的读接口，所以 `GET /api/portal-room/status` 会如实回答 `501 本站不支持登记状态查询`（不编造一个「没登记」）。

## agent 模式

游戏**不**直连中央。它把「提交这间房」POST 给本机 Agent 的 `/internal/game/v1/publications`（独立桥接凭据），由 Agent 用它的 WSS 连接去登记：

```ini
# 游戏服
SP_PORTAL_ROOM_MODE=agent
SP_SITE_ID=hongkong
SP_PORTAL_AGENT_URL=http://127.0.0.1:3900/
SP_PORTAL_BRIDGE_TOKEN=与Agent MON_GAME_BRIDGE_TOKEN 相同的值
SP_ROOM_ADMIN_TOKEN=与Agent SP_GAME_ADMIN_TOKEN 相同的值
SP_ROOM_ADMIN_PORT=3001

# Agent 本机
MON_GAME_BRIDGE_TOKEN=与上面相同
SP_GAME_ADMIN_TOKEN=与 SP_ROOM_ADMIN_TOKEN 相同
MON_GAME_ADMIN_URL=http://127.0.0.1:3001/
```

- `SP_PORTAL_AGENT_URL` 只允许**回环地址上的 HTTP 根路径**，不能带用户名 / 密码 / query / fragment，端口后不要写子路径（桥接路径是固定的）。
- `SP_PORTAL_BRIDGE_TOKEN` 必须与 `SP_ROOM_ADMIN_TOKEN` **不同**（凭据分离）：桥接凭据只能走分享入口，拿到它不等于拿到关房 / 改配置的资格。两把凭据都是 32–256 位非空白 ASCII。
- Agent 与游戏必须**同宿主机回环**。Docker 分开部署时容器里的 `127.0.0.1` 互不相通，首版不支持这种拓扑（要支持得另立设计：限定网段 + 独立鉴权）。
- 这种模式不需要 `SP_PORTAL_URL`、也不需要旧的 HMAC 密钥：游戏不再持有任何能代表本站改写公告 / 配置 / 关房的东西。

### 登记结果可能是「未知」

正式提交时游戏为**当前房间实例**生成 `opId`，随 `{code, roomId, opId, expiresInMs}` 一起发出：

| 游戏服 `POST /api/portal-room` | 含义 | 界面 |
|---|---|---|
| `200 {registered:true, expiresAt, remainingMs, opId}` | 中央确认收录 | 「已提交到联机站，剩余 N 分钟」 |
| `202 {status:'pending', opId}` | **发出去了但不知道结果**（回执在路上丢了） | 「登记结果待确认」+ 查询按钮 |
| `409 {code:'ROOM_CHANGED'}` | 房间已经不是提交时那一间 | 提示刷新，界面不显示收录 |
| `429` / `503` / `502` | 被拒（限流 / 链路不可用 / 其它） | 显示对应文案，可稍后重试 |

`202` 之后的界面必须走 `GET /api/portal-room/status?code=ABCD`（仅当前房主，Bearer 游戏会话 token），返回：

| `state` | 含义 |
|---|---|
| `registered` | 在册，带 `expiresAt` / `remainingMs`（中央十分钟裁定） |
| `ended` | 曾经登记、现在已撤下或过期 |
| `absent` | 查不到这条申请（确定没登记） |
| `pending` | 上一次申请还没有定论 |
| `unknown` | 查询本身失败（**不是**「没登记」） |

两条规则不要绕开：

- **同一个未定论的申请复用同一个 `opId`**。换一个 `opId` 重发在中央那边就是第二次登记；只有「确定被拒」或「查询确认没登记」之后，下一次点击才生成新 `opId`。
- 提交前的冷却（同房间一分钟）与登记有效期（十分钟）是**两件事**。冷却约束的是点按频率，登记有效期由中央的 `expiresAt` 决定；观测不会延长有效期，刷新页面也不会重置剩余时间。

### 可用性探测

公开的 `GET /api/portal-room` 返回 `{enabled, mode, available}`。`available` 是游戏对 Agent 的**本机短期缓存**（15 秒，并发探测只打一次）：探测问的是「那个进程还在不在监听」，不产生任何中央往返。任何一次真实提交的结果都会立刻修正它 —— 提交遇到 `AGENT_OFFLINE` 之后，界面马上转为「暂不可用」并给出「重试」（重新探测），而不是按一次报一次错。

## 接口与权限

- 游戏服 `GET /api/portal-room`：返回 `{ enabled, mode, available }`，不泄漏 URL、密钥或站点配置。
- 游戏服 `POST /api/portal-room`：JSON `{ "code": "ABCD" }`，`Authorization: Bearer <当前游戏会话token>`。服务端检查在线会话、房主身份、待机空位、同源与限流；提交前后各校验一次房间实例，晚回执不会写进新房间的界面。
- 游戏服 `GET /api/portal-room/status?code=ABCD`：同上鉴权，仅当前房主可查本站当前实例的登记结果。
- 联机站（legacy-http）`POST /api/rooms/from-game`：仅服务器调用，JSON `{ "code": "ABCD" }`；不接受浏览器 Origin 或 Sec-Fetch-Site。站点由签名请求头确定，不能由请求体指定 URL、备注或其他站点。
- Agent（agent 模式）`POST /internal/game/v1/publications`（提交）、`GET …/publications/<opId>?code=`（结果查询）、`DELETE …/publications/<listingId>?opId=&roomId=`（撤下）：只绑定回环、禁止 Origin、独立桥接 Token、请求体与在途数受限。回执里的 `status` 是业务状态（`registered` / `pending` / `rejected`），HTTP 码只给中间设备看。

legacy-http 的签名头为 `X-Portal-Site`、`X-Portal-Timestamp`（毫秒 Unix 时间）、`X-Portal-Nonce`（16 个随机字节的小写 hex）、`X-Portal-Signature`（SHA-256 HMAC 小写 hex）。HMAC 的 key 是配置的 **64 字符原文**（UTF-8，不做 hex 解码）；签名消息按以下顺序用 LF 连接，最后没有额外换行：

```text
POST
/api/rooms/from-game
<siteId>
<timestamp>
<nonce>
<原始JSON请求体>
```

legacy-http 两端成功均只返回 `{ "ok": true }`（游戏对浏览器的回执另带 `registered:true`）。重复收录幂等，不覆盖原提交者的所有权凭据，也不延长已有条目的有效期。条目复用联机站原有十分钟过期、状态探测和每站 20 条上限；过期后可重新提交。此入口不会发放续期/删除凭据，原有联机站手动登记仍保留其管理能力。

## 房间实例号与关房

每间房创建时生成 `roomId`（UUID），写进存档并在恢复时保留；旧存档缺字段时补一枚并尽快落盘 —— 这不算开新对局。公开状态接口、本机私有状态端点和 `room.state` 都带这个实例号：**房间码会被复用**，只有实例号能分清「我看到的这间房还在」与「这个码被别人的新房间占了」。

关房命令（本机 `POST /api/rooms/:code/close`）现在按实例号执行：

- 请求体 `{roomId, createdAt, expiresAt}`（旧调用方仍可只给 `createdAt`）。`roomId` 与新房间不一致、`createdAt` 不一致，或两者都不给 → `409 ROOM_CHANGED`，**绝不**按同码的新房间执行。
- 带 `expiresAt` 且已过期 → `200 {closed:false, code:'DEADLINE_EXCEEDED'}`，房间保持不动：这是一条被放弃的命令，不是故障。
- 真正执行 → `200 {closed:true, roomCode, roomId, createdAt}`。管理端只在收到 `closed:true` 时才把操作记成成功，否则读回现场自证（可能仍是「未知」）。

## 配置版本（`/api/room-config`）

配置文件是 v2 文档：`{schemaVersion:2, revision, values:{…五个字段…}, lastMutation:{opId,payloadHash,revision}}`。启动时旧 v1 文件会被读成 values 并按 **revision=1** 落成 v2（第一次真正的改动是第 2 版）。读接口除平铺的旧字段外还返回 `revision` / `values` / `lastMutation` / `gameBootId`。

- 版本化写：`PUT {"expectedRevision":N,"patch":{…}}`（可选 `opId`、`expiresAt`）。版本比较发生在**串行队列内部**，两个人同时改配置只有一个成功，另一个拿到 `409 CONFIG_CONFLICT` 和当时的实际值。
- 同一个 `opId` 同内容重发 = 幂等重放（不递增版本，回 `replayed:true` 与 `originalResultRevision`）；同 `opId` 不同内容 → `409 OP_ID_CONFLICT`。
- 迁移期保留的旧写法（直接给 `{"maxRooms":700}`）仍然可用，但它走同一个串行入口并**递增 revision**，不会绕过版本控制。
- 先落盘再改运行值；落盘成功但应用失败时回 `persisted:true, applied:false`（磁盘已经变了，重启会加载新值），保存失败回 `503 ROOM_LIMIT_SAVE_FAILED` 且运行值不变。

## 资源边界

游戏端复用可信代理地址策略做 IP 限流（突发 10，持续 2 次/秒，最多 4096 个桶），同一房间每分钟最多一次；全服突发 4、持续每 5 秒一次，最多 4 个在途提交。请求体限 128 字节、读取限 3 秒；agent 模式出网限 8 秒（小于浏览器等待上限 10 秒，保证「探针放弃」永远先于「浏览器超时」发生），legacy-http 出网限 5 秒，均禁止跟随重定向；远端响应体直接丢弃。失败同样消耗冷却。登记结果查询另有 4 个在途上限。

联机站先走已有房间写入 IP 桶，再验证签名；每站突发 4、每 5 秒补一次，最多 4 个在途请求，请求体限 512 字节、读取限 3 秒。签名仅允许前后 30 秒时差，已使用 nonce 在有效期内不能重放，最多保留 4096 个。收录前通过已连接 Agent 的私有状态查询（本机回环，最多二十项一批）验证可加入状态，沿用原有有界探测队列及退避；Agent 侧观测周期两秒、完整观测最长十秒。

以上限流与 nonce 缓存是**单进程内存**。部署多个联机站实例需要共享防重放存储/限流或将此接口固定到一个实例。进程重启会清空 nonce 缓存，30 秒时间窗内旧签名可能被再次接受，但登记本身幂等。

应用限流不能吸收链路被打满的流量。生产部署仍应在反向代理/CDN 设置连接和请求速率上限、请求体上限与超时，条件允许时对联机站该写接口限制游戏服出口 IP。必须覆盖写可信代理 IP 请求头；不要记录 Authorization、签名头、密钥或请求体。现有 nginx `/api/` 代理可承接接口，需确认未被静态站路由覆盖且未缓存写请求。生产浏览器访问游戏服也必须使用 HTTPS。

## 排错

- 先看游戏启动日志的 `[portal]` 那一行：模式、站点、目标地址都在里面。
- 按钮显示「暂不可用」：`GET /api/portal-room` 的 `available` 为假 —— 检查 Agent 进程是否在跑、`SP_PORTAL_AGENT_URL` 是否正确、`MON_GAME_BRIDGE_TOKEN` 与 `SP_PORTAL_BRIDGE_TOKEN` 是否一致（桥接未配置时 Agent 回 `BRIDGE_NOT_CONFIGURED`）。
- 一直「登记结果待确认」：看状态查询的 `state`。`pending` 说明中央还没给回执；`unknown` 是查询本身失败（链路问题），不是「没登记」。
- 界面上显示「已收录」但联机站列表里没有：确认双方的 `SP_SITE_ID` 一致，且联机站该站点的模式与凭据没被改过。房间码复用之后旧登记会被撤下，界面按 `roomId` 判断，不会串到新房间。
- 探针与面板侧的接入见 [MONITORING.md](MONITORING.md)、[ROOM_PROTECTION.md](ROOM_PROTECTION.md)。

验证命令：游戏服 `node --test test/portal-room.test.js test/portal-room-agent.test.js test/portal-room-config.test.js test/portal-room-admin.test.js test/room-config-v2.test.js test/ui/room-share.test.js`；联机站 `node --test test/game-room-publish.test.mjs test/rooms.test.mjs test/room-probes.test.mjs test/game-bridge.test.mjs test/room-share-e2e.test.mjs`。
