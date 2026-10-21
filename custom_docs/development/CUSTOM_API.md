# 本分支服务端 API 规范

整理日期：2026-10-05。实现版本：`master`，提交 `bf91444`，应用版本 `0.1.3`，WebSocket 协议版本 `1`。

本文只收录本分支相对已合并的上游 `sganggs/Stronghold-Protocol` **v0.1.3（`a0a5419`）** 新增或修改的对外接口。核对依据是 `git diff v0.1.3 HEAD` 和当前源码；本地 `origin/master` 仍停留在较早的 `bdb0765`，不能仅按它的差异判断哪些接口属于本分支。

普通建房、加入、准备、开局、踢人、观战、战斗操作以及原有健康检查字段均属于上游接口，本文不重复定义。资源预载、工作线程与持久化部分包含从其他分支移植并适配的实现；这里的“本分支”表示相对上述上游的扩展，并不表示全部代码均为原创。本文描述本地代码契约，线上站点是否已部署此版本需另行核对。

## 1. 接口总览与公共约定

| 接口 | 类型 | 本分支扩展 | 跨域读取 |
|---|---|---|---|
| `/api/rooms/:code/status` | HTTP GET / HEAD | 按房间号查询公开状态，含难度名称 | 未开放 CORS |
| `/api/ping` | HTTP GET / HEAD / OPTIONS | 无会话的 HTTP 延迟探测 | `Access-Control-Allow-Origin: *` |
| `/api/nickname/validate` | HTTP POST | 进入游戏前校验昵称；不返回词表或命中详情 | 未开放 CORS |
| `/api/announcement` | HTTP GET / HEAD | 读取当前维护公告 | 未开放 CORS |
| `/api/portal-room` | HTTP GET / HEAD / POST | 房间分享的功能探测与提交（`off` / `legacy-http` / `agent` 三种模式） | 未开放 CORS |
| `/api/portal-room/status` | HTTP GET / HEAD | 查询当前房主那条登记的结果（仅 `agent` 模式） | 未开放 CORS |
| `/healthz` | HTTP GET / HEAD | 公开状态：增加素材版本、CDN、`roomProtection` / `botPopulation` / `foreignSessions` 计数 | 未开放 CORS |
| `/metrics` | HTTP GET / HEAD | 进程内部性能与诊断（worker、内存、持久化…）；只回应回环 / 私网调用者 | 未开放 CORS |
| `/data/resource-manifest.json` | HTTP GET / HEAD | 动态生成资源预载清单 | 未开放 CORS |
| `/_v/:version/...` 及素材路径 | HTTP 资源请求 | 版本缓存、素材 CORS | 仅素材开放 CORS |
| `/ws` → `queue.join` / `queue.cancel` / `queue.accept` / `room.matchmaking` | WebSocket JSON | 四人同站匹配：入队、取消、确认入场，支持组队补齐 | 按原有 WebSocket 连接规则 |
| `/ws` ← `queue.state` | WebSocket JSON | 推送匹配进度（入队 / 待确认 / 已匹配）与结果 | 按原有 WebSocket 连接规则 |
| `/ws` ← `m.result` | WebSocket JSON | 增加稳定的结算 ID 和时间 | 按原有 WebSocket 连接规则 |

以下示例以 `http://localhost:3000` 为服务基地址；实际接入时替换为游戏站点地址。所有路径相对于游戏服务根路径，反向代理应把 API 和 `/ws` 转发到对应游戏进程。

HTTP 查询接口无需账号、Cookie 或访问令牌，不创建游戏会话，也不占用玩家席位。WebSocket 匹配接口需要先完成原有 `hello` 握手。

除资源清单和静态资源外，表中 HTTP JSON 接口统一返回 `Content-Type: application/json; charset=utf-8` 和 `Cache-Control: no-store`。`HEAD` 返回与对应请求相同的状态码和响应头，但没有响应体。部署仓库 Nginx 示例时，`/api/announcement` 可在源站 Nginx 内部缓存 5 秒；Node 和浏览器收到的响应仍为 `no-store`。未开放 CORS 的接口可由同源页面或外部服务的后端读取，独立域名的浏览器页面不能直接跨域读取。

时间戳单位均为 **Unix 毫秒**；`/healthz.uptimeSec` 是秒。HTTP 错误响应并非全都为 JSON，具体见各接口。

难度取实际游戏定义：

| `difficulty` | `difficultyName` |
|---|---|
| `FUNNY` | 标准模拟 |
| `NORMAL` | 险境模拟 |
| `HARD` | 绝境模拟 |
| `ABYSS` | 终极模拟 |

## 2. 按房间号查询状态

```http
GET /api/rooms/ABCD/status
HEAD /api/rooms/ABCD/status
```

