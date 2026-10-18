# 服务端断点恢复

游戏安装和统一配置从[部署指南](DEPLOY.md)开始；本文说明对局数据的保存、备份与恢复。

与浏览器本地战绩不同，这个功能保存正在进行的服务端对局。检查点与恢复逻辑移植自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol/tree/20524bb07dff68743980ec8e6b4a8e458f3720b6)，遵循 GPL-3.0-or-later；本仓库增加原子文件存储、独占写入锁、开战前检查点、关服写入等待、观战与结算补推恢复、持久化 Worker，以及分片存储（文件目录与 Redis 多键两套，见下）。

## Redis（可选持久化）

状态除了 `SP_STATE_FILE` 之外还能放在 Redis 里；连接层取自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol) 的 `server/redis.js`（逐字，本分支只往里加了四个按键读写的原语），存储布局是 `server/redisState.js`。优先级是：**Redis → `SP_STATE_FILE` → 内存**；只要配了 Redis URL 就不再写文件。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SP_REDIS_URL` / `REDIS_URL` | （空，不启用） | 只有 `rediss://`、`redis://`、`unix:` 会被接受；其他值当作未配置 |
| `SP_REDIS_PREFIX` | `stronghold:` | 键前缀。**一个前缀只给一个游戏服**：两个进程连同一个前缀会互相覆盖 |
| `SP_REDIS_TTL` | `90000`（25 小时） | 每次写都刷新过期时间，单位秒；小于 60 的值忽略。25 小时是「最长重连窗口」的下限 |
| `SP_REDIS_CONNECT_TIMEOUT` | `3000` | 连接超时（毫秒），0 表示不限；启动读重试 4 次、间隔 750 ms |
| `SP_REDIS_COMMAND_TIMEOUT` | `4000` | 单条命令超时（毫秒），0 表示不限 |

现成的 compose 与 `redis.conf` 在 [`deploy/redis/`](../../deploy/redis/README.md)：`docker compose -f deploy/redis/docker-compose.yml up -d` 起一台 Valkey，游戏侧只加 `SP_REDIS_URL` 与 `SP_REDIS_PREFIX` 两个变量。

### 键布局：和文件目录布局一一对应

一个文件一个键，所以两种后端读回的形状完全相同，`restoreServer` 不需要分支：

| 键 | 内容 | 什么时候写 |
| --- | --- | --- |
| `<前缀>index` | 会话、房间、对局元数据 | 元数据变了才写（`Persister` 传的 `metadataVersion` 或元数据的规范化 JSON 与上次提交的不同） |
| `<前缀>runtime` | 各对局时钟、`savedAt`、索引版本 | 每轮刷（很小，通常几百字节） |
| `<前缀>cp:<房间码>` | 一个房间的检查点（带信封：版本、对局序号、分片自带时钟） | 正文变了才写 |
| `<前缀>state` | 旧版「一个键一份整份文档」 | 只在 `index` 不存在时读一次；之后按上表写，旧键保留做回滚副本 |

**写入顺序**（几份键之间的崩溃一致性）：分片 → `index` → `runtime` → 删除不再被点名的分片。索引永远晚于它点名的分片落地，所以崩在任何一步都不会出现「索引点名一个不存在的分片」；反过来「分片比索引新」由 `runtime` 里的索引版本与分片信封里自带的时钟兜住 —— 和文件后端用的是同一套信封。

**值编码**：小于 1 KiB 直接存 JSON 文本（前缀 `J:`），超过就用 zlib `deflateRaw` 再 base64（前缀 `Z:`）。压缩走 libuv 线程池，不占 Worker 也不占游戏线程；读回有 64 MiB 上限，一个坏键或外来键不能让进程把它 inflate 到爆内存。没有前缀标记的值原样交给 `JSON.parse`（旧版文档、别人的键都是这条路）。

