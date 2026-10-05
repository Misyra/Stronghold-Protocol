# 服务端断点恢复

与浏览器本地战绩不同，这个功能保存正在进行的服务端对局。检查点与恢复逻辑移植自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol/tree/20524bb07dff68743980ec8e6b4a8e458f3720b6)，遵循 GPL-3.0-or-later；本仓库增加原子文件存储、独占写入锁、开战前检查点、关服写入等待、观战与结算补推恢复。

## 启用与升级

`npm start` 默认开启，保存于仓库 `.state/server-3000.state.json`（端口不同则文件名不同）。每 10 秒刷新一次，在开局和开战前额外检查保存，正常关服先等待已有写入，再写最后一次状态，然后关闭房间。

生产环境建议配置固定的私有文件路径，升级时继续使用同一文件。例如：

```sh
SP_STATE_FILE=/var/lib/stronghold/game.state.json npm start
```

Windows PowerShell：

```powershell
$env:SP_STATE_FILE='E:\stronghold-data\game.state.json'
npm start
```

`SP_STATE_SAVE_MS` 调整周期，最短 1000 毫秒，默认 10000。`SP_STATE_FILE=off` 关闭持久化。程序调用 `startServer()` 时默认不创建文件；传入 `stateFile` 或 `store` 启用，`store: null` 显式关闭，方便测试与嵌入使用。

升级流程：正常停止旧进程，备份状态文件，更新代码与依赖，再启动新进程。不要删除 `.state/`，也不要运行两个进程同时写同一文件。检查 `/healthz.persist` 的 `enabled`、`writes`、`failures`、`checkpoints`；`failures` 增长说明保存有问题。不能在旧版首次升级前自动取回旧进程尚未写盘的内存，请等那批对局结束后部署此功能。

## 恢复范围

- 玩家身份、昵称、调配、房间、座位、AI 队友、观战者、准备状态、局数和待补发结算。
- 对局的信息确认、策略轮选、机变轮选、回合开始或休整期检查点：棋盘、手牌、商店、资金、生命值、装备、盟约、效果、悬赏、卡池和所有随机数流位置。
- 作战、联防、最终攻势或隐秘核心进行中重启：恢复最近一个安全阶段，不保存战斗的精确帧，会重打该回合。异常强制结束进程可能丢失最近尚未成功落盘的操作。
- 恢复休整期后，人类玩家重新准备；多人至少有 20 秒休整时间，独立模拟或仅一名真人的同盟仍无倒计时。暂停状态不恢复。
- 同盟身份重连窗口通常为 10 分钟，独立模拟 24 小时；停机时间计入窗口。恢复后过期身份及对应座位会移除。
- 检查点格式有独立版本号，代码版本变化本身不会清空存档。改变存档结构时需要迁移；不兼容的文件或损坏 JSON 会阻止启动并保留原文件，不自动覆盖。

文件包含私有重连令牌，必须保存在静态目录以外，不能上传到 Git 或公开备份。默认目录已加入 Git 与 Docker 构建忽略列表。写入先同步临时文件，再原子重命名覆盖旧文件；保存失败会保留旧检查点。锁文件避免多个本机进程互相覆盖，进程被强制终止后会检测并回收残留的锁。

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

`node --test test/persist.test.js test/state-file.test.js test/match/snapshot.test.js` 覆盖快照保真、随机数续接、资金与阵容恢复、重连身份、真实磁盘写入、跨进程强制退出后恢复、写入竞争、观战和结算补推、过期身份、损坏文件与最后一次关服保存。
