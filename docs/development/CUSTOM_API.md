# 本分支服务端 API 规范

整理日期：2026-10-05。实现版本：`master`，提交 `bf91444`，应用版本 `0.1.3`，WebSocket 协议版本 `1`。

本文只收录本分支相对已合并的上游 `sganggs/Stronghold-Protocol` **v0.1.3（`a0a5419`）** 新增或修改的对外接口。核对依据是 `git diff v0.1.3 HEAD` 和当前源码；本地 `origin/master` 仍停留在较早的 `bdb0765`，不能仅按它的差异判断哪些接口属于本分支。

普通建房、加入、准备、开局、踢人、观战、战斗操作以及原有健康检查字段均属于上游接口，本文不重复定义。资源预载、工作线程与持久化部分包含从其他分支移植并适配的实现；这里的“本分支”表示相对上述上游的扩展，并不表示全部代码均为原创。本文描述本地代码契约，线上站点是否已部署此版本需另行核对。

## 1. 接口总览与公共约定

| 接口 | 类型 | 本分支扩展 | 跨域读取 |
|---|---|---|---|
| `/api/rooms/:code/status` | HTTP GET / HEAD | 按房间号查询公开状态，含难度名称 | 未开放 CORS |
| `/api/ping` | HTTP GET / HEAD / OPTIONS | 无会话的 HTTP 延迟探测 | `Access-Control-Allow-Origin: *` |
| `/api/announcement` | HTTP GET / HEAD | 读取当前维护公告 | 未开放 CORS |
| `/healthz` | HTTP GET / HEAD | 增加素材版本、CDN、工作线程、持久化信息 | 未开放 CORS |
| `/data/resource-manifest.json` | HTTP GET / HEAD | 动态生成资源预载清单 | 未开放 CORS |
| `/_v/:version/...` 及素材路径 | HTTP 资源请求 | 版本缓存、素材 CORS | 仅素材开放 CORS |
| `/ws` → `matchmaking.join` / `room.matchmaking` / `matchmaking.cancel` | WebSocket JSON | 四人同站匹配，支持组队补齐 | 按原有 WebSocket 连接规则 |
| `/ws` ← `matchmaking.state` | WebSocket JSON | 推送匹配进度与结果 | 按原有 WebSocket 连接规则 |
| `/ws` ← `m.result` | WebSocket JSON | 增加稳定的结算 ID 和时间 | 按原有 WebSocket 连接规则 |

以下示例以 `http://localhost:3000` 为服务基地址；实际接入时替换为游戏站点地址。所有路径相对于游戏服务根路径，反向代理应把 API 和 `/ws` 转发到对应游戏进程。

HTTP 查询接口无需账号、Cookie 或访问令牌，不创建游戏会话，也不占用玩家席位。WebSocket 匹配接口需要先完成原有 `hello` 握手。

除资源清单和静态资源外，表中 HTTP JSON 接口统一返回 `Content-Type: application/json; charset=utf-8` 和 `Cache-Control: no-store`。`HEAD` 返回与对应请求相同的状态码和响应头，但没有响应体。未开放 CORS 的接口可由同源页面或外部服务的后端读取，独立域名的浏览器页面不能直接跨域读取。

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

接口只查询指定房间，**没有房间列表、搜索或分页接口**。房间号只是分享码，持有码即可查到昵称等公开状态，无需加入房间。

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

存在有效公告时返回 200：

```json
{
  "announcement": {
    "id": "0123456789abcdef01234567",
    "title": "维护公告",
    "text": "服务器将在公告截止时间进行维护。",
    "expiresAt": 1791194400000
  },
  "serverTime": 1791190800000
}
```

`id` 为公告公开内容的 SHA-256 摘要前 24 位十六进制字符串；标题、正文或截止时间变化会改变 ID，可用于区分玩家已关闭的旧公告。`expiresAt` 和 `serverTime` 均为毫秒时间戳。

公告关闭、过期、文件不存在或配置无效时，仍返回 200：

```json
{ "announcement": null, "serverTime": 1791194400000 }
```

没有公告写入 API。POST / PUT / DELETE / OPTIONS 等方法返回 405、`Allow: GET, HEAD`，响应体为 HTML 错误页。