**失败与退让**：`load()` 把「没应答」和「不存在」分开（`undefined` / `null`）。读不出来时 `Persister` 进 `deferLoad`，之后每轮写之前重读一次，读到才恢复并继续写 —— 一盏起不来的 Redis 不会让第一次存档把真正的存档覆盖掉。`/metrics.persist` 的 `pendingLoad` / `deferredSkips` 就是这件事的状态与计数。单个检查点坏了只丢那个房间的对局，其余照常恢复。

- 对局跑在 lane 线程里时，存档是跨线程 `capture` 拍的，且不做版本跳过：[性能说明](../development/PERFORMANCE.md)。

### 小机器（4 核 4 GB）

一台 4c4g 上三个进程抢内存：游戏主线程、`SP_WORKERS` 个模拟线程（每个线程独立加载一份游戏数据）、以及 Redis 自己。可用的配置：

```conf
# redis.conf —— 状态是「能续上最好，续不上重开」的数据，不值得为它冒 OOM 的险
maxmemory 384mb
maxmemory-policy volatile-ttl     # 所有状态键都带 TTL，先淘汰最旧的检查点
appendonly no                     # 丢了就从空状态起，不影响玩家重开
save ""
```

```sh
SP_REDIS_URL=redis://127.0.0.1:6379 SP_REDIS_PREFIX=stronghold: \
SP_WORKERS=2 SP_MATCH_WORKERS=0 SP_ROOM_WORKERS=0 \
SP_STATE_SAVE_MS=15000 npm start
```

- `SP_WORKERS` 默认 `min(8, 核数-2)`，4 核就是 2；每多一个线程多一份游戏数据的常驻内存，机器小就往小调。
- 房间数很少时把 `SP_STATE_SAVE_MS` 放宽到 15–20 秒：它是整份 `runtime` 的刷新周期，检查点本身只在内容变化时才写。
- 用 Valkey 还是 Redis 都行（同一套 RESP 与命令），镜像体积与许可证按自己的偏好挑。

### 线协议层面的验证（不需要真的 Redis）

`test/redis-wire.test.js` 起一个最小的 RESP 服务器（只用 `node:net`），让 `server/redis.js` 里真正的 `redis` 客户端连上去，跑完整条路：`HELLO 3` 的 RESP3 握手、`CLIENT SETINFO`、每个键的 `SET key value EX 60`、用 `MGET` 把几个检查点一次读回、换一个新 store 实例把文档读回来、`DEL` 清理；再验证「同一份输入第二轮一个 `SET` 都不发」、坏分片被跳过而不写成垃圾，以及 Redis 挂掉时 `load` 返回 `null` 且 `loadState='unavailable'`、`save` 返回 `false` 而不是抛，恢复后原来的文档还在。不需要真 Redis 的键布局、写入顺序与压缩用例在 `test/redis-state.test.js`。

写这类测试要注意一件事：`redis` 客户端保持的 socket 会让 `node --test` 不退出。用例结束时必须 `await store.close()`（以及关掉假服务器），否则整套测试会挂住而不是失败 —— 第一次写这个用例就是这么卡了五分钟。

## 启用与升级

`npm start` 默认开启，保存于仓库 `.state/server-3000`（端口不同则目录名不同）。每 10 秒刷新一次，在开局和开战前额外检查保存，正常关服先等待已有写入，再写最后一次状态，然后关闭房间。

生产环境建议配置固定的私有路径，升级时继续使用同一路径。例如：

```sh
SP_STATE_FILE=/var/lib/stronghold/game npm start
```

Windows PowerShell：

```powershell
$env:SP_STATE_FILE='E:\stronghold-data\game'
npm start
```

`SP_STATE_SAVE_MS` 调整周期，最短 1000 毫秒，默认 10000。`SP_STATE_FILE=off` 关闭持久化。程序调用 `startServer()` 时默认不创建文件；传入 `stateFile` 或 `store` 启用，`store: null` 显式关闭，方便测试与嵌入使用。

