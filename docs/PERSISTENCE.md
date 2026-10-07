# 服务端断点恢复

与浏览器本地战绩不同，这个功能保存正在进行的服务端对局。检查点与恢复逻辑移植自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol/tree/20524bb07dff68743980ec8e6b4a8e458f3720b6)，遵循 GPL-3.0-or-later；本仓库增加原子文件存储、独占写入锁、开战前检查点、关服写入等待、观战与结算补推恢复，以及持久化 Worker 与分片存储（见下）。

## 启用与升级

`npm start` 默认开启，保存于仓库 `.state/server-3000`（端口不同则目录名不同）。每 10 秒刷新一次，在开局和开战前额外检查保存，正常关服先等待已有写入，再写最后一次状态，然后关闭房间。

生产环境建议配置固定的私有路径，升级时继续使用同一路径。例如：

```sh
SP_STATE_FILE=/var/lib/stronghold/game.state.json npm start
```

Windows PowerShell：

```powershell
$env:SP_STATE_FILE='E:\stronghold-data\game'
npm start
```

`SP_STATE_SAVE_MS` 调整周期，最短 1000 毫秒，默认 10000。`SP_STATE_FILE=off` 关闭持久化。程序调用 `startServer()` 时默认不创建文件；传入 `stateFile` 或 `store` 启用，`store: null` 显式关闭，方便测试与嵌入使用。

升级流程：正常停止旧进程，备份状态文件，更新代码与依赖，再启动新进程。不要删除 `.state/`，也不要运行两个进程同时写同一路径。检查 `/healthz.persist` 的 `enabled`、`mode`、`writes`、`failures`、`checkpoints`；`failures` 增长说明保存有问题。不能在旧版首次升级前自动取回旧进程尚未写盘的内存，请等那批对局结束后部署此功能。

## 存储布局与持久化 Worker

按 `SP_STATE_FILE` 的形态自动选择，无需配置：

- **分片目录**（默认，路径不以 `.json` 结尾）：`index.json` 保存身份、房间和各对局的时钟信封，`matches/<房间码>.json` 每房一个检查点分片。分片与 index 都只在内容真正变化时重写（index 的比对不含 `savedAt`——它记录的是最后一次实际写盘时间）：挂机的休整期房间每个周期只更新 index 里的一行时钟，全部对局都在作战阶段时连 index 也不写。数百个房间的部署用这种布局。
- **单文件**（路径以 `.json` 结尾，或该路径已是文件）：经典的单 JSON 文档布局，行为与旧版本一致，Docker 与已有部署不受影响。检查点编码同样走 Worker，只是落盘仍是整份文档。
- **旧版迁移**：首次启动时若分片目录下没有 `index.json`，会自动读取旁边的旧单文件（`.state/server-3000.state.json`）完成恢复，之后的新写入进入分片布局；旧文件保留作为回滚副本，确认无误后可手动删除。

无论哪种布局，检查点的**编码与 JSON 校验都在专用持久化 Worker 线程**完成（`server/workers/persistence.js`），主线程只做字段捕获，数百个房间也不会卡住游戏心跳；Worker 崩溃或超时自动降级为主线程同步编码，持久化不随 Worker 一起失效。每个检查点的时钟（剩余休整时间等）与内容分离存储，内容按字节对比判断「脏」，因此不变的对局不会产生磁盘写入。写轮次按 `SAVE_MS`（默认 10 秒）合并：检查点事件只编码入内存并预约下一个写槽，不立刻触发整轮落盘。分片先写、index 后写：index 是提交点，崩溃最多留下多余分片（下次启动清理），不会丢失已写盘的检查点；单个分片损坏只影响该房间（对局回到大厅），不阻止整个服务器启动。

## 恢复范围

- 玩家身份、昵称、调配、房间、座位、AI 队友、观战者、准备状态、局数和待补发结算。
- 对局的信息确认、策略轮选、机变轮选、回合开始或休整期检查点：棋盘、手牌、商店、资金、生命值、装备、盟约、效果、悬赏、卡池和所有随机数流位置。
- 作战、联防、最终攻势或隐秘核心进行中重启：恢复最近一个安全阶段，不保存战斗的精确帧，会重打该回合。异常强制结束进程可能丢失最近尚未成功落盘的操作。
- 恢复休整期后，人类玩家重新准备；多人至少有 20 秒休整时间，独立模拟或仅一名真人的同盟仍无倒计时。暂停状态不恢复。
- 同盟身份重连窗口通常为 10 分钟，独立模拟 24 小时；停机时间计入窗口。恢复后过期身份及对应座位会移除。
- 检查点格式有独立版本号，代码版本变化本身不会清空存档。改变存档结构时需要迁移；不兼容的文档或损坏的 index 会阻止启动并保留原文件，不自动覆盖；单个分片损坏只丢弃该房间的对局恢复。

状态文件包含私有重连令牌，必须保存在静态目录以外，不能上传到 Git 或公开备份。默认目录已加入 Git 与 Docker 构建忽略列表。写入先同步临时文件，再原子重命名覆盖旧文件；保存失败会保留旧检查点。锁文件避免多个本机进程互相覆盖，进程被强制终止后会检测并回收残留的锁。

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

`node --test test/persist.test.js test/state-file.test.js test/state-shards.test.js test/persist-worker.test.js test/match/snapshot.test.js` 覆盖快照保真、随机数续接、资金与阵容恢复、重连身份、真实磁盘写入、跨进程强制退出后恢复、写入竞争、观战和结算补推、过期身份、损坏文件与最后一次关服保存，以及 Worker 编码与同步编码的一致性、时钟外置后的字节稳定、分片脏检测、旧文件迁移、孤儿/损坏分片和分片布局下的硬杀重启恢复。

模拟多用户与本机规模验证：

```sh
node tools/persist-sim.mjs                # 多用户硬杀恢复 + 250 房规模基准
node tools/persist-sim.mjs --rooms 400    # 自定义房间数
node tools/persist-sim.mjs --skip-scale   # 只跑多用户硬杀恢复
```

多用户场景会以真实 WebSocket 客户端开一个 4 人同盟房和一个单人房，推进到休整期并完成购买，强制杀死服务器进程后再重启，逐一校验身份、房间、对局、回合与资金；规模场景会开 N 个房间测量 flush 耗时、事件循环最大停顿、稳态分片写入次数（脏检测应约为 0）以及重启后的完整恢复。
