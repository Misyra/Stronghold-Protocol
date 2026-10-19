# 本分支维护边界

整理只覆盖本分支新增或适配的逻辑。上游的玩法、URL 辅助函数、`RefLru`、原始网络接口与模块布局保持不变；共用文件只修改本分支的接入点。上游图片失败缓存的重试语义保留，不将它误列为本分支已修复的问题。

## 模块归属

| 文件 | 单一职责 |
| --- | --- |
| `server/runtimeCleanup.js` | 正常关服或启动回滚时释放资源；自身不写存档 |
| `server/roomConfig.js` | 本分支保护配置的默认值、验证与私有配置文件读写 |
| `server/roomReclamation.js` | 90% 触发、回收到低于 80% 的离线房间策略与定时检查 |
| `server/botPopulation.js` | AI 席位的全服与海外计数、添加许可及监控计数 |
| `server/geoip.js` | 启动时加载 GeoLite 国家库；游戏请求路径不访问网络或磁盘 |
| `server/foreignSessions.js` | 海外单 IP 身份索引、在线准入、断线回收计划与处罚转移；不直接操作房间或 socket |
| `server/wireHints.js` | 本分支的预编码与状态合并标记；不持有连接 |
| `public/js/cdnSpine.js` | 本分支 CDN 的独立哈希图集、纹理页和 PIXI resolver 元数据适配 |
| `public/js/image.js` | 本分支 CORS 图片修复、并发请求共享和总时限 |
| `public/js/resources/state.js` | 本分支资源管理状态发布，按修改字段比较以减少序列化 |

`Lobby` 仍是房间、席位和销毁操作的唯一所有者。策略模块不直接删除房间。AI 名额只在添加、移除、恢复和销毁的入口变动；不得在观测、开局或重连时重新扣减。

管理 API 负责身份验证、HTTP 参数、串行持久化；写入成功后通过 `lobby.applyRoomConfig()` 应用广播、回收和审计，不直接修改 `lobby.opts`。保存失败不改变运行时策略。

预载模块把下载、归档和清理任务集中在 `tasks` 中，下载与归档各自持有 Promise 和取消控制器。它们仍沿用原有的暂停、等待和互斥顺序，不另建一套任务调度器。

## 生命周期约束

- 正常关服先进入 draining：拒绝新的 WebSocket 和已有连接的修改请求，冻结房间计算与过期回收，等待已接受的管理配置写入，再保存最终存档，最后释放资源。
- 启动回滚只释放资源，不进行最终保存，避免覆盖无法读取的原存档；一个清理动作失败不跳过其余动作。
- 聊天处罚可保留身份，但不会延长房间席位的重连窗口；超时席位与 AI 正常清理，处罚记录仍在。
- 房间创建时间随存档保留，重启不会重置回收排序与管理端防误关标识。旧存档缺少创建时间时以恢复时间兼容。

## 取自 xinhai-ai/Stronghold-Protocol 的部分

CDN、资源预载、Redis 持久化与后台 Worker 四块按「照抄对方」的方式引入（对方与本仓库同为 GPL-3.0-or-later）。下面分清哪些是逐字照搬、哪些只做了接入适配，以及刻意没有采用的三处。