`code` 为 4 位字母的房间号（游戏中的“同盟密钥”），字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ`，不含 `I`、`O`；接口接受大小写，返回大写房间号。整个路由匹配不区分大小写。不接受多余的尾部 `/`。查询参数不参与房间查找。

公开接口只查询指定房间，没有公开房间列表或搜索接口。房间号只是分享码，持有码即可查到昵称等公开状态，无需加入房间。运维房间列表、限额和关闭接口只监听 `127.0.0.1` 的独立管理端口，配置与私有字段见[房间审计与保护](../operations/ROOM_PROTECTION.md#私有房间列表)。

### 2.1 返回示例

以下为一个有两名真人、一名 AI、一个空位的大厅示例；昵称及时间为示例值。

```json
{
  "code": "ABCD",
  "mode": "coop",
  "difficulty": "NORMAL",
  "difficultyName": "险境模拟",
  "inMatch": false,
  "joinable": true,
  "capacity": 4,
  "occupied": 3,
  "humans": 2,
  "bots": 1,
  "connectedHumans": 2,
  "phase": "LOBBY",
  "round": 0,
  "lastRound": null,
  "deadline": 0,
  "paused": false,
  "seats": [
    { "seat": 0, "name": "房主", "isBot": false, "isHost": true, "connected": true, "ready": false },
    { "seat": 1, "name": "队友", "isBot": false, "isHost": false, "connected": true, "ready": true },
    { "seat": 2, "name": "AI 队友", "isBot": true, "isHost": false, "connected": true, "ready": true },
    null
  ],
  "serverNow": 1791194400000
}
```

### 2.2 顶层字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | string | 大写房间号 |
| `mode` | string | `solo` 独立模拟 / `coop` 同盟模拟 |
| `difficulty` | string | 难度枚举 |
| `difficultyName` | string | 服务端给出的难度名称，展示工具应以它为准 |
| `inMatch` | boolean | 是否存在正在运行的对局 |
| `joinable` | boolean | 仅当同盟房间尚未开局且有空玩家席位时为 `true`；不表示能否重连或观战 |
| `capacity` | number | 玩家席位容量；独立模拟为 1，同盟模拟为 4 |
| `occupied` | number | 已占玩家席位数量，包含断线保留席位和 AI |
| `humans` / `bots` | number | 真人 / AI 数量；均不含观战者 |
| `connectedHumans` | number | 在线且未离席的真人数量 |
| `phase` | string | 当前阶段；未开局时为 `LOBBY` |
| `round` | number | 当前回合；未开局时为 0 |
| `lastRound` | number / null | 对局的常规最后回合，未开局或无数据时为 `null` |
| `deadline` | number | 当前阶段的截止时间；0 表示没有有效截止时间 |
| `paused` | boolean | 服务器已发布的暂停状态 |
| `seats` | array | 按玩家席位排列；空位为 `null`，不返回观战者 |
| `serverNow` | number | 生成响应时的服务器时间 |

### 2.3 席位字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `seat` | number | 从 0 开始的席位编号 |
| `name` | string | 昵称 |
| `isBot` / `isHost` | boolean | 是否 AI / 房主 |
| `connected` | boolean | 是否在线且未离席 |
| `ready` | boolean | 大厅准备状态；已有对局状态时取对局中的准备状态 |
| `alive` | boolean | 仅在该席位有对局状态时出现，是否仍存活 |
| `lp` | number / null | 仅在该席位有对局状态时出现，已结算生命值 |
| `pendingLp` | number | 仅在该席位有对局状态时出现，尚未结算的扣血量 |

对局中的席位示例：

```json
{ "seat": 0, "name": "房主", "isBot": false, "isHost": true, "connected": true, "ready": false, "alive": true, "lp": 30, "pendingLp": 3 }
```

显示实时生命值时，若 `lp` 为有效数值，使用 `Math.max(0, lp - pendingLp)`，上例显示 27；`lp: null` 时显示未知。战斗状态取服务器最近收到并发布的数据，尚未上报的浏览器内战斗进度不在接口中。对局结束回到大厅后，`alive`、`lp`、`pendingLp` 字段消失。

阶段名称来自上游游戏状态，供此查询接口解释返回值：

| `phase` | 含义 | `phase` | 含义 |
|---|---|---|---|
| `LOBBY` | 等待中 | `INFO_CHECK` | 确认本局信息 |
| `BAND_DRAFT` | 选择策略 | `BATTLE_CHECK` | 协议启动 |
| `ROUND_START` | 回合开始 | `SP_DRAFT` | 机变阶段 |
| `PREP` | 休整期 | `COMBAT` | 作战中 |
| `UNITE` | 联防阶段 | `SETTLE` | 结算 |
| `FINAL_ASSAULT` | 最终攻势 | `HIDDEN_CORE` | 隐秘核心 |
| `RESULT` | 模拟结束 | | |

### 2.4 错误、限流及响应头

| HTTP 状态 | 响应体 | 条件 |
|---|---|---|
| 200 | 房间状态对象 | 房间存在且请求允许 |
| 404 | `{"error":"ROOM_NOT_FOUND"}` | 格式错误、不存在、已关闭的房间；访问 `/api/rooms` 也返回此错误 |
| 405 | `{"error":"METHOD_NOT_ALLOWED"}` | 非 GET / HEAD；带 `Allow: GET, HEAD` |
| 429 | `{"error":"RATE_LIMITED"}` | 限流；带 `Retry-After: 1` |

所有 `/api/rooms` 和 `/api/rooms/…` 请求都消耗同一个查询预算，失败查询和不支持的方法也计数。先检查限流，再检查方法和房间，因此超限时优先返回 429。每个客户端网络令牌桶以 **每秒 2 次**补充，突发容量 **10 次**；IPv6 同一 `/64` 网络合并计数，本机和内网请求也受此查询限流约束。

客户端地址识别沿用 `TRUST_PROXY`：默认 `auto` 只信任来自本机 / 内网代理的转发头，`1` 始终信任，`0` 不信任。所有房间查询响应带 `X-Robots-Tag: noindex, nofollow, noarchive`。

接口不返回玩家 ID、重连令牌、私人商店、调配或棋盘数据。外部房间展示服务应从后端查询，并在 429 时按 `Retry-After` 退避；同一网络查询多个房间时须共用限流预算。

```sh
curl -i http://localhost:3000/api/rooms/ABCD/status
```

## 3. HTTP 延迟探测

```http
GET /api/ping
HEAD /api/ping
OPTIONS /api/ping
```

- GET 返回 200 和 `{"ok":true}`；HEAD 返回 200，无响应体。
- OPTIONS 返回 204，无响应体；其他方法返回 405 和 `{"error":"METHOD_NOT_ALLOWED"}`。
- 响应带 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, HEAD, OPTIONS` 和 `Cache-Control: no-store`。
- 不返回房间信息，也不创建会话。当前代码没有为此路由配置独立的应用层令牌桶。

独立中间页可使用浏览器的 `performance.now()` 测量请求前后的差值：

```js
async function probeGame(baseUrl) {
  const started = performance.now();
  const response = await fetch(new URL('/api/ping', baseUrl), {
    method: 'HEAD', cache: 'no-store', credentials: 'omit',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Math.round(performance.now() - started);
}
```

