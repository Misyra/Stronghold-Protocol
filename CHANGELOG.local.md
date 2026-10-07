# 本站更新记录

上游 sganggs/Stronghold-Protocol 的官方版本记录见 [CHANGELOG.md](CHANGELOG.md)；本文件只记录本站部署在其之上的自有改动。每次发布前在此追加条目。

## 未发布

### 界面与表现

- 维护公告改为进入游戏即全程显示（标题画面、大厅、同盟与对局）：维护通知在玩家进对局之前就能看到，不再只在对局内出现。配置方式不变（`SP_ANNOUNCEMENT_FILE`，`GET /api/announcement`），关闭记忆、30 秒轮询、到期自动隐藏等行为保持不变。
- 结算画面的「对局记录」按钮移到「返回同盟」右侧，两个按钮同为超大尺寸并排平分一行。

### 测试

- 修复上游 `client-wait` 测试在 Windows 上的计时抖动：`fakePage(95)` 的等待窗口会被三个 30ms 分片在 ~15.6ms 计时器粒度下覆盖，导致「至少切片 4 次」断言随机失败；等待改为 200ms（测试意图不变）。

### 素材与部署

- **R2 素材上传改为增量**：放弃「每次发布全量重传 1.4 万个对象（约 4 小时）」的双 key 快照方案，改为仓库清单（`.assets-manifest.json`）记录每个文件的发布哈希，`node tools/r2-sync.mjs` 只上传变化的文件（通常几秒到几十秒）。CDN URL 从 `_v/<tag>/…` 前缀改为逐文件 `?v=<文件哈希>` 查询串：内容不变则 URL 不变（永久命中缓存），文件更新只有它自己的 URL 变化。清单由游戏服务器同源提供（`/assets-manifest.json?v=<tag>`，不可变缓存），页面在 `<head>` 预取；清单不存在时回退旧的 `.assets-cdn-version` / `_v/` 解析链，线上旧代码与已缓存资源不受影响。断点续传文件（`.cache/r2-sync-progress.json`）删除——清单本身就是续传状态；未知命令行参数现在直接报错退出（此前 `--help` 会被静默忽略并触发真实全量上传）。
- 合并上游 v0.1.4（9f93096）：沉睡不可阻挡、阿戈尔吞噬最终加算、高台特性放置、金标准测试网等。上游新增了干员战斗语音等素材引用，发布时需把新素材上传 R2（见 [docs/CDN.md](docs/CDN.md) §6.1：`node tools/r2-sync.mjs --bucket weishu --push`）。
- 修复：CDN 查询串模式下 `validSpine` 把带 `?v=` 的 Spine 条目判为非法，人物骨骼全部不加载。校验与骨骼派生路径改为容忍逐文件穿透查询串（仅允许 `?v=<16 位哈希>`，其余查询仍拒绝），真机验证骨骼经 CDN 加载正常。

## 2026-10-04 ～ 2026-10-06（0.1.3 之后、合并上游 v0.1.4 之前）

### 功能

- 对局记录：结算时自动保存最近 100 局到浏览器 IndexedDB，可查看阵容统计、导出 JSON（[docs/MATCH_HISTORY.md](docs/MATCH_HISTORY.md)）。
- 资源预载：按文件 hash 增量预载、断点续传、跨版本缓存别名复用，已接入 Cloudflare CDN 实测（[docs/CDN.md](docs/CDN.md) §5）。
- 同站四人纯真人匹配与中间页延迟 / 难度接口；同盟匹配等待超 10 秒提示可前往中间页创建同盟并发布房间号。
- 外部只读接口：按房间码查询实时状态 `GET /api/rooms/<房间码>/status`、延迟探测 `GET /api/ping`（[docs/CUSTOM_API.md](docs/CUSTOM_API.md)）。
- 可关闭的局内维护公告（`SP_ANNOUNCEMENT_FILE` 热加载）与 `GET /api/announcement`。
- 客户端可自定义游戏快捷键（设置 → 修改快捷键，8 个动作），默认键位与上游 Q / X 对齐并吸收其守卫逻辑。

### 素材与部署

- R2 素材 CDN：`tools/r2-sync.mjs` 版本化发布（双 key、断点续传、`_v/latest` 解析），`.assets-cdn-version` 随仓库发布（[docs/CDN.md](docs/CDN.md) §6）。
- v0.1.3 本地客户端美术随 Git 部署；nginx 运维备忘与多核配置示例（[docs/DEPLOY.md](docs/DEPLOY.md)）。

### 服务端性能与可靠性

- 会话、房间与对局检查点跨重启持久化；持久化编码移入专用 Worker、分片存储。
- Bot 布局增量求值、战斗 tick 闭包消除、`m.public` / `m.private` / `b.snap` 单次序列化、`/healthz` 线帧计数与内存诊断（[docs/PERFORMANCE.md](docs/PERFORMANCE.md)）。
- WebSocket 低等级 permessage-deflate 压缩（`SP_WS_COMPRESSION`）。
- Worker 池泄漏修复、资源清单 304 再验证。
