# 游戏内公告：管理面板接入

游戏内公告默认由 sp-portal 管理面板编辑；本地文件只在显式选择 `file` 模式时使用。游戏服务器和监控探针是不同进程，安装探针本身不会改变游戏公告源。

## 数据流

```text
/ops/manage.html「游戏内公告」
    → PUT /api/panel/v1/announcements
    → PANEL_ANNOUNCE_FILE（/var/lib/sp-portal/announcements.json）
    → GET /api/announce/v1/<siteId>（公开 feed）
    → 游戏服务端读取 / 轮询（至少间隔 10 秒）
    → GET /api/announcement
    → 玩家浏览器（30 秒检查一次，切回标签页立即检查）
```

面板发布只更新中央存储，不会远程修改游戏进程的环境变量。服务端按公告 API 请求触发拉取，同一进程合并并发请求并缓存拉取结果，最短间隔由 `SP_ANNOUNCEMENT_POLL_MS` 控制；没有读取请求时不主动访问 feed。面板探针默认也每 10 秒读取游戏公告。因此“10 秒同步”不是玩家端显示的总延迟；还需考虑浏览器 30 秒轮询和代理缓存。

## 默认配置与站点身份

本分支默认接入西安 / 新国内站：

```dotenv
SP_ANNOUNCEMENT_SOURCE=panel
SP_PORTAL_URL=https://game.rainya.me
SP_SITE_ID=site-ad797aa8
```

这是仓库的默认目标，不是自动识别机器。部署到国内、国内2、香港时分别设置 `SP_SITE_ID=shiyan`、`aliyun`、`hongkong`；未来新增站点在面板站点配置中读取实际 ID。显示名称可以修改，ID 决定公告归属。

| 配置 | 默认 / 优先级 |
|---|---|
| `SP_ANNOUNCEMENT_SOURCE` | `panel`；只有显式 `file` 才读取本地公告 |
| `SP_ANNOUNCEMENT_URL` | 未设置或空字符串时由下面两项组合；已有完整 URL 优先，兼容现有部署 |
| `SP_PORTAL_URL` | `https://game.rainya.me`；公开 feed 所在服务的根地址 |
| `SP_SITE_ID` | `site-ad797aa8`；必须与面板站点 ID 相同 |
| `SP_ANNOUNCEMENT_POLL_MS` | `10000`，限制在 3000–600000 毫秒 |
| `SP_ANNOUNCEMENT_FILE` | `<项目根目录>/announcement.json`；仅文件模式使用 |

等价的完整 URL：

```dotenv
SP_ANNOUNCEMENT_URL=https://game.rainya.me/api/announce/v1/site-ad797aa8
```

环境配置必须属于**游戏服务**，例如[部署指南](DEPLOY.md#配置)的 `/etc/stronghold/game.env`；写进探针的 `admin.env` 或面板的 `portal.env` 对游戏无效。修改后重启游戏进程。已有完整 URL 会覆盖 `SP_SITE_ID`，切换站点时同时删除或修正旧 URL。

## 验证

```bash
curl -s https://game.rainya.me/api/announce/v1/site-ad797aa8
curl -s http://127.0.0.1:3000/api/announcement
```

第一条应返回 `{enabled,title,text,expiresAt}`，未发布或显式停用时为 `{"enabled":false}`；不存在的站点返回 404。第二条返回 `announcement`、`serverTime` 和配置诊断 `source`：

```json
{"announcement":null,"serverTime":1791532800000,"source":{"mode":"panel","siteId":"site-ad797aa8"}}
```

`source` 表示进程选择的来源，不代表上游已成功读取；实际正文须与 feed 对照。启动日志 `[announcement] panel <URL>` 显示解析后的完整 URL，拉取失败记录 `central source unavailable`。第一次读取失败时 `announcement` 为 null；后续失败保留最后有效公告，到期仍隐藏。只有中央源明确返回 `enabled:false` 才主动撤下。任何故障都不会自动切回本地文件，进程重启后重新读取中央源。

## 显式使用本地文件

离线自用或独立运营时选择：

```dotenv
SP_ANNOUNCEMENT_SOURCE=file
SP_ANNOUNCEMENT_FILE=announcement.json
```

复制根目录 `announcement.example.json` 后修改标题、正文及 `expiresAt`。时间必须带时区，例如 `2026-10-16T19:52:00+08:00`；标题最多 80 字符，正文最多 2000 字符，支持换行且不解析 HTML。文件最多 16 KiB，每秒最多读取一次，修改内容无需重启；切换来源需要重启。设置 `enabled:false` 或删除文件撤下；文件无效时不显示并记录警告。

仅设置文件路径、留下旧 `announcement.json` 或清空远程 URL 都不会启用文件模式。公告关闭和到期只影响提示，不会停服、踢人或结束对局。

## 排错

- 面板有配置、线上无公告：先看游戏 API 的 `source` 和游戏服务日志，核对站点 ID。正确发布与游戏进程正确配置是两步。
- 改环境变量后仍读取旧地址：检查 systemd `EnvironmentFile`、drop-in、容器 `--env-file` 或 Windows `scripts/service.env.cmd`，重启实际承载本站端口的进程。
- feed 404：检查站点是否仍在面板站点配置中，以及 URL 中 ID 是否准确。不要换成本地 JSON 掩盖中央源配置问题。
- feed 正常，游戏请求失败：从游戏服务器测试出站 DNS、HTTPS 和 feed 访问；日志会给出超时或 HTTP 错误。
- 代理返回旧值：`/api/announcement` 精确匹配代理至游戏 Node，共享缓存保持 5 秒，最多 10 秒；feed 由 sp-portal 提供，不能误代理回游戏公告接口。

## 与中间页公告的区别

| | 游戏内公告 | 中间页公告 |
|---|---|---|
| 面板文件 | `/var/lib/sp-portal/announcements.json` | `PORTAL_ANNOUNCEMENT_FILE`，例如 `/etc/stronghold/portal-announcement.json` |
| 编辑入口 | 「游戏内公告」 | 「中间页公告」 |
| 出口 | `/api/announce/v1/<siteId>` → 游戏 `/api/announcement` | `/api/notices` → 联机入口页 |
| 内容 | 每站一份，截止时间 `expiresAt` | 多条、级别、起止时间及历史归档 |

游戏只提供公告读取接口；面板写入、权限和存储以 sp-portal 项目为准。公开 API 字段见 [CUSTOM_API.md](../development/CUSTOM_API.md#4-维护公告)；不要将两套公告 JSON 相互覆盖。