升级流程：正常停止旧进程，备份状态文件，更新代码与依赖，再启动新进程。不要删除 `.state/`，也不要运行两个进程同时写同一路径。检查 `/metrics.persist`（只对本机回环 / 私网应答）的 `enabled`、`mode`、`writes`、`failures`、`checkpoints`；`failures` 增长说明保存有问题。不能在旧版首次升级前自动取回旧进程尚未写盘的内存，请等那批对局结束后部署此功能。

## 存储布局与持久化 Worker

按 `SP_STATE_FILE` 的形态自动选择，无需配置：

- **分片目录**（默认，路径不以 `.json` 结尾）：`index.json` 只保存身份、房间和座位等元数据，内容变化才重写；`runtime.json` 保存各对局时钟和服务器最后存活时间，每个保存周期原子刷新；`matches/<房间码>.json` 每房一个检查点分片，内容变化才重写。休整期倒计时变化或作战期间的存活刷新都只写较小的 runtime，不再重写整份 index。index 的 `savedAt` 是最后一次元数据保存时间；恢复在线身份使用 runtime 的最新存活时间，已经断线的身份仍使用实际断线时间，停机时间仍计入重连窗口。
- **单文件**（路径以 `.json` 结尾，或该路径已是文件）：经典的单 JSON 文档布局，行为与旧版本一致，Docker 与已有部署不受影响。检查点编码同样走 Worker，只是落盘仍是整份文档。
- **旧版迁移**：已有的旧分片目录（时钟在 index 中）可直接读取，下次保存自动升级为 index/runtime 分离布局。若分片目录下没有 `index.json`，会自动读取旁边的旧单文件（`.state/server-3000.state.json`）完成恢复，之后的新写入进入分片布局；旧单文件保留作为回滚副本。升级前备份整个目录；回滚旧程序时应使用升级前备份，新分片信封不供旧程序读取。

无论哪种布局，检查点的**编码与 JSON 校验都在专用持久化 Worker 线程**完成（`server/workers/persistence.js`）；主线程仍需捕获字段及编码元数据，Worker 崩溃或超时自动降级为同步检查点编码。写轮次按 `SAVE_MS`（默认 10 秒）合并，检查点事件预约下一个写槽。目录模式按「分片 → 必要的 index → runtime」写入：分片带本次检查点版本、局数和初始时钟，runtime 的时钟引用对应分片版本，并引用 index 版本。保存中断时只合并版本匹配的时钟，否则使用分片自带时钟；尚未提交的新一局不会挂到旧房间。废弃分片在元数据提交成功后才删除。每个文件独立原子替换，整轮保存不是跨文件事务，崩溃可能恢复到已写入的部分进度。失败不会更新对应的已保存缓存，下一轮继续重试。

**未变化的对局不再重复编码**（2026-10，`snapshot.persistVersion`）：每局有一个便宜的持久化版本号（`markPublic`/`markPrivate` 的变更计数 + 直接读取的持久化标量面 + 六个 RNG 位置 + 共享池 revision）。与已落盘分片同一版本时只刷新时钟信封，跳过字段捕获、跨线程结构化克隆、编解码与 JSON 往返；分片字节不变，因此也不会重写。房间结束、换局或房间消失时丢弃版本号。`SP_PERSIST_VERIFY=1`（或构造参数 `verifyVersion`）打开反向自证：版本说没变时照常编码并与已存 body 逐字节比对，不同则计入 `versionHoles`、告警并提交新 body。`/metrics` 的 `persist` 暴露 `checkpointsEncoded` / `checkpointsSkipped` / `versionChecks` / `versionHoles`，采样复核用；`versionHoles` 应长期为 0。测量与复现见 [同步链路基线](../development/STATE_SYNC_BENCHMARK.md)。

单个分片损坏只影响该房间（对局回到大厅），不阻止整个服务器启动；index 或 runtime 损坏会阻止启动并保留原文件。首次保存若在 index 写完、runtime 创建前中断，允许使用 index 时间和分片初始时钟恢复。

## 恢复范围

