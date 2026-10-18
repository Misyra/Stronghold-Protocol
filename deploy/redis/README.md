# Redis（对局状态）

游戏把正在进行的服务端对局存在这里，重启后能接着打：[断点恢复](../../custom_docs/operations/PERSISTENCE.md)。

## 起一台

```sh
docker compose -f deploy/redis/docker-compose.yml up -d
docker exec stronghold-redis valkey-cli keys 'stronghold:*'    # 跑一局之后应该能看到 index / runtime / cp:<房间码>
```

Windows 上 Docker Desktop（WSL 2 后端）即可；不想装 Docker 就装 Memurai，或者 WSL 里 `apt install valkey-server`。

## 接到游戏上

```sh
SP_REDIS_URL=redis://127.0.0.1:6379 \
SP_REDIS_PREFIX=stronghold: \
npm start
```

启动横幅会打印 `State: checkpoint every 10s (sharded keys stronghold:{index,runtime,cp:<code>})`；
`GET /healthz` 的 `persistence` 里 `backend: 'redis'`、`writes` 在涨，就说明写通了。

## 键

| 键 | 内容 |
| --- | --- |
| `<前缀>index` | 会话、房间、对局元数据（元数据变了才写） |
| `<前缀>runtime` | 各对局时钟、`savedAt`（每轮刷，很小） |
| `<前缀>cp:<房间码>` | 一个房间的检查点（正文变了才写，>1 KiB 压缩） |

旧的 `<前缀>state`（单键整份文档）只在 `index` 不存在时读一次，之后按新布局写，旧键留着做回滚副本。

## 4 核 4 GB 上的取值

```conf
maxmemory 384mb
maxmemory-policy volatile-ttl     # 所有键都带 TTL，先淘汰最旧的断点
appendonly no
save ""
```

再配合 `SP_WORKERS=2`、`SP_STATE_SAVE_MS=15000`。理由与其它取值见
[断点恢复 · 小机器](../../custom_docs/operations/PERSISTENCE.md)。