此值是浏览器至游戏站点的 HTTP 往返耗时，可能包含连接建立和 HTTP 服务响应时间，不等同于游戏 WebSocket 延迟。中间页的接入约定为每站最多每 30 秒一次、5 秒超时；这是调用端约定，服务端没有强制 30 秒间隔。代理和 CDN 应遵循 `no-store` 并将此路由转到游戏服务。

## 4. 维护公告

```http
GET /api/announcement
HEAD /api/announcement
```

运维读取最新源站内容时可请求 `/api/announcement?nocache=1`；仓库 Nginx 示例会让该请求绕过共享缓存。普通公告请求在 Nginx 内部最多缓存 5 秒，Node 和浏览器仍使用 `no-store` 响应策略。

存在有效公告时返回 200：

```json
{
  "announcement": {
    "id": "0123456789abcdef01234567",
    "title": "维护公告",
    "text": "服务器将在公告截止时间进行维护。",
    "expiresAt": 1791194400000
  },
  "popupAnnouncement": null,
  "serverTime": 1791190800000,
  "source": { "mode": "agent", "siteId": null },
  "observedRevision": 7,
  "observedAt": 1791190799000
}
```

`announcement` 是滚动公告，`popupAnnouncement` 是当前弹窗公告；没有对应公告时为 `null`。`id` 为公告公开内容的 SHA-256 摘要前 24 位十六进制字符串；标题、正文或截止时间变化会改变 ID，可用于区分玩家已关闭的旧公告。`expiresAt`、`serverTime` 和 `observedAt` 均为毫秒时间戳。`source` 描述公告源模式与站点 ID；`observedRevision` / `observedAt` 报告游戏进程实际读到的交付版本和时间，手工文件未携带交付版本时 revision 为 `null`。

公告关闭、过期、文件不存在或配置无效时，仍返回 200：

```json
{ "announcement": null, "popupAnnouncement": null, "serverTime": 1791194400000,
  "source": { "mode": "agent", "siteId": null }, "observedRevision": null, "observedAt": 1791194399000 }
```

没有公告写入 API。POST / PUT / DELETE / OPTIONS 等方法返回 405、`Allow: GET, HEAD`，响应体为 HTML 错误页。

默认来源为 agent：管理面板以管理密钥推送到本站探针，探针原子写入 `/var/lib/stronghold-announcement/announcement.json`，游戏热读取。Windows 默认 `.state/announcement.json`；`SP_ANNOUNCEMENT_AGENT_FILE` 可指定与探针一致的路径。响应包含 `source: { mode, siteId }` 供诊断。已有显式完整 `SP_ANNOUNCEMENT_URL` 且未指定来源时继续使用 panel 模式；无探针站点可显式选择 panel。仅 `SP_ANNOUNCEMENT_SOURCE=file` 使用手工 `SP_ANNOUNCEMENT_FILE`，默认根目录 announcement.json。文件最多 16 KiB，读取缓存 1 秒。部署说明见 [ANNOUNCEMENTS.md](../operations/ANNOUNCEMENTS.md)。

```json
{
  "enabled": true,
  "title": "维护公告",
  "text": "服务器将在 20:00 维护，请提前结束对局。",
  "expiresAt": "2026-10-05T20:00:00+08:00"
}
```

开启公告须设置 `enabled: true`、非空正文（最多 2000 个 JS 字符单位）和带明确时区的 ISO 截止时间。标题省略时使用“维护公告”，显式设置时须非空且不超过 80 个 JS 字符单位；标题和正文会去除首尾空白。`enabled: false` 关闭公告。本地配置文件不会直接公开，只返回上述公开字段。

中央模式通过 `SP_ANNOUNCEMENT_URL` 或面板地址与站点 ID 组合读取公开 feed（可选 `SP_ANNOUNCEMENT_POLL_MS`，默认 10000，钳制在 3 秒到 10 分钟）后，服务器按间隔拉取该地址的公告配置，响应体格式与本节文件格式完全一致（`{ "enabled", "title", "text", "expiresAt" }`）。拉取失败、响应非法或超过 64 KiB 时保留上一次成功取得的公告，显式 `enabled: false` 立即关闭公告，到期拦截不变；进程重启后重新拉取。中央模式下本地文件不参与，故障时也不会回退本地；切换来源需要重启游戏进程。

## 5. 四人同站匹配（WebSocket）

连接 `ws://localhost:3000/ws`；HTTPS 站点使用 `wss://<游戏站点>/ws`。消息为 JSON，`t` 指定消息类型，`rid` 可用于关联直接回复。先按上游协议握手，例如：

```json
{ "t": "hello", "rid": 1, "name": "博士", "version": 1 }
```

收到 `welcome` 后再发送匹配请求。以下只定义新增消息。

### 5.1 加入 / 取消 / 确认

```json
{ "t": "queue.join", "rid": 2, "difficulty": "NORMAL" }
```

`difficulty` 必填，使用第 1 节的四个枚举。成功即回复 `{"t":"ok","rid":2}`，随后推送一份完整的 `queue.state`。相同难度重复加入不增加人数、不重置入队时间；更换难度必须先取消（否则返回 `QUEUED`）。进度另行推送。

```json
{ "t": "queue.cancel", "rid": 3, "ticketId": "9f2c…" }
```

`ticketId` 取最近一次 `queue.state` 里给出的值。取消成功回复 `{"t":"ok","rid":3}` 并推送 `state: "idle"`（带 `reason`）；未在队列时取消同样成功。对局已经开始时返回 `ROOM_STARTED`。同盟队列只有创建者能主动取消，取消会让整队退出队列并保留原同盟。

凑齐人数的过程是 0.3.1 的 offer / accept 握手：队列把同难度、能凑成恰好四人的票组成一份 offer，给每个入队者推 `state: "offered"`（带 `offerId`、`deadline`、`accepted`、`acceptedCount`）。每人都要点一次：