- 玩家身份、昵称、调配、房间、座位、AI 队友、观战者、准备状态、局数和待补发结算。
- 0.2.3 开局重刷编号、待完成投票和已同意玩家随信息确认检查点保存；投票恢复期间倒计时继续暂停。自选干员、剩余库存、重刷后的禁用状态和机器人表情记录也会保留，旧检查点缺少新增字段时使用默认值。
- 对局的信息确认、策略轮选、机变轮选、回合开始或休整期检查点：棋盘、手牌、商店、资金、生命值、装备、盟约、效果、悬赏、卡池和所有随机数流位置。
- 作战、联防、最终攻势或隐秘核心进行中重启：恢复最近一个安全阶段，不保存战斗的精确帧，会重打该回合。异常强制结束进程可能丢失最近尚未成功落盘的操作。
- 恢复休整期后，人类玩家重新准备；多人至少有 20 秒休整时间，独立模拟或仅一名真人的同盟仍无倒计时。暂停状态不恢复。
- 同盟身份重连窗口通常为 10 分钟，独立模拟 24 小时；停机时间计入窗口。恢复后过期身份及对应座位会移除。
- 检查点格式有独立版本号，代码版本变化本身不会清空存档。改变存档结构时需要迁移；不兼容的文档或损坏的 index 会阻止启动并保留原文件，不自动覆盖；单个分片损坏只丢弃该房间的对局恢复。

状态文件包含私有重连令牌，必须保存在静态目录以外，不能上传到 Git 或公开备份。默认目录已加入 Git 与 Docker 构建忽略列表。写入先同步临时文件，再原子重命名覆盖旧文件；单个文件写入失败会保留该文件的旧版本。锁文件避免多个本机进程互相覆盖，进程被强制终止后会检测并回收残留的锁。

## Docker

容器使用 `/app/.state/server.state.json`，目录已授权给 `node` 用户。升级重建容器时必须挂载同一个持久卷：

```sh
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v stronghold-state:/app/.state stronghold-protocol
```

Compose：

```yaml
services:
  stronghold:
    image: stronghold-protocol
    ports: ["3000:3000"]
    volumes: ["stronghold-state:/app/.state"]
    stop_grace_period: 30s
volumes:
  stronghold-state:
```

检查点文件只支持一个进程写入；该功能不提供多实例共享对局。

## 验证

`node --test test/persist.test.js test/state-file.test.js test/state-shards.test.js test/state-runtime.test.js test/persist-worker.test.js test/match/snapshot.test.js` 覆盖快照保真、随机数续接、资金与阵容恢复、重连身份、真实磁盘写入、跨进程强制退出后恢复、写入竞争、观战和结算补推、过期身份、损坏文件与最后一次关服保存，以及 Worker 编码与同步编码的一致性、时钟外置后的字节稳定、分片脏检测、旧文件迁移、孤儿/损坏分片和分片布局下的硬杀重启恢复。运行时回归另覆盖长期在线跳写后的身份恢复、各写入阶段的故障重试、版本不匹配的时钟隔离、未提交新一局的隔离、移除失败保护和 250 房的实际稳态写入量。

模拟多用户与本机规模验证：

```sh
node tools/persist-sim.mjs                # 多用户硬杀恢复 + 250 房规模基准
node tools/persist-sim.mjs --rooms 400    # 自定义房间数
node tools/persist-sim.mjs --skip-scale   # 只跑多用户硬杀恢复
```

多用户场景会以真实 WebSocket 客户端开一个 4 人同盟房和一个单人房，推进到休整期并完成购买，强制杀死服务器进程后再重启，逐一校验身份、房间、对局、回合与资金；规模场景会开 N 个房间测量完整 flush 耗时、事件循环最大停顿、实际写入字节数、稳态 index/分片写入次数（应为 0）以及重启后的完整恢复。规模计时暂停自动保存，显式完成每轮保存，避免将被节流推迟的请求误计为成功写入。

0.2.2 的干员潜能／练度设置随身份、房间席位和对局检查点保存；「AI 队友最后选择」随房间与对局保存，教鞭尚未确认的个人选卡也随检查点恢复。旧检查点缺少这些字段时沿用默认设置。