| 部分 | 照搬（逐字或仅改路径） | 只做接入适配 |
| --- | --- | --- |
| CDN | `shared/cdn.js`、`public/js/asset-cdn.js`、`server/http/files.js`、`server/packs.js`、`shared/resourcePackRoutes.js` | `server/http/static.js`（同一层要服务本地素材、`/_v/<tag>/` 与 CDN 基址）、`server/http/config.js`（`parseAssetCdn` 合入本分支配置）、`server/index.js`（启动时解析基址交给静态层） |
| 资源预载 | `public/js/resources/{transport,sha1Stream,integrity,workerCache,workerManifest,readThrough}.js`、`server/workers/manifestEncode.js`、`tools/resource_packs.py`、`tools/resource_delta.py` | `public/js/resources/{index,store,archive,common}.js`（本分支的皮肤/特效/三开关/必备+额外分层）、`server/resources.js`（`skinKeyForPath`、`fx` 标记、站点自带表情） |
| Redis 持久化 | `server/redis.js`（本分支只往里加了 `getKey`/`getKeys`/`setKey`/`delKeys` 四个按键读写的原语与 `warn`）、`server/index.js`（Redis > `SP_STATE_FILE` > 内存的优先级） | `server/redisState.js`（`saveSharded` → `<前缀>index` + `<前缀>runtime` + `<前缀>cp:<房间码>` 三键布局，与 `server/stateFile.js` 的目录布局一一对应；写入顺序、压缩、旧单键退回见 [断点恢复](../operations/PERSISTENCE.md)） |
| Worker | `server/workers/{backgroundClient,stateEncoder,pluginScan,manifestEncode,matchPool,matchWorker}.js`、`server/workers/{persistence,persistenceClient,memory,pool,roomPool,simulation}.js` | `server/stateTransport.js`（`attachWorkerState`：worker 发来的状态帧带回归属）、`server/plugins/registry.js`（后台扫描）、`server/persist.js`（线程池对局用线程往返的 `capture` 拍档）、`server/lobby.js` 与 `server/matchRestore.js`（`SP_MATCH_WORKERS`：开局与重启恢复都进 lane） |

Worker 池在本分支的开关是 `SP_MATCH_WORKERS`（默认 0），细节见 [性能说明](PERFORMANCE.md) 与 [部署说明](../operations/DEPLOY.md)。池子唯一的对外行为差异是 `onLaneFailure`：上游在 Worker 报错时只留一行日志，房间会挂着一个不会应答的对局；本分支据此结束那几条对局（房间回大厅、存档保留）、把死泳道从分配表里摘掉（`test/match-worker-lanes.test.js`）。状态增量（`server/stateTransport.js`）本来就是共用件，worker 侧新增的只有帧归属，压缩与校验语义未改。

刻意没有采用的三处，以及原因：

- `public/js/resources/runtimeIndex.js`（运行期写缓存的旁路索引）。对方用它记下 Service Worker 运行期写进缓存的条目，省掉一次整文件哈希。本分支的 `store` 在 `#status` 里本来就把「已缓存但未入索引」的条目交给 `#adopt` 现算哈希后再复用，正确性相同，只是每次多算一遍；引入第二套索引会让「索引坏了就重算」这条退路变成两套可能不一致的退路。
- `public/js/resourceNetwork.js`（运行期素材下载器 + PIXI parser 钩子）。它绑的是对方的渲染取图路径；本分支走自己的 `public/js/image.js` 与 `public/js/cdnSpine.js`（含皮肤 273 套的图集与纹理页适配）。换过去等于重写取图链路，收益只有请求去重。
- `public/js/resources/combat.js`（战斗期暂停批量预载）。功能有，实现不同：本分支的 `public/js/resources/schedule.js` 按比赛状态排队（战斗期间只停 `TIER_REST` 与低优先级 lane，正在跑的请求允许收尾），由 `main.js` 的 `updateResourcePriority` 驱动。

## 取自 Stardust-minus/Stronghold-Protocol @ fab1b97 的部分（0.3.1：特效层与匹配）

上游 0.3.1 用两支提交落在同一个仓库里：`b3deebda`（origin/master 的 0.3.1）与 `fab1b97`（`Merge upstream v0.3.1`）。合并按三方走 `git merge-file`，以 fab1b97 的行为为准，一批一提交：`160669eb`（A0 零冲突照抄）、`9333054c`（A1 特效层）、`413d48da`（A2a 渲染入口）、`9a0269f2`（A2b 模型与 3D 场景）、`cb036963`（A3 模拟层）、`51f1cdc1`（B1 匹配）、`921cba7a`（B2 确认面板样式）。

