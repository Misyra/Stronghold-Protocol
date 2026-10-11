# 游戏内公告

面板是唯一编辑入口。配置好探针后，在管理页发布即可写到对应游戏服务器，无需为游戏逐台绑定面板站点 ID。

## 默认链路

```text
/ops/manage.html 发布 → 面板公告存储（PANEL_ANNOUNCE_FILE）
    → PUT /api/admin/v1/announcement（本站探针，管理密钥）
    → /var/lib/stronghold-announcement/announcement.json（原子替换）
    → 游戏 GET /api/announcement → 玩家浏览器
```

面板先持久化内容和每站递增版本，再并行推送。失败站点在监控轮询时重试（默认 10 秒），面板重启后也会补发；成功站点不受其他站点故障影响。探针拒绝旧版本覆盖，重复请求可安全重试。停用或删除公告也会作为带版本的撤下指令补发。公告到期由游戏和浏览器独立判断。

游戏每秒最多读取一次文件，浏览器每 30 秒检查一次，切回标签页立即检查；代理缓存会额外增加少量延迟。「已写入探针」表示文件写入成功，「线上生效」列显示实际游戏接口内容。

## 显示方式与有效期

管理页分别配置有效期和显示方式。选择「30 分钟」会在发布时生成统一的 `expiresAt`：发布 30 分钟后全体过期，迟进入的玩家不会重新获得 30 分钟。另有 1 小时、6 小时及原有较长档位。

- `displayMode: "once"`（默认）：关闭后，同一浏览器不再显示该版本，刷新也不会重新显示；新公告或修改内容后重新显示。
- `displayMode: "visit"`：每次重新打开或刷新游戏页面都会显示；关闭后，本次页面内的轮询、切换界面和断线重连不会让它重新出现。

两种方式都受统一过期时间限制。旧配置省略 `displayMode` 时保持原有关闭记录和公告 ID；清理浏览器存储或换浏览器会失去「只显示一次」记录。面板、探针和游戏须一起更新才能完整支持新模式。

## 接入和升级

1. 游戏及中央 sp-portal 更新到支持探针推送的版本；游戏仓库的 ops/ 已包含对应探针。
2. 按 [MONITORING.md](MONITORING.md) 运行安装脚本。已有 env 保留，脚本自动补充独立的 `SP_ADMIN_TOKEN_RW`、公告目录及 systemd 写权限。
3. 在面板站点配置中填写本站探针 URL 和 `admin.env` 中的 `SP_ADMIN_TOKEN_RW`，测试连接后保存。它可读取监控并写公告；旧 `SP_ADMIN_TOKEN_RO` 仍只能读取监控。
4. 升级已有 feed 部署时，把**游戏服务**环境设置为 `SP_ANNOUNCEMENT_SOURCE=agent` 后重启游戏。新安装不设置来源即可使用 agent。安装脚本不会擅自改动游戏服务环境。
5. 在管理页发布并检查推送状态及线上内容。

默认 Linux 公告目录为 `/var/lib/stronghold-announcement`，由 spmonitor 持有，目录 0755、公告文件 0644，只存放玩家可见内容。探针仅有该目录的写权限，不允许通过请求修改路径、游戏程序或服务配置。自定义目录需使用安装器支持的 /var/lib 下独立目录，并同时设置探针 `MON_ANNOUNCEMENT_FILE` 和游戏 `SP_ANNOUNCEMENT_AGENT_FILE`。

Docker 游戏须将宿主机**整个公告目录**只读挂载到容器同一路径（不要只挂载单个文件，原子替换会更换 inode）；见 [DEPLOY.md](DEPLOY.md#docker)。Windows 游戏默认读项目 `.state/announcement.json`；若自行运行探针，请将两个进程的上述文件配置设成同一个绝对路径。

| 游戏环境变量 | 行为 |
|---|---|
| `SP_ANNOUNCEMENT_SOURCE` | 默认 agent；显式 URL 且未指定来源时兼容为 panel；另支持 file |
| `SP_ANNOUNCEMENT_AGENT_FILE` | agent 模式的探针管理文件；Linux 默认上述路径 |
| `SP_ANNOUNCEMENT_URL` | panel 模式的完整 feed URL；已有显式 URL 继续有效 |
| `SP_PORTAL_URL` / `SP_SITE_ID` | panel 模式未指定完整 URL 时必填；没有绑定某一站点的默认值 |
| `SP_ANNOUNCEMENT_POLL_MS` | feed 最短拉取间隔 10000 毫秒，限制 3000–600000 |
| `SP_ANNOUNCEMENT_FILE` | 仅显式 file 模式使用；默认根目录 announcement.json |

## 无探针站点的 feed 接入

面板仍提供公开 `GET /api/announce/v1/<siteId>`，仅包含玩家可见字段。游戏可继续配置：

```dotenv
SP_ANNOUNCEMENT_SOURCE=panel
SP_ANNOUNCEMENT_URL=https://game.rainya.me/api/announce/v1/<面板中本站的实际ID>
```

国内、国内2、香港 ID 分别为 shiyan、aliyun、hongkong；其他站点从面板配置读取实际 ID。feed 拉取失败保留最后有效值；明确 enabled:false 撤下，到期仍隐藏。故障不会自动切换来源。没有配置探针的站点在面板显示「由游戏拉取 feed」。

## 手工文件模式

仅用于独立部署：显式设置 `SP_ANNOUNCEMENT_SOURCE=file`，按 `announcement.example.json` 创建手工公告。根目录旧 announcement.json 不会被默认 agent 模式读取；探针只写受管理文件。标题 1–80 字符、正文 1–2000 字符，expiresAt 必须是带时区的 ISO 时间。内容支持换行，不解析 HTML。文件最多 16 KiB，修改无需重启。

## 排错

- 「请升级探针并填写管理密钥」：探针缺少写入能力，或面板仍在用只读密钥。
- 「等待重试」：检查探针连接、密钥、目录权限及 `journalctl -u sp-admin`。不要只重启游戏。
- 「游戏仍使用旧公告来源」：游戏环境切为 agent 后重启；核对 `curl -s http://127.0.0.1:3000/api/announcement` 的 source.mode。
- 文件已写入但游戏无公告：核对两个进程文件路径、游戏账号读取权限、Docker 目录挂载、过期时间。
- 代理返回旧值：游戏 /api/announcement 精确反代至游戏 Node，共享缓存为 30 秒，浏览器另有 30 秒轮询等待；缓存中的 serverTime 可使客户端到期显示产生约 30 秒偏差。源站失败时不继续返回过期缓存；中央 feed 由 sp-portal 提供。
- 版本冲突：检查该探针是否被误配置到两个面板站点，修正后重新发布。中央公告存储需和私有探针配置一起备份。

游戏内公告和入口页公告是独立系统：前者保存在 PANEL_ANNOUNCE_FILE、每站一份；后者由 PORTAL_ANNOUNCEMENT_FILE 管理、多条轮播，通过 /api/notices 展示。不要交叉修改两套文件。