默认来源为管理面板中央 feed：`SP_PORTAL_URL` 默认 `https://game.rainya.me`，`SP_SITE_ID` 默认西安站 `site-ad797aa8`；显式完整 `SP_ANNOUNCEMENT_URL` 优先。空 URL 或已有本地文件不会切换来源。响应额外包含 `source: { mode, siteId }`，便于核对当前配置；它不表示上游读取成功。仅显式设置 `SP_ANNOUNCEMENT_SOURCE=file` 才通过 `SP_ANNOUNCEMENT_FILE` 热读本地配置，默认项目根目录 `announcement.json`；文件最多 16 KiB，读取缓存默认 1 秒。部署说明统一见 [ANNOUNCEMENTS.md](../operations/ANNOUNCEMENTS.md)。

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

### 5.1 加入 / 取消

```json
{ "t": "matchmaking.join", "rid": 2, "difficulty": "NORMAL" }
```

`difficulty` 必填，使用第 1 节的四个枚举。成功直接回复 `{"t":"ok","rid":2}`，匹配进度另行推送。重复加入相同难度不增加人数、不重置入队时间；改选难度会退出旧队列并重新入队。

```json
{ "t": "matchmaking.cancel", "rid": 3 }
```

取消成功回复 `{"t":"ok","rid":3}` 并推送 `idle`。未在队列时取消也成功；对局已经开始时返回 `ROOM_STARTED`。同盟队列仅创建者可主动取消，取消会让整队退出队列并保留原同盟。

已有同盟的创建者可发送：

```json
{ "t": "room.matchmaking", "rid": 4 }
```

使用同盟当前难度，要求 1–3 名在线真人、无 AI、其他队员已准备。整队进入队列，不拆散队员；支持 2+1+1、3+1、2+2 等组合。队列中的同盟通过 `room.state.matchmaking: true` 显示匹配状态，暂停直接开局。其他玩家可凭同盟密钥加入，成功加入会让整队退出队列，待新队员准备后创建者可重新发起匹配。凑齐四人后保留较早入队同盟的密钥和创建者，其他同盟合并进入该房间；观战者一起迁移，合并后观战席仍最多两人。

### 5.2 状态推送

等待中：

```json
{ "t": "matchmaking.state", "status": "searching", "difficulty": "NORMAL", "joinedAt": 1791190800000, "players": 2, "target": 4, "serverNow": 1791190810000 }
```

| 字段 | 说明 |
|---|---|
| `status` | `searching` / `idle` / `matched` / `failed` |
| `serverNow` | 每种状态均有，服务器时间 |
| `difficulty` | `searching`、`matched`、`failed` 时有 |
| `joinedAt` | 仅 `searching`，当前难度入队时间 |
| `players` | 仅 `searching`，保持本队完整且符合观战席容量时可组合的同难度队列人数，上限 4；不是本站在线人数 |
| `target` | 仅 `searching`，固定为 4 |
| `code` | 仅 `matched`，已分配的大写房间号 |
| `error` | 仅 `failed`，分配 / 启动失败错误码 |

其余状态示例：

```json
{ "t": "matchmaking.state", "status": "idle", "serverNow": 1791190810000 }
```

```json
{ "t": "matchmaking.state", "status": "matched", "difficulty": "NORMAL", "code": "ABCD", "serverNow": 1791190810000 }
```

```json
{ "t": "matchmaking.state", "status": "failed", "difficulty": "NORMAL", "error": "RATE", "serverNow": 1791190810000 }
```

匹配成功自动创建或复用同盟房间并开局，沿用上游 `room.state` 和 `m.public` 进入 `INFO_CHECK`。这些房间 / 对局推送可能先于 `matched` 或请求的直接 `ok` 到达，调用端应独立处理推送和直接回复，不要假定严格的到达顺序。

### 5.3 队列规则与错误

队列仅限同一游戏进程、同难度、主动入队且在线的真人，优先按入队顺序选择能完整凑齐 4 人的队伍，不补 AI。单人 `matchmaking.join` 不要求发送 `room.ready`，已有房间的玩家通过创建者的 `room.matchmaking` 整队入队；观战者不占匹配人数且不能发起匹配。

断线会立即退出队列，重连不会自动重新入队；同盟任一队员断线、离队、被移出或取消准备时整队出队。更改难度、添加 AI 或手动创建、加入其他房间、进入观战席位成功时也退出队列。服务器重启后队列清空；多个进程之间不共享队列。分配失败移除该组的排队记录，已有同盟恢复原来的队员、密钥与准备状态，单人释放临时座位，用户可重新加入。