```json
{ "t": "queue.accept", "rid": 5, "ticketId": "9f2c…", "offerId": "3ee7…" }
```

最后一位确认者触发房间分配，请求直接回复 `ok` 并推送 `state: "matched"`（带 `code`）；分配失败则直接回复错误码，未过期的票退回 `state: "queued"` 并带 `reason: "allocation_failed"`。默认确认窗口 30 秒（`deadline`），超时 offer 作废、票继续排队；单人最长等待 10 分钟。

已有同盟的创建者仍然发送：

```json
{ "t": "room.matchmaking", "rid": 4 }
```

使用同盟当前难度，要求 1–3 名在线真人、无 AI、其他队员已准备。整队作为**一张不可拆分的票**入队，支持 2+1+1、3+1、2+2 等组合。队列中的同盟通过 `room.state.matchmaking: true` 显示匹配状态，期间不能直接开局。其他玩家可凭同盟密钥加入，成功加入会让整队退出队列，待新队员准备后创建者可重新发起匹配。凑齐四人后保留较早入队同盟的密钥和创建者，其他同盟整体合并进入该房间；观战者一起迁移，合并后观战席仍最多两人。

### 5.2 状态推送

`queue.state` 是**完整快照**，从不发送增量。等待中：

```json
{ "t": "queue.state", "state": "queued", "ticketId": "9f2c…", "difficulty": "NORMAL", "required": 4, "joinedAt": 1791190800000, "deadline": 1791191400000, "partyId": null, "partySize": 1, "partyLeaderId": "p_ab12…", "partyRoomCode": null, "waitingCount": 2 }
```

| 字段 | 说明 |
|---|---|
| `state` | `idle` / `queued` / `offered` / `matched` |
| `ticketId` | 本票标识；`idle` 时为 `null` |
| `difficulty` / `required` / `joinedAt` | 难度、目标人数（固定 4）、入队时间 |
| `deadline` | 本票的过期时间；`offered` 时是 offer 的确认截止时间 |
| `partyId` / `partySize` / `partyLeaderId` / `partyRoomCode` | 同盟票的归属信息；单人票 `partySize: 1`、`partyRoomCode: null` |
| `waitingCount` | 仅 `queued`：同难度、且能保持本队完整时可组合的等待人数，上限 4；不是本站在线人数 |
| `reason` | 票被结束的原因：`cancelled` / `peer_cancelled` / `peer_disconnected` / `expired` / `unavailable` / `allocation_failed` / `superseded` / `shutdown` |
| `offerId` / `accepted` / `acceptedCount` / `allocationPending` | 仅 `offered`：确认窗口、自己是否已确认、已确认人数；分配进行中时带 `allocationPending: true` |
| `code` | 仅 `matched`：已分配的大写房间号 |

其余三种状态：

```json
{ "t": "queue.state", "state": "idle", "ticketId": null, "required": 4, "reason": "expired" }
```

```json
{ "t": "queue.state", "state": "offered", "ticketId": "9f2c…", "difficulty": "NORMAL", "required": 4, "offerId": "3ee7…", "accepted": false, "acceptedCount": 2, "deadline": 1791190830000, "partyId": null, "partySize": 1, "partyLeaderId": "p_ab12…", "partyRoomCode": null }
```

```json
{ "t": "queue.state", "state": "matched", "ticketId": "9f2c…", "offerId": "3ee7…", "difficulty": "NORMAL", "required": 4, "code": "ABCD" }
```

匹配成功自动创建或复用同盟房间并开局，沿用上游 `room.state` 和 `m.public` 进入 `INFO_CHECK`。这些房间 / 对局推送可能先于 `matched` 或请求的直接 `ok` 到达，调用端应独立处理推送和直接回复，不要假定严格的到达顺序。

### 5.3 队列规则与错误

队列仅限同一游戏进程、同难度、主动入队且在线的真人：池内按入队顺序组合，把整队和真人填成**恰好四人**，不补 AI；一个队伍凑不满时不会被拆开。单人 `queue.join` 不要求发送 `room.ready`；已有房间的玩家通过创建者的 `room.matchmaking` 整队入队；观战者不占匹配人数且不能发起匹配。

断线会立即退出队列，重连不会自动重新入队；同盟任一队员断线、离队、被移出或取消准备时整队出队。更改难度、添加 AI 或手动创建、加入其他房间、进入观战席位成功时也退出队列。服务器重启后队列清空；多个进程之间不共享队列。分配失败不会解散队列：已确认且仍健康的票保持原来的入队顺序与过期时间，同盟恢复原来的队员、密钥与准备状态，单人释放临时座位，用户可以直接重试。

`hello` 需要带上队列与容量契约的版本（见第 3 节）：

```json
{ "t": "hello", "rid": 1, "name": "博士", "version": 1, "matchmakingVersion": "alliance-2", "playerCapacityVersion": "capacity-3" }
```

客户端可省略；一旦发送就必须与服务端一致，否则 `hello` 直接返回 `BAD_MSG`（`detail: "matchmaking version mismatch"` / `"player capacity version mismatch"`），客户端应刷新页面重连。

| 错误码 | 触发条件 |
|---|---|
| `BAD_MSG` | 非法难度、不符合消息格式、未完成握手（`detail: "hello required"`）、或版本契约不一致 |
| `QUEUED` | 已在队列中却又改了难度，或先取消再开 / 加入私人房间 |
| `MAINTENANCE` | 服务器暂不接受新的匹配（维护开关） |
| `NOT_READY` | 服务端会话不处于已连接状态，或组队成员离线 / 未准备 |
| `NOT_HOST` | 同盟非创建者发起 / 取消整队匹配 |
| `SPECTATOR` | 观战者发起 / 取消整队匹配 |
| `ROOM_STARTED` | 对局已开始后加入 / 取消匹配 |
| `RATE` | 请求限流、队列已满（默认最多 2000 人）或网络资源限制 |
| `INTERNAL` | 房间分配或对局启动失败等内部错误 |