| 部分 | 照搬（逐字或仅改字段名） | 只做接入适配 |
| --- | --- | --- |
| 特效层 | `public/js/render/vfx/wiring.js`（`skinOf`/`swap`/`_fakeShot`，飞行特效按皮肤换投射物）、`vfx/geom.js` 的 pivot 符号、其余 12 份 vfx 文件 | `v?.info?.skinId` → `v?.info?.skin`（本分支的 UnitInfo 字段名）；注释里的 §34.6 改成本分支的 §54.6 |
| 模拟层 | `server/sim/battle/events.js`、`ai.js`、`buffs.js`、`damageBoard.js`、`syncHash.js`（与上游逐字节相同）、`battle/units.js` 的 31 行字段预声明、`Battle.js`/`battle/lifecycle.js` 的开局面板统计触发 | `server/sim/spec.js` 接 `morphPairing: 'plus'`（本分支 `shared/plugins/rules.js` 的 `morphBattleOpt` 一直在发，此前 sim 不认）；`content/support/index.js` 的 `unitBonds` 走 `grantedBondsByMorph`；`snapshot.js` 顺带 `unitStatsEntry` |
| 匹配 | `server/matchmaking.js`（offer/accept 握手、ticket、分池、超时扫描）、`server/phaseMetrics.js`、`shared/protocol.js` 的 `queue.*` 与 hello 能力版本、`shared/constants.js` 的 `MATCHMAKING_VERSION` / `ERR.QUEUED` / `ERR.MAINTENANCE` | `server/matchmakingRooms.js` 改成本分支的适配层（导出名不变；`allocate()` 必须回 `{ ok, code }`，引擎只认 `result.code`）、`server/lobby.js` 的 25 处调用点加两道缝：`queueReply`（引擎回 `{ok}`/`{error}`，本分支 net 是 RPC `{t:'ok'}`）与 `leaveQueue`/`mmCohort`（cohort 正在分配房间时不许各自解票，否则引擎 `breakOffer` 会把整组打散）、`public/js/screens/{lobby,room}.js` 的确认入场面板、`public/js/main.js` 把 `queue.state` 映射回旧视图形状 |

刻意没有采用的部分（每一项都先实测过代价）：

- `public/js/materialFallback.js` 与 `public/js/render/materialLoader.js`（取图镜像/重试层）。本分支的取图链路是自己的 `public/js/image.js` + `public/js/resourceUrl.js`（`/_v/<tag>/` 前缀），且 `test/ui/image-policy.test.js` 白名单只允许 `image.js`/`resourceNetwork.js` 出现 `new Image()`；`boardArt.js`、`board3d/load.js` 在上游的改动全部只是换成 `fetchMaterial`，本分支保留原样。
- UnitInfo 的皮肤字段仍叫 `skin`（不是上游的 `skinId`）。皮肤目录是本分支的 `shared/skin-catalogue.js` 加 `room.skins{choices}`，皮肤选择器是本分支的 `public/js/ui/skinPicker.js`（含商店立绘）；上游的 `ui/{skinAssets,skinsModel,pluginSkinPicker,dynamicIllustration}.js` 不接。
- `server/cluster/**`、`server/persist/**`、`server/match/combat/**`、`server/match/extensions.js`、`shared/cluster-load.js`，以及上游独有的 35 个 `public/js/ui/*.js` 面板。
- `public/js/ui/matchmaking.js` 的 159 行队列面板（依赖 `public/js/queueCancellation.js` 与 `ui/experimental.js`，两份本分支都没有）与 `test/cluster-matchmaking.test.js`；本分支的匹配界面仍在 `screens/{lobby,room}.js`，只借用了 `queue.state` 的字段。
- `shared/names.js`：上游那份只是 `deploy/stardust/auth/name-policy.mjs` 的转发，本分支没有那个目录，昵称策略在 `server/net.js` 的 `sanitizeName` + `server/moderation/nickname.js`（更严：混淆名也会被拒）。
- `shared/protocol.js`、`shared/constants.js`、`shared/plugins/ui.js` 整份不照抄：两支分支各自增减了消息与错误码（本分支有聊天、控制台配额与 `MAX_SEATS`，上游换成了 `queue.*`、`presence.state`、`MAX_PLAYER_CAPACITY`），只把 0.3.1 需要的键逐条搬过来。
- `server/sim/content/{bands,garrisons}/meta.js` 的装备库存模型：上游 #488 把「装备占份数」当库存，与本分支 2026-10-13 的拍板（保留 0.3.0 模型）相反，跳过。
- `data/` 整批跳过。`data/assets.json` 是两份不同的生成产物（本分支 `tools/fetch-assets.mjs` 的全量清单：288335 个文件、1214 个 Spine、每角色带 `chars.<id>.skins`；上游是 `tools/merge-generated-release.mjs` 的精简发布清单：21775 个文件、673 个 Spine），重建清单会动到 273 套皮肤的图集键；`data/config.json` 的三处差异（`unite.helperOrder` 的层数、`rewards.milestones` 的 60 档 token、`rewards.daily` 的每日防卫目标）对应上游独有的机制，本分支的 sim 与结算没有对应实现，只改字符串会让说明与行为不符。