| 错误码 | 触发条件 |
|---|---|
| `BAD_MSG` | 非法难度、不符合消息格式，或尚未完成握手（`detail: "hello required"`） |
| `NOT_READY` | 服务端会话不处于已连接状态，或组队成员离线 / 未准备 |
| `ALREADY` | 用户已在房间中，包括观战者 |
| `RATE` | 请求限流、队列已满（默认最多 2000 人）或网络资源限制 |
| `ROOM_STARTED` | 对局已开始后加入 / 取消匹配 |
| `NOT_HOST` | 同盟非创建者发起 / 取消整队匹配 |
| `SPECTATOR` | 观战者发起 / 取消整队匹配 |
| `INTERNAL` | 房间分配或对局启动失败等内部错误 |

直接错误回复沿用上游格式，例如：

```json
{ "t": "error", "rid": 2, "code": "ALREADY", "msg": "已完成该操作", "detail": "leave your room before matchmaking" }
```

`msg` 以实际服务端文本为准，`detail` 可缺省；业务判断使用 `code`。分配失败也可能通过 `matchmaking.state.error` 推送，不一定表现为加入请求的直接错误。

`matchmaking.join` 和 `room.matchmaking` 使用原有重请求限流桶，默认每连接每秒补充 2 次、突发容量 6 次，并同时受普通消息桶限制（默认每秒 40 次、突发 40 次）。这些默认值可由程序配置覆盖。

### 5.4 WebSocket 压缩扩展

本分支默认启用可协商的 `permessage-deflate`，设置 `SP_WS_COMPRESSION=off` 可关闭。服务端采用压缩等级 1、1024 字节阈值和不复用消息间压缩上下文的配置；客户端由 WebSocket 实现处理协商与解压，应用层仍收发原有 JSON，不增加消息字段或自定义压缩格式。

## 6. 原有健康检查的新增字段

`GET /healthz` / `HEAD /healthz` 沿用上游接口，只增加以下字段。原有 `ok`、`version`、`app`、`build`、在线统计等字段不在这里重新定义。

| 新增字段 | 类型 | 含义 |
|---|---|---|
| `artVersion` | string | 本站素材版本，16 位小写十六进制字符串 |
| `assetsCdn` | string / null | 当前素材 CDN 基地址，未配置为 `null` |
| `assetsCdnVersion` | string / null | 配置的远端素材版本，未配置为 `null` |
| `workers` | object / null | 工作线程池统计，未启用为 `null` |
| `persist` | object / null | 持久化统计，未启用为 `null` |
| `memory` | object | 主进程内存（`process.memoryUsage()`；`rss` 覆盖全部线程，其余为该主线程的堆计数，单位字节） |
| `staticCache` | object | 静态缓存占用：`gzipBytes` / `gzipEntries` / `gzipLimitBytes` / `gzipInflight`（gzip LRU），`transformedBytes` / `transformedEntries`（重写响应缓存） |
| `socketBuffers` | object | 全部打开 WebSocket 的未发送字节 `{ total, max }`，排查积压的对端 |

`workers` 对象字段：

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

## 9. 实现出处与验证

| 契约 | 实现 / 已有测试 |
|---|---|
| HTTP 路由、响应头、资源缓存 | [server/index.js](../../server/index.js)、[test/asset-version.test.js](../../test/asset-version.test.js)、[test/asset-cdn.test.js](../../test/asset-cdn.test.js) |
| 房间状态、限流 | [server/roomStatus.js](../../server/roomStatus.js)、[test/room-status.test.js](../../test/room-status.test.js) |
| 公告 | [server/announcement.js](../../server/announcement.js)、[test/announcement.test.js](../../test/announcement.test.js) |
| 匹配、延迟探测、难度名称 | [server/matchmaking.js](../../server/matchmaking.js)、[server/lobby.js](../../server/lobby.js)、[shared/protocol.js](../../shared/protocol.js)、[test/matchmaking.test.js](../../test/matchmaking.test.js) |
| 资源清单 | [server/resources.js](../../server/resources.js)、[test/resources/manifest.test.js](../../test/resources/manifest.test.js) |
| 结算扩展 | [server/match/results.js](../../server/match/results.js)、[test/match/results.test.js](../../test/match/results.test.js) |

可在项目根目录运行已有接口测试核对契约：

```sh
node --test test/room-status.test.js test/matchmaking.test.js test/announcement.test.js test/asset-version.test.js test/asset-cdn.test.js test/resources/manifest.test.js test/match/results.test.js test/ws-compression.test.js
```