直接错误回复沿用上游格式，例如：

```json
{ "t": "error", "rid": 2, "code": "ALREADY", "msg": "已完成该操作", "detail": "cancel matchmaking before starting" }
```

`msg` 以实际服务端文本为准，`detail` 可缺省；业务判断使用 `code`。分配失败也可能通过 `queue.state` 的 `reason` 推送反映，不一定表现为请求的直接错误。

`queue.join` / `queue.accept` / `room.matchmaking` 使用原有重请求限流桶，默认每连接每秒补充 2 次、突发容量 6 次，并同时受普通消息桶限制（默认每秒 40 次、突发 40 次）。这些默认值可由程序配置覆盖。

### 5.4 WebSocket 压缩扩展

本分支默认启用可协商的 `permessage-deflate`，设置 `SP_WS_COMPRESSION=off` 可关闭。服务端采用压缩等级 1、1024 字节阈值和不复用消息间压缩上下文的配置；客户端由 WebSocket 实现处理协商与解压，应用层仍收发原有 JSON，不增加消息字段或自定义压缩格式。

## 6. 健康检查与运维诊断

### 6.1 公开接口 `GET /healthz`

`GET /healthz` / `HEAD /healthz` 沿用上游接口；上游字段（`ok`、`version`、`app`、`uptimeSec`、`build`、`runtimeVersion`、`assetsManifest` 与在线统计 `sockets` / `sessions` / `rooms` / `matches` / `humans` / `bots` / `spectators`）语义不变，本分支只增加站点身份与公开计数：

| 新增字段 | 类型 | 含义 |
|---|---|---|
| `artVersion` | string | 本站素材版本，16 位小写十六进制字符串 |
| `assetsCdn` | string / null | 当前素材 CDN 基地址，未配置为 `null` |
| `assetsCdnVersion` | string / null | 配置的远端素材版本，未配置为 `null` |
| `roomProtection` | object | 房间动作限流计数；见 [ROOM_PROTECTION.md](../operations/ROOM_PROTECTION.md) |
| `botPopulation` | object | 机器人人口上限与当前数量 |
| `foreignSessions` | object / null | 海外会话判定统计，未启用为 `null` |

`?build=1` 只返回 `{ build }`（页面的版本守卫用它）；`?traffic=1` 追加本机流量计数，仅回环/私网客户端可得。

**进程自身的性能数据不在这个响应里。** `memory`、`staticCache`、`socketBuffers`、`workers`、`persist`、`wire`、`stateDelta`、`processDiagnostics`、`chatLog`、`rehearsalPressure` 只在 6.2 出现：它们描述的是这台主机，而不是玩家，公开响应既不采集也不发送。因此探针换代后 `/healthz` 的体积明显变小。

### 6.2 运维诊断接口 `GET /metrics`

```http
GET /metrics
HEAD /metrics
```

即时采集完整诊断（不复用 `/healthz` 的一秒缓存），并附带 `websocket` 延迟诊断：

| 字段 | 类型 | 含义 |
|---|---|---|
| `workers` | object / null | 工作线程池统计，未启用为 `null` |
| `persist` | object / null | 持久化统计，未启用为 `null` |
| `memory` | object | 主进程内存（`process.memoryUsage()`；`rss` 覆盖全部线程，其余为该主线程的堆计数，单位字节） |
| `staticCache` | object | 静态缓存占用：`gzipBytes` / `gzipEntries` / `gzipLimitBytes` / `gzipInflight`（gzip LRU），`transformedBytes` / `transformedEntries`（重写响应缓存） |
| `socketBuffers` | object | 全部打开 WebSocket 的未发送字节 `{ total, max }`，排查积压的对端 |
| `wire` | object | 进程启动以来的出站帧计数（`frames` / `bytes` / `byType`），采样两次得速率 |
| `stateDelta` | object | 增量同步记账；见 [STATE_DELTA.md](STATE_DELTA.md) |
| `processDiagnostics` | object | 事件循环 / GC / 进程 CPU 的有界区间窗口；见 [PERFORMANCE.md](PERFORMANCE.md) |
| `chatLog` | object / null | 聊天日志的聚合占用（不含路径与内容）；字段见 [DEPLOY.md](../operations/DEPLOY.md) |
| `rehearsalPressure` | object / null | 演练压力采样器：指标来源、负载百分比、当前档位、候选上限（`null` 表示沿用配置）与阈值 |
| `websocket` | object | WebSocket 延迟诊断（`diagnostics`），仅本接口提供 |

**只有回环或私网客户端能读到它。** 其余调用者不会被拒绝，而是回落到静态文件处理，得到与未知路径相同的 404，所以这条路径对外不暴露自身存在。判定与 `?traffic=1` 一致（`net.js` `clientAddress` + `isLocalIp`，受 `TRUST_PROXY` 影响），因此经隧道或本机反向代理转发来的公网客户端仍算公网。采集端不在本仓库：同机任一进程经回环取 `http://127.0.0.1:<游戏端口>/metrics` 即可，本仓库不附带采集器、探针或面板。

`workers` 对象字段：

| 字段 | 含义 |
|---|---|
| `size` / `threads` / `busy` | 配置线程容量 / 已创建线程数 / 忙碌线程数 |
| `queued` / `maxQueue` / `timeoutMs` | 排队任务数 / 队列上限 / 任务超时毫秒数 |
| `submitted` / `completed` / `failed` / `cancelled` / `rejected` | 各类任务累计计数 |
| `queueMs` / `computeMs` | 累计排队 / 计算毫秒数 |
| `avgComputeMs` | `completed > 0` 时为 `computeMs / completed`，否则为 0 |
| `memory` | 每线程 `{ threadId, busy, sample }` 数组；`sample` 为该线程最近一次回包携带的堆采样（`heapUsed` / `heapTotal` / `external` / `arrayBuffers` / `sampledAt`），尚未回包时为 `null` |
| `lanes` | 仅 `SP_ROOM_WORKERS` 房间泳道池：每条泳道的 `{ id, rooms, ... }` |

