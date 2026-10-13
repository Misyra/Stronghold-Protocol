# 同盟房间一键收录

房主在同盟等待室点击「提交本房间到联机站」，公开房间密钥供其他玩家加入。仅接受仍有空位、未开局、未进入匹配队列的协力房间；独立模拟和观战者不能提交。未配置时不显示按钮。

## 配置

游戏服与联机站各自设置环境变量并重启。`siteId` 必须与联机站现有 `sites.json` 的 `id` 完全一致（例如 `hongkong`）。每个游戏站点生成不同的专用密钥，不复用探针或管理密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

游戏服环境（部署环境文件只允许运行用户读取，不入库）：

```ini
SP_PORTAL_URL=https://你的联机站域名
SP_PORTAL_SITE_ID=hongkong
SP_PORTAL_ROOM_KEY=替换为生成的64位小写十六进制密钥
```

联机站环境（JSON 中对应的值必须与该游戏服一致）：

```ini
PORTAL_GAME_ROOM_KEYS={"hongkong":"替换为相同密钥"}
```

游戏服目标地址必须是 HTTPS；仅本机调试允许 loopback HTTP。联机站仍需要通过已配置的 `apiUrl` 访问游戏服 `GET /api/rooms/<code>/status`，且该站不能设置 `roomApi: false`。密钥只存在两端服务器环境中，轮换时同时更新两端并重启；应保持时钟同步。

## 接口与权限

- 游戏服 `GET /api/portal-room`：返回 `{ enabled }`，不泄漏 URL、密钥或站点配置。
- 游戏服 `POST /api/portal-room`：JSON `{ "code": "ABCD" }`，`Authorization: Bearer <当前游戏会话token>`。服务端检查在线会话、房主身份和当前房间；提交中的房间变化也会再次检查。
- 联机站 `POST /api/rooms/from-game`：仅服务器调用，JSON `{ "code": "ABCD" }`；不接受浏览器 Origin 或 Sec-Fetch-Site。站点由签名请求头确定，不能由请求体指定 URL、备注或其他站点。

签名头为 `X-Portal-Site`、`X-Portal-Timestamp`（毫秒 Unix 时间）、`X-Portal-Nonce`（16 个随机字节的小写 hex）、`X-Portal-Signature`（SHA-256 HMAC 小写 hex）。HMAC 的 key 是配置的 **64 字符原文**（UTF-8，不做 hex 解码）；签名消息按以下顺序用 LF 连接，最后没有额外换行：

```text
POST
/api/rooms/from-game
<siteId>
<timestamp>
<nonce>
<原始JSON请求体>
```

两端成功均只返回 `{ "ok": true }`。重复收录幂等，不覆盖原提交者的所有权凭据，也不延长已有条目的有效期。条目复用联机站原有十分钟过期、状态探测和每站 20 条上限；过期后可重新提交。此入口不会发放续期/删除凭据，原有联机站手动登记仍保留其管理能力。

## 资源边界

游戏端复用可信代理地址策略做 IP 限流（突发 10，持续 2 次/秒，最多 4096 个桶），同一房间每分钟最多一次；全服突发 4、持续每 5 秒一次，最多 4 个在途提交。请求体限 128 字节、读取限 3 秒，出网限 5 秒，禁止跟随重定向；远端响应体直接丢弃。失败同样消耗冷却。

联机站先走已有房间写入 IP 桶，再验证签名；每站突发 4、每 5 秒补一次，最多 4 个在途请求，请求体限 512 字节、读取限 3 秒。签名仅允许前后 30 秒时差，已使用 nonce 在有效期内不能重放，最多保留 4096 个。收录前通过已配置的游戏状态接口验证可加入状态，沿用原有有界探测队列及退避。

以上限流与 nonce 缓存是**单进程内存**。部署多个联机站实例需要共享防重放存储/限流或将此接口固定到一个实例。进程重启会清空 nonce 缓存，30 秒时间窗内旧签名可能被再次接受，但登记本身幂等。

应用限流不能吸收链路被打满的流量。生产部署仍应在反向代理/CDN 设置连接和请求速率上限、请求体上限与超时，条件允许时对联机站该写接口限制游戏服出口 IP。必须覆盖写可信代理 IP 请求头；不要记录 Authorization、签名头、密钥或请求体。现有 nginx `/api/` 代理可承接接口，需确认未被静态站路由覆盖且未缓存写请求。生产浏览器访问游戏服也必须使用 HTTPS。

验证命令：游戏服 `node --test test/portal-room.test.js`；联机站 `node --test test/game-room-publish.test.mjs test/rooms.test.mjs test/room-probes.test.mjs`。
