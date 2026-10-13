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