`matchWorkers` 对象（仅 `SP_MATCH_WORKERS` > 0 时非 null；对局线程池，见 [DEPLOY.md](../operations/DEPLOY.md)）：`kind: "match-workers"`、`size`（泳道数）、`threads`（存活线程数）、`failedLanes`、`busy`（有请求在途的泳道数）、`queued`、`rooms`（当前跑在池里的对局数），以及逐泳道的 `lanes: [{ id, rooms, pending, failed, load, loadAgeMs, score }]` —— `load` 是该线程自报的 `{ utilization, delayP99Ms, workQueued, serverFields }`。

`persist` 对象字段：`enabled: true`、`backend`（例如 `file`，未声明存储类型时为 `custom`）、`writes`（成功写入次数）、`failures`（失败次数）、`checkpoints`（当前对局检查点数量）、`workerMemory`（持久化 Worker 最近一次回包的堆采样，尚未回包为 `null`）、`deferredSkips`（启动读失败期间被拒绝的写轮次，见 `Persister.deferLoad`）、`pendingLoad`（仍在校验启动时那份存档，`true` 时不会有任何写入）。`persist: null` 表示未启用，不能按 `persist.enabled: false` 读取。成功持久化不代表保存了战斗的精确帧，恢复边界见 [PERSISTENCE.md](../operations/PERSISTENCE.md)。

| 字段 | 含义 |
|---|---|
| `size` / `threads` / `busy` | 配置线程容量 / 已创建线程数 / 忙碌线程数 |
| `queued` / `maxQueue` / `timeoutMs` | 排队任务数 / 队列上限 / 任务超时毫秒数 |
| `submitted` / `completed` / `failed` / `cancelled` / `rejected` | 各类任务累计计数 |
| `queueMs` / `computeMs` | 累计排队 / 计算毫秒数 |
| `avgComputeMs` | `completed > 0` 时为 `computeMs / completed`，否则为 0 |
| `memory` | 每线程 `{ threadId, busy, sample }` 数组；`sample` 为该线程最近一次回包携带的堆采样（`heapUsed` / `heapTotal` / `external` / `arrayBuffers` / `sampledAt`），尚未回包时为 `null` |

`persist` 对象字段：`enabled: true`、`backend`（例如 `file`，未声明存储类型时为 `custom`）、`writes`（成功写入次数）、`failures`（失败次数）、`checkpoints`（当前对局检查点数量）、`workerMemory`（持久化 Worker 最近一次回包的堆采样，尚未回包为 `null`）。`persist: null` 表示未启用，不能按 `persist.enabled: false` 读取。成功持久化不代表保存了战斗的精确帧，恢复边界见 [PERSISTENCE.md](../operations/PERSISTENCE.md)。

## 7. 资源预载清单与版本资源

### 7.1 动态清单

```http
GET /data/resource-manifest.json
HEAD /data/resource-manifest.json
```

示例仅展示两个文件，版本和指纹为示例值：

