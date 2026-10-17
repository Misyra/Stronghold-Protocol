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
| 资源预载 | `public/js/resources/{transport,sha1Stream,integrity,workerCache,workerManifest,readThrough}.js`、`server/workers/manifestEncode.js` | `public/js/resources/{index,store,archive,common}.js`（本分支的皮肤/特效/三开关/必备+额外分层）、`server/resources.js`（`skinKeyForPath`、`fx` 标记、站点自带表情） |
| Redis 持久化 | `server/redis.js` | `server/redisState.js`（`saveSharded` → 单文档 `save`，供本分支分片存储复用）、`server/index.js`（Redis > `SP_STATE_FILE` > 内存的优先级） |
| Worker | `server/workers/{backgroundClient,stateEncoder,pluginScan,manifestEncode,matchPool,matchWorker}.js`、`server/workers/{persistence,persistenceClient,memory,pool,roomPool,simulation}.js` | `server/stateTransport.js`（`attachWorkerState`：worker 发来的状态帧带回归属）、`server/plugins/registry.js`（后台扫描）、`server/persist.js`（线程池对局用线程往返的 `capture` 拍档）、`server/lobby.js` 与 `server/matchRestore.js`（`SP_MATCH_WORKERS`：开局与重启恢复都进 lane） |

Worker 池在本分支的开关是 `SP_MATCH_WORKERS`（默认 0），细节见 [性能说明](PERFORMANCE.md) 与 [部署说明](../operations/DEPLOY.md)。池子唯一的对外行为差异是 `onLaneFailure`：上游在 Worker 报错时只留一行日志，房间会挂着一个不会应答的对局；本分支据此结束那几条对局（房间回大厅、存档保留）、把死泳道从分配表里摘掉（`test/match-worker-lanes.test.js`）。状态增量（`server/stateTransport.js`）本来就是共用件，worker 侧新增的只有帧归属，压缩与校验语义未改。

刻意没有采用的三处，以及原因：

- `public/js/resources/runtimeIndex.js`（运行期写缓存的旁路索引）。对方用它记下 Service Worker 运行期写进缓存的条目，省掉一次整文件哈希。本分支的 `store` 在 `#status` 里本来就把「已缓存但未入索引」的条目交给 `#adopt` 现算哈希后再复用，正确性相同，只是每次多算一遍；引入第二套索引会让「索引坏了就重算」这条退路变成两套可能不一致的退路。
- `public/js/resourceNetwork.js`（运行期素材下载器 + PIXI parser 钩子）。它绑的是对方的渲染取图路径；本分支走自己的 `public/js/image.js` 与 `public/js/cdnSpine.js`（含皮肤 273 套的图集与纹理页适配）。换过去等于重写取图链路，收益只有请求去重。
- `public/js/resources/combat.js`（战斗期暂停批量预载）。功能有，实现不同：本分支的 `public/js/resources/schedule.js` 按比赛状态排队（战斗期间只停 `TIER_REST` 与低优先级 lane，正在跑的请求允许收尾），由 `main.js` 的 `updateResourcePriority` 驱动。

## 回归检查

常规测试使用 `npm test -- <文件>`；源码浏览器与临时生产包测试分别使用 `npm run test:browser`、`npm run test:client`。参见 [测试流程](TEST_WORKFLOW.md)，不要通过清理本机 `public/build` 解决源码测试混用问题。

```sh
npm test -- test/runtime-lifecycle.test.js test/room-reclamation.test.js test/bot-population.test.js test/bot-policy.test.js
npm test -- test/net-backpressure.test.js test/net-fanout.test.js test/state-delta-integration.test.js
npm test -- test/asset-cdn.test.js test/render/image-cors-recovery.test.js test/resources/index.test.js test/resources/state.test.js
npm run check:imports
npm run typecheck
npm run build
```

`check:imports` 使用本分支严格适配器，不改变上游的 advisory 检查器。只登记 `server/sim/nodeData.js` 原有的三个 Node 内置导入例外，其他新增跨层依赖均失败，不能豁免整个文件或目录。