匹配这一批是**行为变更**：凑满四人不再直接开局，而是先发 offer、全员在 30 秒内 `queue.accept` 才分配房间（`waitMs` 10 分钟）。回滚只需回退 `51f1cdc1`：旧引擎、旧消息名与旧大厅调用点都在那一个提交里。

**基线差异（不是本次合并引入）**：`node tools/golden.mjs` 只差 `roster-039`；在 `366f056b`（合并前的 master）上复跑同样只差这一条。`test/match/fuzz.test.js` 的两项（`g.kickBallot` 的 `voteId`）与 `test/match/simServe.test.js` 的 simdata 路径断言、`test/render` 的 5 组（板面素材与 vfx-psys 的 Local 缩放）同样是既有的红，与本批无关。

## 回归检查

常规测试使用 `npm test -- <文件>`；源码浏览器与临时生产包测试分别使用 `npm run test:browser`、`npm run test:client`。参见 [测试流程](TEST_WORKFLOW.md)，不要通过清理本机 `public/build` 解决源码测试混用问题。

```sh
npm test -- test/runtime-lifecycle.test.js test/room-reclamation.test.js test/bot-population.test.js test/bot-policy.test.js
npm test -- test/net-backpressure.test.js test/net-fanout.test.js test/state-delta-integration.test.js
npm test -- test/matchmaking.test.js test/matchmaking-party.test.js
npm test -- test/asset-cdn.test.js test/render/image-cors-recovery.test.js test/resources/index.test.js test/resources/state.test.js
npm run check:imports
npm run typecheck
npm run build
```

匹配界面的端到端检查（真 Chrome，起临时服务器，四个浏览器上下文）：四个上下文共用 `::1`，必须先关掉每 IP 会话上限，否则第四个连不上。

```sh
SP_E2E=1 SP_IP_SESSION_LIMIT=off CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe' \
  node --import ./test/helpers/test-setup.js --test test/ui/matchmaking.e2e.test.js
```

它覆盖：大厅「同盟匹配」→ 选难度 → 开始搜寻 → 人数计数 → 停止搜寻 → 四人「队友已集结 / 确认入场」→ 同一房间四个真人无 AI → 简报「准备就绪」离开 INFO_CHECK，并在手机尺寸（844×390）上钉住「停止搜寻」不被确认卡片挤出视口。预组队一侧走协议级用例（`test/matchmaking-party.test.js`），因为旧的房间内「同盟匹配」勾选框界面已被大厅的 `ProtocolSelect` 取代。

`check:imports` 使用本分支严格适配器，不改变上游的 advisory 检查器。只登记 `server/sim/nodeData.js` 原有的三个 Node 内置导入例外，其他新增跨层依赖均失败，不能豁免整个文件或目录。