```json
{
  "format": 1,
  "version": "012345abcdef",
  "count": 2,
  "tier1": 1,
  "sized": 1,
  "totalBytes": 12345,
  "files": [
    { "url": "/_v/0123456789abcdef/fonts/bender-regular.woff2", "tier": 1, "size": 12345, "hash": "abcdef012345" },
    { "url": "/_v/0123456789abcdef/assets/char/portrait/char_002_amiya.png", "tier": 2, "hash": "syn-abcdef012345" }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `format` | 清单格式版本，目前为 1 |
| `version` | 整份清单的版本摘要，目前为 12 位十六进制字符串 |
| `count` / `tier1` | 文件总数 / 第一优先级文件数 |
| `sized` | 已知文件大小的条目数量 |
| `totalBytes` | 已知大小条目的字节数之和；无已知大小时为 `null`，不一定是全部下载大小 |
| `files[].url` | 资源 URL；可能为本站版本路径，也可能为配置的 CDN 绝对地址 |
| `files[].tier` | 1 优先资源（字体、界面、图标、音频等）；2 后台资源（立绘、Spine 等） |
| `files[].size` | 可缺省；本机可确定的文件字节数 |
| `files[].hash` | 缓存复用指纹；服务端动态清单为每项生成，可能是内容摘要或 `syn-` 回退值，不应一律作为文件完整性摘要 |

清单按优先级、URL 排序，随 CDN 配置和资源版本重写 URL。返回 `Cache-Control: no-cache`、`ETag`、`Last-Modified` 与 `Vary: Accept-Encoding`，支持 gzip。ETag 为对完整响应体的 sha256（`"resources-<sha256>"`，gzip 表示为带 `-gz` 后缀）：内容不变时重启或重建保持不变，任何内容变化（含文件大小）都会更换；`If-None-Match`（含弱比较器与列表）或 `If-Modified-Since` 命中时返回 304，浏览器可用 `cache: 'no-cache'` 走再验证而不必整份重下。

生成失败返回 500 HTML 错误页；不支持的方法返回 405 HTML 错误页。该清单只描述资源，不包含房间、对局或玩家状态。

### 7.2 版本路径、素材跨域与 CDN

新增版本命名空间 `/_v/<16 位小写十六进制版本>/<资源路径>`。代码 / 数据使用当前运行版本（原有 `/healthz.build`），素材使用新增的 `/healthz.artVersion`。URL 应从服务端返回的页面或清单获取，避免自行猜测版本。

- 有效版本资源返回 `Cache-Control: public, max-age=31536000, immutable`；HTML 仍为 `no-cache`。
- 版本错误、旧版本或不支持的版本路径返回 404；有效版本下文件自启动后已变更时返回 503，需重启服务器。错误响应为 HTML，并使用 `no-store`。
- 普通 `/assets/`、`/fonts/`、`/vendor/` 文件默认缓存一天；单纯附加 `?v=` 不再使资源进入一年不可变缓存。
- `/assets/`、`/fonts/`、`/media/` 及对应版本素材路径新增公开 CORS：允许 GET / HEAD / OPTIONS、请求头 `Range`，暴露 `ETag, Content-Length, Content-Range, Accept-Ranges`；有效素材预检返回 204，`Access-Control-Max-Age: 86400`。
- API、游戏数据和私有模块未因此开放 CORS；健康检查也没有开放 CORS。

`SP_ASSETS_CDN` 配置素材基地址；素材版本由仓库根目录的 `.assets-manifest.json` 决定，素材 URL 形如 `<基地址>/assets/…?v=<文件哈希>`。只有素材 URL 使用 CDN，API 与 `/ws` 仍请求游戏站点。完整部署说明见 [CDN.md](../operations/CDN.md)。

## 8. 结算消息新增字段

上游 `m.result` 消息保留原有结算内容，本分支增加：

| 字段 | 类型 | 含义 |
|---|---|---|
| `matchId` | string | 一局结算的稳定标识；重连 / 重发不变，接入方应按不透明字符串处理 |
| `startedAt` | number | 服务端对局开始时间，毫秒 |
| `finishedAt` | number | 服务端结算时间，毫秒 |

当前生成方式为 `roomCode + '-' + battlePrefix + '-' + startedAt`，但业务只应依赖其稳定性，以 `matchId` 去重，不应解析内部组成。

这些字段用于浏览器本地战绩；当前没有服务端历史列表、战绩查询、上传、删除或完整录像 API。服务器检查点持久化也没有公开保存 / 恢复 HTTP API。战绩范围见 [MATCH_HISTORY.md](../guides/MATCH_HISTORY.md)。

### 私有房间管理

配置 `SP_ROOM_ADMIN_TOKEN` 后，游戏在独立回环端口（默认 `127.0.0.1:3001`）开放 `GET /api/rooms`、`GET/PUT /api/room-config` 和 `POST /api/rooms/:code/close`，必须携带 Bearer 密钥。不能公开转发此端口；探针与面板接入见 [ROOM_PROTECTION.md](../operations/ROOM_PROTECTION.md)。

配置读接口及列表的 `config` 返回 `maxRooms` 和 `allowBots`。写接口支持部分更新 `{"maxRooms":1000}` / `{"allowBots":false}`，也可同时提交；上限为 1–10000 整数，AI 开关为布尔值，空对象及未知字段拒绝。保存成功后实时生效并持久化，保存失败返回 503 且不改变运行时设置。

`room.state.allowBots` 表示是否允许新增 AI（旧服务器未提供时客户端按允许处理）。禁用时 `room.addBot` 返回 `BOTS_DISABLED`；已有 AI、进行中对局和断线自动接管不受影响。

配置 GeoLite 后，海外同 IP 已有其他在线身份时 `hello` 返回 `FOREIGN_SESSION_LIMIT`，不创建新身份、不踢原玩家。有效 token 的本身份重连保持原规则；旧身份断线时允许新建，并清理旧席位和撤销旧 token。`/healthz` 的 `foreignSessions` 提供启用状态及拒绝/回收计数，不提供 IP 配额键。详见 [ROOM_PROTECTION.md](../operations/ROOM_PROTECTION.md)。

`SP_FOREIGN_SESSION_LIMIT=on/off` 设置默认开关；本机管理接口 `PUT /api/room-config` 支持 `{ "limitForeignSessions": false }`，实时生效并持久化。读取配置另含只读 `foreignSessionGeoipAvailable`，不能通过 PUT 修改。健康指标区分 `configured`（开关）、`geoipAvailable`（国家库）和 `enabled`（实际生效）。

`room.addBot` 检查实时 AI 席位存量：全服合计达到 300 个返回 `AI_POPULATION_LIMIT`；配置私有 GeoLite Country 数据库后，海外来源（非 `CN`，含港澳台）共用 50 个名额，达到后新的海外请求返回 `FOREIGN_AI_POPULATION_LIMIT`。全服限制优先且不依赖 GeoLite。两种拒绝都不关闭房间或删除已有 AI；备战和运行中都计数，移除、销毁释放名额，存档恢复重建计数。健康接口 `botPopulation` 提供当前存量与上限，详细配置见 [ROOM_PROTECTION.md](../operations/ROOM_PROTECTION.md)。

## 9. 房间分享与联机站

房主可以把一间**仍有空位、未开局、未排队**的协力房间公开到联机站，让其他玩家按房间码加入。目的地与凭据全部来自服务器启动配置，请求体里没有「发给哪个站」这种字段。

### 9.1 `GET /api/portal-room`

无需会话。返回 `{ enabled, mode, available }`：

| 字段 | 说明 |
|---|---|
| `enabled` | 本站是否开放分享（`off` 模式为 `false`，界面隐藏入口） |
| `mode` | `off` / `legacy-http` / `agent`（见 [PORTAL_ROOMS.md](../operations/PORTAL_ROOMS.md)） |
| `available` | 链路是否可用。`agent` 模式下是本机对 Agent 的 15 秒缓存探测结果（不打中央接口）；配置了但不可用时界面显示「暂不可用」并允许重试 |

不返回 URL、站点 ID、密钥或任何房间信息。

### 9.2 `POST /api/portal-room`

同源 JSON，`Authorization: Bearer <当前游戏会话 token>`，请求体 `{"code":"ABCD"}`（最大 128 字节）。

服务端依次检查：功能已配置 → 会话在线 → 当前房主 → 房间处于可加入的待机状态 → 同源 → 限流（同房间一分钟、全服 4 个在途）。提交前后各确认一次房间**实例**，晚回执不会写进新房间的界面。

| 响应 | 含义 |
|---|---|
| `200 {ok:true, registered:true, expiresAt, remainingMs, opId, listingId?}` | 联机站确认收录（`expiresAt` 由中央裁定，十分钟） |
| `202 {ok:false, status:'pending', opId}` | **发出去了但结果未知**（回执丢失）。必须保留 `opId` 并用 §9.3 查询，**不能**当作失败 |
| `409 {code:'ROOM_CHANGED'\|'ROOM_NOT_JOINABLE'\|…}` | 确定被拒，可显示失败文案 |
| `429` / `503` / `502` | 限流 / 链路不可用 / 其它；响应体带业务码与可重试标记 |

`legacy-http` 模式的成功回执只有 `{ok:true, registered:true}`（没有 `expiresAt`），并且**没有** §9.3 的查询接口。界面不得用 `response.ok` 判断是否已收录，必须看 `registered`。

### 9.3 `GET /api/portal-room/status?code=ABCD`

同源，`Authorization: Bearer <当前游戏会话 token>`，仅**当前房主**可查本站当前实例。`agent` 模式返回：

| `state` | 含义 |
|---|---|
| `registered` | 在册，含 `expiresAt` 与 `remainingMs` |
| `ended` | 曾经登记、现在已撤下或过期 |
| `absent` | 查不到这条申请（确定没登记） |
| `pending` | 上一次申请还没有定论（保留 `opId`） |
| `unknown` | 查询本身失败（`503`），**不是**「没登记」 |

`legacy-http` 模式返回 `501 本站不支持登记状态查询`（该模式没有这条读接口，不编造结论）；`off` 模式返回 `503`。

### 9.4 房间实例号

`room.state`、`GET /api/rooms/<code>/status` 与联机站的私有状态端点都会带 `roomId`（房间**实例** UUID）。房间码会被复用，只有实例号能区分「同一间房」与「同码的新房」。它只是标识、不是凭据：公开状态接口本来就能读到。旧存档没有这个字段时服务器补一枚并尽快落盘，不视为开新对局。

关房与登记都按实例绑定：`POST /api/rooms/:code/close` 接受 `{roomId, createdAt, expiresAt}`，实例不一致或一个凭据都不给返回 `409 ROOM_CHANGED`；`expiresAt` 已过期则**不执行**（`200 {closed:false, code:'DEADLINE_EXCEEDED'}`）；执行成功返回 `{closed:true, roomCode, roomId, createdAt}` —— 调用方只有看到 `closed:true` 才应记为成功。

### 9.5 私有房间状态端点（Agent 用）

配置 `SP_ROOM_ADMIN_TOKEN` 后，本机回环管理端口另有联机站专用入口，参数最多二十项、只回答问题里问到的房间（从不枚举其它房间），且**不**包含座位名、玩家 ID 或 IP：

- `GET /api/portal/rooms/:code/status` → `{state:'ok', roomId, createdAt, gameBootId, room:{code,roomId,mode,difficulty,difficultyName,capacity,occupied,humans,inMatch,joinable,phase,round}}`；房间不在时 `{state:'closed', roomId:null}` —— 调用方必须能区分「问过了，没有」与「没问成」（后者是 4xx/5xx/超时）。
- `POST /api/portal/rooms/status-batch`：`{"items":[{"listingId","code","roomId"}]}`，1–20 项，整批拒绝畸形条目，逐项返回同一个投影。

## 10. 实现出处与验证

| 契约 | 实现 / 已有测试 |
|---|---|
| HTTP 路由、响应头、资源缓存 | [server/index.js](../../server/index.js)、[test/asset-version.test.js](../../test/asset-version.test.js)、[test/asset-cdn.test.js](../../test/asset-cdn.test.js) |
| 房间状态、限流 | [server/roomStatus.js](../../server/roomStatus.js)、[test/room-status.test.js](../../test/room-status.test.js) |
| 公告 | [server/announcement.js](../../server/announcement.js)、[test/announcement.test.js](../../test/announcement.test.js) |
| 匹配、延迟探测、难度名称 | [server/matchmaking.js](../../server/matchmaking.js)、[server/lobby.js](../../server/lobby.js)、[shared/protocol.js](../../shared/protocol.js)、[test/matchmaking.test.js](../../test/matchmaking.test.js) |
| 资源清单 | [server/resources.js](../../server/resources.js)、[test/resources/manifest.test.js](../../test/resources/manifest.test.js) |
| 结算扩展 | [server/match/results.js](../../server/match/results.js)、[test/match/results.test.js](../../test/match/results.test.js) |
| 房间分享、联机站状态端点 | [server/http/portalRoom.js](../../server/http/portalRoom.js)、[test/portal-room.test.js](../../test/portal-room.test.js)、[test/portal-room-agent.test.js](../../test/portal-room-agent.test.js)、[test/portal-room-config.test.js](../../test/portal-room-config.test.js)、[test/portal-room-admin.test.js](../../test/portal-room-admin.test.js) |
| 配置版本与 CAS、实例号关房 | [server/roomConfig.js](../../server/roomConfig.js)、[server/roomAdmin.js](../../server/roomAdmin.js)、[test/room-config-v2.test.js](../../test/room-config-v2.test.js) |

可在项目根目录运行已有接口测试核对契约：

```sh
node --test test/room-status.test.js test/matchmaking.test.js test/announcement.test.js test/asset-version.test.js test/asset-cdn.test.js test/resources/manifest.test.js test/match/results.test.js test/ws-compression.test.js
```

### 昵称预检

`POST /api/nickname/validate`，同源 JSON 请求 `{"name":"正常博士"}`，成功为 200 `{"ok":true}`，敏感昵称为 422 `{"ok":false,"code":"NICKNAME_SENSITIVE"}`。所有结果 `Cache-Control: no-store`，不回显昵称、匹配词或词表。客户端只有收到成功才保存昵称和进入；登录 `hello` 仍执行同款校验。

仅支持 POST；请求体最大 1 KiB、读取超时 5 秒；格式错误 400、方法错误 405、超时 408、过大 413、非 JSON 415、限流 429。限流响应附 `Retry-After: 1`，按与 WebSocket 相同的可信代理/网络策略独立限流（每秒补充 2 次、突发 10 次）。无 CORS 授权，浏览器跨站请求拒绝。运行时只读服务端随包词库，不调用外部服务。
